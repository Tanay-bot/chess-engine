/**
 * Thin UCI wrapper around the Stockfish 19 WebAssembly engine.
 *
 * The engine runs in its own Web Worker. All searches are serialised and any
 * aborted search is explicitly stopped so a stale `bestmove` can never be
 * mistaken for the answer to a newer request.
 *
 * Two builds ship with the `stockfish` package: a multi-threaded one that needs
 * a cross-origin isolated page (SharedArrayBuffer) and a single-threaded one
 * that runs anywhere. We prefer the multi-threaded build because spreading a
 * short search across cores is both faster and stronger, and fall back to the
 * single-threaded build if it cannot boot.
 *
 * A worker whose script fails to load is retried once from the same URL with a
 * query string (see `boot`). The engine also stays completely silent until its
 * whole WASM module has arrived — even the banner is printed by the module — so
 * booting waits out that silence instead of treating it as a failure; a first
 * visit may still be downloading the 99 MB network.
 */

export type EngineScore = { type: "cp" | "mate"; value: number };

export type EngineVariant = "multi" | "single";

export type EngineInfo = {
  variant: EngineVariant;
  threads: number;
  hash: number;
};

export type SearchUpdate = {
  depth: number;
  score: EngineScore | null;
  nps: number | null;
};

export type SearchResult = {
  bestMove: string | null;
};

type ActiveSearch = {
  id: number;
  lastDepth: number;
  lastNps: number | null;
  onUpdate?: (update: SearchUpdate) => void;
  resolve: (result: SearchResult) => void;
};

/**
 * How long a build may take to answer.
 *
 * Stockfish emits nothing at all until its WASM module has fully downloaded —
 * the startup banner comes from the module, not from the worker script — so a
 * slow first download is indistinguishable from a quiet engine. This deadline
 * only exists to surface a worker that never answers, and has to be generous
 * enough for ~99 MB on a slow connection.
 */
const BOOT_TIMEOUT_MS = 300_000;

/** A worker whose script never loaded, as opposed to an engine that boots slowly. */
class WorkerLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerLoadError";
  }
}

/** Leave one core for the UI, but never spawn a pointless pool. */
function preferredThreads(): number {
  const cores = typeof navigator === "undefined" ? 1 : navigator.hardwareConcurrency || 4;
  return Math.max(1, Math.min(8, cores - 1));
}

export class StockfishEngine {
  private worker: Worker | null = null;
  private active: ActiveSearch | null = null;
  private readonly lineHandlers = new Set<(line: string) => boolean>();
  private readonly pendingWaits = new Set<() => void>();
  private discardNextBestMove = false;
  private nextId = 1;
  private terminated = false;
  private bootReject: ((error: Error) => void) | null = null;
  private currentInfo: EngineInfo = { variant: "single", threads: 1, hash: 256 };
  private readonly onError?: (message: string) => void;

  constructor(options: { onError?: (message: string) => void } = {}) {
    this.onError = options.onError;
  }

  get info(): EngineInfo {
    return this.currentInfo;
  }

  async init(): Promise<void> {
    // SharedArrayBuffer only exists on a cross-origin isolated page, which is
    // exactly what the pthread build needs.
    const canUseThreads = typeof SharedArrayBuffer !== "undefined";
    const attempts: EngineVariant[] = canUseThreads ? ["multi", "single"] : ["single"];
    let failure: Error | null = null;

    for (const variant of attempts) {
      try {
        await this.boot(variant);
        return;
      } catch (cause) {
        failure = cause instanceof Error ? cause : new Error(String(cause));
      }
    }

    this.terminated = true;
    throw failure ?? new Error("Could not start Stockfish.");
  }

  newGame(): void {
    this.post("ucinewgame");
  }

  search(
    fen: string,
    options: { movetime: number; onUpdate?: (update: SearchUpdate) => void },
  ): Promise<SearchResult> {
    if (!this.worker || this.terminated) return Promise.resolve({ bestMove: null });

    this.stop();

    const id = this.nextId++;
    this.post(`position fen ${fen}`);
    this.post(`go movetime ${options.movetime}`);

    return new Promise<SearchResult>((resolve) => {
      const timer = setTimeout(() => {
        if (this.active?.id === id) {
          this.active = null;
          this.discardNextBestMove = true;
          this.post("stop");
        }
        resolve({ bestMove: null });
      }, options.movetime + 30_000);

      this.active = {
        id,
        lastDepth: 0,
        lastNps: null,
        onUpdate: options.onUpdate,
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
      };
    });
  }

  stop(): void {
    if (!this.worker || !this.active) return;
    const active = this.active;
    this.active = null;
    // The engine will still emit one `bestmove` for this aborted search; it
    // belongs to nobody and must not resolve the next request.
    this.discardNextBestMove = true;
    active.resolve({ bestMove: null });
    this.post("stop");
  }

  terminate(): void {
    this.terminated = true;
    this.bootReject = null;
    this.teardownWorker();
  }

  /* --------------------------------------------------------------- internal */

  /**
   * Boot one build, retrying once from the same URL with a query string.
   *
   * On one machine `new Worker(".../stockfish-19-single.js")` failed with an
   * error event that carried no message and a network log entry of
   * net::ERR_BLOCKED_BY_RESPONSE, and kept failing after reloads, while the same
   * file requested as `.../stockfish-19-single.js?v=2` loaded normally (and a
   * fresh browser profile loaded the plain URL too). We never established why,
   * so this is a cheap second attempt for a URL that will not load, not an
   * explanation of the cause.
   */
  private async boot(variant: EngineVariant): Promise<void> {
    const file = variant === "multi" ? "stockfish-19.js" : "stockfish-19-single.js";
    const base = new URL(`${import.meta.env.BASE_URL}engine/${file}`, window.location.href).href;
    const urls = [base, `${base}?v=2`];

    let failure: Error | null = null;
    for (const url of urls) {
      try {
        await this.bootFrom(url, variant);
        return;
      } catch (cause) {
        failure = cause instanceof Error ? cause : new Error(String(cause));
        // A slow boot would only repeat the same wait; just a worker that never
        // loaded is worth a second URL.
        if (!(failure instanceof WorkerLoadError)) break;
      }
    }

    throw failure ?? new Error("Could not start Stockfish.");
  }

  private async bootFrom(url: string, variant: EngineVariant): Promise<void> {
    this.teardownWorker();
    this.terminated = false;
    this.discardNextBestMove = false;

    const threads = variant === "multi" ? preferredThreads() : 1;
    const hash = variant === "multi" ? 512 : 256;

    const worker = new Worker(url);
    this.worker = worker;
    this.currentInfo = { variant, threads, hash };

    worker.onmessage = (event: MessageEvent) => this.handleOutput(String(event.data));
    worker.onerror = () => {
      this.fail(new WorkerLoadError("The Stockfish worker failed to load."));
    };
    worker.onmessageerror = () => {
      this.fail(new WorkerLoadError("The Stockfish worker sent an unreadable message."));
    };

    const failure = new Promise<never>((_, reject) => {
      this.bootReject = reject;
    });

    // Stockfish registers its message listener asynchronously while the WASM
    // module boots, so keep pinging until the handshake is answered.
    try {
      await Promise.race([
        this.waitForLine((line) => line.includes("uciok"), () => this.post("uci"), BOOT_TIMEOUT_MS),
        failure,
      ]);

      this.post(`setoption name Threads value ${threads}`);
      this.post(`setoption name Hash value ${hash}`);
      this.post("setoption name MultiPV value 1");
      this.post("setoption name Skill Level value 20");
      this.post("setoption name UCI_LimitStrength value false");
      this.post("setoption name Ponder value false");
      this.post("ucinewgame");

      await Promise.race([
        this.waitForLine(
          (line) => line.includes("readyok"),
          () => this.post("isready"),
          BOOT_TIMEOUT_MS,
        ),
        failure,
      ]);
    } finally {
      this.bootReject = null;
    }
  }

  private post(command: string): void {
    this.worker?.postMessage(command);
  }

  private teardownWorker(): void {
    this.worker?.terminate();
    this.worker = null;
    this.lineHandlers.clear();
    for (const cancel of [...this.pendingWaits]) cancel();
    this.pendingWaits.clear();
    const active = this.active;
    this.active = null;
    active?.resolve({ bestMove: null });
  }

  private handleOutput(raw: string): void {
    for (const part of raw.split(/\r?\n/)) {
      const line = part.trim();
      if (!line) continue;

      if (line.startsWith("info ")) {
        this.handleInfo(line);
        continue;
      }

      if (line.startsWith("bestmove")) {
        this.handleBestMove(line);
        continue;
      }

      for (const handler of [...this.lineHandlers]) {
        if (handler(line)) break;
      }
    }
  }

  private handleInfo(line: string): void {
    const active = this.active;
    if (!active) return;
    if (/\b(lowerbound|upperbound)\b/.test(line)) return;

    const depthMatch = /\bdepth (\d+)/.exec(line);
    const scoreMatch = /\bscore (cp|mate) (-?\d+)/.exec(line);
    const npsMatch = /\bnps (\d+)/.exec(line);
    if (npsMatch) active.lastNps = Number(npsMatch[1]);
    if (!depthMatch && !scoreMatch) return;

    const depth = depthMatch ? Number(depthMatch[1]) : active.lastDepth;
    const score: EngineScore | null = scoreMatch
      ? { type: scoreMatch[1] as "cp" | "mate", value: Number(scoreMatch[2]) }
      : null;

    if (!score && depth === active.lastDepth) return;
    active.lastDepth = depth;
    active.onUpdate?.({ depth, score, nps: active.lastNps });
  }

  private handleBestMove(line: string): void {
    const match = /^bestmove\s+(\S+)/.exec(line);
    const bestMove = match && match[1] !== "(none)" ? match[1] : null;

    if (this.discardNextBestMove) {
      this.discardNextBestMove = false;
      return;
    }

    const active = this.active;
    if (!active) return;
    this.active = null;
    active.resolve({ bestMove });
  }

  private waitForLine(
    match: (line: string) => boolean,
    ping: () => void,
    timeoutMs: number,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let interval: ReturnType<typeof setInterval> | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (interval) clearInterval(interval);
        this.lineHandlers.delete(handler);
        this.pendingWaits.delete(cancel);
      };

      const cancel = () => cleanup();

      const handler = (line: string) => {
        if (!match(line)) return false;
        cleanup();
        resolve(line);
        return true;
      };

      timer = setTimeout(() => {
        cleanup();
        reject(new Error("Stockfish took too long to start."));
      }, timeoutMs);

      this.lineHandlers.add(handler);
      this.pendingWaits.add(cancel);
      ping();
      interval = setInterval(ping, 700);
    });
  }

  private fail(cause: string | Error): void {
    const error = cause instanceof Error ? cause : new Error(cause);

    const bootReject = this.bootReject;
    if (bootReject) {
      this.bootReject = null;
      this.teardownWorker();
      bootReject(error);
      return;
    }

    if (this.terminated) return;
    this.terminated = true;
    this.teardownWorker();
    this.onError?.(error.message);
  }
}

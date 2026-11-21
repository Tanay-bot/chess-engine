import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import { Chessboard, defaultPieces } from "react-chessboard";
import type { PieceRenderObject } from "react-chessboard";
import { Chess, type Move, type PieceSymbol, type Square } from "chess.js";
import {
  StockfishEngine,
  type EngineInfo,
  type EngineScore,
  type SearchUpdate,
} from "./engine/stockfish";
import { MoveInputError, playMoveInput } from "./lib/move-input";

type Side = "w" | "b";
type PromotionPiece = "q" | "r" | "b" | "n";

type EvalView = { cp: number | null; mate: number | null };

type Outcome = {
  title: string;
  detail: string;
  winner: Side | null;
  score: string;
};

type EngineReply = {
  san: string;
  label: string;
  value: EvalView | null;
  depth: number;
  nps: number | null;
  elapsedMs: number;
};

/** Search time per engine move. The multi-threaded build turns this into a
 *  much deeper search than the old 1.8s single-thread run. */
const ENGINE_MOVETIME_MS = 1000;

const PIECE_FILL: Record<Side, string> = { w: "#f7f3e8", b: "#101419" };

const PIECES: PieceRenderObject = Object.fromEntries(
  Object.entries(defaultPieces).map(([key, render]) => {
    const isWhite = key.startsWith("w");
    return [
      key,
      (props?: { fill?: string; square?: string; svgStyle?: CSSProperties }) =>
        render({
          ...props,
          fill: isWhite ? PIECE_FILL.w : PIECE_FILL.b,
          svgStyle: {
            ...props?.svgStyle,
            filter: isWhite
              ? "drop-shadow(0 2px 2px rgba(0, 0, 0, 0.35))"
              : "drop-shadow(0 1px 1.5px rgba(240, 245, 250, 0.32))",
          },
        }),
    ];
  }),
) as PieceRenderObject;

const PROMOTION_GLYPHS: Record<PromotionPiece, string> = { q: "♛", r: "♜", b: "♝", n: "♞" };
const PROMOTION_NAMES: Record<PromotionPiece, string> = {
  q: "Queen",
  r: "Rook",
  b: "Bishop",
  n: "Knight",
};
const PROMOTION_PIECES: PromotionPiece[] = ["q", "r", "b", "n"];

function other(color: Side): Side {
  return color === "w" ? "b" : "w";
}

function readOutcome(chess: Chess): Outcome | null {
  if (chess.isCheckmate()) {
    const winner: Side = chess.turn() === "w" ? "b" : "w";
    return {
      title: "Checkmate",
      detail: winner === "w" ? "White delivers mate." : "Black delivers mate.",
      winner,
      score: winner === "w" ? "1–0" : "0–1",
    };
  }
  if (chess.isStalemate()) {
    return { title: "Stalemate", detail: "No legal moves remain — the game is drawn.", winner: null, score: "½–½" };
  }
  if (chess.isInsufficientMaterial()) {
    return { title: "Draw", detail: "Neither side has enough material to mate.", winner: null, score: "½–½" };
  }
  if (chess.isThreefoldRepetition()) {
    return { title: "Draw", detail: "The same position occurred three times.", winner: null, score: "½–½" };
  }
  if (chess.isDrawByFiftyMoves()) {
    return { title: "Draw", detail: "Fifty moves without a capture or pawn move.", winner: null, score: "½–½" };
  }
  if (chess.isDraw()) {
    return { title: "Draw", detail: "The position is drawn.", winner: null, score: "½–½" };
  }
  return null;
}

function findKing(chess: Chess, color: Side): Square | null {
  for (const row of chess.board()) {
    for (const piece of row) {
      if (piece && piece.type === "k" && piece.color === color) return piece.square;
    }
  }
  return null;
}

function applyUci(chess: Chess, uci: string): Move | null {
  const match = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(uci);
  if (!match) return null;

  const from = match[1] as Square;
  const to = match[2] as Square;
  const piece = chess.get(from);
  const promotion =
    (match[3] as PieceSymbol | undefined) ??
    (piece?.type === "p" && (to[1] === "8" || to[1] === "1") ? "q" : undefined);

  try {
    return chess.move(promotion ? { from, to, promotion } : { from, to });
  } catch {
    return null;
  }
}

function toWhiteEval(score: EngineScore, engineColor: Side): EvalView {
  const sign = engineColor === "w" ? 1 : -1;
  return score.type === "mate"
    ? { cp: null, mate: score.value * sign }
    : { cp: score.value * sign, mate: null };
}

function formatEval(value: EvalView | null): string {
  if (!value) return "0.0";
  if (value.mate !== null) return `${value.mate >= 0 ? "+" : "−"}M${Math.abs(value.mate)}`;
  const cp = value.cp ?? 0;
  if (Math.abs(cp) < 5) return "0.0";
  return `${cp > 0 ? "+" : "−"}${(Math.abs(cp) / 100).toFixed(1)}`;
}

function formatNps(nps: number): string {
  if (nps >= 1_000_000) return `${(nps / 1_000_000).toFixed(1)} Mn/s`;
  if (nps >= 1_000) return `${Math.round(nps / 1_000)} kn/s`;
  return `${nps} n/s`;
}

function whiteShare(value: EvalView | null): number {
  if (!value) return 50;
  if (value.mate !== null) return value.mate > 0 ? 100 : 0;
  const cp = Math.max(-1200, Math.min(1200, value.cp ?? 0));
  return 100 / (1 + Math.exp(-cp / 330));
}

export default function App() {
  const chessRef = useRef(new Chess());
  const engineRef = useRef<StockfishEngine | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const searchToken = useRef(0);
  const setupOpenRef = useRef(true);

  const [fen, setFen] = useState(chessRef.current.fen());
  const [moves, setMoves] = useState<Move[]>([]);
  const [side, setSide] = useState<Side | null>(null);
  const [setupOpen, setSetupOpen] = useState(true);
  const [result, setResult] = useState<Outcome | null>(null);
  const [thinking, setThinking] = useState(false);
  const [searchInfo, setSearchInfo] = useState<{
    depth: number;
    value: EvalView | null;
    nps: number | null;
  }>({ depth: 0, value: null, nps: null });
  const [engineReply, setEngineReply] = useState<EngineReply | null>(null);
  const [engineInfo, setEngineInfo] = useState<EngineInfo | null>(null);
  const [lastMove, setLastMove] = useState<{ from: string; to: string } | null>(null);
  const [selected, setSelected] = useState<Square | null>(null);
  const [pendingPromotion, setPendingPromotion] = useState<{ from: Square; to: Square } | null>(null);
  const [typedMove, setTypedMove] = useState("");
  const [error, setError] = useState("");
  const [engineState, setEngineState] = useState<"loading" | "ready" | "error">("loading");
  const [engineError, setEngineError] = useState("");

  setupOpenRef.current = setupOpen;

  const chess = chessRef.current;
  const turn = chess.turn();
  const playerCanMove = side !== null && !result && !setupOpen && turn === side && !pendingPromotion;
  const engineColor: Side = side ? other(side) : "b";

  /* ---------------------------------------------------------------- engine */

  useEffect(() => {
    const engine = new StockfishEngine({
      onError: (message) => {
        setEngineState("error");
        setEngineError(message);
      },
    });
    engineRef.current = engine;
    let disposed = false;

    engine
      .init()
      .then(() => {
        if (disposed) return;
        setEngineInfo(engine.info);
        setEngineState("ready");
      })
      .catch((cause: unknown) => {
        if (disposed) return;
        setEngineState("error");
        setEngineError(cause instanceof Error ? cause.message : "Could not start Stockfish.");
      });

    return () => {
      disposed = true;
      engine.terminate();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || engineState !== "ready" || !side || result || setupOpen) return;

    const board = chessRef.current;
    if (board.turn() === side) return;

    const engineToMove: Side = board.turn();
    const fenAtSearch = board.fen();
    const token = ++searchToken.current;
    const startedAt = performance.now();
    let cancelled = false;
    let latest: SearchUpdate | null = null;
    let lastPaint = 0;

    setThinking(true);

    engine
      .search(board.fen(), {
        movetime: ENGINE_MOVETIME_MS,
        onUpdate: (update) => {
          if (cancelled || token !== searchToken.current) return;
          latest = update;
          const now = performance.now();
          if (now - lastPaint < 100) return;
          lastPaint = now;
          setSearchInfo((previous) => ({
            depth: update.depth || previous.depth,
            value: update.score ? toWhiteEval(update.score, engineToMove) : previous.value,
            nps: update.nps ?? previous.nps,
          }));
        },
      })
      .then(({ bestMove }) => {
        if (cancelled || token !== searchToken.current) return;
        if (!bestMove) return;
        // Never apply a result computed for a different position.
        if (board.fen() !== fenAtSearch || board.turn() !== engineToMove) return;

        const moveNumber = board.moveNumber();
        const move = applyUci(board, bestMove);
        if (!move) return;

        const finalUpdate = latest;
        const value = finalUpdate?.score ? toWhiteEval(finalUpdate.score, engineToMove) : null;
        if (finalUpdate) {
          setSearchInfo((previous) => ({
            depth: finalUpdate.depth || previous.depth,
            value: value ?? previous.value,
            nps: finalUpdate.nps ?? previous.nps,
          }));
        }

        // Echo the engine's answer back to the player, with the numbers behind it.
        setEngineReply({
          san: move.san,
          label: engineToMove === "w" ? `${moveNumber}.` : `${moveNumber}…`,
          value,
          depth: finalUpdate?.depth ?? 0,
          nps: finalUpdate?.nps ?? null,
          elapsedMs: performance.now() - startedAt,
        });

        setFen(board.fen());
        setMoves(board.history({ verbose: true }));
        setLastMove({ from: move.from, to: move.to });

        const outcome = readOutcome(board);
        if (outcome) setResult(outcome);
      })
      .finally(() => {
        if (cancelled || token !== searchToken.current) return;
        setThinking(false);
        if (!chessRef.current.isGameOver()) {
          inputRef.current?.focus({ preventScroll: true });
        }
      });

    return () => {
      cancelled = true;
      if (searchToken.current === token) searchToken.current += 1;
      engine.stop();
      setThinking(false);
    };
  }, [fen, side, result, engineState, setupOpen]);

  /* ----------------------------------------------------------------- focus */

  useEffect(() => {
    if (!side || result || setupOpen) return;
    if (chessRef.current.turn() === side) {
      inputRef.current?.focus({ preventScroll: true });
    }
  }, [fen, side, result, setupOpen]);

  useEffect(() => {
    const list = historyRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [moves.length]);

  useEffect(() => {
    if (!pendingPromotion) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPendingPromotion(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pendingPromotion]);

  const focusInput = useCallback(() => {
    if (setupOpenRef.current) return;
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  /* ------------------------------------------------------------------ game */

  const finishMove = useCallback((move: Move) => {
    const board = chessRef.current;
    setEngineReply(null);
    setFen(board.fen());
    setMoves(board.history({ verbose: true }));
    setLastMove({ from: move.from, to: move.to });
    setSelected(null);
    setPendingPromotion(null);
    setError("");
    const outcome = readOutcome(board);
    if (outcome) setResult(outcome);
  }, []);

  const tryPlayerMove = useCallback(
    (from: Square, to: Square, promotion?: PromotionPiece): boolean => {
      if (!playerCanMove) return false;
      const board = chessRef.current;
      const piece = board.get(from);
      if (piece?.type === "p" && (to.endsWith("8") || to.endsWith("1")) && !promotion) {
        setPendingPromotion({ from, to });
        return true;
      }
      try {
        const move = board.move(promotion ? { from, to, promotion } : { from, to });
        if (!move) return false;
        finishMove(move);
        return true;
      } catch {
        return false;
      }
    },
    [finishMove, playerCanMove],
  );

  const completePromotion = useCallback(
    (promotion: PromotionPiece) => {
      const pending = pendingPromotion;
      setPendingPromotion(null);
      if (!pending) return;
      try {
        const move = chessRef.current.move({ from: pending.from, to: pending.to, promotion });
        if (move) finishMove(move);
      } catch {
        setError("That promotion is not legal.");
        focusInput();
      }
    },
    [finishMove, focusInput, pendingPromotion],
  );

  const startGame = useCallback((nextSide: Side) => {
    searchToken.current += 1;
    const engine = engineRef.current;
    engine?.stop();
    engine?.newGame();

    chessRef.current = new Chess();
    setFen(chessRef.current.fen());
    setMoves([]);
    setSide(nextSide);
    setResult(null);
    setThinking(false);
    setSearchInfo({ depth: 0, value: null, nps: null });
    setEngineReply(null);
    setLastMove(null);
    setSelected(null);
    setPendingPromotion(null);
    setTypedMove("");
    setError("");
    setSetupOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  }, []);

  const openSetup = useCallback(() => {
    searchToken.current += 1;
    engineRef.current?.stop();
    setThinking(false);
    setSelected(null);
    setPendingPromotion(null);
    setEngineReply(null);
    setError("");
    setSetupOpen(true);
  }, []);

  const resign = useCallback(() => {
    if (!side || result) return;
    searchToken.current += 1;
    engineRef.current?.stop();
    setThinking(false);
    const winner = other(side);
    setResult({
      title: "Resignation",
      detail: "You resigned the game.",
      winner,
      score: winner === "w" ? "1–0" : "0–1",
    });
  }, [result, side]);

  const submitTypedMove = (event: FormEvent) => {
    event.preventDefault();
    if (setupOpen) return;

    if (!side) return;
    if (result) {
      setError("The game is over. Start a new game.");
      return;
    }
    if (chessRef.current.turn() !== side) {
      setError("Stockfish is still thinking.");
      inputRef.current?.focus({ preventScroll: true });
      return;
    }

    try {
      const move = playMoveInput(chessRef.current, typedMove);
      setTypedMove("");
      finishMove(move);
    } catch (cause) {
      setError(cause instanceof MoveInputError ? cause.message : "Not a legal move.");
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.select();
    }
  };

  /* ----------------------------------------------------------------- board */

  const legalTargets = useMemo(() => {
    if (!selected) return [] as Square[];
    try {
      return chessRef.current.moves({ square: selected, verbose: true }).map((move) => move.to);
    } catch {
      return [] as Square[];
    }
  }, [selected, fen]);

  const squareStyles = useMemo(() => {
    const styles: Record<string, CSSProperties> = {};
    const board = chessRef.current;

    if (lastMove) {
      const highlight: CSSProperties = { backgroundColor: "rgba(217, 184, 119, 0.34)" };
      styles[lastMove.from] = { ...highlight };
      styles[lastMove.to] = { ...highlight };
    }

    if (board.inCheck()) {
      const king = findKing(board, board.turn());
      if (king) {
        styles[king] = {
          ...styles[king],
          backgroundImage:
            "radial-gradient(circle, rgba(226, 114, 110, 0.92) 0%, rgba(226, 114, 110, 0.45) 46%, rgba(226, 114, 110, 0) 72%)",
        };
      }
    }

    if (selected) {
      styles[selected] = {
        ...styles[selected],
        backgroundColor: "rgba(217, 184, 119, 0.48)",
        boxShadow: "inset 0 0 0 2px rgba(240, 210, 154, 0.85)",
      };
    }

    for (const target of legalTargets) {
      const occupied = board.get(target);
      styles[target] = occupied
        ? { ...styles[target], boxShadow: "inset 0 0 0 4px rgba(9, 11, 13, 0.34)" }
        : {
            ...styles[target],
            backgroundImage:
              "radial-gradient(circle, rgba(9, 11, 13, 0.38) 0%, rgba(9, 11, 13, 0.38) 17%, transparent 18%)",
          };
    }

    return styles;
  }, [lastMove, selected, legalTargets, fen]);

  const handleDrop = useCallback(
    ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }) => {
      if (!targetSquare || !playerCanMove) return false;
      return tryPlayerMove(sourceSquare as Square, targetSquare as Square);
    },
    [playerCanMove, tryPlayerMove],
  );

  const handleSquareClick = useCallback(
    ({ square, piece }: { square: string; piece: { pieceType: string } | null }) => {
      if (!playerCanMove) return;
      const target = square as Square;
      const ownPiece = chessRef.current.get(target)?.color === side;

      if (selected) {
        if (target === selected) {
          setSelected(null);
          return;
        }
        if (tryPlayerMove(selected, target)) return;
        setSelected(ownPiece ? target : null);
        return;
      }

      if (ownPiece || piece?.pieceType.startsWith(side ?? "")) setSelected(target);
    },
    [playerCanMove, selected, side, tryPlayerMove],
  );

  /* ------------------------------------------------------------------- ui */

  const movePairs = useMemo(() => {
    const pairs: { number: number; white?: Move; black?: Move }[] = [];
    for (let index = 0; index < moves.length; index += 2) {
      pairs.push({ number: index / 2 + 1, white: moves[index], black: moves[index + 1] });
    }
    return pairs;
  }, [moves]);

  const latestMove = moves.length > 0 ? moves[moves.length - 1] : null;
  const evalShare = whiteShare(searchInfo.value);
  const resultTone = result ? (result.winner === null ? "draw" : result.winner === side ? "win" : "loss") : "";

  const boardOptions = {
    position: fen,
    boardOrientation: side === "b" ? ("black" as const) : ("white" as const),
    boardStyle: { width: "100%", height: "100%", borderRadius: "9px", overflow: "hidden" },
    lightSquareStyle: { backgroundColor: "#a9b3be" },
    darkSquareStyle: { backgroundColor: "#525d6a" },
    lightSquareNotationStyle: { color: "rgba(14, 18, 23, 0.55)" },
    darkSquareNotationStyle: { color: "rgba(247, 243, 232, 0.55)" },
    squareStyles,
    pieces: PIECES,
    animationDurationInMs: 180,
    showAnimations: true,
    allowDragging: true,
    allowDragOffBoard: false,
    allowDrawingArrows: false,
    showNotation: true,
    canDragPiece: ({ square, piece }: { square: string | null; piece: { pieceType: string } }) =>
      Boolean(playerCanMove && square && piece.pieceType[0] === side),
    onPieceDrop: handleDrop,
    onSquareClick: handleSquareClick,
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            ♞
          </div>
          <div className="brand-text">
            <h1>Grandmaster</h1>
            <p>Play the machine</p>
          </div>
        </div>

        <div className="topbar-right">
          <span className="engine-chip">
            <i
              className={`dot ${
                engineState === "ready" ? (thinking ? "busy" : "live") : engineState === "error" ? "bad" : ""
              }`}
            />
            Stockfish 19 · Skill 20{engineInfo ? ` · ${engineInfo.threads}t` : ""}
          </span>
          <button className="btn ghost" onClick={openSetup} disabled={setupOpen}>
            New game
          </button>
        </div>
      </header>

      <main className="layout">
        <section className="board-col">
          {result ? (
            <div className={`result ${resultTone}`} role="status">
              <span className="result-score">{result.score}</span>
              <div className="result-copy">
                <strong>{result.title}</strong>
                <p>
                  {result.winner === null
                    ? result.detail
                    : result.winner === side
                      ? "You win — Stockfish 19 tips its king."
                      : result.title === "Resignation"
                        ? "You resigned. Stockfish 19 takes the point."
                        : "Stockfish 19 wins this one."}
                </p>
              </div>
              <div className="result-actions">
                <button className="btn primary sm" onClick={() => (side ? startGame(side) : openSetup())}>
                  Rematch
                </button>
                <button className="btn ghost sm" onClick={openSetup}>
                  Change side
                </button>
              </div>
            </div>
          ) : (
            <div className="board-meta">
              <span className="meta-you">
                <span className={`swatch ${side === "b" ? "dark" : "light"}`} aria-hidden="true" />
                {side ? (
                  <>
                    You play <b>{side === "w" ? "White" : "Black"}</b>
                  </>
                ) : (
                  <>Choose a side to begin</>
                )}
              </span>
              <span className="eval-chip">
                Eval <b>{formatEval(searchInfo.value)}</b>
              </span>
            </div>
          )}

          <div className="board-row">
            <div
              className="evalbar"
              role="img"
              aria-label={`Evaluation ${formatEval(searchInfo.value)} for White`}
            >
              <div className="evalbar-fill" style={{ height: `${evalShare}%` }} />
              <div className="evalbar-mid" />
            </div>

            <div className="board-frame">
              {/* data-chess-fen is the hook the best-move extension reads. */}
              <div
                className="board"
                onPointerDown={focusInput}
                data-chess-fen={fen}
                data-chess-turn={turn}
              >
                <Chessboard options={boardOptions} />

                {pendingPromotion && (
                  <div className="setup" onPointerDown={(event) => event.stopPropagation()}>
                    <div className="promo-card">
                      <p className="eyebrow">Promote to</p>
                      <div className="promo-row">
                        {PROMOTION_PIECES.map((piece) => (
                          <button
                            key={piece}
                            className="promo-btn"
                            onClick={() => completePromotion(piece)}
                            aria-label={PROMOTION_NAMES[piece]}
                            title={PROMOTION_NAMES[piece]}
                          >
                            <span className={side === "w" ? "piece-white" : "piece-black"}>
                              {PROMOTION_GLYPHS[piece]}
                            </span>
                          </button>
                        ))}
                      </div>
                      <button className="btn ghost sm" onClick={() => setPendingPromotion(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {setupOpen && (
                  <div className="setup" onPointerDown={(event) => event.stopPropagation()}>
                    <div className="setup-card">
                      <p className="eyebrow">{moves.length > 0 ? "New game" : "Grandmaster"}</p>
                      <h2>Choose your side</h2>
                      <p className="setup-sub">
                        {engineInfo
                          ? `Stockfish 19 answers with its full neural network at maximum strength — ${engineInfo.threads} ${
                              engineInfo.threads === 1 ? "thread" : "threads"
                            }, ${engineInfo.hash} MB hash, 1.0s per move.`
                          : "Stockfish 19 answers with its full neural network at maximum strength."}
                      </p>

                      <div className="side-grid">
                        <button
                          className="side-btn"
                          onClick={() => startGame("w")}
                          disabled={engineState !== "ready"}
                        >
                          <span className="swatch light" aria-hidden="true" />
                          <span className="side-name">White</span>
                          <span className="side-note">You move first</span>
                        </button>
                        <button
                          className="side-btn"
                          onClick={() => startGame("b")}
                          disabled={engineState !== "ready"}
                        >
                          <span className="swatch dark" aria-hidden="true" />
                          <span className="side-name">Black</span>
                          <span className="side-note">Stockfish opens</span>
                        </button>
                      </div>

                      {engineState === "loading" && (
                        <div className="engine-load">
                          <div className="load-bar">
                            <span />
                          </div>
                          <p>Warming up Stockfish 19 · 94 MB neural network</p>
                        </div>
                      )}

                      {engineState === "error" && (
                        <div className="engine-error">
                          <p>Stockfish could not start. {engineError}</p>
                          <button className="btn ghost sm" onClick={() => window.location.reload()}>
                            Reload
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {engineReply && !setupOpen && (
            <div
              className="engine-reply"
              key={`${moves.length}-${engineReply.san}`}
              role="status"
              aria-live="polite"
            >
              <span className="reply-label">Stockfish played</span>
              <strong className="reply-move">
                {engineReply.label} {engineReply.san}
              </strong>
              <span className="reply-stats">
                {engineReply.value ? formatEval(engineReply.value) : "—"}
                {engineReply.depth ? ` · d${engineReply.depth}` : ""}
                {` · ${(engineReply.elapsedMs / 1000).toFixed(1)}s`}
              </span>
            </div>
          )}

          <p className="board-caption">
            {thinking
              ? `Stockfish is calculating${searchInfo.depth ? ` · depth ${searchInfo.depth}` : ""}${
                  searchInfo.nps ? ` · ${formatNps(searchInfo.nps)}` : ""
                }…`
              : setupOpen
                ? "Full-strength NNUE · 1.0s per move"
                : result
                  ? "Game over"
                  : side && turn === side
                    ? "Your move"
                    : "Stockfish to move"}
          </p>
        </section>

        <aside className="panel">
          <div className="panel-head">
            <span>Match</span>
            <span className={`status ${thinking ? "busy" : ""}`}>
              <i
                className={`dot ${
                  engineState === "ready" ? (thinking ? "busy" : "live") : engineState === "error" ? "bad" : ""
                }`}
              />
              {engineState === "loading"
                ? "Loading"
                : engineState === "error"
                  ? "Offline"
                  : thinking
                    ? "Thinking"
                    : "Ready"}
            </span>
          </div>

          <div className="players">
            <div className={`player ${turn === engineColor && !result ? "active" : ""}`}>
              <div className="avatar engine" aria-hidden="true">
                ♞
              </div>
              <div className="player-info">
                <div className="player-name">Stockfish 19</div>
                <div className="player-sub">
                  {engineColor === "w" ? "White" : "Black"} ·{" "}
                  {engineInfo
                    ? `${engineInfo.threads} ${engineInfo.threads === 1 ? "thread" : "threads"} · ${engineInfo.hash} MB hash`
                    : "NNUE · full strength"}
                </div>
              </div>
              <span className={`turn-flag ${turn === engineColor && !result ? "on" : ""}`} />
            </div>

            <div className={`player ${turn === side && side && !result ? "active" : ""}`}>
              <div className="avatar human" aria-hidden="true">
                {side === "b" ? "♚" : "♔"}
              </div>
              <div className="player-info">
                <div className="player-name">You</div>
                <div className="player-sub">{side ? (side === "w" ? "White" : "Black") : "Waiting"}</div>
              </div>
              <span className={`turn-flag ${turn === side && side && !result ? "on" : ""}`} />
            </div>
          </div>

          <div>
            <div className="field-label">
              <span>Your move</span>
              <span>SAN / UCI</span>
            </div>
            <form className="move-form" onSubmit={submitTypedMove}>
              <input
                ref={inputRef}
                className="move-input"
                value={typedMove}
                onChange={(event) => {
                  setTypedMove(event.target.value);
                  if (error) setError("");
                }}
                placeholder={turn === side && side ? "e4 · Nf3 · e2e4 · O-O" : "Stockfish is thinking…"}
                aria-label="Type your move in algebraic or coordinate notation"
                aria-invalid={Boolean(error)}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                disabled={setupOpen || Boolean(result)}
              />
              <button
                type="submit"
                className="move-submit"
                aria-label="Play move"
                disabled={setupOpen || Boolean(result)}
              >
                ↵
              </button>
            </form>
            <p className={`hint ${error ? "error" : ""}`} role={error ? "alert" : undefined}>
              {error || "Type a move and press Enter · drag pieces as a fallback"}
            </p>
          </div>

          <div className="history">
            <div className="history-head">
              <span>Moves</span>
              <span>{moves.length ? `${Math.ceil(moves.length / 2)} moves` : "—"}</span>
            </div>
            <div className="move-list" ref={historyRef} aria-label="Move history">
              {movePairs.length === 0 ? (
                <p className="empty">
                  {side === "b" ? "Stockfish is about to open." : "The board is waiting for your first move."}
                </p>
              ) : (
                movePairs.map((pair) => (
                  <div className="move-row" key={pair.number}>
                    <span className="move-no">{pair.number}</span>
                    <span className={`move-san ${pair.white === latestMove ? "latest" : ""}`}>
                      {pair.white?.san ?? ""}
                    </span>
                    <span className={`move-san ${pair.black === latestMove ? "latest" : ""}`}>
                      {pair.black?.san ?? ""}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="panel-actions">
            <button
              className="btn ghost danger"
              onClick={resign}
              disabled={!side || Boolean(result) || setupOpen}
            >
              Resign
            </button>
            <button className="btn primary" onClick={openSetup} disabled={setupOpen}>
              New game
            </button>
          </div>
        </aside>
      </main>

      <footer className="footer">
        <span>Stockfish 19 · full NNUE · 1.0s per move</span>
        <span>
          {engineInfo ? `${engineInfo.threads}-thread search · all local` : "Runs locally in your browser"}
        </span>
      </footer>
    </div>
  );
}

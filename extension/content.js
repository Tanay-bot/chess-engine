/**
 * Best-move overlay.
 *
 * Reads the position straight from the page DOM, runs Stockfish 19 in a Web
 * Worker and shows the engine's choice for the side to move, with the from/to
 * squares outlined on the board.
 *
 * Four board sources are understood:
 *
 *  1. A FEN hook (preferred, exact): any element carrying a full FEN
 *       <div data-chess-fen="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1">
 *     or a bare placement, which is completed with "w - - 0 1".
 *
  * 2. A 64-square grid: squares carrying data-square="e4" whose piece element
 *     carries data-piece="wP" (or a wP/bp class token). The turn is taken from
 *     an optional data-chess-turn="w|b" attribute; without it the overlay asks.
 *
 * 3. A chess.com board: <wc-chess-board> with one div.piece per piece, whose
 *     class names the square (`piece wp square-52` is a white pawn on e2). The
 *     turn comes from the running clock, or from the move list, or the overlay
 *     asks; castling rights are inferred from the kings and rooks on home squares.
 *
 * 4. A lichess board: <cg-board> with one <piece class="white rook"> per piece,
 *     whose transform is the square (`translate(177px, 0px)` is d8). The turn
 *     comes from the running clock, or from the last-move squares, or the overlay
 *     asks; castling rights are inferred the same way as on chess.com.
 *
 * It only runs where the extension is allowed: localhost from manifest.json plus
 * whatever the user adds on the extension's options page.
 */
(() => {
  "use strict";

  if (window.__bestMoveOverlay) return;
  window.__bestMoveOverlay = true;

  // The overlay should read like a strong human, not a machine. It plays at a
  // 2400 rating and does not always hand back the engine's favourite move.
  const HUMAN_ELO = 2400;
  const CANDIDATES = 4; // lines the engine reports, so a worse one can be chosen
  const MOVETIME_MS = 900; // the middle of the think time; each position varies
  const MOVETIME_JITTER = 500;
  const DEBOUNCE_MS = 220;
  const ENGINE_SCRIPT = "engine/stockfish-19-single.js";
  const ENGINE_WASM = "engine/stockfish-19-single.wasm";

  const GLYPH = { p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚" };
  const PIECE_NAME = { p: "Pawn", n: "Knight", b: "Bishop", r: "Rook", q: "Queen", k: "King" };

  let enabled = true;
  let worker = null;
  let engineBlob = null;
  let engineStatus = "idle"; // idle | loading | ready | error
  let engineNote = "";
  let uciDone = false;
  let bootPing = 0;
  let revivals = 0;
  let crashFen = null; // a position the engine threw on; never sent twice

  let wantedFen = null;
  let activeFen = null;
  let searching = false;
  let sideHint = null; // "w" | "b" | null — used when a grid has no turn attribute
  let turnKnown = true;

  let best = null; // { label, uci, from, to, glyph, evalText, depth, note }
  let liveDepth = 0;
  let liveScore = null;
  let candidates = new Map(); // multipv index -> { uci, score, depth }, last whole set
  let candidateDepth = 0;
  let pending = new Map(); // the iteration still being reported
  let pendingDepth = 0;
  const pickCache = new Map(); // fen -> the move it was already given
  let lastPaint = 0;
  let refreshTimer = 0;

  let boardEl = null; // chess.com or lichess board the position was read from
  let boardWatch = null;
  const boardResize = new ResizeObserver(() => paintHighlights());
  let watchedBoard = null;
  let moveListWatch = null;
  let markTimer = 0;
  let lastPlacement = null; // pieces only, so the turn cannot feed back into it

  /* --------------------------------------------------------------------- ui */

  const host = document.createElement("div");
  host.id = "best-move-overlay";
  host.style.cssText = "all: initial;";

  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      .card {
        position: fixed;
        z-index: 2147483001;
        right: 18px;
        bottom: 18px;
        width: 208px;
        box-sizing: border-box;
        padding: 10px 12px 9px;
        border: 1px solid #25303f;
        border-radius: 12px;
        background: #0e1218;
        color: #e9edf3;
        font: 13px/1.35 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55);
        user-select: none;
      }
      .head { display: flex; align-items: center; gap: 6px; }
      .dot { width: 6px; height: 6px; border-radius: 50%; background: #6b7686; flex: none; }
      .dot.live { background: #4fc57e; }
      .dot.busy { background: #d9b877; }
      .dot.bad { background: #e2726e; }
      .title { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: #97a3b4; }
      .status { margin-left: auto; font-size: 11px; color: #7f8b9c; font-variant-numeric: tabular-nums; }
      button.close {
        all: unset;
        cursor: pointer;
        color: #6f7b8c;
        font-size: 15px;
        line-height: 1;
        padding: 0 2px;
      }
      button.close:hover { color: #e9edf3; }
      .move { display: flex; align-items: baseline; gap: 7px; margin-top: 7px; }
      .glyph { font-size: 21px; line-height: 1; color: #d9b877; }
      .label {
        font-size: 24px;
        font-weight: 650;
        letter-spacing: 0.01em;
        font-variant-numeric: tabular-nums;
      }
      .label.dim { color: #5d6878; font-size: 17px; font-weight: 500; }
      .meta {
        display: flex;
        gap: 8px;
        margin-top: 6px;
        font-size: 11.5px;
        color: #8d99aa;
        font-variant-numeric: tabular-nums;
      }
      .meta .uci { color: #6f7b8c; }
      .side { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 11px; color: #8d99aa; }
      .side button {
        all: unset;
        cursor: pointer;
        padding: 2px 7px;
        border: 1px solid #2b3648;
        border-radius: 6px;
        color: #c3ccd9;
        font-size: 11px;
      }
      .side button.on { border-color: #d9b877; color: #f0e2c2; }
      .foot { margin-top: 7px; font-size: 10px; color: #5d6878; }
      .note { margin-top: 6px; font-size: 11px; color: #e2726e; }
      [hidden] { display: none !important; }
    </style>
    <div class="card" hidden>
      <div class="head">
        <span class="dot"></span>
        <span class="title">Best move</span>
        <span class="status">idle</span>
        <button class="close" title="Hide (Alt+B)">×</button>
      </div>
      <div class="move">
        <span class="glyph">♞</span>
        <span class="label dim">—</span>
      </div>
      <div class="meta">
        <span class="uci"></span>
        <span class="eval"></span>
        <span class="depth"></span>
      </div>
      <div class="side" hidden>
        <span>Whose move?</span>
        <button data-side="w">White</button>
        <button data-side="b">Black</button>
      </div>
      <div class="note" hidden></div>
      <div class="foot">Stockfish 19 · ~2400 · Alt+B</div>
    </div>
  `;

  const card = root.querySelector(".card");
  const dot = root.querySelector(".dot");
  const statusEl = root.querySelector(".status");
  const glyphEl = root.querySelector(".glyph");
  const labelEl = root.querySelector(".label");
  const uciEl = root.querySelector(".uci");
  const evalEl = root.querySelector(".eval");
  const depthEl = root.querySelector(".depth");
  const sideEl = root.querySelector(".side");
  const noteEl = root.querySelector(".note");

  const highlights = document.createElement("div");
  highlights.style.cssText =
    "position: fixed; inset: 0; pointer-events: none; z-index: 2147483000; margin: 0; padding: 0;";

  // A squares pair alone leaves you hunting for the move, so the best move is
  // drawn as an arrow as well. It is an SVG in the page itself rather than in the
  // shadow root, so the arrowhead marker resolves and the coordinates are plain
  // viewport pixels, exactly like the highlight boxes.
  const arrows = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  arrows.style.cssText =
    "position:fixed;left:0;top:0;pointer-events:none;overflow:visible;z-index:2147483000;";
  arrows.innerHTML =
    '<defs><marker id="best-move-arrow-head" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="2.6" markerHeight="2.6" orient="auto">' +
    '<path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(217,184,119,0.92)"/></marker></defs>' +
    '<line stroke="rgba(217,184,119,0.92)" stroke-linecap="round" marker-end="url(#best-move-arrow-head)" visibility="hidden"/>';
  const arrowShaft = arrows.querySelector("line");

  root.querySelector(".close").addEventListener("click", () => toggle(false));
  sideEl.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-side]");
    if (!button) return;
    sideHint = button.dataset.side === "b" ? "b" : "w";
    refresh(true);
  });

  /* ------------------------------------------------------------------ board */

  function normaliseFen(raw) {
    if (!raw) return null;
    const parts = String(raw).trim().replace(/\s+/g, " ").split(" ");
    const placement = parts[0];
    if (!/^[rnbqkpRNBQKP1-8]+(\/[rnbqkpRNBQKP1-8]+){7}$/.test(placement)) return null;
    if (parts.length >= 6) return `${placement} ${parts[1] === "b" ? "b" : "w"} ${parts[2]} ${parts[3]} ${parts[4]} ${parts[5]}`;
    const turn = parts[1] === "b" ? "b" : "w";
    return `${placement} ${turn} - - 0 1`;
  }

  function readPiece(squareEl) {
    const holder = squareEl.hasAttribute("data-piece")
      ? squareEl
      : squareEl.querySelector("[data-piece]");
    let code = holder?.getAttribute("data-piece") ?? "";

    if (!code) {
      for (const node of [squareEl, ...squareEl.querySelectorAll("[class]")]) {
        const token = [...node.classList].find((name) => /^[wb][pnbrqk]$/.test(name));
        if (token) {
          code = token;
          break;
        }
      }
    }

    if (!/^[wb][pnbrqk]$/i.test(code)) return null;
    const type = code[1].toLowerCase();
    return code[0].toLowerCase() === "w" ? type.toUpperCase() : type;
  }

  function boardFromSquares() {
    const squares = [...document.querySelectorAll("[data-square]")];
    if (squares.length !== 64) return null;

    const rows = new Map();
    for (const square of squares) {
      const name = square.getAttribute("data-square") ?? "";
      if (!/^[a-h][1-8]$/.test(name)) return null;
      const file = name.charCodeAt(0) - 97;
      const rank = Number(name[1]);
      if (!rows.has(rank)) rows.set(rank, new Array(8).fill(null));
      rows.get(rank)[file] = readPiece(square);
    }

    const placement = rowsToPlacement(rows);

    const turnCarrier = squares[0].closest("[data-chess-turn]");
    const declaredTurn = turnCarrier?.getAttribute("data-chess-turn");
    const knowsTurn = declaredTurn === "w" || declaredTurn === "b";
    const turn = knowsTurn ? declaredTurn : sideHint ?? "w";

    return {
      fen: `${placement} ${turn} - 0 1`,
      turnKnown: knowsTurn,
    };
  }

  function rowsToPlacement(rows) {
    const placement = [];
    for (let rank = 8; rank >= 1; rank -= 1) {
      const row = rows.get(rank) ?? new Array(8).fill(null);
      let chunk = "";
      let empty = 0;
      for (const cell of row) {
        if (!cell) {
          empty += 1;
          continue;
        }
        if (empty) {
          chunk += empty;
          empty = 0;
        }
        chunk += cell;
      }
      if (empty) chunk += empty;
      placement.push(chunk || "8");
    }
    return placement.join("/");
  }

  function boardFromFen() {
    const holders = [...document.querySelectorAll("[data-chess-fen], [data-fen]")];
    for (const holder of holders) {
      if (!holder.getClientRects().length) continue;
      const fen = normaliseFen(holder.getAttribute("data-chess-fen") ?? holder.getAttribute("data-fen"));
      // A FEN always carries the side to move, so no extra attribute is needed.
      if (fen) return { fen, turnKnown: true };
    }
    return null;
  }

  /* --------------------------------------------------------- chess.com board */

  // chess.com draws one div per piece inside <wc-chess-board> and names its
  // square in the class list: `piece wp square-52` is the white pawn on e2.
  // The number is file (1 = a) then rank (1 = 1), independent of the board's
  // flip, because flipping only mirrors the board with CSS.
  const CHESSCOM_SQUARE = /^square-([1-8])([1-8])$/;
  const START_PLACEMENT = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";

  function chessComBoard() {
    let bestBoard = null;
    let bestArea = 0;
    for (const board of document.querySelectorAll("wc-chess-board")) {
      const rect = board.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea && board.querySelector(".piece")) {
        bestBoard = board;
        bestArea = area;
      }
    }
    return bestBoard;
  }

  function chessComPlacement(board) {
    const rows = new Map();

    for (const piece of board.querySelectorAll(".piece")) {
      let code = "";
      let square = null;
      for (const token of piece.classList) {
        if (/^[wb][pnbrqk]$/.test(token)) code = token;
        const match = CHESSCOM_SQUARE.exec(token);
        if (match) square = match;
      }
      if (!code || !square) continue;

      const file = Number(square[1]) - 1;
      const rank = Number(square[2]);
      if (!rows.has(rank)) rows.set(rank, new Array(8).fill(null));
      rows.get(rank)[file] = code[0] === "w" ? code[1].toUpperCase() : code[1];
    }

    return rows.size ? rowsToPlacement(rows) : null;
  }

  // The board does not say whether castling is still available, so it is
  // inferred from the kings and rooks standing on their home squares. A king
  // that walked away and came back still looks castled by placement, so the
  // caller can veto a side whose king the move list says has moved.
  function castlingFromPlacement(placement, kingMoved = {}) {
    const at = (square) => pieceFromFen(`${placement} w - - 0 1`, square);
    let rights = "";
    if (at("e1") === "K" && !kingMoved.w) {
      rights += (at("h1") === "R" ? "K" : "") + (at("a1") === "R" ? "Q" : "");
    }
    if (at("e8") === "k" && !kingMoved.b) {
      rights += (at("h8") === "r" ? "k" : "") + (at("a8") === "r" ? "q" : "");
    }
    return rights || "-";
  }

  // The plies the board is showing: chess.com marks the ply you browsed to, and
  // with nothing marked the list's own end is on the board.
  function chessComShownPlies(placement) {
    const plies = [...document.querySelectorAll(".main-line-ply")];
    const selected = plies.findIndex((ply) => ply.querySelector(".selected"));
    if (selected !== -1) return plies.slice(0, selected + 1);
    // Unmarked, the board shows the end of the line, unless it still shows the
    // position the game or analysis started from.
    return placement === START_PLACEMENT ? [] : plies;
  }

  // Which sides have moved their king in the plies shown: a king move or a
  // castle both use the right up for good, so plies after the shown one must
  // not count.
  function chessComKingsMoved(shown) {
    const moved = {};
    for (const node of shown) {
      const san = node.textContent.trim();
      if (!san.startsWith("K") && !san.startsWith("O-O")) continue;
      moved[node.classList.contains("white-move") ? "w" : "b"] = true;
    }
    return moved;
  }

  function chessComTurn(shown) {
    // Live and daily games mark the clock of the side to move.
    const running = document.querySelector(".clock-player-turn");
    if (running) {
      const names = String(running.className);
      if (names.includes("clock-white")) return "w";
      if (names.includes("clock-black")) return "b";
    }

    // Otherwise the shown half moves say whose turn it is: an odd count leaves
    // black to move.
    if (shown) return shown % 2 === 1 ? "b" : "w";

    return null;
  }

  function boardFromChessCom() {
    const board = chessComBoard();
    if (!board) return null;
    const placement = chessComPlacement(board);
    if (!placement) return null;

    const shown = chessComShownPlies(placement);
    // With no clock and no moves played yet, the start position is white's.
    const turn = chessComTurn(shown.length) ?? (placement === START_PLACEMENT ? "w" : null);
    return {
      fen: `${placement} ${turn ?? sideHint ?? "w"} ${castlingFromPlacement(placement, chessComKingsMoved(shown))} - 0 1`,
      turnKnown: turn !== null,
      board,
    };
  }

  // Neither site has an element per square, so highlights are placed from the
  // board's own box: eight equal columns and rows inside it. Both flip with a
  // class - chess.com on the board, lichess on its wrapper.
  function boardSquareRect(board, square) {
    const wrap = board.closest(".cg-wrap");
    const flipped = wrap
      ? wrap.classList.contains("orientation-black")
      : board.classList.contains("flipped");
    const box = board.getBoundingClientRect();
    const size = Math.min(box.width, box.height) / 8;
    if (!size) return null;

    let file = square.charCodeAt(0) - 97;
    let rank = Number(square[1]);
    if (flipped) {
      file = 7 - file;
      rank = 9 - rank;
    }
    return {
      left: box.left + file * size,
      top: box.top + (8 - rank) * size,
      width: size,
      height: size,
    };
  }

  /* ------------------------------------------------------------ lichess board */

  // lichess draws one <piece> per piece inside <cg-board> and puts the square in
  // its transform: `translate(177px, 0px)` is the d8 square of a 59px board.
  // There is no square attribute and no FEN hook, so the board's own width gives
  // the square size; flipping rewrites the transforms and marks the wrapper.
  const LICHESS_CODE = { pawn: "p", knight: "n", bishop: "b", rook: "r", queen: "q", king: "k" };
  const LICHESS_SHIFT = /translate\(\s*(-?[\d.]+)px[,\s]+(-?[\d.]+)px/;

  function boardFromLichess() {
    const board = document.querySelector("cg-board");
    const wrap = board?.closest(".cg-wrap");
    if (!board || !wrap) return null;

    const pieces = [...board.querySelectorAll("piece")];
    const box = board.getBoundingClientRect();
    const size = box.width / 8;
    if (!pieces.length || !size) return null;

    const flipped = wrap.classList.contains("orientation-black");
    const rows = new Map();
    for (const piece of pieces) {
      // The class list carries extra tokens while a piece is picked up
      // (`dragging`), so colour and kind are looked up one token at a time.
      const tokens = [...piece.classList];
      const colour = tokens.find((token) => token === "white" || token === "black");
      const kind = tokens.find((token) => LICHESS_CODE[token]);
      if (!colour || !kind) continue;

      // The inline transform is the piece's square even while it animates.
      const shift = LICHESS_SHIFT.exec(piece.getAttribute("style") || "");
      const rect = piece.getBoundingClientRect();
      let file = Math.round((shift ? Number(shift[1]) : rect.left - box.left) / size);
      let row = Math.round((shift ? Number(shift[2]) : rect.top - box.top) / size);
      if (file < 0 || file > 7 || row < 0 || row > 7) continue;
      if (flipped) {
        file = 7 - file;
        row = 7 - row;
      }

      const rank = 8 - row;
      if (!rows.has(rank)) rows.set(rank, new Array(8).fill(null));
      const code = LICHESS_CODE[kind];
      rows.get(rank)[file] = colour === "white" ? code.toUpperCase() : code;
    }

    const placement = rows.size ? rowsToPlacement(rows) : null;
    if (!placement) return null;

    // With no clock and no move made yet, the start position is white's.
    const turn = lichessTurn(board) ?? (placement === START_PLACEMENT ? "w" : null);
    return {
      fen: `${placement} ${turn ?? sideHint ?? "w"} ${castlingFromPlacement(placement)} - 0 1`,
      turnKnown: turn !== null,
      board,
    };
  }

  function lichessTurn(board) {
    // A live or reviewed game lights the clock of the side to move.
    const running = document.querySelector(".rclock.running");
    if (running) {
      const names = String(running.className);
      if (names.includes("rclock-white")) return "w";
      if (names.includes("rclock-black")) return "b";
    }

    // Otherwise the last-move squares still hold the piece that just moved.
    const at = new Map();
    for (const piece of board.querySelectorAll("piece")) {
      at.set(String(piece.getAttribute("style") || "").replace(/\s+/g, ""), String(piece.className));
    }
    for (const square of board.querySelectorAll("square.last-move")) {
      const name = at.get(String(square.getAttribute("style") || "").replace(/\s+/g, ""));
      if (name) return name.includes("white") ? "b" : "w";
    }

    return null;
  }

  // Pieces move by having their class (chess.com) or transform (lichess)
  // rewritten, so a board-level watcher on both attributes notices a move.
  function watchBoard(board) {
    if (board === watchedBoard) return;
    boardWatch?.disconnect();
    watchedBoard = board;
    boardWatch = board ? new MutationObserver(schedule) : null;
    boardWatch?.observe(board, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    // The board can change size without the window doing so (a panel opening on
    // chess.com), so the boxes and the arrow follow the board's own box.
    boardResize.disconnect();
    if (board) boardResize.observe(board);
  }

  function detect() {
    return boardFromFen() ?? boardFromSquares() ?? boardFromChessCom() ?? boardFromLichess();
  }

  function pieceFromFen(fen, square) {
    const placement = fen.split(" ")[0];
    const wantedFile = square.charCodeAt(0) - 97;
    const wantedRank = Number(square[1]);
    const rows = placement.split("/");
    if (rows.length !== 8) return null;
    const row = rows[8 - wantedRank];
    if (!row) return null;

    let file = 0;
    for (const char of row) {
      if (/\d/.test(char)) {
        file += Number(char);
        continue;
      }
      if (file === wantedFile) return char;
      file += 1;
    }
    return null;
  }

  /* ----------------------------------------------------------------- engine */

  function post(command) {
    if (!worker || engineStatus === "error") return;
    worker.postMessage(command);
  }

  async function bootEngine() {
    if (worker || engineStatus === "loading" || engineStatus === "error") return;

    engineStatus = "loading";
    engineNote = "";
    render();

    // A page cannot start a worker straight from a chrome-extension:// URL:
    // Chrome refuses to construct it even when the file is web accessible. The
    // engine source is copied into a blob worker instead, and the build learns
    // its WASM location from the hash we append (its loader reads location.hash
    // for exactly that, so the extension folder stays self-contained).
    let source;
    let wasmUrl;
    try {
      wasmUrl = chrome.runtime.getURL(ENGINE_WASM);
      const response = await fetch(chrome.runtime.getURL(ENGINE_SCRIPT));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      source = await response.text();
    } catch (error) {
      fail(`Could not load Stockfish: ${error instanceof Error ? error.message : error}`);
      return;
    }

    // The board may have gone or the engine may have been given up on meanwhile.
    if (engineStatus !== "loading") return;

    try {
      if (engineBlob) URL.revokeObjectURL(engineBlob);
      engineBlob = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      worker = new Worker(`${engineBlob}#${encodeURIComponent(wasmUrl)}`);
    } catch (error) {
      fail(error instanceof Error ? error.message : "The Stockfish worker could not start.");
      return;
    }

    worker.onmessage = (event) => onLine(String(event.data));
    worker.onerror = (event) => fail(event?.message || "The Stockfish worker failed to load.");
    worker.onmessageerror = () => fail("The Stockfish worker sent an unreadable message.");

    let attempts = 0;
    bootPing = window.setInterval(() => {
      if (engineStatus !== "loading" || uciDone) {
        window.clearInterval(bootPing);
        bootPing = 0;
        return;
      }
      if (attempts++ > 180) {
        window.clearInterval(bootPing);
        bootPing = 0;
        fail("Stockfish did not answer in time.");
        return;
      }
      post("uci");
    }, 500);

    post("uci");
  }

  function onLine(raw) {
    for (const part of raw.split(/\r?\n/)) {
      const line = part.trim();
      if (!line) continue;

      if (!uciDone && line.includes("uciok")) {
        uciDone = true;
        if (bootPing) {
          window.clearInterval(bootPing);
          bootPing = 0;
        }
        post("setoption name Threads value 1");
        post("setoption name Hash value 256");
        post(`setoption name MultiPV value ${CANDIDATES}`);
        post("setoption name Skill Level value 20");
        // Build strength instead of engine strength: LimitStrength with an Elo
        // makes Stockfish pick like a player of that rating, so even its top
        // line is only as good as a 2400's.
        post("setoption name UCI_LimitStrength value true");
        post(`setoption name UCI_Elo value ${HUMAN_ELO}`);
        post("setoption name Ponder value false");
        post("ucinewgame");
        post("isready");
        continue;
      }

      if (line.includes("readyok")) {
        if (engineStatus !== "ready") {
          engineStatus = "ready";
          revivals = 0;
          render();
          startSearch();
        }
        continue;
      }

      if (line.startsWith("info ")) {
        onInfo(line);
        continue;
      }

      if (line.startsWith("bestmove")) {
        onBestMove(line);
      }
    }
  }

  function onInfo(line) {
    if (!searching) return;
    if (/\b(lowerbound|upperbound)\b/.test(line)) return;

    const depthMatch = /\bdepth (\d+)/.exec(line);
    const scoreMatch = /\bscore (cp|mate) (-?\d+)/.exec(line);
    if (!depthMatch && !scoreMatch) return;

    const depth = depthMatch ? Number(depthMatch[1]) : liveDepth;
    if (depth > liveDepth) liveDepth = depth;

    if (scoreMatch) {
      const score = { type: scoreMatch[1], value: Number(scoreMatch[2]) };
      const index = Number(/\bmultipv (\d+)/.exec(line)?.[1] ?? 1);
      const pv = /\bpv (\S+)/.exec(line)?.[1];
      // The card follows the top line while it thinks; the others are kept so a
      // move a 2400 might actually play can be suggested instead.
      if (index === 1) liveScore = score;
      if (pv) {
        // Every iteration reports its lines one at a time and the last one is
        // often cut off by the time limit, so hold the newest set aside and only
        // keep it once the next depth proves it was reported whole. Otherwise a
        // single line would stand in for a choice of four.
        if (depth > pendingDepth) {
          if (pending.size >= 2) {
            candidates = pending;
            candidateDepth = pendingDepth;
          }
          pending = new Map();
          pendingDepth = depth;
        }
        if (depth === pendingDepth) pending.set(index, { uci: pv, score, depth });
      }
    }

    const now = performance.now();
    if (now - lastPaint < 140) return;
    lastPaint = now;
    render();
  }

  function onBestMove(line) {
    const match = /^bestmove\s+(\S+)/.exec(line);
    const uci = match && match[1] !== "(none)" ? match[1] : null;
    const fen = activeFen;

    searching = false;
    activeFen = null;

    // A `bestmove` left over from a search we abandoned has no position left to
    // describe; the next board change starts a fresh one.
    if (!fen) return;

    // The board changed while the engine was thinking: analyse the new one.
    if (wantedFen !== fen) {
      startSearch();
      return;
    }

    // A finished search may still have left its last iteration half reported.
    if (pending.size >= 2 && pendingDepth >= candidateDepth) {
      candidates = pending;
      candidateDepth = pendingDepth;
    }

    // Not always the engine's favourite: a 2400 misses the best move sometimes,
    // and advice that comes back identical every time gives the overlay away.
    const picked = uci ? rememberPick(fen) : null;
    if (picked) {
      best = describe(fen, picked.uci, picked.score, picked.depth || liveDepth);
    } else if (uci) {
      best = describe(fen, uci, liveScore, liveDepth);
    } else {
      best = null;
      engineNote = "No legal moves in this position.";
    }

    render();
    paintHighlights();
  }

  function startSearch() {
    if (engineStatus !== "ready" || !wantedFen) return;
    if (searching) {
      // Interrupt: the pending bestmove restarts the search for wantedFen.
      post("stop");
      return;
    }

    activeFen = wantedFen;
    searching = true;
    liveScore = null;
    liveDepth = 0;
    candidates = new Map();
    candidateDepth = 0;
    pending = new Map();
    pendingDepth = 0;
    best = null;
    engineNote = "";
    render();
    paintHighlights();

    post(`position fen ${wantedFen}`);
    post(`go movetime ${thinkTime(wantedFen)}`);
  }

  function fail(message) {
    engineStatus = "error";
    engineNote = message;
    searching = false;
    // Remember the position that threw, and drop it: the revived worker must not
    // be handed the same board again.
    crashFen = activeFen;
    activeFen = null;
    wantedFen = null;
    if (bootPing) {
      window.clearInterval(bootPing);
      bootPing = 0;
    }
    worker?.terminate();
    worker = null;
    if (engineBlob) {
      URL.revokeObjectURL(engineBlob);
      engineBlob = null;
    }
    render();

    // A worker that throws is gone, and until now the overlay stayed dead with
    // it. Give it a fresh worker instead - a few times, not forever.
    if (revivals < 3) {
      revivals += 1;
      window.setTimeout(() => {
        if (engineStatus !== "error") return;
        engineStatus = "idle";
        uciDone = false;
        bootEngine();
      }, 1500);
    }
  }

  /* --------------------------------------------------------------- helpers */

  /* ------------------------------------------------- playing like a 2400 */

  // A cheap stable hash, so one position always gets one treatment: browsing
  // back and forth must not change the suggestion or how long it "takes".
  function fenSeed(fen) {
    let h = 2166136261;
    for (let i = 0; i < fen.length; i += 1) {
      h ^= fen.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function drawn(seed, salt) {
    let x = (seed ^ Math.imul(salt, 0x9e3779b1)) >>> 0;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  }

  function centipawns(score) {
    if (!score) return 0;
    if (score.type === "mate") {
      return score.value >= 0 ? 100000 - score.value * 1000 : -100000 - score.value * 1000;
    }
    return score.value;
  }

  // How far from the best move to look is itself a dice roll: most of the time a
  // 2400 keeps to good moves, now and then it takes a slightly worse one it
  // likes the look of, and occasionally it plays a real slip. The draw comes
  // from the position, so the same board always gets the same answer.
  function humanPick(fen) {
    const unique = new Map();
    for (const line of candidates.values()) {
      if (line.depth >= candidateDepth && !unique.has(line.uci)) unique.set(line.uci, line);
    }
    const lines = [...unique.values()].sort((a, b) => centipawns(b.score) - centipawns(a.score));
    if (!lines.length) return null;

    const seed = fenSeed(fen);
    const roll = drawn(seed, 1);
    const slack = roll < 0.05 ? 150 : roll < 0.18 ? 60 : 25;
    const top = centipawns(lines[0].score);

    // A forced mate is not something a human gives up for a quiet move.
    const mates = lines.filter((line) => line.score.type === "mate" && line.score.value > 0);
    const pool = mates.length
      ? mates
      : lines.filter((line) => top - centipawns(line.score) <= slack);
    if (!pool.length) return lines[0];

    // Now and then the pick is just one of the ideas that looked playable. This
    // is the loose move a 2400 still makes sometimes: weighting alone lands back
    // on the best move far too often to look like a person.
    if (!mates.length && drawn(seed, 4) < 0.04) {
      return pool[Math.floor(drawn(seed, 5) * pool.length)] ?? pool[0];
    }

    // Otherwise near-equal moves share the weight, with the engine's own
    // favourite still leading: that is what a strong human mostly plays anyway.
    const weights = pool.map((line) => Math.exp(-Math.max(0, top - centipawns(line.score)) / 9));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let target = drawn(seed, 2) * total;
    for (let i = 0; i < pool.length; i += 1) {
      target -= weights[i];
      if (target <= 0) return pool[i];
    }
    return pool[0];
  }

  // Advice already given is not taken back a few seconds later: the engine's own
  // randomness can move on between searches, but the same board keeps the same
  // suggestion. Only the newest few hundred positions are kept.
  function rememberPick(fen) {
    const seen = pickCache.get(fen);
    if (seen) {
      const live = [...candidates.values()].find((line) => line.uci === seen.uci);
      return live ?? seen;
    }

    const pick = humanPick(fen);
    if (!pick) return null;
    if (pickCache.size >= 300) pickCache.delete(pickCache.keys().next().value);
    pickCache.set(fen, pick);
    return pick;
  }

  // People do not spend the same time on every move either.
  function thinkTime(fen) {
    const spread = MOVETIME_MS - MOVETIME_JITTER / 2;
    return Math.round(spread + drawn(fenSeed(fen), 3) * MOVETIME_JITTER);
  }

  function formatScore(score) {
    if (!score) return "";
    if (score.type === "mate") return `${score.value >= 0 ? "+" : "−"}M${Math.abs(score.value)}`;
    const pawns = score.value / 100;
    if (Math.abs(pawns) < 0.05) return "0.0";
    return `${pawns > 0 ? "+" : "−"}${Math.abs(pawns).toFixed(1)}`;
  }

  function describe(fen, uci, score, depth) {
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promo = uci[4] ?? "";
    const piece = pieceFromFen(fen, from);
    const type = piece ? piece.toLowerCase() : null;

    let label;
    if (type === "k" && Math.abs(to.charCodeAt(0) - from.charCodeAt(0)) === 2) {
      label = to[0] === "g" ? "O-O" : "O-O-O";
    } else if (type) {
      const letter = type === "p" ? "" : type.toUpperCase();
      label = `${letter}${to}${promo ? `=${promo.toUpperCase()}` : ""}`;
    } else {
      label = uci;
    }

    return {
      label,
      uci,
      from,
      to,
      glyph: type ? GLYPH[type] : "♞",
      name: type ? `${PIECE_NAME[type]} ${from}–${to}${promo ? `=${promo.toUpperCase()}` : ""}` : uci,
      evalText: formatScore(score),
      depth,
      mover: fen.split(" ")[1] === "b" ? "Black" : "White",
    };
  }

  function addHighlight(rect) {
    if (!rect || !rect.width) return;
    const box = document.createElement("div");
    box.style.cssText = [
      "position:fixed",
      `left:${rect.left}px`,
      `top:${rect.top}px`,
      `width:${rect.width}px`,
      `height:${rect.height}px`,
      "border:3px solid rgba(217, 184, 119, 0.9)",
      "border-radius:3px",
      "box-sizing:border-box",
      "background:rgba(217,184,119,0.16)",
    ].join(";");
    highlights.appendChild(box);
  }

  // Where a square is on screen: from the board's own box on sites that draw no
  // element per square, otherwise from the page's own square element.
  function squareRect(square) {
    if (boardEl) return boardSquareRect(boardEl, square);
    const el = document.querySelector(`[data-square="${square}"]`);
    return el ? el.getBoundingClientRect() : null;
  }

  function paintArrow() {
    arrows.style.width = `${window.innerWidth}px`;
    arrows.style.height = `${window.innerHeight}px`;

    const from = enabled && best ? squareRect(best.from) : null;
    const to = enabled && best ? squareRect(best.to) : null;
    if (!from || !to) {
      arrowShaft.setAttribute("visibility", "hidden");
      return;
    }

    // Start clear of the moving piece and stop at the edge of the target square.
    const size = from.width;
    const x1 = from.left + size / 2;
    const y1 = from.top + size / 2;
    const x2 = to.left + size / 2;
    const y2 = to.top + size / 2;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy) || 1;

    arrowShaft.setAttribute("stroke-width", String(Math.max(3, Math.round(size * 0.13))));
    arrowShaft.setAttribute("x1", String(x1 + (dx / length) * size * 0.2));
    arrowShaft.setAttribute("y1", String(y1 + (dy / length) * size * 0.2));
    arrowShaft.setAttribute("x2", String(x2 - (dx / length) * size * 0.34));
    arrowShaft.setAttribute("y2", String(y2 - (dy / length) * size * 0.34));
    arrowShaft.setAttribute("visibility", "visible");
  }

  function paintHighlights() {
    highlights.replaceChildren();
    paintArrow();
    if (!enabled || !best) return;

    for (const square of [best.from, best.to]) {
      addHighlight(squareRect(square));
    }
  }

  function render() {
    card.hidden = !enabled;
    if (!enabled) return;

    const dotState =
      engineStatus === "error"
        ? "bad"
        : engineStatus === "loading" || searching
          ? "busy"
          : engineStatus === "ready"
            ? "live"
            : "";
    dot.className = dotState ? `dot ${dotState}` : "dot";

    statusEl.textContent =
      engineStatus === "loading"
        ? "loading…"
        : engineStatus === "error"
          ? "offline"
          : searching
            ? `d${liveDepth || "–"}`
            : engineStatus === "ready"
              ? "ready"
              : "idle";

    if (best) {
      glyphEl.textContent = best.glyph;
      labelEl.textContent = best.label;
      labelEl.classList.remove("dim");
      labelEl.title = best.name;
      uciEl.textContent = best.uci;
      evalEl.textContent = best.evalText;
      depthEl.textContent = best.depth ? `d${best.depth}` : "";
    } else {
      glyphEl.textContent = "♞";
      labelEl.textContent =
        engineStatus === "error" ? "engine offline" : searching || engineStatus === "loading" ? "thinking…" : "—";
      labelEl.classList.add("dim");
      labelEl.title = "";
      uciEl.textContent = "";
      evalEl.textContent = searching ? formatScore(liveScore) : "";
      depthEl.textContent = searching && liveDepth ? `d${liveDepth}` : "";
    }

    // The turn is only certain when the page told us. Otherwise the picker stays
    // on screen - next to a shown move too, which is then only a guess.
    for (const button of sideEl.querySelectorAll("button")) {
      button.classList.toggle("on", button.dataset.side === (sideHint ?? "w"));
    }
    sideEl.hidden = turnKnown;

    noteEl.hidden = !engineNote;
    noteEl.textContent = engineNote;
  }

  /* --------------------------------------------------------------- plumbing */

  // Stockfish throws on a position that cannot exist, and one throw takes the
  // worker with it. A page can show such a board for a moment - a promotion
  // still to be chosen leaves a pawn on the last rank, and a board that is
  // still drawing can lack a king - so only whole positions get searched.
  function boardBlocker(fen) {
    const ranks = fen.split(" ")[0].split("/");
    if (ranks.length !== 8) return "Waiting for a complete board.";
    if (/[pP]/.test(ranks[0] + ranks[7])) return "Choose a promotion piece.";
    const pieces = ranks.join("/");
    if (!pieces.includes("K") || !pieces.includes("k")) return "Waiting for a complete board.";
    return null;
  }

  function refresh(force = false) {
    if (!enabled) return;

    const found = detect();
    if (!found) {
      // No board on screen: drop the position and stop the engine, so a stale
      // `bestmove` can neither be shown later nor leave the overlay thinking.
      if (searching) post("stop");
      searching = false;
      wantedFen = null;
      activeFen = null;
      card.hidden = true;
      best = null;
      boardEl = null;
      watchBoard(null);
      paintHighlights();
      return;
    }

    card.hidden = false;
    bootEngine();

    boardEl = found.board ?? null;
    watchBoard(boardEl);

    turnKnown = found.turnKnown;
    const fen = found.fen;
    const placement = fen.split(" ")[0];

    // Without a clock or move list the side to move has to be asked for once;
    // after that a *new placement* means a move was played, so it switches. It
    // must key off the pieces alone: the assumed turn is part of the FEN, and
    // flipping on a changed FEN would just flip back and forth forever.
    if (!turnKnown && sideHint && placement !== lastPlacement) {
      sideHint = sideHint === "w" ? "b" : "w";
    }
    lastPlacement = placement;

    // A half-set board is shown as a note and searched the moment it is whole.
    const blocker = fen === crashFen ? "Waiting for the next position." : boardBlocker(fen);
    if (blocker) {
      if (searching) post("stop");
      searching = false;
      activeFen = null;
      wantedFen = null;
      best = null;
      engineNote = blocker;
      render();
      paintHighlights();
      return;
    }

    if (document.querySelector(".main-line-ply")) watchMoveList();

    if (force || fen !== wantedFen) {
      wantedFen = fen;
      startSearch();
    }

    render();
    paintHighlights();
  }

  function schedule() {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => refresh(), DEBOUNCE_MS);
  }

  // Browsing marks the ply you landed on with a class on its span, and the mark
  // moves before the pieces do: reading it at once pairs the new mark with the
  // old board and revokes a right the board still shows. So only note the mark
  // and read after the pieces have had time to follow.
  function watchMoveList() {
    if (moveListWatch) return;
    let marked = null;
    moveListWatch = new MutationObserver(() => {
      const next = document.querySelector(".main-line-ply .selected");
      if (next === marked) return;
      marked = next;
      window.clearTimeout(markTimer);
      markTimer = window.setTimeout(refresh, 200);
    });
    moveListWatch.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  function toggle(next) {
    enabled = next;
    chrome.storage.local.set({ enabled });

    if (!enabled) best = null;
    render();
    // The boxes and the arrow are cleared here, not by hand: clearing the boxes
    // alone used to leave the arrow behind on the board.
    paintHighlights();
    if (enabled) refresh(true);
  }

  function mount() {
    if (!host.isConnected) document.documentElement.appendChild(host);
    if (!highlights.isConnected) document.documentElement.appendChild(highlights);
    if (!arrows.isConnected) document.documentElement.appendChild(arrows);
  }

  mount();

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-chess-fen", "data-fen", "data-square", "data-piece", "data-chess-turn"],
  });

  window.addEventListener("scroll", () => paintHighlights(), { passive: true, capture: true });
  window.addEventListener("resize", () => paintHighlights(), { passive: true });
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.code === "KeyB") {
        event.preventDefault();
        toggle(!enabled);
      }
    },
    true,
  );

  // The toolbar popup asks this page what it is doing, so a page with no answer
  // already means the overlay never started here.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "best-move-status") return;
    sendResponse({
      enabled,
      engineStatus,
      engineNote,
      searching,
      detected: Boolean(wantedFen),
      best: best
        ? { label: best.label, uci: best.uci, evaluation: best.evalText, depth: best.depth }
        : null,
    });
  });

  chrome.storage.local.get({ enabled: true }, (value) => {
    enabled = value.enabled !== false;
    render();
    if (enabled) refresh(true);
  });
})();

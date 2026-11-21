import { type Chess, type Move, type PieceSymbol, type Square } from "chess.js";

export class MoveInputError extends Error {}

const UCI_MOVE = /^([a-h][1-8])[-,x]?([a-h][1-8])([qrbn])?$/;
const CASTLE_ZEROS = /^[0o]-[0o](?:-[0o])?$/i;

/**
 * Plays a move typed by the user, accepting both SAN ("Nf3", "exd5", "O-O",
 * "e8=Q") and UCI coordinate notation ("g1f3", "e2e4", "e7e8q").
 *
 * chess.js validates the move and throws for anything illegal, which we
 * surface as a MoveInputError with a human-readable message.
 */
export function playMoveInput(chess: Chess, raw: string): Move {
  const trimmed = raw.trim();
  if (!trimmed) throw new MoveInputError("Type a move first.");

  const compact = trimmed.replace(/\s+/g, "");
  const uci = UCI_MOVE.exec(compact.toLowerCase());

  if (uci) {
    const from = uci[1] as Square;
    const to = uci[2] as Square;
    const piece = chess.get(from);
    if (!piece) throw new MoveInputError(`There is no piece on ${from}.`);

    const lastRank = piece.color === "w" ? "8" : "1";
    const promotion =
      (uci[3] as PieceSymbol | undefined) ??
      (piece.type === "p" && to[1] === lastRank ? ("q" as PieceSymbol) : undefined);

    try {
      const move = chess.move(promotion ? { from, to, promotion } : { from, to });
      if (!move) throw new Error("rejected");
      return move;
    } catch {
      throw new MoveInputError(`Not a legal move: ${trimmed}`);
    }
  }

  const san = CASTLE_ZEROS.test(compact)
    ? compact.length > 3
      ? "O-O-O"
      : "O-O"
    : compact;

  try {
    const move = chess.move(san);
    if (!move) throw new Error("rejected");
    return move;
  } catch {
    throw new MoveInputError(`Not a legal move: ${trimmed}`);
  }
}

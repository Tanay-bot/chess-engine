/**
 * The overlay's rating, and the one place it is written.
 *
 * It starts where a new account starts and moves with the games it sees, as an
 * Elo step against a fixed club-strength field: the same win is worth a lot while
 * the rating sits far below that field and very little once it has caught up, so
 * it climbs quickly at first and then has to keep winning to keep climbing. A
 * loss costs a little, which is what makes the growth feel earned.
 *
 * Loaded before content.js on the page and next to popup.js in the popup, so the
 * page and the popup always share one number.
 */
(() => {
  "use strict";

  const FLOOR = 800;
  const CEIL = 2800;
  const RUNG = 24; // rating points at stake in one game
  const FIELD = 1200; // the strength of the games it watches

  const count = (raw, fallback) =>
    Number.isFinite(raw) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(raw))) : fallback;

  function clean(value) {
    const state = value && typeof value === "object" ? value : {};
    const elo = Number.isFinite(state.elo) ? Math.round(state.elo) : FLOOR;
    return {
      elo: Math.min(CEIL, Math.max(FLOOR, elo)),
      wins: count(state.wins, 0),
      losses: count(state.losses, 0),
      draws: count(state.draws, 0),
    };
  }

  async function read() {
    const { ladder } = await chrome.storage.local.get({ ladder: null });
    return clean(ladder);
  }

  // One game against the field. A win from far below it is worth most of the
  // rung; the same win once the rating has caught up is worth half of it.
  function after(state, outcome) {
    const current = clean(state);
    const expected = 1 / (1 + 10 ** ((FIELD - current.elo) / 400));
    const step =
      outcome === "win"
        ? RUNG * (1 - expected)
        : outcome === "loss"
          ? -RUNG * expected
          : RUNG * (0.5 - expected);

    return {
      elo: Math.min(CEIL, Math.max(FLOOR, Math.round(current.elo + step))),
      wins: current.wins + (outcome === "win" ? 1 : 0),
      losses: current.losses + (outcome === "loss" ? 1 : 0),
      draws: current.draws + (outcome === "draw" ? 1 : 0),
    };
  }

  async function record(outcome) {
    const current = await read();
    if (outcome !== "win" && outcome !== "loss" && outcome !== "draw") return current;

    const next = after(current, outcome);
    await chrome.storage.local.set({ ladder: next });
    return next;
  }

  async function reset() {
    const fresh = clean(null);
    await chrome.storage.local.set({ ladder: fresh });
    return fresh;
  }

  window.BestMoveLadder = { FLOOR, CEIL, read, record, reset, after };
})();

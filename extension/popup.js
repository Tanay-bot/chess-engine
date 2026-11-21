/**
 * Toolbar popup: what the overlay is doing on the tab you are looking at, and a
 * one-click way to allow the site it does not run on.
 *
 * It asks the content script directly, so "no answer" already means the overlay
 * is not injected on this tab; it then says why (site not allowed, or allowed
 * but not reloaded) and shows the engine error when the search never started.
 * `activeTab` is what lets it name a site the extension has no access to yet.
 */
const dot = document.getElementById("dot");
const stateEl = document.getElementById("state");
const siteEl = document.getElementById("site");
const moveEl = document.getElementById("move");
const noteEl = document.getElementById("note");
const allowRow = document.getElementById("allow-row");
const allowButton = document.getElementById("allow");

let pendingAllow = null;

function render({ tone = "", state, site = "", move = "", note = "", noteIsError = false, allow = null }) {
  dot.className = `dot ${tone}`.trim();
  stateEl.textContent = state;

  siteEl.textContent = site;
  siteEl.hidden = !site;
  siteEl.title = site;

  moveEl.textContent = move;
  moveEl.hidden = !move;

  noteEl.textContent = note;
  noteEl.hidden = !note;
  noteEl.classList.toggle("bad", noteIsError);

  pendingAllow = allow;
  allowRow.hidden = !allow;
  allowButton.disabled = false;
}

function moveLine(best) {
  const parts = [best.label, best.uci];
  if (best.evaluation) parts.push(best.evaluation);
  if (best.depth) parts.push(`d${best.depth}`);
  return parts.join(" · ");
}

async function statusOf(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "best-move-status" });
  } catch {
    // No receiver means the content script is not running on this tab.
    return null;
  }
}

async function allowedSites() {
  const { allowedSites: list = [] } = await chrome.storage.local.get({ allowedSites: [] });
  return Array.isArray(list) ? list : [];
}

async function inspect() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    render({ tone: "muted", state: "No active tab" });
    return;
  }

  const url = tab.url ?? "";
  if (!url) {
    // Chrome hides the address on pages the extension has no access to until the
    // user invokes the extension (toolbar icon, shortcut, the Extensions menu).
    // Without it there is no host to name or ask about, so point at both fixes.
    render({
      tone: "warn",
      state: "Chrome did not share this tab's address",
      note: "Click the Best Move toolbar icon on the page you want (that hands over the address), or add the site in Allowed sites.",
    });
    return;
  }

  if (!/^https?:/i.test(url)) {
    render({ tone: "muted", state: "Not a web page", site: url });
    return;
  }

  const parsed = new URL(url);
  const origin = parsed.origin;
  // Chrome match patterns carry no port, so `http://host:5173/*` is not a valid
  // pattern and asking about it would throw (and look like "not allowed").
  const pattern = `${parsed.protocol}//${parsed.hostname}/*`;
  const alwaysOn = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  const status = await statusOf(tab.id);

  if (!status) {
    if (alwaysOn || (await allowedSites()).includes(pattern)) {
      render({
        tone: "warn",
        state: "Overlay is not running",
        site: origin,
        note: "This site is allowed. Reload the tab so the overlay can start.",
      });
    } else {
      render({
        tone: "muted",
        state: "Not allowed here",
        site: origin,
        note: "Allow this site to run Stockfish on it.",
        allow: { tabId: tab.id, pattern, origin },
      });
    }
    return;
  }

  if (status.engineStatus === "error") {
    render({
      tone: "bad",
      state: "Engine failed",
      site: origin,
      note: status.engineNote || "Stockfish could not start.",
      noteIsError: true,
    });
    return;
  }

  if (!status.enabled) {
    render({
      tone: "muted",
      state: "Overlay hidden",
      site: origin,
      note: "Press Alt+B on the page to show it again.",
    });
    return;
  }

  if (status.best) {
    render({ tone: "live", state: "Running", site: origin, move: moveLine(status.best) });
    return;
  }

  let note = "No chess board found on this page.";
  if (status.detected) note = status.searching ? "Thinking…" : "Waiting for a position.";
  render({ tone: "live", state: "Running", site: origin, note });
}

async function allow(event) {
  event.preventDefault();
  const target = pendingAllow;
  if (!target) return;

  allowButton.disabled = true;

  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [target.pattern] });
  } catch {
    granted = false;
  }

  if (!granted) {
    render({
      tone: "warn",
      state: "Not allowed here",
      site: target.origin,
      note: "Chrome did not grant access to this site.",
      allow: target,
    });
    return;
  }

  // background.js records newly granted origins too, so this list is written even
  // if Chrome closes the popup while its permission prompt is open.
  const sites = await allowedSites();
  if (!sites.includes(target.pattern)) {
    await chrome.storage.local.set({ allowedSites: [...sites, target.pattern] });
  }

  render({ tone: "live", state: "Allowed", site: target.origin, note: "Reloading the tab so the overlay can start." });

  try {
    await chrome.tabs.reload(target.tabId);
  } catch {
    // The tab may have gone away; the site stays allowed either way.
  }
}

async function main() {
  // The popup is only useful if it always says something: never leave it on
  // "Checking…" because a browser call did not come back.
  const watchdog = setTimeout(() => {
    render({
      tone: "warn",
      state: "No answer from this tab",
      note: "Reload the tab, then open this popup again.",
    });
  }, 4000);

  try {
    await inspect();
  } finally {
    clearTimeout(watchdog);
  }
}

allowButton.addEventListener("click", allow);

document.getElementById("options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

main().catch((error) => {
  render({
    tone: "bad",
    state: "Popup failed",
    note: String(error && error.message ? error.message : error),
    noteIsError: true,
  });
});

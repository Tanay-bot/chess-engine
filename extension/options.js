/**
 * The one place to allow the overlay on a chess site.
 *
 * Every entry is stored as a match pattern ("https://site.example/*") and only
 * kept while the browser still grants access to it. background.js turns that
 * list into the content script registration.
 */
const form = document.getElementById("add-form");
const input = document.getElementById("site");
const listEl = document.getElementById("list");
const statusEl = document.getElementById("status");

let statusTimer = 0;

function say(message, bad = false) {
  window.clearTimeout(statusTimer);
  statusEl.textContent = message;
  statusEl.classList.toggle("bad", bad);
  statusEl.hidden = !message;
  statusTimer = window.setTimeout(() => {
    statusEl.hidden = true;
  }, 7000);
}

/** "chess.example.com/analysis" -> "https://chess.example.com/*" */
function patternFrom(value) {
  const raw = value.trim();
  if (!raw) return null;

  const text = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  // Match patterns have no port, so http://site:8080 is stored as http://site/*
  // (which is what the browser grants anyway). IPv6 literals are not patterns.
  if (url.hostname.startsWith("[")) return null;
  return `${url.protocol}//${url.hostname}/*`;
}

function label(pattern) {
  return pattern.replace(/\/\*$/, "");
}

async function readSites() {
  const { allowedSites = [] } = await chrome.storage.local.get({ allowedSites: [] });
  return Array.isArray(allowedSites) ? allowedSites.filter((site) => typeof site === "string") : [];
}

async function writeSites(sites) {
  await chrome.storage.local.set({ allowedSites: sites });
}

function addRow(pattern, { removable }) {
  const item = document.createElement("li");

  const site = document.createElement("span");
  site.className = "site";
  site.textContent = label(pattern);
  site.title = pattern;
  item.appendChild(site);

  if (removable) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => forget(pattern));
    item.appendChild(remove);
  } else {
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = "always on";
    item.appendChild(tag);
  }

  listEl.appendChild(item);
}

async function render() {
  const sites = await readSites();
  listEl.replaceChildren();

  // localhost comes from the static content script and cannot be removed.
  addRow("http://localhost/*", { removable: false });
  for (const pattern of sites) {
    if (pattern.startsWith("http://localhost/") || pattern.startsWith("http://127.0.0.1/")) continue;
    addRow(pattern, { removable: true });
  }

  if (!sites.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No site yet — add the address of your own chess board above.";
    listEl.appendChild(empty);
  }
}

async function allow(event) {
  event.preventDefault();

  const pattern = patternFrom(input.value);
  if (!pattern) {
    say("Enter a site such as chess.example.com.", true);
    return;
  }
  if (pattern.startsWith("http://localhost/") || pattern.startsWith("http://127.0.0.1/")) {
    say("localhost is always allowed.");
    return;
  }

  // The permission prompt has to be requested straight from this click, before
  // any other asynchronous work.
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [pattern] });
  } catch {
    granted = false;
  }
  if (!granted) {
    say("Access to that site was not granted.", true);
    return;
  }

  const sites = await readSites();
  if (!sites.includes(pattern)) await writeSites([...sites, pattern]);

  input.value = "";
  say(`Allowed on ${label(pattern)}. Reload that tab.`);
  await render();
}

async function forget(pattern) {
  try {
    await chrome.permissions.remove({ origins: [pattern] });
  } catch {
    // Access may already be gone; the list entry still has to go.
  }

  const sites = await readSites();
  await writeSites(sites.filter((site) => site !== pattern));
  say(`Removed ${label(pattern)}.`);
  await render();
}

form.addEventListener("submit", allow);
render();

/**
 * Runs the overlay on the sites the user allowed in the options page.
 *
 * localhost is covered by the static content script in manifest.json; everything
 * else lives in the `allowedSites` storage list and is registered here as a
 * dynamic content script. A site is only registered while the browser still
 * grants the extension access to it, so removing access also removes the script.
 */
const SCRIPT_ID = "best-move-site";

async function grantedPatterns() {
  const { allowedSites = [] } = await chrome.storage.local.get({ allowedSites: [] });
  if (!Array.isArray(allowedSites)) return [];

  const granted = [];
  for (const pattern of allowedSites) {
    if (typeof pattern !== "string" || !pattern) continue;
    try {
      if (await chrome.permissions.contains({ origins: [pattern] })) granted.push(pattern);
    } catch {
      // A malformed pattern from an older version is simply skipped.
    }
  }
  return granted;
}

let syncChain = Promise.resolve();

/**
 * Registrations can arrive together (a grant writes the allowlist, which fires
 * storage.onChanged, and the grant handler syncs too), so run them one at a time
 * instead of racing unregister/register against each other.
 */
function syncContentScript() {
  const next = syncChain.then(applyContentScript, applyContentScript);
  syncChain = next.catch(() => {});
  return next;
}

async function applyContentScript() {
  const patterns = await grantedPatterns();

  // unregister throws when the id was never registered, which is the normal
  // case on a fresh profile.
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  } catch {
    // nothing registered yet
  }

  if (!patterns.length) return;

  await chrome.scripting.registerContentScripts([
    {
      id: SCRIPT_ID,
      matches: patterns,
      js: ["content.js"],
      runAt: "document_idle",
    },
  ]);
}

function syncQuietly() {
  syncContentScript().catch((error) => {
    console.warn("[best-move] could not update the allowed sites:", error);
  });
}

chrome.runtime.onInstalled.addListener(syncQuietly);
chrome.runtime.onStartup.addListener(syncQuietly);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.allowedSites) syncQuietly();
});

async function readSites() {
  const { allowedSites = [] } = await chrome.storage.local.get({ allowedSites: [] });
  return Array.isArray(allowedSites) ? allowedSites : [];
}

/**
 * Keeps the stored allowlist in step with what the browser actually granted.
 *
 * The popup asks for the permission and then stores the site, but Chrome takes
 * over with its own prompt and may close the popup while it is open, so the
 * grant is also recorded here - that is what makes the popup's Allow button
 * complete even when its page no longer exists.
 */
async function reconcile(added, removed) {
  const sites = await readSites();
  const next = sites.filter((site) => !removed.includes(site));
  for (const origin of added) {
    if (!next.includes(origin)) next.push(origin);
  }

  if (next.length !== sites.length || next.some((site, index) => site !== sites[index])) {
    await chrome.storage.local.set({ allowedSites: next });
  }
}

// The stored patterns look like "http://host/*": the popup builds them from the
// scheme and hostname only.
function matchesPattern(pattern, url) {
  try {
    const target = new URL(url);
    const [scheme, rest = ""] = pattern.split("://");
    const host = rest.replace(/\/\*$/, "");
    return target.protocol === `${scheme}:` && target.hostname === host;
  } catch {
    return false;
  }
}

async function reloadMatchingTabs(patterns) {
  if (!patterns.length) return;
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    if (!patterns.some((pattern) => matchesPattern(pattern, tab.url))) continue;
    try {
      await chrome.tabs.reload(tab.id);
    } catch {
      // The tab may have closed in the meantime.
    }
  }
}

chrome.permissions.onAdded.addListener((permissions) => {
  const origins = permissions.origins ?? [];
  (async () => {
    await reconcile(origins, []);
    // Register first, then reload: a reloaded page only gets the overlay if the
    // dynamic content script exists by the time it loads. Chrome's permission
    // prompt usually closes the popup, so its own reload never happens.
    await syncContentScript();
    await reloadMatchingTabs(origins);
  })().catch((error) => {
    console.warn("[best-move] could not finish allowing a site:", error);
  });
});

chrome.permissions.onRemoved.addListener((permissions) => {
  reconcile([], permissions.origins ?? [])
    .catch(() => {})
    .finally(syncQuietly);
});

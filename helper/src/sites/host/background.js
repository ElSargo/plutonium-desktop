// The sites host (SITE_EXTENSIONS.md, "The sites host"): keeps the browser's
// declarativeNetRequest rules equal to the helper's, made from each site's
// "block" list. The helper writes this folder with config.json (its address
// and a token only this extension can read). A long poll keeps it in step;
// an alarm brings it back if the browser stopped the service worker.
let running = false;

async function config() {
  const response = await fetch(chrome.runtime.getURL("config.json"));
  return response.json();
}

async function apply(rules) {
  const old = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: old.map((rule) => rule.id),
    addRules: rules,
  });
}

async function poll() {
  if (running) return;
  running = true;
  try {
    const { helper, token } = await config();
    // A fresh service worker applies the rules once, whatever they were.
    let version = "";
    for (;;) {
      const response = await fetch(`${helper}/v1/sites/host/rules?since=${encodeURIComponent(version)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error(`helper said ${response.status}`);
      const state = await response.json();
      if (state.version !== version) {
        await apply(state.rules);
        version = state.version;
      }
    }
  } catch (error) {
    console.warn("sites host:", error.message);
  } finally {
    running = false;
  }
}

chrome.runtime.onStartup.addListener(poll);
chrome.runtime.onInstalled.addListener(poll);
chrome.alarms.create("poll", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(poll);
poll();

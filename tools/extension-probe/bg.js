const events = [];
const log = (e) => { events.push({ t: Date.now(), ...e }); chrome.storage.local.set({ events: events.slice(-200) }); };
chrome.runtime.onMessage.addListener((m, sender) => {
  log({ ev: "message", m, tabId: sender.tab?.id ?? null, frameId: sender.frameId, windowId: sender.tab?.windowId ?? null });
});
chrome.tabs.onCreated.addListener((t) => log({ ev: "tabs.onCreated", id: t.id, url: t.pendingUrl || t.url }));
chrome.tabs.onUpdated.addListener((id, info) => log({ ev: "tabs.onUpdated", id, info }));
chrome.tabs.onActivated.addListener((info) => log({ ev: "tabs.onActivated", info }));
chrome.tabs.onRemoved.addListener((id) => log({ ev: "tabs.onRemoved", id }));
chrome.webNavigation.onCommitted.addListener((d) => log({ ev: "webNavigation.onCommitted", tabId: d.tabId, url: d.url, frameId: d.frameId }));
chrome.commands.onCommand.addListener((c) => log({ ev: "command", c }));
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: "probe", title: "Probe item", contexts: ["all"] });
});
chrome.contextMenus.onClicked.addListener((info, tab) => log({ ev: "contextMenus.onClicked", tabId: tab?.id }));

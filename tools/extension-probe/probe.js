// Runs each check in turn; the result is in window.probeResult and the page.
async function step(name, fn) {
  try { return { name, ok: true, value: await fn() }; }
  catch (e) { return { name, ok: false, error: String(e && e.message || e) }; }
}
async function run(targetUrl) {
  const r = [];
  const tabs = await chrome.tabs.query({});
  r.push({ name: "tabs.query({})", ok: true, value: tabs.map((t) => ({ id: t.id, windowId: t.windowId, url: t.url, active: t.active })) });
  r.push(await step("windows.getAll", async () => (await chrome.windows.getAll({ populate: false })).map((w) => ({ id: w.id, type: w.type, focused: w.focused }))));
  r.push(await step("tabs.query active/currentWindow", async () => (await chrome.tabs.query({ active: true, currentWindow: true })).map((t) => t.id)));
  r.push(await step("tabs.getCurrent", async () => (await chrome.tabs.getCurrent())?.id ?? null));
  const stored = (await chrome.storage.local.get("events")).events || [];
  const fromCs = stored.filter((e) => e.ev === "message" && e.m.kind === "cs");
  r.push({ name: "content script messages (tabId seen)", ok: true, value: fromCs.slice(-6).map((e) => ({ url: e.m.url, tabId: e.tabId, frameId: e.frameId })) });
  const target = tabs.find((t) => targetUrl && t.url && t.url.startsWith(targetUrl));
  const csTabId = fromCs.map((e) => e.tabId).filter((x) => x != null && x >= 0).pop();
  const tabId = target?.id ?? csTabId;
  r.push({ name: "target tab id", ok: tabId != null, value: tabId ?? null });
  if (tabId != null) {
    r.push(await step("tabs.get", async () => { const t = await chrome.tabs.get(tabId); return { id: t.id, url: t.url, windowId: t.windowId }; }));
    r.push(await step("scripting.executeScript", async () => (await chrome.scripting.executeScript({ target: { tabId }, func: () => (document.documentElement.dataset.probeExec = "1", location.href) }))[0]?.result));
    r.push(await step("scripting.insertCSS user", () => chrome.scripting.insertCSS({ target: { tabId }, css: "html { outline: 6px solid magenta !important }", origin: "USER" })));
    r.push(await step("userScripts.execute", async () => (await chrome.userScripts.execute({ target: { tabId }, js: [{ code: "document.documentElement.dataset.probeUs='1'; location.href" }] }))[0]?.result));
    r.push(await step("tabs.sendMessage", () => chrome.tabs.sendMessage(tabId, { ping: 1 }).then(() => "sent", (e) => { throw e; })));
  }
  r.push(await step("userScripts.register", async () => {
    await chrome.userScripts.unregister().catch(() => {});
    await chrome.userScripts.register([{ id: "us", matches: ["<all_urls>"], js: [{ code: "document.documentElement.setAttribute('data-probe-us-reg','1')" }], runAt: "document_start" }]);
    return (await chrome.userScripts.getScripts()).length;
  }));
  r.push(await step("dnr.updateDynamicRules (block example.org)", async () => {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1], addRules: [{ id: 1, priority: 1, action: { type: "block" }, condition: { urlFilter: "||example.org", resourceTypes: ["main_frame", "sub_frame", "script", "image", "xmlhttprequest"] } }] });
    return (await chrome.declarativeNetRequest.getDynamicRules()).length;
  }));
  r.push(await step("tabs.create", async () => { const t = await chrome.tabs.create({ url: "https://example.com/?from=tabs.create", active: false }); return { id: t.id, windowId: t.windowId }; }));
  r.push(await step("windows.create", async () => { const w = await chrome.windows.create({ url: "https://example.com/?from=windows.create" }); return { id: w.id, type: w.type }; }));
  r.push({ name: "events so far", ok: true, value: ((await chrome.storage.local.get("events")).events || []).filter((e) => e.ev !== "message").slice(-15) });
  return r;
}
window.probe = async (targetUrl) => { const r = await run(targetUrl); window.probeResult = r; document.getElementById("out").textContent = JSON.stringify(r, null, 1); return r; };
if (!location.search.includes("manual")) window.probe(new URLSearchParams(location.search).get("target"));

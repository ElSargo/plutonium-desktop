// Live checks of the shell's window broker (EXO-BROKER): which documents get
// navigator.windowBroker and grants, and the events it sends. run.sh serves
// this directory, makes index.html a shell (on 127.0.0.1) and runs run() in
// it over DevTools. The same files on localhost are another site.
//
// With --enable-blink-features=PlutoniumShell (run.sh --forced) every page
// sees the API, and only the browser's checks keep the others out.

const OTHER_SITE = `http://localhost:${location.port}`;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const within = (ms, promise, otherwise) => Promise.race([promise, wait(ms).then(() => otherwise)]);

export function exposure(win) {
  try {
    return "windowBroker" in win.navigator ? "api" : "no api";
  } catch (error) {
    return `error ${error.name}`;
  }
}

export async function call(win) {
  const broker = win.navigator.windowBroker;
  if (!broker) return "no api";
  try {
    const windows = await within(3000, broker.getWindows(), null);
    return windows ? `ok ${windows.length}` : "no answer";
  } catch (error) {
    return `rejected ${error.name}`;
  }
}

// A <native-window> in |doc| with |grant| (none if undefined): its state once
// the browser answered, or after 3 s.
export function attach(doc, grant, windowId) {
  return new Promise((resolve) => {
    const element = doc.createElement("native-window");
    let errored = false;
    const done = () => resolve({ element, state: element.windowState + (errored ? " +windowerror" : "") });
    element.addEventListener("windowerror", () => {
      errored = true;
      done();
    });
    // "windowerror" follows a failure's "windowchange".
    element.addEventListener("windowchange", () => {
      if (element.windowState === "attached") done();
      else if (element.windowState !== "attaching") setTimeout(done, 100);
    });
    if (grant !== undefined) element.setAttribute("grant", grant);
    if (windowId) element.setAttribute("window", String(windowId));
    doc.body.append(element);
    setTimeout(done, 3000);
  });
}

// In frame.html: answers checks.js's questions about this frame.
export function answer() {
  addEventListener("message", async (event) => {
    const { id, cmd, grant, windowId } = event.data;
    let result;
    if (cmd === "exposure") result = exposure(window);
    else if (cmd === "call") result = await call(window);
    else if (cmd === "attach") result = (await attach(document, grant, windowId)).state;
    event.source.postMessage({ id, result }, "*");
  });
  parent.postMessage({ ready: true }, "*");
}

// In popup.html and prerender.html: what this page got, in localStorage
// (under ?key= if given).
export async function report(key) {
  key = new URLSearchParams(location.search).get("key") ?? key;
  const result = { prerendering: !!document.prerendering, exposure: exposure(window) };
  localStorage.setItem(key, JSON.stringify(result));
  // A binding the browser refuses may cancel a prerender before this returns.
  result.call = await call(window);
  localStorage.setItem(key, JSON.stringify(result));
}

// An iframe at |url|, and a way to ask it questions.
async function frame(url) {
  const iframe = document.createElement("iframe");
  iframe.src = url;
  const ready = new Promise((resolve) => {
    addEventListener("message", function onReady(event) {
      if (event.source === iframe.contentWindow && event.data?.ready) {
        removeEventListener("message", onReady);
        resolve();
      }
    });
  });
  document.body.append(iframe);
  await within(5000, ready);
  let next = 0;
  const ask = (cmd, args = {}) =>
    within(
      5000,
      new Promise((resolve) => {
        const id = ++next;
        addEventListener("message", function onAnswer(event) {
          if (event.source === iframe.contentWindow && event.data?.id === id) {
            removeEventListener("message", onAnswer);
            resolve(event.data.result);
          }
        });
        iframe.contentWindow.postMessage({ id, cmd, ...args }, "*");
      }),
      "(no answer)",
    );
  return { iframe, ask };
}

// A same-origin iframe made by script (|srcdoc|, about:blank, or a URL).
async function sameOriginFrame(setup) {
  const iframe = document.createElement("iframe");
  setup(iframe);
  const loaded = new Promise((resolve) => iframe.addEventListener("load", resolve, { once: true }));
  document.body.append(iframe);
  await within(5000, loaded);
  return iframe;
}

async function waitForStorage(key, ms) {
  for (let waited = 0; waited < ms; waited += 100) {
    const value = localStorage.getItem(key);
    if (value) return JSON.parse(value);
    await wait(100);
  }
  return null;
}

// Every check: { name, got, want, ok }. |want| is a string, or a RegExp.
export async function run({ forced = false } = {}) {
  const results = [];
  const check = checker(results);
  const otherApi = forced ? "api" : "no api";
  const otherCall = forced ? "rejected NotAllowedError" : "no api";
  const broker = navigator.windowBroker;
  localStorage.clear();

  check("shell: exposure", exposure(window), "api");
  const windows = await broker.getWindows();
  check("shell: windows (run.sh starts two)", String(windows.length), /^[2-9]$/);
  const [first, second] = windows;
  if (!second) return results;
  const grant = await broker.requestGrant(first.id);

  // A valid grant, then revoking it.
  const valid = await attach(document, grant, first.id);
  check("shell: valid grant", valid.state, "attached");
  const revoked = new Promise((resolve) => broker.addEventListener("grantrevoked", resolve, { once: true }));
  const closed = new Promise((resolve) => valid.element.addEventListener("windowclose", () => resolve("windowclose")));
  broker.revokeGrant(grant);
  const event = await within(3000, revoked, null);
  check(
    "grantrevoked after revokeGrant()",
    event ? `${event.constructor.name} ${event.windowId} ${event.grant === grant ? "same grant" : event.grant} entry=${event.entry}` : "none",
    `NativeWindowEvent ${first.id} same grant entry=null`,
  );
  check("element after revokeGrant()", await within(3000, closed, "nothing"), "windowclose");
  valid.element.remove();
  check("revoked grant attaches", (await attach(document, grant, first.id)).state, "failed +windowerror");

  // Grants of a window that closes: revoked, then the window goes.
  const order = [];
  const onRevoked = (e) => e.windowId === second.id && order.push("grantrevoked");
  const onRemoved = (e) => e.windowId === second.id && order.push("windowremoved");
  broker.addEventListener("grantrevoked", onRevoked);
  broker.addEventListener("windowremoved", onRemoved);
  const secondGrant = await broker.requestGrant(second.id);
  const shown = await attach(document, secondGrant, second.id);
  check("shell: second window", shown.state, "attached");
  broker.close(second.id);
  for (let waited = 0; waited < 5000 && order.length < 2; waited += 100) await wait(100);
  check("window closed: events", order.join(", "), "grantrevoked, windowremoved");
  broker.removeEventListener("grantrevoked", onRevoked);
  broker.removeEventListener("windowremoved", onRemoved);
  shown.element.remove();

  // Unsubscribing: with no listeners left, listening again subscribes again
  // and replays the current windows. (Before, the first subscription stayed,
  // and a second listener got no replay.)
  const count = async (add) => {
    let added = 0;
    const listener = () => added++;
    add(listener);
    await wait(500);
    return { added, listener };
  };
  const current = (await broker.getWindows()).length;
  const a = await count((l) => broker.addEventListener("windowadded", l));
  check("subscribe: replay", String(a.added), String(current));
  broker.removeEventListener("windowadded", a.listener);
  const b = await count((l) => broker.addEventListener("windowadded", l));
  check("subscribe again after the last listener went: replay", String(b.added), String(current));
  broker.removeEventListener("windowadded", b.listener);
  const c = await count((l) => (broker.onwindowadded = l));
  broker.onwindowadded = null;
  const d = await count((l) => (broker.onwindowadded = l));
  broker.onwindowadded = null;
  check("onwindowadded = null unsubscribes", `${c.added} ${d.added}`, `${current} ${current}`);

  // NativeWindowEvent's constructor.
  const made = new NativeWindowEvent("windowadded", { windowId: 5, entry: first, grant: "g" });
  check(
    "new NativeWindowEvent(type, init)",
    `${made.type} ${made.windowId} ${made.entry?.appId} ${made.grant} ${made.bubbles} ${made.isTrusted}`,
    `windowadded 5 ${first.appId} g false false`,
  );
  const bare = new NativeWindowEvent("windowremoved");
  check("new NativeWindowEvent(type)", `${bare.windowId} ${bare.entry} '${bare.grant}'`, "0 null ''");
  let badEntry = "no error";
  try {
    new NativeWindowEvent("windowadded", { entry: { id: 1 } });
  } catch (error) {
    badEntry = error.name;
  }
  check("new NativeWindowEvent: incomplete entry", badEntry, "TypeError");
  const target = new EventTarget();
  let dispatched = null;
  target.addEventListener("windowadded", (e) => (dispatched = e.entry?.id));
  target.dispatchEvent(made);
  check("dispatching a made NativeWindowEvent", String(dispatched), String(first.id));

  // Frames inside the shell. A new grant: the one above is revoked.
  const shellGrant = await broker.requestGrant(first.id);
  for (const [name, setup] of [
    ["srcdoc iframe", (f) => (f.srcdoc = "<body></body>")],
    ["about:blank iframe", () => {}],
    ["same-origin iframe", (f) => (f.src = "/frame.html?same-origin")],
  ]) {
    const iframe = await sameOriginFrame(setup);
    const win = iframe.contentWindow;
    check(`${name}: exposure`, exposure(win), otherApi);
    check(`${name}: call`, await call(win), otherCall);
    check(`${name}: shell grant`, (await attach(iframe.contentDocument, shellGrant, first.id)).state, "failed +windowerror");
    iframe.remove();
  }
  const crossSite = await frame(`${OTHER_SITE}/frame.html?cross-site`);
  check("cross-site iframe: exposure", await crossSite.ask("exposure"), otherApi);
  check("cross-site iframe: call", await crossSite.ask("call"), otherCall);
  check("cross-site iframe: shell grant", await crossSite.ask("attach", { grant: shellGrant, windowId: first.id }), "failed +windowerror");
  crossSite.iframe.remove();
  // The shell still has its grant.
  const after = await attach(document, shellGrant, first.id);
  check("shell: grant after the frames", after.state, "attached");
  after.element.remove();

  // <webview> is an extension/app feature: a page gets no guest, so nothing
  // loads.
  const webview = document.createElement("webview");
  webview.setAttribute("src", "/popup.html?key=webview");
  document.body.append(webview);
  check("<webview src>: loads", (await waitForStorage("webview", 3000)) ? "loaded" : "nothing", "nothing");
  webview.remove();

  return results;
}

function checker(results) {
  return (name, got, want) =>
    results.push({ name, got, want: String(want), ok: want instanceof RegExp ? want.test(got) : got === want });
}

// Popups, each run on its own with a user gesture (run.sh evaluates them with
// one: a page's popups need it). In shell mode a page's new windows become
// browser tabs, which are never the shell.
export async function openPopup({ forced = false } = {}) {
  const results = [];
  const check = checker(results);
  localStorage.removeItem("popup");
  const popup = window.open("/popup.html", "_blank");
  check("window.open(url): handle", popup ? "window" : "null", "window");
  const got = await waitForStorage("popup", 5000);
  check(
    "window.open(url): page",
    JSON.stringify(got),
    JSON.stringify({ prerendering: false, exposure: forced ? "api" : "no api", call: forced ? "rejected NotAllowedError" : "no api" }),
  );
  popup?.close();
  return results;
}

// window.open(""): an about:blank window that the shell can script, on its
// origin.
export async function openBlank({ forced = false } = {}) {
  const results = [];
  const check = checker(results);
  const blank = window.open("", "_blank");
  check("window.open(''): handle", blank ? `window ${blank.origin === location.origin ? "same origin" : blank.origin}` : "null", "window same origin");
  if (blank) {
    check("window.open(''): exposure", exposure(blank), forced ? "api" : "no api");
    check("window.open(''): call", await call(blank), forced ? "rejected NotAllowedError" : "no api");
    const [first] = await navigator.windowBroker.getWindows();
    const grant = await navigator.windowBroker.requestGrant(first.id);
    check("window.open(''): shell grant", (await attach(blank.document, grant, first.id)).state, "failed +windowerror");
    blank.close();
  }
  return results;
}

// A prerendered page on the shell origin. DevTools sessions attached to the
// page turn prerendering off, so this only schedules it: run.sh detaches,
// waits, then calls prerenderResults().
export function startPrerender() {
  localStorage.removeItem("prerender");
  setTimeout(() => {
    const rules = document.createElement("script");
    rules.type = "speculationrules";
    rules.textContent = JSON.stringify({ prerender: [{ source: "list", urls: ["/prerender.html"] }] });
    document.head.append(rules);
  }, 1500);
}

export function prerenderResults({ forced = false } = {}) {
  const results = [];
  const check = checker(results);
  const got = JSON.parse(localStorage.getItem("prerender"));
  check("prerender: ran", got ? `prerendering=${got.prerendering}` : "no", "prerendering=true");
  if (got) {
    check("prerender: exposure", got.exposure, forced ? "api" : "no api");
    // Forced: a prerendering page's interface requests wait for activation
    // (Mojo binder policy kDefer), so the call is never answered. Activated,
    // in the shell's window on the shell's origin, it would be the shell.
    check("prerender: call", String(got.call), forced ? "no answer" : "no api");
  }
  return results;
}

// A new document in the same frame (a javascript: URL's result keeps the
// RenderFrameHost): it must not attach with the old document's grant. The
// result goes to sessionStorage "javascript-url"; read it with readJavascriptUrl().
export async function navigateToJavascriptUrl() {
  const [first] = await navigator.windowBroker.getWindows();
  const grant = await navigator.windowBroker.requestGrant(first.id);
  sessionStorage.removeItem("javascript-url");
  const html =
    "<!doctype html><body><script type=module>" +
    `import { afterJavascriptUrl } from "${location.origin}/checks.js";` +
    `afterJavascriptUrl(${JSON.stringify(grant)}, ${first.id});` +
    "</" + "script>";
  location.href = "javascript:" + encodeURIComponent(JSON.stringify(html));
}

export async function afterJavascriptUrl(grant, windowId) {
  const result = { exposure: exposure(window) };
  result.oldGrant = (await attach(document, grant, windowId)).state;
  if (navigator.windowBroker) {
    try {
      const fresh = await navigator.windowBroker.requestGrant(windowId);
      result.newGrant = (await attach(document, fresh, windowId)).state;
    } catch (error) {
      result.newGrant = `rejected ${error.name}`;
    }
  }
  sessionStorage.setItem("javascript-url", JSON.stringify(result));
}

// Pluto Vim's bundle (vimBundle.ts) and its injection into pages (vimInject.ts).
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import type { BrowserCdp, CdpEvent } from "../src/cdp.ts";
import { vimBundle } from "../src/vimBundle.ts";
import { VimInjector, wantsVim } from "../src/vimInject.ts";

const VIM = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "vim");

test("the bundle is one classic script that sets plutoVim, and the engine works from it", async () => {
  const source = vimBundle(VIM);
  assert.doesNotMatch(source, /^\s*(import|export) /m);
  const context = vm.createContext({ setTimeout, clearTimeout });
  vm.runInContext(source, context);
  const v = (context as any).plutoVim;
  for (const name of ["attach", "Vim", "StringBuffer", "bufferFor", "keyFromEvent", "Registers"]) assert.equal(typeof v[name], "function", name);
  assert.equal(typeof v.text.next, "function", "text.js keeps its own namespace");
  const buffer = new v.StringBuffer("foo bar", { cursor: 0 });
  const session = new v.Vim({ opt: { startInInsert: false } }).attach(buffer);
  await session.idle();
  session.feedKeys("dw");
  await session.idle();
  assert.equal(buffer.value, "bar");
});

test("the engine goes on in http(s) documents only", () => {
  assert.equal(wantsVim("http://127.0.0.1:8773/"), true);
  assert.equal(wantsVim("https://example.com/"), true);
  assert.equal(wantsVim("chrome://settings/"), false);
  assert.equal(wantsVim("devtools://devtools/inspector.html"), false);
  assert.equal(wantsVim("about:blank"), false);
});

/** A browser's DevTools, as far as the injector uses them. */
function fakeCdp(targets: { targetId: string; type: string; url: string }[]) {
  const calls: { method: string; params: any; sessionId?: string }[] = [];
  const listeners: ((event: CdpEvent) => void)[] = [];
  let sessions = 0;
  let scripts = 0;
  const cdp = {
    addEventListener(fn: (event: CdpEvent) => void) { listeners.push(fn); },
    async send(method: string, params: any = {}, sessionId?: string) {
      calls.push({ method, params, sessionId });
      if (method === "Target.getTargets") return { targetInfos: targets };
      if (method === "Target.attachToTarget") return { sessionId: `s${++sessions}` };
      if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: String(++scripts) };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
      return {};
    },
  };
  const emit = (method: string, params: unknown) => listeners.forEach((fn) => fn({ method, params, sessionId: undefined }));
  return { cdp: cdp as unknown as BrowserCdp, calls, emit };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

test("pages open at start get the script, run in their document too; new ones wait for theirs, then run", async () => {
  const { cdp, calls, emit } = fakeCdp([
    { targetId: "shell", type: "page", url: "http://127.0.0.1:8773/" },
    { targetId: "sw", type: "service_worker", url: "https://example.com/sw.js" },
  ]);
  const injector = new VimInjector(cdp, () => "/* bundle */");
  await injector.start();
  const sent = (method: string) => calls.filter((c) => c.method === method);
  assert.deepEqual(sent("Target.setAutoAttach")[0]!.params, { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  assert.equal(sent("Page.addScriptToEvaluateOnNewDocument").length, 1, "the page, not the worker");
  const first = sent("Page.addScriptToEvaluateOnNewDocument")[0]!;
  assert.equal(first.params.worldName, "pluto-vim");
  assert.equal(first.params.runImmediately, true);
  assert.match(first.params.source, /^if \(\/\^https\?:\$\/\.test\(location\.protocol\)[\s\S]*\/\* bundle \*\/[\s\S]*plutoVim\.attach\(document/);
  assert.equal(sent("Runtime.evaluate").length, 1, "and run in the document it has");

  // A new tab, paused until its script is in.
  emit("Target.attachedToTarget", { sessionId: "auto1", waitingForDebugger: true, targetInfo: { targetId: "tab", type: "page", url: "about:blank" } });
  // A worker: run, and let go.
  emit("Target.attachedToTarget", { sessionId: "auto2", waitingForDebugger: true, targetInfo: { targetId: "w", type: "shared_worker", url: "https://example.com/w.js" } });
  // Another part of the helper attaching on its own: not ours.
  emit("Target.attachedToTarget", { sessionId: "other", waitingForDebugger: false, targetInfo: { targetId: "shell", type: "page", url: "http://127.0.0.1:8773/" } });
  await tick();
  const order = calls.filter((c) => c.sessionId === "auto1").map((c) => c.method);
  assert.deepEqual(order, ["Page.addScriptToEvaluateOnNewDocument", "Runtime.runIfWaitingForDebugger", "Page.createIsolatedWorld", "Runtime.evaluate"], "its script, then it runs, then the script in the document it has");
  assert.deepEqual(calls.filter((c) => c.sessionId === "auto2").map((c) => c.method), ["Runtime.runIfWaitingForDebugger"]);
  assert.ok(sent("Target.detachFromTarget").some((c) => c.params.sessionId === "auto2"));
  assert.equal(injector.pages, 2);
  emit("Target.detachedFromTarget", { sessionId: "auto1" });
  assert.equal(injector.pages, 1);
});

test("a new page runs even when its script couldn't go in", async () => {
  const { cdp, calls, emit } = fakeCdp([]);
  (cdp as any).send = async (method: string, params: any = {}, sessionId?: string) => {
    calls.push({ method, params, sessionId });
    if (method === "Page.addScriptToEvaluateOnNewDocument") throw new Error("gone");
    return { targetInfos: [] };
  };
  const injector = new VimInjector(cdp, () => "");
  await injector.start();
  emit("Target.attachedToTarget", { sessionId: "a", waitingForDebugger: true, targetInfo: { targetId: "t", type: "page", url: "" } });
  await tick();
  assert.ok(calls.some((c) => c.method === "Runtime.runIfWaitingForDebugger" && c.sessionId === "a"));
});

test("starting again (a new connection to the browser) puts the engine back", async () => {
  const { cdp, calls } = fakeCdp([{ targetId: "shell", type: "page", url: "http://127.0.0.1:8773/" }]);
  const injector = new VimInjector(cdp, () => "");
  await injector.start();
  await injector.start();
  assert.equal(calls.filter((c) => c.method === "Page.addScriptToEvaluateOnNewDocument").length, 2);
});

test("a new init.js replaces each page's script and is configured into the world it has", async () => {
  const { cdp, calls } = fakeCdp([{ targetId: "shell", type: "page", url: "http://127.0.0.1:8773/" }]);
  let config = "null";
  const injector = new VimInjector(cdp, () => "", () => {}, { config: () => config, shellOrigins: () => ({ "http://127.0.0.1:8773": "hydra" }) });
  await injector.start();
  assert.match(calls.find((c) => c.method === "Page.addScriptToEvaluateOnNewDocument")!.params.source, /"hydra"\}\)\[location\.origin\]/);
  config = "(() => (vim) => {})()";
  calls.length = 0;
  await injector.reconfigure();
  assert.deepEqual(calls.map((c) => c.method), ["Page.removeScriptToEvaluateOnNewDocument", "Page.addScriptToEvaluateOnNewDocument", "Page.createIsolatedWorld", "Runtime.evaluate"]);
  assert.equal(calls[0]!.params.identifier, "1");
  assert.match(calls[3]!.params.expression, /configure\(globalThis\.plutoVimPage\.vim, \(\(\) => \(vim\) => \{\}\)\(\)\)/);
  assert.equal(calls[3]!.params.contextId, 7);
});

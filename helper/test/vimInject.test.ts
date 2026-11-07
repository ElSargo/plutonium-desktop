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
  const context = vm.createContext({});
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

test("only web pages get the engine", () => {
  assert.equal(wantsVim({ targetId: "a", type: "page", url: "http://127.0.0.1:8773/" }), true);
  assert.equal(wantsVim({ targetId: "a", type: "page", url: "https://example.com/" }), true);
  assert.equal(wantsVim({ targetId: "a", type: "page", url: "chrome://settings/" }), false);
  assert.equal(wantsVim({ targetId: "a", type: "page", url: "devtools://devtools/inspector.html" }), false);
  assert.equal(wantsVim({ targetId: "a", type: "service_worker", url: "https://example.com/sw.js" }), false);
});

/** A browser's DevTools, as far as the injector uses them. */
function fakeCdp(targets: { targetId: string; type: string; url: string }[]) {
  const calls: { method: string; params: any; sessionId?: string }[] = [];
  const listeners: ((event: CdpEvent) => void)[] = [];
  let sessions = 0;
  const cdp = {
    addEventListener(fn: (event: CdpEvent) => void) { listeners.push(fn); },
    async send(method: string, params: any = {}, sessionId?: string) {
      calls.push({ method, params, sessionId });
      if (method === "Target.getTargets") return { targetInfos: targets };
      if (method === "Target.attachToTarget") return { sessionId: `s${++sessions}` };
      return {};
    },
  };
  const emit = (method: string, params: unknown) => listeners.forEach((fn) => fn({ method, params, sessionId: undefined }));
  return { cdp: cdp as unknown as BrowserCdp, calls, emit };
}

test("each page gets the engine in its own world, once, and new pages as they come", async () => {
  const { cdp, calls, emit } = fakeCdp([
    { targetId: "shell", type: "page", url: "http://127.0.0.1:8773/" },
    { targetId: "settings", type: "page", url: "chrome://settings/" },
  ]);
  const injector = new VimInjector(cdp, () => "/* bundle */");
  await injector.start();
  const scripts = () => calls.filter((c) => c.method === "Page.addScriptToEvaluateOnNewDocument");
  assert.equal(scripts().length, 1);
  assert.equal(scripts()[0]!.params.worldName, "pluto-vim");
  assert.equal(scripts()[0]!.params.runImmediately, true);
  assert.match(scripts()[0]!.params.source, /\/\* bundle \*\/[\s\S]*plutoVim\.attach\(document\)/);
  assert.equal(scripts()[0]!.sessionId, "s1");
  emit("Target.targetInfoChanged", { targetInfo: { targetId: "shell", type: "page", url: "http://127.0.0.1:8773/draft" } });
  emit("Target.targetCreated", { targetInfo: { targetId: "tab", type: "page", url: "https://example.com/" } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(scripts().length, 2, "the shell page once; the new tab");
  assert.equal(injector.pages, 2);
  emit("Target.detachedFromTarget", { sessionId: "s2" });
  assert.equal(injector.pages, 1, "a page whose session went is free to get the engine again");
});

test("starting again (a new connection to the browser) puts the engine back", async () => {
  const { cdp, calls } = fakeCdp([{ targetId: "shell", type: "page", url: "http://127.0.0.1:8773/" }]);
  const injector = new VimInjector(cdp, () => "");
  await injector.start();
  await injector.start();
  assert.equal(calls.filter((c) => c.method === "Page.addScriptToEvaluateOnNewDocument").length, 2);
});

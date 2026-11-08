// Pluto Vim's init.js (vimConfig.ts): bundling it and its plugins, checking it
// in a dry run, the watched folder (commits, the last good version), and the
// injector carrying it into a real Chromium's pages, live.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { BrowserCdp } from "../src/cdp.ts";
import { checkConfig, configExpression, configModules, VimConfig } from "../src/vimConfig.ts";
import { vimBundle } from "../src/vimBundle.ts";
import { VimInjector } from "../src/vimInject.ts";
import { RegisterStore } from "../src/vimRegisters.ts";

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "vim");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A config folder with these files. */
function folder(files: Record<string, string>): string {
  const dir = join(mkdtempSync(join(tmpdir(), "pvim-config-")), "vim");
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

/** The setup function a config expression evaluates to, run on a fresh Vim in a context with the engine. */
function load(expression: string) {
  const context = vm.createContext({ setTimeout, clearTimeout });
  vm.runInContext(vimBundle(ENGINE), context);
  vm.runInContext(`globalThis.vim = new plutoVim.Vim(); globalThis.result = plutoVim.configure(vim, ${expression});`, context);
  return context as any;
}

describe("bundling", () => {
  test("init.js and its plugins, each module's exports from the others", () => {
    const dir = folder({
      "init.js": `import surround, { wrap as w } from "./plugins/surround.js";
import * as util from "./plugins/util.js";
import "./plugins/side.js";
export default function setup(vim) {
  vim.keymap.set("n", "Y", "y$");
  surround(vim, w("x"));
  vim.command("Upper", util.upper);
}`,
      "plugins/surround.js": `export function wrap(s) { return "(" + s + ")"; }
export default (vim, arg) => vim.keymap.set("n", "gs", arg);`,
      "plugins/util.js": `const upper = () => {};
const secret = 1;
export { upper, secret as hidden };`,
      "plugins/side.js": "globalThis.sideEffect = true;\n",
    });
    assert.deepEqual(configModules(dir)!.map((m) => m.id), ["plugins/surround.js", "plugins/util.js", "plugins/side.js", "init.js"]);
    const context = load(configExpression(dir));
    assert.equal(context.vim.keymaps.n.get("g\0s").rhs, "(x)");
    assert.equal(context.vim.user.commands.has("Upper"), true);
    assert.equal(context.sideEffect, true);
  });

  test("no init.js is the defaults; a bare import, one outside the folder, and a circle are refused", () => {
    assert.equal(configExpression(folder({ "other.js": "" })), "null");
    assert.throws(() => configModules(folder({ "init.js": 'import _ from "lodash";\n' })), /a plugin is a file in/);
    assert.throws(() => configModules(folder({ "init.js": 'import x from "../x.js";\n' })), /outside/);
    assert.throws(() => configModules(folder({ "init.js": 'import a from "./a.js";\n', "a.js": 'import b from "./init.js";\nexport default 1;\n' })), /circle: init\.js → a\.js → init\.js/);
  });

  test("lines stay where they were, so errors point at the file's own", () => {
    const result = checkConfig(folder({ "init.js": "import {\n  a,\n} from \"./a.js\";\nexport default function setup(vim) {\n  vim.opt.nope = 1;\n}\n", "a.js": "export const a = 1;\n" }), ENGINE);
    assert.equal(result.ok, false);
    assert.match(result.errors[0]!, /^init\.js:5: pluto vim: vim\.opt\.nope: no such option/);
  });
});

describe("checking", () => {
  test("a good config: what it sets up, and its warnings", () => {
    const result = checkConfig(folder({ "init.js": 'export default function (vim) { vim.keymap.set("n", "xx", "dd"); vim.command("Hi", () => {}); }\n' }), ENGINE);
    assert.equal(result.ok, true);
    assert.equal(result.summary, "1 mapping, 1 command");
    assert.match(result.warnings[0]!, /x now waits/);
  });

  test("syntax errors, throws, and no default export", () => {
    let r = checkConfig(folder({ "init.js": "export default function (vim) {\n  let a = ;\n}\n" }), ENGINE);
    assert.match(r.errors[0]!, /^init\.js:2: Unexpected token/);
    r = checkConfig(folder({ "init.js": "export default function (vim) {\n  nope();\n}\n" }), ENGINE);
    assert.match(r.errors[0]!, /^init\.js:2: nope is not defined/);
    r = checkConfig(folder({ "init.js": "export const x = 1;\n" }), ENGINE);
    assert.match(r.errors[0]!, /no default export/);
  });
});

describe("the watched folder", () => {
  const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

  test("starts with a starter init.js, committed; good saves are committed and handed on, bad ones notify and keep the last good", async () => {
    const home = mkdtempSync(join(tmpdir(), "pvim-home-"));
    const changes: string[] = [];
    const notices: string[] = [];
    const config = new VimConfig({ home, engineDir: ENGINE, onChange: (e) => changes.push(e), notify: (s, b) => notices.push(`${s}: ${b}`) });
    try {
      config.start();
      const dir = join(home, "vim");
      assert.match(readFileSync(join(dir, "init.js"), "utf8"), /export default function setup\(vim\)/);
      assert.equal(git(dir, "log", "--format=%s"), "pluto vim: init.js");
      assert.equal(changes.length, 1, "the first load");

      writeFileSync(join(dir, "init.js"), 'export default function (vim) { vim.keymap.set("i", "jk", "<Esc>"); }\n');
      await waitFor(() => changes.length === 2);
      assert.match(config.expression, /jk/);
      assert.equal(git(dir, "rev-list", "--count", "HEAD"), "2");

      writeFileSync(join(dir, "init.js"), "export default function (vim) { vim.opt.inputs = false; }\n");
      await waitFor(() => notices.length === 1);
      assert.match(notices[0]!, /init\.js has an error: init\.js:1: pluto vim: vim\.opt\.inputs/);
      assert.match(config.expression, /jk/, "the last good one stays");
      assert.equal(changes.length, 2);
      assert.equal(git(dir, "rev-list", "--count", "HEAD"), "2", "a bad version isn't committed");
    } finally {
      config.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("starting with a broken init.js runs the newest committed one that works", () => {
    const home = mkdtempSync(join(tmpdir(), "pvim-home-"));
    const dir = join(home, "vim");
    const first = new VimConfig({ home, engineDir: ENGINE, onChange: () => {} });
    first.start();
    first.stop();
    writeFileSync(join(dir, "init.js"), 'export default function (vim) { vim.keymap.set("n", "Q", "dd"); }\n');
    first.load(true);
    writeFileSync(join(dir, "init.js"), "export default function (vim) { broken(; }\n");
    const changes: string[] = [];
    const again = new VimConfig({ home, engineDir: ENGINE, onChange: (e) => changes.push(e) });
    try {
      again.start();
      assert.equal(changes.length, 1);
      assert.match(changes[0]!, /"Q"/);
    } finally {
      again.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

async function waitFor(condition: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(20);
  }
}

function chromiumPath(): string | null {
  if (process.env.PLUTO_TEST_CHROMIUM) return process.env.PLUTO_TEST_CHROMIUM;
  try {
    return execFileSync("sh", ["-c", "command -v chromium"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

const chromium = chromiumPath();

describe("init.js in a real browser's pages", { skip: chromium ? false : "no Chromium (PLUTO_TEST_CHROMIUM)" }, () => {
  let server: Server;
  let browserProcess: ChildProcess;
  let profile: string;
  let cdp: BrowserCdp;
  let origin = "";

  before(async () => {
    server = createServer((req, res) => res.writeHead(200, {
      "Content-Type": "text/html",
      // A page that allows no eval of its own: "= still evaluates, in the engine's world.
      ...(req.url === "/csp" ? { "Content-Security-Policy": "script-src 'none'" } : {}),
    }).end("<textarea id=ta></textarea>"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    profile = mkdtempSync(join(tmpdir(), "pvim-chromium-"));
    browserProcess = spawn(chromium!, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
    const portFile = join(profile, "DevToolsActivePort");
    await waitFor(() => existsSync(portFile) && readFileSync(portFile, "utf8").includes("\n"), 20000);
    cdp = new BrowserCdp(Number(readFileSync(portFile, "utf8").split("\n")[0]));
  });

  after(async () => {
    if (browserProcess && browserProcess.exitCode == null) {
      const exited = new Promise((r) => browserProcess.once("exit", r));
      browserProcess.kill();
      await exited;
    }
    server?.close();
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  });

  /** Keys typed into the page, as key events. */
  async function press(sessionId: string, keys: string) {
    for (const key of keys) {
      const code = `Key${key.toUpperCase()}`;
      const vk = key.toUpperCase().charCodeAt(0);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, text: key, windowsVirtualKeyCode: vk }, sessionId);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk }, sessionId);
    }
    await sleep(50);
  }

  test("a page's world runs init.js, and a new version reaches the open page", async () => {
    let expression = configExpression(folder({ "init.js": 'export default function (vim) { vim.keymap.set("i", "jk", "<Esc>"); }\n' }));
    const injector = new VimInjector(cdp, () => vimBundle(ENGINE), () => {}, { config: () => expression });
    await injector.start();
    const { targetId } = (await cdp.send("Target.createTarget", { url: `${origin}/` })) as { targetId: string };
    const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
    await waitFor(() => injector.pages >= 1, 5000);
    const value = async (expr: string) => ((await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId)) as { result: { value: unknown } }).result.value;
    const end = Date.now() + 5000;
    while ((await value("document.readyState === 'complete' && !!document.getElementById('ta')")) !== true) {
      if (Date.now() > end) throw new Error("the page didn't load");
      await sleep(50);
    }
    // The engine is in the page's world before keys come.
    // (A world is its DevTools session's: the injector's session sees it.)
    const own = (injector as any).sessions.get(targetId).sessionId as string;
    const inWorld = async () => {
      const { executionContextId } = (await cdp.send("Page.createIsolatedWorld", { frameId: targetId, worldName: "pluto-vim" }, own)) as { executionContextId: number };
      return ((await cdp.send("Runtime.evaluate", { contextId: executionContextId, expression: "!!globalThis.plutoVimPage", returnByValue: true }, own)) as { result: { value: boolean } }).result.value;
    };
    while (!(await inWorld())) {
      if (Date.now() > end) throw new Error("the engine didn't reach the page");
      await sleep(50);
    }
    await cdp.send("Runtime.evaluate", { expression: "document.getElementById('ta').focus()" }, sessionId);
    await sleep(100);
    await press(sessionId, "abjk");
    assert.equal(await value("document.getElementById('ta').value"), "ab");
    assert.equal(await value("document.getElementById('ta').dataset.pvimMode"), "normal", "jk left insert mode");
    assert.equal(await value("typeof plutoVim"), "undefined", "the engine stays in its own world");

    // A new init.js: kj instead, into the page as it is.
    expression = configExpression(folder({ "init.js": 'export default function (vim) { vim.keymap.set("i", "kj", "<Esc>"); }\n' }));
    await injector.reconfigure();
    await press(sessionId, "a");
    assert.equal(await value("document.getElementById('ta').dataset.pvimMode"), "insert");
    await press(sessionId, "jkkj");
    assert.equal(await value("document.getElementById('ta').value"), "abjk", "jk is typed now; kj leaves");
    assert.equal(await value("document.getElementById('ta').dataset.pvimMode"), "normal");
    await cdp.send("Target.closeTarget", { targetId });
    await injector.stop();
  });

  test("registers are the helper's: a yank in one page puts in another, by scope, and the page can't reach them", async () => {
    const expression = configExpression(folder({
      "init.js": 'export default function (vim) { vim.opt.startInInsert = false; vim.registers.scope("t", "thread"); }\n',
    }));
    const registers = new RegisterStore();
    const threads = new Map<string, string>();
    const injector = new VimInjector(cdp, () => vimBundle(ENGINE), () => {}, {
      config: () => expression,
      registers,
      placeOf: (targetId) => ({ thread: threads.get(targetId) ?? null }),
    });
    await injector.start();
    const open = async (thread: string, text: string, path = "/") => {
      const { targetId } = (await cdp.send("Target.createTarget", { url: `${origin}${path}` })) as { targetId: string };
      threads.set(targetId, thread);
      const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
      await waitFor(() => (injector as any).sessions.has(targetId), 5000);
      const own = (injector as any).sessions.get(targetId).sessionId as string;
      const end = Date.now() + 5000;
      const inWorld = async () => {
        const { executionContextId } = (await cdp.send("Page.createIsolatedWorld", { frameId: targetId, worldName: "pluto-vim" }, own)) as { executionContextId: number };
        return ((await cdp.send("Runtime.evaluate", { contextId: executionContextId, expression: "!!globalThis.plutoVimPage", returnByValue: true }, own)) as { result: { value: boolean } }).result.value;
      };
      while (!(await inWorld().catch(() => false))) {
        if (Date.now() > end) throw new Error("the engine didn't reach the page");
        await sleep(50);
      }
      const value = async (expr: string) => ((await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId)) as { result: { value: unknown } }).result.value;
      await value(`(() => { const ta = document.getElementById('ta'); ta.value = ${JSON.stringify(text)}; ta.focus(); ta.setSelectionRange(0, 0); })()`);
      await sleep(100);
      return { targetId, sessionId, value };
    };
    const a = await open("one", "hello");
    const b = await open("two", "world");
    const c = await open("one", "again");
    assert.equal(await a.value("typeof plutoVimStore"), "undefined", "the binding is only in the engine's world");

    await press(a.sessionId, "yy");
    await waitFor(() => registers.size > 0, 2000);
    await press(b.sessionId, "p");
    await waitFor(async () => (await b.value("document.getElementById('ta').value")) !== "world", 2000);
    assert.equal(await b.value("document.getElementById('ta').value"), "world\nhello", "a yank in one page puts in another");

    // "t is each thread's own: b's thread has nothing in it; c shares a's.
    await press(a.sessionId, '"tyiw');
    await sleep(100);
    await press(b.sessionId, 'u"tp');
    await sleep(200);
    assert.equal(await b.value("document.getElementById('ta').value"), "world", "another thread's \"t is empty");
    await press(c.sessionId, '"tP');
    await waitFor(async () => (await c.value("document.getElementById('ta').value")) !== "again", 2000);
    assert.equal(await c.value("document.getElementById('ta').value"), "helloagain");
    assert.deepEqual(await registers.get("t", "thread", { thread: "one" }), { text: "hello", linewise: false });

    const strict = await open("one", "ab", "/csp");
    await press(strict.sessionId, '"=');
    for (const key of "6*7") {
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, text: key }, strict.sessionId);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key }, strict.sessionId);
    }
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, strict.sessionId);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, strict.sessionId);
    await press(strict.sessionId, "p");
    await waitFor(async () => (await strict.value("document.getElementById('ta').value")) !== "ab", 2000);
    assert.equal(await strict.value("document.getElementById('ta').value"), "a42b", "\"= under the page's CSP");
    await cdp.send("Target.closeTarget", { targetId: strict.targetId });
    for (const page of [a, b, c]) await cdp.send("Target.closeTarget", { targetId: page.targetId });
    await injector.stop();
  });
});

// Pluto Vim's stand-in web backend (web/vim/dom.js, PLUTO_VIM.md step 2), in
// a real browser: real key events into a <textarea>, an <input>, a plain
// contenteditable and a ProseMirror editor (Hydra's composer is Tiptap, which
// is ProseMirror).
//
// Needs a Chromium (PLUTO_TEST_CHROMIUM, else `chromium` on PATH); the
// ProseMirror tests need T3 Code's checkout (T3CODE_DIR, else ~/projects/t3code)
// for its node_modules. Each is skipped without them.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const VIM = join(HERE, "..", "web", "vim");

function chromiumPath(): string | null {
  if (process.env.PLUTO_TEST_CHROMIUM) return process.env.PLUTO_TEST_CHROMIUM;
  try {
    return execFileSync("sh", ["-c", "command -v chromium"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

const PM_PACKAGES = [
  "prosemirror-model", "prosemirror-state", "prosemirror-view", "prosemirror-history", "prosemirror-keymap",
  "prosemirror-commands", "prosemirror-transform", "orderedmap", "w3c-keyname", "rope-sequence",
];

/** Each ProseMirror package's dist/index.js in T3 Code's pnpm store, or null. */
function proseMirror(): Record<string, string> | null {
  const store = join(process.env.T3CODE_DIR ?? join(homedir(), "projects", "t3code"), "node_modules", ".pnpm");
  if (!existsSync(store)) return null;
  const entries = readdirSync(store);
  const found: Record<string, string> = {};
  for (const name of PM_PACKAGES) {
    const dir = entries.find((e) => e.startsWith(`${name}@`));
    const base = dir && join(store, dir, "node_modules", name);
    const file = base && [join(base, "dist", "index.js"), join(base, "index.js")].find((f) => existsSync(f));
    if (!file) return null;
    found[name] = file;
  }
  return found;
}

const PAGE = (pm: boolean) => `<!doctype html>
<meta charset="utf-8">
<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(PM_PACKAGES.map((n) => [n, `/pm/${n}.js`])) })}</script>
<form id="form" onsubmit="event.preventDefault(); window.submitted.push(document.getElementById('in').value)">
  <input id="in" type="text">
</form>
<textarea id="ta" rows="5" cols="40"></textarea>
<textarea id="guarded" rows="2" cols="40"></textarea>
<input id="pw" type="password">
<div id="ce" contenteditable="true"><p>one two</p><p>three</p></div>
<div id="pm"></div>
<div id="composer"></div>
<div id="rich"></div>
<script type="module">
  import { attach, bufferFor } from "/vim/dom.js";
  window.submitted = [];
  window.inputs = [];
  document.addEventListener("input", (e) => window.inputs.push(e.inputType));
  // A page's own key handler on a field: Principle 1 says it wins.
  document.getElementById("guarded").addEventListener("keydown", (e) => { if (e.key === "j") e.preventDefault(); });
  window.escapes = [];
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") window.escapes.push(e.defaultPrevented); });
  window.pvim = attach(document, { opt: { startInInsert: true } });
  window.bufferFor = bufferFor;
  window.state = (sel) => {
    const el = document.querySelector(sel);
    const t = bufferFor(el).text();
    return { text: t.text, cursor: t.cursor, anchor: t.anchor, mode: window.pvim.sessionOf(el).mode, pvimMode: el.dataset.pvimMode };
  };
  window.idle = (sel) => window.pvim.sessionOf(document.querySelector(sel)).idle();
  ${pm ? `
  const { Schema } = await import("prosemirror-model");
  const { EditorState } = await import("prosemirror-state");
  const { EditorView } = await import("prosemirror-view");
  const { history, undo, redo } = await import("prosemirror-history");
  const { keymap } = await import("prosemirror-keymap");
  const { baseKeymap } = await import("prosemirror-commands");
  const schema = new Schema({ nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "inline*", toDOM: () => ["p", 0], parseDOM: [{ tag: "p" }] },
    text: { group: "inline" },
  } });
  const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("alpha beta")]), schema.node("paragraph", null, [schema.text("gamma")])]);
  window.pmView = new EditorView(document.getElementById("pm"), {
    state: EditorState.create({ doc, plugins: [history(), keymap({ "Mod-z": undo, "Mod-y": redo }), keymap(baseKeymap)] }),
  });
  window.pmText = () => { const d = window.pmView.state.doc; return d.textBetween(0, d.content.size, "\\n"); };
  // Like Hydra's composer: one paragraph, lines are hard breaks, Enter isn't a new paragraph.
  const one = new Schema({ nodes: {
    doc: { content: "paragraph" },
    paragraph: { content: "inline*", toDOM: () => ["p", 0], parseDOM: [{ tag: "p" }] },
    text: { group: "inline" },
    hard_break: { inline: true, group: "inline", selectable: false, toDOM: () => ["br"], parseDOM: [{ tag: "br" }], leafText: () => "\\n" },
  } });
  window.composerView = new EditorView(document.getElementById("composer"), {
    state: EditorState.create({ doc: one.node("doc", null, [one.node("paragraph")]), plugins: [history(), keymap({ "Mod-z": undo, "Mod-y": redo, Enter: () => { window.composerSends++; return true; } }), keymap(baseKeymap)] }),
  });
  window.composerSends = 0;
  // Like Hydra's rich composer: paragraphs are lines, Enter sends, Shift+Enter is a new paragraph.
  const { splitBlock } = await import("prosemirror-commands");
  window.richSends = 0;
  window.richView = new EditorView(document.getElementById("rich"), {
    state: EditorState.create({ doc: schema.node("doc", null, [schema.node("paragraph", null, [schema.text("first")]), schema.node("paragraph", null, [schema.text("second")])]),
      plugins: [history(), keymap({ Enter: () => { window.richSends++; return true; }, "Shift-Enter": splitBlock }), keymap(baseKeymap)] }),
  });
  window.richText = () => { const d = window.richView.state.doc; return d.textBetween(0, d.content.size, "\\n"); };
  window.composerDoc = () => window.composerView.state.doc.toJSON();
  ` : ""}
  window.ready = true;
</script>`;

const chromium = chromiumPath();
const pm = proseMirror();

describe("Pluto Vim in a browser", { skip: chromium ? false : "no Chromium (PLUTO_TEST_CHROMIUM)" }, () => {
  let server: Server;
  let browser: Browser;
  let page: Page;
  let origin = "";

  before(async () => {
    server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      let body: Buffer | string | null = null;
      if (path === "/") body = PAGE(Boolean(pm));
      else if (path.startsWith("/vim/")) {
        const file = join(VIM, path.slice(5));
        if (file.startsWith(VIM) && existsSync(file)) body = readFileSync(file);
      } else if (path.startsWith("/pm/") && pm) {
        const name = path.slice(4).replace(/\.js$/, "");
        if (pm[name]) body = readFileSync(pm[name]);
      }
      if (body == null) return void res.writeHead(404).end();
      const type = path === "/" ? "text/html" : extname(path) === ".js" || path.startsWith("/pm/") ? "text/javascript" : "text/plain";
      res.writeHead(200, { "Content-Type": type }).end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const { chromium: launcher } = await import("playwright-core");
    browser = await launcher.launch({ executablePath: chromium!, headless: true });
    page = await browser.newPage();
    page.on("pageerror", (e) => console.error("page error:", e));
    await page.goto(origin);
    await page.waitForFunction(() => (window as any).ready === true);
  });

  after(async () => {
    await browser?.close();
    server?.close();
  });

  /** Focuses a field with its text set and the cursor at the end, in insert mode (a fresh session). */
  async function fresh(sel: string, text: string) {
    await page.evaluate(({ sel, text }) => {
      const el = document.querySelector(sel) as HTMLTextAreaElement;
      const clone = el.cloneNode(true) as HTMLTextAreaElement;
      el.replaceWith(clone); // a new element: a new session
      if ("value" in clone && clone.tagName !== "DIV") clone.value = text;
      clone.focus();
      if ("setSelectionRange" in clone) clone.setSelectionRange(text.length, text.length);
    }, { sel, text });
  }

  async function keys(sel: string, ...presses: string[]) {
    for (const p of presses) {
      if (p.length === 1 || !/^[A-Z][a-z]|\+/.test(p)) await page.keyboard.type(p);
      else await page.keyboard.press(p);
      await page.evaluate((s) => (window as any).idle(s), sel);
    }
  }

  const state = (sel: string) => page.evaluate((s) => (window as any).state(s), sel);

  test("a textarea: insert, Escape, motions and operators", async () => {
    await fresh("#ta", "");
    await keys("#ta", "hello world", "Escape");
    let s = await state("#ta");
    assert.equal(s.mode, "normal");
    assert.equal(s.cursor, 10, "Escape moves onto the last character");
    assert.equal(s.pvimMode, "normal");
    await keys("#ta", "b", "d", "w");
    s = await state("#ta");
    assert.equal(s.text, "hello ");
    await keys("#ta", "u");
    assert.equal((await state("#ta")).text, "hello world");
  });

  test("Escape that leaves insert mode is vim's alone; one vim has no use for is the page's", async () => {
    await fresh("#ta", "");
    await page.evaluate(() => { (window as any).escapes.length = 0; });
    await keys("#ta", "hello", "Escape");
    assert.equal((await state("#ta")).mode, "normal");
    assert.deepEqual(await page.evaluate(() => (window as any).escapes), [], "the page never saw the first Escape");
    await keys("#ta", "v", "Escape");
    assert.equal((await state("#ta")).mode, "normal");
    assert.deepEqual(await page.evaluate(() => (window as any).escapes), [], "nor the one leaving visual mode");
    await keys("#ta", "Escape");
    assert.deepEqual(await page.evaluate(() => (window as any).escapes), [false], "in normal mode it's the page's, untouched");
  });

  test("a wrapping textarea: j and k move by display lines, gj and gk by real ones, dj takes real lines", async () => {
    const long = "word ".repeat(24).trim(); // 119 characters: three lines or more at 40 columns
    await fresh("#ta", `${long}\nsecond\nthird`);
    await keys("#ta", "Escape", "g", "g");
    assert.equal((await state("#ta")).cursor, 0);
    await keys("#ta", "j");
    let s = await state("#ta");
    assert.ok(s.cursor > 20 && s.cursor < 60, `j stayed in the wrapped line (at ${s.cursor})`);
    await keys("#ta", "k");
    assert.equal((await state("#ta")).cursor, 0, "k went back up");
    await keys("#ta", "g", "j");
    assert.equal((await state("#ta")).cursor, long.length + 1, "gj went to the next real line");
    await keys("#ta", "g", "k");
    assert.equal((await state("#ta")).cursor, 0, "gk back to the first");
    await keys("#ta", "d", "j");
    assert.equal((await state("#ta")).text, "third", "dj deleted two real lines");
    await keys("#ta", "u", "g", "g", "5", "j");
    s = await state("#ta");
    assert.ok(s.text.startsWith(long) && s.cursor > long.length + 1, `5j crossed into later lines (at ${s.cursor})`);
  });

  test("display lines off (vim.opt.displayLines = false): j is a real line, gj a display line", async () => {
    await page.evaluate(() => { (window as any).pvim.vim.opt.displayLines = false; });
    try {
      const long = "word ".repeat(24).trim();
      await fresh("#ta", `${long}\nsecond`);
      await keys("#ta", "Escape", "g", "g", "j");
      assert.equal((await state("#ta")).cursor, long.length + 1);
      await keys("#ta", "g", "g", "g", "j");
      const s = await state("#ta");
      assert.ok(s.cursor > 20 && s.cursor < 60, `gj stayed in the wrapped line (at ${s.cursor})`);
    } finally {
      await page.evaluate(() => { (window as any).pvim.vim.opt.displayLines = true; });
    }
  });

  test("a textarea: cw then u undoes the whole change; edits are real input events", async () => {
    await fresh("#ta", "one two");
    await page.evaluate(() => { (window as any).inputs.length = 0; });
    await keys("#ta", "Escape", "0", "c", "w", "uno", "Escape");
    assert.equal((await state("#ta")).text, "uno two");
    const inputs: string[] = await page.evaluate(() => (window as any).inputs);
    assert.ok(inputs.includes("deleteContent") || inputs.includes("deleteContentBackward") || inputs.includes("insertText"), inputs.join(","));
    await keys("#ta", "u");
    assert.equal((await state("#ta")).text, "one two");
    await keys("#ta", "Control+r");
    assert.equal((await state("#ta")).text, "uno two");
  });

  test("a textarea: lines, visual mode, yank and put", async () => {
    await fresh("#ta", "");
    await keys("#ta", "a", "Enter", "b", "Enter", "c", "Escape", "g", "g", "y", "y", "G", "p");
    assert.equal((await state("#ta")).text, "a\nb\nc\na");
    await keys("#ta", "g", "g", "V", "j", "d");
    assert.equal((await state("#ta")).text, "c\na");
    await keys("#ta", "v", "$", "y", "P");
    assert.equal((await state("#ta")).text, "cc\na");
  });

  test("a page's own key handler on the field wins", async () => {
    await page.evaluate(() => {
      const el = document.getElementById("guarded") as HTMLTextAreaElement;
      el.value = "a\nb";
      el.focus();
      el.setSelectionRange(0, 0);
    });
    await keys("#guarded", "Escape", "j");
    const s = await state("#guarded");
    assert.equal(s.cursor, 0, "j was the page's");
    await keys("#guarded", "l");
    assert.equal((await state("#guarded")).cursor, 0, "a one-character line: l can't move");
  });

  test("a single-line input: Escape is the page's, Ctrl+[ enters normal mode, Enter submits", async () => {
    await fresh("#in", "");
    await page.evaluate(() => { (window as any).escapes.length = 0; (window as any).submitted.length = 0; });
    await keys("#in", "foo bar", "Escape");
    assert.equal((await state("#in")).mode, "insert");
    assert.deepEqual(await page.evaluate(() => (window as any).escapes), [false], "Escape reached the page untouched");
    await keys("#in", "Control+BracketLeft");
    assert.equal((await state("#in")).mode, "normal");
    await keys("#in", "b", "D");
    assert.equal((await state("#in")).text, "foo ");
    await keys("#in", "Enter");
    assert.deepEqual(await page.evaluate(() => (window as any).submitted), ["foo "]);
  });

  test("Caps Lock (Plutonium's Escape with code CapsLock) is Ctrl+[: normal mode before the page", async () => {
    await fresh("#in", "");
    await page.evaluate(() => { (window as any).escapes.length = 0; });
    await keys("#in", "foo bar");
    // Ash's rewrite, as Blink gets it: key Escape, keyCode 27, code CapsLock.
    const cdp = await page.context().newCDPSession(page);
    for (const type of ["rawKeyDown", "keyUp"]) {
      await cdp.send("Input.dispatchKeyEvent", { type: type as "rawKeyDown", key: "Escape", code: "CapsLock", windowsVirtualKeyCode: 27 });
    }
    await cdp.detach();
    await page.evaluate((s) => (window as any).idle(s), "#in");
    assert.equal((await state("#in")).mode, "normal");
    assert.deepEqual(await page.evaluate(() => (window as any).escapes), [], "the page never saw it");
    await keys("#in", "b", "D");
    assert.equal((await state("#in")).text, "foo ");
  });

  test("a page that integrates: its start, its actions from Enter, j and k, and keys it gives up", async () => {
    await page.evaluate(() => {
      const w = window as any;
      w.actions = [];
      const el = document.createElement("textarea");
      el.id = "integ";
      el.value = "one\ntwo";
      el.dataset.pvimStart = "normal";
      el.dataset.pvimActions = "submit history.prev history.next";
      el.dataset.pvimYield = "x";
      // The page's own x: vim's while the page gives it up.
      el.addEventListener("keydown", (e) => { if (e.key === "x") e.preventDefault(); });
      el.addEventListener("pvim:action", (e) => w.actions.push((e as CustomEvent).detail.name));
      el.addEventListener("pvim:mode", (e) => w.actions.push(`mode ${(e as CustomEvent).detail.mode}`));
      document.body.append(el);
      el.focus();
      el.setSelectionRange(0, 0);
    });
    await page.evaluate(() => (window as any).idle("#integ"));
    assert.equal((await state("#integ")).mode, "normal", "data-pvim-start");
    await keys("#integ", "k", "j", "j", "Enter");
    assert.deepEqual(await page.evaluate(() => (window as any).actions), ["history.prev", "history.next", "submit"],
      "k on the first line, j on the second (a motion), j on the last, Enter");
    await keys("#integ", "x");
    assert.equal((await state("#integ")).text, "one\nwo", "x yielded");
    await page.evaluate(() => { document.getElementById("integ")!.dataset.pvimYield = ""; });
    await keys("#integ", "i", "x");
    assert.equal((await state("#integ")).text, "one\nwo", "the page's x in insert mode");
    assert.ok((await page.evaluate(() => (window as any).actions)).includes("mode insert"));
  });

  test("while a jump or the : line is typed, Enter is vim's before the page's own handler", async () => {
    await page.evaluate(() => {
      const w = window as any;
      w.sent = 0;
      const el = document.createElement("textarea");
      el.id = "sends";
      el.value = "one two";
      // A chat composer's Enter: it sends, and the page sees the key first.
      el.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); w.sent++; } });
      document.body.append(el);
      el.focus();
      el.setSelectionRange(0, 0);
    });
    await keys("#sends", "Control+BracketLeft", "s", "t", "Enter");
    assert.equal(await page.evaluate(() => (window as any).sent), 0);
    assert.equal((await state("#sends")).cursor, 4, "Enter went to the match");
    await keys("#sends", ":", "s/one/1/", "Enter");
    assert.equal(await page.evaluate(() => (window as any).sent), 0);
    assert.equal((await state("#sends")).text, "1 two");
  });

  test("the : line is drawn under the field as it's typed, and runs on Enter", async () => {
    await fresh("#ta", "a a");
    await keys("#ta", "Escape", ":", "s/a/b/g");
    assert.equal(await page.evaluate(() => document.querySelectorAll("pvim-line").length), 1);
    await keys("#ta", "Enter");
    assert.equal((await state("#ta")).text, "b b");
    assert.equal(await page.evaluate(() => document.querySelectorAll("pvim-line").length), 0);
  });

  test("s: the jump's labels are drawn over the field while it's typed, and the label goes there", async () => {
    await fresh("#ta", "one two one three one");
    await keys("#ta", "Escape", "0", "s", "o");
    assert.equal(await page.evaluate(() => document.querySelectorAll("pvim-labels").length), 1);
    // Where the labels go: each character's own place, in the field's layout.
    const placed = await page.evaluate(() => {
      const el = document.getElementById("ta") as HTMLTextAreaElement;
      const rects = (window as any).bufferFor(el).rectsOf([4, 8, 18]);
      const box = el.getBoundingClientRect();
      return { xs: [4, 8, 18].map((o) => rects.get(o).left), inside: [...rects.values()].every((r: any) => r.left >= box.left && r.top >= box.top && r.top < box.bottom) };
    });
    assert.ok(placed.inside, "labels are over the field");
    assert.ok(placed.xs[0] < placed.xs[1] && placed.xs[1] < placed.xs[2], "and further along the line for later offsets");
    await keys("#ta", "Enter");
    assert.equal(await page.evaluate(() => document.querySelectorAll("pvim-labels").length), 0);
    assert.equal((await state("#ta")).cursor, 6, "Enter goes to the nearest match (two's o)");
  });

  test("a contenteditable's character rects are the browser's own", async () => {
    const same = await page.evaluate(() => {
      const el = document.getElementById("ce")!;
      const rects = (window as any).bufferFor(el).rectsOf([4, 8]);
      const range = document.createRange();
      const text = el.querySelector("p")!.firstChild!;
      range.setStart(text, 4);
      range.setEnd(text, 5);
      const want = range.getBoundingClientRect();
      const second = el.querySelectorAll("p")[1].firstChild!;
      range.setStart(second, 0);
      range.setEnd(second, 1);
      const want2 = range.getBoundingClientRect();
      return Math.abs(rects.get(4).left - want.left) < 1 && Math.abs(rects.get(8).top - want2.top) < 1;
    });
    assert.ok(same);
  });

  test("a read-only region: the cursor is drawn, motions and visual mode work, y yanks, x does nothing", async () => {
    await page.evaluate(() => {
      const el = document.createElement("div");
      el.id = "ro";
      el.tabIndex = -1;
      el.setAttribute("data-pvim-readonly", "");
      el.innerHTML = "<p>alpha beta gamma</p><p>delta</p>";
      document.body.append(el);
      el.focus();
    });
    await keys("#ro", "w", "v", "e", "y");
    const yanked = await page.evaluate(async () => (await (window as any).pvim.vim.registers.get('"'))?.text);
    assert.equal(yanked, "beta");
    await keys("#ro", "x", "d", "d");
    assert.equal(await page.evaluate(() => document.getElementById("ro")!.textContent), "alpha beta gammadelta");
    assert.equal(await page.evaluate(() => document.querySelectorAll("pvim-caret").length), 1, "its cursor is drawn");
    assert.equal((await state("#ro")).mode, "normal");
  });

  test("off a field, a page's place keys go to the desktop (PageKey); a field's keys stay the field's", async () => {
    await page.evaluate(() => {
      const w = window as any;
      w.pageKeys = [];
      w.pvim.vim.on("PageKey", ({ name }: any) => w.pageKeys.push(name));
      (document.activeElement as HTMLElement)?.blur();
      document.body.focus();
    });
    await page.keyboard.type("gtzbS");
    await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(() => (window as any).pageKeys), ["place.terminal", "show.panel", "jump.significant"]);
  });

  test("a password field is never vim's", async () => {
    await page.evaluate(() => { const el = document.getElementById("pw") as HTMLInputElement; el.value = ""; el.focus(); });
    await page.keyboard.press("Control+BracketLeft");
    await page.keyboard.type("x");
    assert.equal(await page.evaluate(() => (document.getElementById("pw") as HTMLInputElement).value), "x");
  });

  test("a wrapping contenteditable: j moves by display lines, gj by blocks", async () => {
    const long = "word ".repeat(24).trim();
    await page.evaluate((long) => {
      const el = document.getElementById("ce")!;
      el.style.width = "20em";
      el.innerHTML = `<p>${long}</p><p>after</p>`;
      el.focus();
      getSelection()!.collapse(el.querySelector("p")!.firstChild, 0);
    }, long);
    try {
      await keys("#ce", "Escape");
      await keys("#ce", "j");
      const s = await state("#ce");
      assert.ok(s.cursor > 5 && s.cursor < long.length, `j stayed in the wrapped paragraph (at ${s.cursor})`);
      await keys("#ce", "k");
      assert.equal((await state("#ce")).cursor, 0);
      await keys("#ce", "g", "j");
      assert.equal((await state("#ce")).cursor, long.length + 1, "gj went to the next block");
    } finally {
      await page.evaluate(() => { document.getElementById("ce")!.style.width = ""; });
    }
  });

  test("a contenteditable: blocks are lines", async () => {
    await page.evaluate(() => {
      const el = document.getElementById("ce")!;
      el.innerHTML = "<p>one two</p><p>three</p>";
      el.focus();
      const sel = getSelection()!;
      sel.collapse(el.querySelector("p")!.firstChild, 0);
    });
    let s = await state("#ce");
    assert.equal(s.text, "one two\nthree");
    await keys("#ce", "Escape");
    s = await state("#ce");
    assert.equal(s.mode, "normal");
    await keys("#ce", "w", "j");
    assert.equal((await state("#ce")).cursor, 12, "j keeps the column");
    await keys("#ce", "k", "d", "i", "w");
    assert.equal((await state("#ce")).text, "one \nthree");
    await keys("#ce", "o", "new", "Escape");
    assert.equal((await state("#ce")).text, "one \nnew\nthree");
    await keys("#ce", "j", "d", "d");
    assert.equal((await state("#ce")).text, "one \nnew");
  });

  test("ProseMirror: edits go through the editor's model, and u is its undo", { skip: pm ? false : "no T3 Code checkout for ProseMirror" }, async () => {
    await page.evaluate(() => {
      const view = (window as any).pmView;
      view.focus();
      const sel = getSelection()!;
      sel.collapse(view.dom.querySelector("p").firstChild, 0);
    });
    await new Promise((r) => setTimeout(r, 50));
    const pmText = () => page.evaluate(() => (window as any).pmText());
    assert.equal(await pmText(), "alpha beta\ngamma");
    const host = "#pm > .ProseMirror";
    // ProseMirror's base keymap takes Escape (select the parent node): vim claims it first, in insert mode.
    await keys(host, "Escape");
    assert.equal((await state(host)).mode, "normal");
    await keys(host, "i", "Control+BracketLeft");
    assert.equal((await state(host)).mode, "normal");
    await keys(host, "d", "w");
    assert.equal(await pmText(), "beta\ngamma");
    await keys(host, "c", "w", "delta", "Control+BracketLeft");
    assert.equal(await pmText(), "delta\ngamma");
    await keys(host, "j", "o", "omega", "Control+BracketLeft");
    assert.equal(await pmText(), "delta\ngamma\nomega");
    await keys(host, "u");
    assert.equal(await pmText(), "delta\ngamma");
    await keys(host, "g", "g", "d", "d");
    assert.equal(await pmText(), "gamma");
  });

  test("a one-paragraph composer: lines are hard breaks, with no stray break at the end", { skip: pm ? false : "no T3 Code checkout for ProseMirror" }, async () => {
    const host = "#composer > .ProseMirror";
    await page.locator(host).click();
    await keys(host, "one", "Control+BracketLeft", "o", "two", "Control+BracketLeft");
    const doc = await page.evaluate(() => (window as any).composerDoc());
    const inline = doc.content[0].content.map((n: any) => n.type === "text" ? n.text : `<${n.type}>`);
    assert.deepEqual(inline, ["one", "<hard_break>", "two"]);
    await keys(host, "y", "y", "P");
    const again = await page.evaluate(() => (window as any).composerDoc());
    assert.deepEqual(again.content[0].content.map((n: any) => n.type === "text" ? n.text : `<${n.type}>`), ["one", "<hard_break>", "two", "<hard_break>", "two"]);
    await keys(host, "G", "y", "y", "p", "k", "y", "y", "p", "o", "x", "Control+BracketLeft");
    assert.equal(await page.evaluate(() => (window as any).composerSends), 0, "a put or o never sends: only the Enter key does");
  });

  test("a composer whose Enter sends: yy p and o make lines and never send", { skip: pm ? false : "no T3 Code checkout for ProseMirror" }, async () => {
    const host = "#rich > .ProseMirror";
    await page.locator(host).click();
    await keys(host, "Control+BracketLeft", "g", "g", "y", "y", "p");
    assert.equal(await page.evaluate(() => (window as any).richText()), "first\nfirst\nsecond");
    await keys(host, "G", "o", "third", "Control+BracketLeft", "y", "y", "P");
    assert.equal(await page.evaluate(() => (window as any).richText()), "first\nfirst\nsecond\nthird\nthird");
    assert.equal(await page.evaluate(() => (window as any).richSends), 0, "nothing was sent");
    await keys(host, "i", "Enter");
    assert.equal(await page.evaluate(() => (window as any).richSends), 1, "the Enter key still sends");
  });
});

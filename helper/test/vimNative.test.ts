// Pluto Vim for native apps (vimNative.ts) against a fake Exo: a text field
// that applies editVimField and arrow keys as a toolkit would, reports its
// state back, and types the keys the engine passes on, as Exo's replay does.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { vimBundle } from "../src/vimBundle.ts";
import { graphemesBetween, keySpec, NativeVim } from "../src/vimNative.ts";
import { RegisterStore } from "../src/vimRegisters.ts";

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "vim");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exo and a GTK entry, as far as the helper can tell. */
class FakeExo {
  listeners = new Set<(e: { method: string; params?: unknown; sessionId?: string }) => void>();
  sent: { method: string; params: any }[] = [];
  text: string;
  cursor: number;
  anchor: number;
  hold: { all: boolean; keys: { key: string; modifiers?: number }[] } = { all: false, keys: [] };
  answers = new Map<number, (consumed: boolean) => void>();
  nextKey = 1;
  history: [string, number][] = [];
  multiline: boolean;

  constructor(text: string, cursor: number, { multiline = true } = {}) {
    this.text = text;
    this.cursor = this.anchor = cursor;
    this.multiline = multiline;
  }

  addEventListener(l: any) { this.listeners.add(l); }
  removeEventListener(l: any) { this.listeners.delete(l); }
  emit(method: string, params: unknown) { for (const l of this.listeners) l({ method, params }); }

  report() {
    this.emit("Plutonium.vimFieldChanged", {
      field: { id: 1, windowId: 7, text: this.text, cursor: this.cursor, anchor: this.anchor, hint: this.multiline ? 0x200 : 0, purpose: 0, caret: [10, 20, 1, 16] },
    });
  }

  async send(method: string, params: any = {}) {
    this.sent.push({ method, params });
    if (method === "Plutonium.setVimHold") this.hold = { all: params.all, keys: params.keys };
    if (method === "Plutonium.answerVimKey") this.answers.get(params.keyId)?.(params.consumed);
    if (method === "Plutonium.editVimField") {
      this.history.push([this.text, this.cursor]);
      const from = this.cursor - params.before;
      const to = this.cursor + params.after;
      this.text = this.text.slice(0, from) + params.text + this.text.slice(to);
      this.cursor = this.anchor = from + params.text.length;
      setTimeout(() => this.report(), 1);
    }
    if (method === "Plutonium.dispatchWindowKeyEvents") {
      // As GTK does: each arrow press moves the cursor and is reported on its own, a moment apart.
      let delay = 0;
      // Ctrl+Z, as GTK: back a step, with no report of it.
      if (params.events.some((e: any) => e.type === "keyDown" && e.code === "KeyZ" && e.modifiers === 2)) {
        const step = this.history.pop();
        if (step) [this.text, this.cursor] = step;
        this.anchor = this.cursor;
        return {};
      }
      for (const e of params.events) {
        if (e.type !== "keyDown" || !/^Arrow/.test(e.code)) continue;
        delay += 2;
        setTimeout(() => {
          if (e.code === "ArrowLeft") this.cursor = Math.max(0, this.cursor - 1);
          if (e.code === "ArrowRight") this.cursor = Math.min(this.text.length, this.cursor + 1);
          if (!(e.modifiers & 8)) this.anchor = this.cursor;
          this.report();
        }, delay);
      }
      if (!delay) setTimeout(() => this.report(), 1);
    }
    return {};
  }

  /** A key pressed in the app: held for the engine if the field wants it, else typed. */
  async press(key: string, modifiers = 0) {
    const held = this.hold.all || this.hold.keys.some((k) => k.key === key && (k.modifiers ?? 0) === (modifiers & 3));
    if (!held || key === "Shift") return this.type(key);
    const id = this.nextKey++;
    const consumed = await new Promise<boolean>((resolve) => {
      this.answers.set(id, resolve);
      this.emit("Plutonium.vimKey", { id, fieldId: 1, key, code: "", modifiers, repeat: false });
    });
    if (!consumed) this.type(key);
  }

  type(key: string) {
    if (key.length !== 1) return;
    this.text = this.text.slice(0, this.cursor) + key + this.text.slice(this.cursor);
    this.cursor = this.anchor = this.cursor + 1;
    this.report();
  }

  async keys(...keys: string[]) {
    for (const k of keys) {
      if (k === "<Esc>") await this.press("Escape");
      else for (const c of k) await this.press(c);
      await sleep(5);
    }
    await sleep(40);
  }
}

async function setup(text: string, cursor: number, config = "null", options: { multiline?: boolean; registers?: RegisterStore } = {}) {
  const exo = new FakeExo(text, cursor, options);
  const shown: any[] = [];
  const native = new NativeVim(exo as any, { bundle: () => vimBundle(ENGINE), config: () => config, budget: 60, quiet: 10, registers: options.registers, showMode: (s) => shown.push(s) });
  await native.start();
  exo.report();
  await sleep(10);
  return { exo, native, shown };
}

describe("Pluto Vim in a native field", () => {
  test("insert mode holds only Escape and Ctrl+[; normal mode holds everything", async () => {
    const { exo, native } = await setup("hello world", 11);
    assert.equal(native.fields, 1);
    assert.equal(exo.hold.all, false);
    assert.deepEqual(exo.hold.keys.map((k) => k.key), ["Escape", "["]);
    await exo.keys("!", "<Esc>");
    assert.equal(exo.text, "hello world!", "typing goes to the app as it is");
    assert.equal(native.session(1)!.mode, "normal");
    assert.equal(exo.hold.all, true);
    assert.equal(exo.cursor, 11, "Escape steps back onto the last character, with an arrow");
  });

  test("operators edit with one delete and commit; motions are arrow presses, reported one by one", async () => {
    const { exo } = await setup("hello big world", 15);
    await exo.keys("<Esc>", "b", "dw");
    assert.equal(exo.text, "hello big ", "b's four presses aren't corrected while they arrive");
    await exo.keys("0", "w", "dw");
    assert.equal(exo.text, "hello ");
    const edits = exo.sent.filter((s) => s.method === "Plutonium.editVimField");
    assert.deepEqual(edits.map((e) => e.params), [{ fieldId: 1, before: 0, after: 5, text: "" }, { fieldId: 1, before: 0, after: 4, text: "" }]);
    await exo.keys("u");
    const undo = exo.sent.filter((s) => s.method === "Plutonium.dispatchWindowKeyEvents").at(-1)!.params.events;
    assert.deepEqual(undo.map((e: any) => `${e.type} ${e.code}`), ["keyDown ControlLeft", "keyDown KeyZ", "keyUp KeyZ", "keyUp ControlLeft"]);
  });

  test("cw then typing: the typed keys reach the app after the edit", async () => {
    const { exo, native } = await setup("one two", 7);
    await exo.keys("<Esc>", "0", "cw");
    assert.equal(native.session(1)!.mode, "insert");
    await exo.keys("uno");
    assert.equal(exo.text, "uno two");
  });

  test("insert mappings hold their first key; jk leaves insert mode", async () => {
    const { exo, native } = await setup("", 0, '(vim) => vim.keymap.set("i", "jk", "<Esc>")');
    assert.ok(exo.hold.keys.some((k) => k.key === "j"));
    await exo.keys("ajx");
    assert.equal(exo.text, "ajx", "j then x types both, in order");
    await exo.keys("jk");
    assert.equal(native.session(1)!.mode, "normal");
    assert.equal(exo.text, "ajx");
  });

  test("a field without the MULTILINE hint (GTK's text views): Escape is still vim's", async () => {
    const { exo, native } = await setup("abc", 3, "null", { multiline: false });
    await exo.keys("<Esc>");
    assert.equal(native.session(1)!.mode, "normal");
  });

  test("registers are the helper's store; the mode is shown outside insert mode", async () => {
    const registers = new RegisterStore();
    const { exo, shown } = await setup("word", 4, "null", { registers });
    await exo.keys("<Esc>", "0", "yw");
    assert.deepEqual(await registers.get('"', "global"), { text: "word", linewise: false });
    assert.deepEqual(shown.at(-1), { windowId: 7, mode: "normal", caret: [10, 20, 1, 16], line: null });
    await exo.keys("i");
    assert.equal(shown.at(-1).mode, null);
  });
});

describe("the : line, macros and marks in a native field", () => {
  test(":s edits, the line is shown as it's typed, a macro replays, and uppercase marks go to the helper", async () => {
    const marks: [number, string, number][] = [];
    const jumps: string[] = [];
    const exo = new FakeExo("a a", 3);
    const shown: any[] = [];
    const native = new NativeVim(exo as any, {
      bundle: () => vimBundle(ENGINE), config: () => "null", budget: 60, quiet: 10,
      showMode: (s) => shown.push(s), onMarkSet: (w, n, o) => marks.push([w, n, o]), onMarkJump: (n) => jumps.push(n),
    });
    await native.start();
    exo.report();
    await sleep(10);
    await exo.keys("<Esc>", ":s/a/b/g");
    assert.equal(shown.at(-1).line, ":s/a/b/g");
    await exo.press("Enter");
    await sleep(60);
    assert.equal(exo.text, "b b");
    assert.equal(shown.at(-1).line, null);
    await exo.keys("0qqA!", "<Esc>", "q", "@q");
    assert.equal(exo.text, "b b!!", "the typed ! was recorded, and replayed");
    await exo.keys("0mA", "`B");
    assert.deepEqual(marks, [[7, "A", 0]]);
    assert.deepEqual(jumps, ["B"]);
  });
});

describe("a field that comes back", () => {
  test("focus left the window and returned (a new field): it's in the mode it was; a mark jump lands in normal mode", async () => {
    const { exo, native } = await setup("abc", 3);
    await exo.keys("<Esc>");
    assert.equal(native.session(1)!.mode, "normal");
    exo.emit("Plutonium.vimFieldGone", { id: 1 });
    exo.emit("Plutonium.vimFieldChanged", { field: { id: 2, windowId: 7, text: "abc", cursor: 2, anchor: 2, hint: 0, purpose: 0 } });
    assert.equal(native.session(2)!.mode, "normal");
    native.jumpInWindow(9, 1);
    exo.emit("Plutonium.vimFieldChanged", { field: { id: 3, windowId: 9, text: "xyz", cursor: 3, anchor: 3, hint: 0, purpose: 0 } });
    assert.equal(native.session(3)!.mode, "normal");
  });
});

describe("an app that reports nothing after its undo (GTK)", () => {
  test("u then yy p: the helper asks the app where it is before going on", async () => {
    const { exo } = await setup("one two", 7);
    await exo.keys("<Esc>", "0", "dw");
    assert.equal(exo.text, "two");
    await exo.keys("u");
    assert.equal(exo.text, "one two");
    await exo.keys("yyp");
    assert.equal(exo.text, "one two\none two");
  });
});

describe("helpers", () => {
  test("keys in vim's notation become what Exo matches", () => {
    assert.deepEqual(keySpec("j"), { key: "j" });
    assert.deepEqual(keySpec("<C-w>"), { key: "w", modifiers: 2 });
    assert.deepEqual(keySpec("<Esc>"), { key: "Escape" });
    assert.deepEqual(keySpec("<A-CR>"), { key: "Enter", modifiers: 1 });
  });

  test("arrow presses count graphemes", () => {
    assert.equal(graphemesBetween("a👍🏽b", 0, 5), 2);
    assert.equal(graphemesBetween("abc", 3, 0), 3);
  });
});

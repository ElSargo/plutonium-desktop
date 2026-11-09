// Pluto Vim over AT-SPI (vimAtspi.ts): an AtspiBuffer against a fake element
// that counts in characters, as AT-SPI does, driven through NativeVim's key
// path as Exo's window fields are.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { AtspiBuffer, fromChars, toChars, type AtspiField } from "../src/vimAtspi.ts";
import { vimBundle } from "../src/vimBundle.ts";
import { NativeVim } from "../src/vimNative.ts";

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "vim");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A text element as AT-SPI sees it: offsets in characters. */
class FakeElement implements AtspiField {
  chars: string[];
  caret: number;
  selection: [number, number] | null = null;
  calls: string[] = [];
  constructor(text: string, caret: number) {
    this.chars = [...text];
    this.caret = caret;
  }
  get text() { return this.chars.join(""); }
  async read() { return { text: this.text, caret: this.caret, selection: this.selection }; }
  async setCaret(offset: number) { this.calls.push(`caret ${offset}`); this.caret = offset; this.selection = null; }
  async select(start: number, end: number) { this.calls.push(`select ${start} ${end}`); this.selection = [start, end]; }
  async deleteText(start: number, end: number) { this.calls.push(`delete ${start} ${end}`); this.chars.splice(start, end - start); }
  async insertText(at: number, text: string) { this.calls.push(`insert ${at} ${text}`); this.chars.splice(at, 0, ...text); }
}

function setup(text: string, caret: number) {
  const listeners = new Set<(e: any) => void>();
  const answers = new Map<number, boolean>();
  const keys: string[] = [];
  const cdp = {
    addEventListener: (l: any) => listeners.add(l),
    removeEventListener: (l: any) => listeners.delete(l),
    send: async (method: string, params: any = {}) => {
      if (method === "Plutonium.answerVimKey") answers.set(params.keyId, params.consumed);
      if (method === "Plutonium.dispatchWindowKeyEvents") keys.push(...params.events.filter((e: any) => e.type === "keyDown").map((e: any) => e.code));
      return {};
    },
  };
  const native = new NativeVim(cdp as any, { bundle: () => vimBundle(ENGINE), config: () => "null" });
  const element = new FakeElement(text, caret);
  let next = 1;
  /** A key held for the window field, as Exo's vimKey; resolves to the answer. */
  /** Caps Lock is an Escape whose code says so (Ash's), and leaves insert mode; the Escape key is the app's. */
  const press = async (key: string) => {
    const id = next++;
    const caps = key === "CapsLock";
    for (const l of listeners) l({ method: "Plutonium.vimKey", params: { id, fieldId: 5, key: caps ? "Escape" : key, code: caps ? "CapsLock" : "", modifiers: 0, repeat: false } });
    for (let k = 0; k < 100 && !answers.has(id); k++) await sleep(2);
    await sleep(10);
    const consumed = answers.get(id);
    // A key the engine left goes to the app, which types it.
    if (consumed === false && key.length === 1) {
      element.chars.splice(element.caret, 0, key);
      element.caret++;
    }
    return consumed;
  };
  return { native, element, press, keys };
}

describe("Pluto Vim over AT-SPI", () => {
  test("character offsets and UTF-16 offsets", () => {
    assert.equal(toChars("a👍b", 3), 2);
    assert.equal(fromChars("a👍b", 2), 3);
  });

  test("motions are exact, edits are delete and insert, typing goes to the app, Ctrl+Z is undo", async () => {
    const { native, element, press, keys } = setup("hello big world", 15);
    await native.start();
    native.setDesktopMode("insert");
    const host = (native as any).host;
    const buffer = new AtspiBuffer(element, host, { fieldId: 5, windowId: 3 });
    await buffer.refresh();
    native.addField(5, buffer);
    assert.equal(await press("x"), false, "insert mode: the app's");
    assert.equal(element.text, "hello big worldx");
    await press("CapsLock");
    for (const k of "bdw") await press(k);
    assert.equal(element.text, "hello big ");
    assert.ok(element.calls.includes("delete 10 16"), element.calls.join(", "));
    for (const k of "0cw") await press(k);
    await press("h");
    await press("i");
    await press("CapsLock");
    assert.equal(element.text, "hi big ");
    await press("u");
    assert.deepEqual(keys.slice(-2), ["ControlLeft", "KeyZ"]);
  });

  test("the element is read again before a key: the app's own changes count", async () => {
    const { native, element, press } = setup("abc", 0);
    await native.start();
    const buffer = new AtspiBuffer(element, (native as any).host, { fieldId: 5, windowId: 3 });
    await buffer.refresh();
    native.addField(5, buffer);
    await press("CapsLock");
    element.chars = [..."xyz abc"];
    element.caret = 4;
    await press("x");
    assert.equal(element.text, "xyz bc");
  });
});

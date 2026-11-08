// Pluto Vim's register store (vimRegisters.ts): in memory, by scope, with
// "+ as the system clipboard. The pages' side is in vimConfig.test.ts (a real
// browser) and vim.test.ts (RemoteStore).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { fromClipboard, MAX_TEXT, RegisterStore, wlClipboard, type Clipboard } from "../src/vimRegisters.ts";

describe("the register store", () => {
  test("a scope picks the copy: the field's thread, its project, or global when it has neither", async () => {
    const store = new RegisterStore();
    const one = { thread: "one", project: "p" };
    const two = { thread: "two", project: "p" };
    await store.set("a", { text: "global", linewise: false }, "global", one);
    await store.set("t", { text: "mine", linewise: false }, "thread", one);
    await store.set("p", { text: "ours", linewise: true }, "project", one);
    assert.deepEqual(await store.get("a", "global", two), { text: "global", linewise: false });
    assert.equal(await store.get("t", "thread", two), null, "another thread's \"t");
    assert.deepEqual(await store.get("t", "thread", one), { text: "mine", linewise: false });
    assert.deepEqual(await store.get("p", "project", two), { text: "ours", linewise: true }, "the same project");
    // No thread: global.
    await store.set("t", { text: "nowhere", linewise: false }, "thread", {});
    assert.deepEqual(await store.get("t", "global"), { text: "nowhere", linewise: false });
  });

  test("names and values are checked; a huge yank is cut", async () => {
    const store = new RegisterStore();
    await assert.rejects(store.set("A", { text: "x" }, "global"), /not a register/);
    await assert.rejects(store.get("%", "global"), /not a register/);
    await assert.rejects(store.set("a", "x", "global"), /text, linewise/);
    await store.set("a", { text: "x".repeat(MAX_TEXT + 10), linewise: 1 }, "global");
    const value = await store.get("a", "global");
    assert.equal(value!.text.length, MAX_TEXT);
    assert.equal(value!.linewise, true);
  });

  test("\"+ is the clipboard, always global; a trailing newline is linewise both ways", async () => {
    let copied = "";
    const clipboard: Clipboard = { read: async () => copied || null, write: async (text) => void (copied = text) };
    const store = new RegisterStore({ clipboard });
    await store.set("+", { text: "a\nb", linewise: true }, "thread", { thread: "one" });
    assert.equal(copied, "a\nb\n");
    copied = "from an app";
    assert.deepEqual(await store.get("+", "thread", { thread: "two" }), { text: "from an app", linewise: false });
    copied = "";
    assert.deepEqual(await store.get("+", "global"), { text: "a\nb", linewise: true }, "an empty clipboard: what was set last");
    assert.deepEqual(fromClipboard("x\n"), { text: "x", linewise: true });
  });

  test("\"* is the primary selection, apart from the clipboard, and always global", async () => {
    const copied: Record<string, string> = { clipboard: "", primary: "" };
    const clipboard: Clipboard = {
      read: async (primary) => copied[primary ? "primary" : "clipboard"] || null,
      write: async (text, primary) => void (copied[primary ? "primary" : "clipboard"] = text),
    };
    const store = new RegisterStore({ clipboard });
    await store.set("*", { text: "selected", linewise: false }, "thread", { thread: "one" });
    assert.deepEqual(copied, { clipboard: "", primary: "selected" });
    copied.primary = "picked in an app";
    assert.deepEqual(await store.get("*", "thread", { thread: "two" }), { text: "picked in an app", linewise: false });
  });

  test("without wl-clipboard there's no clipboard", () => {
    assert.equal(wlClipboard("wayland-0", () => undefined), null);
    assert.ok(wlClipboard("wayland-0", (name) => `/bin/${name}`));
  });
});

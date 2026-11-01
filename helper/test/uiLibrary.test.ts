import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { uiLibraryFile } from "../src/uiLibrary.ts";
// @ts-ignore: the browser's library, plain JavaScript.
import * as keys from "../web/ui/keys.js";
// @ts-ignore
import * as settings from "../web/ui/settings.js";
// @ts-ignore
import * as drag from "../web/ui/drag.js";

describe("serving the UI library", () => {
  test("its files, by type; nothing outside it, no dot files", () => {
    const root = mkdtempSync(join(tmpdir(), "ui-"));
    mkdirSync(join(root, "dock"));
    writeFileSync(join(root, "dock", "core.js"), "export {};");
    writeFileSync(join(root, ".secret.js"), "x");
    writeFileSync(join(root, "notes.txt"), "x");
    writeFileSync(join(tmpdir(), "outside.js"), "x");
    symlinkSync(join(tmpdir(), "outside.js"), join(root, "link.js"));
    assert.equal(uiLibraryFile(root, "dock/core.js")?.contentType, "text/javascript");
    assert.equal(uiLibraryFile(root, "dock%2Fcore.js")?.contentType, "text/javascript");
    assert.equal(uiLibraryFile(root, ".secret.js"), null);
    assert.equal(uiLibraryFile(root, "notes.txt"), null);
    assert.equal(uiLibraryFile(root, "../outside.js"), null);
    assert.equal(uiLibraryFile(root, "dock/../../outside.js"), null);
    assert.equal(uiLibraryFile(root, "link.js"), null);
    assert.equal(uiLibraryFile(root, "missing.js"), null);
    assert.equal(uiLibraryFile(root, "%E0%A4%A.js"), null);
  });

  test("the shipped library's modules load", async () => {
    for (const file of ["keys.js", "settings.js", "drag.js", "widgets.js", "dock/core.js", "dock/dock.js"]) {
      await import(`../web/ui/${file}`);
    }
  });
});

describe("keys", () => {
  const press = (code: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "repeat", boolean>> = {}) => {
    let prevented = false;
    return {
      code, key: code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, ...mods,
      preventDefault: () => (prevented = true), stopPropagation: () => {}, get prevented() { return prevented; },
    };
  };

  test("combos are written in one order and read nicely", () => {
    assert.equal(keys.normalizeCombo("Shift+Super+KeyR"), "Super+Shift+KeyR");
    assert.equal(keys.comboOf(press("Digit1", { metaKey: true, shiftKey: true })), "Super+Shift+Digit1");
    assert.equal(keys.prettyCombo("Super+Shift+Digit1"), "Super + Shift + 1");
    assert.deepEqual(keys.withTopRow("Alt+F2"), ["Alt+F2", "Alt+BrowserForward"]);
    assert.equal(keys.recordedCombo(press("Escape")), null);
    assert.equal(keys.recordedCombo(press("Backspace")), "");
    assert.equal(keys.recordedCombo(press("ShiftLeft", { shiftKey: true })), undefined);
  });

  test("a keymap runs actions, takes the user's keys, moves a combo that clashes", () => {
    const ran: string[] = [];
    let kept: Record<string, string[]> | null = null;
    const keymap = new keys.Keymap({ overrides: { b: ["Super+KeyX"] }, onOverrides: (o: Record<string, string[]>) => (kept = o) });
    keymap.define("a", { label: "A", keys: ["Shift+Super+KeyA"], run: () => ran.push("a"), repeat: false });
    keymap.define("b", { label: "B", keys: ["Super+KeyB"], run: () => ran.push("b") });
    keymap.define("run", { label: "Run", keys: ["Alt+F2"], run: () => ran.push("run") });
    assert.equal(keymap.handle(press("KeyA", { metaKey: true, shiftKey: true }))?.id, "a");
    assert.equal(keymap.handle(press("KeyA", { metaKey: true, shiftKey: true, repeat: true }))?.id, "a");
    assert.equal(keymap.handle(press("KeyB", { metaKey: true })), null);
    keymap.handle(press("KeyX", { metaKey: true }));
    keymap.handle(press("BrowserForward", { altKey: true }));
    assert.deepEqual(ran, ["a", "b", "run"]);
    const clash = keymap.assign("a", "Super+KeyX");
    assert.equal(clash.id, "b");
    assert.deepEqual(keymap.keysOf("b"), []);
    assert.deepEqual(kept, { b: [], a: ["Super+KeyX"] });
    assert.ok(keymap.combos().includes("Super+KeyX"));
    keymap.resetAll();
    assert.deepEqual(keymap.keysOf("b"), ["Super+KeyB"]);
    keymap.undefine("r*");
    assert.equal(keymap.get("run"), null);
  });
});

describe("settings", () => {
  test("defaults, what's kept, only changes saved, a change event", async () => {
    const kept = new Map<string, unknown>([["prefs", { size: 32, gone: true }]]);
    const store = { get: async (key: string) => kept.get(key), set: (key: string, value: unknown) => kept.set(key, value) };
    const prefs = new settings.Settings({ store, defaults: { size: 24, shown: true } });
    await prefs.load();
    assert.equal(prefs.get("size"), 32);
    assert.equal(prefs.get("shown"), true);
    const seen: unknown[] = [];
    prefs.subscribe((key: string, value: unknown) => seen.push([key, value]));
    prefs.set("shown", false);
    prefs.set("shown", false);
    prefs.reset("size");
    assert.deepEqual(seen, [["shown", false], ["size", 24]]);
    assert.deepEqual(kept.get("prefs"), { shown: false, gone: true });
  });

  test("the shell's store, else localStorage", async () => {
    const local = new Map<string, string>();
    const localStorage = { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => local.set(k, v) };
    const store = settings.shellStore(null, "niri.", localStorage);
    store.set("dock", { a: 1 });
    assert.deepEqual(await store.get("dock"), { a: 1 });
    assert.equal(local.get("niri.dock"), '{"a":1}');
  });
});

describe("drag geometry", () => {
  test("the nearest edge, as niri resizes from", () => {
    const rect = { left: 0, top: 0, width: 300, height: 300 };
    assert.equal(drag.nearestEdge(rect, 10, 10), "top-left");
    assert.equal(drag.nearestEdge(rect, 290, 150), "right");
    assert.equal(drag.nearestEdge(rect, 150, 290), "bottom");
    assert.equal(drag.nearestEdge(rect, 140, 150), "left");
  });

  test("resizing keeps the opposite edge, within limits", () => {
    const start = { x: 100, y: 100, w: 200, h: 200 };
    assert.deepEqual(drag.resizeRect(start, "bottom-right", 50, -20), { x: 100, y: 100, w: 250, h: 180 });
    assert.deepEqual(drag.resizeRect(start, "top-left", 50, 50), { x: 150, y: 150, w: 150, h: 150 });
    assert.deepEqual(drag.resizeRect(start, "left", 190, 0, { min: { w: 60, h: 60 } }), { x: 240, y: 100, w: 60, h: 200 });
    assert.equal(drag.edgeCode("top-right"), "ne");
  });

  test("edge scrolling, insertion points, double clicks", () => {
    assert.equal(drag.edgeVelocity(500, 1000, 30), 0);
    assert.equal(drag.edgeVelocity(0, 1000, 30), -1);
    assert.equal(drag.edgeVelocity(985, 1000, 30), 0.5);
    const rects = [0, 40, 80].map((left) => ({ left, top: 0, width: 40, height: 40 }));
    assert.equal(drag.insertIndex(rects, 10), 0);
    assert.equal(drag.insertIndex(rects, 50), 1);
    assert.equal(drag.insertIndex(rects, 500), 3);
    const clicks = drag.doubleClick(400);
    assert.equal(clicks.hit(1000), false);
    assert.equal(clicks.hit(1300), true);
    assert.equal(clicks.hit(1400), false);
  });
});

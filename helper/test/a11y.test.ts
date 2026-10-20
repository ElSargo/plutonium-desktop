import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { A11yError, Accessibility, type A11yWindow } from "../src/a11y.ts";
import { FakeBus, STATE, type FakeNode } from "./fixtures/fakeBus.ts";

const SHOWN = [STATE.showing, STATE.enabled, STATE.sensitive];

function editor(): { frame: FakeNode; save: FakeNode; field: FakeNode; zoom: FakeNode; check: FakeNode; menu: FakeNode } {
  const save: FakeNode = { role: "push button", name: "Save", states: SHOWN, extents: [10, 20, 80, 30], actions: ["click"] };
  const field: FakeNode = {
    role: "text",
    name: "Name",
    states: [...SHOWN, STATE.editable, STATE.focused],
    extents: [10, 60, 200, 30],
    text: "draft",
    editable: true,
  };
  const zoom: FakeNode = { role: "slider", name: "Zoom", states: SHOWN, value: { current: 1, min: 0, max: 4 } };
  const check: FakeNode = { role: "check box", name: "Wrap", states: [...SHOWN, STATE.checkable], extents: [0, 0, 20, 20] };
  const menu: FakeNode = { role: "menu item", name: "Recent", states: SHOWN, actions: ["click", "expand"] };
  const hidden: FakeNode = { role: "label", name: "Hidden", states: [] };
  const frame: FakeNode = {
    role: "frame",
    name: "Editor",
    states: [...SHOWN, STATE.active],
    extents: [0, 0, 400, 300],
    children: [
      // An unnamed panel: left out, its children moved up.
      { role: "panel", states: SHOWN, children: [save, field] },
      zoom,
      check,
      menu,
      hidden,
      { role: "separator", states: SHOWN },
    ],
  };
  return { frame, save, field, zoom, check, menu };
}

describe("Accessibility", () => {
  let bus: FakeBus;
  let elements: ReturnType<typeof editor>;
  const previous = process.env.DBUS_SESSION_BUS_ADDRESS;
  const window: A11yWindow = { id: 7, pid: 4242, title: "Editor", width: 400, height: 300, deviceScaleFactor: 2 };

  before(async () => {
    bus = await FakeBus.start();
    elements = editor();
    bus.addApp(4242, [elements.frame, { role: "frame", name: "Preferences", states: SHOWN }]);
    // Another process's window, for the by-title fallback.
    bus.addApp(5000, [{ role: "frame", name: "Through Xwayland", states: SHOWN, children: [elements.check] }]);
    bus.addApp(6000, []);
    process.env.DBUS_SESSION_BUS_ADDRESS = bus.address;
  });
  after(async () => {
    process.env.DBUS_SESSION_BUS_ADDRESS = previous;
    await bus.stop();
  });

  test("reads a window as an outline with refs", async () => {
    const a11y = new Accessibility();
    const outline = await a11y.read(window);
    const lines = outline.split("\n");
    assert.match(lines[0]!, /^- frame "Editor" \[ref=a1\]/);
    // Centers in snapshot pixels (scale 2).
    assert.ok(lines.some((line) => /^ {2}- push button "Save" \[ref=a\d+\] @100,70$/.test(line)), outline);
    assert.ok(lines.some((line) => /- text "Name" \[ref=a\d+\] \(focused, editable\) @220,150: "draft"/.test(line)), outline);
    assert.ok(lines.some((line) => /- slider "Zoom" \[ref=a\d+\] value=1 \(0–4\)/.test(line)), outline);
    assert.ok(lines.some((line) => /- check box "Wrap" \[ref=a\d+\] \(unchecked\)/.test(line)), outline);
    assert.ok(lines.some((line) => /- menu item "Recent" \[ref=a\d+\] actions: expand$/.test(line)), outline);
    assert.ok(!outline.includes("panel"), "unnamed panels are left out");
    assert.ok(!outline.includes("separator"));
    assert.ok(!outline.includes("Hidden"), "hidden elements are left out");
    assert.ok((await a11y.read(window, { all: true })).includes("Hidden"));
  });

  test("refs stay the same across reads and act on their element", async () => {
    const a11y = new Accessibility();
    const first = await a11y.read(window);
    const refOf = (name: string, outline = first) => outline.match(new RegExp(`"${name}" \\[ref=(a\\d+)\\]`))?.[1];
    const second = await a11y.read(window);
    assert.equal(refOf("Save", second), refOf("Save"));

    assert.deepEqual(await a11y.act(window, refOf("Save")!, "click", {}), { done: "click" });
    assert.deepEqual(elements.save.log, ["DoAction click"]);

    assert.deepEqual(await a11y.act(window, refOf("Name")!, "set_text", { text: "final" }), { done: "set the text" });
    assert.equal(elements.field.text, "final");

    await a11y.act(window, refOf("Zoom")!, "set_value", { value: 3 });
    assert.equal(elements.zoom.value?.current, 3);

    await a11y.act(window, refOf("Recent")!, "expand", {});
    assert.deepEqual(elements.menu.log, ["DoAction expand"]);
    await assert.rejects(a11y.act(window, refOf("Recent")!, "fly", {}), /Its actions: click, expand/);

    // No action of its own: a point to click instead.
    assert.deepEqual(await a11y.act(window, refOf("Wrap")!, "click", {}), { click: [20, 20] });

    // A part of the window, by ref.
    const part = await a11y.read(window, { ref: refOf("Save")! });
    assert.match(part, /^- push button "Save"/);
    assert.equal(part.split("\n").length, 1);
  });

  test("unknown refs and windows say what to do", async () => {
    const a11y = new Accessibility();
    await assert.rejects(a11y.act(window, "a99", "click", {}), (error: unknown) => {
      return error instanceof A11yError && /read_window gives the refs/.test(error.message);
    });
    // The app is there but has no windows.
    await assert.rejects(a11y.read({ ...window, pid: 6000, title: "Nope" }), /none of its windows is this one/);
    // Not on the bus at all.
    await assert.rejects(a11y.read({ ...window, pid: 1, title: "Gone" }), /isn't on the accessibility bus/);
  });

  test("an app's window whose title doesn't match: the one its size does", async () => {
    const a11y = new Accessibility();
    assert.match(await a11y.read({ ...window, title: "Editor — renamed" }), /^- frame "Editor"/);
  });

  test("finds another process's window by its title", async () => {
    const a11y = new Accessibility();
    const outline = await a11y.read({ ...window, pid: 9999, title: "Through Xwayland" });
    assert.match(outline, /^- frame "Through Xwayland"/);
  });

  test("forgets the refs of windows that are gone", async () => {
    const a11y = new Accessibility();
    const outline = await a11y.read(window);
    const ref = outline.match(/"Save" \[ref=(a\d+)\]/)![1]!;
    a11y.prune(new Set());
    await assert.rejects(a11y.act(window, ref, "click", {}), /No element/);
  });

  test("without a session bus, says so", async () => {
    const saved = process.env.DBUS_SESSION_BUS_ADDRESS;
    delete process.env.DBUS_SESSION_BUS_ADDRESS;
    try {
      await assert.rejects(new Accessibility().read(window), /No session bus/);
    } finally {
      process.env.DBUS_SESSION_BUS_ADDRESS = saved;
    }
  });
});

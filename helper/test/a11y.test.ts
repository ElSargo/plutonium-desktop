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
    // A Flatpak app: on the bus through its sandbox's proxy (pid 8100), its
    // windows from pid 8200; one of them untitled.
    bus.addApp(8100, [
      { role: "frame", name: "Recovery", states: SHOWN, extents: [0, 0, 600, 400] },
      { role: "dialog", name: "", states: [...SHOWN, STATE.active], extents: [0, 0, 520, 160], children: [elements.zoom] },
    ]);
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

  test("select: through the list's Selection, else its table's row, else a pointer click", async () => {
    const tabs: FakeNode = {
      role: "page tab list",
      states: SHOWN,
      selection: {},
      children: [
        { role: "page tab", name: "One", states: SHOWN, extents: [0, 0, 50, 20] },
        { role: "page tab", name: "Two", states: SHOWN, extents: [50, 0, 50, 20] },
      ],
    };
    // A GTK 3 list of two columns: it refuses SelectChild; its cells' first action expands.
    const cell = (name: string, y: number): FakeNode => ({
      role: "table cell",
      name,
      states: SHOWN,
      extents: [20, y, 80, 20],
      actions: ["Expand or contract", "Edit"],
    });
    const list: FakeNode = {
      role: "table",
      states: SHOWN,
      selection: { refuses: true },
      columns: 2,
      children: [cell("", 0), cell("Column", 0), cell("", 20), cell("Line", 20)],
    };
    const loose: FakeNode = { role: "list", states: SHOWN, selection: { refuses: true }, children: [cell("Loose", 40)] };
    bus.addApp(8300, [{ role: "frame", name: "Chart Type", states: SHOWN, extents: [0, 0, 300, 200], children: [tabs, list, loose] }]);
    const chart = { ...window, id: 9, pid: 8300, title: "Chart Type", width: 300, height: 200, deviceScaleFactor: 1 };
    const a11y = new Accessibility();
    const outline = await a11y.read(chart);
    const refOf = (name: string) => outline.match(new RegExp(`"${name}" \\[ref=(a\\d+)\\]`))![1]!;

    assert.deepEqual(await a11y.act(chart, refOf("Two"), "select", {}), { done: "select it" });
    assert.deepEqual(tabs.log, ["SelectChild 1"]);

    assert.deepEqual(await a11y.act(chart, refOf("Line"), "select", {}), { done: "select its row" });
    assert.deepEqual(list.log, ["SelectChild 3", "AddRowSelection 1"]);

    // No row to select: a pointer click at its center, never "Expand or contract".
    const result = await a11y.act(chart, refOf("Loose"), "select", {});
    assert.deepEqual(result, { click: [60, 50], why: "the app didn't select it through accessibility" });
    assert.equal(loose.children![0]!.log, undefined);
  });

  test("a ref whose element the app replaced: says it's gone", async () => {
    const status: FakeNode = { role: "status bar", name: "Status", states: SHOWN, extents: [0, 280, 400, 20] };
    bus.addApp(8400, [{ role: "frame", name: "Sheet", states: SHOWN, extents: [0, 0, 400, 300], children: [status] }]);
    const sheet = { ...window, id: 10, pid: 8400, title: "Sheet" };
    const a11y = new Accessibility();
    const ref = (await a11y.read(sheet)).match(/"Status" \[ref=(a\d+)\]/)![1]!;
    status.states = [STATE.defunct];
    await assert.rejects(a11y.read(sheet, { ref }), new RegExp(`${ref} is gone: .*read_window the window again`));
    await assert.rejects(a11y.act(sheet, ref, "click", {}), new RegExp(`${ref} is gone`));
  });

  test("a frame with its window's shadow: found by size, points without the shadow", async () => {
    // A 200×100 window whose frame is 20 bigger each way: a 10 px shadow around it.
    const ok: FakeNode = { role: "push button", name: "OK", states: SHOWN, extents: [110, 70, 40, 20], actions: ["click"] };
    bus.addApp(8500, [
      { role: "frame", name: "Main", states: [...SHOWN, STATE.active], extents: [0, 0, 800, 600] },
      { role: "alert", name: "", states: SHOWN, extents: [0, 0, 220, 120], children: [ok] },
    ]);
    const box = { ...window, id: 11, pid: 8500, title: "", width: 200, height: 100, deviceScaleFactor: 2 };
    const outline = await new Accessibility().read(box);
    assert.match(outline, /^- alert \[ref=a1\] @200,100/);
    assert.match(outline, /- push button "OK" \[ref=a\d+\] @240,140/);
  });

  test("unknown refs and windows say what to do", async () => {
    const a11y = new Accessibility();
    await assert.rejects(a11y.act(window, "a99", "click", {}), (error: unknown) => {
      return error instanceof A11yError && /read_window gives the refs/.test(error.message);
    });
    // The app is there but has no windows.
    await assert.rejects(a11y.read({ ...window, pid: 6000, title: "Nope" }), /this window isn't among its windows there/);
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

  test("finds a sandboxed app's untitled window through its sandbox's proxy", async () => {
    const sandboxOf = (pid: number) => (pid === 8100 || pid === 8200 ? "instance-1" : undefined);
    const outline = await new Accessibility({ sandboxOf }).read({ ...window, pid: 8200, title: "", width: 520, height: 160 });
    assert.match(outline, /^- dialog \[ref=a1\]/);
    assert.match(outline, /slider "Zoom"/);
    // Without the sandbox, nothing to match an untitled window by.
    await assert.rejects(
      new Accessibility({ sandboxOf: () => undefined }).read({ ...window, pid: 8200, title: "", width: 520, height: 160 }),
      /isn't on the accessibility bus/,
    );
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

describe("Accessibility on a spreadsheet and on apps that don't answer", () => {
  let bus: FakeBus;
  let calc: string;
  const previous = process.env.DBUS_SESSION_BUS_ADDRESS;
  const sheet: A11yWindow = { id: 8, pid: 7000, title: "Untitled 1 - LibreOffice Calc", width: 1000, height: 700, deviceScaleFactor: 1 };
  const columnName = (column: number) => String.fromCharCode(65 + column);
  // The formula bar's input line after the sheet changed: defunct.
  const inputLine: FakeNode = { role: "paragraph", name: "Input line", states: [STATE.defunct] };
  const table: FakeNode = {
    role: "table",
    name: "Sheet1",
    states: SHOWN,
    extents: [36, 168, 800, 400],
    table: {
      rows: 1_048_576,
      columns: 16_384,
      cellSize: [80, 20],
      cell: (row, column) => ({
        role: "table cell",
        name: `${columnName(column)}${row + 1}`,
        states: row === 0 && column === 0 ? [...SHOWN, STATE.focused] : SHOWN,
        extents: [36 + column * 80, 168 + row * 20, 80, 20],
        text: row === 1 && column === 1 ? "0.8413" : "",
      }),
    },
  };

  before(async () => {
    bus = await FakeBus.start();
    calc = bus.addApp(7000, [
      { role: "frame", name: sheet.title, states: SHOWN, extents: [0, 0, 1000, 700], children: [
        { role: "push button", name: "Bold", states: SHOWN, actions: ["press"] },
        inputLine,
        table,
      ] },
    ]);
    bus.addApp(7100, [
      { role: "frame", name: "Busy", states: SHOWN, children: [
        { role: "push button", name: "OK", states: SHOWN },
        { role: "panel", name: "Stuck", states: SHOWN, hangs: true },
      ] },
    ]);
    bus.addApp(7200, [{ role: "frame", name: "Frozen", states: SHOWN, hangs: true }]);
    process.env.DBUS_SESSION_BUS_ADDRESS = bus.address;
  });
  after(async () => {
    process.env.DBUS_SESSION_BUS_ADDRESS = previous;
    await bus.stop();
  });

  test("reads a spreadsheet's visible cells, never its Locale, nothing of what's defunct", async () => {
    bus.calls.length = 0;
    const outline = await new Accessibility().read(sheet);
    assert.match(outline, /- push button "Bold"/);
    // 10 columns × 20 rows are visible.
    assert.match(outline, /- \(1048576 rows × 16384 columns; read the visible cells, A1 to J20: the empty ones left out\./);
    assert.match(outline, /- table cell "B2" \[ref=a\d+\] @156,198: "0.8413"/);
    assert.match(outline, /- table cell "A1" \[ref=a\d+\] \(focused\)/);
    assert.ok(!outline.includes('"C3"'), "empty cells are left out");
    assert.ok(!outline.includes("Input line"));
    const accessibleGetAll = bus.calls.filter((call) => call.member === "GetAll" && call.body?.[0] === "org.a11y.atspi.Accessible");
    assert.equal(accessibleGetAll.length, 0, "GetAll(Accessible) includes Locale, which aborts Calc");
    assert.ok(!bus.calls.some((call) => call.body?.[1] === "Locale"));
    // The frame is /1, then Bold, the input line and the table.
    const on = (path: string) => bus.calls.filter((call) => call.destination === calc && call.path === `/org/a11y/atspi/accessible/${path}`);
    assert.deepEqual([...new Set(on("3").map((call) => call.member))], ["GetState"], "a defunct object is asked nothing else");
    assert.ok(!on("4").some((call) => call.member === "GetChildren"), "no GetChildren on the table");
    assert.ok(bus.calls.length < 3000, `${bus.calls.length} calls`);
  });

  test("an app that stops answering: what was read, and that it's still running", async () => {
    const started = Date.now();
    const outline = await new Accessibility({ callTimeoutMs: 200 }).read({ ...sheet, pid: 7100, title: "Busy" });
    assert.ok(Date.now() - started < 2000, "one stuck call doesn't hold the read");
    assert.match(outline, /^- frame "Busy"/);
    assert.match(outline, /- push button "OK"/);
    assert.match(outline, /The app didn't answer \(org\.a11y\.atspi\.Accessible\.GetState: no reply in 0\.2 s\) after \d+ elements\. It's still running but busy or hung/);
  });

  test("an app whose window doesn't answer at all, running or gone", async () => {
    const a11y = new Accessibility({ callTimeoutMs: 200 });
    const frozen = { ...sheet, pid: 7200, title: "Frozen" };
    await assert.rejects(a11y.read(frozen), (error: unknown) => {
      return error instanceof A11yError && /didn't answer .*It's still running/.test(error.message);
    });
    // Gone while being read, as Calc was when it aborted.
    bus.addApp(7300, [{ role: "frame", name: "Crashing", states: SHOWN, children: [{ role: "panel", crashes: true }] }]);
    const outline = await a11y.read({ ...sheet, pid: 7300, title: "Crashing" });
    assert.match(outline, /^- frame "Crashing"/);
    assert.match(outline, /didn't answer .*, and it's gone: it quit or crashed\./);
  });
});

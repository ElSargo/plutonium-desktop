import assert from "node:assert/strict";
import { describe, test } from "node:test";

// @ts-ignore: the browser's library, plain JavaScript.
import * as core from "../web/ui/dock/core.js";

type Win = { id: number; appId: string; title?: string; pid?: number; tags: string[] };
type Tab = { id: number; url: string; title?: string; tags: string[]; openedBy?: string; openerId?: number };

/** A shell: windows and tabs with tags, workspaces as tags, what has the keyboard. */
function fakeHost({ ns = "gnome", workspace = "1" } = {}) {
  const windows = new Map<number, Win>();
  const tabs = new Map<number, Tab>();
  const log: string[] = [];
  let nextId = 100;
  const host = {
    ns,
    scopes: ["thread", "global"],
    workspace,
    focused: null as null | { kind: string; id: number },
    shown: new Set<string>(),
    world: () => ({ windows: windows.values(), tabs: tabs.values() }),
    contextKey: () => host.workspace,
    scopeTag: (scope: string) => (scope === "global" ? `${ns}:global` : `${ns}:workspace/${host.workspace}`),
    launchThread: () => `${ns}:workspace/${host.workspace}`,
    retag: async (item: { kind: string; id: number }, add: string[], remove: string[]) => {
      const entry = item.kind === "window" ? windows.get(item.id) : tabs.get(item.id);
      if (!entry) throw new Error("gone");
      entry.tags = [...entry.tags.filter((t) => !remove.includes(t) || t === entry.tags[0]), ...add.filter((t) => !entry.tags.includes(t))];
      log.push(`retag ${item.kind}:${item.id} +${add.join(",")} -${remove.join(",")}`);
    },
    launchApp: async (desktopId: string, thread: string) => {
      const pid = nextId++;
      log.push(`launch ${desktopId} in ${thread}`);
      // The window shows up a moment later.
      setTimeout(() => {
        windows.set(pid, { id: pid, appId: desktopId, pid, tags: [thread] });
        dock.changed();
      }, 5);
      return { pid };
    },
    launchTerminal: async (thread: string) => host.launchApp("foot", thread),
    openTab: async (url: string, tags: string[]) => {
      const tab = { id: nextId++, url, tags: [...tags] };
      tabs.set(tab.id, tab);
      log.push(`tab ${url} ${tags.join(",")}`);
      return tab;
    },
    presence: (thing: { kind: string; entry?: Win; tab?: Tab }) => {
      const key = thing.kind === "window" ? `window:${thing.entry!.id}` : `tab:${thing.tab!.id}`;
      if (host.focused && `${host.focused.kind}:${host.focused.id}` === key) return "focused";
      return host.shown.has(key) ? "shown" : "hidden";
    },
    show: (thing: { kind: string; entry?: Win; tab?: Tab }, options: { layout: string }) => {
      const item = thing.kind === "window" ? { kind: "window", id: thing.entry!.id } : { kind: "tab", id: thing.tab!.id };
      host.focused = item;
      host.shown.add(`${item.kind}:${item.id}`);
      log.push(`show ${item.kind}:${item.id} ${options.layout}`);
    },
    hide: (thing: { kind: string; entry?: Win; tab?: Tab }) => {
      const key = thing.kind === "window" ? `window:${thing.entry!.id}` : `tab:${thing.tab!.id}`;
      host.shown.delete(key);
      if (host.focused && `${host.focused.kind}:${host.focused.id}` === key) host.focused = null;
      log.push(`hide ${key}`);
    },
    snapshot: () => host.focused,
    restore: (point: any) => {
      host.focused = point;
      log.push(`restore ${point ? `${point.kind}:${point.id}` : "nothing"}`);
    },
    focusedItem: () => host.focused,
    apps: async () => [{ id: "org.gnome.Nautilus", name: "Files" }, { id: "foot", name: "Foot" }],
    toast: (text: string) => log.push(`toast ${text}`),
    groupOf: (item: Win | Tab, kind: string) => (kind === "window" ? { key: (item as Win).appId, name: (item as Win).appId } : null),
  };
  const kept = new Map<string, unknown>();
  const store = { get: async (key: string) => kept.get(key), set: (key: string, value: unknown) => kept.set(key, structuredClone(value)) };
  const settings = new Map<string, unknown>();
  const dock = new core.Dock({ host, store, settings: { get: (key: string) => settings.get(key) } });
  return { host, dock, windows, tabs, log, kept, settings };
}

const wait = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

describe("slots as stored", () => {
  test("Hydra's record, version 1 (no id, a site's match), and gaps", () => {
    const slots = core.migrateSlots({
      "1": { scope: "thread", target: { kind: "terminal" }, layout: "split" },
      "3": { scope: "global", target: { kind: "site", url: "https://a.example/", name: "A", match: "a.example" }, layout: "fold" },
      "12": { target: { kind: "app" } },
      x: { target: { kind: "site", url: "u", name: "n" } },
    });
    assert.equal(slots.length, 12);
    assert.equal(slots[1], null);
    assert.equal(slots[0].target.kind, "terminal");
    assert.ok(slots[0].id);
    assert.deepEqual(slots[2].target, { kind: "site", url: "https://a.example/", name: "A" });
    assert.equal(slots[2].scope, "global");
    assert.equal(slots[11].layout, "split");
  });

  test("an array keeps its gaps, trailing ones trimmed", () => {
    const slots = core.migrateSlots([null, { id: "x", target: { kind: "terminal" }, scope: "bogus", layout: "fold" }, null]);
    assert.equal(slots.length, 2);
    assert.equal(slots[1].scope, "thread");
    assert.equal(slots[1].id, "x");
  });

  test("the same thing named again keeps the id; another site doesn't", () => {
    assert.ok(core.namesSameThing({ kind: "site", url: "https://github.com/a" }, { kind: "site", url: "https://github.com/a/pulls" }));
    assert.ok(!core.namesSameThing({ kind: "site", url: "https://github.com/a" }, { kind: "site", url: "https://gitlab.com/a" }));
    assert.ok(core.namesSameThing({ kind: "app", desktopId: "foot", windowAppId: null }, { kind: "app", desktopId: "foot", windowAppId: "foot" }));
    assert.ok(core.sameApp("org.gnome.Nautilus.desktop", "nautilus"));
    assert.equal(core.normalizeSiteUrl("github.com/x"), "https://github.com/x");
    assert.equal(core.normalizeSiteUrl("javascript:alert(1)"), null);
  });
});

describe("a slot's key", () => {
  test("nothing held: starts the app, binds the window its process opened, shows it", async () => {
    const { dock, windows, log } = fakeHost();
    // Another foot is open on the workspace, but adoptOpen is off.
    windows.set(1, { id: 1, appId: "foot", tags: ["gnome:workspace/1"] });
    dock.pin({ kind: "app", desktopId: "foot", windowAppId: null, name: "Foot" });
    dock._settings = { get: (key: string) => (key === "adoptOpen" ? false : undefined) };
    await dock.activate(0);
    await wait();
    const started = [...windows.values()].find((w) => w.id !== 1)!;
    assert.ok(started.tags.includes(core.slotTag("gnome", dock.slot(0).id)));
    assert.ok(!windows.get(1)!.tags.some((t) => t.startsWith("gnome:dock/")));
    assert.ok(log.includes(`show window:${started.id} split`));
    // It learned the window's app id.
    assert.equal(dock.slot(0).target.windowAppId, "foot");
  });

  test("adoptOpen: an open window of the app is taken instead (Dash to Dock)", async () => {
    const { dock, windows, log } = fakeHost();
    windows.set(1, { id: 1, appId: "foot", tags: ["gnome:workspace/1"] });
    dock.pin({ kind: "app", desktopId: "foot", windowAppId: null, name: "Foot" });
    await dock.activate(0);
    assert.ok(windows.get(1)!.tags.includes(core.slotTag("gnome", dock.slot(0).id)));
    assert.ok(log.includes("show window:1 split"));
    assert.ok(!log.some((line) => line.startsWith("launch")));
  });

  test("focused: back where the key was pressed from; a click minimizes instead", async () => {
    const { dock, windows, host, log } = fakeHost();
    windows.set(1, { id: 1, appId: "foot", tags: ["gnome:workspace/1"] });
    windows.set(2, { id: 2, appId: "gedit", tags: ["gnome:workspace/1"] });
    host.focused = { kind: "window", id: 2 };
    dock.pin({ kind: "app", desktopId: "foot", windowAppId: null, name: "Foot" });
    await dock.activate(0);
    assert.deepEqual(host.focused, { kind: "window", id: 1 });
    assert.equal(dock.state(0), "focused");
    await dock.activate(0);
    assert.deepEqual(host.focused, { kind: "window", id: 2 });
    assert.ok(log.includes("restore window:2"));
    await dock.activate(0, { click: true });
    await dock.activate(0, { click: true });
    assert.ok(log.includes("hide window:1"));
  });

  test("a click on an app with several windows lists them; cycling raises the next", async () => {
    const { dock, windows, host } = fakeHost();
    windows.set(1, { id: 1, appId: "foot", tags: ["gnome:workspace/1"] });
    windows.set(2, { id: 2, appId: "foot", tags: ["gnome:workspace/2"] });
    dock.pin({ kind: "app", desktopId: "foot", windowAppId: null, name: "Foot" });
    await dock.activate(0, { click: true });
    assert.equal(dock.things(0).length, 2);
    let listed = -1;
    dock.addEventListener("previews", (e: any) => (listed = e.detail.index));
    await dock.activate(0, { click: true });
    assert.equal(listed, 0);
    await dock.cycle(0, 1);
    assert.deepEqual(host.focused, { kind: "window", id: 2 });
    // Isolated to the workspace: only its own.
    dock._settings = { get: (key: string) => (key === "isolateWorkspaces" ? true : undefined) };
    assert.equal(dock.things(0).length, 1);
  });

  test("a site: one tab with the scope's tag and the slot's; a popup it opens isn't the slot's", async () => {
    const { dock, tabs, log } = fakeHost();
    dock.pin({ kind: "site", url: "https://example.com/", name: "Example" });
    await dock.activate(0);
    const tag = core.slotTag("gnome", dock.slot(0).id);
    assert.ok(log.includes(`tab https://example.com/ gnome:workspace/1,${tag}`));
    const tab = [...tabs.values()][0];
    tabs.set(50, { id: 50, url: "https://example.com/popup", tags: [...tab.tags], openedBy: "page", openerId: tab.id });
    assert.equal(core.findThing(dock.slot(0), dock.host)?.tab.id, tab.id);
    tabs.delete(tab.id);
    // The opener's gone: the popup carrying its tags counts as held now.
    assert.equal(core.findThing(dock.slot(0), dock.host)?.tab.id, 50);
  });

  test("per workspace: another workspace's copy isn't found there; everywhere follows you", async () => {
    const { dock, host, windows } = fakeHost();
    dock.pin({ kind: "app", desktopId: "foot", windowAppId: null, name: "Foot" });
    dock._settings = { get: (key: string) => (key === "adoptOpen" ? false : undefined) };
    await dock.activate(0);
    await wait();
    host.workspace = "2";
    assert.equal(dock.thing(0), null);
    host.workspace = "1";
    await dock.setScope(0, "global");
    host.workspace = "2";
    const held = dock.thing(0);
    assert.ok(held);
    assert.ok(windows.get(held.entry.id)!.tags.includes("gnome:global"));
  });

  test("empty slot: says how to fill it; Super+Shift+N puts the focused window there", async () => {
    const { dock, host, windows, log } = fakeHost();
    await dock.activate(2);
    assert.ok(log.includes("toast Super+3 is empty"));
    windows.set(7, { id: 7, appId: "nautilus", title: "Home", tags: ["gnome:workspace/1"] });
    host.focused = { kind: "window", id: 7 };
    await dock.assign(2);
    assert.equal(dock.slots.length, 3);
    assert.equal(dock.slot(0), null);
    assert.deepEqual(dock.slot(2).target, { kind: "app", desktopId: "org.gnome.Nautilus", windowAppId: "nautilus", name: "Files" });
    assert.ok(windows.get(7)!.tags.includes(core.slotTag("gnome", dock.slot(2).id)));
    // Into another slot: it leaves the first.
    await dock.assign(4);
    assert.ok(!windows.get(7)!.tags.includes(core.slotTag("gnome", dock.slot(2).id)));
  });

  test("pins: move, unpin and put back, kept in the store", async () => {
    const { dock, kept } = fakeHost();
    dock.pin({ kind: "app", desktopId: "a", windowAppId: null, name: "A" });
    dock.pin({ kind: "app", desktopId: "b", windowAppId: null, name: "B" });
    dock.pin({ kind: "app", desktopId: "c", windowAppId: null, name: "C" });
    dock.move(0, 2);
    assert.deepEqual(dock.slots.map((s: any) => s.target.name), ["B", "C", "A"]);
    const removed = dock.unpin(1);
    assert.deepEqual(dock.slots.map((s: any) => s.target.name), ["B", "A"]);
    dock.insert(1, removed);
    assert.deepEqual(dock.slots.map((s: any) => s.target.name), ["B", "C", "A"]);
    assert.equal((kept.get("dock") as any).slots.length, 3);
    const again = fakeHost();
    again.kept.set("dock", kept.get("dock"));
    await again.dock.load();
    assert.deepEqual(again.dock.slots.map((s: any) => s.target.name), ["B", "C", "A"]);
  });

  test("the view: running apps no slot names, after the pinned ones", () => {
    const { dock, windows } = fakeHost();
    windows.set(1, { id: 1, appId: "foot", tags: ["gnome:workspace/1"] });
    windows.set(2, { id: 2, appId: "gimp", tags: ["gnome:workspace/1"] });
    windows.set(3, { id: 3, appId: "gimp", tags: ["gnome:workspace/2"] });
    dock.pin({ kind: "app", desktopId: "foot", windowAppId: null, name: "Foot" });
    const view = dock.view();
    assert.equal(view.pinned[0].things.length, 1);
    assert.deepEqual(view.running.map((group: any) => [group.key, group.things.length]), [["gimp", 2]]);
  });

  test("the key asks about what the slot holds, not its app's other windows", async () => {
    const { dock, windows, host } = fakeHost();
    windows.set(1, { id: 1, appId: "foot", tags: ["gnome:workspace/1"] });
    dock.pin({ kind: "app", desktopId: "foot", windowAppId: null, name: "Foot" });
    await dock.activate(0);
    // Another foot, which the slot doesn't hold, has the keyboard.
    windows.set(2, { id: 2, appId: "foot", tags: ["gnome:workspace/1"] });
    host.focused = { kind: "window", id: 2 };
    assert.equal(dock.state(0), "focused");
    await dock.activate(0);
    assert.deepEqual(host.focused, { kind: "window", id: 1 });
  });

  test("a click on an app with windows only elsewhere raises one; its key starts one here", async () => {
    const { dock, windows, host, log } = fakeHost();
    windows.set(1, { id: 1, appId: "foot", tags: ["gnome:workspace/2"] });
    dock.pin({ kind: "app", desktopId: "foot", windowAppId: null, name: "Foot" });
    await dock.activate(0, { click: true });
    assert.deepEqual(host.focused, { kind: "window", id: 1 });
    assert.ok(!log.some((line) => line.startsWith("launch")));
    host.focused = null;
    await dock.activate(0);
    assert.ok(log.some((line) => line.startsWith("launch foot")));
  });

  test("a launcher that opens a tab: the tab is the slot's; the host groups tabs under it", async () => {
    const { dock, host, tabs } = fakeHost();
    (host as any).launchApp = async () => {
      const tab = { id: 9, url: "https://start.example/", tags: ["gnome:workspace/1"] };
      tabs.set(9, tab);
      return { tab };
    };
    (host as any).belongsTo = (target: any, _item: any, kind: string) => (target.desktopId === "web" ? kind === "tab" : undefined);
    dock.pin({ kind: "app", desktopId: "web", windowAppId: null, name: "Web" });
    dock._settings = { get: (key: string) => (key === "adoptOpen" ? false : undefined) };
    await dock.activate(0);
    assert.ok(tabs.get(9)!.tags.includes(core.slotTag("gnome", dock.slot(0).id)));
    tabs.set(10, { id: 10, url: "https://other.example/", tags: ["gnome:workspace/1"] });
    assert.deepEqual(dock.things(0).map((t: any) => t.tab.id), [9, 10]);
    assert.deepEqual(dock.view().running, []);
  });

  test("the keymap's dock actions", () => {
    const actions: string[] = [];
    const keymap = { define: (id: string, spec: any) => actions.push(`${id} ${spec.keys.join(",")}`) };
    core.defineDockActions(keymap, fakeHost().dock);
    assert.ok(actions.includes("dock.slot.1 Super+Digit1"));
    assert.ok(actions.includes("dock.assign.9 Super+Shift+Digit9"));
    assert.ok(actions.includes("dock.new.3 Super+Ctrl+Shift+Digit3"));
    assert.ok(actions.includes("dock.toggleLayout "));
  });
});

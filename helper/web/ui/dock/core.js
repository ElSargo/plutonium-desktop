// The dock's model (UI_LIBRARY.md, "The dock"): no DOM, so any shell can use
// it and tests can drive it. Slots on Super+1…9, each a terminal, an app or a
// site, kept in a scope; what a slot's key does when pressed again and again;
// and the running apps nothing pinned. It is Hydra's dock (HYDRA_DOCK.md) and
// GNOME's Dash to Dock in one, and a shell turns parts of it on with its
// settings (DOCK_SETTINGS).
//
// A slot holds one window or tab, not every one that looks like it: the one
// put in it carries the slot's tag (<ns>:dock/<slot id>). A scope says which
// copy the key finds: "thread" (a thread, or a workspace: one copy each),
// "project" (Hydra's), "global" (one copy, which follows you). With nothing
// held, the key starts the app or opens the site and tags what that made; with
// `adoptOpen`, an app's open window in the scope is taken first, as Dash to
// Dock raises an app's window. An app slot shows the app's other windows in
// the scope too (`groupApps`), as dots, cycled by a click or the wheel.
//
// The shell is the host (DockHost below): it says what's in a scope, shows
// and hides things, starts apps and opens tabs, and remembers where you were.

export const DOCK_KEY_COUNT = 9;
export const SCOPES = ["thread", "project", "global"];
export const LAYOUTS = ["split", "fold"];

/**
 * @typedef {{ kind: "terminal" }
 *   | { kind: "app", desktopId: string | null, windowAppId: string | null, name: string }
 *   | { kind: "site", url: string, name: string, icon?: string }} DockTarget
 * @typedef {{ id: string, target: DockTarget, scope: "thread" | "project" | "global", layout: "split" | "fold" }} DockSlot
 * @typedef {{ id: number, appId?: string, title?: string, pid?: number, tags?: string[], focused?: boolean }} DockWindow
 * @typedef {{ id: number, url?: string, title?: string, tags?: string[], openedBy?: string, openerId?: number }} DockTab
 * @typedef {{ kind: "window", entry: DockWindow } | { kind: "tab", tab: DockTab }} DockThing
 * @typedef {{ kind: "window" | "tab", id: number }} DockItem
 *
 * @typedef {object} DockHost
 * @property {string} ns  the tags' namespace ("t3", "niri", "gnome")
 * @property {("thread" | "project" | "global")[]} scopes  the scopes it has
 * @property {() => { windows: Iterable<DockWindow>, tabs: Iterable<DockTab> }} world
 * @property {() => string} contextKey  the thread or workspace the user is in (for its own layouts)
 * @property {(scope: string) => string | null} scopeTag  the tag things kept in `scope` carry here (null: none needed)
 * @property {(item: DockWindow | DockTab, scope: string, kind: "window" | "tab") => boolean} [inScope]  default: carries scopeTag(scope)
 * @property {(scope: string) => string | null} launchThread  the thread to start things for `scope` in (null: can't here)
 * @property {(item: DockItem, add: string[], remove: string[]) => Promise<void>} retag
 * @property {(desktopId: string, thread: string) => Promise<{ pid?: number, tab?: DockTab }>} launchApp  (a tab: the launcher opened one)
 * @property {(thread: string) => Promise<{ pid?: number }>} [launchTerminal]  a terminal slot's start (none: the host runs terminal slots itself)
 * @property {(slot: DockSlot, options: object) => void} [runTerminal]  the host's own terminal (Hydra's drawer)
 * @property {(url: string, tags: string[]) => Promise<DockTab | null>} openTab  a tab with tags[0] as its origin
 * @property {(thing: DockThing) => "focused" | "shown" | "hidden"} presence  whether it has the keyboard, shows, or neither
 * @property {(thing: DockThing, options: { layout: string, scope: string }) => void | Promise<void>} show  shows it, laid out as `layout`, with the keyboard
 * @property {(thing: DockThing) => void} hide  minimizes it, or puts it away
 * @property {(thing: DockThing) => void} [close]
 * @property {() => any} snapshot  where the user is now, to come back to
 * @property {(point: any, own: DockThing | null) => void} restore  back there (never showing `own` again)
 * @property {() => DockItem | null} focusedItem  what has the keyboard, for Super+Shift+N
 * @property {() => Promise<{ id: string, name: string }[]>} apps  the desktop apps
 * @property {(text: string, options?: object) => void} toast
 * @property {(target: DockTarget, item: DockWindow | DockTab, kind: "window" | "tab") => boolean | undefined} [belongsTo]
 *   whether a window or tab is one of an app target's (undefined: a window of the app)
 * @property {(item: DockWindow | DockTab, kind: "window" | "tab") => { key: string, name: string, desktopId?: string | null, windowAppId?: string | null, url?: string } | null} [groupOf]
 *   which running app an unpinned window or tab is (default: windows by app id; tabs aren't listed)
 */

/** The dock's own settings, with their defaults; the shells draw them (settings.js). */
export const DOCK_DEFAULTS = {
  clickAction: "focus-minimize-previews",
  middleClick: "new-window",
  shiftClick: "new-window",
  scrollAction: "cycle",
  showRunning: true,
  isolateWorkspaces: false,
  adoptOpen: true,
  groupApps: true,
  showNumbers: "super",
  iconSize: 24,
};

/**
 * The settings' schema (settings.js's SettingSpec). `scopeName` is what the
 * shell calls a thread ("workspace"); `sizes` the icon sizes it offers.
 */
export function dockSettingsSchema({ scopeName = "workspace", sizes = [16, 64], step = 2 } = {}) {
  return [
    {
      key: "clickAction", kind: "choice", label: "Click on an icon",
      choices: [
        ["focus-minimize-previews", "Focus, minimize or list its windows"],
        ["focus-minimize-cycle", "Focus, minimize or cycle its windows"],
        ["focus-back", "Focus, or go back to where you were"],
      ],
    },
    { key: "middleClick", kind: "choice", label: "Middle click", choices: [["new-window", "New window"], ["minimize", "Minimize"], ["close", "Close its windows"], ["none", "Nothing"]] },
    { key: "shiftClick", kind: "choice", label: "Shift+click", choices: [["new-window", "New window"], ["minimize", "Minimize"], ["none", "Nothing"]] },
    { key: "scrollAction", kind: "choice", label: "Scrolling over an icon", choices: [["cycle", "Cycles its windows"], ["none", "Nothing"]] },
    { key: "showRunning", kind: "switch", label: "Show running apps", help: "Apps with windows open that aren't pinned, after a separator" },
    { key: "isolateWorkspaces", kind: "switch", label: `Only this ${scopeName}'s windows`, help: `Running apps and window counts from the current ${scopeName} only` },
    { key: "adoptOpen", kind: "switch", label: "Use an open window", help: "A pinned app with nothing in its slot raises one of its open windows instead of starting a new one" },
    { key: "groupApps", kind: "switch", label: "Group an app's windows", help: "An app's icon counts and cycles its other windows too" },
    { key: "showNumbers", kind: "choice", label: "Slot numbers", choices: [["super", "While Super is held"], ["always", "Always"], ["never", "Never"]] },
    { key: "iconSize", kind: "range", label: "Icon size", min: sizes[0], max: sizes[1], step, unit: " px" },
  ];
}

/** A new slot id. */
export function newSlotId() {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const slotTag = (ns, id) => `${ns}:dock/${id}`;
export const isSlotTag = (ns, tag) => tag.startsWith(`${ns}:dock/`);
export const globalTag = (ns) => `${ns}:global`;

const tagsOf = (item) => item?.tags ?? [];

/** The host's world as arrays (it may give iterators, which a second look would find empty). */
export function worldOf(host) {
  const world = host.world();
  return { windows: [...world.windows], tabs: [...world.tabs] };
}
const normalizeAppId = (id) => String(id).toLowerCase().replace(/\.desktop$/, "");

/** Whether window app id `windowAppId` is desktop entry `desktopId`'s (org.gnome.Nautilus ~ nautilus). */
export function sameApp(desktopId, windowAppId) {
  if (!desktopId || !windowAppId) return false;
  const a = normalizeAppId(desktopId);
  const b = normalizeAppId(windowAppId);
  return a === b || a.split(".").at(-1) === b.split(".").at(-1);
}

export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** "github.com/x" → "https://github.com/x"; null if it isn't a web address. */
export function normalizeSiteUrl(input) {
  const text = String(input ?? "").trim();
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** A short name for a slot's target. */
export function slotLabel(slot) {
  if (!slot) return "empty";
  return slot.target.kind === "terminal" ? "Terminal" : slot.target.name;
}

/**
 * Whether `next` names the same app or site as `previous`, so the slot keeps
 * its id: what it holds elsewhere (another thread's) stays.
 */
export function namesSameThing(previous, next) {
  if (previous.kind === "terminal" || next.kind === "terminal") return previous.kind === next.kind;
  if (previous.kind === "app" && next.kind === "app") {
    return (
      (previous.desktopId !== null && previous.desktopId === next.desktopId) ||
      (previous.windowAppId !== null && previous.windowAppId === next.windowAppId)
    );
  }
  if (previous.kind === "site" && next.kind === "site") return hostOf(previous.url) === hostOf(next.url);
  return false;
}

/**
 * Slots as stored: an array (gaps are null), or Hydra's record by number
 * ("1"…"9"), or slots from before they held one thing (no id; a site's
 * `match`). Returns the array, trailing gaps trimmed.
 */
export function migrateSlots(stored) {
  const list = [];
  const take = (index, value) => {
    if (!value || typeof value !== "object" || !value.target || typeof value.target !== "object") return;
    const { match: _match, ...target } = value.target;
    if (!["terminal", "app", "site"].includes(target.kind)) return;
    list[index] = {
      id: typeof value.id === "string" && value.id ? value.id : newSlotId(),
      target,
      scope: SCOPES.includes(value.scope) ? value.scope : "thread",
      layout: LAYOUTS.includes(value.layout) ? value.layout : "split",
    };
  };
  if (Array.isArray(stored)) stored.forEach((value, index) => take(index, value));
  else if (stored && typeof stored === "object") {
    for (const [key, value] of Object.entries(stored)) {
      const number = Number(key);
      if (Number.isInteger(number) && number >= 1) take(number - 1, value);
    }
  }
  const out = Array.from({ length: list.length }, (_, index) => list[index] ?? null);
  while (out.length && out.at(-1) === null) out.pop();
  return out;
}

/** The scope of what carries `tags`: the last scope tag among them. */
export function scopeOfTags(tags, ns) {
  for (let index = tags.length - 1; index >= 0; index -= 1) {
    const tag = tags[index];
    if (tag === globalTag(ns)) return "global";
    if (tag.startsWith(`${ns}:project/`)) return "project";
    if (tag.startsWith(`${ns}:thread/`)) return "thread";
  }
  return "thread";
}

/**
 * Whether `tab` carries slot tag `tag` as its own: a page's new tab starts
 * with its opener's tags, and isn't the slot's for that.
 */
export function tabHolds(tab, tag, tabs) {
  if (!tagsOf(tab).includes(tag)) return false;
  if (tab.openedBy !== "page") return true;
  const opener = [...tabs].find((other) => other.id === tab.openerId);
  return !opener || !tagsOf(opener).includes(tag);
}

function inScope(host, item, scope, kind) {
  if (host.inScope) return host.inScope(item, scope, kind);
  const tag = host.scopeTag(scope);
  return tag !== null && tagsOf(item).includes(tag);
}

/** Whether `entry` is a window of the slot's app. */
function isAppWindow(target, entry) {
  if (target.kind !== "app" && target.kind !== "terminal") return false;
  if (target.windowAppId) return entry.appId === target.windowAppId;
  return target.kind === "app" && target.desktopId !== null && sameApp(target.desktopId, entry.appId);
}

/**
 * Slot `slot`'s thing here: what carries the slot's tag, in its scope. The
 * newest window; a tab, the newest.
 * @returns {DockThing | null}
 */
export function findThing(slot, host, world = worldOf(host)) {
  if (!slot) return null;
  const tag = slotTag(host.ns, slot.id);
  const heldTab = () => {
    const tabs = [...world.tabs];
    let found = null;
    for (const tab of tabs) {
      if (!tabHolds(tab, tag, tabs) || !inScope(host, tab, slot.scope, "tab")) continue;
      found = { kind: "tab", tab };
    }
    return found;
  };
  if (slot.target.kind === "site") return heldTab();
  const entry = [...world.windows]
    .filter((window) => tagsOf(window).includes(tag) && inScope(host, window, slot.scope, "window"))
    .sort((a, b) => a.id - b.id)
    .at(-1);
  // An app's launcher may have opened a tab (a shell's "Web"): that's held too.
  return entry ? { kind: "window", entry } : heldTab();
}

const heldBySlot = (ns, item) => tagsOf(item).some((tag) => isSlotTag(ns, tag));

/** Whether `item` (a window or tab) is one of `target`'s app's: the host's say, else a window of the app. */
function belongs(host, target, item, kind) {
  const said = host.belongsTo?.(target, item, kind);
  if (said !== undefined) return said;
  return kind === "window" && isAppWindow(target, item);
}

/**
 * The other windows (and, as the host says, tabs) of an app slot's app in
 * its scope (or anywhere, with `everywhere`) that no slot holds, oldest first.
 * @returns {DockThing[]}
 */
export function appMembers(slot, host, world, { everywhere = false } = {}) {
  if (!slot || (slot.target.kind !== "app" && slot.target.kind !== "terminal")) return [];
  const pick = (list, kind) => list
    .filter((item) => belongs(host, slot.target, item, kind) && !heldBySlot(host.ns, item))
    .filter((item) => everywhere || inScope(host, item, slot.scope, kind))
    .sort((a, b) => a.id - b.id)
    .map((item) => (kind === "window" ? { kind, entry: item } : { kind, tab: item }));
  return [...pick([...world.windows], "window"), ...pick([...world.tabs], "tab")];
}

/** A slot's things: what it holds first, then (grouping apps) its app's other windows. */
export function slotThings(slot, host, world, settings = DOCK_DEFAULTS) {
  const held = findThing(slot, host, world);
  const things = held ? [held] : [];
  // Its app's windows on every workspace, as Dash to Dock counts them, unless isolated.
  if (settings.groupApps) things.push(...appMembers(slot, host, world, { everywhere: !settings.isolateWorkspaces }));
  return things;
}

const thingItem = (thing) => (thing.kind === "window" ? { kind: "window", id: thing.entry.id } : { kind: "tab", id: thing.tab.id });
const sameThing = (a, b) => !!a && !!b && a.kind === b.kind && (a.kind === "window" ? a.entry.id === b.entry.id : a.tab.id === b.tab.id);

/**
 * The dock: its slots (kept in `store` under `key`), its settings, and what
 * pressing, clicking or scrolling on a slot does.
 * Events: "change" (the slots or what they show changed: redraw).
 */
export class Dock extends EventTarget {
  /**
   * @param {{ host: DockHost, store: { get(key: string): Promise<any>, set(key: string, value: any): void },
   *           key?: string, settings?: { get(key: string): any }, defaults?: (DockSlot | null)[] }} options
   */
  constructor({ host, store, key = "dock", settings = null, defaults = [] }) {
    super();
    this.host = host;
    this._store = store;
    this._key = key;
    this._settings = settings;
    /** @type {(DockSlot | null)[]} */
    this.slots = migrateSlots(defaults);
    /** A context's own layout for a slot, by context key, then slot id. */
    this.layouts = {};
    /** Where to go back to, by context key: { slotId, point }. Not kept. */
    this._returnTo = new Map();
    /** Which of an app's things a click raised last, by slot id (to cycle on). */
    this._cycle = new Map();
  }

  /** Reads what's kept (`fallback()` gives the slots when nothing is: a migration). */
  async load(fallback = null) {
    const saved = await this._store.get(this._key);
    if (saved && typeof saved === "object") {
      this.slots = migrateSlots(saved.slots);
      this.layouts = saved.layouts && typeof saved.layouts === "object" ? saved.layouts : {};
    } else if (fallback) {
      const slots = await fallback();
      if (slots) {
        this.slots = migrateSlots(slots);
        this._save();
      }
    }
    this.changed();
    return this;
  }

  /** A setting's value (the shell's, else the dock's default). */
  setting(key) {
    const value = this._settings?.get(key);
    return value === undefined ? DOCK_DEFAULTS[key] : value;
  }

  settingsNow() {
    return Object.fromEntries(Object.keys(DOCK_DEFAULTS).map((key) => [key, this.setting(key)]));
  }

  /** Tells the views to redraw (call it when windows or tabs change). */
  changed() {
    this.dispatchEvent(new Event("change"));
  }

  slot(index) {
    return this.slots[index] ?? null;
  }

  _save() {
    this._store.set(this._key, { version: 3, slots: this.slots, layouts: this.layouts });
  }

  _setSlot(index, slot) {
    const slots = [...this.slots];
    while (slots.length <= index) slots.push(null);
    slots[index] = slot;
    while (slots.length && slots.at(-1) === null) slots.pop();
    this.slots = slots;
    this._save();
    this.changed();
  }

  // ------------------------------------------------------------ finding

  /** Slot `index`'s thing here, or null. */
  thing(index, world = worldOf(this.host)) {
    return findThing(this.slot(index), this.host, world);
  }

  /** Slot `index`'s things: what it holds, then its app's other windows (grouping). */
  things(index, world = worldOf(this.host)) {
    const slot = this.slot(index);
    return slot ? slotThings(slot, this.host, world, this.settingsNow()) : [];
  }

  /**
   * Slot `index`'s state here: empty (nothing set), idle (nothing of it
   * running), running, shown, focused.
   */
  state(index, world = worldOf(this.host)) {
    const slot = this.slot(index);
    if (!slot) return "empty";
    const things = this.things(index, world);
    if (!things.length) return "idle";
    const presences = things.map((thing) => this.host.presence(thing));
    if (presences.includes("focused")) return "focused";
    if (presences.includes("shown")) return "shown";
    return "running";
  }

  /**
   * What the dock shows: every slot (gaps too) with its state and things,
   * then the running apps no slot names (with showRunning), by app.
   */
  view() {
    const world = worldOf(this.host);
    const settings = this.settingsNow();
    const pinned = this.slots.map((slot, index) => {
      const things = slot ? slotThings(slot, this.host, world, settings) : [];
      return { index, slot, things, state: this.state(index, world) };
    });
    const running = [];
    if (settings.showRunning && this.host.groupOf) {
      const claimed = new Set();
      for (const entry of pinned) for (const thing of entry.things) claimed.add(`${thing.kind}:${thing.kind === "window" ? thing.entry.id : thing.tab.id}`);
      const groups = new Map();
      const add = (item, kind) => {
        if (claimed.has(`${kind}:${item.id}`)) return;
        if (settings.isolateWorkspaces && !inScope(this.host, item, "thread", kind)) return;
        const group = this.host.groupOf(item, kind);
        if (!group) return;
        // An app a slot names counts there, not here.
        if (settings.groupApps && this.slots.some((slot) => slot && (slot.target.kind === "app" || slot.target.kind === "terminal") && belongs(this.host, slot.target, item, kind))) return;
        if (!groups.has(group.key)) groups.set(group.key, { ...group, things: [] });
        groups.get(group.key).things.push(kind === "window" ? { kind, entry: item } : { kind, tab: item });
      };
      for (const window of world.windows) add(window, "window");
      for (const tab of world.tabs) add(tab, "tab");
      for (const group of groups.values()) {
        const presences = group.things.map((thing) => this.host.presence(thing));
        running.push({ ...group, state: presences.includes("focused") ? "focused" : presences.includes("shown") ? "shown" : "running" });
      }
    }
    return { pinned, running };
  }

  // ------------------------------------------------------------ pressing

  _layoutOf(slot) {
    return this.layouts[this.host.contextKey()]?.[slot.id] ?? slot.layout;
  }

  /**
   * Super+N (or a click, `click: true`): starts, shows, focuses or puts away
   * slot `index`'s thing. `other` lays it out the other way this time.
   */
  async activate(index, { other = false, click = false } = {}) {
    const slot = this.slot(index);
    const n = index + 1;
    if (!slot) {
      this.host.toast(`Super+${n} is empty`, { detail: `Super+Shift+${n} puts what has the keyboard there.` });
      return;
    }
    const own = this._layoutOf(slot);
    const layout = other ? (own === "fold" ? "split" : "fold") : own;
    if (slot.target.kind === "terminal" && !this.host.launchTerminal) {
      this.host.runTerminal?.(slot, { other, click, layout });
      return;
    }
    const world = worldOf(this.host);
    let thing = findThing(slot, this.host, world);
    if (!thing && this.setting("adoptOpen")) thing = await this._adopt(slot, world);
    const things = this.things(index);
    // Nothing held: the key starts one here. A click on an app with windows
    // elsewhere raises those (Dash to Dock switches to their workspace).
    if (!thing && !(click && things.length)) {
      this._remember(slot);
      await this._start(index, slot, layout);
      return;
    }
    // The key asks about what the slot holds; a click, as Dash to Dock, about any of its app's windows.
    const focusedThing = click
      ? (things.find((candidate) => this.host.presence(candidate) === "focused") ?? null)
      : this.host.presence(thing) === "focused" ? thing : null;
    if (focusedThing && !other) {
      // It has the keyboard: back, or (a click) Dash to Dock's minimize, list or cycle.
      const action = click ? this.setting("clickAction") : "focus-back";
      if (action !== "focus-back" && things.length > 1) {
        if (action === "focus-minimize-cycle") this.cycle(index, 1);
        else this.dispatchEvent(new CustomEvent("previews", { detail: { index } }));
        return;
      }
      this.back(index, focusedThing, { minimize: action !== "focus-back" });
      return;
    }
    this._remember(slot);
    // Shown or not, it gets the keyboard: what it holds (a click: the one of its app's windows raised last).
    const target = click ? (this._lastRaised(slot, things) ?? thing ?? things.at(-1)) : thing;
    await this.host.show(target, { layout, scope: thing && target === thing ? slot.scope : "thread" });
    this.changed();
  }

  /** Goes back to where slot `index`'s key was pressed from, or puts its thing away. */
  back(index, thing = this.thing(index), { minimize = false } = {}) {
    const slot = this.slot(index);
    if (!slot) return;
    const key = this.host.contextKey();
    const back = this._returnTo.get(key);
    this._returnTo.delete(key);
    if (back?.slotId === slot.id && !minimize) this.host.restore(back.point, thing);
    else if (thing) this.host.hide(thing);
    this.changed();
  }

  _remember(slot) {
    const key = this.host.contextKey();
    if (this._returnTo.get(key)?.slotId === slot.id) return;
    this._returnTo.set(key, { slotId: slot.id, point: this.host.snapshot() });
  }

  _lastRaised(slot, things) {
    const last = this._cycle.get(slot.id);
    return things.find((thing) => sameThing(thing, last)) ?? null;
  }

  /** Raises slot `index`'s next (dir 1) or previous thing: its app's windows in turn. */
  async cycle(index, dir = 1) {
    const slot = this.slot(index);
    const things = this.things(index);
    if (!slot || !things.length) return;
    const current = things.findIndex((thing) => this.host.presence(thing) === "focused");
    const next = things[(current + dir + things.length) % things.length];
    this._cycle.set(slot.id, next);
    await this.host.show(next, { layout: this._layoutOf(slot), scope: slot.scope });
    this.changed();
  }

  /** Raises a running group's next thing (an app nothing pins). */
  async cycleGroup(group, dir = 1) {
    const things = group.things;
    if (!things.length) return;
    const current = things.findIndex((thing) => this.host.presence(thing) === "focused");
    const next = things[(current + dir + things.length) % things.length];
    await this.host.show(next, { layout: "split", scope: "thread" });
    this.changed();
  }

  /** Raises `thing` (from the window list). */
  async raise(thing, index = null) {
    const slot = index === null ? null : this.slot(index);
    if (slot) this._cycle.set(slot.id, thing);
    await this.host.show(thing, { layout: slot ? this._layoutOf(slot) : "split", scope: slot?.scope ?? "thread" });
    this.changed();
  }

  /** Takes an app slot's open window in its scope that no slot holds: the slot holds it now. */
  async _adopt(slot, world) {
    if (slot.target.kind !== "app") return null;
    // A slot kept everywhere takes one from anywhere, and keeps it everywhere from now.
    const member = appMembers(slot, this.host, world, { everywhere: slot.scope === "global" }).at(-1);
    if (!member) return null;
    const item = member.kind === "window" ? member.entry : member.tab;
    const scopeTag = this.host.scopeTag(slot.scope);
    const add = [slotTag(this.host.ns, slot.id), ...(scopeTag && !tagsOf(item).includes(scopeTag) ? [scopeTag] : [])];
    await this.host.retag({ kind: member.kind, id: item.id }, add, []).catch(() => {});
    const tagged = { ...item, tags: [...tagsOf(item), ...add] };
    return member.kind === "window" ? { kind: "window", entry: tagged } : { kind: "tab", tab: tagged };
  }

  /** Makes slot `slot`'s thing from its recipe, tags it, and shows it. */
  async _start(index, slot, layout) {
    const thread = this.host.launchThread(slot.scope);
    const scopeTag = this.host.scopeTag(slot.scope);
    if (thread === null) {
      this.host.toast(slot.scope === "project" ? "This thread has no project" : "Nowhere to start it here");
      return;
    }
    const tag = slotTag(this.host.ns, slot.id);
    if (slot.target.kind === "site") {
      try {
        const tab = await this.host.openTab(slot.target.url, [scopeTag ?? thread, tag]);
        if (tab) await this.host.show({ kind: "tab", tab }, { layout, scope: slot.scope });
      } catch (error) {
        this.host.toast(`Could not open ${slot.target.name}`, { detail: error?.message ?? String(error) });
      }
      this.changed();
      return;
    }
    await this._launch(index, slot, thread, scopeTag, layout, { bind: true });
  }

  /**
   * Starts slot `slot`'s app or terminal; with `bind`, the window it opens is
   * the slot's: a new window of the process started, else a new window of the
   * app in the scope (a launcher that hands over to another process).
   */
  async _launch(index, slot, thread, scopeTag, layout, { bind }) {
    const target = slot.target;
    const name = slotLabel(slot);
    if (target.kind === "app" && !target.desktopId) {
      this.host.toast(`${name} isn't running`, { detail: `No installed app was found to start it. Start it yourself, then Super+Shift+${index + 1} puts it in the slot.` });
      return;
    }
    const known = new Set([...worldOf(this.host).windows].map((window) => window.id));
    const tag = slotTag(this.host.ns, slot.id);
    let pid = null;
    let done = false;
    let timer = 0;
    const stop = () => {
      done = true;
      clearTimeout(timer);
      this.removeEventListener("change", look);
    };
    const look = () => {
      if (done) return;
      const entry = [...worldOf(this.host).windows]
        .filter((window) => !known.has(window.id) && ((pid !== null && window.pid === pid) || (isAppWindow(target, window) && inScope(this.host, window, slot.scope, "window"))))
        .sort((a, b) => a.id - b.id)[0];
      if (!entry) return;
      stop();
      if (bind) {
        const add = scopeTag && !tagsOf(entry).includes(scopeTag) ? [scopeTag, tag] : [tag];
        void this.host.retag({ kind: "window", id: entry.id }, add, []).catch(() => {});
        // Its app id: the next start finds its window by it too.
        const current = this.slot(index);
        if (current?.id === slot.id && current.target.kind !== "site" && !current.target.windowAppId && entry.appId) {
          this._setSlot(index, { ...current, target: { ...current.target, windowAppId: entry.appId } });
        }
      }
      void this.host.show({ kind: "window", entry }, { layout, scope: slot.scope });
    };
    // The host calls changed() as windows come and go.
    this.addEventListener("change", look);
    timer = setTimeout(stop, 60_000);
    this.host.toast(`Starting ${name}…`, { ms: 2500 });
    try {
      const started = target.kind === "terminal" ? await this.host.launchTerminal(thread) : await this.host.launchApp(target.desktopId, thread);
      pid = started?.pid || null;
      // A launcher that opened a tab (a shell's "Web"): that's the slot's.
      if (started?.tab) {
        stop();
        if (bind) {
          const add = scopeTag && !tagsOf(started.tab).includes(scopeTag) ? [scopeTag, tag] : [tag];
          await this.host.retag({ kind: "tab", id: started.tab.id }, add, []).catch(() => {});
        }
        await this.host.show({ kind: "tab", tab: started.tab }, { layout, scope: slot.scope });
        this.changed();
        return;
      }
      look();
    } catch (error) {
      stop();
      this.host.toast(`Could not start ${name}`, { detail: error?.message ?? String(error) });
    }
  }

  /** A new window of slot `index`'s app (or a new tab of its site), not the slot's. */
  async newWindow(index) {
    const slot = this.slot(index);
    if (!slot) return;
    const thread = this.host.launchThread("thread");
    if (thread === null) return;
    if (slot.target.kind === "site") {
      const tab = await this.host.openTab(slot.target.url, [thread]).catch(() => null);
      if (tab) await this.host.show({ kind: "tab", tab }, { layout: this._layoutOf(slot), scope: "thread" });
      return;
    }
    if (slot.target.kind === "terminal" && !this.host.launchTerminal) return;
    await this._launch(index, slot, thread, null, this._layoutOf(slot), { bind: false });
  }

  /** Minimizes every thing of slot `index` (Dash to Dock's middle click). */
  minimizeAll(index) {
    for (const thing of this.things(index)) this.host.hide(thing);
    this.changed();
  }

  /** Closes every thing of slot `index`. */
  closeAll(index) {
    for (const thing of this.things(index)) this.host.close?.(thing);
  }

  // ------------------------------------------------------------ changing slots

  /** Takes slot `slot`'s tag off everything that carries it, in every scope. */
  _release(slot) {
    if (!slot) return;
    const tag = slotTag(this.host.ns, slot.id);
    const world = worldOf(this.host);
    for (const window of world.windows) if (tagsOf(window).includes(tag)) void this.host.retag({ kind: "window", id: window.id }, [], [tag]).catch(() => {});
    for (const tab of world.tabs) if (tagsOf(tab).includes(tag)) void this.host.retag({ kind: "tab", id: tab.id }, [], [tag]).catch(() => {});
  }

  /**
   * Slot `index` set to `next` (from the editor): it keeps its id while it
   * names the same app or site; naming another, what it held leaves it.
   */
  save(index, next) {
    const previous = this.slot(index);
    const keep = previous && namesSameThing(previous.target, next.target);
    if (previous && !keep) this._release(previous);
    const scope = this.host.scopes.includes(next.scope) ? next.scope : "thread";
    this._setSlot(index, { target: next.target, scope: next.target.kind === "terminal" && !this.host.launchTerminal ? "thread" : scope, layout: next.layout ?? "split", id: keep ? previous.id : newSlotId() });
  }

  /** Empties slot `index` (Hydra: a gap stays); what it held leaves it. */
  clear(index) {
    this._release(this.slot(index));
    this._setSlot(index, null);
  }

  /** Takes slot `index` out, the later ones moving up (Dash to Dock's unpin). Returns it. */
  unpin(index) {
    const slot = this.slot(index);
    if (!slot) return null;
    this._release(slot);
    const slots = [...this.slots];
    slots.splice(index, 1);
    while (slots.length && slots.at(-1) === null) slots.pop();
    this.slots = slots;
    this._save();
    this.changed();
    return slot;
  }

  /** Puts `slot` back at `index` (an unpin's undo), later ones moving down. */
  insert(index, slot) {
    const slots = [...this.slots];
    while (slots.length < index) slots.push(null);
    slots.splice(index, 0, { ...slot, id: newSlotId() });
    this.slots = slots;
    this._save();
    this.changed();
  }

  /** Makes slot `index` empty, the later ones moving along (to put something there next). */
  openGap(index) {
    if (index >= this.slots.length) return;
    const slots = [...this.slots];
    slots.splice(index, 0, null);
    this.slots = slots;
  }

  /** Moves slot `from` to `to` (dragging), the ones between shifting. */
  move(from, to) {
    if (from === to || !this.slot(from)) return;
    const slots = [...this.slots];
    const [slot] = slots.splice(from, 1);
    while (slots.length < to) slots.push(null);
    slots.splice(Math.min(to, slots.length), 0, slot);
    while (slots.length && slots.at(-1) === null) slots.pop();
    this.slots = slots;
    this._save();
    this.changed();
  }

  /** Pins `target` at `index` (default: the end); returns its index. */
  pin(target, { index = this.slots.length, scope = "thread", layout = "split" } = {}) {
    const slots = [...this.slots];
    while (slots.length < index) slots.push(null);
    slots.splice(index, 0, { id: newSlotId(), target, scope: this.host.scopes.includes(scope) ? scope : "thread", layout });
    this.slots = slots;
    this._save();
    this.changed();
    return index;
  }

  /** Whether an app is pinned (an app slot names it). */
  pinnedIndexOf(desktopId) {
    return this.slots.findIndex((slot) => slot?.target.kind === "app" && slot.target.desktopId === desktopId);
  }

  /** Keeps slot `index` laid out as `layout` in this context only (Super+Up). */
  setContextLayout(index, layout) {
    const slot = this.slot(index);
    if (!slot) return;
    const key = this.host.contextKey();
    this.layouts = { ...this.layouts, [key]: { ...this.layouts[key], [slot.id]: layout } };
    this._save();
    this.changed();
  }

  /** The context goes back to the slot's own layout. */
  clearContextLayout(index) {
    const slot = this.slot(index);
    const key = this.host.contextKey();
    if (!slot || this.layouts[key]?.[slot.id] === undefined) return;
    const own = { ...this.layouts[key] };
    delete own[slot.id];
    this.layouts = { ...this.layouts, [key]: own };
    this._save();
    this.changed();
  }

  /** This context's own layout for slot `index`, if it has one. */
  contextLayout(index) {
    const slot = this.slot(index);
    return slot ? this.layouts[this.host.contextKey()]?.[slot.id] ?? null : null;
  }

  /**
   * Keeps slot `index` in `scope`. What it holds here gets the new scope's
   * tag (and loses a project's or the global one); what it holds elsewhere
   * stays as it is.
   */
  async setScope(index, scope) {
    const slot = this.slot(index);
    if (!slot || !this.host.scopes.includes(scope) || scope === slot.scope) return;
    const thing = findThing(slot, this.host);
    this._setSlot(index, { ...slot, scope });
    if (!thing) return;
    const from = this.host.scopeTag(slot.scope);
    const to = this.host.scopeTag(scope);
    // A thread's or workspace's tag stays: it shows it, and its agent reaches it.
    const remove = from && from !== to && (from === globalTag(this.host.ns) || from.startsWith(`${this.host.ns}:project/`)) ? [from] : [];
    if (to || remove.length) await this.host.retag(thingItem(thing), to ? [to] : [], remove).catch(() => {});
    this.changed();
  }

  /** What `item` would be as a slot's target, and the scope it's in now. */
  async targetOf(item) {
    const world = worldOf(this.host);
    if (item.kind === "window") {
      const entry = [...world.windows].find((window) => window.id === item.id);
      if (!entry) return null;
      const apps = await this.host.apps().catch(() => []);
      const app = apps.find((candidate) => sameApp(candidate.id, entry.appId));
      return {
        target: { kind: "app", desktopId: app?.id ?? null, windowAppId: entry.appId ?? null, name: app?.name ?? (entry.title || entry.appId || "App") },
        scope: this._scopeOf(entry),
      };
    }
    const tab = [...world.tabs].find((candidate) => candidate.id === item.id);
    if (!tab?.url) return null;
    let name = tab.title || tab.url;
    try {
      name = tab.title || new URL(tab.url).host;
    } catch {}
    return { target: { kind: "site", url: tab.url, name, ...(tab.favicon ? { icon: tab.favicon } : {}) }, scope: this._scopeOf(tab) };
  }

  _scopeOf(item) {
    if (tagsOf(item).includes(globalTag(this.host.ns)) && this.host.scopes.includes("global")) return "global";
    const scope = scopeOfTags(tagsOf(item), this.host.ns);
    return this.host.scopes.includes(scope) ? scope : "thread";
  }

  /**
   * Super+Shift+N: puts `item` (default: what has the keyboard) in slot
   * `index`. That window or tab is the slot's in its scope instead of what
   * was, and it leaves any other slot it was in.
   */
  async assign(index, item = this.host.focusedItem()) {
    const n = index + 1;
    if (!item) {
      this.host.toast("Nothing has the keyboard", { detail: `Focus a window or tab, then Super+Shift+${n}.` });
      return;
    }
    const found = await this.targetOf(item);
    if (!found) {
      this.host.toast("Only apps and browser tabs go in the dock");
      return;
    }
    const previous = this.slot(index);
    const keep = !!previous && namesSameThing(previous.target, found.target);
    const next = { id: keep ? previous.id : newSlotId(), target: found.target, scope: found.scope, layout: previous?.layout ?? "split" };
    const tag = slotTag(this.host.ns, next.id);
    const world = worldOf(this.host);
    if (previous && !keep) this._release(previous);
    else if (previous) {
      const old = findThing(previous, this.host, world);
      if (old && !(thingItem(old).kind === item.kind && thingItem(old).id === item.id)) {
        await this.host.retag(thingItem(old), [], [tag]).catch(() => {});
      }
    }
    const current = item.kind === "window" ? [...world.windows].find((window) => window.id === item.id) : [...world.tabs].find((tab) => tab.id === item.id);
    const others = tagsOf(current).filter((other) => isSlotTag(this.host.ns, other) && other !== tag);
    const scopeTag = this.host.scopeTag(next.scope);
    const add = scopeTag && !tagsOf(current).includes(scopeTag) ? [tag, scopeTag] : [tag];
    await this.host.retag(item, add, others).catch(() => {});
    this._setSlot(index, next);
    this.host.toast(`Super+${n}: ${slotLabel(next)}`, { detail: next.scope === "global" ? "Kept everywhere." : "" });
  }

  /** The slot `item` holds here, or -1. */
  slotOfItem(item, world = worldOf(this.host)) {
    return this.slots.findIndex((slot) => {
      const thing = findThing(slot, this.host, world);
      return thing ? thingItem(thing).kind === item.kind && thingItem(thing).id === item.id : false;
    });
  }
}

/**
 * Defines the dock's actions on `keymap` (keys.js): Super+1…9 run a slot,
 * Super+Ctrl+1…9 in the other layout, Super+Shift+1…9 put what has the
 * keyboard there, Super+Ctrl+Shift+1…9 a new window of it. `keys` changes
 * the defaults per action kind ({ slot, other, assign, new }: a function of
 * n giving combos), `layoutToggle` Super+Up's (none by default).
 */
export function defineDockActions(keymap, dock, { group = "Dock", keys = {}, layoutToggle = [] } = {}) {
  const combos = {
    slot: (n) => [`Super+Digit${n}`],
    other: (n) => [`Super+Ctrl+Digit${n}`],
    assign: (n) => [`Super+Shift+Digit${n}`],
    new: (n) => [`Super+Ctrl+Shift+Digit${n}`],
    ...keys,
  };
  for (let n = 1; n <= DOCK_KEY_COUNT; n++) {
    keymap.define(`dock.slot.${n}`, { group, label: `Open dock slot ${n}`, keys: combos.slot(n), run: () => void dock.activate(n - 1), repeat: false, hotkey: n === 1 });
    keymap.define(`dock.slotOther.${n}`, { group, label: `Open dock slot ${n} in the other layout`, keys: combos.other(n), run: () => void dock.activate(n - 1, { other: true }), repeat: false });
    keymap.define(`dock.assign.${n}`, { group, label: `Put the focused window in dock slot ${n}`, keys: combos.assign(n), run: () => void dock.assign(n - 1), repeat: false, hotkey: n === 1 });
    keymap.define(`dock.new.${n}`, { group, label: `New window of dock slot ${n}`, keys: combos.new(n), run: () => void dock.newWindow(n - 1), repeat: false });
  }
  keymap.define("dock.toggleLayout", {
    group, label: "The open dock slot's other layout, kept here", keys: layoutToggle, repeat: false,
    run: () => {
      const key = dock.host.contextKey();
      const back = dock._returnTo.get(key);
      const index = back ? dock.slots.findIndex((slot) => slot?.id === back.slotId) : -1;
      if (index < 0) return;
      const now = dock.contextLayout(index) ?? dock.slot(index).layout;
      dock.setContextLayout(index, now === "fold" ? "split" : "fold");
      void dock.activate(index);
    },
  });
}

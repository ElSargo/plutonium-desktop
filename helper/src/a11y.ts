// Native windows as accessibility trees (AT-SPI), for agents: read_window and
// act_window. Apps that support accessibility (GTK, Qt, LibreOffice, ...) put
// their windows on the accessibility bus; this finds a window's frame there by
// the app's pid and the window's title, reads it as an outline with refs, and
// acts on an element by its ref (its action, focus, text, value, selection).
import { DBusConnection, DBusError } from "./dbus.ts";

const ACCESSIBLE = "org.a11y.atspi.Accessible";
const PROPERTIES = "org.freedesktop.DBus.Properties";
const REGISTRY_ROOT = { bus: "org.a11y.atspi.Registry", path: "/org/a11y/atspi/accessible/root" };
// AtspiCoordType: relative to the window.
const COORD_WINDOW = 1;

// AtspiStateType, by bit.
const STATE = {
  active: 1,
  checked: 4,
  collapsed: 5,
  defunct: 6,
  editable: 7,
  enabled: 8,
  expandable: 9,
  expanded: 10,
  focused: 12,
  modal: 16,
  pressed: 20,
  selected: 23,
  sensitive: 24,
  showing: 25,
  indeterminate: 32,
  checkable: 41,
  readOnly: 43,
} as const;

// An outline's limits.
const MAX_NODES = 1500;
const MAX_DEPTH = 40;
// Children beyond this (a spreadsheet's cells) aren't read.
const MAX_CHILDREN = 400;
const MAX_TEXT = 300;
// Calls in flight at once, so a big tree doesn't flood the app.
const CONCURRENCY = 32;

/** An object on the accessibility bus. */
interface Ref {
  readonly bus: string;
  readonly path: string;
}

/** The window an outline is for, as the helper knows it. */
export interface A11yWindow {
  readonly id: number;
  readonly pid: number;
  readonly title: string;
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
}

export class A11yError extends Error {}

function hasState(states: readonly number[], bit: number): boolean {
  return ((states[bit >> 5] ?? 0) & (1 << (bit & 31))) !== 0;
}

function quote(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return JSON.stringify(flat.length > max ? `${flat.slice(0, max)}…` : flat);
}

/** Roles that only group others: left out of an outline when they have no name. */
const STRUCTURAL = new Set(["filler", "panel", "unknown", "section", "scroll pane", "viewport", "layered pane", "redundant object", "invalid"]);
/** Roles whose value means something (buttons have one too, in some toolkits). */
const VALUED = new Set(["slider", "spin button", "progress bar", "scroll bar", "level bar", "dial"]);
/** Roles left out of an outline altogether. */
const NOISE = new Set(["separator"]);
/** Actions that mean "click it", most likely first. */
const CLICK_ACTIONS = ["click", "press", "activate", "jump", "toggle", "open", "select"];

interface Node {
  readonly ref: Ref;
  readonly role: string;
  readonly name: string;
  readonly description: string;
  readonly states: readonly number[];
  readonly interfaces: readonly string[];
  readonly childCount: number;
  readonly extents?: readonly [number, number, number, number];
  readonly text?: string;
  readonly value?: { current: number; min: number; max: number };
  readonly actions?: readonly string[];
}

class Limiter {
  private running = 0;
  private readonly queue: (() => void)[] = [];
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }
}

export class Accessibility {
  private connecting: Promise<DBusConnection> | null = null;
  private readonly roleNames = new Map<number, string>();
  /** Per window: ref name ↔ object, stable across reads. */
  private readonly refs = new Map<number, { byName: Map<string, Ref>; byKey: Map<string, string>; next: number }>();

  /** The accessibility bus (found through the session bus), connected once. */
  private async bus(): Promise<DBusConnection> {
    if (this.connecting) {
      const connection = await this.connecting.catch(() => null);
      if (connection?.isOpen) return connection;
    }
    this.connecting = (async () => {
      const sessionAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
      if (!sessionAddress) throw new A11yError("No session bus (DBUS_SESSION_BUS_ADDRESS), so no accessibility bus.");
      const session = await DBusConnection.connect(sessionAddress);
      try {
        const [address] = (await session.call({
          destination: "org.a11y.Bus",
          path: "/org/a11y/bus",
          interface: "org.a11y.Bus",
          member: "GetAddress",
        })) as [string];
        return await DBusConnection.connect(address);
      } catch (error) {
        throw new A11yError(`No accessibility bus (at-spi2-core): ${(error as Error).message}`);
      } finally {
        session.close();
      }
    })();
    return this.connecting;
  }

  private async call(ref: Ref, iface: string, member: string, signature = "", body: unknown[] = []): Promise<unknown[]> {
    const bus = await this.bus();
    return bus.call({ destination: ref.bus, path: ref.path, interface: iface, member, signature, body });
  }

  private async property(ref: Ref, iface: string, name: string): Promise<unknown> {
    const [value] = await this.call(ref, PROPERTIES, "Get", "ss", [iface, name]);
    return value;
  }

  private async roleName(ref: Ref, role: number): Promise<string> {
    const known = this.roleNames.get(role);
    if (known !== undefined) return known;
    const [name] = (await this.call(ref, ACCESSIBLE, "GetRoleName")) as [string];
    this.roleNames.set(role, name);
    return name;
  }

  private async children(ref: Ref): Promise<Ref[]> {
    const [children] = (await this.call(ref, ACCESSIBLE, "GetChildren")) as [[string, string][]];
    return children.filter(([, path]) => path !== "/org/a11y/atspi/null").map(([bus, path]) => ({ bus, path }));
  }

  /** The frame on the accessibility bus that is `window`. */
  private async frameOf(window: A11yWindow): Promise<Ref> {
    const bus = await this.bus();
    const apps = await this.children(REGISTRY_ROOT);
    const pidOf = async (app: Ref) => {
      try {
        const [pid] = (await bus.call({
          destination: "org.freedesktop.DBus",
          path: "/org/freedesktop/DBus",
          interface: "org.freedesktop.DBus",
          member: "GetConnectionUnixProcessID",
          signature: "s",
          body: [app.bus],
        })) as [number];
        return pid;
      } catch {
        return 0;
      }
    };
    const pids = await Promise.all(apps.map(pidOf));
    const own = apps.filter((_, index) => pids[index] === window.pid);
    // The app's own first; another process's (a wrapper's child, an X11 app
    // through Xwayland) by title.
    for (const candidates of [own, apps.filter((app) => !own.includes(app))]) {
      const frames: { ref: Ref; name: string; states: number[]; size?: [number, number] }[] = [];
      for (const app of candidates) {
        let children: Ref[];
        try {
          children = await this.children(app);
        } catch {
          continue;
        }
        for (const ref of children) {
          try {
            const [name, [states]] = await Promise.all([
              this.property(ref, ACCESSIBLE, "Name") as Promise<string>,
              this.call(ref, ACCESSIBLE, "GetState") as Promise<[number[]]>,
            ]);
            frames.push({ ref, name, states });
          } catch {
            // Gone meanwhile.
          }
        }
      }
      const titled = frames.filter((frame) => frame.name === window.title && window.title !== "");
      if (titled.length === 1) return titled[0]!.ref;
      if (candidates !== own) continue;
      const pool = titled.length > 1 ? titled : frames.filter((frame) => !hasState(frame.states, STATE.defunct));
      if (pool.length === 1) return pool[0]!.ref;
      if (pool.length > 1) {
        // Several windows of the app: the one its size matches, else the active one.
        for (const frame of pool) {
          try {
            const [[, , w, h]] = (await this.call(frame.ref, "org.a11y.atspi.Component", "GetExtents", "u", [COORD_WINDOW])) as [
              [number, number, number, number],
            ];
            if (Math.abs(w - window.width) <= 2 && Math.abs(h - window.height) <= 2) return frame.ref;
          } catch {
            // No Component.
          }
        }
        const active = pool.find((frame) => hasState(frame.states, STATE.active));
        return (active ?? pool[0]!).ref;
      }
    }
    if (own.length === 0) {
      throw new A11yError(
        "This app isn't on the accessibility bus: it has no accessibility support, or it's off (Qt apps need " +
          "QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1, Electron and Chromium apps --force-renderer-accessibility). " +
          "Use snapshot_window instead.",
      );
    }
    throw new A11yError("The app is on the accessibility bus, but none of its windows is this one.");
  }

  private async node(ref: Ref, limiter: Limiter): Promise<Node> {
    const run = <T>(task: () => Promise<T>) => limiter.run(task);
    const [props, [role], [states], [interfaces]] = await Promise.all([
      run(() => this.call(ref, PROPERTIES, "GetAll", "s", [ACCESSIBLE])) as Promise<[Map<string, unknown>]>,
      run(() => this.call(ref, ACCESSIBLE, "GetRole")) as Promise<[number]>,
      run(() => this.call(ref, ACCESSIBLE, "GetState")) as Promise<[number[]]>,
      run(() => this.call(ref, ACCESSIBLE, "GetInterfaces")) as Promise<[string[]]>,
    ]).then(([[all], ...rest]) => [all, ...rest] as [Map<string, unknown>, [number], [number[]], [string[]]]);
    const has = (name: string) => interfaces.includes(`org.a11y.atspi.${name}`);
    const roleName = await run(() => this.roleName(ref, role));
    const optional = async <T>(task: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await run(task);
      } catch {
        return undefined;
      }
    };
    const [extents, text, value, actions] = await Promise.all([
      has("Component")
        ? optional(async () => {
            const [box] = (await this.call(ref, "org.a11y.atspi.Component", "GetExtents", "u", [COORD_WINDOW])) as [
              [number, number, number, number],
            ];
            return box;
          })
        : undefined,
      has("Text")
        ? optional(async () => {
            const count = (await this.property(ref, "org.a11y.atspi.Text", "CharacterCount")) as number;
            if (!count) return "";
            const [text] = (await this.call(ref, "org.a11y.atspi.Text", "GetText", "ii", [0, Math.min(count, MAX_TEXT + 1)])) as [string];
            return text;
          })
        : undefined,
      has("Value")
        ? optional(async () => {
            const [all] = (await this.call(ref, PROPERTIES, "GetAll", "s", ["org.a11y.atspi.Value"])) as [Map<string, number>];
            return { current: all.get("CurrentValue") ?? 0, min: all.get("MinimumValue") ?? 0, max: all.get("MaximumValue") ?? 0 };
          })
        : undefined,
      has("Action")
        ? optional(async () => {
            const [list] = (await this.call(ref, "org.a11y.atspi.Action", "GetActions")) as [[string, string, string][]];
            return list.map(([name]) => name);
          })
        : undefined,
    ]);
    return {
      ref,
      role: roleName,
      name: String(props.get("Name") ?? ""),
      description: String(props.get("Description") ?? ""),
      states,
      interfaces,
      childCount: Number(props.get("ChildCount") ?? 0),
      ...(extents ? { extents } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(value ? { value } : {}),
      ...(actions ? { actions } : {}),
    };
  }

  private refName(windowId: number, ref: Ref): string {
    let table = this.refs.get(windowId);
    if (!table) {
      table = { byName: new Map(), byKey: new Map(), next: 1 };
      this.refs.set(windowId, table);
    }
    const key = `${ref.bus}${ref.path}`;
    let name = table.byKey.get(key);
    if (!name) {
      name = `a${table.next++}`;
      table.byKey.set(key, name);
      table.byName.set(name, ref);
    }
    return name;
  }

  private resolve(windowId: number, ref: string): Ref {
    const found = this.refs.get(windowId)?.byName.get(ref);
    if (!found) throw new A11yError(`No element ${ref} in this window: read_window gives the refs.`);
    return found;
  }

  /** Forgets the refs of windows that are gone. */
  prune(existing: ReadonlySet<number>): void {
    for (const id of this.refs.keys()) if (!existing.has(id)) this.refs.delete(id);
  }

  /**
   * `window` (or the element `ref` in it) as an outline: one line per element,
   * with its role, name, states, center in snapshot pixels and ref. Hidden
   * elements are left out unless `all`.
   */
  async read(window: A11yWindow, options: { ref?: string; all?: boolean } = {}): Promise<string> {
    const root = options.ref ? this.resolve(window.id, options.ref) : await this.frameOf(window);
    const limiter = new Limiter(CONCURRENCY);
    const scale = window.deviceScaleFactor || 1;
    let count = 0;
    let truncated = false;
    const lines: string[] = [];

    const describe = (node: Node): string => {
      const parts = [`- ${node.role}`];
      if (node.name) parts.push(quote(node.name));
      parts.push(`[ref=${this.refName(window.id, node.ref)}]`);
      const flags: string[] = [];
      const state = (bit: number) => hasState(node.states, bit);
      if (state(STATE.focused)) flags.push("focused");
      if (state(STATE.checked)) flags.push("checked");
      else if (state(STATE.checkable)) flags.push("unchecked");
      if (state(STATE.indeterminate)) flags.push("mixed");
      if (state(STATE.pressed)) flags.push("pressed");
      if (state(STATE.selected)) flags.push("selected");
      if (state(STATE.expandable)) flags.push(state(STATE.expanded) ? "expanded" : "collapsed");
      if (!state(STATE.enabled) && !state(STATE.sensitive)) flags.push("disabled");
      if (state(STATE.editable) && !state(STATE.readOnly)) flags.push("editable");
      if (state(STATE.modal)) flags.push("modal");
      if (flags.length) parts.push(`(${flags.join(", ")})`);
      if (node.value && VALUED.has(node.role)) {
        parts.push(`value=${node.value.current} (${node.value.min}–${node.value.max})`);
      }
      if (node.extents) {
        const [x, y, w, h] = node.extents;
        if (w > 0 && h > 0 && x + w > 0 && y + h > 0 && x < window.width && y < window.height) {
          parts.push(`@${Math.round((x + w / 2) * scale)},${Math.round((y + h / 2) * scale)}`);
        }
      }
      const others = node.actions?.filter((action) => action && !CLICK_ACTIONS.includes(action.toLowerCase())) ?? [];
      if (others.length) parts.push(`actions: ${others.join(", ")}`);
      let line = parts.join(" ");
      if (node.text && node.text.trim() && node.text.trim() !== node.name.trim()) line += `: ${quote(node.text, MAX_TEXT)}`;
      else if (node.description && node.description !== node.name) line += ` — ${quote(node.description, 80)}`;
      return line;
    };

    // Each subtree's lines, in order; read with siblings in parallel.
    const walk = async (ref: Ref, depth: number): Promise<string[]> => {
      if (count >= MAX_NODES || depth > MAX_DEPTH) {
        truncated = true;
        return [];
      }
      count++;
      let node: Node;
      try {
        node = await this.node(ref, limiter);
      } catch (error) {
        if (error instanceof DBusError) return [];
        throw error;
      }
      if (depth > 0 && !options.all && !hasState(node.states, STATE.showing)) return [];
      if (NOISE.has(node.role)) return [];
      const skip =
        depth > 0 && STRUCTURAL.has(node.role) && !node.name && !node.text?.trim() && !node.actions?.length;
      const indent = "  ".repeat(skip ? depth - 1 : depth);
      const own = skip ? [] : [`${"  ".repeat(depth)}${describe(node)}`];
      if (node.childCount === 0) return own;
      // A spreadsheet's cells, a long list's rows.
      if (node.childCount > MAX_CHILDREN) {
        return [...own, `${indent}  - (${node.childCount} children, not read)`];
      }
      let children: Ref[];
      try {
        children = await limiter.run(() => this.children(ref));
      } catch {
        return own;
      }
      const nested = await Promise.all(children.map((child) => walk(child, skip ? depth : depth + 1)));
      return [...own, ...nested.flat()];
    };

    lines.push(...(await walk(root, 0)));
    if (truncated) lines.push(`(stopped after ${MAX_NODES} elements: read_window with a ref reads one part)`);
    return lines.join("\n");
  }

  /** Acts on element `ref` of `window`. Returns a point to click when the element has no action of its own. */
  async act(
    window: A11yWindow,
    ref: string,
    action: string,
    args: { text?: string; value?: number },
  ): Promise<{ done: string } | { click: [number, number] }> {
    const target = this.resolve(window.id, ref);
    const [interfacesReply] = (await this.call(target, ACCESSIBLE, "GetInterfaces")) as [string[]];
    const has = (name: string) => interfacesReply.includes(`org.a11y.atspi.${name}`);
    const center = async (): Promise<[number, number] | null> => {
      if (!has("Component")) return null;
      const [[x, y, w, h]] = (await this.call(target, "org.a11y.atspi.Component", "GetExtents", "u", [COORD_WINDOW])) as [
        [number, number, number, number],
      ];
      if (w <= 0 || h <= 0) return null;
      const scale = window.deviceScaleFactor || 1;
      return [Math.round((x + w / 2) * scale), Math.round((y + h / 2) * scale)];
    };
    const ok = (value: unknown, what: string) => {
      if (value === false) throw new A11yError(`The app refused to ${what}.`);
      return { done: what };
    };
    switch (action) {
      case "click": {
        if (has("Action")) {
          const [list] = (await this.call(target, "org.a11y.atspi.Action", "GetActions")) as [[string, string, string][]];
          const names = list.map(([name]) => name.toLowerCase());
          const index = CLICK_ACTIONS.map((name) => names.indexOf(name)).find((at) => at >= 0) ?? (names.length ? 0 : -1);
          if (index >= 0) {
            const [done] = await this.call(target, "org.a11y.atspi.Action", "DoAction", "i", [index]);
            return ok(done, list[index]![0] || "click");
          }
        }
        const point = await center();
        if (!point) throw new A11yError("The element has no action and no place on screen to click.");
        return { click: point };
      }
      case "focus": {
        if (!has("Component")) throw new A11yError("The element can't take focus.");
        const [done] = await this.call(target, "org.a11y.atspi.Component", "GrabFocus");
        return ok(done, "focus");
      }
      case "set_text": {
        if (typeof args.text !== "string") throw new A11yError("set_text needs text.");
        if (!has("EditableText")) throw new A11yError("The element's text isn't editable: click it and use type_window.");
        const [done] = await this.call(target, "org.a11y.atspi.EditableText", "SetTextContents", "s", [args.text]);
        return ok(done, "set the text");
      }
      case "set_value": {
        if (typeof args.value !== "number") throw new A11yError("set_value needs a value.");
        if (!has("Value")) throw new A11yError("The element has no value.");
        await this.call(target, PROPERTIES, "Set", "ssv", ["org.a11y.atspi.Value", "CurrentValue", ["d", args.value]]);
        return { done: "set the value" };
      }
      case "select": {
        const [bus, path] = (await this.property(target, ACCESSIBLE, "Parent")) as [string, string];
        const parentRef = bus && path && path !== "/org/a11y/atspi/null" ? { bus, path } : null;
        const [index] = (await this.call(target, ACCESSIBLE, "GetIndexInParent")) as [number];
        if (parentRef) {
          const [parentInterfaces] = (await this.call(parentRef, ACCESSIBLE, "GetInterfaces")) as [string[]];
          if (parentInterfaces.includes("org.a11y.atspi.Selection")) {
            const [done] = await this.call(parentRef, "org.a11y.atspi.Selection", "SelectChild", "i", [index]);
            return ok(done, "select it");
          }
        }
        return this.act(window, ref, "click", args);
      }
      case "scroll_into_view": {
        if (!has("Component")) throw new A11yError("The element can't be scrolled to.");
        // ATSPI_SCROLL_ANYWHERE.
        const [done] = await this.call(target, "org.a11y.atspi.Component", "ScrollTo", "u", [6]);
        return ok(done, "scroll to it");
      }
      default: {
        // One of the element's own actions, by name.
        if (!has("Action")) throw new A11yError(`The element has no action "${action}".`);
        const [list] = (await this.call(target, "org.a11y.atspi.Action", "GetActions")) as [[string, string, string][]];
        const index = list.findIndex(([name]) => name.toLowerCase() === action.toLowerCase());
        if (index < 0) {
          throw new A11yError(
            `The element has no action "${action}". Its actions: ${list.map(([name]) => name).join(", ") || "none"}; ` +
              "or use click, focus, set_text, set_value, select, scroll_into_view.",
          );
        }
        const [done] = await this.call(target, "org.a11y.atspi.Action", "DoAction", "i", [index]);
        return ok(done, list[index]![0]);
      }
    }
  }
}

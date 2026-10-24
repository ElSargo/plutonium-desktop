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
// A big table (a spreadsheet's millions of cells): only its visible cells are
// read, at most this many.
const MAX_CELLS = 1000;
// How long one call may take before the app counts as not answering; a read
// stops at the first call that doesn't answer, and after its whole budget.
const CALL_TIMEOUT_MS = 4_000;
const READ_BUDGET_MS = 20_000;

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

/** A call the app didn't answer in time. */
class NoAnswer extends Error {
  readonly bus: string;
  constructor(bus: string, what: string) {
    super(what);
    this.bus = bus;
  }
}

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
  /** Gone from the app (a closed popup, a cell's old object): nothing else is asked of it. */
  readonly defunct?: boolean;
  readonly extents?: readonly [number, number, number, number];
  readonly text?: string;
  readonly value?: { current: number; min: number; max: number };
  readonly actions?: readonly string[];
}

class Limiter {
  /** Once set, calls not yet started fail with it at once. */
  stopped: Error | null = null;
  private running = 0;
  private readonly queue: (() => void)[] = [];
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.running++;
    if (this.stopped) {
      this.running--;
      this.queue.shift()?.();
      throw this.stopped;
    }
    try {
      return await task();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }
}

export class Accessibility {
  private readonly callTimeoutMs: number;
  private readonly readBudgetMs: number;
  private connecting: Promise<DBusConnection> | null = null;
  private readonly roleNames = new Map<number, string>();
  /** Per window: ref name ↔ object, stable across reads. */
  private readonly refs = new Map<number, { byName: Map<string, Ref>; byKey: Map<string, string>; next: number }>();

  constructor(options: { callTimeoutMs?: number; readBudgetMs?: number } = {}) {
    this.callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
    this.readBudgetMs = options.readBudgetMs ?? READ_BUDGET_MS;
  }

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
    try {
      return await bus.call({
        destination: ref.bus,
        path: ref.path,
        interface: iface,
        member,
        signature,
        body,
        timeoutMs: this.callTimeoutMs,
      });
    } catch (error) {
      if (!(error instanceof DBusError) && bus.isOpen && /timed out/.test((error as Error).message)) {
        const what = iface !== PROPERTIES ? `${iface}.${member}` : member === "Get" ? `${body[0]}.${body[1]}` : `${member} ${body[0]}`;
        throw new NoAnswer(ref.bus, what);
      }
      throw error;
    }
  }

  /** Whether the app at `bus` is still on the accessibility bus (it's gone when it quit or crashed). */
  private async present(bus: string): Promise<boolean> {
    try {
      await (await this.bus()).call({
        destination: "org.freedesktop.DBus",
        path: "/org/freedesktop/DBus",
        interface: "org.freedesktop.DBus",
        member: "GetConnectionUnixProcessID",
        signature: "s",
        body: [bus],
        timeoutMs: this.callTimeoutMs,
      });
      return true;
    } catch (error) {
      return !(error instanceof DBusError);
    }
  }

  /** What to tell the agent when the app didn't answer `error`'s call. */
  private async noAnswer(error: NoAnswer, read: number): Promise<string> {
    const seconds = Math.round(this.callTimeoutMs / 100) / 10;
    const what = `The app didn't answer (${error.message}: no reply in ${seconds} s)${read ? ` after ${read} elements` : ""}`;
    return (await this.present(error.bus))
      ? `${what}. It's still running but busy or hung: wait and read again, or use snapshot_window.`
      : `${what}, and it's gone: it quit or crashed. list_windows shows what's left.`;
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
    // An app that didn't answer, said when its window isn't found otherwise.
    let silent: NoAnswer | undefined;
    const own = apps.filter((_, index) => pids[index] === window.pid);
    // The app's own first; another process's (a wrapper's child, an X11 app
    // through Xwayland) by title.
    for (const candidates of [own, apps.filter((app) => !own.includes(app))]) {
      const frames: { ref: Ref; name: string; states: number[]; size?: [number, number] }[] = [];
      for (const app of candidates) {
        let children: Ref[];
        try {
          children = await this.children(app);
        } catch (error) {
          if (error instanceof NoAnswer && candidates === own) silent ??= error;
          continue;
        }
        for (const ref of children) {
          try {
            const [name, [states]] = await Promise.all([
              this.property(ref, ACCESSIBLE, "Name") as Promise<string>,
              this.call(ref, ACCESSIBLE, "GetState") as Promise<[number[]]>,
            ]);
            frames.push({ ref, name, states });
          } catch (error) {
            // Gone meanwhile.
            if (error instanceof NoAnswer && candidates === own) silent ??= error;
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
    if (silent) throw silent;
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
    // The state first: a defunct object is asked nothing else. And no
    // GetAll(Accessible): it includes Locale, which aborts LibreOffice Calc on
    // its cells' and input line's objects.
    const [states] = (await run(() => this.call(ref, ACCESSIBLE, "GetState"))) as [number[]];
    if (hasState(states, STATE.defunct)) {
      return { ref, role: "", name: "", description: "", states, interfaces: [], childCount: 0, defunct: true };
    }
    // A property the app doesn't have is left out.
    const property = (name: string) =>
      run(() => this.property(ref, ACCESSIBLE, name)).catch((error) => {
        if (error instanceof DBusError) return undefined;
        throw error;
      });
    const [[role], [interfaces], name, description, childCount] = (await Promise.all([
      run(() => this.call(ref, ACCESSIBLE, "GetRole")),
      run(() => this.call(ref, ACCESSIBLE, "GetInterfaces")),
      property("Name"),
      property("Description"),
      property("ChildCount"),
    ])) as [[number], [string[]], unknown, unknown, unknown];
    const has = (name: string) => interfaces.includes(`org.a11y.atspi.${name}`);
    const roleName = await run(() => this.roleName(ref, role));
    const optional = async <T>(task: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await run(task);
      } catch (error) {
        if (error instanceof NoAnswer) throw error;
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
      name: String(name ?? ""),
      description: String(description ?? ""),
      states,
      interfaces,
      childCount: Number(childCount ?? 0),
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
    let root: Ref;
    try {
      root = options.ref ? this.resolve(window.id, options.ref) : await this.frameOf(window);
    } catch (error) {
      if (error instanceof NoAnswer) throw new A11yError(await this.noAnswer(error, 0));
      throw error;
    }
    const limiter = new Limiter(CONCURRENCY);
    const scale = window.deviceScaleFactor || 1;
    const deadline = Date.now() + this.readBudgetMs;
    let count = 0;
    let truncated = false;
    let stalled: NoAnswer | null = null;
    let outOfTime = false;
    const lines: string[] = [];
    // Stops the whole read: the calls not yet made fail at once.
    const stop = (error: unknown) => {
      if (error instanceof NoAnswer) stalled ??= error;
      limiter.stopped ??= error as Error;
    };
    const timer = setTimeout(() => {
      outOfTime = true;
      stop(new Error("out of time"));
    }, Math.max(0, deadline - Date.now()));

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

    // A big table's visible cells: the ones with text, and the focused one.
    // Null when its visible part can't be found.
    const cells = async (table: Node, indent: string): Promise<string[] | null> => {
      if (!table.extents || !table.interfaces.includes("org.a11y.atspi.Component")) return null;
      const [x, y, w, h] = table.extents;
      const left = Math.max(x, 0);
      const top = Math.max(y, 0);
      const right = Math.min(x + w, window.width) - 1;
      const bottom = Math.min(y + h, window.height) - 1;
      if (right <= left || bottom <= top) return null;
      const TABLE = "org.a11y.atspi.Table";
      const run = <T>(task: () => Promise<T>) => limiter.run(task);
      const cellAt = async (px: number, py: number): Promise<[number, number] | null> => {
        const [[bus, path]] = (await run(() =>
          this.call(table.ref, "org.a11y.atspi.Component", "GetAccessibleAtPoint", "iiu", [px, py, COORD_WINDOW]),
        )) as [[string, string]];
        if (!bus || path === "/org/a11y/atspi/null") return null;
        const [index] = (await run(() => this.call({ bus, path }, ACCESSIBLE, "GetIndexInParent"))) as [number];
        if (index < 0) return null;
        const [[row], [column]] = (await Promise.all([
          run(() => this.call(table.ref, TABLE, "GetRowAtIndex", "i", [index])),
          run(() => this.call(table.ref, TABLE, "GetColumnAtIndex", "i", [index])),
        ])) as [[number], [number]];
        return row >= 0 && column >= 0 ? [row, column] : null;
      };
      let first: [number, number] | null;
      let last: [number, number] | null;
      let size: [number, number];
      try {
        [first, last, size] = await Promise.all([
          cellAt(left + 1, top + 1),
          cellAt(right - 1, bottom - 1),
          Promise.all([this.property(table.ref, TABLE, "NRows"), this.property(table.ref, TABLE, "NColumns")]).then(
            ([rows, columns]) => [Number(rows), Number(columns)] as [number, number],
          ),
        ]);
      } catch (error) {
        if (error instanceof NoAnswer) throw error;
        return null;
      }
      if (!first || !last) return null;
      const columns = Math.min(last[1] - first[1] + 1, MAX_CELLS);
      const visibleRows = last[0] - first[0] + 1;
      const rows = Math.min(visibleRows, Math.max(1, Math.floor(MAX_CELLS / columns)));
      const positions: [number, number][] = [];
      for (let row = first[0]; row < first[0] + rows; row++) {
        for (let column = first[1]; column < first[1] + columns; column++) positions.push([row, column]);
      }
      const read = await Promise.all(
        positions.map(async ([row, column]) => {
          const [[bus, path]] = (await run(() => this.call(table.ref, TABLE, "GetAccessibleAt", "ii", [row, column]))) as [
            [string, string],
          ];
          if (!bus || path === "/org/a11y/atspi/null") return null;
          try {
            return await this.node({ bus, path }, limiter);
          } catch (error) {
            if (error instanceof DBusError) return null;
            throw error;
          }
        }),
      );
      const shown = read.filter(
        (cell): cell is Node =>
          cell !== null && !cell.defunct && (!!cell.text?.trim() || hasState(cell.states, STATE.focused)),
      );
      const name = (cell: Node | null | undefined, [row, column]: [number, number]) =>
        cell?.name ? cell.name : `row ${row + 1}, column ${column + 1}`;
      const corner = name(read.at(-1), positions.at(-1)!);
      const cut = rows < visibleRows || columns < last[1] - first[1] + 1;
      return [
        `${indent}  - (${size[0]} rows × ${size[1]} columns; read the ${cut ? `first ${positions.length} ` : ""}visible cells, ` +
          `${name(read[0], positions[0]!)} to ${corner}: ${shown.length ? "the empty ones left out" : "all empty"}. ` +
          "Scroll the window to read others.)",
        ...shown.map((cell) => `${indent}  ${describe(cell)}`),
      ];
    };

    // Each subtree's lines, in order; read with siblings in parallel.
    const walk = async (ref: Ref, depth: number): Promise<string[]> => {
      if (limiter.stopped) return [];
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
        stop(error);
        return [];
      }
      if (node.defunct) return [];
      if (depth > 0 && !options.all && !hasState(node.states, STATE.showing)) return [];
      if (NOISE.has(node.role)) return [];
      const skip =
        depth > 0 && STRUCTURAL.has(node.role) && !node.name && !node.text?.trim() && !node.actions?.length;
      const indent = "  ".repeat(skip ? depth - 1 : depth);
      const own = skip ? [] : [`${"  ".repeat(depth)}${describe(node)}`];
      if (node.childCount === 0) return own;
      // A spreadsheet's cells, a long list's rows.
      if (node.childCount > MAX_CHILDREN) {
        let visible: string[] | null = null;
        if (node.interfaces.includes("org.a11y.atspi.Table")) {
          try {
            visible = await cells(node, indent);
          } catch (error) {
            stop(error);
            return own;
          }
        }
        return [...own, ...(visible ?? [`${indent}  - (${node.childCount} children, not read)`])];
      }
      let children: Ref[];
      try {
        children = await limiter.run(() => this.children(ref));
      } catch (error) {
        if (!(error instanceof DBusError)) stop(error);
        return own;
      }
      const nested = await Promise.all(children.map((child) => walk(child, skip ? depth : depth + 1)));
      return [...own, ...nested.flat()];
    };

    try {
      lines.push(...(await walk(root, 0)));
    } finally {
      clearTimeout(timer);
    }
    if (stalled) {
      const message = await this.noAnswer(stalled, count);
      if (lines.length === 0) throw new A11yError(message);
      lines.push(`(${message} What's above is what was read.)`);
    } else if (outOfTime) {
      lines.push(`(stopped after ${Math.round(this.readBudgetMs / 1000)} s and ${count} elements: read_window with a ref reads one part)`);
    } else if (limiter.stopped) {
      throw limiter.stopped;
    } else if (truncated) {
      lines.push(`(stopped after ${MAX_NODES} elements: read_window with a ref reads one part)`);
    }
    return lines.join("\n");
  }

  /** Acts on element `ref` of `window`. Returns a point to click when the element has no action of its own. */
  async act(
    window: A11yWindow,
    ref: string,
    action: string,
    args: { text?: string; value?: number },
  ): Promise<{ done: string } | { click: [number, number] }> {
    try {
      return await this.actOn(window, ref, action, args);
    } catch (error) {
      if (error instanceof NoAnswer) throw new A11yError(await this.noAnswer(error, 0));
      throw error;
    }
  }

  private async actOn(
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
        return this.actOn(window, ref, "click", args);
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

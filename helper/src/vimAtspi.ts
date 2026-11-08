// Pluto Vim's fallback for apps without text-input-v3 (PLUTO_VIM.md,
// "Fallback: AT-SPI"): Xwayland apps, older toolkits, a GTK app without its
// Wayland input method. The helper hears which element has focus over the
// accessibility bus; when it's editable text, it asks Exo to hold that
// window's keys as it does a text-input-v3 field's (Plutonium.setVimWindowField),
// and the same engine (vimNative.ts) runs over an AtspiBuffer:
// - text, caret and selection from AT-SPI's Text, read again before each key;
// - motions exact, by Text.SetCaretOffset and SetSelection;
// - edits by EditableText.DeleteText and InsertText;
// - undo and redo the app's own Ctrl+Z.
// Every motion and edit is a D-Bus round trip, so it's the slowest backend.
// AT-SPI counts characters (code points); the engine, UTF-16 units.
import { DBusConnection, type Message } from "./dbus.ts";
import type { BrowserCdp } from "./cdp.ts";
import type { NativeHost, VimField } from "./vimNative.ts";

/** An editable text element, as AT-SPI has it (offsets in characters). */
export interface AtspiField {
  read(): Promise<{ text: string; caret: number; selection: [number, number] | null }>;
  setCaret(offset: number): Promise<void>;
  select(start: number, end: number): Promise<void>;
  deleteText(start: number, end: number): Promise<void>;
  insertText(at: number, text: string): Promise<void>;
}

/** UTF-16 offset → character offset, and back. */
export function toChars(text: string, offset: number): number {
  return [...text.slice(0, offset)].length;
}
export function fromChars(text: string, chars: number): number {
  let units = 0;
  let n = 0;
  for (const ch of text) {
    if (n++ >= chars) break;
    units += ch.length;
  }
  return units;
}

/** A Buffer (PLUTO_VIM.md, The Buffer interface) over an AT-SPI text element. */
export class AtspiBuffer {
  readonly kind = "atspi";
  readonly caps = { exactMotions: true, wholeText: true, selection: true, undo: "keys" as const };
  readonly field: { singleLine: boolean; purpose: string; windowId: number };
  state: VimField;
  private readonly element: AtspiField;
  private readonly host: NativeHost;

  constructor(element: AtspiField, host: NativeHost, ids: { fieldId: number; windowId: number }, singleLine = false) {
    this.element = element;
    this.host = host;
    this.field = { singleLine, purpose: "normal", windowId: ids.windowId };
    this.state = { id: ids.fieldId, windowId: ids.windowId, text: "", cursor: 0, anchor: 0, hint: 0, purpose: 0 };
  }

  /** What the element has now (before each key: the app may have changed it). */
  async refresh(): Promise<void> {
    const { text, caret, selection } = await this.element.read();
    let cursor = fromChars(text, caret);
    let anchor = cursor;
    if (selection && selection[0] !== selection[1]) {
      const [a, b] = [fromChars(text, selection[0]), fromChars(text, selection[1])];
      anchor = cursor === a ? b : a;
      cursor = cursor === a ? a : b;
    }
    this.state = { ...this.state, text, cursor, anchor };
  }

  update(field: VimField): void {
    this.state = field;
  }

  text() {
    const { text, cursor, anchor } = this.state;
    return { text, start: 0, cursor, anchor };
  }

  async move(to: { offset: number; extend?: boolean } | { by: string }): Promise<void> {
    if (!("offset" in to)) throw new Error("AtspiBuffer moves by offset only");
    const { text, anchor } = this.state;
    const offset = Math.max(0, Math.min(to.offset, text.length));
    if (to.extend) await this.element.select(toChars(text, Math.min(anchor, offset)), toChars(text, Math.max(anchor, offset)));
    else await this.element.setCaret(toChars(text, offset));
    this.state = { ...this.state, cursor: offset, anchor: to.extend ? anchor : offset };
  }

  async edit(range: { from: number; to: number }, insert: string): Promise<void> {
    const { text } = this.state;
    const from = toChars(text, range.from);
    if (range.to > range.from) await this.element.deleteText(from, toChars(text, range.to));
    if (insert) await this.element.insertText(from, insert);
    const at = range.from + insert.length;
    await this.element.setCaret(from + [...insert].length);
    this.state = { ...this.state, text: text.slice(0, range.from) + insert + text.slice(range.to), cursor: at, anchor: at };
  }

  async undo(): Promise<void> {
    await this.host.keys(this.state.windowId, [{ code: "ControlLeft", modifiers: 2 }, { code: "KeyZ", modifiers: 2 }, { code: "KeyZ", modifiers: -3 }, { code: "ControlLeft", modifiers: -1 }]);
    await this.refresh().catch(() => {});
  }

  async redo(): Promise<void> {
    await this.host.keys(this.state.windowId, [
      { code: "ControlLeft", modifiers: 2 }, { code: "ShiftLeft", modifiers: 10 },
      { code: "KeyZ", modifiers: 10 }, { code: "KeyZ", modifiers: -11 },
      { code: "ShiftLeft", modifiers: -3 }, { code: "ControlLeft", modifiers: -1 },
    ]);
    await this.refresh().catch(() => {});
  }

  setCaret(_shape: string, mode?: string): void {
    this.host.mode(this.state, mode ?? null);
  }
}

// ── The accessibility bus ────────────────────────────────────────────────

const ROLE_PASSWORD_TEXT = 40;
const STATE_EDITABLE = 7;
const STATE_SINGLE_LINE = 25;

/** An element over D-Bus. */
class DbusField implements AtspiField {
  private readonly bus: DBusConnection;
  private readonly app: string;
  private readonly path: string;

  constructor(bus: DBusConnection, app: string, path: string) {
    this.bus = bus;
    this.app = app;
    this.path = path;
  }

  private call(iface: string, member: string, signature = "", body: unknown[] = []) {
    return this.bus.call({ destination: this.app, path: this.path, interface: iface, member, signature, body, timeoutMs: 1000 });
  }

  async read() {
    const [count] = (await this.call("org.freedesktop.DBus.Properties", "Get", "ss", ["org.a11y.atspi.Text", "CharacterCount"])) as [[string, number]];
    const characters = Array.isArray(count) ? Number(count[1]) : Number(count);
    const [text] = (await this.call("org.a11y.atspi.Text", "GetText", "ii", [0, Math.min(characters, 1_000_000)])) as [string];
    const [caretValue] = (await this.call("org.freedesktop.DBus.Properties", "Get", "ss", ["org.a11y.atspi.Text", "CaretOffset"])) as [[string, number]];
    const caret = Array.isArray(caretValue) ? Number(caretValue[1]) : Number(caretValue);
    let selection: [number, number] | null = null;
    const [n] = (await this.call("org.a11y.atspi.Text", "GetNSelections")) as [number];
    if (n > 0) {
      const [start, end] = (await this.call("org.a11y.atspi.Text", "GetSelection", "i", [0])) as [number, number];
      selection = [start, end];
    }
    return { text, caret, selection };
  }

  async setCaret(offset: number) {
    await this.call("org.a11y.atspi.Text", "SetCaretOffset", "i", [offset]);
  }

  async select(start: number, end: number) {
    const [n] = (await this.call("org.a11y.atspi.Text", "GetNSelections")) as [number];
    if (n > 0) await this.call("org.a11y.atspi.Text", "SetSelection", "iii", [0, start, end]);
    else await this.call("org.a11y.atspi.Text", "AddSelection", "ii", [start, end]);
  }

  async deleteText(start: number, end: number) {
    await this.call("org.a11y.atspi.EditableText", "DeleteText", "ii", [start, end]);
  }

  async insertText(at: number, text: string) {
    await this.call("org.a11y.atspi.EditableText", "InsertText", "isi", [at, text, [...text].length]);
  }
}

export interface AtspiVimOptions {
  /** The windows, with their client's pid and which has focus. */
  readonly windows: () => readonly { id: number; pid: number; focused: boolean }[];
  /** Whether a window already has a text-input-v3 field (that one wins). */
  readonly hasNativeField: (windowId: number) => boolean;
  readonly addField: (fieldId: number, buffer: AtspiBuffer) => void;
  readonly removeField: (fieldId: number) => void;
  readonly host: NativeHost;
  readonly log?: (message: string) => void;
}

/** Watches the accessibility bus for focus on editable text, and gives each such element to the engine. */
export class AtspiVim {
  private bus: DBusConnection | null = null;
  private current: { windowId: number; fieldId: number; app: string; path: string } | null = null;
  private readonly cdp: BrowserCdp;
  private readonly options: AtspiVimOptions;

  constructor(cdp: BrowserCdp, options: AtspiVimOptions) {
    this.cdp = cdp;
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.bus?.isOpen) return;
    // AT_SPI_BUS_ADDRESS names the accessibility bus outright, as at-spi2's clients read it; else the session bus says.
    let address = process.env.AT_SPI_BUS_ADDRESS ?? "";
    if (!address) {
      const sessionAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
      if (!sessionAddress) throw new Error("no session bus, so no accessibility bus");
      const session = await DBusConnection.connect(sessionAddress);
      try {
        [address] = (await session.call({ destination: "org.a11y.Bus", path: "/org/a11y/bus", interface: "org.a11y.Bus", member: "GetAddress" })) as [string];
      } finally {
        session.close();
      }
    }
    const bus = await DBusConnection.connect(address);
    this.bus = bus;
    bus.onSignal = (message) => void this.signal(message).catch((error) => this.options.log?.(`pluto vim (AT-SPI): ${(error as Error).message}`));
    await bus.call({
      destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus", member: "AddMatch",
      signature: "s", body: ["type='signal',interface='org.a11y.atspi.Event.Object',member='StateChanged',arg0='focused'"],
    });
    // Apps send events only to registered listeners (at-spi2's registry).
    await bus.call({
      destination: "org.a11y.atspi.Registry", path: "/org/a11y/atspi/registry", interface: "org.a11y.atspi.Registry",
      member: "RegisterEvent", signature: "s", body: ["object:state-changed:focused"],
    }).catch(() => {});
  }

  stop(): void {
    this.bus?.close();
    this.bus = null;
  }

  private debug(text: string): void {
    if (process.env.PLUTONIUM_VIM_DEBUG === "1") this.options.log?.(`pluto vim (AT-SPI): ${text}`);
  }

  private async signal(message: Message): Promise<void> {
    if (message.member !== "StateChanged" || message.body?.[0] !== "focused" || !message.sender || !message.path) return;
    const focused = Number(message.body[1]) === 1;
    this.debug(`focus ${focused ? "on" : "off"} ${message.sender} ${message.path}`);
    if (!focused) {
      if (this.current && this.current.app === message.sender && this.current.path === message.path) await this.drop();
      return;
    }
    await this.focus(message.sender, message.path);
  }

  private async drop(): Promise<void> {
    const current = this.current;
    if (!current) return;
    this.current = null;
    this.debug(`drop field ${current.fieldId}`);
    this.options.removeField(current.fieldId);
    await this.cdp.send("Plutonium.setVimWindowField", { windowId: current.windowId, enabled: false }).catch(() => {});
  }

  private async focus(app: string, path: string): Promise<void> {
    const bus = this.bus!;
    const call = (iface: string, member: string, signature = "", body: unknown[] = []) =>
      bus.call({ destination: app, path, interface: iface, member, signature, body, timeoutMs: 1000 });
    const [interfaces] = (await call("org.a11y.atspi.Accessible", "GetInterfaces")) as [string[]];
    if (!interfaces.includes("org.a11y.atspi.EditableText") || !interfaces.includes("org.a11y.atspi.Text")) return this.drop();
    const [role] = (await call("org.a11y.atspi.Accessible", "GetRole")) as [number];
    const [states] = (await call("org.a11y.atspi.Accessible", "GetState")) as [number[]];
    const has = (bit: number) => Boolean((states[Math.floor(bit / 32)] ?? 0) & (1 << (bit % 32)));
    // Passwords are never vim's (Principle 5); only text you can edit is.
    if (role === ROLE_PASSWORD_TEXT || !has(STATE_EDITABLE)) return this.drop();
    const [pid] = (await bus.call({
      destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus",
      member: "GetConnectionUnixProcessID", signature: "s", body: [app],
    })) as [number];
    const windows = this.options.windows();
    // The app's focused window; an X11 app's windows are its satellite's, so else the focused one.
    const window = windows.find((w) => w.pid === pid && w.focused) ?? windows.find((w) => w.pid === pid) ?? windows.find((w) => w.focused);
    if (!window || this.options.hasNativeField(window.id)) return this.drop();
    if (this.current?.app === app && this.current.path === path) return;
    await this.drop();
    const { fieldId } = (await this.cdp.send("Plutonium.setVimWindowField", { windowId: window.id, enabled: true })) as { fieldId: number };
    // Multi-line to the engine, as every native field is (vimNative.ts): the first Escape is vim's.
    this.debug(`single-line state: ${has(STATE_SINGLE_LINE)}`);
    const buffer = new AtspiBuffer(new DbusField(bus, app, path), this.options.host, { fieldId, windowId: window.id });
    const at = Date.now();
    await buffer.refresh();
    this.debug(`field ${fieldId} in window ${window.id}: ${JSON.stringify(buffer.state.text.slice(0, 40))} ${buffer.state.cursor} (read in ${Date.now() - at} ms)`);
    this.current = { windowId: window.id, fieldId, app, path };
    this.options.addField(fieldId, buffer);
  }
}

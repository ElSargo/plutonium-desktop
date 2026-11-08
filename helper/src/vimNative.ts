// Pluto Vim for native apps (PLUTO_VIM.md, "Native apps: text-input-v3"):
// the engine runs here, in the helper, over each text-input-v3 field Exo
// reports through the Plutonium DevTools domain (Exo's plutonium_vim.cc).
//
// - Fields: vimFieldChanged gives the surrounding text (about 4 KB around
//   the cursor), the cursor, the anchor and the content type; each field is
//   a session of the engine over a NativeBuffer.
// - Keys: Exo holds a key while the field's mode takes it (setVimHold: every
//   key outside insert mode; in insert mode Escape and the first keys of
//   insert mappings), and every key behind it, until answerVimKey. A key the
//   engine takes is answered at once; one it leaves is answered once the
//   engine's edits for the keys before it are out, so the app sees them in
//   order. A key not answered in 100 ms goes on by itself.
// - Edits: editVimField (delete around the cursor, then commit), one edit
//   the app can undo. Motions: navigation keys through
//   dispatchWindowKeyEvents, best effort: one batch, then one correction
//   once the app's next state arrives, or the motion budget runs out.
// - The mode: shown by the shell over the window, at the field's cursor
//   (the shell library's vim badge), outside insert mode.
import { createContext, runInContext, type Context } from "node:vm";

import type { BrowserCdp } from "./cdp.ts";
import type { RegisterPlace, RegisterStore } from "./vimRegisters.ts";

/**
 * How long a motion or edit waits for the app: until its state is what was
 * sent, or it has been quiet this long after a report (an app reports each
 * arrow press in turn), or the budget runs out.
 */
export const MOTION_QUIET_MS = 10;
export const MOTION_BUDGET_MS = 60;
/** text-input-v3's purposes, by number. */
const PURPOSES = ["normal", "alpha", "digits", "number", "phone", "url", "email", "name", "password", "pin", "date", "time", "datetime", "terminal"];

export interface VimField {
  readonly id: number;
  readonly windowId: number;
  readonly text: string;
  readonly cursor: number;
  readonly anchor: number;
  readonly hint: number;
  readonly purpose: number;
  readonly caret?: number[];
}

interface VimKeyEvent {
  readonly id: number;
  readonly fieldId: number;
  readonly key: string;
  readonly code: string;
  readonly modifiers: number;
  readonly repeat: boolean;
}

interface KeySpec {
  readonly key: string;
  readonly modifiers?: number;
}

/** What NativeBuffer asks of Exo and the shell. */
export interface NativeHost {
  edit(fieldId: number, before: number, after: number, text: string): Promise<void>;
  keys(windowId: number, keys: { code: string; modifiers?: number }[]): Promise<void>;
  mode(field: VimField, mode: string | null): void;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** How many arrow presses get from `a` to `b` in `text`: toolkits move by grapheme. */
export function graphemesBetween(text: string, a: number, b: number): number {
  const [from, to] = a < b ? [a, b] : [b, a];
  let n = 0;
  for (const { index } of segmenter.segment(text.slice(from, to))) if (index >= 0) n++;
  return n;
}

/**
 * A Buffer (PLUTO_VIM.md, The Buffer interface) over a native field. Its
 * text() is what the app last reported, with the engine's own moves and edits
 * applied ahead of the app's next report, which replaces it.
 */
export class NativeBuffer {
  readonly kind = "native";
  readonly caps = { exactMotions: false, wholeText: false, selection: true, undo: "keys" as const };
  readonly field: { singleLine: boolean; purpose: string; windowId: number };
  state: VimField;
  private waiters: (() => void)[] = [];
  private readonly quiet: number;
  private readonly host: NativeHost;
  private readonly budget: number;

  constructor(field: VimField, host: NativeHost, budget = MOTION_BUDGET_MS, quiet = MOTION_QUIET_MS) {
    this.state = field;
    this.host = host;
    this.budget = budget;
    this.quiet = quiet;
    // No native field is single-line to the engine: GTK's text views don't send the MULTILINE
    // hint, so its absence says nothing, and the first Escape is vim's everywhere.
    this.field = { singleLine: false, purpose: PURPOSES[field.purpose] ?? "normal", windowId: field.windowId };
  }

  /** The app's new state. */
  update(field: VimField): void {
    this.state = field;
    this.field.windowId = field.windowId;
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  text() {
    const { text, cursor, anchor } = this.state;
    return { text, start: 0, cursor, anchor };
  }

  /** Waits until the app's state is `done`, or it goes quiet after a report, or the budget runs out. */
  private settle(done: (field: VimField) => boolean): Promise<void> {
    return new Promise((resolve) => {
      let quiet: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        clearTimeout(budget);
        clearTimeout(quiet);
        this.waiters = this.waiters.filter((w) => w !== wake);
        resolve();
      };
      const budget = setTimeout(finish, this.budget);
      const wake = () => {
        if (done(this.state)) return finish();
        clearTimeout(quiet);
        quiet = setTimeout(finish, this.quiet);
        this.waiters.push(wake);
      };
      this.waiters.push(wake);
    });
  }

  private arrows(from: number, to: number, extend: boolean) {
    const n = graphemesBetween(this.state.text, from, to);
    const code = to < from ? "ArrowLeft" : "ArrowRight";
    const modifiers = extend ? 8 : 0;
    const keys: { code: string; modifiers?: number }[] = [];
    for (let k = 0; k < n; k++) keys.push({ code, modifiers }, { code, modifiers: -1 - modifiers });
    return keys;
  }

  private async send(keys: { code: string; modifiers?: number }[]) {
    if (keys.length) await this.host.keys(this.state.windowId, keys);
  }

  async move(to: { offset: number; extend?: boolean } | { by: string }): Promise<void> {
    if (!("offset" in to)) throw new Error("NativeBuffer moves by offset only");
    const { text, cursor, anchor } = this.state;
    const target = Math.max(0, Math.min(to.offset, text.length));
    const extend = Boolean(to.extend);
    const keys: { code: string; modifiers?: number }[] = [];
    let from = cursor;
    if (!extend && anchor !== cursor) {
      // A selection collapses to its end with the arrow toward it, where toolkits put the cursor.
      keys.push(...this.arrows(anchor, cursor, false).slice(0, 2));
      from = cursor;
    }
    keys.push(...this.arrows(from, target, extend));
    if (!keys.length) return;
    // Shift went with each arrow's flags: let it go, so the app's next key isn't shifted.
    if (extend) keys.push({ code: "ShiftLeft", modifiers: -1 });
    await this.send(keys);
    const arrived = (f: VimField) => f.cursor === target && (extend || f.anchor === target);
    await this.settle(arrived);
    // One correction, if the app's cursor isn't where it was sent; then it's where it is.
    if (this.state.cursor !== target && Math.abs(this.state.cursor - target) <= text.length) {
      const fix = this.arrows(this.state.cursor, target, extend);
      if (extend && fix.length) fix.push({ code: "ShiftLeft", modifiers: -1 });
      if (fix.length) {
        await this.send(fix);
        await this.settle(arrived);
      }
    }
    // Where it was sent, as far as the engine goes, until the app says otherwise.
    if (!arrived(this.state)) this.state = { ...this.state, cursor: target, anchor: extend ? this.state.anchor : target };
  }

  async edit(range: { from: number; to: number }, insert: string): Promise<void> {
    if (this.state.anchor !== this.state.cursor) await this.move({ offset: this.state.cursor });
    // delete_surrounding_text counts from the cursor: it has to be in the range.
    if (this.state.cursor < range.from) await this.move({ offset: range.from });
    else if (this.state.cursor > range.to) await this.move({ offset: range.to });
    const { text, cursor } = this.state;
    await this.host.edit(this.state.id, cursor - range.from, range.to - cursor, insert);
    const at = range.from + insert.length;
    const expected = text.slice(0, range.from) + insert + text.slice(range.to);
    await this.settle((f) => f.text === expected && f.cursor === at);
    if (this.state.text !== expected) this.state = { ...this.state, text: expected, cursor: at, anchor: at };
  }

  async undo(): Promise<void> {
    await this.history([{ code: "ControlLeft", modifiers: 2 }, { code: "KeyZ", modifiers: 2 }, { code: "KeyZ", modifiers: -3 }, { code: "ControlLeft", modifiers: -1 }]);
  }

  async redo(): Promise<void> {
    await this.history([
      { code: "ControlLeft", modifiers: 2 }, { code: "ShiftLeft", modifiers: 10 },
      { code: "KeyZ", modifiers: 10 }, { code: "KeyZ", modifiers: -11 },
      { code: "ShiftLeft", modifiers: -3 }, { code: "ControlLeft", modifiers: -1 },
    ]);
  }

  /**
   * The app's own undo or redo. GTK reports no new state after one, so if the
   * app stays silent, a Shift+arrow there and back (selecting one character
   * and letting it go) makes it report where its text and cursor are now.
   */
  private async history(keys: { code: string; modifiers?: number }[]): Promise<void> {
    const before = this.state;
    await this.send(keys);
    await this.settle((f) => f !== before);
    if (this.state !== before) return;
    const [there, back] = before.cursor > 0 ? ["ArrowLeft", "ArrowRight"] : ["ArrowRight", "ArrowLeft"];
    await this.send([
      { code: there, modifiers: 8 }, { code: there, modifiers: -9 },
      { code: back, modifiers: 8 }, { code: back, modifiers: -9 },
      { code: "ShiftLeft", modifiers: -1 },
    ]);
    // Two reports: the selection, then where it ends.
    let reports = 0;
    await this.settle(() => ++reports >= 2);
  }

  setCaret(_shape: string, mode?: string): void {
    this.host.mode(this.state, mode ?? null);
  }
}

/** Vim's notation for a key's DOM key and modifiers, as Exo matches them (KeySpec), or null. */
export function keySpec(key: string): KeySpec | null {
  const special: Record<string, string> = { "<Esc>": "Escape", "<CR>": "Enter", "<Tab>": "Tab", "<BS>": "Backspace", "<Del>": "Delete", "<Up>": "ArrowUp", "<Down>": "ArrowDown", "<Left>": "ArrowLeft", "<Right>": "ArrowRight", "<Home>": "Home", "<End>": "End" };
  if (special[key]) return { key: special[key]! };
  if (key === "<C-[>") return { key: "Escape" };
  const m = /^<([CAM])-(.+)>$/.exec(key);
  if (m) {
    const inner = keySpec(m[2]!.length === 1 ? m[2]! : `<${m[2]}>`);
    return inner ? { key: inner.key, modifiers: (inner.modifiers ?? 0) | (m[1] === "C" ? 2 : 1) } : null;
  }
  if ([...key].length === 1) return { key: key === " " ? " " : key };
  return null;
}

interface Session {
  mode: string;
  feed(key: string): boolean;
  idle(): Promise<void>;
  typeahead: unknown[];
  insertRegister: boolean;
  expression: string | null;
  pending: unknown[];
  buffer: NativeBuffer;
}

export interface NativeVimOptions {
  /** The engine's bundle (vimBundle.ts). */
  readonly bundle: () => string;
  /** init.js as an expression (vimConfig.ts), or "null". */
  readonly config?: () => string;
  readonly registers?: RegisterStore;
  /** A window's thread and project, for registers' scopes. */
  readonly placeOf?: (windowId: number) => RegisterPlace;
  /** The mode, for the shell to show over the window (null: hide it). */
  readonly showMode?: (show: { windowId: number; mode: string | null; caret: number[] | null }) => void;
  readonly log?: (message: string) => void;
  readonly budget?: number;
  readonly quiet?: number;
}

export class NativeVim {
  private context: Context | null = null;
  private vim: any = null;
  private readonly sessions = new Map<number, Session>();
  private readonly holds = new Map<number, string>();
  private readonly busy = new Map<number, number>();
  private place: RegisterPlace = {};
  private listener: ((event: { method: string; params?: unknown; sessionId?: string }) => void) | null = null;
  private readonly cdp: BrowserCdp;
  private readonly options: NativeVimOptions;
  private readonly host: NativeHost;
  private readonly debug: ((message: string) => void) | null;

  constructor(cdp: BrowserCdp, options: NativeVimOptions) {
    this.cdp = cdp;
    this.options = options;
    const debug = process.env.PLUTONIUM_VIM_DEBUG === "1" ? (m: string) => options.log?.(`pluto vim (native): ${m}`) : null;
    this.debug = debug;
    this.host = {
      edit: async (fieldId, before, after, text) => {
        debug?.(`edit ${fieldId} -${before} +${after} ${JSON.stringify(text)}`);
        await this.cdp.send("Plutonium.editVimField", { fieldId, before, after, text });
      },
      keys: async (windowId, keys) => {
        debug?.(`keys ${windowId} ${keys.map((k) => `${(k.modifiers ?? 0) < 0 ? "^" : ""}${k.code}`).join(" ")}`);
        // A negative modifiers is a key up, with -1 - modifiers held (NativeBuffer's shorthand).
        const events = keys.map(({ code, modifiers = 0 }) =>
          modifiers < 0 ? { type: "keyUp", code, modifiers: -1 - modifiers } : { type: "keyDown", code, modifiers });
        await this.cdp.send("Plutonium.dispatchWindowKeyEvents", { id: windowId, events });
      },
      mode: (field, mode) => {
        const shown = mode && mode !== "insert" ? mode : null;
        this.options.showMode?.({ windowId: field.windowId, mode: shown, caret: field.caret ?? null });
      },
    };
  }

  /** The engine, configured with init.js; again for each new version. */
  private engine(): any {
    if (!this.vim) {
      const context = createContext({ setTimeout, clearTimeout, queueMicrotask, console });
      runInContext(this.options.bundle(), context, { filename: "pluto-vim-engine.js" });
      const registers = this.options.registers;
      const store = registers
        ? { get: (name: string, scope: string) => registers.get(name, scope, this.place), set: (name: string, value: unknown, scope: string) => registers.set(name, value, scope, this.place) }
        : undefined;
      context.store = store;
      this.vim = runInContext("new plutoVim.Vim(store ? { store } : {})", context);
      this.vim.on("error", (error: Error) => this.options.log?.(`pluto vim (native): ${error.message}`));
      this.context = context;
      this.configure();
    }
    return this.vim;
  }

  /** init.js changed: the engine takes the new version (fields keep their sessions). */
  configure(): void {
    if (!this.context || !this.vim) return;
    try {
      const setup = runInContext(this.options.config?.() ?? "null", this.context);
      runInContext("(vim, setup) => plutoVim.configure(vim, setup)", this.context)(this.vim, setup);
    } catch (error) {
      this.options.log?.(`pluto vim (native): init.js: ${(error as Error).message}`);
    }
  }

  async start(): Promise<void> {
    if (!this.listener) {
      this.listener = ({ method, params, sessionId }) => {
        if (sessionId) return;
        if (method === "Plutonium.vimFieldChanged") this.fieldChanged((params as { field: VimField }).field);
        else if (method === "Plutonium.vimFieldGone") this.fieldGone((params as { id: number }).id);
        else if (method === "Plutonium.vimKey") void this.key(params as VimKeyEvent);
      };
      this.cdp.addEventListener(this.listener);
    }
    this.sessions.clear();
    this.holds.clear();
    await this.cdp.send("Plutonium.setVimEnabled", { enabled: true });
  }

  async stop(): Promise<void> {
    if (this.listener) this.cdp.removeEventListener(this.listener);
    this.listener = null;
    await this.cdp.send("Plutonium.setVimEnabled", { enabled: false }).catch(() => {});
  }

  /** The fields with a session, for tests. */
  get fields(): number {
    return this.sessions.size;
  }

  session(fieldId: number): Session | undefined {
    return this.sessions.get(fieldId);
  }

  private fieldChanged(field: VimField): void {
    this.debug?.(`field ${field.id} ${JSON.stringify(field.text.slice(0, 60))} ${field.cursor}/${field.anchor}`);
    const known = this.sessions.get(field.id);
    if (known) {
      known.buffer.update(field);
      return;
    }
    const vim = this.engine();
    const buffer = new NativeBuffer(field, this.host, this.options.budget, this.options.quiet);
    const session = vim.attach(buffer) as Session;
    this.sessions.set(field.id, session);
    vim.emit("FieldEnter", { session });
    void this.hold(field.id);
  }

  private fieldGone(id: number): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    this.holds.delete(id);
    this.busy.delete(id);
    session.buffer.setCaret("bar", "insert");
    this.vim?.emit("FieldLeave", { session });
  }

  /** What field `id` holds now: every key unless it's in insert mode with nothing pending. */
  private wanted(session: Session): { all: boolean; keys: KeySpec[] } {
    const insertIdle = session.mode === "insert" && !session.typeahead.length && !session.insertRegister && session.expression === null;
    if (!insertIdle) return { all: true, keys: [] };
    const keys: KeySpec[] = [{ key: "Escape" }, { key: "[", modifiers: 2 }];
    for (const mapping of this.vim.keymaps.i.values()) {
      const spec = keySpec(mapping.lhs[0]);
      if (spec) keys.push(spec);
    }
    return { all: false, keys };
  }

  private async hold(fieldId: number, force?: { all: boolean; keys: KeySpec[] }): Promise<void> {
    const session = this.sessions.get(fieldId);
    if (!session) return;
    const want = force ?? this.wanted(session);
    const id = JSON.stringify(want);
    if (this.holds.get(fieldId) === id) return;
    this.holds.set(fieldId, id);
    await this.cdp.send("Plutonium.setVimHold", { fieldId, ...want }).catch(() => {});
  }

  private async key(event: VimKeyEvent): Promise<void> {
    const session = this.sessions.get(event.fieldId);
    const answer = (consumed: boolean) =>
      this.cdp.send("Plutonium.answerVimKey", { keyId: event.id, consumed }).catch(() => {});
    if (!session) return void answer(false);
    this.engine();
    const key = runInContext("plutoVim.keyFromEvent", this.context!)({
      key: event.key,
      code: event.code,
      altKey: Boolean(event.modifiers & 1),
      ctrlKey: Boolean(event.modifiers & 2),
      metaKey: Boolean(event.modifiers & 4),
      shiftKey: Boolean(event.modifiers & 8),
    });
    this.debug?.(`key ${event.id} ${event.key} -> ${key}`);
    if (!key) return void answer(false);
    this.place = this.options.placeOf?.(session.buffer.state.windowId) ?? {};
    const mine = session.feed(key);
    // Until the engine's edits are out, every key waits behind this one.
    this.busy.set(event.fieldId, (this.busy.get(event.fieldId) ?? 0) + 1);
    await this.hold(event.fieldId, { all: true, keys: [] });
    if (mine) void answer(true);
    try {
      await session.idle();
    } finally {
      if (!mine) await answer(false);
      const left = (this.busy.get(event.fieldId) ?? 1) - 1;
      if (left > 0) this.busy.set(event.fieldId, left);
      else {
        this.busy.delete(event.fieldId);
        await this.hold(event.fieldId);
      }
    }
  }
}

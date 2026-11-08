// Pluto Vim's engine (PLUTO_VIM.md): modes, counts, the command parser, and
// what each command does to a field, through the field's Buffer.
//
// A Vim holds what fields share: options, registers, the last change (for
// `.`), the last f/t search. attach(buffer) gives a Session: one field's mode
// and pending keys.
//
// session.feed(key) decides at once, with no waiting, whether the key is
// vim's (Principle 6). If it is, the backend stops the field's default action
// and the command runs on a queue, in order, so a backend whose Buffer calls
// are asynchronous (text-input-v3) still sees edits in the order of their
// keys. A backend must hold keys the engine didn't take until session.idle(),
// so a key typed after `cw` lands after the delete.

import * as T from "./text.js";
import { isPrintable, parseKeys } from "./keys.js";
import { Registers, REGISTER_NAMES } from "./registers.js";
import { ACTIONS, MOTIONS, OBJECTS, OPERATORS, VISUAL_ACTIONS, compile } from "./commands.js";
import { UserBuffer } from "./userBuffer.js";

export const DEFAULT_OPTIONS = {
  /** Fields start in insert mode (Principle 2). */
  startInInsert: true,
  /** Single-line inputs: "manual" (Ctrl+[ enters normal mode), "on" (as a textarea), "off". */
  inputs: "manual",
  /** "unnamedplus": the unnamed register is the system clipboard. */
  clipboard: "",
  shiftwidth: 2,
  /**
   * Keys Pluto Vim takes before the page's own handlers in a field it's on
   * in: Ctrl+[, so normal mode is always reachable, even where the page
   * takes Escape (ProseMirror's keymap, Hydra's composer) and Ctrl+[ (T3's
   * navigation.back). Every other key is the page's first (Principle 1).
   */
  claim: ["<C-[>"],
  /** How long a key that starts a mapping waits for the rest of it, in milliseconds. */
  timeoutlen: 1000,
  /** What <leader> stands for in a mapping, when it's made. */
  mapleader: "\\",
};

/** The modes a mapping can be for: normal, insert, and visual (visual and visual line). */
export const MAP_MODES = ["n", "i", "v"];

/** How deep mappings with remap may expand each other before it's taken as a loop. */
const MAX_MAP_DEPTH = 100;

const CARETS = { normal: "block", visual: "block", vline: "block", insert: "bar", replace: "underline", pending: "underline" };

const MORE = { status: "more" };
const BAD = { status: "bad" };

export class Vim {
  /**
   * @param {object} [options]
   * @param {Partial<typeof DEFAULT_OPTIONS>} [options.opt]
   * @param {Registers} [options.registers]
   */
  constructor({ opt = {}, registers } = {}) {
    /** Options the backend set (a test's, a page's), under init.js's. */
    this.baseOpt = opt;
    this.registers = registers ?? new Registers({ clipboard: () => this.opt.clipboard });
    /** The last change, for `.`: { cmd, inserted }. */
    this.lastChange = null;
    /** The last f, t, F or T, for ; and ,. */
    this.lastFind = null;
    this.listeners = new Map();
    /** The session a mapping's function runs for (api.js's vim.selection(), vim.feedkeys()). */
    this.current = null;
    this.reset();
  }

  /**
   * Back to the built-in commands and options, with no mappings and nothing
   * of init.js's: before init.js runs, and again before it runs anew.
   */
  reset() {
    for (const unlisten of this.user?.unlisten ?? []) unlisten();
    this.opt = { ...DEFAULT_OPTIONS, ...this.baseOpt };
    /** Mappings by mode, by their keys joined: { lhs, rhs, opts }. */
    this.keymaps = Object.fromEntries(MAP_MODES.map((mode) => [mode, new Map()]));
    /** What init.js added (api.js): motions and operators as table entries, text objects by key, operators' and commands' functions by name. */
    this.user = { motions: [], operators: [], objects: {}, ops: new Map(), commands: new Map(), unlisten: [] };
    /** vim.disable and vim.enable, in order: { on, site?, shell?, app?, selector? }. */
    this.rules = [];
    /** vim.registers.scope: register → "global", "project" or "thread" (the register store's, step 5). */
    this.registerScopes = new Map();
    this.rebuild();
  }

  /** The command tables from the built-in ones and init.js's, which come first, so the same keys are init.js's. */
  rebuild() {
    const motions = [...this.user.motions, ...compile(MOTIONS)].map((e) => ({ ...e, type: "motion" }));
    const operators = [...this.user.operators, ...compile(OPERATORS)];
    this.tables = {
      normal: [
        ...motions,
        ...operators.map((e) => ({ ...e, type: "operator" })),
        ...compile(ACTIONS).map((e) => ({ ...e, type: "action" })),
      ],
      visual: [
        ...motions,
        ...this.user.operators.map((e) => ({ keys: e.keys, op: e.op, type: "visualOp" })),
        ...compile(VISUAL_ACTIONS).map((e) => ({ ...e, type: e.op ? "visualOp" : "action" })),
      ],
      motions,
    };
    /** The keys an operator starts with: the caret shows "pending" after one. */
    this.operatorKeys = new Set(operators.map((e) => e.keys[0]));
    this.objects = { ...OBJECTS, ...this.user.objects };
  }

  /** Runs `fn` with `session` as the current one, for a mapping's function. */
  withSession(session, fn) {
    const before = this.current;
    this.current = session;
    try {
      return fn();
    } finally {
      this.current = before;
    }
  }

  /**
   * Whether Pluto Vim is on for a field: the last of vim.disable's and
   * vim.enable's rules that matches it decides; on if none does.
   * @param {{ site?: string, shell?: string, app?: string, el?: Element }} where
   */
  enabledFor(where) {
    let on = true;
    for (const rule of this.rules) if (ruleMatches(rule, where)) on = rule.on;
    return on;
  }

  /** A field's session. `options.startInInsert` overrides the option for this field (a page's data-pvim-start). */
  attach(buffer, options = {}) {
    return new Session(this, buffer, options);
  }

  /** Listens for ModeChanged, InsertEnter, InsertLeave, TextYankPost, error. Returns the unlisten function. */
  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event)?.delete(fn);
  }

  emit(event, data) {
    if (event === "error" && !this.listeners.get("error")?.size) console.error("pluto vim:", data);
    for (const fn of this.listeners.get(event) ?? []) {
      try { fn(data); } catch (error) { if (event !== "error") this.emit("error", error); }
    }
  }
}

function ruleMatches(rule, where) {
  if (rule.site != null && !(where.site && (where.site === rule.site || where.site.endsWith(`.${rule.site}`)))) return false;
  if (rule.shell != null && where.shell !== rule.shell) return false;
  if (rule.app != null && where.app !== rule.app) return false;
  if (rule.selector != null && !where.el?.closest?.(rule.selector)) return false;
  return true;
}

// ── Parsing ──────────────────────────────────────────────────────────────

function readCount(tokens, i) {
  let digits = "";
  while (i < tokens.length && /^[0-9]$/.test(tokens[i]) && !(digits === "" && tokens[i] === "0")) digits += tokens[i++];
  return [digits ? Number(digits) : null, i];
}

/** The longest entry of `table` whose keys start at tokens[i]; MORE while one could still match; BAD if none can. */
function match(table, tokens, i) {
  let exact = null;
  let more = false;
  const rest = tokens.length - i;
  for (const entry of table) {
    const keys = entry.keys;
    const n = Math.min(keys.length, rest);
    let same = true;
    for (let k = 0; k < n; k++) if (keys[k] !== tokens[i + k]) { same = false; break; }
    if (!same) continue;
    if (keys.length <= rest) { if (!exact || keys.length > exact.keys.length) exact = entry; }
    else more = true;
  }
  if (more) return MORE;
  return exact ? { entry: exact, end: i + exact.keys.length } : BAD;
}

const eq = (a, b) => a.length === b.length && a.every((x, k) => x === b[k]);
const startsWith = (a, b) => a.length < b.length && a.every((x, k) => x === b[k]);

/** The argument a key gives f, t and r: its character, or null. */
function argOf(key, allowNewline) {
  if (isPrintable(key)) return key;
  if (key === "<Tab>") return "\t";
  if (key === "<CR>" && allowNewline) return "\n";
  return null;
}

/** A command from the keys typed so far in normal or visual mode, or MORE, or BAD. */
export function parseCommand(vim, tokens, visual) {
  let i = 0;
  let register = null;
  if (tokens[0] === '"') {
    if (tokens.length < 2) return MORE;
    if (!REGISTER_NAMES.test(tokens[1])) return BAD;
    register = tokens[1];
    i = 2;
  }
  let count1;
  [count1, i] = readCount(tokens, i);
  if (i >= tokens.length) return MORE;
  const base = { register, count: count1 ?? 1, hasCount: count1 != null };

  if (visual && (tokens[i] === "i" || tokens[i] === "a")) {
    if (i + 1 >= tokens.length) return MORE;
    const object = vim.objects[tokens[i + 1]];
    if (!object || i + 2 !== tokens.length) return BAD;
    return { status: "done", cmd: { ...base, type: "object", object, around: tokens[i] === "a" } };
  }

  const found = match(visual ? vim.tables.visual : vim.tables.normal, tokens, i);
  if (found.status) return found;
  const { entry } = found;
  let at = found.end;

  if (entry.alias) {
    if (at !== tokens.length) return BAD;
    const prefix = [...(register ? ['"', register] : []), ...(count1 != null ? String(count1).split("") : [])];
    return parseCommand(vim, [...prefix, ...parseKeys(entry.alias)], visual);
  }

  if (entry.type === "operator") {
    let count2;
    [count2, at] = readCount(tokens, at);
    if (at >= tokens.length) return MORE;
    const rest = tokens.slice(at);
    const doubled = [entry.keys, ...(entry.keys.length > 1 ? [entry.keys.slice(-1)] : [])];
    const count = (count1 ?? 1) * (count2 ?? 1);
    const op = { ...base, type: "operator", op: entry.op, count, hasCount: count1 != null || count2 != null };
    if (doubled.some((keys) => eq(rest, keys))) return { status: "done", cmd: { ...op, line: true } };
    const couldDouble = doubled.some((keys) => startsWith(rest, keys));
    if (rest[0] === "i" || rest[0] === "a") {
      if (rest.length < 2) return MORE;
      const object = vim.objects[rest[1]];
      if (!object || rest.length !== 2) return BAD;
      return { status: "done", cmd: { ...op, object, around: rest[0] === "a" } };
    }
    const motion = match(vim.tables.motions, tokens, at);
    if (motion === MORE || (motion === BAD && couldDouble)) return MORE;
    if (motion === BAD) return BAD;
    let end = motion.end;
    let arg = null;
    if (motion.entry.arg) {
      if (end >= tokens.length) return MORE;
      arg = argOf(tokens[end++], false);
      if (arg == null) return BAD;
    }
    if (end !== tokens.length) return BAD;
    return { status: "done", cmd: { ...op, motion: motion.entry, arg } };
  }

  let arg = null;
  if (entry.arg) {
    if (at >= tokens.length) return MORE;
    arg = argOf(tokens[at++], entry.action === "replaceChar" || entry.op === "r");
    if (arg == null) return BAD;
  }
  if (at !== tokens.length) return BAD;
  return { status: "done", cmd: { ...base, type: entry.type, entry, arg } };
}

// ── A field's session ────────────────────────────────────────────────────

export class Session {
  constructor(vim, buffer, options = {}) {
    this.vim = vim;
    this.buffer = buffer;
    const single = Boolean(buffer.field?.singleLine);
    /** Pluto Vim stays out of this field entirely. */
    this.off = single && vim.opt.inputs === "off";
    const startInInsert = options.startInInsert ?? (single && vim.opt.inputs === "manual" ? true : vim.opt.startInInsert);
    /** "normal", "insert", "visual", "vline" or "replace". */
    this.mode = startInInsert ? "insert" : "normal";
    this.pending = [];
    /** The column j and k keep (Infinity after $); null until a motion sets it. */
    this.want = null;
    this.queue = Promise.resolve();
    /** The insert session in progress (engine side): where it started and what started it. */
    this.insert = null;
    /** After Ctrl+O: one normal-mode command, then back to insert mode. */
    this.oneShot = false;
    /** After Ctrl+R in insert mode: the next key names a register. */
    this.insertRegister = false;
    /** Visual mode's ends, as offsets of characters. */
    this.vAnchor = 0;
    this.vCursor = 0;
    this.start = 0;
    /** Where we last put the cursor. */
    this.lastPos = -1;
    /** Undo steps per change, so `u` undoes a whole change (cw and what was typed). */
    this.undoSteps = [];
    this.redoSteps = [];
    this.edits = 0;
    this.replaced = null;
    /** Keys held while they might start a mapping: { key, live }; live is the key feed() was just given. */
    this.typeahead = [];
    this.mapTimer = null;
    this.mapDepth = 0;
    if (this.off) return;
    this.#caret();
    if (this.mode === "insert") this.#enqueue(() => this.#beginInsert(null));
    else this.#enqueue(async () => { const s = this.#read(); await this.#move(T.clampNormal(s.text, s.cursor)); });
  }

  /** Resolves once every command so far has run. */
  idle() {
    return this.queue;
  }

  /** The mode as the caret and `vimMode` show it: "pending" while an operator waits for its motion. */
  get displayMode() {
    if ((this.mode === "normal" || this.mode === "visual" || this.mode === "vline") && this.pending.length) {
      return parseCommand(this.vim, this.pending, this.mode !== "normal").status === "more" &&
        this.pending.some((k) => this.vim.operatorKeys.has(k)) ? "pending" : this.mode;
    }
    return this.mode;
  }

  /**
   * One key, in vim notation (keys.js). True: the key is vim's, and the field
   * mustn't act on it. False: it's the page's or the field's.
   */
  feed(key) {
    if (this.off || key == null) return false;
    clearTimeout(this.mapTimer);
    this.mapTimer = null;
    this.mapDepth = 0;
    if (!this.typeahead.length && !this.#mightMap(key)) return this.#feedRaw(key);
    // Keys held before this one: their events are gone, so whatever they turn out to be, it's ours to do.
    for (const held of this.typeahead) held.live = false;
    this.typeahead.push({ key, live: true });
    return this.#drain(false);
  }

  /** Every key of a string in notation; what feed() said for each. */
  feedKeys(notation) {
    return parseKeys(notation).map((key) => this.feed(key));
  }

  /**
   * Keys from init.js (vim.feedkeys): as typed, through the mappings with
   * `remap`, else as vim's own keys. Keys vim leaves are typed into the field.
   */
  sendKeys(notation, { remap = false } = {}) {
    if (this.off) return;
    const keys = parseKeys(notation);
    if (!remap) return this.#feedKeysRaw(keys);
    this.typeahead.push(...keys.map((key) => ({ key, live: false })));
    this.#drain(false);
  }

  /** Drops keys held for a mapping (the field lost focus). */
  cancelPending() {
    clearTimeout(this.mapTimer);
    this.mapTimer = null;
    this.typeahead = [];
  }

  // ── Mappings ───────────────────────────────────────────────────────────

  /** The keymap that applies now: "i" in insert mode, "n" or "v" at the start of a command (after a register and a count); null otherwise. */
  #mapMode() {
    if (this.mode === "insert") return this.insertRegister ? null : "i";
    if (this.mode === "replace") return null;
    let i = 0;
    if (this.pending[0] === '"') {
      if (this.pending.length < 2) return null;
      i = 2;
    }
    for (; i < this.pending.length; i++) if (!/^[0-9]$/.test(this.pending[i])) return null;
    return this.mode === "normal" ? "n" : "v";
  }

  #mightMap(key) {
    const mode = this.#mapMode();
    if (!mode) return false;
    for (const m of this.vim.keymaps[mode].values()) if (m.lhs[0] === key) return true;
    return false;
  }

  /**
   * Runs what the held keys make, as vim does with its typeahead: the longest
   * mapping they complete, unless a longer one could still come (then they
   * wait, up to timeoutlen); else the first key, as itself. Returns whether
   * the live key is vim's: held and taken by a mapping are; one fed as
   * itself is what the mode makes of it.
   */
  #drain(timedOut) {
    let live = true;
    let typed = false;
    while (this.typeahead.length) {
      const mode = this.#mapMode();
      const keys = this.typeahead.map((t) => t.key);
      let exact = null;
      let more = false;
      if (mode) {
        for (const m of this.vim.keymaps[mode].values()) {
          if (m.lhs.length <= keys.length) {
            if (m.lhs.every((k, j) => k === keys[j]) && (!exact || m.lhs.length > exact.lhs.length)) exact = m;
          } else if (!timedOut && keys.every((k, j) => k === m.lhs[j])) more = true;
        }
      }
      if (more && !exact?.opts.nowait) {
        this.mapTimer = setTimeout(() => this.#timeout(), this.vim.opt.timeoutlen);
        return true;
      }
      if (exact) {
        this.typeahead.splice(0, exact.lhs.length);
        this.#runMapping(exact);
        continue;
      }
      const item = this.typeahead.shift();
      if (item.key === "<Cmd>") {
        const end = this.typeahead.findIndex((t) => t.key === "<CR>");
        const line = this.typeahead.splice(0, end < 0 ? this.typeahead.length : end + 1).map((t) => t.key);
        this.runCommand(cmdLine(line));
        continue;
      }
      const taken = this.#feedRaw(item.key);
      if (item.live) {
        // Held keys typed by us go on the queue: so must this one, or it would land before them.
        live = taken || (typed && this.#type(item.key));
      } else if (!taken && this.#type(item.key)) {
        typed = true;
      }
    }
    return live;
  }

  #timeout() {
    this.mapTimer = null;
    this.mapDepth = 0;
    for (const held of this.typeahead) held.live = false;
    this.#drain(true);
  }

  #runMapping(m) {
    let rhs = m.rhs;
    if (typeof rhs === "function") {
      let result;
      try {
        result = this.vim.withSession(this, () => rhs());
      } catch (error) {
        this.vim.emit("error", error);
        return;
      }
      if (result && typeof result.then === "function") {
        result.then(null, (error) => this.vim.emit("error", error));
        return;
      }
      if (!m.opts.expr) return;
      rhs = typeof result === "string" ? result : "";
    }
    const keys = parseKeys(rhs);
    if (!m.opts.remap) return this.#feedKeysRaw(keys);
    if (++this.mapDepth > MAX_MAP_DEPTH) {
      this.typeahead = [];
      this.vim.emit("error", new Error(`pluto vim: mappings expand each other without end (${m.lhs.join("")})`));
      return;
    }
    this.typeahead.unshift(...keys.map((key) => ({ key, live: false })));
  }

  /** Keys as vim's own, not mapped; <Cmd>…<CR> runs a command. A key vim leaves is typed into the field. */
  #feedKeysRaw(keys) {
    for (let j = 0; j < keys.length; j++) {
      if (keys[j] === "<Cmd>") {
        let end = keys.indexOf("<CR>", j);
        if (end < 0) end = keys.length;
        this.runCommand(cmdLine(keys.slice(j + 1, end)));
        j = end;
        continue;
      }
      if (!this.#feedRaw(keys[j])) this.#type(keys[j]);
    }
  }

  /**
   * A key vim didn't take, which no key event will carry to the field (it was
   * held, or a mapping made it): typed by us, in insert mode. True if it was.
   */
  #type(key) {
    if (this.mode !== "insert") return false;
    const single = Boolean(this.buffer.field?.singleLine);
    const ch = isPrintable(key) ? key : key === "<Tab>" ? "\t" : key === "<CR>" && !single ? "\n" : null;
    if (ch != null) {
      this.#enqueue(() => this.#typeText(ch));
      return true;
    }
    if (key === "<BS>") {
      this.#enqueue(() => this.#backspace());
      return true;
    }
    return false;
  }

  async #typeText(ch) {
    const { cursor, anchor } = this.#read();
    const [from, to] = [Math.min(cursor, anchor), Math.max(cursor, anchor)];
    await this.#edit(from, to, ch);
    await this.#move(from + ch.length);
  }

  async #backspace() {
    const { text, cursor, anchor } = this.#read();
    let [from, to] = [Math.min(cursor, anchor), Math.max(cursor, anchor)];
    if (from === to) {
      if (from === 0) return;
      from = T.prev(text, from);
    }
    await this.#edit(from, to, "");
    await this.#move(from);
  }

  /** A command (init.js's vim.command), from a mapping's <Cmd>…<CR> or vim.cmd(): "Name[!] args". */
  runCommand(line) {
    const m = /^\s*:?\s*([A-Za-z][A-Za-z0-9]*)(!?)\s*(.*)$/.exec(line);
    const command = m && this.vim.user.commands.get(m[1]);
    if (!command) {
      this.vim.emit("error", new Error(`pluto vim: not a command: :${line.trim()}`));
      return;
    }
    this.#enqueue(async () => {
      this.edits = 0;
      this.changeBefore = this.buffer.text().text;
      const { text, cursor } = this.#read();
      const buf = this.#userBuffer(text, T.clampNormal(text, cursor));
      await command.fn(buf, { args: m[3], bang: m[2] === "!" });
      this.#endChange();
    });
  }

  /** A UserBuffer (init.js's view of the field) whose edits and moves are the field's. */
  #userBuffer(text, pos) {
    return new UserBuffer(text, pos, {
      edit: (from, to, insert) => this.#edit(from, to, insert),
      move: (offset) => this.#move(offset),
      mode: this.mode,
    });
  }

  #feedRaw(key) {
    if (this.mode === "insert") return this.#feedInsert(key);
    if (this.mode === "replace") return this.#feedReplace(key);
    return this.#feedNormal(key);
  }

  // ── Keys ───────────────────────────────────────────────────────────────

  #feedNormal(key) {
    const visual = this.mode === "visual" || this.mode === "vline";
    if (key === "<Esc>" || key === "<C-[>") {
      if (this.pending.length) {
        this.pending = [];
        this.#caret();
        return true;
      }
      if (visual) {
        this.#setMode("normal");
        this.#enqueue(() => this.#exitVisual());
        return true;
      }
      if (this.oneShot) {
        this.oneShot = false;
        this.#setMode("insert");
        this.#enqueue(() => this.#beginInsert(null));
        return true;
      }
      // Escape in normal mode is the page's (Principle 3).
      return key !== "<Esc>";
    }
    if (key === "<CR>" && this.buffer.field?.singleLine && !this.pending.length) return false;
    this.pending.push(key);
    const parsed = parseCommand(this.vim, this.pending, visual);
    if (parsed === MORE) {
      this.#caret();
      return true;
    }
    const keys = this.pending;
    this.pending = [];
    this.#caret();
    if (parsed === BAD) return keys.length > 1 || isPrintable(key);
    this.#dispatch({ ...parsed.cmd, mode: this.mode });
    return true;
  }

  #feedInsert(key) {
    if (this.insertRegister) {
      if (key === "<C-r>") return true; // Ctrl+R Ctrl+R: put literally, which is what we do anyway.
      this.insertRegister = false;
      if (REGISTER_NAMES.test(key)) this.#enqueue(() => this.#putInInsert(key));
      return true;
    }
    switch (key) {
      case "<Esc>":
        if (this.buffer.field?.singleLine && this.vim.opt.inputs === "manual") return false;
        this.#leaveInsert();
        return true;
      case "<C-[>":
        this.#leaveInsert();
        return true;
      case "<C-r>":
        this.insertRegister = true;
        return true;
      case "<C-o>":
        this.#leaveInsert({ keepCursor: true });
        this.oneShot = true;
        return true;
      case "<C-w>":
        this.#enqueue(() => this.#deleteBefore("word"));
        return true;
      case "<C-u>":
        this.#enqueue(() => this.#deleteBefore("line"));
        return true;
      default:
        return false;
    }
  }

  #feedReplace(key) {
    if (key === "<Esc>" || key === "<C-[>") {
      this.#setMode("normal");
      this.#enqueue(() => this.#endReplace());
      return true;
    }
    if (key === "<BS>") {
      this.#enqueue(() => this.#replaceBack());
      return true;
    }
    const ch = key === "<CR>" ? "\n" : key === "<Tab>" ? "\t" : isPrintable(key) ? key : null;
    if (ch == null) return false;
    this.#enqueue(() => this.#replaceChar(ch));
    return true;
  }

  // ── Modes ──────────────────────────────────────────────────────────────

  #setMode(mode) {
    if (mode === this.mode) return this.#caret();
    const from = this.mode;
    this.mode = mode;
    this.#caret();
    this.vim.emit("ModeChanged", { session: this, from, to: mode });
  }

  #caret() {
    try { this.buffer.setCaret?.(CARETS[this.displayMode] ?? "block", this.displayMode); } catch { /* a caret is cosmetic */ }
  }

  /** The sync half of a command: the mode it leaves, then its effect on the queue. */
  #dispatch(cmd) {
    const visual = cmd.mode === "visual" || cmd.mode === "vline";
    let next = visual ? cmd.mode : "normal";
    if (cmd.type === "operator") next = cmd.op === "c" ? "insert" : "normal";
    else if (cmd.type === "visualOp") next = cmd.entry.op === "c" ? "insert" : "normal";
    else if (cmd.type === "action") {
      const { entry } = cmd;
      if (entry.insert) next = "insert";
      else if (entry.action === "visual") next = cmd.mode === "visual" ? "normal" : "visual";
      else if (entry.action === "visualLine") next = cmd.mode === "vline" ? "normal" : "vline";
      else if (entry.action === "replaceMode") next = "replace";
    }
    if (this.oneShot && next === "normal") {
      this.oneShot = false;
      next = "insert";
      cmd.thenInsert = true;
    }
    if (next === "insert" && this.oneShot) this.oneShot = false;
    cmd.next = next;
    this.#setMode(next);
    this.#enqueue(() => this.#run(cmd));
  }

  #enqueue(fn) {
    this.queue = this.queue.then(fn).catch((error) => this.vim.emit("error", error));
    return this.queue;
  }

  // ── The field ──────────────────────────────────────────────────────────

  #read() {
    const snap = this.buffer.text();
    this.start = snap.start ?? 0;
    return { text: snap.text, cursor: snap.cursor - this.start, anchor: snap.anchor - this.start };
  }

  async #move(offset, extend = false) {
    if (!extend) this.lastPos = offset;
    await this.buffer.move({ offset: this.start + offset, extend });
  }

  async #edit(from, to, insert) {
    if (this.insert) {
      // Typing since our last edit is an undo step of the field's own.
      const now = this.buffer.text().text;
      if (now !== this.insert.checkpoint) this.insert.typed++;
    }
    await this.buffer.edit({ from: this.start + from, to: this.start + to }, insert);
    this.edits++;
    if (this.insert) this.insert.checkpoint = this.buffer.text().text;
  }

  /**
   * A change ends: one step for `u`. It keeps the field's text before and
   * after, so `u` can undo until the text is back, however the field groups
   * its own undo steps (ProseMirror groups by time); `steps` is how many the
   * field likely has, a bound on how far `u` goes.
   */
  #endChange(steps = this.edits, before = this.changeBefore) {
    if (steps > 0) {
      this.undoSteps.push({ steps, before, after: this.buffer.text().text });
      this.redoSteps = [];
    }
    this.edits = 0;
  }

  // ── Running commands ───────────────────────────────────────────────────

  async #run(cmd) {
    this.edits = 0;
    this.changeBefore = this.buffer.text().text;
    switch (cmd.type) {
      case "motion": await this.#runMotion(cmd); break;
      case "operator": await this.#runOperator(cmd); break;
      case "object": await this.#runVisualObject(cmd); break;
      case "visualOp": await this.#runVisualOp(cmd); break;
      case "action": await this.#runAction(cmd); break;
    }
    // After Ctrl+O: the one command has run; insert mode again.
    if (cmd.thenInsert && !this.insert) await this.#beginInsert(null);
  }

  #ctx(text, pos, cmd, op = null) {
    return { text, pos, count: cmd.count, hasCount: cmd.hasCount, arg: cmd.arg, op, vim: this.vim, session: this };
  }

  #updateWant(motion, text, at) {
    if (motion.keepWant) return;
    this.want = motion.wantEnd ? Infinity : at - T.lineStart(text, at);
  }

  async #runMotion(cmd) {
    const { text, cursor } = this.#read();
    const visual = cmd.mode === "visual" || cmd.mode === "vline";
    const pos = visual ? this.vCursor : T.clampNormal(text, cursor);
    // The cursor moved without us (a click, the field's own keys): j and k want its column now.
    if (!visual && (cursor !== this.lastPos || this.want == null)) this.want = pos - T.lineStart(text, pos);
    const target = cmd.entry.fn(this.#ctx(text, pos, cmd));
    if (target == null) return;
    const at = T.clampNormal(text, target);
    this.#updateWant(cmd.entry, text, at);
    if (visual) {
      this.vCursor = at;
      await this.#select(text, cmd.mode);
    } else {
      await this.#move(at);
    }
    return;
  }


  /** The range a motion covers from `pos`, by vim's rules for operators. */
  #motionRange(text, pos, target, kind) {
    let from = Math.min(pos, target);
    let to = Math.max(pos, target);
    if (kind === "linewise") return { from: T.lineStart(text, from), to: T.lineEnd(text, to), linewise: true };
    if (kind === "inclusive") {
      to = to < text.length && text[to] !== "\n" ? T.next(text, to) : to;
      return { from, to, linewise: false };
    }
    // Exclusive: an end at the start of a later line goes back to the end of the line before (:help o_v).
    if (to > from && to === T.lineStart(text, to) && T.lineStart(text, from) !== T.lineStart(text, to)) {
      if (from <= T.firstNonBlank(text, from)) {
        return { from: T.lineStart(text, from), to: to - 1, linewise: true };
      }
      to = to - 1;
    }
    return { from, to, linewise: false };
  }

  async #runOperator(cmd) {
    const { text, cursor } = this.#read();
    const pos = T.clampNormal(text, cursor);
    let range;
    if (cmd.line) {
      const first = T.lineStart(text, pos);
      let last = first;
      for (let k = 1; k < cmd.count; k++) {
        const down = T.nextLineStart(text, last);
        if (down == null) break;
        last = down;
      }
      range = { from: first, to: T.lineEnd(text, last), linewise: true };
    } else if (cmd.object) {
      range = cmd.object(this.#ctx(text, pos, cmd, cmd.op), cmd.around);
    } else {
      const ctx = this.#ctx(text, pos, cmd, cmd.op);
      const target = cmd.motion.fn(ctx);
      if (target != null) {
        const kind = typeof cmd.motion.kind === "function" ? cmd.motion.kind(ctx) : cmd.motion.kind;
        range = this.#motionRange(text, pos, target, kind);
      }
    }
    if (!range) return this.#failed(cmd);
    if (!cmd.replay && cmd.op !== "y") this.vim.lastChange = { cmd, inserted: "" };
    return this.#apply(cmd.op, range, cmd, text, pos);
  }

  /** A command that couldn't run: back to normal mode, if it had left it. */
  async #failed(cmd) {
    if (cmd.next === "insert" && this.mode === "insert") this.#setMode("normal");
  }

  /** An operator over a range (from, to: offsets; to exclusive). */
  async #apply(op, range, cmd, text, pos) {
    const { from, to, linewise } = range;
    const value = { text: text.slice(from, to), linewise };
    const registers = this.vim.registers;
    switch (op) {
      case "d": {
        await registers.delete(cmd.register, value);
        let [a, b] = [from, to];
        if (linewise) {
          if (b < text.length) b++;
          else if (a > 0) a--;
        }
        await this.#edit(a, b, "");
        const after = text.slice(0, a) + text.slice(b);
        const at = linewise ? T.firstNonBlank(after, Math.min(a, after.length)) : T.clampNormal(after, a);
        await this.#move(at);
        this.want = at - T.lineStart(after, at);
        this.#endChange();
        return;
      }
      case "c": {
        await registers.delete(cmd.register, value);
        await this.#edit(from, to, "");
        await this.#move(from);
        return this.#beginInsert(cmd);
      }
      case "y": {
        await registers.yank(cmd.register, value);
        this.vim.emit("TextYankPost", { session: this, register: cmd.register, ...value });
        if (!cmd.line) {
          const at = linewise
            ? (from < T.lineStart(text, pos) ? Math.min(from + (pos - T.lineStart(text, pos)), T.lastChar(text, from)) : pos)
            : T.clampNormal(text, from);
          await this.#move(at);
        }
        return;
      }
      default: {
        // An operator of init.js's (vim.operator).
        const user = this.vim.user.ops.get(op);
        if (!user) return;
        const buf = this.#userBuffer(text, pos);
        await user.fn(buf, { from, to, linewise }, { count: cmd.count, register: cmd.register });
        if (!buf.moved) {
          const now = this.#read();
          await this.#move(T.clampNormal(now.text, Math.min(from, now.text.length)));
        }
        this.#endChange();
        return;
      }
      case ">":
      case "<": {
        const first = T.lineStart(text, from);
        const last = T.lineEnd(text, linewise ? to : Math.max(from, to - 1));
        const lines = text.slice(first, last).split("\n");
        const width = this.vim.opt.shiftwidth * (cmd.line || cmd.mode !== "normal" ? cmd.count : 1);
        const shifted = lines.map((l) => {
          if (op === ">") return l === "" ? l : " ".repeat(width) + l;
          let cut = 0;
          while (cut < l.length && cut < width && (l[cut] === " " || l[cut] === "\t")) { if (l[cut++] === "\t") break; }
          return l.slice(cut);
        }).join("\n");
        await this.#edit(first, last, shifted);
        const after = text.slice(0, first) + shifted + text.slice(last);
        await this.#move(T.firstNonBlank(after, first));
        this.#endChange();
        return;
      }
      case "g~":
      case "gu":
      case "gU": {
        const swap = (s) => [...s].map((ch) => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase())).join("");
        const fn = op === "gu" ? (s) => s.toLowerCase() : op === "gU" ? (s) => s.toUpperCase() : swap;
        const changed = fn(value.text);
        await this.#edit(from, to, changed);
        await this.#move(linewise && cmd.line ? pos : T.clampNormal(text, from));
        this.#endChange();
        return;
      }
    }
  }

  // ── Visual mode ────────────────────────────────────────────────────────

  async #select(text, mode) {
    const a = this.vAnchor;
    const c = this.vCursor;
    let anchor;
    let focus;
    if (mode === "vline") {
      const lo = Math.min(a, c);
      const hi = Math.max(a, c);
      [anchor, focus] = c >= a ? [T.lineStart(text, lo), T.lineEnd(text, hi)] : [T.lineEnd(text, hi), T.lineStart(text, lo)];
    } else if (c >= a) {
      [anchor, focus] = [a, Math.min(T.next(text, c), text.length)];
    } else {
      [anchor, focus] = [Math.min(T.next(text, a), text.length), c];
    }
    await this.#move(anchor);
    await this.#move(focus, true);
  }

  async #exitVisual() {
    await this.#move(this.vCursor);
  }

  #visualRange(text, mode) {
    const lo = Math.min(this.vAnchor, this.vCursor);
    const hi = Math.max(this.vAnchor, this.vCursor);
    if (mode === "vline") return { from: T.lineStart(text, lo), to: T.lineEnd(text, hi), linewise: true };
    return { from: lo, to: Math.min(T.next(text, hi), text.length), linewise: false };
  }

  async #runVisualObject(cmd) {
    const { text } = this.#read();
    const range = cmd.object(this.#ctx(text, this.vCursor, cmd), cmd.around);
    if (!range) return;
    this.vAnchor = range.from;
    this.vCursor = Math.max(range.from, T.prev(text, range.to));
    let mode = cmd.mode;
    if (range.linewise && mode === "visual") {
      mode = "vline";
      this.#setMode("vline");
    }
    await this.#select(text, mode);
  }

  async #runVisualOp(cmd) {
    const { text, cursor } = this.#read();
    let range;
    if (cmd.replay) {
      const pos = T.clampNormal(text, cursor);
      const r = cmd.region;
      if (r.linewise) {
        let last = T.lineStart(text, pos);
        for (let k = 1; k < r.lines; k++) last = T.nextLineStart(text, last) ?? last;
        range = { from: T.lineStart(text, pos), to: T.lineEnd(text, last), linewise: true };
      } else {
        range = { from: pos, to: Math.min(pos + r.chars, T.lineEnd(text, pos)), linewise: false };
      }
    } else {
      range = this.#visualRange(text, cmd.mode);
      if (cmd.entry.lines && !range.linewise) {
        range = { from: T.lineStart(text, range.from), to: T.lineEnd(text, Math.max(range.from, range.to - 1)), linewise: true };
      }
      cmd.region = range.linewise
        ? { linewise: true, lines: T.lineNumber(text, range.to) - T.lineNumber(text, range.from) + 1 }
        : { linewise: false, chars: range.to - range.from };
    }
    const op = cmd.entry.op;
    const pos = range.from;
    if (op !== "y" && !cmd.replay) this.vim.lastChange = { cmd, inserted: "" };
    if (op === "J") return this.#join(text, range.from, Math.max(2, T.lineNumber(text, range.to) - T.lineNumber(text, range.from) + 1));
    if (op === "r") {
      const replaced = [...text.slice(range.from, range.to)].map((ch) => (ch === "\n" ? ch : cmd.arg)).join("");
      await this.#edit(range.from, range.to, replaced);
      await this.#move(range.from);
      return this.#endChange();
    }
    if (op === "p" || op === "P") {
      const value = await this.vim.registers.get(cmd.register);
      if (!value) return this.#move(T.clampNormal(text, range.from));
      if (op === "p") await this.vim.registers.delete(null, { text: text.slice(range.from, range.to), linewise: range.linewise });
      let insert = value.text.repeat(cmd.count);
      if (value.linewise && !range.linewise) insert = `\n${insert}\n`;
      await this.#edit(range.from, range.to, insert);
      await this.#move(T.clampNormal(text.slice(0, range.from) + insert + text.slice(range.to), range.from + (value.linewise && !range.linewise ? 1 : 0)));
      return this.#endChange();
    }
    cmd.op = op;
    return this.#apply(op, range, cmd, text, pos);
  }

  // ── Actions ────────────────────────────────────────────────────────────

  async #runAction(cmd) {
    const { text, cursor } = this.#read();
    const pos = cmd.mode === "visual" || cmd.mode === "vline" ? this.vCursor : T.clampNormal(text, cursor);
    const name = cmd.entry.action;
    if (cmd.entry.insert || cmd.entry.change) {
      if (!cmd.replay) this.vim.lastChange = { cmd, inserted: "" };
    }
    const single = Boolean(this.buffer.field?.singleLine);
    switch (name) {
      case "insert":
        await this.#move(Math.min(cursor, text.length));
        return this.#beginInsert(cmd);
      case "append": {
        const at = T.lineEnd(text, pos) > pos ? T.next(text, pos) : pos;
        await this.#move(at);
        return this.#beginInsert(cmd);
      }
      case "insertLineStart":
        await this.#move(T.firstNonBlank(text, pos));
        return this.#beginInsert(cmd);
      case "appendLineEnd":
        await this.#move(T.lineEnd(text, pos));
        return this.#beginInsert(cmd);
      case "openBelow": {
        if (single) { await this.#move(T.lineEnd(text, pos)); return this.#beginInsert(cmd); }
        const end = T.lineEnd(text, pos);
        await this.#edit(end, end, "\n");
        await this.#move(end + 1);
        return this.#beginInsert(cmd);
      }
      case "openAbove": {
        const start = T.lineStart(text, pos);
        if (single) { await this.#move(start); return this.#beginInsert(cmd); }
        await this.#edit(start, start, "\n");
        await this.#move(start);
        return this.#beginInsert(cmd);
      }
      case "put":
      case "putBefore":
        return this.#put(text, pos, cmd, name === "putBefore");
      case "undo":
      case "redo":
        return this.#undo(name === "redo", cmd.count);
      case "replaceChar": {
        const end = T.lineEnd(text, pos);
        let to = pos;
        for (let k = 0; k < cmd.count; k++) {
          if (to >= end) return;
          to = T.next(text, to);
        }
        const insert = cmd.arg === "\n" ? "\n" : cmd.arg.repeat(cmd.count);
        await this.#edit(pos, to, insert);
        await this.#move(cmd.arg === "\n" ? pos + 1 : pos + insert.length - cmd.arg.length);
        this.#endChange();
        return;
      }
      case "replaceMode":
        this.replaced = { at: pos, original: [], typed: "" };
        this.edits = 0;
        return this.#move(pos);
      case "join":
        return this.#join(text, pos, Math.max(2, cmd.count));
      case "toggleCase": {
        const end = T.lineEnd(text, pos);
        let to = pos;
        for (let k = 0; k < cmd.count && to < end; k++) to = T.next(text, to);
        if (to === pos) return;
        const swapped = [...text.slice(pos, to)].map((ch) => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase())).join("");
        await this.#edit(pos, to, swapped);
        await this.#move(T.clampNormal(text, to));
        this.#endChange();
        return;
      }
      case "repeat":
        return this.#repeat(cmd);
      case "visual":
      case "visualLine": {
        if (cmd.next === "normal") return this.#exitVisual();
        if (cmd.mode === "normal") this.vAnchor = this.vCursor = pos;
        return this.#select(text, cmd.next);
      }
      case "swapEnds": {
        [this.vAnchor, this.vCursor] = [this.vCursor, this.vAnchor];
        return this.#select(text, cmd.mode);
      }
    }
  }

  async #put(text, pos, cmd, before) {
    const value = await this.vim.registers.get(cmd.register);
    if (!value) return;
    const single = Boolean(this.buffer.field?.singleLine);
    if (value.linewise && !single) {
      const block = Array(cmd.count).fill(value.text).join("\n");
      if (before) {
        const at = T.lineStart(text, pos);
        await this.#edit(at, at, `${block}\n`);
        await this.#move(T.firstNonBlank(`${block}\n`, 0) + at);
      } else {
        const at = T.lineEnd(text, pos);
        await this.#edit(at, at, `\n${block}`);
        await this.#move(at + 1 + T.firstNonBlank(block, 0));
      }
    } else {
      const insert = value.text.repeat(cmd.count);
      const at = before || T.lineEnd(text, pos) === pos ? pos : T.next(text, pos);
      await this.#edit(at, at, insert);
      // The cursor ends on the last character put (on the first, for text over lines).
      await this.#move(insert.includes("\n") || !insert ? at : at + T.prev(insert, insert.length));
    }
    this.#endChange();
    return;
  }

  async #undo(redo, count) {
    for (let k = 0; k < count; k++) {
      const change = (redo ? this.redoSteps : this.undoSteps).pop();
      if (!change) {
        await (redo ? this.buffer.redo() : this.buffer.undo());
        continue;
      }
      // Undo (or redo) until the text is what it was, stopping when the field has nothing more to undo.
      const target = redo ? change.after : change.before;
      for (let s = 0; s < change.steps + 3; s++) {
        const now = this.buffer.text().text;
        if (now === target) break;
        await (redo ? this.buffer.redo() : this.buffer.undo());
        if (this.buffer.text().text === now) break;
      }
      (redo ? this.undoSteps : this.redoSteps).push(change);
    }
    const { text, cursor } = this.#read();
    await this.#move(T.clampNormal(text, cursor));
  }

  async #join(text, pos, count) {
    const first = T.lineStart(text, pos);
    let last = first;
    for (let k = 1; k < count; k++) {
      const down = T.nextLineStart(text, last);
      if (down == null) break;
      last = down;
    }
    if (last === first) return;
    const lines = text.slice(first, T.lineEnd(text, last)).split("\n");
    let joined = lines[0];
    let at = 0;
    for (const next of lines.slice(1)) {
      const trimmed = next.replace(/^[ \t]+/, "");
      const space = trimmed === "" || /[ \t]$/.test(joined) || trimmed.startsWith(")") || joined === "" ? "" : " ";
      at = joined.length;
      joined += space + trimmed;
    }
    await this.#edit(first, T.lineEnd(text, last), joined);
    await this.#move(first + at);
    this.#endChange();
  }

  // ── Insert mode ────────────────────────────────────────────────────────

  /** Insert mode starts (the sync half set the mode). On a `.` replay, the recorded text goes in instead. */
  async #beginInsert(cmd) {
    if (cmd?.replay) {
      const { text, cursor } = this.#read();
      const unit = this.#repeatUnit(cmd, this.vim.lastChange?.inserted ?? "");
      const first = this.vim.lastChange?.inserted ?? "";
      const insert = first + unit.repeat(Math.max(0, cmd.count - 1));
      if (insert) await this.#edit(cursor, cursor, insert);
      const end = cursor + insert.length;
      await this.#move(end > T.lineStart(text.slice(0, cursor) + insert, end) ? T.prev(text.slice(0, cursor) + insert, end) : end);
      this.#endChange();
      return;
    }
    const { text, cursor } = this.#read();
    this.insert = { cmd, before: text, at: cursor, checkpoint: text, typed: 0, edits: this.edits, changeBefore: cmd ? this.changeBefore : text };
    this.edits = 0;
    this.vim.emit("InsertEnter", { session: this });
  }

  #repeatUnit(cmd, inserted) {
    const action = cmd?.entry?.action;
    return action === "openBelow" || action === "openAbove" ? `\n${inserted}` : inserted;
  }

  /** The sync half of leaving insert mode; the rest runs on the queue. */
  #leaveInsert({ keepCursor = false } = {}) {
    this.#setMode("normal");
    this.#enqueue(() => this.#endInsert(keepCursor));
  }

  async #endInsert(keepCursor) {
    const session = this.insert;
    this.insert = null;
    let { text, cursor } = this.#read();
    if (session) {
      const typedNow = text !== session.checkpoint ? 1 : 0;
      const inserted = insertedText(session.before, text);
      let steps = session.edits + this.edits + session.typed + typedNow;
      const cmd = session.cmd;
      if (cmd && cmd.count > 1 && inserted) {
        const more = this.#repeatUnit(cmd, inserted).repeat(cmd.count - 1);
        await this.buffer.edit({ from: this.start + cursor, to: this.start + cursor }, more);
        steps++;
        ({ text, cursor } = this.#read());
      }
      await this.vim.registers.setSpecial(".", { text: inserted, linewise: false });
      if (cmd && this.vim.lastChange?.cmd === cmd) this.vim.lastChange.inserted = inserted;
      this.#endChange(steps, session.changeBefore);
      this.vim.emit("InsertLeave", { session: this, inserted });
    }
    if (!keepCursor) {
      const at = cursor > T.lineStart(text, cursor) ? T.prev(text, cursor) : cursor;
      await this.#move(at);
      this.want = at - T.lineStart(text, at);
    }
  }

  async #putInInsert(name) {
    const value = await this.vim.registers.get(name);
    if (!value) return;
    const { cursor, anchor } = this.#read();
    const [from, to] = [Math.min(cursor, anchor), Math.max(cursor, anchor)];
    const insert = value.linewise ? `${value.text}\n` : value.text;
    await this.#edit(from, to, insert);
    await this.#move(from + insert.length);
  }

  async #deleteBefore(what) {
    const { text, cursor } = this.#read();
    const start = T.lineStart(text, cursor);
    let from;
    if (cursor === start) from = cursor > 0 ? cursor - 1 : cursor;
    else if (what === "line") {
      const first = T.firstNonBlank(text, cursor);
      from = cursor > first ? first : start;
    } else {
      from = cursor;
      while (from > start && T.isBlank(text[from - 1])) from--;
      if (from > start) {
        const c = T.cls(text, from - 1);
        while (from > start && T.cls(text, from - 1) === c) from--;
      }
    }
    if (from === cursor) return;
    await this.#edit(from, cursor, "");
    await this.#move(from);
  }

  // ── Replace mode ───────────────────────────────────────────────────────

  async #replaceChar(ch) {
    const { text, cursor } = this.#read();
    const r = this.replaced ?? (this.replaced = { at: cursor, original: [], typed: "" });
    const end = T.lineEnd(text, cursor);
    const to = cursor < end && ch !== "\n" ? T.next(text, cursor) : cursor;
    r.original.push(text.slice(cursor, to));
    r.typed += ch;
    await this.#edit(cursor, to, ch);
    await this.#move(cursor + ch.length);
  }

  async #replaceBack() {
    const r = this.replaced;
    if (!r || !r.original.length) return;
    const { cursor } = this.#read();
    const original = r.original.pop();
    const typed = [...r.typed].pop();
    r.typed = r.typed.slice(0, r.typed.length - typed.length);
    const from = cursor - typed.length;
    await this.#edit(from, cursor, original);
    await this.#move(from);
  }

  async #endReplace() {
    const r = this.replaced;
    this.replaced = null;
    if (r && r.typed) {
      this.vim.lastChange = { cmd: { type: "replaceString", count: 1, hasCount: false }, inserted: r.typed };
    }
    this.#endChange();
    const { text, cursor } = this.#read();
    await this.#move(cursor > T.lineStart(text, cursor) ? T.prev(text, cursor) : cursor);
  }

  // ── Repeat ─────────────────────────────────────────────────────────────

  async #repeat(cmd) {
    const last = this.vim.lastChange;
    if (!last) return;
    const count = cmd.hasCount ? cmd.count : last.cmd.count;
    if (cmd.hasCount) {
      last.cmd.count = cmd.count;
      last.cmd.hasCount = true;
    }
    const replay = { ...last.cmd, count, replay: true, mode: last.cmd.type === "visualOp" ? last.cmd.mode : "normal", thenInsert: false, next: "normal" };
    if (replay.type === "replaceString") {
      const { text, cursor } = this.#read();
      const end = T.lineEnd(text, cursor);
      const typed = last.inserted;
      const to = Math.min(end, cursor + typed.length);
      await this.#edit(cursor, to, typed);
      await this.#move(Math.max(cursor, cursor + typed.length - 1));
      return this.#endChange();
    }
    this.edits = 0;
    await this.#run(replay);
    // An insert's replay ends its own change; an operator's has already ended.
  }
}

/** A <Cmd>…<CR> mapping's keys as the command line they spell. */
function cmdLine(keys) {
  return keys.filter((k) => k !== "<CR>").map((k) => (isPrintable(k) ? k : k === "<lt>" ? "<" : "")).join("");
}

/** What was typed between two versions of a field's text: the part that's new. */
export function insertedText(before, after) {
  let prefix = 0;
  const max = Math.min(before.length, after.length);
  while (prefix < max && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return after.slice(prefix, after.length - suffix);
}

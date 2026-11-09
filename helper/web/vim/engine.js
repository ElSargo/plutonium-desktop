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
import * as P from "./prose.js";
import { UserBuffer } from "./userBuffer.js";

export const DEFAULT_OPTIONS = {
  /** Fields start in insert mode (Principle 2). */
  startInInsert: true,
  /** Single-line inputs: "manual" (Ctrl+[ enters normal mode), "on" (as a textarea), "off". */
  inputs: "manual",
  /** "unnamedplus": the unnamed register is the system clipboard. */
  clipboard: "",
  shiftwidth: 2,
  /** > and <: "quote" puts or takes away a Markdown quote (`> `), for prose; "indent" shifts by shiftwidth, as vim does. */
  shift: "quote",
  /**
   * Keys Pluto Vim takes before the page's own handlers in a field it's on
   * in: Ctrl+[ and Escape, so normal mode is always one key away, and the
   * Escape that leaves insert or visual mode (or cancels a pending command)
   * never reaches the page too: ProseMirror's keymap, Hydra's composer and
   * chat pages (stop, blur) take it. An Escape vim has no use for (normal
   * mode, nothing pending; a single-line input) still goes on to the page
   * (Principle 3). Every other key is the page's first (Principle 1).
   */
  claim: ["<C-[>", "<Esc>"],
  /**
   * j and k move by display lines (gj and gk by real ones) where the field
   * can say where its lines wrap: web pages' fields. With an operator (dj,
   * yk) they're real lines, as in vim.
   */
  displayLines: true,
  /** How long a key that starts a mapping waits for the rest of it, in milliseconds. */
  timeoutlen: 1000,
  /** What <leader> stands for in a mapping, when it's made. */
  mapleader: "\\",
  /** Every copy on the desktop goes into "#1…"#9 (the helper keeps them, in memory). */
  clipboardHistory: false,
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
   * @param {object} [options.store] the registers' store (registers.js): MemoryStore by default, RemoteStore in Plutonium
   */
  constructor({ opt = {}, registers, store } = {}) {
    /** Options the backend set (a test's, a page's), under init.js's. */
    this.baseOpt = opt;
    this.registers = registers ?? new Registers({
      store,
      clipboard: () => this.opt.clipboard,
      scopeOf: (name) => this.registerScopes.get(name) ?? "global",
    });
    /** The last change, for `.`: { cmd, inserted }. */
    this.lastChange = null;
    /** The last f, t, F or T, for ; and ,. */
    this.lastFind = null;
    /** The last / or ? (or * or #): { pattern, backward }. */
    this.lastSearch = null;
    /** Uppercase marks: name → { session, offset }. With remoteMarks, the host keeps them (MarkSet, MarkJump). */
    this.globalMarks = new Map();
    this.remoteMarks = false;
    /** The last register @ played, and the last : command, for @@ and @:. */
    this.lastPlayed = null;
    this.lastEx = null;
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
    /** vim.registers.scope: register → "global", "project" or "thread" (each call to the register store carries it). */
    this.registerScopes = new Map();
    /** The options init.js set (vim.opt.x = …), which win over a page's own (data-pvim-start). */
    this.userOpts = new Set();
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

  /** The mode a field starts in by vim.enable({ …, start }), the last matching rule's; null where none says. */
  startFor(where) {
    let start = null;
    for (const rule of this.rules) if (rule.start && ruleMatches(rule, where)) start = rule.start;
    return start;
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
    if (tokens[1] === "#") {
      // "#1…"#9: clipboard history.
      if (tokens.length < 3) return MORE;
      if (!/^[1-9]$/.test(tokens[2])) return BAD;
      register = `#${tokens[2]}`;
      i = 3;
    } else {
      if (!REGISTER_NAMES.test(tokens[1])) return BAD;
      register = tokens[1];
      i = 2;
    }
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
    // ds{c}, cs{a}{b}, ys{motion}{c}: surround (HYDRA_KEYBOARD.md), as vim-surround's.
    if (rest[0] === "s" && (entry.op === "d" || entry.op === "c" || entry.op === "y")) return parseSurround(vim, op, tokens, at + 1);
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

/** The rest of ds, cs and ys, from tokens[at]: a surround command, or MORE, or BAD. */
function parseSurround(vim, op, tokens, at) {
  const char = (k) => (k < tokens.length ? argOf(tokens[k], false) : undefined);
  const cmd = { ...op, type: "surround" };
  if (op.op === "d" || op.op === "c") {
    const target = char(at);
    if (target === undefined) return MORE;
    if (target == null) return BAD;
    if (op.op === "d") return at + 1 === tokens.length ? { status: "done", cmd: { ...cmd, kind: "delete", target } } : BAD;
    const replacement = char(at + 1);
    if (replacement === undefined) return MORE;
    if (replacement == null || at + 2 !== tokens.length) return BAD;
    return { status: "done", cmd: { ...cmd, kind: "change", target, replacement } };
  }
  // ys: a text object or a motion, then what to surround it with.
  if (at >= tokens.length) return MORE;
  let end;
  if (tokens[at] === "i" || tokens[at] === "a") {
    if (at + 1 >= tokens.length) return MORE;
    const object = vim.objects[tokens[at + 1]];
    if (!object) return BAD;
    cmd.object = object;
    cmd.around = tokens[at] === "a";
    end = at + 2;
  } else {
    const motion = match(vim.tables.motions, tokens, at);
    if (motion === MORE) return MORE;
    if (motion === BAD) return BAD;
    cmd.motion = motion.entry;
    end = motion.end;
    if (motion.entry.arg) {
      const arg = char(end);
      if (arg === undefined) return MORE;
      if (arg == null) return BAD;
      cmd.arg = arg;
      end++;
    }
  }
  const surround = char(end);
  if (surround === undefined) return MORE;
  if (surround == null || end + 1 !== tokens.length) return BAD;
  return { status: "done", cmd: { ...cmd, kind: "add", with: surround } };
}

/** The labels a jump gives its targets, nearest first: the home row, then the rest. */
const JUMP_LABELS = "asdfjklghqweruioptyzxcvbnm";

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
    /** The command line being typed, until Enter: { kind: ":" | "/" | "?" | "=", text }; null otherwise. */
    this.cmd = null;
    /** q{register}: the keys typed since, for the register. */
    this.recording = null;
    /** Lowercase marks: name → offset. */
    this.marks = new Map();
    /** The jump list (offsets), and where Ctrl+O and Ctrl+I are in it. */
    this.jumps = [];
    this.jumpAt = 0;
    /** Where the last jump left from: the ' and ` marks. */
    this.previousJump = null;
    /** The lines visual mode last covered, for '<,'>. */
    this.lastVisual = null;
    this.playing = 0;
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
    /** A labeled jump being typed (s): { query, text, pos, targets }; null otherwise. */
    this.jump = null;
    /** Where insert mode last ended, for gi. */
    this.lastInsertAt = null;
    if (this.off) return;
    this.#caret();
    if (this.mode === "insert") this.#enqueue(() => this.#beginInsert(null));
    else this.#enqueue(async () => { const s = this.#read(); await this.#move(T.clampNormal(s.text, s.cursor)); });
  }

  /** Resolves once every command so far has run. */
  /** Resolves once the queue is empty, including what the queued work queued (a macro's keys). */
  async idle() {
    let queue;
    do {
      queue = this.queue;
      await queue;
    } while (queue !== this.queue);
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
    // A macro is the keys as typed, before mappings.
    if (this.recording) this.recording.keys.push(key);
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
    if (this.cmd) return null;
    if (this.mode === "insert") return this.insertRegister ? null : "i";
    if (this.mode === "replace") return null;
    let i = 0;
    if (this.pending[0] === '"') {
      if (this.pending.length < 2) return null;
      i = this.pending[1] === "#" ? 3 : 2;
      if (this.pending.length < i) return null;
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

  /** Runs a page's action (data-pvim-actions) on this field: false if it has none of that name. */
  runAction(name, detail) {
    const field = this.buffer.field;
    if (!field?.actions?.().has(name)) return false;
    field.action(name, detail);
    return true;
  }

  #edgeAction(key) {
    const field = this.buffer.field;
    if (!field?.actions) return false;
    if (this.runAction(key === "j" ? "menu.next" : "menu.prev")) return true;
    const { text, cursor } = this.#read();
    // The first or last line the field shows, with display lines; else the first or last real line.
    const display = this.vim.opt.displayLines && typeof this.buffer.displayLine === "function"
      ? this.buffer.displayLine(cursor, key === "j" ? 1 : -1, 1) : undefined;
    const edge = display !== undefined ? display === null
      : key === "k" ? T.lineStart(text, cursor) === 0 : text.indexOf("\n", cursor) === -1;
    return edge && this.runAction(key === "j" ? "history.next" : "history.prev");
  }

  /** A command (init.js's vim.command), from a mapping's <Cmd>…<CR> or vim.cmd(): "Name[!] args". */
  runCommand(line) {
    const m = /^\s*:?\s*([A-Za-z][A-Za-z0-9]*)(!?)\s*(.*)$/.exec(line);
    const command = m && this.vim.user.commands.get(m[1]);
    if (!command) {
      // A page's command (data-pvim-commands) runs its action of that name.
      if (m && this.buffer.field?.commands?.().has(m[1])) {
        this.buffer.field.action(m[1]);
        return;
      }
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
    if (this.jump) return this.#feedJump(key);
    if (this.cmd) return this.#feedCmdline(key);
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
    // A page's actions (data-pvim-actions): Enter submits or picks the open menu's item; j and k
    // move in an open menu, and past the last or first line go through the page's history.
    if (!this.pending.length && !visual) {
      if (key === "<CR>" && (this.runAction("menu.select") || this.runAction("submit"))) return true;
      if ((key === "j" || key === "k") && this.#edgeAction(key)) return true;
    }
    if (key === "<CR>" && this.buffer.field?.singleLine && !this.pending.length) return false;
    // q while recording ends the macro.
    if (key === "q" && this.recording && !this.pending.length) {
      this.#stopRecording();
      return true;
    }
    if (key === ":" && countOnly(this.pending)) {
      this.pending = [];
      if (visual) {
        const { text } = this.#read();
        const [a, b] = [this.vAnchor, this.vCursor].sort((x, y) => x - y);
        this.lastVisual = { from: T.lineNumber(text, a), to: T.lineNumber(text, b) };
        this.#setMode("normal");
        this.#enqueue(() => this.#exitVisual());
        this.#startCmdline(":", "'<,'>");
      } else this.#startCmdline(":");
      return true;
    }
    // / and ? are motions: wherever n would be one (after an operator too).
    if ((key === "/" || key === "?") && parseCommand(this.vim, [...this.pending, "n"], visual).status === "done") {
      this.#startCmdline(key);
      return true;
    }
    this.pending.push(key);
    if (key === "=" && this.pending.length === 2 && this.pending[0] === '"') {
      this.#startCmdline("=");
      return true;
    }
    if (key === "#" && this.pending.length === 2 && this.pending[0] === '"') return true;
    const parsed = parseCommand(this.vim, this.pending, visual);
    if (parsed === MORE) {
      this.#caret();
      return true;
    }
    const keys = this.pending;
    this.pending = [];
    this.#caret();
    if (parsed === BAD) return keys.length > 1 || isPrintable(key);
    // A page's key (data-pvim-actions), and the jump: they act at once, not on the queue.
    if (parsed.cmd.entry?.action === "page") return this.#pageKey(parsed.cmd);
    if (parsed.cmd.entry?.action === "jumpStart") return this.#startJump();
    // q{register} starts recording now, not when the queue gets to it: the next key is the macro's.
    if (parsed.cmd.entry?.action === "record") {
      if (/^[a-zA-Z0-9"]$/.test(parsed.cmd.arg)) {
        this.recording = { register: parsed.cmd.arg, keys: [] };
        this.vim.emit("RecordingChanged", { session: this, register: parsed.cmd.arg });
      }
      return true;
    }
    this.#dispatch({ ...parsed.cmd, mode: this.mode });
    return true;
  }

  /**
   * A key a page fills (commands.js, PAGE_KEYS): its action, with the count
   * and, for some, the text under the cursor; else the key's fallback, or the
   * key to the page.
   */
  #pageKey(cmd) {
    const { entry } = cmd;
    const detail = { count: cmd.hasCount ? cmd.count : null };
    if (entry.text) {
      const { text, cursor } = this.#read();
      const pos = T.clampNormal(text, cursor);
      const url = entry.text === "target" ? P.urlAt(text, pos) : null;
      detail.text = url && pos >= url.from && pos < url.to ? text.slice(url.from, url.to) : bigWordAt(text, pos);
    }
    if (this.runAction(entry.page, detail)) return true;
    if (entry.fallback) {
      const count = cmd.hasCount ? String(cmd.count).split("") : [];
      for (const key of [...count, ...parseKeys(entry.fallback)]) this.#feedRaw(key);
      return true;
    }
    return !entry.pass;
  }

  // ── The labeled jump (s) ───────────────────────────────────────────────

  #startJump() {
    const { text, cursor } = this.#read();
    this.jump = { query: "", text, pos: T.clampNormal(text, cursor), targets: [] };
    this.#caret();
    this.vim.emit("JumpLabels", { session: this, query: "", targets: [] });
    return true;
  }

  /**
   * A key while a jump is typed: a label goes there; any other character
   * narrows the matches (the labels never use a character that would
   * continue one); Enter goes to the nearest; Escape cancels.
   */
  #feedJump(key) {
    const jump = this.jump;
    if (key === "<Esc>" || key === "<C-[>") return this.#endJump(null);
    if (key === "<CR>") return this.#endJump(jump.targets[0]?.offset ?? null);
    if (key === "<BS>") {
      if (!jump.query) return this.#endJump(null);
      jump.query = jump.query.slice(0, -1);
      this.#labelJump();
      return true;
    }
    if (!isPrintable(key)) return this.#endJump(null);
    const hit = jump.query ? jump.targets.find((t) => t.label === key) : null;
    if (hit) return this.#endJump(hit.offset);
    jump.query += key;
    this.#labelJump();
    if (!jump.targets.length) {
      this.#message(`no match: ${jump.query}`);
      return this.#endJump(null);
    }
    return true;
  }

  #labelJump() {
    const jump = this.jump;
    const { query, text, pos } = jump;
    jump.targets = [];
    if (query) {
      // Smart case: lower case matches either case.
      const exact = query !== query.toLowerCase();
      const hay = exact ? text : text.toLowerCase();
      const continues = new Set();
      for (let at = hay.indexOf(query); at !== -1; at = hay.indexOf(query, at + 1)) {
        if (at !== pos) jump.targets.push({ offset: at, length: query.length });
        const after = text[at + query.length];
        if (after) continues.add(after.toLowerCase());
      }
      jump.targets.sort((a, b) => Math.abs(a.offset - pos) - Math.abs(b.offset - pos) || a.offset - b.offset);
      const labels = [...JUMP_LABELS].filter((ch) => !continues.has(ch));
      jump.targets.forEach((target, k) => { if (k < labels.length) target.label = labels[k]; });
    }
    this.vim.emit("JumpLabels", { session: this, query, targets: jump.targets });
  }

  #endJump(offset) {
    const from = this.jump?.pos;
    this.jump = null;
    this.vim.emit("JumpLabels", { session: this, query: null, targets: null });
    this.#caret();
    if (offset != null) {
      this.#enqueue(async () => {
        const { text } = this.#read();
        this.#pushJump(from);
        const at = T.clampNormal(text, offset);
        this.want = at - T.lineStart(text, at);
        await this.#move(at);
      });
    }
    return true;
  }

  #feedInsert(key) {
    if (this.insertRegister) {
      if (this.insertRegister === "#") {
        this.insertRegister = false;
        if (/^[1-9]$/.test(key)) this.#enqueue(() => this.#putInInsert(`#${key}`));
        return true;
      }
      if (key === "<C-r>") return true; // Ctrl+R Ctrl+R: put literally, which is what we do anyway.
      this.insertRegister = false;
      if (key === "=") {
        this.#startCmdline("=");
        return true;
      }
      // Ctrl+R # then a digit: clipboard history.
      if (key === "#") {
        this.insertRegister = "#";
        return true;
      }
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
      // A page's open menu (data-pvim-actions), as vim's completion popup: Ctrl+N and Ctrl+P
      // move in it, Ctrl+Y picks, Ctrl+E closes. Without one, the keys are the page's.
      case "<C-n>":
        return this.runAction("menu.next");
      case "<C-p>":
        return this.runAction("menu.prev");
      case "<C-y>":
        return this.runAction("menu.select");
      case "<C-e>":
        return this.runAction("menu.close");
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

  /** The command line as it's typed (":s/a/b/", "/foo", "=1+2"), or null. */
  get cmdline() {
    return this.cmd ? `${this.cmd.kind}${this.cmd.text}` : null;
  }

  /** The "= expression being typed (vimNative.ts holds keys while there is one). */
  get expression() {
    return this.cmd?.kind === "=" ? this.cmd.text : null;
  }

  #startCmdline(kind, text = "") {
    this.cmd = { kind, text };
    this.vim.emit("CmdlineChanged", { session: this, cmdline: this.cmdline });
  }

  /** A key on the command line: Enter runs it, Escape (or deleting it all) cancels. */
  #feedCmdline(key) {
    const cmd = this.cmd;
    const done = (keep) => {
      this.cmd = null;
      this.vim.emit("CmdlineChanged", { session: this, cmdline: null });
      if (!keep) {
        if (this.mode !== "insert") this.pending = [];
        this.#caret();
        return;
      }
      this.#runCmdline(cmd);
    };
    if (key === "<Esc>" || key === "<C-[>") done(false);
    else if (key === "<CR>") done(true);
    else if (key === "<BS>" || key === "<C-h>") {
      if (!cmd.text) done(false);
      else cmd.text = cmd.text.slice(0, -1);
    } else if (key === "<C-u>") cmd.text = "";
    else if (key === "<C-w>") cmd.text = cmd.text.replace(/\S*\s*$/, "");
    else if (key === "<Tab>") cmd.text += "\t";
    else if (isPrintable(key)) cmd.text += key;
    if (this.cmd) this.vim.emit("CmdlineChanged", { session: this, cmdline: this.cmdline });
    return true;
  }

  #runCmdline({ kind, text }) {
    if (kind === "=") {
      const insert = this.mode === "insert";
      this.#enqueue(async () => {
        // An empty expression puts the last one's value again, as in vim.
        if (text) this.vim.registers.expression = await evaluate(text, this.vim);
        if (insert) await this.#putInInsert("=");
      });
      return;
    }
    if (kind === "/" || kind === "?") {
      // An empty search searches for the last one again.
      if (text) {
        this.vim.lastSearch = { pattern: text, backward: kind === "?" };
        void this.vim.registers.setSpecial("/", { text, linewise: false });
      } else if (this.vim.lastSearch) this.vim.lastSearch = { ...this.vim.lastSearch, backward: kind === "?" };
      // As n, with whatever register, count or operator came before the / (d/foo<CR>).
      this.#feedNormal("n");
      return;
    }
    this.#enqueue(() => this.#ex(text));
  }

  // ── Macros, marks and jumps ────────────────────────────────────────────

  #stopRecording() {
    const { register, keys } = this.recording;
    this.recording = null;
    // The q that ended it was recorded too.
    keys.pop();
    const text = keys.map((k) => (k === "<" ? "<lt>" : k)).join("");
    this.vim.emit("RecordingChanged", { session: this, register: null });
    this.#enqueue(() => this.vim.registers.setMacro(register, { text, linewise: false }));
  }

  /**
   * Where mark `name` is in this field, or null. Uppercase marks name a
   * field anywhere: with remoteMarks the host goes there (MarkJump), else
   * one in this field is found here.
   */
  markOffset(name) {
    if (name === "'" || name === "`") return this.previousJump;
    if (/^[a-z]$/.test(name)) {
      if (!this.marks.has(name)) this.vim.emit("error", new Error(`pluto vim: mark ${name} isn't set`));
      return this.marks.get(name) ?? null;
    }
    if (/^[A-Z]$/.test(name)) {
      const mark = this.vim.globalMarks.get(name);
      if (!this.vim.remoteMarks && mark?.session === this) return mark.offset;
      this.vim.emit("MarkJump", { session: this, name });
      return null;
    }
    return null;
  }

  /** Moves the cursor to `offset` (the host, for an uppercase mark in this field). */
  moveTo(offset) {
    this.#enqueue(async () => {
      const { text } = this.#read();
      await this.#move(T.clampNormal(text, offset));
    });
  }

  #pushJump(pos) {
    this.jumps = this.jumps.slice(0, this.jumpAt);
    if (this.jumps.at(-1) !== pos) this.jumps.push(pos);
    if (this.jumps.length > 100) this.jumps.shift();
    this.jumpAt = this.jumps.length;
    this.previousJump = pos;
  }

  /** Marks and jumps move with the text an edit changed. */
  #shiftOffsets(from, to, inserted) {
    const shift = (at) => (at >= to ? at + inserted - (to - from) : at > from ? from : at);
    for (const [name, at] of this.marks) this.marks.set(name, shift(at));
    for (const mark of this.vim.globalMarks.values()) if (mark.session === this) mark.offset = shift(mark.offset);
    this.jumps = this.jumps.map(shift);
    if (this.previousJump != null) this.previousJump = shift(this.previousJump);
    if (this.lastInsertAt != null) this.lastInsertAt = shift(this.lastInsertAt);
  }

  // ── The : line ─────────────────────────────────────────────────────────

  /** Shows `text` where the command line was (the backend draws it). */
  #message(text) {
    this.vim.emit("Message", { session: this, text });
  }

  async #ex(line) {
    this.vim.lastEx = line;
    void this.vim.registers.setSpecial(":", { text: line, linewise: false });
    const { text, cursor } = this.#read();
    const pos = T.clampNormal(text, cursor);
    const lines = T.lineNumber(text, text.length) + 1;
    const here = T.lineNumber(text, pos);
    // A range: %, '<,'>, n, n,m, .
    const m = /^\s*(%|'<,'>|\.|\d+)?(?:,(\.|\$|\d+))?\s*(.*)$/.exec(line);
    const lineOf = (spec) => (spec === "." ? here : spec === "$" ? lines - 1 : Number(spec) - 1);
    let range = null;
    if (m[1] === "%") range = [0, lines - 1];
    else if (m[1] === "'<,'>") range = this.lastVisual ? [this.lastVisual.from, this.lastVisual.to] : null;
    else if (m[1]) range = [lineOf(m[1]), m[2] ? lineOf(m[2]) : lineOf(m[1])];
    const rest = m[3];
    if (!rest && range) {
      // :n goes to line n.
      const at = T.lineStartOf(text, Math.max(0, Math.min(lines - 1, range[1])));
      this.#pushJump(pos);
      return this.#move(T.firstNonBlank(text, at));
    }
    const sub = /^s(?:ubstitute)?([^\w\s])(.*)$/.exec(rest);
    if (sub) return this.#substitute(text, pos, range ?? [here, here], sub[1], sub[2]);
    const global = /^(g|v|g!)(?:lobal)?([^\w\s])(.*)$/.exec(rest);
    if (global) return this.#global(text, range ?? [0, lines - 1], global[1] !== "g", global[2], global[3]);
    if (/^noh(lsearch)?$/.test(rest)) return;
    if (/^(reg(isters)?|di(splay)?)$/.test(rest)) return this.#showRegisters();
    if (/^marks$/.test(rest)) return this.#showMarks(text);
    return this.runCommand(rest);
  }

  async #substitute(text, pos, [first, last], delimiter, body) {
    const parts = splitUnescaped(body, delimiter);
    const pattern = parts[0] || this.vim.lastSearch?.pattern;
    if (!pattern) return this.#message("no pattern");
    const flags = parts[2] ?? "";
    let re;
    try {
      re = new RegExp(pattern, `u${flags.includes("g") ? "g" : ""}${flags.includes("i") ? "i" : ""}`);
    } catch (error) {
      return this.#message(`not a pattern: ${error.message}`);
    }
    this.vim.lastSearch = { pattern, backward: false };
    const replacement = vimReplacement(parts[1] ?? "");
    const from = T.lineStartOf(text, first);
    const to = T.lineEnd(text, T.lineStartOf(text, last));
    let count = 0;
    let lastLine = first;
    const changed = text.slice(from, to).split("\n").map((l, k) => {
      const next = l.replace(re, (...args) => {
        count++;
        lastLine = first + k;
        return expandReplacement(replacement, args);
      });
      return next;
    }).join("\n");
    if (!count) return this.#message(`not found: ${pattern}`);
    this.edits = 0;
    this.changeBefore = text;
    await this.#edit(from, to, changed);
    const after = this.#read().text;
    await this.#move(T.firstNonBlank(after, T.lineStartOf(after, lastLine)));
    this.#endChange();
  }

  async #global(text, [first, last], invert, delimiter, body) {
    const [pattern, command = "d"] = splitUnescaped(body, delimiter);
    if (command.trim() !== "d") return this.#message(":g runs d only, so far");
    let re;
    try {
      re = new RegExp(pattern || this.vim.lastSearch?.pattern || "", "u");
    } catch (error) {
      return this.#message(`not a pattern: ${error.message}`);
    }
    const from = T.lineStartOf(text, first);
    const to = T.lineEnd(text, T.lineStartOf(text, last));
    const kept = text.slice(from, to).split("\n").filter((l) => re.test(l) === invert);
    let end = to;
    let start = from;
    // Deleting every line of a range takes its newline with it.
    if (!kept.length) {
      if (end < text.length) end++;
      else if (start > 0) start--;
    }
    this.edits = 0;
    this.changeBefore = text;
    await this.#edit(start, end, kept.join("\n"));
    const after = this.#read().text;
    await this.#move(T.firstNonBlank(after, Math.min(start, after.length)));
    this.#endChange();
  }

  async #showRegisters() {
    const names = ['"', "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "-", ...("abcdefghijklmnopqrstuvwxyz"), "+", "*", ".", ":", "/", "#1", "#2", "#3"];
    const rows = [];
    for (const name of names) {
      const value = await this.vim.registers.get(name);
      if (value?.text) rows.push(`"${name}  ${value.text.replace(/\n/g, "^J").slice(0, 60)}`);
    }
    this.#message(rows.join("\n") || "no registers");
  }

  #showMarks(text) {
    const rows = [];
    for (const [name, at] of [...this.marks].sort()) rows.push(`${name}  line ${T.lineNumber(text, at) + 1}`);
    for (const [name, mark] of [...this.vim.globalMarks].sort()) rows.push(`${name}  ${mark.session === this ? `line ${T.lineNumber(text, mark.offset) + 1}` : "another field"}`);
    this.#message(rows.join("\n") || "no marks");
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
      else if (entry.action === "surround") next = "normal";
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
    // Whoever changed the text (our edits, typing, the page), marks and jumps move with it.
    const before = this.seenText;
    if (before != null && before !== snap.text && (this.marks.size || this.jumps.length || this.previousJump != null || this.vim.globalMarks.size)) {
      const after = snap.text;
      let head = 0;
      const most = Math.min(before.length, after.length);
      while (head < most && before.charCodeAt(head) === after.charCodeAt(head)) head++;
      let tail = 0;
      while (tail < most - head && before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)) tail++;
      this.#shiftOffsets(head, before.length - tail, after.length - tail - head);
    }
    this.seenText = snap.text;
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
      case "surround": await this.#runSurround(cmd); break;
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
    if (cmd.entry.jump && !visual && at !== pos) this.#pushJump(pos);
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

  /** ds, cs and ys (parseSurround). */
  async #runSurround(cmd) {
    const { text, cursor } = this.#read();
    const pos = T.clampNormal(text, cursor);
    if (!cmd.replay) this.vim.lastChange = { cmd, inserted: "" };
    if (cmd.kind === "add") {
      let range;
      if (cmd.object) range = cmd.object(this.#ctx(text, pos, cmd, "y"), cmd.around);
      else {
        const ctx = this.#ctx(text, pos, cmd, "y");
        const target = cmd.motion.fn(ctx);
        if (target != null) range = this.#motionRange(text, pos, target, typeof cmd.motion.kind === "function" ? cmd.motion.kind(ctx) : cmd.motion.kind);
      }
      if (!range) return;
      return this.#wrap(range.from, range.to, cmd.with);
    }
    const pair = P.findSurround(text, pos, cmd.target, cmd.count);
    if (!pair) return;
    const [open, close] = pair;
    const [a, b] = cmd.kind === "change" ? P.surroundPair(cmd.replacement) : ["", ""];
    await this.#edit(close, close + 1, b);
    await this.#edit(open, open + 1, a);
    await this.#move(open);
    this.#endChange();
  }

  /** Puts the pair `ch` names around from…to (to exclusive), and the cursor on the opening one. */
  async #wrap(from, to, ch) {
    const [open, close] = P.surroundPair(ch);
    await this.#edit(to, to, close);
    await this.#edit(from, from, open);
    await this.#move(from);
    this.#endChange();
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
        const times = cmd.line || cmd.mode !== "normal" ? cmd.count : 1;
        const width = this.vim.opt.shiftwidth * times;
        const quote = this.vim.opt.shift !== "indent";
        const shifted = lines.map((l) => {
          if (quote) return op === ">" ? quoteLine(l, times) : unquoteLine(l, times);
          if (op === ">") return l === "" ? l : " ".repeat(width) + l;
          let cut = 0;
          while (cut < l.length && cut < width && (l[cut] === " " || l[cut] === "\t")) { if (l[cut++] === "\t") break; }
          return l.slice(cut);
        }).join("\n");
        await this.#edit(first, last, shifted);
        const after = text.slice(0, first) + shifted + text.slice(last);
        // A quoted line's cursor goes past its markers, onto the text.
        const markers = quote ? /^\s*(?:> ?)*/.exec(shifted)[0].length : 0;
        await this.#move(quote ? T.clampNormal(after, first + markers) : T.firstNonBlank(after, first));
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
      case "insertLast":
        await this.#move(Math.min(this.lastInsertAt ?? cursor, text.length));
        return this.#beginInsert(cmd);
      case "appendEnd":
        await this.#move(text.length);
        return this.#beginInsert(cmd);
      case "surround": {
        if (cmd.mode !== "visual" && cmd.mode !== "vline") return;
        const range = this.#visualRange(text, cmd.mode);
        this.vCursor = range.from;
        return this.#wrap(range.from, range.to, cmd.arg);
      }
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
      case "mark":
        if (/^[a-z]$/.test(cmd.arg)) this.marks.set(cmd.arg, pos);
        else if (/^[A-Z]$/.test(cmd.arg)) {
          this.vim.globalMarks.set(cmd.arg, { session: this, offset: pos });
          this.vim.emit("MarkSet", { session: this, name: cmd.arg, offset: pos });
        }
        return;
      case "play":
        return this.#play(cmd);
      case "jumpBack": {
        if (this.jumpAt === this.jumps.length) {
          // Coming back to here is Ctrl+I's.
          this.jumps.push(pos);
        }
        if (this.jumpAt <= 0) return;
        this.jumpAt--;
        return this.#move(T.clampNormal(text, this.jumps[this.jumpAt]));
      }
      case "jumpForward": {
        if (this.jumpAt + 1 >= this.jumps.length) return;
        this.jumpAt++;
        return this.#move(T.clampNormal(text, this.jumps[this.jumpAt]));
      }
    }
  }

  /** @{register}: its keys again, as typed (through mappings); @@ the last one, @: the last : command. */
  async #play(cmd) {
    if (this.playing > 20) {
      this.vim.emit("error", new Error("pluto vim: macros play each other without end"));
      return;
    }
    let name = cmd.arg;
    if (name === "@") name = this.vim.lastPlayed;
    if (!name) return;
    if (name === ":") {
      if (this.vim.lastEx != null) for (let k = 0; k < cmd.count; k++) await this.#ex(this.vim.lastEx);
      return;
    }
    if (!/^[a-zA-Z0-9".+*-]$/.test(name)) return;
    this.vim.lastPlayed = name;
    const value = await this.vim.registers.get(name);
    if (!value?.text) return;
    this.playing++;
    try {
      for (let k = 0; k < cmd.count; k++) this.sendKeys(value.text, { remap: true });
    } finally {
      this.playing--;
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
    this.lastInsertAt = cursor;
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
/**
 * "=: JavaScript, evaluated in the engine's world (not the page's), as a
 * register's value. A promise is waited for; an array is lines (linewise);
 * null and undefined are nothing.
 */
async function evaluate(source, vim) {
  try {
    const result = await (0, eval)(source);
    if (result == null) return null;
    if (Array.isArray(result)) return { text: result.map(String).join("\n"), linewise: true };
    return { text: typeof result === "object" ? JSON.stringify(result) : String(result), linewise: false };
  } catch (error) {
    vim.emit("error", new Error(`pluto vim: "=${source}: ${error?.message ?? error}`));
    return null;
  }
}

/** Nothing but a count (and a register) typed: where : may start. */
function countOnly(pending) {
  let i = pending[0] === '"' ? 2 : 0;
  for (; i < pending.length; i++) if (!/^[0-9]$/.test(pending[i])) return false;
  return true;
}

/** "a/b\/c/g" split on unescaped `delimiter`, with \<delimiter> made plain. */
function splitUnescaped(body, delimiter) {
  const parts = [""];
  for (let k = 0; k < body.length; k++) {
    if (body[k] === "\\" && body[k + 1] === delimiter) {
      parts[parts.length - 1] += delimiter;
      k++;
    } else if (body[k] === delimiter) parts.push("");
    else parts[parts.length - 1] += body[k];
  }
  return parts;
}

/** A replacement in vim's spelling: & is the match, \1…\9 groups, \n a newline, \& a plain &. */
function vimReplacement(replacement) {
  const out = [];
  for (let k = 0; k < replacement.length; k++) {
    const ch = replacement[k];
    if (ch === "\\" && k + 1 < replacement.length) {
      const next = replacement[++k];
      if (/[0-9]/.test(next)) out.push({ group: Number(next) });
      else if (next === "n" || next === "r") out.push("\n");
      else if (next === "t") out.push("\t");
      else out.push(next);
    } else if (ch === "&") out.push({ group: 0 });
    else out.push(ch);
  }
  return out;
}

function expandReplacement(parts, args) {
  // String.replace's callback: match, groups…, offset, whole string (and maybe named groups).
  const named = typeof args.at(-1) === "object";
  const groups = args.slice(0, args.length - (named ? 3 : 2));
  return parts.map((p) => (typeof p === "string" ? p : groups[p.group] ?? "")).join("");
}

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

/** The WORD (no blanks) at pos, for K's and gx's text. */
function bigWordAt(text, pos) {
  let from = pos;
  let to = pos;
  while (from > 0 && !/\s/.test(text[from - 1])) from--;
  while (to < text.length && !/\s/.test(text[to])) to++;
  return text.slice(from, to);
}

/** > on a line: one more level of Markdown quote ("> > text" nests; an empty line gets a bare >). */
function quoteLine(line, times) {
  let out = line;
  for (let k = 0; k < times; k++) out = out === "" ? ">" : `> ${out}`;
  return out;
}

/** < on a line: one level of Markdown quote less, if it has one. */
function unquoteLine(line, times) {
  let out = line;
  for (let k = 0; k < times; k++) out = out.replace(/^ {0,3}> ?/, "");
  return out;
}

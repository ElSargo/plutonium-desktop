// The `vim` that init.js's setup(vim) gets (PLUTO_VIM.md, init.js): options,
// mappings, new motions, operators, text objects and commands, events,
// registers, where Pluto Vim is on. Names follow neovim's where the idea is
// the same.
//
// configure(vim, setup) runs a setup function on a Vim from scratch: the Vim
// goes back to its built-ins first, so running it again (init.js saved) leaves
// nothing of the last version behind. Everything is checked as it's set, and
// a mistake throws with what was wrong, so `plutonium vim check` reports it
// before a page runs it.

import { normalizeKey, parseKeys, isPrintable } from "./keys.js";
import { MAP_MODES, parseCommand } from "./engine.js";
import { UserBuffer } from "./userBuffer.js";

const EVENTS = new Set(["ModeChanged", "InsertEnter", "InsertLeave", "TextYankPost", "FieldEnter", "FieldLeave", "CmdlineChanged"]);
const SCOPES = new Set(["global", "project", "thread"]);
const KINDS = new Set(["exclusive", "inclusive", "linewise"]);
const MAP_OPTS = new Set(["remap", "noremap", "expr", "desc", "silent", "nowait"]);
const RULE_KEYS = new Set(["site", "shell", "app", "selector"]);

/** Options documented for later steps, which say so rather than "unknown". */
const LATER_OPTIONS = { clipboardHistory: "clipboard history (step 9)", whichwrap: "whichwrap", iskeyword: "iskeyword" };

const OPTIONS = {
  startInInsert: (v) => bool(v),
  inputs: (v) => oneOf(v, ["manual", "on", "off"]),
  clipboard: (v) => oneOf(v, ["", "unnamedplus"]),
  shiftwidth: (v) => { if (!Number.isInteger(v) || v < 1 || v > 16) throw new TypeError("a whole number from 1 to 16"); return v; },
  claim: (v) => { if (!Array.isArray(v)) throw new TypeError("a list of keys, like [\"<C-[>\"]"); return v.map(oneKey); },
  timeoutlen: (v) => { if (typeof v !== "number" || !(v >= 0) || v > 10000) throw new TypeError("milliseconds, from 0 to 10000"); return v; },
  mapleader: (v) => oneKey(v),
};

function bool(v) {
  if (typeof v !== "boolean") throw new TypeError("true or false");
  return v;
}

function oneOf(v, values) {
  if (!values.includes(v)) throw new TypeError(`one of ${values.map((x) => JSON.stringify(x)).join(", ")}`);
  return v;
}

function oneKey(v) {
  const keys = typeof v === "string" ? parseKeys(v) : [];
  if (keys.length !== 1) throw new TypeError(`one key in vim's notation, like "<C-[>" or " " (not ${JSON.stringify(v)})`);
  return keys[0];
}

/** Keys as they're written in a mapping: a space is <Space>, "<" is <lt>. */
function spell(keys) {
  return keys.map((k) => (k === " " ? "<Space>" : k === "<" ? "<lt>" : k)).join("");
}

function fail(what, message) {
  throw new Error(`pluto vim: ${what}: ${message}`);
}

/** The modes a mapping's `modes` names: "n", "i", "v" ("x" is "v"; "" is normal and visual), or a list of them. */
function mapModes(modes) {
  const list = Array.isArray(modes) ? modes : modes === "" ? ["n", "v"] : [...String(modes)];
  if (!list.length) fail("keymap", "no mode (\"n\", \"i\" or \"v\")");
  return [...new Set(list.map((m) => {
    if (m === "x") return "v";
    if (MAP_MODES.includes(m)) return m;
    if (m === "o") fail("keymap", "operator-pending mappings (\"o\") aren't supported yet; vim.textobject and vim.motion make keys that work after an operator");
    return fail("keymap", `no mode ${JSON.stringify(m)}: "n", "i" or "v" (and "x", which is "v")`);
  }))];
}

/** A mapping's or a command's keys, with <leader> as vim.opt.mapleader. */
function lhsKeys(vim, lhs, what) {
  if (typeof lhs !== "string" || lhs === "") fail(what, "keys must be a non-empty string, in vim's notation");
  return parseKeys(lhs.replace(/<leader>/gi, vim.opt.mapleader === "<" ? "<lt>" : vim.opt.mapleader));
}

/**
 * Runs `setup` (init.js's default export) on `vim`, from its built-ins.
 * Returns { warnings }: what's legal but likely not meant (a mapping that
 * makes a built-in wait, one set twice). Throws, leaving `vim` at its
 * built-ins, if setup does.
 * @param {object} [host] { desktopCall(name, args), shell }: what the backend gives
 */
export function configure(vim, setup, host = {}) {
  vim.reset();
  if (setup == null) return { warnings: [] };
  if (typeof setup !== "function") fail("init.js", "its default export must be a function: export default function setup(vim) { … }");
  const warnings = [];
  const api = createApi(vim, host, warnings);
  try {
    const result = setup(api);
    if (result && typeof result.then === "function") {
      result.then(null, () => {});
      fail("init.js", "setup(vim) must finish at once, not return a promise: keys are answered as they come");
    }
  } catch (error) {
    vim.reset();
    throw error;
  }
  warnings.push(...waits(vim));
  return { warnings };
}

/** Mappings that make other keys wait for timeoutlen: a built-in command they start with, or another mapping. */
function waits(vim) {
  const out = [];
  for (const mode of ["n", "v"]) {
    for (const m of vim.keymaps[mode].values()) {
      for (let n = 1; n < m.lhs.length; n++) {
        const prefix = m.lhs.slice(0, n);
        if (parseCommand(vim, prefix, mode === "v").status === "done") {
          out.push(`${mode} ${spell(m.lhs)}: ${spell(prefix)} now waits up to ${vim.opt.timeoutlen} ms for the rest of it before it runs`);
          break;
        }
      }
    }
  }
  for (const mode of MAP_MODES) {
    const maps = [...vim.keymaps[mode].values()];
    for (const a of maps) {
      if (a.opts.nowait) continue;
      const longer = maps.find((b) => b.lhs.length > a.lhs.length && a.lhs.every((k, j) => k === b.lhs[j]));
      if (longer) out.push(`${mode} ${spell(a.lhs)}: waits up to ${vim.opt.timeoutlen} ms, in case it's ${spell(longer.lhs)} (nowait: true runs it at once)`);
    }
  }
  return out;
}

function createApi(vim, host, warnings) {
  const opt = new Proxy({}, {
    get: (_, key) => vim.opt[key],
    set: (_, key, value) => {
      const check = OPTIONS[key];
      if (!check) {
        if (key in LATER_OPTIONS) fail(`vim.opt.${String(key)}`, `${LATER_OPTIONS[key]} isn't built yet`);
        fail(`vim.opt.${String(key)}`, `no such option (there are ${Object.keys(OPTIONS).join(", ")})`);
      }
      try {
        vim.opt[key] = check(value);
      } catch (error) {
        fail(`vim.opt.${String(key)}`, `${error.message}`);
      }
      return true;
    },
    has: (_, key) => key in vim.opt,
    ownKeys: () => Reflect.ownKeys(vim.opt),
    getOwnPropertyDescriptor: (_, key) => (key in vim.opt ? { value: vim.opt[key], enumerable: true, configurable: true, writable: true } : undefined),
  });

  const current = (what) => vim.current ?? fail(what, "only works while a mapping's function runs");

  const builtIn = (table, keys) => table.some((e) => !e.user && e.keys.length === keys.length && e.keys.every((k, j) => k === keys[j]));

  return {
    opt,

    keymap: {
      /** A mapping: `rhs` is keys (vim's notation) or a function; opts: remap, expr, nowait, desc. */
      set(modes, lhs, rhs, opts = {}) {
        for (const key of Object.keys(opts ?? {})) if (!MAP_OPTS.has(key)) fail(`keymap ${lhs}`, `no option ${key} (there are ${[...MAP_OPTS].join(", ")})`);
        if (typeof rhs !== "string" && typeof rhs !== "function") fail(`keymap ${lhs}`, "the right-hand side must be keys (a string) or a function");
        if (opts.expr && typeof rhs !== "function") fail(`keymap ${lhs}`, "expr needs a function, whose result is the keys");
        const keys = lhsKeys(vim, lhs, `keymap ${lhs}`);
        const remap = opts.remap ?? (opts.noremap === false);
        for (const mode of mapModes(modes)) {
          const id = keys.join("\0");
          if (vim.keymaps[mode].has(id)) warnings.push(`${mode} ${spell(keys)}: mapped again; the later one is kept`);
          vim.keymaps[mode].set(id, { lhs: keys, rhs, opts: { remap, expr: Boolean(opts.expr), nowait: Boolean(opts.nowait), desc: opts.desc ?? "" } });
        }
      },
      /** Removes a mapping. */
      del(modes, lhs) {
        const keys = lhsKeys(vim, lhs, `keymap.del ${lhs}`);
        for (const mode of mapModes(modes)) {
          if (!vim.keymaps[mode].delete(keys.join("\0"))) fail(`keymap.del ${lhs}`, `no ${mode} mapping for it`);
        }
      },
    },

    /** A motion: fn(buf, { count, hasCount, arg, operator }) returns where the cursor goes, or null. opts: kind ("exclusive", "inclusive", "linewise"), arg (it takes a character, as f does). */
    motion(lhs, fn, { kind = "exclusive", arg = false } = {}) {
      const keys = lhsKeys(vim, lhs, `motion ${lhs}`);
      if (typeof fn !== "function") fail(`motion ${lhs}`, "needs a function");
      if (!KINDS.has(kind)) fail(`motion ${lhs}`, `kind is "exclusive", "inclusive" or "linewise"`);
      if (builtIn(vim.tables.motions, keys)) warnings.push(`motion ${spell(keys)}: replaces the built-in one`);
      vim.user.motions = vim.user.motions.filter((e) => e.keys.join("\0") !== keys.join("\0"));
      vim.user.motions.push({
        keys,
        kind,
        user: true,
        arg: Boolean(arg),
        fn: (ctx) => {
          const at = fn(new UserBuffer(ctx.text, ctx.pos, { mode: ctx.session.mode }), { count: ctx.count, hasCount: ctx.hasCount, arg: ctx.arg, operator: ctx.op });
          if (at == null) return null;
          if (!Number.isInteger(at) || at < 0 || at > ctx.text.length) fail(`motion ${lhs}`, `returned ${JSON.stringify(at)}, not an offset in the text (0…${ctx.text.length}) or null`);
          return at;
        },
      });
      vim.rebuild();
    },

    /** An operator: fn(buf, range, { count, register }) changes the range, with buf.edit(). */
    operator(lhs, fn) {
      const keys = lhsKeys(vim, lhs, `operator ${lhs}`);
      if (typeof fn !== "function") fail(`operator ${lhs}`, "needs a function");
      const name = `user:${spell(keys)}`;
      if (vim.tables.normal.some((e) => e.type === "operator" && !e.op.startsWith("user:") && e.keys.join("\0") === keys.join("\0"))) {
        warnings.push(`operator ${spell(keys)}: replaces the built-in one`);
      }
      vim.user.operators = vim.user.operators.filter((e) => e.op !== name);
      vim.user.operators.push({ keys, op: name });
      vim.user.ops.set(name, { fn });
      vim.rebuild();
    },

    /** A text object, for i{key} and a{key}: fn(buf, around, { count }) returns a range, or null. */
    textobject(key, fn) {
      if (typeof key !== "string" || !isPrintable(key)) fail(`textobject ${key}`, "the key is one character (\"u\" makes iu and au)");
      if (typeof fn !== "function") fail(`textobject ${key}`, "needs a function");
      if (key in vim.objects && !(key in vim.user.objects)) warnings.push(`textobject ${key}: replaces the built-in i${key} and a${key}`);
      vim.user.objects[key] = (ctx, around) => {
        const range = fn(new UserBuffer(ctx.text, ctx.pos, { mode: ctx.session.mode }), around, { count: ctx.count });
        if (range == null) return null;
        const { from, to } = range;
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > ctx.text.length) {
          fail(`textobject ${key}`, `returned ${JSON.stringify(range)}, not a range { from, to } in the text, or null`);
        }
        return { from, to, linewise: Boolean(range.linewise) };
      };
      vim.rebuild();
    },

    /** A command, run by a mapping's <Cmd>Name<CR> or vim.cmd("Name"): fn(buf, { args, bang }). */
    command(name, fn, opts = {}) {
      if (typeof name !== "string" || !/^[A-Z][A-Za-z0-9]*$/.test(name)) fail(`command ${name}`, "a command's name starts with a capital letter, as in neovim: \"Upper\"");
      if (typeof fn !== "function") fail(`command ${name}`, "needs a function");
      if (vim.user.commands.has(name)) warnings.push(`command ${name}: made again; the later one is kept`);
      vim.user.commands.set(name, { fn, desc: opts.desc ?? "" });
    },

    /** Runs a command in the field a mapping's function runs for. */
    cmd(line) {
      current("vim.cmd").runCommand(String(line));
    },

    /** Neovim's autocmd events that make sense here: ModeChanged, InsertEnter, InsertLeave, TextYankPost, FieldEnter, FieldLeave. */
    on(event, fn) {
      if (!EVENTS.has(event)) fail(`vim.on(${JSON.stringify(event)})`, `no such event (there are ${[...EVENTS].join(", ")})`);
      if (typeof fn !== "function") fail(`vim.on(${event})`, "needs a function");
      const unlisten = vim.on(event, ({ session, ...data }) => {
        const field = session?.buffer?.el ?? session?.buffer?.root ?? data.field ?? null;
        vim.withSession(session ?? null, () => fn({ ...data, field, mode: session?.mode ?? null }));
      });
      vim.user.unlisten.push(unlisten);
      return unlisten;
    },

    registers: {
      /** A register's value, { text, linewise }, or null. A promise: the register store answers asynchronously. */
      get(name) {
        if (typeof name !== "string" || !/^[a-zA-Z0-9"\-+*.:/=]$/.test(name)) fail(`registers.get(${JSON.stringify(name)})`, "not a register");
        return vim.registers.get(name);
      },
      /** Sets a register: text, or { text, linewise }. A capital letter appends, as in vim. */
      set(name, value) {
        if (typeof name !== "string" || !/^[a-zA-Z0-9"\-+*]$/.test(name)) fail(`registers.set(${JSON.stringify(name)})`, "not a register init.js can set (letters, digits, \", -, + and *)");
        const v = typeof value === "string" ? { text: value, linewise: false } : value;
        if (!v || typeof v.text !== "string") fail(`registers.set(${name})`, "the value is text, or { text, linewise }");
        const target = name === "*" ? "+" : name;
        if (/^[A-Z]$/.test(target)) return vim.registers.yank(target, { text: v.text, linewise: Boolean(v.linewise) });
        return vim.registers.store.set(target, { text: v.text, linewise: Boolean(v.linewise) });
      },
      /** Which registers are global, per project or per thread ("a-z", "t", "0-9"). The register store (helper/src/vimRegisters.ts) keeps them apart. */
      scope(names, scope) {
        if (!SCOPES.has(scope)) fail(`registers.scope(${JSON.stringify(names)})`, `the scope is "global", "project" or "thread"`);
        for (const name of expandRegisters(names)) {
          if (name === "+" || name === "*") fail(`registers.scope(${JSON.stringify(names)})`, `"+ and "* are the system's, always global`);
          vim.registerScopes.set(name, scope);
        }
      },
    },

    /** Turns Pluto Vim off where a rule matches: { site, shell, app, selector }; the last matching rule wins. */
    disable(rule) {
      vim.rules.push({ on: false, ...checkRule(rule, "disable") });
    },
    /** Turns it back on where a rule matches, after a broader disable. */
    enable(rule) {
      vim.rules.push({ on: true, ...checkRule(rule, "enable") });
    },

    desktop: {
      /** Calls a function config.js exports (KEYS.md): a promise. */
      call(name, args) {
        if (typeof host.desktopCall === "function") return host.desktopCall(name, args);
        return Promise.reject(new Error("pluto vim: vim.desktop.call needs config.js (KEYS.md), which isn't built yet"));
      },
    },

    /** The mode of the field a mapping's function runs for. */
    mode() {
      return vim.current?.mode ?? null;
    },

    /** The selected text in the field a mapping's function runs for: visual mode's, or the field's own selection. */
    selection() {
      const session = current("vim.selection");
      const { text, start = 0, cursor, anchor } = session.buffer.text();
      if (session.mode === "visual" || session.mode === "vline") {
        // Visual mode's ends are offsets in this text.
        const lo = Math.min(session.vAnchor, session.vCursor);
        const hi = Math.max(session.vAnchor, session.vCursor);
        if (session.mode === "vline") {
          const from = text.lastIndexOf("\n", lo - 1) + 1;
          let to = text.indexOf("\n", hi);
          if (to < 0) to = text.length;
          return text.slice(from, to);
        }
        return text.slice(lo, hi + 1);
      }
      return text.slice(Math.min(cursor, anchor) - start, Math.max(cursor, anchor) - start);
    },

    /** Keys into the field a mapping's function runs for, as if typed: through mappings with { remap: true }. */
    feedkeys(keys, { remap = false } = {}) {
      if (typeof keys !== "string") fail("vim.feedkeys", "keys are a string in vim's notation");
      current("vim.feedkeys").sendKeys(keys, { remap });
    },

    /** Vim's key notation, normalized: "<c-R>" → "<C-r>". */
    key: normalizeKey,
  };
}

function checkRule(rule, what) {
  if (!rule || typeof rule !== "object") fail(`vim.${what}`, "takes a rule: { site }, { shell }, { app } or { selector }");
  const keys = Object.keys(rule);
  if (!keys.length) fail(`vim.${what}`, "an empty rule would match everything; give site, shell, app or selector");
  for (const key of keys) {
    if (!RULE_KEYS.has(key)) fail(`vim.${what}`, `no rule key ${key} (there are site, shell, app, selector)`);
    if (typeof rule[key] !== "string" || !rule[key]) fail(`vim.${what}`, `${key} is a non-empty string`);
  }
  return { ...rule };
}

/** "a-z" → a…z; "0-9", "t", "ab": each register they name. */
function expandRegisters(names) {
  if (typeof names !== "string" || !names) fail("registers.scope", "names registers as a string: \"a-z\", \"t\", \"0-9\"");
  const out = [];
  for (let i = 0; i < names.length; i++) {
    const a = names[i];
    if (names[i + 1] === "-" && i + 2 < names.length) {
      const b = names[i + 2];
      for (let c = a.charCodeAt(0); c <= b.charCodeAt(0); c++) out.push(String.fromCharCode(c));
      i += 2;
    } else out.push(a);
  }
  for (const name of out) if (!/^[a-z0-9\-+*]$/.test(name)) fail(`registers.scope(${JSON.stringify(names)})`, `${name} isn't a register with a scope (a-z, 0-9, -)`);
  return out;
}

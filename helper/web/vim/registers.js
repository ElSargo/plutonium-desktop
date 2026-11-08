// Pluto Vim's registers (PLUTO_VIM.md, Registers): vim's rules for which
// register a yank or a delete goes to, over a store. MemoryStore keeps them
// in this world; in Plutonium, RemoteStore (remoteStore.js) is the helper's
// register store, shared by every page, so get() and set() may return
// promises. Each call carries the register's scope (vim.registers.scope):
// "global", "project" or "thread"; the store decides what that means.
//
// A register's value is { text, linewise }. Linewise text has no trailing
// newline: "a\nb" is two lines.

/** Every register name a command may give after `"`. */
export const REGISTER_NAMES = /^[a-zA-Z0-9"\-_+*.:/=]$/;

export class MemoryStore {
  #values = new Map();
  get(name, _scope) { return this.#values.get(name) ?? null; }
  set(name, value, _scope) { this.#values.set(name, value); }
}

export class Registers {
  /**
   * @param {object} [options]
   * @param {{ get(name: string, scope: string): any, set(name: string, value: any, scope: string): any }} [options.store]
   * @param {() => string} [options.clipboard] vim.opt.clipboard: "" or "unnamedplus"
   * @param {(name: string) => string} [options.scopeOf] a register's scope: "global" (the default), "project" or "thread"
   */
  constructor({ store = new MemoryStore(), clipboard = () => "", scopeOf = () => "global" } = {}) {
    /** "=: the last expression's value, this world's own (it's evaluated here). */
    this.expression = null;
    this.clipboard = clipboard;
    this.scopeOf = scopeOf;
    const raw = store;
    this.raw = raw;
    // The store, with each register's scope ("+ is always global: the system's).
    this.store = {
      get: (name) => raw.get(name, name === "+" ? "global" : this.scopeOf(name) ?? "global"),
      set: (name, value) => raw.set(name, value, name === "+" ? "global" : this.scopeOf(name) ?? "global"),
    };
  }

  #unnamedPlus() { return this.clipboard() === "unnamedplus"; }

  /** The value of register `name` (null or `"` for the unnamed one), or null. */
  async get(name) {
    if (name == null || name === '"') name = this.#unnamedPlus() ? "+" : '"';
    if (name === "*") name = "+"; // No primary selection yet (Exo has none): "* is "+.
    if (name === "_") return null;
    if (name === "=") return this.expression;
    if (/^[A-Z]$/.test(name)) name = name.toLowerCase();
    return (await this.store.get(name)) ?? null;
  }

  /** A yank into `name` (null: the unnamed register, and "0). */
  async yank(name, value) {
    if (name === "_") return;
    if (name == null || name === '"') {
      await this.store.set("0", value);
      return this.#setUnnamed(value);
    }
    return this.#setNamed(name, value);
  }

  /**
   * A delete or change into `name`. Without one, a delete of a line or more
   * shifts "1…"9 and goes to "1; a smaller one goes to "-.
   */
  async delete(name, value, { small } = { small: !value.linewise && !value.text.includes("\n") }) {
    if (name === "_") return;
    if (name == null || name === '"') {
      if (small) await this.store.set("-", value);
      else {
        for (let k = 9; k > 1; k--) {
          const before = await this.store.get(String(k - 1));
          if (before) await this.store.set(String(k), before);
        }
        await this.store.set("1", value);
      }
      return this.#setUnnamed(value);
    }
    return this.#setNamed(name, value);
  }

  /** A read-only register the engine keeps: ". (the last insert), ": and "/. */
  async setSpecial(name, value) {
    await this.store.set(name, value);
  }

  async #setNamed(name, value) {
    if (name === "*") name = "+";
    if (/^[A-Z]$/.test(name)) {
      const lower = name.toLowerCase();
      const before = await this.store.get(lower);
      value = before ? append(before, value) : value;
      name = lower;
    }
    if (!/^[a-z0-9\-+]$/.test(name)) return;
    await this.store.set(name, value);
    return this.#setUnnamed(value, name === "+");
  }

  async #setUnnamed(value, plusDone = false) {
    await this.store.set('"', value);
    if (this.#unnamedPlus() && !plusDone) await this.store.set("+", value);
  }
}

/** Appending to a register, as `"Ayw` does: a linewise part makes the whole linewise. */
function append(before, value) {
  if (before.linewise || value.linewise) {
    return { text: `${before.text}\n${value.text}`, linewise: true };
  }
  return { text: before.text + value.text, linewise: false };
}

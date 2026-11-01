// Keys: what every shell's shortcuts have in common (UI_LIBRARY.md). A
// Keymap is a list of actions, each with its default keys, the keys the user
// gave it instead, and what it does. The shell asks it what a key press is,
// which keys to register as shell shortcuts (so they reach the page while an
// app has the keyboard), and lets the user rebind any action (keyEditor()).
//
// Combos are "Super+Ctrl+Alt+Shift+<KeyboardEvent.code>", modifiers in that
// order: "Super+Shift+Digit1", "Alt+F2", "PrintScreen".

export const MODIFIERS = ["Super", "Ctrl", "Alt", "Shift"];

/** The codes of the modifier keys themselves. */
export const MODIFIER_CODES = new Set([
  "MetaLeft", "MetaRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight",
]);

/** The combo of a key event. */
export function comboOf(event) {
  return `${event.metaKey ? "Super+" : ""}${event.ctrlKey ? "Ctrl+" : ""}${event.altKey ? "Alt+" : ""}${event.shiftKey ? "Shift+" : ""}${event.code}`;
}

/** `text` with its modifiers in comboOf()'s order ("Shift+Super+KeyR" → "Super+Shift+KeyR"). */
export function normalizeCombo(text) {
  const parts = String(text).split("+");
  const code = parts.pop();
  const has = (modifier) => parts.includes(modifier);
  return `${has("Super") ? "Super+" : ""}${has("Ctrl") ? "Ctrl+" : ""}${has("Alt") ? "Alt+" : ""}${has("Shift") ? "Shift+" : ""}${code}`;
}

const KEY_NAMES = {
  ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Backquote: "`", Minus: "-", Equal: "=",
  BracketLeft: "[", BracketRight: "]", Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Semicolon: ";",
  Quote: "'", PrintScreen: "Print", PageUp: "Page Up", PageDown: "Page Down", Escape: "Esc",
  MetaLeft: "Super", MetaRight: "Super",
};

/** A combo as people read it: "Super + Shift + 1". */
export function prettyCombo(combo) {
  return combo.split("+").map((part) => KEY_NAMES[part] ?? part.replace(/^Key|^Digit/, "")).join(" + ");
}

// A keyboard Ash takes for a Chromebook's sends its top row as actions: F1–F4
// arrive as Back, Forward, Refresh and the zoom key, so those answer too. (F5
// on are brightness and media keys there: not taken.)
export const TOP_ROW = { F1: "BrowserBack", F2: "BrowserForward", F3: "BrowserRefresh", F4: "ZoomToggle" };

/** `combo`, and its top-row twin if it has one. */
export function withTopRow(combo) {
  const code = combo.split("+").pop();
  return TOP_ROW[code] ? [combo, combo.slice(0, -code.length) + TOP_ROW[code]] : [combo];
}

/**
 * What a key press means while recording a new combo: the combo; null for
 * Escape (cancel); "" for Backspace (no key); undefined for a modifier on its
 * own (keep waiting).
 */
export function recordedCombo(event) {
  if (MODIFIER_CODES.has(event.code)) return undefined;
  const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
  if (plain && event.code === "Escape") return null;
  if (plain && event.code === "Backspace") return "";
  return comboOf(event);
}

/**
 * @typedef {object} ActionSpec
 * @property {string} [group]   where the key editor lists it
 * @property {string} label
 * @property {string[]} [keys]  its default combos
 * @property {() => void} run
 * @property {boolean} [repeat] whether a held key repeats it (default true)
 * @property {boolean} [hotkey] whether the hotkey overlay shows it
 * @property {boolean} [editable] whether the user can rebind it (default true)
 */

export class Keymap extends EventTarget {
  /**
   * @param {{ overrides?: Record<string, string[]>, onOverrides?: (overrides: Record<string, string[]>) => void }} options
   *   overrides: the user's keys by action id (from the shell's settings);
   *   onOverrides: called with them whenever the user changes one.
   */
  constructor({ overrides = {}, onOverrides } = {}) {
    super();
    /** @type {Map<string, ActionSpec & { id: string, defaults: string[] }>} */
    this._actions = new Map();
    this._overrides = { ...overrides };
    this._onOverrides = onOverrides;
    /** @type {Map<string, string>} combo → action id */
    this._byCombo = new Map();
  }

  /** Adds (or replaces) action `id`. */
  define(id, spec) {
    const defaults = (spec.keys ?? []).map(normalizeCombo);
    this._actions.set(id, { repeat: true, hotkey: false, editable: true, group: "", ...spec, id, defaults });
    this._rebuild();
    return this;
  }

  /** Removes the actions whose id is `id`, or starts with it when it ends in "*". */
  undefine(id) {
    const prefix = id.endsWith("*") ? id.slice(0, -1) : null;
    for (const key of [...this._actions.keys()]) {
      if (prefix !== null ? key.startsWith(prefix) : key === id) this._actions.delete(key);
    }
    this._rebuild();
  }

  /** The actions, in the order they were defined. */
  list() {
    return [...this._actions.values()];
  }

  get(id) {
    return this._actions.get(id) ?? null;
  }

  /** Action `id`'s keys now: the user's, else its defaults. */
  keysOf(id) {
    const action = this._actions.get(id);
    if (!action) return [];
    return (this._overrides[id] ?? action.defaults).map(normalizeCombo);
  }

  /** Whether the user changed action `id`'s keys. */
  changed(id) {
    return this._overrides[id] !== undefined;
  }

  /** The user's keys, by action id (to keep in the shell's settings). */
  overrides() {
    return { ...this._overrides };
  }

  /** Takes the user's keys from the shell's settings (no onOverrides call). */
  setOverrides(overrides) {
    this._overrides = { ...(overrides ?? {}) };
    this._rebuild();
  }

  /** Gives action `id` the keys `combos`; null puts its defaults back. */
  setKeys(id, combos) {
    if (combos === null) delete this._overrides[id];
    else this._overrides[id] = combos.map(normalizeCombo);
    this._rebuild();
    this._onOverrides?.(this.overrides());
  }

  /**
   * Gives action `id` just `combo` (from the key editor). An action that had
   * it loses it; that one is returned, so the shell can say so.
   */
  assign(id, combo) {
    const norm = normalizeCombo(combo);
    const clash = this.list().find((other) => other.id !== id && this.keysOf(other.id).includes(norm)) ?? null;
    if (clash) this._overrides[clash.id] = this.keysOf(clash.id).filter((key) => key !== norm);
    this._overrides[id] = [norm];
    this._rebuild();
    this._onOverrides?.(this.overrides());
    return clash;
  }

  /** Every action back to its defaults. */
  resetAll() {
    this._overrides = {};
    this._rebuild();
    this._onOverrides?.(this.overrides());
  }

  /** The action `combo` runs, or null. */
  actionFor(combo) {
    const id = this._byCombo.get(normalizeCombo(combo));
    return id ? this._actions.get(id) ?? null : null;
  }

  /** Every combo some action has, with top-row twins: the shell's shortcuts. */
  combos() {
    return [...this._byCombo.keys()];
  }

  /**
   * Runs what `event` is bound to, if anything (a held key repeats only
   * actions that allow it). Returns the action, or null; the caller decides
   * whether keys go to something else first (a dialog, a menu).
   */
  handle(event) {
    const action = this.actionFor(comboOf(event));
    if (!action) return null;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat || action.repeat) action.run();
    return action;
  }

  _rebuild() {
    this._byCombo = new Map();
    for (const action of this._actions.values()) {
      for (const combo of this.keysOf(action.id)) {
        for (const twin of withTopRow(combo)) if (!this._byCombo.has(twin)) this._byCombo.set(twin, action.id);
      }
    }
    this.dispatchEvent(new Event("change"));
  }
}

/**
 * Records the next combo pressed (the page must have the keyboard). Calls
 * `done` with it, null if Escape cancelled, "" for Backspace (no key).
 * Returns a function that stops recording.
 */
let recordings = 0;

/** Whether a combo is being recorded: the shell's own key handler leaves keys alone then. */
export const isRecording = () => recordings > 0;

export function recordCombo(done) {
  recordings++;
  let stopped = false;
  const onKey = (event) => {
    const combo = recordedCombo(event);
    event.preventDefault();
    event.stopPropagation();
    if (combo === undefined) return;
    stop();
    done(combo);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    recordings--;
    removeEventListener("keydown", onKey, true);
  };
  addEventListener("keydown", onKey, true);
  return stop;
}

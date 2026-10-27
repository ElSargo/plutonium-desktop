// Keys for native windows (Plutonium.dispatchWindowKeyEvents): text and key
// combinations as physical keys (KeyboardEvent.code) with modifiers. Apps get
// keycodes and map them through the session's keymap, so text goes through
// that keymap too (Plutonium.getKeymap), and characters it lacks go on spare
// keys of a temporary keymap (Plutonium.setWindowKeymap). Without a keymap
// (an older browser), as a US layout types.
import type { WindowKeyEvent } from "./desktop.ts";

const ALT = 1;
const CTRL = 2;
const META = 4;
const SHIFT = 8;
const ALTGR = 16;

const MODIFIERS: Record<string, { readonly code: string; readonly bit: number }> = {
  alt: { code: "AltLeft", bit: ALT },
  option: { code: "AltLeft", bit: ALT },
  ctrl: { code: "ControlLeft", bit: CTRL },
  control: { code: "ControlLeft", bit: CTRL },
  meta: { code: "MetaLeft", bit: META },
  super: { code: "MetaLeft", bit: META },
  cmd: { code: "MetaLeft", bit: META },
  win: { code: "MetaLeft", bit: META },
  shift: { code: "ShiftLeft", bit: SHIFT },
};
// AltGr is only a modifier: Exo sends apps the modifiers before each key, and
// the key that is AltGr depends on the layout.
const ALTGR_MODIFIER = { code: "", bit: ALTGR };

const NAMED: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  escape: "Escape",
  esc: "Escape",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  space: "Space",
  capslock: "CapsLock",
  printscreen: "PrintScreen",
  contextmenu: "ContextMenu",
  menu: "ContextMenu",
  plus: "Equal",
  minus: "Minus",
};

// The US layout: character → [code, shifted].
const US: Record<string, readonly [string, boolean]> = {
  " ": ["Space", false],
  "\n": ["Enter", false],
  "\t": ["Tab", false],
  "-": ["Minus", false],
  _: ["Minus", true],
  "=": ["Equal", false],
  "+": ["Equal", true],
  "[": ["BracketLeft", false],
  "{": ["BracketLeft", true],
  "]": ["BracketRight", false],
  "}": ["BracketRight", true],
  "\\": ["Backslash", false],
  "|": ["Backslash", true],
  ";": ["Semicolon", false],
  ":": ["Semicolon", true],
  "'": ["Quote", false],
  '"': ["Quote", true],
  "`": ["Backquote", false],
  "~": ["Backquote", true],
  ",": ["Comma", false],
  "<": ["Comma", true],
  ".": ["Period", false],
  ">": ["Period", true],
  "/": ["Slash", false],
  "?": ["Slash", true],
  ")": ["Digit0", true],
  "!": ["Digit1", true],
  "@": ["Digit2", true],
  "#": ["Digit3", true],
  $: ["Digit4", true],
  "%": ["Digit5", true],
  "^": ["Digit6", true],
  "&": ["Digit7", true],
  "*": ["Digit8", true],
  "(": ["Digit9", true],
};

/** A character the session's keymap types (Plutonium.getKeymap). */
export interface TypedChar {
  readonly text: string;
  readonly code: string;
  /** Shift=8, AltGr=16. */
  readonly modifiers: number;
}

/** A key and the modifiers (SHIFT, ALTGR) held for it. */
interface CharKey {
  readonly code: string;
  readonly modifiers: number;
}

/** The session's keymap: XKB text, and what its keys type. */
export interface Layout {
  readonly keymap: string;
  readonly chars: ReadonlyMap<string, CharKey>;
}

const bits = (modifiers: number) => (modifiers & SHIFT ? 1 : 0) + (modifiers & ALTGR ? 1 : 0);

/** The layout of Plutonium.getKeymap's result: for each character, its key with the fewest modifiers. */
export function layoutOf(keymap: string, chars: readonly TypedChar[]): Layout {
  const map = new Map<string, CharKey>();
  for (const { text, code, modifiers } of chars) {
    const key = { code, modifiers: modifiers & (SHIFT | ALTGR) };
    const known = map.get(text);
    if (!known || bits(key.modifiers) < bits(known.modifiers)) map.set(text, key);
  }
  return { keymap, chars: map };
}

function usKey(char: string): CharKey | undefined {
  if (/^[a-z]$/.test(char)) return { code: `Key${char.toUpperCase()}`, modifiers: 0 };
  if (/^[A-Z]$/.test(char)) return { code: `Key${char}`, modifiers: SHIFT };
  if (/^[0-9]$/.test(char)) return { code: `Digit${char}`, modifiers: 0 };
  const key = US[char];
  return key && { code: key[0], modifiers: key[1] ? SHIFT : 0 };
}

function charKey(char: string, layout?: Layout): CharKey | undefined {
  // Whitespace by key: keymaps type Return and Tab as control characters.
  if (char === "\n" || char === "\t") return usKey(char);
  if (!layout) return usKey(char);
  return layout.chars.get(char) ?? (char === " " ? usKey(char) : undefined);
}

function modifiersOf(key: CharKey) {
  return [...(key.modifiers & SHIFT ? [MODIFIERS.shift!] : []), ...(key.modifiers & ALTGR ? [ALTGR_MODIFIER] : [])];
}

/** Presses and releases `code` with `modifiers` held (pressing them first). */
function stroke(code: string, modifiers: readonly { code: string; bit: number }[]): WindowKeyEvent[] {
  const events: WindowKeyEvent[] = [];
  let held = 0;
  for (const modifier of modifiers) {
    held |= modifier.bit;
    if (modifier.code) events.push({ type: "keyDown", code: modifier.code, modifiers: held });
  }
  events.push({ type: "keyDown", code, modifiers: held }, { type: "keyUp", code, modifiers: held });
  for (const modifier of [...modifiers].reverse()) {
    held &= ~modifier.bit;
    if (modifier.code) events.push({ type: "keyUp", code: modifier.code, modifiers: held });
  }
  return events;
}

/**
 * Spare keys for characters the keymap lacks: F13 to F24 (XKB keycodes 191 to
 * 202), which keyboards seldom have.
 */
const SPARE_KEYS: readonly (readonly [string, number])[] = Array.from({ length: 12 }, (_, i) => [`F${13 + i}`, 191 + i]);

/** Keys to send, and the keymap the window has while they go (none: the session's). */
export interface TypingRun {
  readonly keymap?: string;
  readonly events: WindowKeyEvent[];
}

/**
 * The session's keymap with `chars` on spare keys, one level each, in order;
 * everything else (modifiers, the other keys) as it was. Undefined if the
 * keymap names no spare key.
 */
export function spareKeymap(keymap: string, chars: readonly string[]): { keymap: string; codes: string[] } | undefined {
  const names = keyNames(keymap);
  const symbols = /(xkb_symbols[^{]*\{)([\s\S]*?)(\n\};)/.exec(keymap);
  if (!symbols) return undefined;
  const spare = SPARE_KEYS.filter(([, keycode]) => names.has(keycode));
  if (spare.length < chars.length) return undefined;
  let body = symbols[2]!;
  const lines: string[] = [];
  const codes: string[] = [];
  chars.forEach((char, i) => {
    const [code, keycode] = spare[i]!;
    const name = names.get(keycode)!;
    body = body.replace(new RegExp(`\\n\\s*key <${name.replace(/[^\w]/g, "\\$&")}>\\s*\\{[^}]*\\};`, "g"), "");
    const hex = char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
    lines.push(`\tkey <${name}> { type= "ONE_LEVEL", symbols[1]= [ U${hex} ] };`);
    codes.push(code);
  });
  return {
    keymap:
      keymap.slice(0, symbols.index) +
      symbols[1] +
      body +
      "\n" +
      lines.join("\n") +
      symbols[3] +
      keymap.slice(symbols.index + symbols[0].length),
    codes,
  };
}

/** The keymap's key names by keycode. */
function keyNames(keymap: string): Map<number, string> {
  const names = new Map<number, string>();
  const keycodes = /xkb_keycodes[^{]*\{([\s\S]*?)\n\};/.exec(keymap)?.[1] ?? "";
  for (const match of keycodes.matchAll(/<([^>]+)>\s*=\s*(\d+)\s*;/g)) names.set(Number(match[2]), match[1]!);
  return names;
}

/**
 * `text` typed key by key, through `layout` (or as a US keyboard types it).
 * Characters the layout lacks go on spare keys of a temporary keymap, at
 * most 12 different ones to a run. Throws for characters there's no way to
 * type.
 */
export function typingRuns(text: string, layout?: Layout): TypingRun[] {
  const chars = [...text.replace(/\r\n?/g, "\n")];
  const missing = new Set<string>();
  const runs: TypingRun[] = [];
  let events: WindowKeyEvent[] = [];
  let lacking: string[] = [];
  const names = layout && /xkb_symbols/.test(layout.keymap) ? keyNames(layout.keymap) : new Map();
  const spareKeys = SPARE_KEYS.filter(([, keycode]) => names.has(keycode)).length;
  const flush = () => {
    if (lacking.length > 0) {
      const spare = spareKeymap(layout!.keymap, lacking)!;
      const codes = new Map(lacking.map((char, i) => [char, spare.codes[i]!]));
      const spared = events.map((event) =>
        event.code.startsWith("\0") ? { ...event, code: codes.get(event.code.slice(1))! } : event,
      );
      runs.push({ keymap: spare.keymap, events: spared });
    } else if (events.length > 0) {
      runs.push({ events });
    }
    events = [];
    lacking = [];
  };
  for (const char of chars) {
    const key = charKey(char, layout);
    if (key) {
      events.push(...stroke(key.code, modifiersOf(key)));
      continue;
    }
    // A spare key, filled in when the run's keymap is made.
    if (spareKeys === 0 || /\p{Cc}/u.test(char)) {
      missing.add(char);
      continue;
    }
    if (!lacking.includes(char)) {
      if (lacking.length === spareKeys) flush();
      lacking.push(char);
    }
    events.push(...stroke(`\0${char}`, []));
  }
  if (missing.size > 0) {
    throw new Error(
      `Can't type ${[...missing].map((char) => JSON.stringify(char)).join(", ")}: ` +
        (layout ? "no key for it, even on a temporary keymap." : "native windows get keys as a US keyboard would type them."),
    );
  }
  flush();
  return runs;
}

/** `text` typed key by key, as a US keyboard types it. Throws for characters it can't type. */
export function textKeys(text: string): WindowKeyEvent[] {
  return typingRuns(text).flatMap((run) => run.events);
}

/** Keys that commit what's being typed (a spreadsheet cell, a form field) and move on. */
const COMMIT_KEYS = new Set(["Tab", "Enter", "NumpadEnter"]);

/**
 * `events` in runs that each end with a stroke of a key that commits (Tab,
 * Enter) once every key is up again. An app can lose the next key while it
 * commits (LibreOffice Calc loses the second of two Tabs after typing in a
 * cell), so a caller waits between runs.
 */
export function commitRuns(events: readonly WindowKeyEvent[]): WindowKeyEvent[][] {
  const runs: WindowKeyEvent[][] = [[]];
  let down = 0;
  let commits = false;
  for (const event of events) {
    runs.at(-1)!.push(event);
    if (event.type === "keyDown") {
      down++;
      if (COMMIT_KEYS.has(event.code)) commits = true;
    } else {
      down = Math.max(0, down - 1);
      if (down === 0 && commits) {
        runs.push([]);
        commits = false;
      }
    }
  }
  if (runs.at(-1)!.length === 0) runs.pop();
  return runs;
}

/**
 * A key combination: "Enter", "ctrl+s", "Ctrl+Shift+T", "alt+F4", "a", or a
 * KeyboardEvent.code ("KeyA", "F5", "ArrowDown").
 */
export function comboKeys(combo: string, layout?: Layout): WindowKeyEvent[] {
  const parts = combo.split("+").map((part) => part.trim());
  // "ctrl++" is ctrl and plus.
  if (combo.endsWith("++")) parts.splice(parts.length - 2, 2, "+");
  const key = parts.pop();
  if (!key) throw new Error(`No key in "${combo}".`);
  const modifiers = parts.map((part) => {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (!modifier) throw new Error(`Unknown modifier "${part}" in "${combo}".`);
    return modifier;
  });
  const lower = key.toLowerCase();
  let code: string | undefined = NAMED[lower];
  if (!code && /^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) code = key.toUpperCase();
  if (!code && MODIFIERS[lower]) code = MODIFIERS[lower].code;
  if (!code && [...key].length === 1) {
    // A letter by its key, whichever case ("ctrl+A" is ctrl+a).
    const typed = charKey(key, layout) ?? charKey(key.toLowerCase(), layout) ?? charKey(key.toUpperCase(), layout);
    if (!typed) throw new Error(`Can't press "${key}": ${layout ? "the keyboard layout has no key for it" : "not on a US keyboard"}.`);
    code = typed.code;
    if (typed.modifiers & SHIFT && key.toLowerCase() === key.toUpperCase()) modifiers.push(MODIFIERS.shift!);
    if (typed.modifiers & ALTGR) modifiers.push(ALTGR_MODIFIER);
  }
  // A KeyboardEvent.code as it is.
  if (!code && /^[A-Z][A-Za-z0-9]+$/.test(key)) code = key;
  if (!code) {
    throw new Error(
      `Unknown key "${key}": use a character ("]", "a"), a name (Enter, Tab, Home, Up, F5, ...) ` +
        'or a KeyboardEvent.code ("BracketRight", "KeyA").',
    );
  }
  return stroke(code, modifiers);
}

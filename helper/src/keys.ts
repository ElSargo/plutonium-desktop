// Keys for native windows (Plutonium.dispatchWindowKeyEvents): text and key
// combinations as physical keys (KeyboardEvent.code) with modifiers. Apps get
// keycodes and map them through the session's keyboard layout, so text comes
// out right for a US layout; other characters are refused.
import type { WindowKeyEvent } from "./desktop.ts";

const ALT = 1;
const CTRL = 2;
const META = 4;
const SHIFT = 8;

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

function charKey(char: string): readonly [string, boolean] | undefined {
  if (/^[a-z]$/.test(char)) return [`Key${char.toUpperCase()}`, false];
  if (/^[A-Z]$/.test(char)) return [`Key${char}`, true];
  if (/^[0-9]$/.test(char)) return [`Digit${char}`, false];
  return US[char];
}

/** Presses and releases `code` with `modifiers` held (pressing them first). */
function stroke(code: string, modifiers: readonly { code: string; bit: number }[]): WindowKeyEvent[] {
  const events: WindowKeyEvent[] = [];
  let held = 0;
  for (const modifier of modifiers) {
    held |= modifier.bit;
    events.push({ type: "keyDown", code: modifier.code, modifiers: held });
  }
  events.push({ type: "keyDown", code, modifiers: held }, { type: "keyUp", code, modifiers: held });
  for (const modifier of [...modifiers].reverse()) {
    held &= ~modifier.bit;
    events.push({ type: "keyUp", code: modifier.code, modifiers: held });
  }
  return events;
}

/** `text` typed key by key. Throws for characters a US keyboard can't type. */
export function textKeys(text: string): WindowKeyEvent[] {
  const missing = new Set<string>();
  const events: WindowKeyEvent[] = [];
  for (const char of text.replace(/\r\n?/g, "\n")) {
    const key = charKey(char);
    if (!key) {
      missing.add(char);
      continue;
    }
    events.push(...stroke(key[0], key[1] ? [MODIFIERS.shift!] : []));
  }
  if (missing.size > 0) {
    throw new Error(
      `Can't type ${[...missing].map((char) => JSON.stringify(char)).join(", ")}: ` +
        "native windows get keys as a US keyboard would type them.",
    );
  }
  return events;
}

/**
 * A key combination: "Enter", "ctrl+s", "Ctrl+Shift+T", "alt+F4", "a", or a
 * KeyboardEvent.code ("KeyA", "F5", "ArrowDown").
 */
export function comboKeys(combo: string): WindowKeyEvent[] {
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
  if (!code && key.length === 1) {
    const typed = charKey(key);
    if (!typed) throw new Error(`Can't press "${key}": not on a US keyboard.`);
    code = typed[0];
    if (typed[1] && /[^A-Z]/.test(key)) modifiers.push(MODIFIERS.shift!);
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

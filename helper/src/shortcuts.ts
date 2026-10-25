// Global shortcuts (docs/features/CAPTURE.md, "Global shortcuts"): keys an
// app binds through the desktop portal (Discord's push-to-talk, OBS's
// hotkeys), caught by the shells whatever has the keyboard.
//
// Two spellings of a key combination:
// - the portal's trigger, from the XDG shortcuts spec: modifiers CTRL, ALT,
//   SHIFT, LOGO joined by "+", then an XKB keysym name ("CTRL+ALT+p",
//   "LOGO+F12");
// - the shells' combo (setShellShortcuts): "[Ctrl+][Alt+][Shift+][Super+]"
//   then a KeyboardEvent.code ("Ctrl+Alt+KeyP").
// Bindings are kept per app, so an app that binds the same shortcuts again
// (OBS at every start) isn't asked again.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MODIFIERS: [trigger: string, combo: string][] = [
  ["CTRL", "Ctrl"],
  ["ALT", "Alt"],
  ["SHIFT", "Shift"],
  ["LOGO", "Super"],
];

const KEYSYMS: Record<string, string> = {
  space: "Space",
  Return: "Enter",
  KP_Enter: "NumpadEnter",
  Escape: "Escape",
  Tab: "Tab",
  BackSpace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  Prior: "PageUp",
  Page_Up: "PageUp",
  Next: "PageDown",
  Page_Down: "PageDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Print: "PrintScreen",
  Pause: "Pause",
  Scroll_Lock: "ScrollLock",
  Caps_Lock: "CapsLock",
  Menu: "ContextMenu",
  minus: "Minus",
  equal: "Equal",
  comma: "Comma",
  period: "Period",
  slash: "Slash",
  backslash: "Backslash",
  semicolon: "Semicolon",
  apostrophe: "Quote",
  grave: "Backquote",
  bracketleft: "BracketLeft",
  bracketright: "BracketRight",
};
const CODES = Object.fromEntries(Object.entries(KEYSYMS).map(([keysym, code]) => [code, keysym]));

/** A KeyboardEvent.code for an XKB keysym name, if there is one. */
function codeOfKeysym(keysym: string): string | undefined {
  if (/^[a-zA-Z]$/.test(keysym)) return `Key${keysym.toUpperCase()}`;
  if (/^[0-9]$/.test(keysym)) return `Digit${keysym}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(keysym)) return keysym;
  if (/^KP_[0-9]$/.test(keysym)) return `Numpad${keysym.slice(3)}`;
  return KEYSYMS[keysym];
}

function keysymOfCode(code: string): string | undefined {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!.toLowerCase();
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  const numpad = /^Numpad([0-9])$/.exec(code);
  if (numpad) return `KP_${numpad[1]}`;
  return CODES[code];
}

/** The shells' combo for a portal trigger, or undefined if it isn't one we can catch. */
export function comboOfTrigger(trigger: string): string | undefined {
  const parts = trigger.split("+").map((part) => part.trim()).filter(Boolean);
  const keysym = parts.pop();
  if (!keysym) return undefined;
  const upper = new Set(parts.map((part) => part.toUpperCase()));
  for (const modifier of upper) {
    if (!MODIFIERS.some(([name]) => name === modifier)) return undefined;
  }
  const code = codeOfKeysym(keysym);
  if (!code) return undefined;
  return MODIFIERS.filter(([name]) => upper.has(name))
    .map(([, combo]) => `${combo}+`)
    .join("") + code;
}

/** The portal's trigger for a shells' combo, or undefined. */
export function triggerOfCombo(combo: string): string | undefined {
  const parts = combo.split("+");
  const code = parts.pop();
  const keysym = code ? keysymOfCode(code) : undefined;
  if (!keysym) return undefined;
  return MODIFIERS.filter(([, name]) => parts.includes(name))
    .map(([trigger]) => `${trigger}+`)
    .join("") + keysym;
}

/** How a combo reads: "Ctrl+Alt+P". */
export function describeCombo(combo: string): string {
  const parts = combo.split("+");
  const code = parts.pop() ?? "";
  const key = /^Key([A-Z])$/.exec(code)?.[1] ?? /^Digit([0-9])$/.exec(code)?.[1] ?? code;
  return [...parts, key].join("+");
}

/** The file bindings are kept in: $XDG_STATE_HOME/plutonium/global-shortcuts.json. */
export function bindingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "plutonium", "global-shortcuts.json");
}

/** Shortcut id → combo, by app. */
export type Bindings = Record<string, Record<string, string>>;

export function loadBindings(path = bindingsPath()): Bindings {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Bindings;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

export function saveBindings(bindings: Bindings, path = bindingsPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(bindings, null, 2));
  renameSync(`${path}.tmp`, path);
}

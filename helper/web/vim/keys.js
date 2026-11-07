// Pluto Vim's keys (PLUTO_VIM.md), in neovim's notation: a printable key is
// itself ("d", "D", " ", "<"); anything else is a name in angle brackets with
// its modifiers in C-A-S- order ("<Esc>", "<CR>", "<C-r>", "<C-S-Left>").
// After C- or A-, letters are lower case, with S- for Shift: "<C-S-r>".
// Super is the desktop's (KEYS.md), so a key with Super is never vim's.

const NAMES = {
  Escape: "Esc", Enter: "CR", Backspace: "BS", Tab: "Tab", Delete: "Del",
  ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Insert: "Insert",
};

/** Names neovim also accepts, and what they mean here. */
const ALIASES = {
  esc: "Esc", cr: "CR", enter: "CR", return: "CR", bs: "BS", tab: "Tab", del: "Del",
  left: "Left", right: "Right", up: "Up", down: "Down", home: "Home", end: "End",
  pageup: "PageUp", pagedown: "PageDown", insert: "Insert",
};

/** The key of a DOM KeyboardEvent (or anything with its fields), or null for keys vim never sees. */
export function keyFromEvent(event) {
  if (event.metaKey || event.isComposing || event.key === "Process" || event.key === "Dead") return null;
  const name = NAMES[event.key];
  if (name) return withModifiers(name, event.ctrlKey, event.altKey, event.shiftKey && name !== "CR");
  if ([...event.key].length !== 1) return null;
  if (!event.ctrlKey && !event.altKey) return event.key;
  const lower = event.key.toLowerCase();
  const shift = event.shiftKey && lower !== event.key;
  return withModifiers(lower, event.ctrlKey, event.altKey, shift);
}

function withModifiers(name, ctrl, alt, shift) {
  const mods = `${ctrl ? "C-" : ""}${alt ? "A-" : ""}${shift ? "S-" : ""}`;
  if (!mods && name.length === 1) return name;
  return `<${mods}${name}>`;
}

/** One key in notation, normalized: "<c-R>" → "<C-r>", "<Space>" → " ", "<lt>" → "<". */
export function normalizeKey(key) {
  const m = /^<((?:[CcAaSsMm]-)*)(.+)>$/.exec(key);
  if (!m || key.length < 3) return key;
  let ctrl = false, alt = false, shift = false;
  for (const mod of m[1].toUpperCase().split("-").filter(Boolean)) {
    if (mod === "C") ctrl = true;
    else if (mod === "A" || mod === "M") alt = true;
    else if (mod === "S") shift = true;
  }
  let name = m[2];
  const lower = name.toLowerCase();
  if (lower === "space") name = " ";
  else if (lower === "lt") name = "<";
  else if (lower === "bar") name = "|";
  else if (lower === "bslash") name = "\\";
  else if (ALIASES[lower]) name = ALIASES[lower];
  if (name.length === 1 && (ctrl || alt)) {
    // <C-R> is <C-r>, as in vim; <A-R> is Alt+Shift+r.
    if (!ctrl && name !== name.toLowerCase()) shift = true;
    name = name.toLowerCase();
  } else if (name.length === 1 && shift && !ctrl && !alt) {
    return name.toUpperCase();
  }
  return withModifiers(name, ctrl, alt, shift);
}

/** A string of keys in notation, split into keys: "d2w<Esc>" → ["d", "2", "w", "<Esc>"]. A "<" that starts no name is itself. */
export function parseKeys(notation) {
  const keys = [];
  for (let i = 0; i < notation.length; ) {
    if (notation[i] === "<") {
      const m = /^<(?:[CcAaSsMm]-)*(?:[^<>\s-]+|-|<|>)>/.exec(notation.slice(i));
      if (m && (m[0].length > 3 || /^<[^<>]>$/.test(m[0]) === false)) {
        keys.push(normalizeKey(m[0]));
        i += m[0].length;
        continue;
      }
    }
    const ch = String.fromCodePoint(notation.codePointAt(i));
    keys.push(ch);
    i += ch.length;
  }
  return keys;
}

/** Whether `key` types a character (no Ctrl or Alt, not a named key). */
export function isPrintable(key) {
  return [...key].length === 1;
}

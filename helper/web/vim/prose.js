// Prose and Markdown for Pluto Vim (HYDRA_KEYBOARD.md, "The base map"):
// sentences, headings, list items, fenced code blocks and URLs, as motions
// and text objects over the field's text. Pure functions over offsets, as
// text.js's are. Lines inside a fenced code block are code, not Markdown:
// a "# comment" there isn't a heading.

import * as T from "./text.js";

/** Each line's start and end, and whether it's in a fenced block (fence lines included). */
export function lines(text) {
  const out = [];
  let fence = null;
  for (let start = 0; ; ) {
    const nl = text.indexOf("\n", start);
    const end = nl === -1 ? text.length : nl;
    const body = text.slice(start, end);
    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(body);
    let kind = fence ? "code" : "text";
    if (open && !fence) {
      fence = open[1];
      kind = "open";
    } else if (fence && open && open[1][0] === fence[0] && open[1].length >= fence.length && body.trim() === open[1]) {
      fence = null;
      kind = "close";
    }
    out.push({ start, end, body, kind });
    if (nl === -1) break;
    start = nl + 1;
  }
  return out;
}

function lineIndex(all, pos) {
  for (let k = all.length - 1; k >= 0; k--) if (all[k].start <= pos) return k;
  return 0;
}

// ── Sentences ────────────────────────────────────────────────────────────

/**
 * Where sentences start, as vim counts them: after a `.`, `!` or `?` (and
 * any closing `)`, `]`, `"`, `'`) and white space, at the first line after
 * an empty one, and at each empty line, which is a sentence of its own.
 */
export function sentenceStarts(text) {
  const starts = new Set();
  const first = T.firstNonBlank(text, 0);
  starts.add(first < text.length ? first : 0);
  const end = /[.!?][)\]"'’”]*[ \t\n]+/g;
  for (let m; (m = end.exec(text)); ) {
    const at = m.index + m[0].length;
    if (at < text.length) starts.add(at);
  }
  for (let start = 0; start < text.length; ) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) break;
    if (nl === start) {
      starts.add(start);
      const next = nl + 1;
      if (next < text.length && text[next] !== "\n") starts.add(T.firstNonBlank(text, next));
    }
    start = nl + 1;
  }
  return [...starts].sort((a, b) => a - b);
}

export function sentenceForward(text, pos) {
  for (const at of sentenceStarts(text)) if (at > pos) return at;
  return text.length > 0 ? T.lastChar(text, text.length) : pos;
}

export function sentenceBack(text, pos) {
  let found = 0;
  for (const at of sentenceStarts(text)) {
    if (at >= pos) break;
    found = at;
  }
  return found;
}

// ── Headings, list items, code blocks ────────────────────────────────────

const HEADING = /^ {0,3}(#{1,6})(\s|$)/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)/;

export function headingLevel(body) {
  const m = HEADING.exec(body);
  return m ? m[1].length : 0;
}

/** The next (dir 1) or previous (-1) line `test` accepts, from pos's line: its start, or null. */
export function nextLine(text, pos, dir, test) {
  const all = lines(text);
  for (let k = lineIndex(all, pos) + dir; k >= 0 && k < all.length; k += dir) {
    if (test(all[k])) return T.firstNonBlank(text, all[k].start);
  }
  return null;
}

export const isHeading = (line) => line.kind === "text" && headingLevel(line.body) > 0;
export const isItem = (line) => line.kind === "text" && ITEM.test(line.body);
export const isFence = (line) => line.kind === "open";

// ── Text objects: { from, to, linewise }, to exclusive ───────────────────

/** ic / ac: the fenced code block around pos: its lines, or with its fences. */
export function codeBlock(text, pos, around) {
  const all = lines(text);
  const here = lineIndex(all, pos);
  let open = -1;
  for (let k = here; k >= 0; k--) {
    if (all[k].kind === "open") { open = k; break; }
    if (all[k].kind === "close" && k !== here) return null;
    if (all[k].kind === "text") return null;
  }
  if (open === -1) return null;
  let close = all.length - 1;
  for (let k = open + 1; k < all.length; k++) if (all[k].kind === "close") { close = k; break; }
  if (around) return { from: all[open].start, to: all[close].end, linewise: true };
  if (close - open < 2) return null;
  return { from: all[open + 1].start, to: all[close - 1].end, linewise: true };
}

/** il / al: the list item around pos, with the lines it continues on; il is its text after the marker. */
export function listItem(text, pos, around) {
  const all = lines(text);
  const here = lineIndex(all, pos);
  let first = -1;
  let indent = 0;
  for (let k = here; k >= 0; k--) {
    const line = all[k];
    if (line.kind !== "text") return null;
    if (line.body.trim() === "") return null;
    const m = ITEM.exec(line.body);
    if (m) {
      first = k;
      indent = m[1].length;
      break;
    }
    if (headingLevel(line.body)) return null;
  }
  if (first === -1) return null;
  let last = first;
  for (let k = first + 1; k < all.length; k++) {
    const line = all[k];
    if (line.kind !== "text" || line.body.trim() === "" || headingLevel(line.body)) break;
    const m = ITEM.exec(line.body);
    if (m && m[1].length <= indent) break;
    last = k;
  }
  if (around) return { from: all[first].start, to: all[last].end, linewise: true };
  const marker = ITEM.exec(all[first].body);
  return { from: all[first].start + marker[0].length, to: all[last].end, linewise: false };
}

/** ih / ah: the section under the heading at or above pos, to the next heading of its level or higher; ih leaves out the heading. */
export function section(text, pos, around) {
  const all = lines(text);
  const here = lineIndex(all, pos);
  let head = -1;
  for (let k = here; k >= 0; k--) if (isHeading(all[k])) { head = k; break; }
  const level = head === -1 ? 0 : headingLevel(all[head].body);
  let last = all.length - 1;
  for (let k = Math.max(head, 0) + (head === -1 ? 0 : 1); k < all.length; k++) {
    if (k === head) continue;
    const l = isHeading(all[k]) ? headingLevel(all[k].body) : 0;
    if (l && (level === 0 || l <= level)) { last = k - 1; break; }
  }
  // Blank lines before the next heading belong between sections, not to this one (ih).
  let end = last;
  if (!around) while (end > head && all[end].body.trim() === "") end--;
  const from = head === -1 ? 0 : around ? head : head + 1;
  if (from > end) return null;
  return { from: all[from].start, to: all[end].end, linewise: true };
}

const URL = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/g;

/** The URL around pos (or the first after it on its line), without the punctuation that ends a sentence. */
export function urlAt(text, pos) {
  const start = T.lineStart(text, pos);
  const end = T.lineEnd(text, pos);
  const line = text.slice(start, end);
  let best = null;
  for (const m of line.matchAll(URL)) {
    let url = m[0].replace(/[.,;:!?]+$/, "");
    // A closing bracket the URL didn't open is the text's: (see https://x.y/z).
    for (const [open, close] of [["(", ")"], ["[", "]"]]) {
      while (url.endsWith(close) && url.split(open).length < url.split(close).length) url = url.slice(0, -1);
    }
    const from = start + m.index;
    const to = from + url.length;
    if (pos >= from && pos < to) return { from, to };
    if (!best && from > pos) best = { from, to };
  }
  return best;
}

/** iu / au: a URL; au takes the blanks after it (or before, at the end of a line). */
export function urlObject(text, pos, around) {
  const found = urlAt(text, pos);
  if (!found) return null;
  let { from, to } = found;
  if (around) {
    const end = T.lineEnd(text, from);
    const start = T.lineStart(text, from);
    if (to < end && T.isBlank(text[to])) while (to < end && T.isBlank(text[to])) to++;
    else while (from > start && T.isBlank(text[from - 1])) from--;
  }
  return { from, to, linewise: false };
}

// ── Surround ─────────────────────────────────────────────────────────────

const PAIRS = {
  "(": ["(", ")"], ")": ["(", ")"], b: ["(", ")"],
  "[": ["[", "]"], "]": ["[", "]"],
  "{": ["{", "}"], "}": ["{", "}"], B: ["{", "}"],
  "<": ["<", ">"], ">": ["<", ">"],
};

/** What `ch` surrounds with: a bracket pair, or the character on both sides (quotes, *, _, ~). */
export function surroundPair(ch) {
  return PAIRS[ch] ?? [ch, ch];
}

/** The pair `ch` names around pos: [open, close] offsets, or null. */
export function findSurround(text, pos, ch, count = 1) {
  const [open, close] = surroundPair(ch);
  if (open !== close) return T.enclosingPair(text, pos, open, close, count);
  return T.quotePair(text, pos, open);
}

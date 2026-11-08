// Pluto Vim's text helpers (PLUTO_VIM.md): lines, character classes, words,
// paragraphs, brackets and quotes, over a plain string. Offsets are UTF-16
// indices, as in the DOM; next() and prev() step over surrogate pairs, so
// the cursor never lands inside one. Nothing here touches a field: the
// engine reads the field's text, works out offsets with these, and hands
// the offsets to the field's Buffer.

/** A character of a keyword, as vim's default 'iskeyword' (letters, digits, `_`), but for every script. */
const KEYWORD = /^[\p{L}\p{N}\p{M}_]$/u;
const BLANK = /^\s$/u;

/** The offset after the character at `i`. */
export function next(text, i) {
  const code = text.charCodeAt(i);
  return i + (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length ? 2 : 1);
}

/** The offset of the character before `i`. */
export function prev(text, i) {
  if (i <= 0) return 0;
  const code = text.charCodeAt(i - 1);
  return code >= 0xdc00 && code <= 0xdfff && i >= 2 ? i - 2 : i - 1;
}

/** The character at `i` (a whole code point), or "". */
export function charAt(text, i) {
  if (i < 0 || i >= text.length) return "";
  return String.fromCodePoint(text.codePointAt(i));
}

/** 0 for blanks (newlines included), 1 for punctuation, 2 for keyword characters; with `big`, 2 for anything not blank. */
export function cls(text, i, big = false) {
  const ch = charAt(text, i);
  if (!ch || BLANK.test(ch)) return 0;
  if (big) return 2;
  return KEYWORD.test(ch) ? 2 : 1;
}

export const isBlank = (ch) => ch !== "" && ch !== "\n" && BLANK.test(ch);

// ── Lines ────────────────────────────────────────────────────────────────
// A line runs from its start to the "\n" that ends it (or the end of the
// text). The cursor on an empty line is at its start, which is the offset of
// its "\n" (or the end of the text, for an empty last line).

export function lineStart(text, i) {
  if (i <= 0) return 0; // lastIndexOf("\n", -1) would still look at index 0.
  return text.lastIndexOf("\n", i - 1) + 1;
}

export function lineEnd(text, i) {
  const end = text.indexOf("\n", i);
  return end === -1 ? text.length : end;
}

/** The start of the next line, or null on the last line. */
export function nextLineStart(text, i) {
  const end = lineEnd(text, i);
  return end < text.length ? end + 1 : null;
}

/** The start of the previous line, or null on the first. */
export function prevLineStart(text, i) {
  const start = lineStart(text, i);
  return start > 0 ? lineStart(text, start - 1) : null;
}

/** Whether the line starting at `start` is empty. */
export function lineEmpty(text, start) {
  return start >= text.length || text[start] === "\n";
}

/** The first non-blank character of the line containing `i` (its end, if the line is blank). */
export function firstNonBlank(text, i) {
  let at = lineStart(text, i);
  const end = lineEnd(text, at);
  while (at < end && isBlank(text[at])) at++;
  return at;
}

/** The last character of the line containing `i`: where normal mode's cursor may go furthest. */
export function lastChar(text, i) {
  const start = lineStart(text, i);
  const end = lineEnd(text, i);
  return end > start ? prev(text, end) : start;
}

/** `i` kept on a character of its line, as normal mode's cursor must be. */
export function clampNormal(text, i) {
  i = Math.max(0, Math.min(i, text.length));
  const last = lastChar(text, i);
  return i > last ? last : i;
}

/** The 0-based line number of `i`. */
export function lineNumber(text, i) {
  let n = 0;
  for (let at = text.indexOf("\n"); at !== -1 && at < i; at = text.indexOf("\n", at + 1)) n++;
  return n;
}

/** The start of line `n` (0-based), or of the last line if there are fewer. */
export function lineStartOf(text, n) {
  let start = 0;
  for (let k = 0; k < n; k++) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) break;
    start = nl + 1;
  }
  return start;
}

// ── Words ────────────────────────────────────────────────────────────────

/** Whether `i` is an empty line, which w, b and ge stop at as if it were a word. */
function emptyLineAt(text, i) {
  return (i === 0 || text[i - 1] === "\n") && (i >= text.length || text[i] === "\n");
}

/** `w`: the start of the next word (the text's end if there is none). */
export function wordForward(text, pos, big) {
  const n = text.length;
  let i = pos;
  if (i >= n) return n;
  const start = cls(text, i, big);
  if (start !== 0) while (i < n && cls(text, i, big) === start) i++;
  while (i < n && cls(text, i, big) === 0) {
    if (i !== pos && emptyLineAt(text, i)) return i;
    i++;
  }
  return i;
}

/**
 * `e`: the end of the next word. With `stay`, a cursor already on the end of
 * a word stays there (what `cw` needs: it changes to the end of this word).
 */
export function wordEnd(text, pos, big, stay = false) {
  const n = text.length;
  let i = stay ? pos : pos + 1;
  while (i < n && cls(text, i, big) === 0) i++;
  if (i >= n) return Math.max(0, prev(text, n));
  const c = cls(text, i, big);
  while (i + 1 < n && cls(text, i + 1, big) === c) i++;
  return i;
}

/** `b`: the start of the word before `pos` (or of the word `pos` is in). */
export function wordBack(text, pos, big) {
  let i = pos - 1;
  if (i <= 0) return 0;
  while (i > 0 && cls(text, i, big) === 0) {
    if (emptyLineAt(text, i)) return i;
    i--;
  }
  const c = cls(text, i, big);
  while (i > 0 && cls(text, i - 1, big) === c) i--;
  return i;
}

/** `ge`: the end of the word before the one `pos` is in. */
export function wordEndBack(text, pos, big) {
  let i = pos;
  const start = cls(text, i, big);
  if (start !== 0) while (i >= 0 && cls(text, i, big) === start) i--;
  while (i >= 0 && cls(text, i, big) === 0) {
    if (emptyLineAt(text, i) && i !== pos) return i;
    i--;
  }
  return Math.max(i, 0);
}

// ── Paragraphs ───────────────────────────────────────────────────────────
// A paragraph boundary is an empty line (not a blank one), as in vim.

/** `}`: the next empty line after this paragraph, or the text's end. */
export function paragraphForward(text, pos) {
  const n = text.length;
  let at = lineStart(text, pos);
  const step = (start) => nextLineStart(text, start) ?? n;
  while (at < n && lineEmpty(text, at)) at = step(at);
  while (at < n && !lineEmpty(text, at)) at = step(at);
  return at;
}

/** `{`: the empty line before this paragraph, or the text's start. */
export function paragraphBack(text, pos) {
  let at = lineStart(text, pos);
  while (at > 0 && lineEmpty(text, at)) at = prevLineStart(text, at);
  while (at > 0 && !lineEmpty(text, at)) at = prevLineStart(text, at);
  return at;
}

// ── Brackets ─────────────────────────────────────────────────────────────

const PAIRS = { "(": ")", "[": "]", "{": "}", "<": ">" };
const CLOSERS = { ")": "(", "]": "[", "}": "{", ">": "<" };

/** The bracket matching the one at `i`, or -1. `<>` count only when `angles` is set. */
export function matchBracket(text, i, angles = false) {
  const ch = text[i];
  const open = PAIRS[ch] && (angles || ch !== "<") ? ch : null;
  const close = CLOSERS[ch] && (angles || ch !== ">") ? ch : null;
  if (!open && !close) return -1;
  const [self, other, dir] = open ? [open, PAIRS[open], 1] : [close, CLOSERS[close], -1];
  let depth = 0;
  for (let at = i; at >= 0 && at < text.length; at += dir) {
    if (text[at] === self) depth++;
    else if (text[at] === other && --depth === 0) return at;
  }
  return -1;
}

/** `%`: the bracket matching the first one at or after `pos` on its line, or -1. */
export function percent(text, pos) {
  const end = lineEnd(text, pos);
  for (let at = pos; at < end; at++) {
    if ("()[]{}".includes(text[at])) return matchBracket(text, at);
  }
  return -1;
}

/**
 * The `count`th pair of `open`/`close` around `pos` (a bracket under the
 * cursor counts as inside), as offsets of the two brackets, or null.
 */
export function enclosingPair(text, pos, open, close, count = 1) {
  let from = pos;
  let result = null;
  for (let k = 0; k < count; k++) {
    let start = -1;
    if (k === 0 && text[from] === open) start = from;
    else if (k === 0 && text[from] === close) start = matchBack(text, from, open, close);
    else {
      let depth = 0;
      for (let at = from - 1; at >= 0; at--) {
        if (text[at] === close) depth++;
        else if (text[at] === open) {
          if (depth === 0) { start = at; break; }
          depth--;
        }
      }
    }
    if (start < 0) return null;
    const end = matchForward(text, start, open, close);
    if (end < 0) return null;
    result = [start, end];
    from = start;
  }
  return result;
}

function matchForward(text, start, open, close) {
  let depth = 0;
  for (let at = start; at < text.length; at++) {
    if (text[at] === open) depth++;
    else if (text[at] === close && --depth === 0) return at;
  }
  return -1;
}

function matchBack(text, end, open, close) {
  let depth = 0;
  for (let at = end; at >= 0; at--) {
    if (text[at] === close) depth++;
    else if (text[at] === open && --depth === 0) return at;
  }
  return -1;
}

// ── Quotes ───────────────────────────────────────────────────────────────

/** The pair of `quote`s on `pos`'s line that `i"` and `a"` act on, or null. Backslash escapes a quote. */
export function quotePair(text, pos, quote) {
  const start = lineStart(text, pos);
  const end = lineEnd(text, pos);
  const quotes = [];
  for (let at = start; at < end; at++) {
    if (text[at] === "\\") { at++; continue; }
    if (text[at] === quote) quotes.push(at);
  }
  const on = quotes.indexOf(pos);
  if (on !== -1) {
    if (on % 2 === 0) return on + 1 < quotes.length ? [quotes[on], quotes[on + 1]] : null;
    return [quotes[on - 1], quotes[on]];
  }
  const before = quotes.filter((at) => at < pos).length;
  if (before % 2 === 1) return before < quotes.length ? [quotes[before - 1], quotes[before]] : null;
  return before + 1 < quotes.length ? [quotes[before], quotes[before + 1]] : null;
}

// ── Tags ─────────────────────────────────────────────────────────────────

/** The innermost `<tag>…</tag>` around `pos`: [open start, open end, close start, close end], or null. */
export function enclosingTag(text, pos, count = 1) {
  const pattern = /<(\/?)([A-Za-z][\w:.-]*)[^<>]*?(\/?)>/g;
  const stack = [];
  const pairs = [];
  for (let m; (m = pattern.exec(text)); ) {
    if (m[3]) continue;
    const name = m[2].toLowerCase();
    if (!m[1]) stack.push({ name, start: m.index, end: m.index + m[0].length });
    else {
      const k = stack.map((t) => t.name).lastIndexOf(name);
      if (k === -1) continue;
      const open = stack[k];
      stack.length = k;
      pairs.push([open.start, open.end, m.index, m.index + m[0].length]);
    }
  }
  const around = pairs
    .filter(([s, , , e]) => s <= pos && pos < e)
    .sort((a, b) => (a[3] - a[0]) - (b[3] - b[0]));
  return around[count - 1] ?? null;
}

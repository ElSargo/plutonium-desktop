// Pluto Vim's commands (PLUTO_VIM.md, The engine): the motions, text objects,
// operators and actions of the first version, as tables the parser
// (engine.js) reads. A motion or a text object is a function over the text:
// it works out offsets and touches nothing; the engine applies the result to
// the field. init.js's vim.motion, vim.textobject and vim.operator (step 4)
// add entries to these tables.

import * as T from "./text.js";
import { parseKeys } from "./keys.js";
import * as P from "./prose.js";

// ── Motions ──────────────────────────────────────────────────────────────
// fn(ctx) returns the target offset, or null when the motion fails (an
// operator then does nothing). ctx: { text, pos, count, hasCount, arg, op,
// vim, session }. kind is how an operator takes the range: "exclusive",
// "inclusive" or "linewise" (or a function of ctx).

function left(ctx, wrap) {
  const { text } = ctx;
  let at = ctx.pos;
  for (let k = 0; k < ctx.count; k++) {
    if (at <= 0) break;
    if (at === T.lineStart(text, at)) {
      if (!wrap) break;
      at = T.lastChar(text, at - 1);
      continue;
    }
    at = T.prev(text, at);
  }
  return at === ctx.pos ? null : at;
}

function right(ctx, wrap) {
  const { text } = ctx;
  let at = ctx.pos;
  for (let k = 0; k < ctx.count; k++) {
    const end = T.lineEnd(text, at);
    const last = ctx.op ? end : T.lastChar(text, at);
    if (at >= last) {
      if (!wrap || end >= text.length) break;
      at = end + 1;
      continue;
    }
    at = T.next(text, at);
  }
  return at === ctx.pos ? null : at;
}

/** The line `count` lines down (or up), at the column the cursor wants, or null at the edge. */
function vertical(ctx, dir) {
  const { text } = ctx;
  let start = T.lineStart(text, ctx.pos);
  let moved = 0;
  for (; moved < ctx.count; moved++) {
    const to = dir > 0 ? T.nextLineStart(text, start) : T.prevLineStart(text, start);
    if (to == null) break;
    start = to;
  }
  if (moved === 0) return null;
  return atColumn(text, start, ctx.session.want);
}

/**
 * j and k by the lines the field shows (vim.opt.displayLines; gj and gk the
 * other way round): the buffer's displayLine, where it has one, else real
 * lines. An operator always takes real lines (dj deletes two lines).
 *
 * The column a run of them keeps is where the run started, as the browser's
 * own arrow keys keep it: each move is counted from the run's first offset
 * (session.displayRun), so k after j comes back exactly, and a short line
 * on the way doesn't pull the cursor left for good.
 */
function displayOr(dir, display) {
  return (ctx) => {
    const { session } = ctx;
    const buffer = session?.buffer;
    const wanted = display === Boolean(ctx.vim?.opt?.displayLines);
    if (ctx.op || !wanted || typeof buffer?.displayLine !== "function") return vertical(ctx, dir);
    const run = session.displayRun?.at === ctx.pos && session.displayRun.text === ctx.text
      ? session.displayRun : { origin: ctx.pos, lines: 0 };
    const lines = run.lines + dir * ctx.count;
    let target;
    if (lines === 0) target = run.origin;
    else {
      const found = buffer.displayLine(run.origin, Math.sign(lines), Math.abs(lines));
      if (found === undefined) return vertical(ctx, dir);
      if (found === null) return null;
      // At a soft wrap the line's end and the next line's start are one offset: the end is its last character.
      target = T.clampNormal(ctx.text, found.end ? T.prev(ctx.text, found.offset) : found.offset);
    }
    // Past the first or last line the run can't go further: the motion fails, and the run stays.
    if (target === ctx.pos) return null;
    session.displayRun = { origin: run.origin, lines, at: target, text: ctx.text };
    return target;
  };
}

function atColumn(text, start, want) {
  const last = T.lastChar(text, start);
  return Math.min(start + (want === Infinity ? Infinity : want), last);
}

function lineDown(ctx, n) {
  let start = T.lineStart(ctx.text, ctx.pos);
  for (let k = 0; k < n; k++) {
    const to = T.nextLineStart(ctx.text, start);
    if (to == null) return null;
    start = to;
  }
  return start;
}

function findChar(text, pos, key, ch, count, repeat) {
  const start = T.lineStart(text, pos);
  const end = T.lineEnd(text, pos);
  let at = pos;
  if (key === "f" || key === "t") {
    let from = T.next(text, at);
    if (key === "t" && repeat) from = T.next(text, from);
    for (let k = 0; k < count; k++) {
      const found = text.indexOf(ch, from);
      if (found === -1 || found >= end) return null;
      at = found;
      from = T.next(text, found);
    }
    return key === "t" ? T.prev(text, at) : at;
  }
  let from = at - 1;
  if (key === "T" && repeat) from = T.prev(text, from);
  for (let k = 0; k < count; k++) {
    const found = from < start ? -1 : text.lastIndexOf(ch, from);
    if (found === -1 || found < start) return null;
    at = found;
    from = found - 1;
  }
  return key === "T" ? T.next(text, at) : at;
}

function find(key) {
  return (ctx) => {
    if (ctx.arg == null) return null;
    ctx.vim.lastFind = { key, char: ctx.arg };
    return findChar(ctx.text, ctx.pos, key, ctx.arg, ctx.count, false);
  };
}

const REVERSE = { f: "F", F: "f", t: "T", T: "t" };

function repeatFind(reverse) {
  return (ctx) => {
    const last = ctx.vim.lastFind;
    if (!last) return null;
    const key = reverse ? REVERSE[last.key] : last.key;
    return findChar(ctx.text, ctx.pos, key, last.char, ctx.count, true);
  };
}

function findKind(reverse) {
  return (ctx) => {
    const last = ctx.vim.lastFind;
    const key = last ? (reverse ? REVERSE[last.key] : last.key) : "f";
    return key === "f" || key === "t" ? "inclusive" : "exclusive";
  };
}

function repeatMotion(step) {
  return (ctx) => {
    let at = ctx.pos;
    for (let k = 0; k < ctx.count; k++) at = step(ctx.text, at);
    return at;
  };
}

function wordForward(big) {
  return (ctx) => {
    const { text } = ctx;
    // cw on a word is ce: it changes to the end of this word, not the blanks after.
    if (ctx.op === "c" && T.cls(text, ctx.pos, big) !== 0) {
      let at = ctx.pos;
      for (let k = 0; k < ctx.count; k++) at = T.wordEnd(text, at, big, k === 0);
      return at;
    }
    let at = ctx.pos;
    let last = at;
    for (let k = 0; k < ctx.count; k++) {
      last = at;
      at = T.wordForward(text, at, big);
    }
    if (ctx.op) {
      // An operator's `w` stops at the end of the line of the last word it moved over.
      const nl = text.indexOf("\n", last);
      if (nl !== -1 && nl < at) at = nl;
    }
    return at === ctx.pos && !ctx.op ? null : at;
  };
}

function wordKind(ctx) {
  return ctx.op === "c" && T.cls(ctx.text, ctx.pos, false) !== 0 ? "inclusive" : "exclusive";
}

function bigWordKind(ctx) {
  return ctx.op === "c" && T.cls(ctx.text, ctx.pos, true) !== 0 ? "inclusive" : "exclusive";
}

/** ]h, [l, …: the count'th line `test` accepts, down (dir 1) or up. */
function structure(dir, test) {
  return (ctx) => {
    let at = ctx.pos;
    for (let k = 0; k < ctx.count; k++) {
      const found = P.nextLine(ctx.text, at, dir, test);
      if (found == null) return k === 0 ? null : at;
      at = found;
    }
    return at;
  };
}

const line = (n) => (ctx) => T.firstNonBlank(ctx.text, T.lineStartOf(ctx.text, n(ctx)));

/** @type {Array<{ keys: string, fn: Function, kind: string | Function, arg?: boolean, keepWant?: boolean, wantEnd?: boolean }>} */
export const MOTIONS = [
  { keys: "h", fn: (c) => left(c, false), kind: "exclusive" },
  { keys: "<Left>", fn: (c) => left(c, false), kind: "exclusive" },
  { keys: "<C-h>", fn: (c) => left(c, true), kind: "exclusive" },
  { keys: "l", fn: (c) => right(c, false), kind: "exclusive" },
  { keys: "<Right>", fn: (c) => right(c, false), kind: "exclusive" },
  { keys: "j", fn: displayOr(1, true), kind: "linewise", keepWant: true },
  { keys: "gj", fn: displayOr(1, false), kind: "linewise", keepWant: true },
  { keys: "<Down>", fn: (c) => vertical(c, 1), kind: "linewise", keepWant: true },
  { keys: "<C-n>", fn: (c) => vertical(c, 1), kind: "linewise", keepWant: true },
  { keys: "<C-j>", fn: (c) => vertical(c, 1), kind: "linewise", keepWant: true },
  { keys: "k", fn: displayOr(-1, true), kind: "linewise", keepWant: true },
  { keys: "gk", fn: displayOr(-1, false), kind: "linewise", keepWant: true },
  { keys: "<Up>", fn: (c) => vertical(c, -1), kind: "linewise", keepWant: true },
  { keys: "<C-p>", fn: (c) => vertical(c, -1), kind: "linewise", keepWant: true },
  { keys: "w", fn: wordForward(false), kind: wordKind },
  { keys: "W", fn: wordForward(true), kind: bigWordKind },
  { keys: "e", fn: repeatMotion((t, at) => T.wordEnd(t, at, false)), kind: "inclusive" },
  { keys: "E", fn: repeatMotion((t, at) => T.wordEnd(t, at, true)), kind: "inclusive" },
  { keys: "b", fn: repeatMotion((t, at) => T.wordBack(t, at, false)), kind: "exclusive" },
  { keys: "B", fn: repeatMotion((t, at) => T.wordBack(t, at, true)), kind: "exclusive" },
  { keys: "ge", fn: repeatMotion((t, at) => T.wordEndBack(t, at, false)), kind: "inclusive" },
  { keys: "gE", fn: repeatMotion((t, at) => T.wordEndBack(t, at, true)), kind: "inclusive" },
  { keys: "0", fn: (c) => T.lineStart(c.text, c.pos), kind: "exclusive" },
  { keys: "<Home>", fn: (c) => T.lineStart(c.text, c.pos), kind: "exclusive" },
  { keys: "^", fn: (c) => T.firstNonBlank(c.text, c.pos), kind: "exclusive" },
  {
    keys: "$",
    fn: (c) => { const s = lineDown(c, c.count - 1); return s == null ? null : T.lastChar(c.text, s); },
    kind: "inclusive",
    wantEnd: true,
  },
  { keys: "<End>", fn: (c) => T.lastChar(c.text, c.pos), kind: "inclusive", wantEnd: true },
  { keys: "gg", fn: line((c) => (c.hasCount ? c.count - 1 : 0)), kind: "linewise", jump: true },
  { keys: "G", fn: line((c) => (c.hasCount ? c.count - 1 : Infinity)), kind: "linewise", jump: true },
  // Enter as a motion only where the page doesn't take it (a composer sends with it).
  { keys: "<CR>", fn: (c) => { const s = lineDown(c, c.count); return s == null ? null : T.firstNonBlank(c.text, s); }, kind: "linewise" },
  { keys: "f", fn: find("f"), kind: "inclusive", arg: true },
  { keys: "t", fn: find("t"), kind: "inclusive", arg: true },
  { keys: "F", fn: find("F"), kind: "exclusive", arg: true },
  { keys: "T", fn: find("T"), kind: "exclusive", arg: true },
  { keys: ";", fn: repeatFind(false), kind: findKind(false) },
  { keys: ",", fn: repeatFind(true), kind: findKind(true) },
  { keys: "}", fn: repeatMotion(T.paragraphForward), kind: "exclusive", jump: true },
  { keys: "{", fn: repeatMotion(T.paragraphBack), kind: "exclusive", jump: true },
  // A labeled jump to any word in the field (HYDRA_KEYBOARD.md): after an operator or in visual mode,
  // a remote motion (y gw: yank from here through the word labelled). Alone, the page's jump.word,
  // where it has one (every word on screen), else the field's words. The engine sets jumpTarget.
  {
    keys: "gw",
    fn: (c) => {
      const at = c.session.jumpTarget;
      if (at == null) return null;
      // Forward, an operator takes the whole word it lands on.
      return c.op && at > c.pos ? T.wordEnd(c.text, at, false, true) : at;
    },
    kind: "inclusive",
    jump: true,
    labelJump: true,
  },
  // Sentences, and Markdown's structure (HYDRA_KEYBOARD.md): headings, list items, code blocks.
  { keys: ")", fn: repeatMotion(P.sentenceForward), kind: "exclusive", jump: true },
  { keys: "(", fn: repeatMotion(P.sentenceBack), kind: "exclusive", jump: true },
  { keys: "]h", fn: structure(1, P.isHeading), kind: "exclusive", jump: true },
  { keys: "[h", fn: structure(-1, P.isHeading), kind: "exclusive", jump: true },
  { keys: "]l", fn: structure(1, P.isItem), kind: "exclusive", jump: true },
  { keys: "[l", fn: structure(-1, P.isItem), kind: "exclusive", jump: true },
  { keys: "]c", fn: structure(1, P.isFence), kind: "exclusive", jump: true },
  { keys: "[c", fn: structure(-1, P.isFence), kind: "exclusive", jump: true },
  // Search (the last / or ?, *, #) and marks: jumps, which Ctrl+O goes back over.
  { keys: "n", fn: searchMotion(false), kind: "exclusive", jump: true },
  { keys: "N", fn: searchMotion(true), kind: "exclusive", jump: true },
  { keys: "*", fn: starMotion(false), kind: "exclusive", jump: true },
  { keys: "#", fn: starMotion(true), kind: "exclusive", jump: true },
  { keys: "'", fn: (c) => { const at = c.session.markOffset(c.arg); return at == null ? null : T.firstNonBlank(c.text, at); }, kind: "linewise", arg: true, jump: true },
  { keys: "`", fn: (c) => c.session.markOffset(c.arg), kind: "exclusive", arg: true, jump: true },
  {
    keys: "%",
    fn: (c) => {
      if (c.hasCount) {
        const lines = T.lineNumber(c.text, c.text.length) + 1;
        return T.firstNonBlank(c.text, T.lineStartOf(c.text, Math.ceil((c.count * lines) / 100) - 1));
      }
      const at = T.percent(c.text, c.pos);
      return at < 0 ? null : at;
    },
    kind: (c) => (c.hasCount ? "linewise" : "inclusive"),
    jump: true,
  },
];

/**
 * Where `pattern` (a JavaScript regular expression: Pluto Vim's searches are
 * JavaScript's, not vim's) next matches after `from`, or before it, going
 * round the end. Null if it doesn't match, or isn't a pattern.
 */
export function searchFrom(text, pattern, from, backward) {
  let re;
  try {
    re = new RegExp(pattern, "gmu");
  } catch {
    return null;
  }
  const starts = [];
  for (const m of text.matchAll(re)) {
    starts.push(m.index);
    if (starts.length > 100000) break;
  }
  if (!starts.length) return null;
  if (backward) {
    for (let k = starts.length - 1; k >= 0; k--) if (starts[k] < from) return starts[k];
    return starts[starts.length - 1];
  }
  for (const at of starts) if (at > from) return at;
  return starts[0];
}

function searchMotion(reverse) {
  return (c) => {
    const last = c.vim.lastSearch;
    if (!last) return null;
    let at = c.pos;
    for (let k = 0; k < c.count; k++) {
      at = searchFrom(c.text, last.pattern, at, last.backward !== reverse);
      if (at == null) return null;
    }
    return at;
  };
}

/** * and #: the word under the cursor, as a whole word, forward or back. */
function starMotion(backward) {
  return (c) => {
    const word = /[\p{L}\p{N}_]+/u;
    let from = c.pos;
    while (from > 0 && word.test(c.text[from - 1])) from--;
    let to = from;
    while (to < c.text.length && word.test(c.text[to])) to++;
    if (to === from) return null;
    const escaped = c.text.slice(from, to).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    c.vim.lastSearch = { pattern: `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, backward };
    return searchMotion(false)({ ...c, pos: backward ? from : c.pos });
  };
}

// ── Text objects ─────────────────────────────────────────────────────────
// fn(ctx, around) returns { from, to, linewise } (to is exclusive), or null.

function wordObject(big) {
  return (ctx, around) => {
    const { text } = ctx;
    const pos = Math.min(ctx.pos, Math.max(0, text.length - 1));
    const start = T.lineStart(text, pos);
    const end = T.lineEnd(text, pos);
    if (start === end) return null;
    const run = (at) => {
      const c = T.cls(text, at, big);
      let from = at;
      let to = at;
      while (from > start && T.cls(text, from - 1, big) === c) from--;
      while (to < end && T.cls(text, to, big) === c) to++;
      return { from, to, blank: c === 0 };
    };
    let first = run(pos);
    let { from, to } = first;
    for (let k = 1; k < ctx.count && to < end; k++) to = run(to).to;
    if (around) {
      if (first.blank) {
        if (to < end) to = run(to).to;
      } else if (to < end && T.cls(text, to, big) === 0) {
        to = run(to).to;
      } else {
        while (from > start && T.isBlank(text[from - 1])) from--;
      }
    }
    return { from, to, linewise: false };
  };
}

function quoteObject(quote) {
  return (ctx, around) => {
    const pair = T.quotePair(ctx.text, ctx.pos, quote);
    if (!pair) return null;
    const [open, close] = pair;
    if (!around) return { from: open + 1, to: close, linewise: false };
    const { text } = ctx;
    const end = T.lineEnd(text, open);
    const start = T.lineStart(text, open);
    let from = open;
    let to = close + 1;
    if (to < end && T.isBlank(text[to])) while (to < end && T.isBlank(text[to])) to++;
    else while (from > start && T.isBlank(text[from - 1])) from--;
    return { from, to, linewise: false };
  };
}

function bracketObject(open, close) {
  return (ctx, around) => {
    const pair = T.enclosingPair(ctx.text, ctx.pos, open, close, ctx.count);
    if (!pair) return null;
    const [a, b] = pair;
    if (around) return { from: a, to: b + 1, linewise: false };
    const { text } = ctx;
    let from = a + 1;
    let to = b;
    // i{ over lines: the lines between the brackets, not the brackets' lines.
    if (text[from] === "\n") {
      const closeLine = T.lineStart(text, b);
      if (text.slice(closeLine, b).trim() === "" && closeLine > from) {
        return { from: from + 1, to: closeLine - 1, linewise: true };
      }
      from++;
    }
    return { from, to, linewise: false };
  };
}

function tagObject(ctx, around) {
  const tag = T.enclosingTag(ctx.text, ctx.pos, ctx.count);
  if (!tag) return null;
  const [os, oe, cs, ce] = tag;
  return around ? { from: os, to: ce, linewise: false } : { from: oe, to: cs, linewise: false };
}

function paragraphObject(ctx, around) {
  const { text } = ctx;
  const here = T.lineStart(text, ctx.pos);
  const empty = T.lineEmpty(text, here);
  let first = here;
  let last = here;
  const grow = () => {
    for (let up = T.prevLineStart(text, first); up != null && T.lineEmpty(text, up) === T.lineEmpty(text, first); up = T.prevLineStart(text, first)) first = up;
    for (let down = T.nextLineStart(text, last); down != null && T.lineEmpty(text, down) === T.lineEmpty(text, last); down = T.nextLineStart(text, last)) last = down;
  };
  grow();
  if (around) {
    const after = T.nextLineStart(text, last);
    if (after != null && T.lineEmpty(text, after) !== empty) {
      last = after;
      for (let down = T.nextLineStart(text, last); down != null && T.lineEmpty(text, down) === T.lineEmpty(text, last); down = T.nextLineStart(text, last)) last = down;
    } else {
      const before = T.prevLineStart(text, first);
      if (before != null) {
        first = before;
        for (let up = T.prevLineStart(text, first); up != null && T.lineEmpty(text, up) === T.lineEmpty(text, first); up = T.prevLineStart(text, first)) first = up;
      }
    }
  }
  return { from: first, to: T.lineEnd(text, last), linewise: true };
}

/** Text objects by the key after `i` or `a`. */
export const OBJECTS = {
  w: wordObject(false),
  W: wordObject(true),
  '"': quoteObject('"'),
  "'": quoteObject("'"),
  "`": quoteObject("`"),
  "(": bracketObject("(", ")"), ")": bracketObject("(", ")"), b: bracketObject("(", ")"),
  "[": bracketObject("[", "]"), "]": bracketObject("[", "]"),
  "{": bracketObject("{", "}"), "}": bracketObject("{", "}"), B: bracketObject("{", "}"),
  "<": bracketObject("<", ">"), ">": bracketObject("<", ">"),
  t: tagObject,
  p: paragraphObject,
  // Markdown (HYDRA_KEYBOARD.md): a fenced code block, a list item, a section under a heading, a URL.
  c: (ctx, around) => P.codeBlock(ctx.text, ctx.pos, around),
  l: (ctx, around) => P.listItem(ctx.text, ctx.pos, around),
  h: (ctx, around) => P.section(ctx.text, ctx.pos, around),
  u: (ctx, around) => P.urlObject(ctx.text, ctx.pos, around),
};

// ── Operators ────────────────────────────────────────────────────────────
// The engine applies them (engine.js, applyOperator): names here, behaviour
// there, because each one edits the field.

export const OPERATORS = [
  { keys: "d", op: "d" },
  { keys: "c", op: "c" },
  { keys: "y", op: "y" },
  { keys: ">", op: ">" },
  { keys: "<lt>", op: "<" },
  { keys: "g~", op: "g~" },
  { keys: "gu", op: "gu" },
  { keys: "gU", op: "gU" },
];

/**
 * Keys a page fills with its own actions (data-pvim-actions; HYDRA_KEYBOARD.md,
 * "Pages fill slots"): the action of that name, with { count, text } as its
 * detail. A page that has none: `fallback`, as keys, where vim had a use for
 * the key; the key goes on to the page with `pass`; otherwise it does nothing.
 */
export const PAGE_KEYS = [
  { keys: " ", page: "context.pageDown", fallback: "l" },
  { keys: "<BS>", page: "context.pageUp", fallback: "h" },
  { keys: "<Tab>", page: "item.recent", pass: true },
  // The context's page from anywhere in normal mode, a field included: the timeline in Hydra, the
  // page around a tab's field, never the field's own text (vim's Ctrl+D and Ctrl+U scroll the window).
  { keys: "<C-d>", page: "context.pageDown" },
  { keys: "<C-u>", page: "context.pageUp" },
  { keys: "H", page: "item.previous" },
  { keys: "L", page: "item.next" },
  { keys: "K", page: "details", text: "word" },
  { keys: "S", page: "jump.significant" },
  { keys: "gx", page: "open", text: "target" },
  { keys: "gc", page: "place.composer" },
  { keys: "gm", page: "place.latest" },
  { keys: "gp", page: "place.pending" },
  { keys: "gt", page: "place.terminal" },
  { keys: "gb", page: "place.browser" },
  { keys: "gB", page: "place.address" },
  { keys: "ga", page: "place.app" },
  { keys: "gf", page: "place.files" },
  { keys: "gd", page: "place.diff" },
  { keys: "gs", page: "place.sidebar" },
  { keys: "zt", page: "show.terminal" },
  { keys: "zb", page: "show.panel" },
  { keys: "zs", page: "show.sidebar" },
  { keys: "zf", page: "show.files" },
  { keys: "zd", page: "show.diff" },
  { keys: "zm", page: "show.maximize" },
  { keys: "za", page: "fold.toggle" },
  { keys: "zo", page: "fold.open" },
  { keys: "zc", page: "fold.close" },
  { keys: "zR", page: "fold.openAll" },
  { keys: "zM", page: "fold.closeAll" },
  { keys: "z ", page: "mode.resize" },
].map((entry) => ({ ...entry, action: "page" }));

/**
 * Off a field (a page session: the page itself, a native window without a
 * field), normal mode's keys (HYDRA_KEYBOARD.md, "One input model"): the page
 * keys, what moves the page (the backend's own where the page doesn't take
 * them: dom.js scrolls, and goes back and forward in a tab), and the keys
 * that start typing, which go to the page's insert (Hydra's: the composer) or
 * else to insert mode, where the page or app has every key. Any other key
 * is the page's.
 */
export const PAGE_ACTIONS = [
  ...PAGE_KEYS,
  { keys: "j", page: "scroll.down" },
  { keys: "k", page: "scroll.up" },
  { keys: "h", page: "scroll.left" },
  { keys: "l", page: "scroll.right" },
  { keys: "gg", page: "scroll.top" },
  { keys: "G", page: "scroll.bottom" },
  { keys: "gw", page: "jump.word" },
  { keys: "gi", page: "place.composerInsert" },
  { keys: "gA", page: "place.composerEnd" },
  // Answers, where the page has something to answer (Hydra: a waiting approval with the keyboard on it).
  { keys: "y", page: "item.accept", pass: true },
  { keys: "n", page: "item.decline", pass: true },
].map((entry) => ({ ...entry, action: "page" })).concat(
  ["i", "a", "I", "A", "o", "O"].map((keys) => ({ keys, action: "insert", insert: true })),
);

// ── Actions ──────────────────────────────────────────────────────────────
// Normal mode's other commands. An alias is the same command in other keys
// (x is dl); the rest are run by the engine by name.

export const ACTIONS = [
  { keys: "x", alias: "dl" },
  { keys: "<Del>", alias: "dl" },
  { keys: "X", alias: "dh" },
  { keys: "D", alias: "d$" },
  { keys: "C", alias: "c$" },
  { keys: "Y", alias: "yy" },
  { keys: "i", action: "insert", insert: true },
  { keys: "<Insert>", action: "insert", insert: true },
  { keys: "a", action: "append", insert: true },
  { keys: "I", action: "insertLineStart", insert: true },
  { keys: "A", action: "appendLineEnd", insert: true },
  { keys: "o", action: "openBelow", insert: true },
  { keys: "O", action: "openAbove", insert: true },
  { keys: "p", action: "put", change: true },
  { keys: "P", action: "putBefore", change: true },
  { keys: "u", action: "undo" },
  { keys: "<C-r>", action: "redo" },
  { keys: "U", action: "redo" },
  { keys: "r", action: "replaceChar", arg: true, change: true },
  { keys: "J", action: "join", change: true },
  { keys: "~", action: "toggleCase", change: true },
  { keys: ".", action: "repeat" },
  { keys: "v", action: "visual" },
  { keys: "V", action: "visualLine" },
  { keys: "q", action: "record", arg: true },
  { keys: "@", action: "play", arg: true },
  { keys: "m", action: "mark", arg: true },
  { keys: "<C-o>", action: "jumpBack" },
  { keys: "<C-i>", action: "jumpForward" },
  // A labeled jump around here (HYDRA_KEYBOARD.md, "Jumps"): the engine's own, not a page's.
  { keys: "s", action: "jumpStart" },
  // The composer, from vim's own meaning of gi: where insert mode last ended; gA its end.
  { keys: "gi", action: "insertLast", insert: true },
  { keys: "gA", action: "appendEnd", insert: true },
  ...PAGE_KEYS,
];

/** Visual mode's commands, besides motions and text objects. */
export const VISUAL_ACTIONS = [
  { keys: "d", op: "d" }, { keys: "x", op: "d" }, { keys: "<Del>", op: "d" },
  { keys: "X", op: "d", lines: true }, { keys: "D", op: "d", lines: true },
  { keys: "y", op: "y" }, { keys: "Y", op: "y", lines: true },
  { keys: "c", op: "c" }, { keys: "s", action: "surround", arg: true, change: true },
  { keys: "C", op: "c", lines: true }, { keys: "S", op: "c", lines: true }, { keys: "R", op: "c", lines: true },
  { keys: ">", op: ">" }, { keys: "<lt>", op: "<" },
  { keys: "~", op: "g~" }, { keys: "u", op: "gu" }, { keys: "U", op: "gU" },
  { keys: "J", op: "J" },
  { keys: "r", op: "r", arg: true },
  { keys: "p", op: "p" }, { keys: "P", op: "P" },
  { keys: "o", action: "swapEnds" }, { keys: "O", action: "swapEnds" },
  { keys: "v", action: "visual" }, { keys: "V", action: "visualLine" },
];

/** A table's entries with their keys parsed: { keys: ["g", "~"], … }. */
export function compile(entries) {
  return entries.map((entry) => ({ ...entry, keys: parseKeys(entry.keys) }));
}

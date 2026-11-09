// Pluto Vim's stand-in web backend (PLUTO_VIM.md, step 2): Buffers over a
// page's own text fields, in ordinary page JavaScript, until Blink's vim core
// (step 3) replaces it. It does in JS what Blink will do natively:
// - keys: a keydown listener on the window, in the bubble phase, so the
//   page's own handlers on the field see each key first (Principle 1), and
//   a key one of them took (defaultPrevented) is never vim's;
// - text: an <input>'s or <textarea>'s value, or a contenteditable's text
//   with "\n" between blocks;
// - edits: execCommand, so pages get beforeinput and input events and the
//   field's own undo (ProseMirror, Lexical and React see ordinary edits);
// - the caret: CSS caret-shape where the browser has it, and always
//   data-pvim-mode on the field and a pvim:mode event (Pages that integrate).
//
// What it can't do that Blink will: run before a page's window listeners
// registered after it, and hide the engine from the page (it runs in the
// page's own world).

import { Vim } from "./engine.js";
import { PAGE_KEYS } from "./commands.js";
import { keyFromEvent, normalizeKey } from "./keys.js";

/** <input> types with a text selection (password is never vim's: Principle 5). */
const TEXT_INPUTS = new Set(["text", "search", "url", "tel"]);

/** Fields with key handling of their own, which keep it. */
const OWN_KEYS = '[data-pvim="off"], .monaco-editor, .cm-editor, .xterm';

/** Off a field: the desktop's keys a page passes on (its places, shows and jumps), as typed → action. */
const OFF_FIELD_KEYS = new Map([
  ...PAGE_KEYS.filter((e) => /^(place|show|jump)\./.test(e.page) && !e.keys.includes(" ")).map((e) => [e.keys, e.page]),
  ["gw", "jump.word"],
  ["gi", "place.composerInsert"],
]);

const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DETAILS|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|SUMMARY|TABLE|TR|UL)$/;

/** The field a key or focus at `target` belongs to (an editing host, for contenteditable), or null. */
export function fieldOf(target) {
  if (!target || target.nodeType !== 1) return null;
  if (target.closest(OWN_KEYS)) return null;
  // A region the page shows as text to read (Hydra's timeline), while it has the keyboard itself.
  if (target.hasAttribute("data-pvim-readonly")) return target;
  const view = target.ownerDocument.defaultView;
  if (target instanceof view.HTMLTextAreaElement) return hidden(target) || secret(target) ? null : target;
  if (target instanceof view.HTMLInputElement) return TEXT_INPUTS.has(target.type) && !secret(target) ? target : null;
  if (target.isContentEditable) {
    let root = target;
    while (root.parentElement?.isContentEditable) root = root.parentElement;
    return root;
  }
  return null;
}

/** A textarea a terminal or an editor reads keys through: tiny, transparent or off-screen. */
function hidden(el) {
  const rect = el.getBoundingClientRect();
  const style = el.ownerDocument.defaultView.getComputedStyle(el);
  return rect.width <= 2 || rect.height <= 2 || Number(style.opacity) === 0 || rect.right < 0 || rect.bottom < 0;
}

function secret(el) {
  return /password|one-time-code/.test(el.getAttribute("autocomplete") ?? "");
}

/**
 * What a page that integrates declares on a field (PLUTO_VIM.md, Pages that
 * integrate): its actions and commands, which the engine runs by
 * dispatching pvim:action with { name } (and the key's count and text, for
 * the keys pages fill: HYDRA_KEYBOARD.md), and the keys its own handlers give
 * up (in vim's notation: "<C-n> <Esc> <Space>"), for as long as it declares them.
 */
function integration(el) {
  const words = (name) => new Set((el.getAttribute(name) ?? "").split(/\s+/).filter(Boolean));
  return {
    actions: () => words("data-pvim-actions"),
    commands: () => words("data-pvim-commands"),
    yields: () => new Set([...words("data-pvim-yield")].map(normalizeKey)),
    action: (name, detail) => el.dispatchEvent(new el.ownerDocument.defaultView.CustomEvent("pvim:action", { detail: { ...detail, name }, bubbles: true })),
  };
}

/** A closed shadow root on the document, for what Pluto Vim draws over a page: the page's styles leave it alone. */
function overlay(doc, tag) {
  const host = doc.createElement(tag);
  host.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;inset:0;width:0;height:0";
  const root = host.attachShadow({ mode: "closed" });
  return { host, root };
}

/**
 * Where the characters at `offsets` of a textarea or input are on screen: a
 * copy of the field's text, laid out as the field lays it out, in a hidden
 * box over it.
 */
function textFieldRects(el, offsets) {
  const doc = el.ownerDocument;
  const view = doc.defaultView;
  const style = view.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const { host, root } = overlay(doc, "pvim-measure");
  const mirror = doc.createElement("div");
  for (const name of ["boxSizing", "width", "height", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "borderStyle", "fontFamily", "fontSize",
    "fontWeight", "fontStyle", "fontVariant", "fontStretch", "letterSpacing", "wordSpacing", "lineHeight", "textTransform",
    "textIndent", "textAlign", "tabSize", "direction"]) mirror.style[name] = style[name];
  Object.assign(mirror.style, {
    position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`, visibility: "hidden", overflow: "hidden",
    whiteSpace: el.tagName === "INPUT" ? "pre" : "pre-wrap", overflowWrap: "break-word", borderColor: "transparent",
  });
  const text = el.value;
  const sorted = [...new Set(offsets)].sort((a, b) => a - b);
  const spans = new Map();
  let at = 0;
  for (const offset of sorted) {
    mirror.append(doc.createTextNode(text.slice(at, offset)));
    const span = doc.createElement("span");
    const ch = text[offset];
    span.textContent = ch && ch !== "\n" ? ch : "\u200b";
    mirror.append(span);
    spans.set(offset, span);
    at = ch && ch !== "\n" ? offset + 1 : offset;
  }
  mirror.append(doc.createTextNode(text.slice(at)));
  root.append(mirror);
  doc.documentElement.append(host);
  const out = new Map();
  for (const [offset, span] of spans) {
    const r = span.getBoundingClientRect();
    out.set(offset, { left: r.left - el.scrollLeft, top: r.top - el.scrollTop, width: r.width, height: r.height });
  }
  host.remove();
  return out;
}

function setCaret(el, shape, mode) {
  el.dataset.pvimMode = mode;
  const css = el.ownerDocument.defaultView.CSS;
  if (css?.supports?.("caret-shape", shape)) el.style.setProperty("caret-shape", shape);
}

/**
 * Where `count` display lines down (dir 1) or up (-1) from a caret is, by the
 * browser's own line movement (Selection.modify, which works in text
 * controls too), in `offsetOf()`'s terms; null when there's no line there
 * (on the last line the browser goes to its end instead: still the same line).
 * `place(offset)` puts a collapsed caret; the caller puts its selection back.
 * At a soft wrap the end of a line and the start of the next are one offset:
 * { end: true } says the browser left the caret at the end of the line.
 */
function displayLine(sel, place, offsetOf, offset, dir, count) {
  place(offset);
  sel.modify("move", "backward", "lineboundary");
  const from = offsetOf();
  place(offset);
  for (let k = 0; k < count; k++) sel.modify("move", dir > 0 ? "forward" : "backward", "line");
  const at = offsetOf();
  if (at == null || at === offset) return null;
  sel.modify("move", "backward", "lineboundary");
  const lineStart = offsetOf();
  if (lineStart === from) return null;
  if (lineStart == null || lineStart >= at) return { offset: at, end: false };
  // Mid-line, or the end of a wrapped line: placed afresh, a caret at a soft wrap starts the next line.
  place(at);
  sel.modify("move", "backward", "lineboundary");
  return { offset: at, end: offsetOf() === at };
}

function insertText(doc, insert, collapsed) {
  if (insert === "") {
    if (!collapsed) doc.execCommand("delete");
    return;
  }
  doc.execCommand("insertText", false, insert);
}

// ── <input> and <textarea> ───────────────────────────────────────────────

export class TextFieldBuffer {
  constructor(el) {
    this.el = el;
    this.kind = "web";
    this.field = { singleLine: el.tagName === "INPUT", site: el.ownerDocument.location?.host, ...integration(el) };
    this.caps = { exactMotions: true, wholeText: true, selection: true, undo: "own" };
  }

  text() {
    const { el } = this;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? start;
    const back = el.selectionDirection === "backward";
    return { text: el.value, start: 0, cursor: back ? start : end, anchor: back ? end : start };
  }

  move({ offset, extend = false }) {
    const { el } = this;
    if (!extend) return el.setSelectionRange(offset, offset);
    const { anchor } = this.text();
    el.setSelectionRange(Math.min(anchor, offset), Math.max(anchor, offset), offset < anchor ? "backward" : "forward");
  }

  edit({ from, to }, insert) {
    if (from === to && insert === "") return;
    this.el.setSelectionRange(from, to);
    insertText(this.el.ownerDocument, insert, from === to);
  }

  undo() { this.el.ownerDocument.execCommand("undo"); }
  redo() { this.el.ownerDocument.execCommand("redo"); }

  /** j and k's display lines (vim.opt.displayLines): a textarea's, as it wraps; undefined for an <input>. */
  displayLine(offset, dir, count) {
    const { el } = this;
    const sel = el.ownerDocument.getSelection?.();
    if (el.tagName !== "TEXTAREA" || !sel?.modify || el.ownerDocument.activeElement !== el) return undefined;
    const { selectionStart, selectionEnd, selectionDirection } = el;
    try {
      return displayLine(sel, (at) => el.setSelectionRange(at, at), () => el.selectionEnd, offset, dir, count);
    } finally {
      el.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
    }
  }

  /** Where the characters at `offsets` are on screen: offset → rect (the jump's labels). */
  rectsOf(offsets) { return textFieldRects(this.el, offsets); }

  setCaret(shape, mode) { setCaret(this.el, shape, mode); }
}

// ── contenteditable ──────────────────────────────────────────────────────

/**
 * The text of an editing host, and where each offset is in the DOM. Blocks
 * are lines; a <br> is a newline, except the last one in a block, which only
 * holds an empty line open (Chrome's <div><br></div>, ProseMirror's trailing
 * break).
 */
export function editableModel(root) {
  let text = "";
  /** Points in document order, each with its offset: [node, nodeOffset, textOffset]. */
  const points = [];
  /** Text nodes: [node, start]. */
  const texts = [];
  let started = false;
  let afterBlock = false;

  const inline = () => {
    if (afterBlock) {
      text += "\n";
      afterBlock = false;
    }
    started = true;
  };

  const visit = (node) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) {
        if (child.data === "") continue;
        inline();
        texts.push([child, text.length]);
        points.push([child, 0, text.length]);
        text += child.data;
        points.push([child, child.data.length, text.length]);
      } else if (child.nodeType === 1) {
        const tag = child.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEMPLATE") continue;
        if (tag === "BR") {
          if (lastInBlock(child, root)) continue;
          inline();
          const index = [...child.parentNode.childNodes].indexOf(child);
          points.push([child.parentNode, index, text.length]);
          text += "\n";
          points.push([child.parentNode, index + 1, text.length]);
        } else if (BLOCK.test(tag)) {
          if (started) text += "\n";
          started = true;
          afterBlock = false;
          points.push([child, 0, text.length]);
          visit(child);
          afterBlock = true;
        } else {
          visit(child);
        }
      }
    }
  };
  points.push([root, 0, 0]);
  visit(root);
  // Editors write spaces as no-break spaces so they show; to vim they're spaces (same length, same offsets).
  return { text: text.replace(/\u00a0/g, " "), points, texts };
}

function lastInBlock(br, root) {
  for (let node = br; node && node !== root; node = node.parentNode) {
    for (let next = node.nextSibling; next; next = next.nextSibling) {
      if (next.nodeType === 3 && next.data !== "") return false;
      if (next.nodeType === 1) return BLOCK.test(next.tagName);
    }
    if (node.parentNode && BLOCK.test(node.parentNode.tagName)) return true;
  }
  return true;
}

export class EditableBuffer {
  constructor(root) {
    this.root = root;
    this.kind = "web";
    this.field = { singleLine: false, site: root.ownerDocument.location?.host, ...integration(root) };
    this.caps = { exactMotions: true, wholeText: true, selection: true, undo: "own" };
  }

  #doc() { return this.root.ownerDocument; }

  /**
   * Editors (ProseMirror, Lexical) learn of a DOM selection change from
   * selectionchange, which the browser fires later; an edit right after would
   * land at the editor's old selection. Telling them now keeps them in step.
   */
  #selectionChanged() {
    const doc = this.#doc();
    doc.dispatchEvent(new doc.defaultView.Event("selectionchange"));
  }

  /** The DOM point of a text offset. */
  #point(model, offset) {
    for (const [node, start] of model.texts) {
      if (offset >= start && offset <= start + node.data.length) return [node, offset - start];
    }
    let best = [this.root, 0];
    for (const [node, nodeOffset, at] of model.points) {
      if (at === offset) return [node, nodeOffset];
      if (at < offset) best = [node, nodeOffset];
    }
    return best;
  }

  /** The text offset of a DOM point: the last point at or before it. */
  #offset(model, node, nodeOffset) {
    if (!this.root.contains(node)) return 0;
    if (node.nodeType === 3) {
      const found = model.texts.find(([n]) => n === node);
      if (found) return found[1] + nodeOffset;
    }
    const range = this.#doc().createRange();
    range.setStart(node, nodeOffset);
    let at = 0;
    for (const [n, o, offset] of model.points) {
      if (range.comparePoint(n, o) <= 0) at = offset;
      else break;
    }
    return at;
  }

  text() {
    const model = editableModel(this.root);
    const sel = this.#doc().getSelection();
    if (!sel || !sel.anchorNode || !this.root.contains(sel.anchorNode)) return { text: model.text, start: 0, cursor: 0, anchor: 0 };
    return {
      text: model.text,
      start: 0,
      cursor: this.#offset(model, sel.focusNode, sel.focusOffset),
      anchor: this.#offset(model, sel.anchorNode, sel.anchorOffset),
    };
  }

  move({ offset, extend = false }) {
    const model = editableModel(this.root);
    const sel = this.#doc().getSelection();
    const [node, nodeOffset] = this.#point(model, offset);
    if (extend && sel.rangeCount) sel.extend(node, nodeOffset);
    else sel.collapse(node, nodeOffset);
    this.#selectionChanged();
  }

  /** j and k's display lines (vim.opt.displayLines), as the editing host wraps them. */
  displayLine(offset, dir, count) {
    const sel = this.#doc().getSelection();
    if (!sel?.modify || !sel.rangeCount || !this.root.contains(sel.anchorNode)) return undefined;
    const model = editableModel(this.root);
    const saved = [sel.anchorNode, sel.anchorOffset, sel.focusNode, sel.focusOffset];
    const place = (at) => sel.collapse(...this.#point(model, at));
    const offsetOf = () => (this.root.contains(sel.focusNode) ? this.#offset(model, sel.focusNode, sel.focusOffset) : null);
    try {
      return displayLine(sel, place, offsetOf, offset, dir, count);
    } finally {
      sel.setBaseAndExtent(...saved);
    }
  }

  async edit({ from, to }, insert) {
    if (from === to && insert === "") return;
    const doc = this.#doc();
    const model = editableModel(this.root);
    const sel = doc.getSelection();
    const [a, ao] = this.#point(model, from);
    const [b, bo] = this.#point(model, to);
    sel.setBaseAndExtent(a, ao, b, bo);
    this.#selectionChanged();
    // A newline is a new paragraph, as Enter makes it: an editor's own model sees a split, not a "\n" in a text node.
    const lines = insert.split("\n");
    if (from !== to) doc.execCommand("delete");
    for (const [k, line] of lines.entries()) {
      if (k > 0) await this.#newline();
      if (line) doc.execCommand("insertText", false, line);
    }
  }

  /**
   * An editor keeps its own history (ProseMirror, Lexical, Tiptap) and binds
   * it to Ctrl+Z: the key goes to it first. A plain contenteditable has no
   * handler, and gets the browser's own undo.
   */
  /**
   * A new paragraph; where the editor refuses one (a chat composer whose
   * document is one paragraph), a line break, as Shift+Enter. An editor with
   * a model undoes what its schema refuses from its mutation observer, a
   * microtask later: still before the next key's event.
   */
  async #newline() {
    const doc = this.#doc();
    const lines = () => editableModel(this.root).text.split("\n").length;
    // First as a person makes a new line without sending: Shift+Enter, to the editor's own key handler.
    // A DOM change that adds a block is Enter to ProseMirror (it runs its Enter handler, and a chat
    // composer like Hydra's sends), so the editing commands below come only where no handler took it.
    const view = doc.defaultView;
    const shiftEnter = new view.KeyboardEvent("keydown", { key: "Enter", code: "Enter", shiftKey: true, bubbles: true, cancelable: true });
    // The editor reads the text just typed from its mutation observer: let it, before it handles a key.
    await settled();
    const start = lines();
    this.root.dispatchEvent(shiftEnter);
    if (shiftEnter.defaultPrevented) {
      await settled();
      // At the end of a block an editor may hold the new line open with a second break: one newline was asked for.
      if (lines() - start > 1) {
        doc.execCommand("forwardDelete");
        await settled();
      }
      return;
    }
    // A field of one paragraph is likely a composer that keeps it one (lines are line breaks); try that first.
    const blocks = [...this.root.children].filter((child) => BLOCK.test(child.tagName)).length;
    const order = blocks <= 1 ? ["insertLineBreak", "insertParagraph"] : ["insertParagraph", "insertLineBreak"];
    const before = lines();
    for (const command of order) {
      doc.execCommand(command);
      await settled();
      const added = lines() - before;
      if (added <= 0) continue;
      // At the end of a block Chrome adds a second <br> to hold the new line open; an editor with a model
      // (ProseMirror) keeps it as a real break, and it holds its own line open. One newline was asked for.
      if (added > 1) {
        doc.execCommand("forwardDelete");
        await settled();
      }
      return;
    }
  }

  undo() { this.#historyKey([{ key: "z", code: "KeyZ", ctrlKey: true }], "undo"); }
  redo() { this.#historyKey([{ key: "Z", code: "KeyZ", ctrlKey: true, shiftKey: true }, { key: "y", code: "KeyY", ctrlKey: true }], "redo"); }

  #historyKey(keys, command) {
    const view = this.#doc().defaultView;
    for (const init of keys) {
      const event = new view.KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
      this.root.dispatchEvent(event);
      if (event.defaultPrevented) return;
    }
    this.#doc().execCommand(command);
  }

  /** Where the characters at `offsets` are on screen: offset → rect (the jump's labels). */
  rectsOf(offsets) {
    const model = editableModel(this.root);
    const doc = this.#doc();
    const out = new Map();
    for (const offset of offsets) {
      const range = doc.createRange();
      const inText = model.texts.find(([node, start]) => offset >= start && offset < start + node.data.length);
      if (inText) {
        range.setStart(inText[0], offset - inText[1]);
        range.setEnd(inText[0], offset - inText[1] + 1);
      } else {
        range.setStart(...this.#point(model, offset));
      }
      const r = range.getClientRects()[0] ?? range.getBoundingClientRect();
      if (r && (r.width || r.height)) out.set(offset, { left: r.left, top: r.top, width: r.width, height: r.height });
    }
    return out;
  }

  setCaret(shape, mode) { setCaret(this.root, shape, mode); }
}

/** After the microtasks an edit queued: mutation observers, and what editors do from them. */
async function settled() {
  for (let k = 0; k < 3; k++) await Promise.resolve();
}

/** The Buffer for a field fieldOf() returned. */
export function bufferFor(el) {
  if (el.hasAttribute("data-pvim-readonly")) return new ReadOnlyBuffer(el);
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? new TextFieldBuffer(el) : new EditableBuffer(el);
}

// ── A read-only region ───────────────────────────────────────────────────

/**
 * Text a page shows to read, not to edit (data-pvim-readonly, focusable:
 * Hydra's timeline). The cursor is the document's selection inside it, which
 * a non-editable region doesn't draw, so it's drawn here; visual mode is the
 * selection itself, and y copies it. Edits do nothing (the engine refuses
 * them first).
 */
export class ReadOnlyBuffer extends EditableBuffer {
  constructor(root) {
    super(root);
    this.caps = { ...this.caps, readonly: true, undo: "none" };
    this.caretBox = null;
  }

  text() {
    const snap = super.text();
    // Nothing chosen in it yet: the cursor starts at the first character on screen, not the top of a long thread.
    const sel = this.root.ownerDocument.getSelection();
    if (!sel?.anchorNode || !this.root.contains(sel.anchorNode)) {
      const [first] = this.visibleRange();
      return { ...snap, cursor: first, anchor: first };
    }
    return snap;
  }

  move(target) {
    super.move(target);
    this.#showCaret(target.offset, target.extend);
  }

  async edit() {}
  undo() {}
  redo() {}

  /** Draws the cursor where the selection is (it takes focus: its cursor shows before the first key). */
  showCursor() {
    const { cursor } = this.text();
    this.#showCaret(cursor, false);
  }

  /** The offsets of the text on screen: [first, last]. */
  visibleRange() {
    const model = editableModel(this.root);
    const box = this.root.getBoundingClientRect();
    let first = null;
    let last = 0;
    for (const [node, start] of model.texts) {
      const parent = node.parentElement;
      if (!parent) continue;
      const r = parent.getBoundingClientRect();
      if (r.bottom < box.top || r.top > box.bottom || r.height === 0) continue;
      if (first == null) first = start;
      last = start + node.data.length;
    }
    return [first ?? 0, first == null ? model.text.length : last];
  }

  setCaret(shape, mode) {
    super.setCaret(shape, mode);
    if (!this.caretBox) return;
    this.caretBox.host.style.display = mode === "visual" || mode === "vline" ? "none" : "";
  }

  #showCaret(offset, extend, scrolled = false) {
    const doc = this.root.ownerDocument;
    const rect = this.rectsOf([offset]).get(offset);
    if (!rect) return;
    // Keep the cursor on screen: the region is its own scroller (or inside one).
    const box = this.root.getBoundingClientRect();
    if (!scrolled && (rect.top < box.top || rect.top + rect.height > box.bottom)) {
      this.root.scrollBy({ top: rect.top - (box.top + box.height / 3), behavior: "instant" });
      return this.#showCaret(offset, extend, true);
    }
    if (!this.caretBox) {
      const host = doc.createElement("pvim-caret");
      host.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;inset:0;width:0;height:0";
      const box = doc.createElement("div");
      box.style.cssText = "position:fixed;background:rgba(255,200,40,.55);outline:1px solid rgba(0,0,0,.4);border-radius:1px";
      host.attachShadow({ mode: "closed" }).append(box);
      this.caretBox = { host, box };
      this.root.addEventListener("focusout", () => this.caretBox?.host.remove());
    }
    Object.assign(this.caretBox.box.style, {
      left: `${rect.left}px`, top: `${rect.top}px`, width: `${Math.max(rect.width, 6)}px`, height: `${rect.height}px`,
    });
    if (!this.caretBox.host.isConnected) doc.documentElement.append(this.caretBox.host);
    this.caretBox.host.style.display = extend ? "none" : "";
  }
}

// ── A document ───────────────────────────────────────────────────────────

/**
 * Pluto Vim in every field of `doc`. Returns { vim, sessionOf, detach }.
 * `options.vim` shares a Vim (and its registers) between documents; otherwise
 * `options.opt` sets the new one's options. `options.shell` names the shell
 * the page is, for vim.disable({ shell }).
 */
export function attach(doc = globalThis.document, options = {}) {
  const vim = options.vim ?? new Vim({ opt: options.opt });
  const view = doc.defaultView;
  const sessions = new WeakMap();

  const sessionOf = (field) => {
    let session = sessions.get(field);
    if (!session) {
      const buffer = bufferFor(field);
      // vim.enable({ …, start }) for this field, else the page's own (data-pvim-start) unless
      // init.js chose one for every field (vim.opt.startInInsert).
      const start = vim.startFor({ site: doc.location?.hostname, shell: options.shell, el: field })
        ?? (vim.userOpts.has("startInInsert") ? null : field.dataset.pvimStart);
      session = vim.attach(buffer, start ? { startInInsert: start !== "normal" } : {});
      sessions.set(field, session);
    }
    return session;
  };

  const target = (event) => event.composedPath?.()[0] ?? event.target;

  /** The field at `el`, if Pluto Vim is on for it (vim.disable and vim.enable). */
  const vimField = (el) => {
    const field = fieldOf(el);
    return field && vim.enabledFor({ site: doc.location?.hostname, shell: options.shell, el: field }) ? field : null;
  };

  const onFocus = (event) => {
    const field = vimField(target(event));
    if (!field) return;
    const session = sessionOf(field);
    session.buffer.showCursor?.();
    vim.emit("FieldEnter", { session });
  };

  const onBlur = (event) => {
    const field = vimField(target(event));
    const session = field && sessions.get(field);
    if (!session) return;
    // Keys held for a mapping would land wherever focus went: they're dropped.
    session.cancelPending();
    vim.emit("FieldLeave", { session });
  };

  // Off a field, in a page that doesn't take them itself (a browser tab in Hydra's panel): the
  // desktop's places, shows and jumps go to the shell (PageKey; HYDRA_KEYBOARD.md).
  let offPending = "";
  let offTimer = null;
  const offField = (event) => {
    if (event.ctrlKey || event.altKey || event.metaKey || !vim.listeners.get("PageKey")?.size) return;
    const el = target(event);
    if (el?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]') || el?.closest?.(OWN_KEYS)) return;
    const key = keyFromEvent(event);
    if (!key || [...key].length !== 1) return;
    const keys = offPending + key;
    const exact = OFF_FIELD_KEYS.get(keys);
    clearTimeout(offTimer);
    offPending = "";
    if (exact) {
      event.preventDefault();
      event.stopImmediatePropagation();
      vim.emit("PageKey", { session: null, name: exact, detail: { count: null } });
    } else if ([...OFF_FIELD_KEYS.keys()].some((lhs) => lhs.length > keys.length && lhs.startsWith(keys))) {
      event.preventDefault();
      event.stopImmediatePropagation();
      offPending = keys;
      offTimer = setTimeout(() => { offPending = ""; }, 1000);
    }
  };

  const handle = (event, claimed) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    if (!event.isTrusted && !options.untrusted) return;
    const field = vimField(target(event));
    if (!field) {
      if (!claimed) offField(event);
      return;
    }
    const key = keyFromEvent(event);
    if (!key) return;
    const session = sessionOf(field);
    // Claimed: vim.opt.claim, every key while a jump or the : line is typed, and the keys the page
    // gives up while it says so (data-pvim-yield, in vim's notation).
    const claim = vim.opt.claim.includes(key) || session.claimsAll || session.buffer.field.yields().has(key);
    if (claim !== claimed) return;
    if (session.feed(key)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  // The claimed keys, before anything of the page's (the window's capture phase is the first to see a key).
  const onClaimed = (event) => handle(event, true);
  // The rest, after the page's own handlers on the field and the document; once Blink offers keys
  // (Plutonium's key hook), from its plutoniumvimkey instead, after every handler of the page's.
  let hooked = false;
  const onKey = (event) => {
    if (!hooked) return handle(event, false);
    // Blink's hook offers only keys a field would edit with: off a field, keys come as keydown only.
    if (!vimField(target(event)) && !event.defaultPrevented && event.isTrusted) offField(event);
  };
  const onOffer = (event) => handle(event, false);
  const onReady = (event) => { if (event.isTrusted) hooked = true; };

  // The command line (:, /, ?, "=), messages (:registers) and "recording @a", under the field,
  // in a closed shadow root so the page's styles leave it alone.
  let line = null;
  let messageTimer = null;
  const lineFor = (session) => {
    const el = session?.buffer?.el ?? session?.buffer?.root;
    if (!el || el.ownerDocument !== doc) return null;
    if (!line) {
      const host = doc.createElement("pvim-line");
      host.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;inset:auto";
      const root = host.attachShadow({ mode: "closed" });
      const box = doc.createElement("div");
      box.style.cssText = "font:12px/1.4 ui-monospace,monospace;white-space:pre;max-width:80vw;max-height:40vh;overflow:hidden;" +
        "padding:2px 6px;border-radius:4px;color:#eee;background:rgba(30,30,36,.92);box-shadow:0 1px 4px rgba(0,0,0,.3)";
      root.append(box);
      line = { host, box };
    }
    const rect = el.getBoundingClientRect();
    line.host.style.left = `${Math.max(0, Math.round(rect.left))}px`;
    line.host.style.top = `${Math.round(Math.min(view.innerHeight - 24, rect.bottom + 2))}px`;
    if (!line.host.isConnected) doc.documentElement.append(line.host);
    return line;
  };
  const show = (session, text) => {
    const l = lineFor(session);
    if (!l) return;
    clearTimeout(messageTimer);
    if (text == null) l.host.remove();
    else l.box.textContent = text;
  };
  const onCmdline = ({ session, cmdline }) => show(session, cmdline);
  const onMessage = ({ session, text }) => {
    show(session, text);
    messageTimer = setTimeout(() => line?.host.remove(), Math.min(10000, 3000 + text.length * 20));
  };
  const onRecording = ({ session, register }) => show(session, register ? `recording @${register}` : null);

  // The labels of a jump (s), over the characters they go to.
  let labels = null;
  const onJumpLabels = ({ session, targets }) => {
    labels?.host.remove();
    labels = null;
    const buffer = session?.buffer;
    const el = buffer?.el ?? buffer?.root;
    if (!targets?.length || !el || el.ownerDocument !== doc || typeof buffer.rectsOf !== "function") return;
    const shown = targets.filter((t) => t.label);
    let rects;
    try {
      rects = buffer.rectsOf(shown.map((t) => t.offset));
    } catch {
      return;
    }
    labels = overlay(doc, "pvim-labels");
    const style = doc.createElement("style");
    style.textContent = "b{position:fixed;font:bold 12px/1 ui-monospace,monospace;padding:1px 3px;border-radius:3px;" +
      "color:#1b1b1f;background:#ffd84a;box-shadow:0 0 0 1px rgba(0,0,0,.35)}";
    labels.root.append(style);
    for (const target of shown) {
      const r = rects.get(target.offset);
      if (!r || r.top + r.height < 0 || r.top > view.innerHeight || r.left > view.innerWidth) continue;
      const b = doc.createElement("b");
      b.textContent = target.label;
      b.style.left = `${Math.round(r.left)}px`;
      b.style.top = `${Math.round(r.top + Math.max(0, (r.height - 14) / 2))}px`;
      labels.root.append(b);
    }
    doc.documentElement.append(labels.host);
  };

  const onMode = ({ session, to }) => {
    const el = session.buffer.el ?? session.buffer.root;
    if (!el || el.ownerDocument !== doc) return;
    el.dispatchEvent(new view.CustomEvent("pvim:mode", { detail: { mode: to }, bubbles: true }));
  };

  // A page that integrates sets the mode: pvim:set-mode with { mode } on the field.
  const onSetMode = (event) => {
    const field = vimField(target(event));
    const mode = event.detail?.mode;
    if (field && (mode === "normal" || mode === "insert")) sessionOf(field).enterMode(mode);
  };
  doc.addEventListener("pvim:set-mode", onSetMode);
  doc.addEventListener("focusin", onFocus, true);
  doc.addEventListener("focusout", onBlur, true);
  view.addEventListener("keydown", onClaimed, true);
  view.addEventListener("keydown", onKey);
  view.addEventListener("plutoniumvimready", onReady);
  view.addEventListener("plutoniumvimkey", onOffer);
  const unlistens = [
    vim.on("ModeChanged", onMode),
    vim.on("CmdlineChanged", onCmdline),
    vim.on("Message", onMessage),
    vim.on("RecordingChanged", onRecording),
    vim.on("JumpLabels", onJumpLabels),
  ];
  const active = vimField(doc.activeElement);
  if (active) sessionOf(active);

  return {
    vim,
    sessionOf,
    /** Uppercase mark `name`, set in this page: focuses its field and moves there (the helper asks). */
    jumpToMark(name, offset) {
      const mark = vim.globalMarks.get(name);
      const el = mark?.session?.buffer?.el ?? mark?.session?.buffer?.root;
      if (!el?.isConnected) return false;
      el.focus();
      mark.session.moveTo(mark.offset ?? offset);
      return true;
    },
    /** Whether keys come from Blink's hook (plutoniumvimkey), not keydown. */
    get hooked() { return hooked; },
    detach() {
      doc.removeEventListener("focusin", onFocus, true);
      doc.removeEventListener("pvim:set-mode", onSetMode);
      doc.removeEventListener("focusout", onBlur, true);
      view.removeEventListener("keydown", onClaimed, true);
      view.removeEventListener("keydown", onKey);
      view.removeEventListener("plutoniumvimkey", onOffer);
      view.removeEventListener("plutoniumvimready", onReady);
      for (const unlisten of unlistens) unlisten();
      line?.host.remove();
      labels?.host.remove();
    },
  };
}

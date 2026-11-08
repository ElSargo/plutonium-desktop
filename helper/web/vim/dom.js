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
import { keyFromEvent } from "./keys.js";

/** <input> types with a text selection (password is never vim's: Principle 5). */
const TEXT_INPUTS = new Set(["text", "search", "url", "tel"]);

/** Fields with key handling of their own, which keep it. */
const OWN_KEYS = '[data-pvim="off"], .monaco-editor, .cm-editor, .xterm';

const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DETAILS|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|SUMMARY|TABLE|TR|UL)$/;

/** The field a key or focus at `target` belongs to (an editing host, for contenteditable), or null. */
export function fieldOf(target) {
  if (!target || target.nodeType !== 1) return null;
  if (target.closest(OWN_KEYS)) return null;
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
 * dispatching pvim:action with { name }, and the keys its own handlers give
 * up (in vim's notation: "<C-n> <Esc>"), for as long as it declares them.
 */
function integration(el) {
  const words = (name) => new Set((el.getAttribute(name) ?? "").split(/\s+/).filter(Boolean));
  return {
    actions: () => words("data-pvim-actions"),
    commands: () => words("data-pvim-commands"),
    yields: () => words("data-pvim-yield"),
    action: (name) => el.dispatchEvent(new el.ownerDocument.defaultView.CustomEvent("pvim:action", { detail: { name }, bubbles: true })),
  };
}

function setCaret(el, shape, mode) {
  el.dataset.pvimMode = mode;
  const css = el.ownerDocument.defaultView.CSS;
  if (css?.supports?.("caret-shape", shape)) el.style.setProperty("caret-shape", shape);
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

  setCaret(shape, mode) { setCaret(this.root, shape, mode); }
}

/** After the microtasks an edit queued: mutation observers, and what editors do from them. */
async function settled() {
  for (let k = 0; k < 3; k++) await Promise.resolve();
}

/** The Buffer for a field fieldOf() returned. */
export function bufferFor(el) {
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? new TextFieldBuffer(el) : new EditableBuffer(el);
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
    if (field) vim.emit("FieldEnter", { session: sessionOf(field) });
  };

  const onBlur = (event) => {
    const field = vimField(target(event));
    const session = field && sessions.get(field);
    if (!session) return;
    // Keys held for a mapping would land wherever focus went: they're dropped.
    session.cancelPending();
    vim.emit("FieldLeave", { session });
  };

  const handle = (event, claimed) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    if (!event.isTrusted && !options.untrusted) return;
    const field = vimField(target(event));
    if (!field) return;
    const key = keyFromEvent(event);
    if (!key) return;
    const session = sessionOf(field);
    // Claimed: vim.opt.claim, and the keys the page gives up while it says so (data-pvim-yield, in vim's notation).
    const claim = vim.opt.claim.includes(key) || session.buffer.field.yields().has(key);
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
  const onKey = (event) => { if (!hooked) handle(event, false); };
  const onOffer = (event) => handle(event, false);
  const onReady = (event) => { if (event.isTrusted) hooked = true; };

  const onMode = ({ session, to }) => {
    const el = session.buffer.el ?? session.buffer.root;
    if (!el || el.ownerDocument !== doc) return;
    el.dispatchEvent(new view.CustomEvent("pvim:mode", { detail: { mode: to }, bubbles: true }));
  };

  doc.addEventListener("focusin", onFocus, true);
  doc.addEventListener("focusout", onBlur, true);
  view.addEventListener("keydown", onClaimed, true);
  view.addEventListener("keydown", onKey);
  view.addEventListener("plutoniumvimready", onReady);
  view.addEventListener("plutoniumvimkey", onOffer);
  const unlisten = vim.on("ModeChanged", onMode);
  const active = vimField(doc.activeElement);
  if (active) sessionOf(active);

  return {
    vim,
    sessionOf,
    /** Whether keys come from Blink's hook (plutoniumvimkey), not keydown. */
    get hooked() { return hooked; },
    detach() {
      doc.removeEventListener("focusin", onFocus, true);
      doc.removeEventListener("focusout", onBlur, true);
      view.removeEventListener("keydown", onClaimed, true);
      view.removeEventListener("keydown", onKey);
      view.removeEventListener("plutoniumvimkey", onOffer);
      view.removeEventListener("plutoniumvimready", onReady);
      unlisten();
    },
  };
}

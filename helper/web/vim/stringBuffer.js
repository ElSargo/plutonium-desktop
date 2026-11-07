// A Buffer over a plain string (PLUTO_VIM.md, The Buffer interface): what the
// engine's tests drive, and the reference for what a backend must do. It also
// plays the field's own part for keys the engine doesn't take (typeKey), as a
// textarea would: typing, Enter, Backspace, Delete and the arrows.
//
// Undo steps follow a browser's: each edit() is one step, and a run of typed
// characters is one step until something else happens.

export class StringBuffer {
  /**
   * @param {string} [text]
   * @param {{ cursor?: number, anchor?: number, singleLine?: boolean }} [options]
   */
  constructor(text = "", { cursor = 0, anchor = cursor, singleLine = false } = {}) {
    this.value = text;
    this.cursor = cursor;
    this.anchor = anchor;
    this.kind = "web";
    this.field = { singleLine };
    this.caps = { exactMotions: true, wholeText: true, selection: true, undo: "own" };
    this.caret = "bar";
    /** What Enter submitted in a single-line field. */
    this.submitted = [];
    this.undoStack = [];
    this.redoStack = [];
    this.typing = false;
  }

  text() {
    return { text: this.value, start: 0, cursor: this.cursor, anchor: this.anchor };
  }

  move(to) {
    this.typing = false;
    if (!("offset" in to)) throw new Error("StringBuffer moves by offset only");
    const offset = Math.max(0, Math.min(to.offset, this.value.length));
    this.cursor = offset;
    if (!to.extend) this.anchor = offset;
  }

  edit(range, insert) {
    this.typing = false;
    this.#replace(range.from, range.to, insert);
  }

  undo() { this.#step(this.undoStack, this.redoStack); }
  redo() { this.#step(this.redoStack, this.undoStack); }

  setCaret(shape) { this.caret = shape; }

  /** The selected text, in selection order. */
  selection() {
    const [a, b] = [this.anchor, this.cursor].sort((x, y) => x - y);
    return this.value.slice(a, b);
  }

  /** What the field itself does with a key the engine didn't take. */
  typeKey(key) {
    const [from, to] = [this.anchor, this.cursor].sort((x, y) => x - y);
    if ([...key].length === 1) return this.#type(from, to, key);
    switch (key) {
      case "<CR>":
        if (this.field.singleLine) return void this.submitted.push(this.value);
        return this.#type(from, to, "\n");
      case "<BS>":
        if (from !== to) return this.#replace(from, to, "");
        if (from > 0) { this.#replace(from - 1, from, "", this.typing); this.typing = true; }
        return;
      case "<Del>":
        if (from !== to) return this.#replace(from, to, "");
        if (to < this.value.length) this.#replace(to, to + 1, "");
        return;
      case "<Left>": this.typing = false; this.cursor = this.anchor = Math.max(0, from - (from === to ? 1 : 0)); return;
      case "<Right>": this.typing = false; this.cursor = this.anchor = Math.min(this.value.length, to + (from === to ? 1 : 0)); return;
      default: // Escape, Tab and the rest do nothing to a textarea's text.
    }
  }

  #type(from, to, text) {
    const coalesce = this.typing && from === to;
    this.#replace(from, to, text, coalesce);
    this.typing = true;
  }

  #replace(from, to, insert, coalesce = false) {
    if (!coalesce) this.undoStack.push({ value: this.value, cursor: Math.min(from, this.cursor) });
    this.redoStack = [];
    this.value = this.value.slice(0, from) + insert + this.value.slice(to);
    this.cursor = this.anchor = from + insert.length;
  }

  #step(from, to) {
    this.typing = false;
    const state = from.pop();
    if (!state) return;
    to.push({ value: this.value, cursor: this.cursor });
    this.value = state.value;
    this.cursor = this.anchor = Math.min(state.cursor, this.value.length);
  }
}

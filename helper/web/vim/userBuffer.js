// What init.js's motions, text objects, operators and commands see of a field
// (PLUTO_VIM.md, init.js): its text, the cursor, lines, searches, and (for
// operators and commands) edits. Offsets are UTF-16, as in the DOM, from the
// start of the text the field gave the engine.
//
// A range is { from, to, linewise? }, `to` exclusive. A motion or a text
// object only reads; an operator's or a command's edits go to the field, in
// order, and this buffer's text follows them.

export class UserBuffer {
  #edit;
  #move;

  /**
   * @param {string} text
   * @param {number} cursor
   * @param {{ edit?: (from: number, to: number, text: string) => Promise<void>, move?: (offset: number) => Promise<void>, mode?: string }} [options]
   */
  constructor(text, cursor, { edit = null, move = null, mode = "normal" } = {}) {
    this.text = text;
    this.cursor = cursor;
    this.mode = mode;
    /** Whether move() was called: an operator that moves the cursor keeps it there. */
    this.moved = false;
    this.#edit = edit;
    this.#move = move;
  }

  get length() {
    return this.text.length;
  }

  /** The text of a range, or of from…to. */
  slice(range, to) {
    if (typeof range === "number") return this.text.slice(range, to);
    return this.text.slice(range.from, range.to);
  }

  /** A line as a range with its text and number (from 1): line `n`, or the cursor's. */
  line(n) {
    if (n == null) return this.lineAt(this.cursor);
    let from = 0;
    for (let k = 1; k < n; k++) {
      const nl = this.text.indexOf("\n", from);
      if (nl < 0) return null;
      from = nl + 1;
    }
    return this.lineAt(from);
  }

  /** The line `offset` is on. */
  lineAt(offset) {
    const from = this.text.lastIndexOf("\n", offset - 1) + 1;
    let to = this.text.indexOf("\n", offset);
    if (to < 0) to = this.text.length;
    let number = 1;
    for (let i = this.text.indexOf("\n"); i >= 0 && i < from; i = this.text.indexOf("\n", i + 1)) number++;
    return { from, to, text: this.text.slice(from, to), number, linewise: true };
  }

  get lineCount() {
    let n = 1;
    for (let i = this.text.indexOf("\n"); i >= 0; i = this.text.indexOf("\n", i + 1)) n++;
    return n;
  }

  /**
   * The next match of `re` from `from` (the cursor), or the last one before it
   * with `backward`: { from, to, match }, or null.
   */
  search(re, { from = this.cursor, backward = false } = {}) {
    const g = globalRegExp(re);
    let found = null;
    for (const m of this.text.matchAll(g)) {
      if (m[0] === "") continue;
      if (backward) {
        if (m.index < from) found = m;
        else break;
      } else if (m.index >= from) {
        found = m;
        break;
      }
    }
    return found ? { from: found.index, to: found.index + found[0].length, match: found } : null;
  }

  /**
   * A text object's range from a pattern: the match of `re` the cursor is in,
   * else the next one on the cursor's line. With `around`, the white space
   * after it too (or before it, if there's none after), as `aw` does.
   */
  matchAround(re, around = false) {
    const line = this.lineAt(this.cursor);
    let hit = null;
    for (const m of this.text.matchAll(globalRegExp(re))) {
      if (m[0] === "") continue;
      const end = m.index + m[0].length;
      if (m.index <= this.cursor && this.cursor < end) { hit = m; break; }
      if (m.index > this.cursor) {
        if (m.index < line.to) hit = m;
        break;
      }
    }
    if (!hit) return null;
    let from = hit.index;
    let to = from + hit[0].length;
    if (around) {
      let after = to;
      while (after < line.to && /[ \t]/.test(this.text[after])) after++;
      if (after > to) to = after;
      else while (from > line.from && /[ \t]/.test(this.text[from - 1])) from--;
    }
    return { from, to, linewise: false };
  }

  /** Replaces a range with `text` in the field (operators and commands). */
  async edit(range, text) {
    if (!this.#edit) throw new Error("pluto vim: a motion or a text object can't edit");
    const { from, to } = range;
    if (!(from >= 0 && to >= from && to <= this.text.length)) throw new Error(`pluto vim: edit out of range: ${from}…${to} of ${this.text.length}`);
    await this.#edit(from, to, String(text));
    this.text = this.text.slice(0, from) + text + this.text.slice(to);
    if (this.cursor > from) this.cursor = Math.max(from, this.cursor + String(text).length - (to - from));
  }

  /** Puts the cursor at `offset` (operators and commands). */
  async move(offset) {
    if (!this.#move) throw new Error("pluto vim: a motion or a text object can't move the cursor; return where it goes");
    const at = Math.max(0, Math.min(offset, this.text.length));
    await this.#move(at);
    this.cursor = at;
    this.moved = true;
  }
}

function globalRegExp(re) {
  if (typeof re === "string") return new RegExp(re.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  return re.global ? re : new RegExp(re.source, `${re.flags}g`);
}

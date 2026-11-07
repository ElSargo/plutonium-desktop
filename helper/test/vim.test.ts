// Pluto Vim's engine (PLUTO_VIM.md), driven over a StringBuffer as a field
// would be: a key the engine doesn't take goes to the field (typeKey).
//
// Fields are written with the cursor as "|": "foo |bar" is the cursor on "b".

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import * as vimModule from "../web/vim/index.js";

const { Vim, StringBuffer, parseKeys, keyFromEvent, Registers } = vimModule as any;

type Options = { insert?: boolean; singleLine?: boolean; vim?: any; opt?: Record<string, unknown> };

function field(marked: string, { singleLine = false } = {}) {
  const cursor = marked.indexOf("|");
  assert.notEqual(cursor, -1, `no cursor in ${JSON.stringify(marked)}`);
  return new StringBuffer(marked.slice(0, cursor) + marked.slice(cursor + 1), { cursor, singleLine });
}

const mark = (buffer: any) => buffer.value.slice(0, buffer.cursor) + "|" + buffer.value.slice(buffer.cursor);

/** Types `keys` into a field: each key to the engine, and to the field when the engine leaves it. */
async function type(session: any, buffer: any, keys: string) {
  const taken: boolean[] = [];
  for (const key of parseKeys(keys)) {
    const mine = session.feed(key);
    taken.push(mine);
    await session.idle();
    if (!mine) buffer.typeKey(key);
  }
  return taken;
}

/** A field in normal mode (or insert, with `insert`), after `keys`. */
async function run(marked: string, keys: string, options: Options = {}) {
  const vim = options.vim ?? new Vim({ opt: { startInInsert: Boolean(options.insert), ...options.opt } });
  const buffer = field(marked, { singleLine: options.singleLine });
  const session = vim.attach(buffer);
  await session.idle();
  const taken = await type(session, buffer, keys);
  return { vim, buffer, session, taken, text: mark(buffer), mode: session.mode };
}

async function expectKeys(before: string, keys: string, after: string, options: Options = {}) {
  const { text } = await run(before, keys, options);
  assert.equal(text, after, `${JSON.stringify(before)} + ${keys}`);
}

describe("keys", () => {
  test("notation splits into keys, normalized", () => {
    assert.deepEqual(parseKeys("d2w<Esc>"), ["d", "2", "w", "<Esc>"]);
    assert.deepEqual(parseKeys("<c-R>a<lt><<"), ["<C-r>", "a", "<", "<", "<"]);
    assert.deepEqual(parseKeys("<Space>x<CR><S-a>"), [" ", "x", "<CR>", "A"]);
    assert.deepEqual(parseKeys("<a>"), ["<", "a", ">"]);
  });

  test("DOM key events become keys", () => {
    assert.equal(keyFromEvent({ key: "d" }), "d");
    assert.equal(keyFromEvent({ key: "D", shiftKey: true }), "D");
    assert.equal(keyFromEvent({ key: "r", ctrlKey: true }), "<C-r>");
    assert.equal(keyFromEvent({ key: "[", ctrlKey: true }), "<C-[>");
    assert.equal(keyFromEvent({ key: "Escape" }), "<Esc>");
    assert.equal(keyFromEvent({ key: "ArrowLeft", ctrlKey: true }), "<C-Left>");
    assert.equal(keyFromEvent({ key: "d", metaKey: true }), null, "Super is the desktop's");
    assert.equal(keyFromEvent({ key: "Shift", shiftKey: true }), null);
    assert.equal(keyFromEvent({ key: "a", isComposing: true }), null, "an IME's composition is never vim's");
  });
});

describe("motions", () => {
  test("h, l and counts stay on the line", async () => {
    await expectKeys("ab|cd\nef", "h", "a|bcd\nef");
    await expectKeys("ab|cd\nef", "9l", "abc|d\nef");
    await expectKeys("|abcd", "h", "|abcd");
  });

  test("words", async () => {
    await expectKeys("|foo.bar baz", "w", "foo|.bar baz");
    await expectKeys("|foo.bar baz", "W", "foo.bar |baz");
    await expectKeys("|foo bar baz", "2w", "foo bar |baz");
    await expectKeys("|foo bar", "e", "fo|o bar");
    await expectKeys("foo bar|", "b", "foo |bar");
    await expectKeys("foo b|ar", "b", "foo |bar");
    await expectKeys("foo b|ar", "ge", "fo|o bar");
    await expectKeys("|foo\n\nbar", "w", "foo\n|\nbar", {}); // an empty line is a word
  });

  test("line motions", async () => {
    await expectKeys("  fo|o", "0", "|  foo");
    await expectKeys("  fo|o", "^", "  |foo");
    await expectKeys("|foo\nbar", "$", "fo|o\nbar");
    await expectKeys("|a\nb\nc", "G", "a\nb\n|c");
    await expectKeys("a\nb\n|c", "gg", "|a\nb\nc");
    await expectKeys("|a\nb\nc", "2G", "a\n|b\nc");
  });

  test("j and k keep the column they want", async () => {
    await expectKeys("abc|d\nx\nabcd", "jj", "abcd\nx\nabc|d");
    await expectKeys("|abcd\nx", "$jk", "abc|d\nx");
    await expectKeys("|a", "j", "|a");
  });

  test("f, t and repeats", async () => {
    await expectKeys("|a,b,c,d", "f,", "a|,b,c,d");
    await expectKeys("|a,b,c,d", "2f,", "a,b|,c,d");
    await expectKeys("|a,b,c,d", "f,;;", "a,b,c|,d");
    await expectKeys("|a,b,c,d", "t,;", "a,|b,c,d");
    await expectKeys("a,b,c,|d", "F,", "a,b,c|,d");
    await expectKeys("|a,b,c,d", "f,;,", "a|,b,c,d");
    await expectKeys("|abc", "fz", "|abc");
  });

  test("paragraphs and brackets", async () => {
    await expectKeys("|a\nb\n\nc", "}", "a\nb\n|\nc");
    await expectKeys("a\n\nb\n|c", "{", "a\n|\nb\nc");
    await expectKeys("f|(a(b)c)", "%", "f(a(b)c|)");
    await expectKeys("|x = [1]", "%", "x = [1|]");
  });
});

describe("operators", () => {
  test("d with motions", async () => {
    await expectKeys("|foo bar", "dw", "|bar");
    await expectKeys("foo |bar\nbaz", "dw", "foo| \nbaz"); // w stops at the line's end
    await expectKeys("|foo bar baz", "d2w", "|baz");
    await expectKeys("|foo bar baz", "2dw", "|baz");
    await expectKeys("fo|o bar", "d$", "f|o");
    await expectKeys("foo b|ar", "d0", "|ar");
    await expectKeys("|a,b,c", "dt,", "|,b,c");
    await expectKeys("|a,b,c", "df,", "|b,c");
    await expectKeys("|abc", "dfz", "|abc");
  });

  test("dd, dj and counts are linewise", async () => {
    await expectKeys("a\n|b\nc", "dd", "a\n|c");
    await expectKeys("a\nb\n|c", "dd", "a\n|b");
    await expectKeys("|a\nb\nc", "2dd", "|c");
    await expectKeys("|a\nb\nc", "dj", "|c");
    await expectKeys("a\nb\n|c", "dk", "|a");
    await expectKeys("|  a\nb", "d}", "|");
  });

  test("x, X, D", async () => {
    await expectKeys("a|bc", "x", "a|c");
    await expectKeys("ab|c", "x", "a|b");
    await expectKeys("a|bcd", "2x", "a|d");
    await expectKeys("ab|c", "X", "a|c");
    await expectKeys("a|bc", "D", "|a");
    await expectKeys("|\nb", "x", "|\nb");
  });

  test("c enters insert mode, and cw is ce", async () => {
    const r = await run("|foo bar", "cwbaz<Esc>");
    assert.equal(r.text, "ba|z bar");
    assert.equal(r.mode, "normal");
    await expectKeys("foo b|ar", "ciwx<Esc>", "foo |x");
    await expectKeys("a|bc\nd", "ccx<Esc>", "|x\nd");
    await expectKeys("a|bc", "Cx<Esc>", "a|x");
    await expectKeys("a|bc", "sx<Esc>", "a|xc");
    await expectKeys("|a\nb", "Sx<Esc>", "|x\nb");
  });

  test("c with a motion that fails stays in normal mode", async () => {
    const r = await run("|abc", "cfz");
    assert.equal(r.mode, "normal");
    assert.equal(r.text, "|abc");
  });

  test("y and p", async () => {
    await expectKeys("|foo bar", "ywP", "foo| foo bar");
    await expectKeys("|foo bar", "yw$p", "foo barfoo| ");
    await expectKeys("|a\nb", "yyp", "a\n|a\nb");
    await expectKeys("a\n|b", "yyP", "a\n|b\nb");
    await expectKeys("|a\nb", "ddp", "b\n|a");
    await expectKeys("|ab", "xp", "b|a");
    await expectKeys("|ab", "yl3p", "aaa|ab");
  });

  test("> and < shift lines", async () => {
    await expectKeys("|a\nb", ">>", "  |a\nb");
    await expectKeys("|a\nb", ">j", "  |a\n  b");
    await expectKeys("    |a", "<<", "  |a");
  });

  test("g~, gu and gU", async () => {
    await expectKeys("|foo bar", "gUiw", "|FOO bar");
    await expectKeys("|FOO bar", "guu", "|foo bar");
    await expectKeys("|Foo", "g~~", "|fOO");
    await expectKeys("|ab", "~", "A|b");
  });
});

describe("text objects", () => {
  test("words", async () => {
    await expectKeys("foo b|ar baz", "diw", "foo | baz");
    await expectKeys("foo b|ar baz", "daw", "foo |baz");
    await expectKeys("foo b|ar", "daw", "fo|o");
    await expectKeys("a b.|c d", "diW", "a | d");
  });

  test("quotes", async () => {
    await expectKeys('x = "a|b c" + 1', 'di"', 'x = "|" + 1');
    await expectKeys('x = "a|b c" + 1', 'da"', "x = |+ 1");
    await expectKeys('|x = "ab"', 'ci"z<Esc>', 'x = "|z"');
    await expectKeys("say 'n|o'", "di'", "say '|'");
  });

  test("brackets and tags", async () => {
    await expectKeys("f(a, (|b), c)", "dib", "f(a, (|), c)");
    await expectKeys("f(a, (|b), c)", "d2i(", "f(|)");
    await expectKeys("f(a, (|b), c)", "da(", "f(a, |, c)");
    await expectKeys("if {\n  |a\n  b\n}", "di{", "if {\n|}");
    await expectKeys("<p>he<b>l|l</b>o</p>", "dit", "<p>he<b>|</b>o</p>");
    await expectKeys("<p>he<b>l|l</b>o</p>", "d2it", "<p>|</p>");
    await expectKeys("<p>he<b>l|l</b>o</p>", "dat", "<p>he|o</p>");
  });

  test("paragraphs", async () => {
    await expectKeys("a\n|b\n\nc", "dip", "|\nc");
    await expectKeys("a\n|b\n\nc", "dap", "|c");
  });
});

describe("visual mode", () => {
  test("v selects characters, and operators act on them", async () => {
    const r = await run("|foo bar", "vll");
    assert.equal(r.mode, "visual");
    assert.equal(r.buffer.selection(), "foo");
    await expectKeys("|foo bar", "vlld", "| bar");
    await expectKeys("foo |bar", "vhhy$p", "foo baro |b");
    await expectKeys("|foo bar", "veU", "|FOO bar");
  });

  test("V selects lines", async () => {
    const r = await run("|a\nb\nc", "Vj");
    assert.equal(r.buffer.selection(), "a\nb");
    await expectKeys("|a\nb\nc", "Vjd", "|c");
    await expectKeys("|a\nb", "Vj>", "  |a\n  b");
  });

  test("text objects in visual mode", async () => {
    const r = await run("foo b|ar baz", "viw");
    assert.equal(r.buffer.selection(), "bar");
    const p = await run("a\n|b\n\nc", "vip");
    assert.equal(p.mode, "vline");
    assert.equal(p.buffer.selection(), "a\nb");
  });

  test("o swaps the ends, Escape leaves", async () => {
    const r = await run("a|bcd", "vlloh<Esc>");
    assert.equal(r.mode, "normal");
    assert.equal(r.text, "|abcd");
  });

  test("p replaces the selection, and the replaced text is in the unnamed register", async () => {
    await expectKeys("|foo bar", "yiwwviwp0P", "ba|rfoo foo");
  });

  test("c changes the selection", async () => {
    await expectKeys("|foo bar", "vecx<Esc>", "|x bar");
  });
});

describe("insert mode", () => {
  test("i, a, I, A, o, O", async () => {
    await expectKeys("a|b", "ix<Esc>", "a|xb");
    await expectKeys("a|b", "ax<Esc>", "ab|x");
    await expectKeys("  a|b", "Ix<Esc>", "  |xab");
    await expectKeys("a|b", "Ax<Esc>", "ab|x");
    await expectKeys("a|b\nc", "ox<Esc>", "ab\n|x\nc");
    await expectKeys("a\n|b", "Ox<Esc>", "a\n|x\nb");
  });

  test("a count repeats what was inserted", async () => {
    await expectKeys("|", "3ix<Esc>", "xx|x");
    await expectKeys("|a", "2ox<Esc>", "a\nx\n|x");
  });

  test("fields start in insert mode, and typing is the field's", async () => {
    const r = await run("|", "hello", { insert: true });
    assert.deepEqual(r.taken, [false, false, false, false, false]);
    assert.equal(r.text, "hello|");
    assert.equal(r.buffer.caret, "bar");
    const n = await run("|", "hi<Esc>", { insert: true });
    assert.equal(n.text, "h|i");
    assert.equal(n.mode, "normal");
    assert.equal(n.buffer.caret, "block");
  });

  test("Escape in normal mode is the page's", async () => {
    const r = await run("|a", "<Esc>");
    assert.deepEqual(r.taken, [false]);
  });

  test("Ctrl+R puts a register", async () => {
    await expectKeys("|foo ", "yiwA<C-r>\"<Esc>", "foo fo|o");
    await expectKeys("|foo ", "\"ayiwA<C-r>a!<Esc>", "foo foo|!");
  });

  test("Ctrl+O runs one normal command", async () => {
    const r = await run("ab|", "<C-o>0x", { insert: true });
    assert.equal(r.mode, "insert");
    assert.equal(r.text, "x|ab");
  });

  test("Ctrl+W and Ctrl+U", async () => {
    await expectKeys("foo bar|", "<C-w><Esc>", "foo| ", { insert: true });
    await expectKeys("  foo bar|", "<C-u><Esc>", " | ", { insert: true });
  });

  test("Ctrl+[ leaves insert mode, as Escape does", async () => {
    const r = await run("ab|", "<C-[>", { insert: true });
    assert.equal(r.mode, "normal");
  });

  test("other keys with Ctrl go to the field", async () => {
    const r = await run("|a", "<C-a><Tab>");
    assert.deepEqual(r.taken, [false, false]);
  });
});

describe("single-line inputs", () => {
  test("manual: insert mode, Escape is the page's, Ctrl+[ enters normal mode", async () => {
    const r = await run("ab|", "<Esc>", { singleLine: true, opt: { startInInsert: false } });
    assert.equal(r.mode, "insert");
    assert.deepEqual(r.taken, [false]);
    const n = await run("ab c|", "<C-[>D", { singleLine: true });
    assert.equal(n.text, "ab| ");
    assert.equal(n.mode, "normal");
  });

  test("Enter submits from normal mode", async () => {
    const r = await run("ab|", "<C-[><CR>", { singleLine: true });
    assert.deepEqual(r.taken, [true, false]);
    assert.deepEqual(r.buffer.submitted, ["ab"]);
  });

  test("insert mode extras work there too", async () => {
    const vim = new Vim();
    await vim.registers.yank("a", { text: "x", linewise: false });
    await expectKeys("|", "<C-r>a", "x|", { singleLine: true, vim });
  });

  test("off: Pluto Vim stays out", async () => {
    const r = await run("ab|", "<C-[>x", { singleLine: true, opt: { inputs: "off" } });
    assert.deepEqual(r.taken, [false, false]);
    assert.equal(r.text, "abx|");
  });

  test("o and O don't make lines in a single-line field", async () => {
    await expectKeys("a|b", "<C-[>ox<Esc>", "ab|x", { singleLine: true, opt: { inputs: "on" } });
  });
});

describe("replace", () => {
  test("r replaces characters", async () => {
    await expectKeys("|abc", "rx", "|xbc");
    await expectKeys("|abc", "2rx", "x|xc");
    await expectKeys("|abc", "4rx", "|abc");
    await expectKeys("a|bc", "r<CR>", "a\n|c");
  });

  test("R overwrites, Backspace restores", async () => {
    await expectKeys("|abcd", "Rxy<Esc>", "x|ycd");
    await expectKeys("|abcd", "Rxyz<BS><Esc>", "x|ycd");
    await expectKeys("|ab", "Rxyz<Esc>", "xy|z");
  });

  test("J joins lines", async () => {
    await expectKeys("|a\n  b\nc", "J", "a| b\nc");
    await expectKeys("|a\nb\nc", "3J", "a b| c");
    await expectKeys("|a\n)", "J", "a|)");
  });
});

describe("repeat and undo", () => {
  test(". repeats the last change", async () => {
    await expectKeys("|a b c d", "dw.", "|c d");
    await expectKeys("|a b c d", "dw2.", "|d");
    await expectKeys("|a\nb\nc", "ddj.", "|b");
    await expectKeys("|foo foo", "cwbar<Esc>w.", "bar ba|r");
    await expectKeys("|a\nb", "Ax<Esc>j.", "ax\nb|x");
    await expectKeys("|a\nb", "ox<Esc>.", "a\nx\n|x\nb");
    await expectKeys("|abcd", "Rxy<Esc>l.", "xyx|y");
    await expectKeys("|a b c", "x.", "|b c");
    await expectKeys("|abcdefg", "vlld.", "|g");
  });

  test("u undoes a whole change, Ctrl+R redoes it", async () => {
    await expectKeys("|foo bar", "cwbaz<Esc>u", "|foo bar");
    await expectKeys("|foo bar", "cwbaz<Esc>u<C-r>", "ba|z bar");
    await expectKeys("|a b c", "dwdwuu", "|a b c");
    await expectKeys("|a", "3ix<Esc>u", "|a");
  });

  test("insert typed at focus is one change", async () => {
    await expectKeys("|", "hello<Esc>u", "|", { insert: true });
  });
});

describe("registers", () => {
  test("yanks go to \"0, deletes to \"1…\"9 or \"-", async () => {
    const { vim } = await run("|a\nb\nc d", "yyjddw\"_dd");
    const get = async (name: string) => (await vim.registers.get(name))?.text;
    assert.equal(await get("0"), "a");
    assert.equal(await get("1"), "b");
    assert.equal(await get('"'), "b");
    const r = await run("|foo bar", "dw");
    assert.equal((await r.vim.registers.get("-")).text, "foo ");
  });

  test("named registers, and capitals append", async () => {
    const { vim } = await run("|foo bar", '"ayiww"Ayiw');
    assert.equal((await vim.registers.get("a")).text, "foobar");
    await expectKeys("|foo bar", '"byiww"bp', "foo bfo|oar");
  });

  test("the black hole keeps the unnamed register", async () => {
    await expectKeys("|foo bar", 'yiww"_diwP', "foofo|o ");
  });

  test("unnamedplus: the unnamed register is the clipboard", async () => {
    const vim = new Vim({ opt: { clipboard: "unnamedplus", startInInsert: false } });
    await run("|foo", "yiw", { vim });
    assert.equal((await vim.registers.get("+")).text, "foo");
    await vim.registers.yank("+", { text: "clip", linewise: false });
    await expectKeys("|x", "P", "cli|px", { vim });
  });

  test("registers are shared between fields", async () => {
    const vim = new Vim({ opt: { startInInsert: false } });
    await run("|first", "yiw", { vim });
    await expectKeys("|", "p", "firs|t", { vim });
  });

  test("a store may be asynchronous", async () => {
    const values = new Map();
    const store = {
      get: async (name: string) => { await new Promise((r) => setTimeout(r, 1)); return values.get(name) ?? null; },
      set: async (name: string, value: unknown) => { await new Promise((r) => setTimeout(r, 1)); values.set(name, value); },
    };
    const vim = new Vim({ opt: { startInInsert: false }, registers: new Registers({ store }) });
    await expectKeys("|ab", "ylp", "a|ab", { vim });
  });
});

describe("events and the caret", () => {
  test("ModeChanged, and the caret follows the mode", async () => {
    const vim = new Vim({ opt: { startInInsert: false } });
    const seen: string[] = [];
    vim.on("ModeChanged", ({ from, to }: any) => seen.push(`${from}>${to}`));
    const buffer = field("|ab");
    const session = vim.attach(buffer);
    session.feed("d");
    assert.equal(buffer.caret, "underline", "an operator waiting for its motion");
    session.feed("<Esc>");
    assert.equal(buffer.caret, "block");
    session.feedKeys("i");
    assert.equal(buffer.caret, "bar");
    session.feed("<Esc>");
    session.feed("v");
    await session.idle();
    assert.deepEqual(seen, ["normal>insert", "insert>normal", "normal>visual"]);
  });

  test("the decision to take a key doesn't wait for the field", async () => {
    // A field whose every call is slow, as text-input-v3's are: keys are still decided at once, and run in order.
    const inner = field("|foo bar");
    const slow = new Proxy(inner, {
      get(target, prop) {
        const value = (target as any)[prop];
        if (typeof value !== "function" || !["move", "edit", "undo", "redo"].includes(prop as string)) {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (...args: unknown[]) => { await new Promise((r) => setTimeout(r, 2)); return value.apply(target, args); };
      },
    });
    const session = new Vim({ opt: { startInInsert: false } }).attach(slow);
    const taken = session.feedKeys("dwwx");
    assert.deepEqual(taken, [true, true, true, true]);
    await session.idle();
    assert.equal(mark(inner), "b|a");
  });
});

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
    assert.equal(keyFromEvent({ key: "Escape", code: "Escape" }), "<Esc>");
    assert.equal(keyFromEvent({ key: "Escape", code: "CapsLock" }), "<C-[>", "Caps Lock is Ctrl+[");
    assert.equal(keyFromEvent({ key: "Escape", code: "CapsLock", shiftKey: true }), "<C-[>");
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
    await expectKeys("a|bc", "clx<Esc>", "a|xc");
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

  test("> and < shift lines, with shift = indent", async () => {
    const opt = { shift: "indent" };
    await expectKeys("|a\nb", ">>", "  |a\nb", { opt });
    await expectKeys("|a\nb", ">j", "  |a\n  b", { opt });
    await expectKeys("    |a", "<<", "  |a", { opt });
  });

  test("> and < quote Markdown by default", async () => {
    await expectKeys("|a\nb", ">>", "> |a\nb");
    await expectKeys("|a\n\nb", ">ip", "> |a\n\nb");
    await expectKeys("|a\n\nb", ">G", "> |a\n>\n> b");
    await expectKeys("|> a", ">>", "> > |a");
    await expectKeys("|> > a", "<<", "> |a");
    await expectKeys("|a", "<<", "|a");
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
    await expectKeys("|a\nb", "Vj>", "> |a\n> b");
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

describe("the register store", () => {
  const { RemoteStore, MemoryStore } = vimModule as any;

  test("each call carries its register's scope; \"+ is always global", async () => {
    const calls: string[] = [];
    const store = {
      values: new Map<string, unknown>(),
      get(name: string, scope: string) { calls.push(`get ${name} ${scope}`); return this.values.get(`${scope}:${name}`) ?? null; },
      set(name: string, value: unknown, scope: string) { calls.push(`set ${name} ${scope}`); this.values.set(`${scope}:${name}`, value); },
    };
    const vim = new Vim({ store, opt: { startInInsert: false } });
    vim.registerScopes.set("t", "thread");
    vim.registerScopes.set("0", "thread");
    const buffer = field("|foo bar");
    const session = vim.attach(buffer);
    await type(session, buffer, '"tyiwyiw"+yiw');
    assert.deepEqual(calls, ["set t thread", 'set " global', "set 0 thread", 'set " global', "set + global", 'set " global']);
  });

  test("RemoteStore asks the binding and takes its reply; without one, or with no answer, it keeps them itself", async () => {
    const world: any = {};
    const sent: any[] = [];
    world.plutoVimStore = (json: string) => {
      const message = JSON.parse(json);
      sent.push(message);
      setTimeout(() => world.plutoVimStoreReply(message.id, message.op === "get" ? { text: "far", linewise: false } : null), 1);
    };
    const store = new RemoteStore({ global: world, timeoutMs: 50 });
    await store.set("a", { text: "x", linewise: false }, "thread");
    assert.deepEqual(await store.get("a", "thread"), { text: "far", linewise: false });
    assert.deepEqual(sent.map(({ id: _, ...m }) => m), [
      { op: "set", name: "a", scope: "thread", value: { text: "x", linewise: false } },
      { op: "get", name: "a", scope: "thread" },
    ]);
    world.plutoVimStore = () => {}; // never answers
    assert.deepEqual(await store.get("a", "thread"), { text: "x", linewise: false }, "this world's own copy, after the timeout");
    delete world.plutoVimStore;
    store.set("b", { text: "y", linewise: true });
    assert.deepEqual(await store.get("b"), { text: "y", linewise: true });
    assert.ok(new MemoryStore());
  });
});

describe("the primary selection register", () => {
  test('"* is a register of its own, not "+', async () => {
    const { vim } = await run("|ab cd", '"*yiww"+yiw');
    assert.equal((await vim.registers.get("*")).text, "ab");
    assert.equal((await vim.registers.get("+")).text, "cd");
  });
});

describe("the expression register", () => {
  test('"= evaluates JavaScript into a register to put', async () => {
    await expectKeys("|ab", '"=1+2<CR>p', "a|3b");
    await expectKeys("|ab", '"=["x","y"]<CR>p', "ab\n|x\ny");
    await expectKeys("|ab", "i<C-r>='hi'.toUpperCase()<CR>!<Esc>", "HI|!ab");
  });

  test("Escape or deleting it all cancels; mappings don't apply while it's typed; an error puts nothing", async () => {
    await expectKeys("|ab", '"=1<Esc>x', "|b");
    await expectKeys("|ab", '"=1<BS><BS>x', "|b");
    const vim = new Vim({ opt: { startInInsert: false } });
    vim.keymaps.n.set("1", { lhs: ["1"], rhs: "x", opts: {} });
    assert.equal((await run("|ab", '"=1<CR>p', { vim })).text, "a|1b", "1 is mapped, but not in an expression");
    const errors: Error[] = [];
    vim.on("error", (error: Error) => errors.push(error));
    const { text } = await run("|ab", '"=nope(<CR>p', { vim });
    assert.equal(text, "|ab");
    assert.match(errors[0]!.message, /"=nope\(/);
  });

  test("CmdlineChanged shows it as it's typed", async () => {
    const vim = new Vim({ opt: { startInInsert: false } });
    const seen: (string | null)[] = [];
    vim.on("CmdlineChanged", ({ cmdline }: { cmdline: string | null }) => seen.push(cmdline));
    await run("|ab", '"=1<CR>', { vim });
    assert.deepEqual(seen, ["=", "=1", null]);
  });
});

describe("search", () => {
  test("/ and ? with n and N, round the end; * and #; d/ as a motion", async () => {
    await expectKeys("|ab x ab y ab", "/ab<CR>", "ab x |ab y ab");
    await expectKeys("|ab x ab y ab", "/ab<CR>nn", "|ab x ab y ab", ); // round to the first
    await expectKeys("ab x ab y |ab", "?ab<CR>", "ab x |ab y ab");
    await expectKeys("|ab x ab y ab", "/ab<CR>N", "|ab x ab y ab");
    await expectKeys("|foo bar foo", "*", "foo bar |foo");
    await expectKeys("|one two three", "d/thr<CR>", "|three");
    await expectKeys("|a1 b22 c333", "/\\d{2}<CR>", "a1 b|22 c333");
  });
});

describe("the : line", () => {
  test(":s on the line, :%s with flags and groups, & and \\1", async () => {
    await expectKeys("|a a\na a", ":s/a/b/<CR>", "|b a\na a");
    await expectKeys("|a a\na a", ":%s/a/b/g<CR>", "b b\n|b b");
    await expectKeys("|John Smith", ":s/(\\w+) (\\w+)/\\2, \\1/<CR>", "|Smith, John");
    await expectKeys("|cat", ":s/cat/[&]/<CR>", "|[cat]");
  });

  test("a range from visual mode, :n, :g and :v", async () => {
    await expectKeys("|a\na\na", "Vj:s/a/b/<CR>", "b\n|b\na");
    await expectKeys("|one\ntwo\nthree", ":3<CR>", "one\ntwo\n|three");
    await expectKeys("|x1\ny\nx2", ":g/x/d<CR>", "|y");
    await expectKeys("|x1\ny\nx2", ":v/x/d<CR>", "|x1\nx2");
  });

  test("u undoes a whole :s; @: repeats the last : command", async () => {
    await expectKeys("|a a a", ":s/a/b/<CR>u", "|a a a");
    await expectKeys("|a a a", ":s/a/b/<CR>@:", "|b b a");
  });

  test("the line is drawn as it's typed; :registers is a message", async () => {
    const vim = new Vim({ opt: { startInInsert: false } });
    const seen: (string | null)[] = [];
    const messages: string[] = [];
    vim.on("CmdlineChanged", ({ cmdline }: any) => seen.push(cmdline));
    vim.on("Message", ({ text }: any) => messages.push(text));
    await run("|word", "yiw:reg<CR>", { vim });
    assert.deepEqual(seen, [":", ":r", ":re", ":reg", null]);
    assert.match(messages[0]!, /"0  word/);
  });
});

describe("macros", () => {
  test("q records, @ plays, with a count; @@ again", async () => {
    await expectKeys("|a\nb\nc\nd", "qaA!<Esc>jq2@a", "a!\nb!\nc!\n|d");
    await expectKeys("|a\nb\nc", "qqI-<Esc>jq@q@@", "-a\n-b\n|-c");
  });

  test("a macro is a register of keys: \"ap puts it, and a capital appends", async () => {
    const { vim } = await run("|x", "qaix<Esc>qqAa<Esc>q");
    assert.equal((await vim.registers.get("a")).text, "ix<Esc>a<Esc>");
    assert.equal((await vim.registers.get('"')), null, "recording leaves the unnamed register alone");
  });
});

describe("marks and jumps", () => {
  test("m and ' and `; marks move with edits", async () => {
    await expectKeys("ab\ncd |ef", "mxgg`x", "ab\ncd |ef");
    await expectKeys("ab\ncd |ef", "mxgg'x", "ab\n|cd ef");
    await expectKeys("ab\ncd |ef", "mxggiZZ<Esc>`x", "ZZab\ncd |ef");
  });

  test("Ctrl+O and Ctrl+I go back and forth over jumps; '' to the last", async () => {
    await expectKeys("|a\nb\nc", "G<C-o>", "|a\nb\nc");
    await expectKeys("|a\nb\nc", "G<C-o><C-i>", "a\nb\n|c");
    await expectKeys("a\n|b\nc", "G''", "a\n|b\nc");
  });

  test("an uppercase mark in another field: the host's (MarkJump)", async () => {
    const vim = new Vim({ opt: { startInInsert: false } });
    const jumps: string[] = [];
    vim.on("MarkJump", ({ name }: any) => jumps.push(name));
    const a = field("|one");
    const sa = vim.attach(a);
    await type(sa, a, "lmA");
    const b = field("|two");
    const sb = vim.attach(b);
    await type(sb, b, "`A");
    assert.deepEqual(jumps, ["A"]);
    await type(sa, a, "0`A");
    assert.equal(mark(a), "o|ne", "in its own field it's found here");
  });
});

// HYDRA_KEYBOARD.md, "The base map".
describe("the base map", () => {
  test("dropped keys do nothing, and Space and Backspace are l and h without a page", async () => {
    await expectKeys("a|bc", "S", "a|bc");
    await expectKeys("a|bc", "H", "a|bc");
    await expectKeys("a|bc", "L", "a|bc");
    await expectKeys("|abc", " ", "a|bc");
    await expectKeys("ab|c", "<BS>", "a|bc");
    await expectKeys("|abc", "2 ", "ab|c");
    await expectKeys("|a\n  b", "+", "|a\n  b");
  });

  test("Tab is the page's without one", async () => {
    const r = await run("|abc", "<Tab>");
    assert.deepEqual(r.taken, [false]);
  });

  test("U redoes", async () => {
    await expectKeys("|abc", "xuU", "|bc");
  });

  test("sentences: ( and )", async () => {
    await expectKeys("|One. Two! Three?", ")", "One. |Two! Three?");
    await expectKeys("|One. Two! Three?", "2)", "One. Two! |Three?");
    await expectKeys("One. Two! Th|ree?", "(", "One. Two! |Three?");
    await expectKeys("One. Two! |Three?", "(", "One. |Two! Three?");
    await expectKeys("|a b.\n\nc d", ")", "a b.\n|\nc d");
    await expectKeys("|One (two.) Three", ")", "One (two.) |Three");
    await expectKeys("|One. Two", "d)", "|Two");
  });

  test("Markdown: headings, list items, code blocks", async () => {
    const doc = "|# A\ntext\n## B\n- x\n- y\n```\n# not\n```\n# C";
    await expectKeys(doc, "]h", "# A\ntext\n|## B\n- x\n- y\n```\n# not\n```\n# C");
    await expectKeys(doc, "2]h", "# A\ntext\n## B\n- x\n- y\n```\n# not\n```\n|# C");
    await expectKeys(doc, "]l]l", "# A\ntext\n## B\n- x\n|- y\n```\n# not\n```\n# C");
    await expectKeys(doc, "]c", "# A\ntext\n## B\n- x\n- y\n|```\n# not\n```\n# C");
    await expectKeys("# A\nt|ext", "[h", "|# A\ntext");
  });

  test("text objects: code blocks, list items, sections, URLs", async () => {
    await expectKeys("a\n```js\nx|\ny\n```\nb", "dic", "a\n```js\n|```\nb");
    await expectKeys("a\n```js\nx|\ny\n```\nb", "dac", "a\n|b");
    await expectKeys("- one\n- t|wo\n  more\n- three", "dal", "- one\n|- three");
    await expectKeys("- one\n- t|wo\n- three", "cilX<Esc>", "- one\n- |X\n- three");
    await expectKeys("# A\na|\n\n# B\nb", "dih", "# A\n|\n# B\nb");
    await expectKeys("# A\na|\n## A1\nx\n# B\nb", "dah", "|# B\nb");
    await expectKeys("see https://x.io/a(b)|c. ok", "diu", "see |. ok");
    await expectKeys("see https://x.|io/p, ok", "diu", "see |, ok");
    await expectKeys("(see https://x.|io/p) ok", "yiuP", "(see https://x.io/|phttps://x.io/p) ok");
  });

  test("surround: ds, cs, ys, and s in visual mode", async () => {
    await expectKeys('say "h|i" now', 'ds"', "say |hi now");
    await expectKeys("f(a, |b)", "ds(", "f|a, b");
    await expectKeys("f(a, |b)", "dsb", "f|a, b");
    await expectKeys('say "h|i"', "cs\"'", "say |'hi'");
    await expectKeys("x [|a] y", "cs[(", "x |(a) y");
    await expectKeys("a w|ord b", "ysiw*", "a |*word* b");
    await expectKeys("a w|ord b", "ysiw)", "a |(word) b");
    await expectKeys("|one two", "yse`", "|`one` two");
    await expectKeys("a |bc d", "vls_", "a |_bc_ d");
    const r = await run("a w|ord b", "ysiw*");
    assert.equal(r.mode, "normal");
    await expectKeys("|a b", "ysiw\"W.", '"a" |"b"');
  });

  test("gi goes back to where insert mode ended; gA appends at the end", async () => {
    await expectKeys("|abc\ndef", "lix<Esc>jgiy<Esc>", "ax|ybc\ndef");
    await expectKeys("a|bc\ndef", "gA!<Esc>", "abc\ndef|!");
  });

  test("s: a labeled jump, nearest first, and Enter goes to the nearest", async () => {
    const vim = new Vim({ opt: { startInInsert: false } });
    const seen: any[] = [];
    vim.on("JumpLabels", ({ query, targets }: any) => seen.push({ query, targets }));
    const buffer = field("|one two one three one");
    const session = vim.attach(buffer);
    await session.idle();
    await type(session, buffer, "so");
    const shown = seen.at(-1);
    assert.equal(shown.query, "o");
    // "o" in one, two, one, one: the cursor's own match isn't a target; nearest first.
    assert.deepEqual(shown.targets.map((t: any) => t.offset), [6, 8, 18]);
    // Labels never use a character that would continue a match ("n" after "o" in one, and " " after "two").
    assert.ok(shown.targets.every((t: any) => t.label && t.label !== "n"));
    const label = shown.targets.find((t: any) => t.offset === 8).label;
    await type(session, buffer, label);
    assert.equal(mark(buffer), "one two |one three one");
    assert.equal(seen.at(-1).targets, null);
    assert.equal(session.mode, "normal");
    await type(session, buffer, "<C-o>");
    assert.equal(mark(buffer), "|one two one three one", "a jump is in the jump list");
  });

  test("s: more characters narrow it; Enter takes the nearest; Escape and no match cancel", async () => {
    await expectKeys("|ab ac ad ac", "sac<CR>", "ab |ac ad ac");
    await expectKeys("|ab ac ad", "sa<Esc>x", "|b ac ad");
    await expectKeys("|ab ac", "szx", "|b ac");
    await expectKeys("|ab AB", "sA<CR>", "ab |AB");
  });
});

describe("pages fill keys", () => {
  function pageField(marked: string, actions: string[]) {
    const buffer = field(marked);
    const ran: any[] = [];
    buffer.field = {
      ...buffer.field,
      actions: () => new Set(actions),
      action: (name: string, detail: any) => ran.push({ name, ...detail }),
    };
    return { buffer, ran };
  }

  test("a page's action runs with its count and the text under the cursor", async () => {
    const vim = new Vim({ opt: { startInInsert: false } });
    const { buffer, ran } = pageField("see https://x.io/|a now", ["context.pageDown", "open", "place.terminal", "item.recent"]);
    const session = vim.attach(buffer);
    await session.idle();
    const taken = await type(session, buffer, " 3 gxgt<Tab>");
    assert.deepEqual(ran, [
      { name: "context.pageDown", count: null },
      { name: "context.pageDown", count: 3 },
      { name: "open", count: null, text: "https://x.io/a" },
      { name: "place.terminal", count: null },
      { name: "item.recent", count: null },
    ]);
    assert.ok(taken.every(Boolean));
    assert.equal(mark(buffer), "see https://x.io/|a now", "the cursor didn't move");
  });

  test("keys a page doesn't fill: g and z keys do nothing", async () => {
    await expectKeys("a|bc", "gtzaZ", "a|bc");
  });
});

// HYDRA_KEYBOARD.md: what came of trying the first version.
describe("normal mode by default, read-only fields, gw, pages' modes and relayed keys", () => {
  test("fields start in normal mode by default; single-line inputs in insert mode", async () => {
    const vim = new Vim();
    const a = vim.attach(field("|abc"));
    const b = vim.attach(field("|abc", { singleLine: true }));
    await a.idle();
    assert.equal(a.mode, "normal");
    assert.equal(b.mode, "insert");
  });

  test("gw: labels every word of the field, and as an operator's motion takes the word it lands on", async () => {
    const vim = new Vim({ opt: { startInInsert: false } });
    const seen: any[] = [];
    vim.on("JumpLabels", ({ targets }: any) => seen.push(targets));
    const buffer = field("|one two three four");
    const session = vim.attach(buffer);
    await session.idle();
    await type(session, buffer, "ygw");
    const targets = seen.at(-1);
    assert.deepEqual(targets.map((t: any) => t.offset), [4, 8, 14]);
    const three = targets.find((t: any) => t.offset === 8).label;
    await type(session, buffer, three);
    assert.equal(seen.at(-1), null);
    await type(session, buffer, "$p");
    assert.equal(mark(buffer), "one two three fourone two thre|e");
    // Alone it moves; in visual mode it extends.
    await type(session, buffer, "0gw");
    await type(session, buffer, seen.at(-1).find((t: any) => t.offset === 4).label);
    assert.equal(buffer.cursor, 4);
  });

  test("gw alone is the page's jump.word where it has one", async () => {
    const vim = new Vim({ opt: { startInInsert: false } });
    const buffer = field("|a b");
    const ran: string[] = [];
    buffer.field = { ...buffer.field, actions: () => new Set(["jump.word"]), action: (name: string) => ran.push(name) };
    const session = vim.attach(buffer);
    await session.idle();
    await type(session, buffer, "gw");
    assert.deepEqual(ran, ["jump.word"]);
  });

  test("a read-only field: motions, visual mode and yanks; changes do nothing; i is the page's insert", async () => {
    const vim = new Vim({ opt: { startInInsert: true } });
    const buffer = field("one |two three");
    buffer.caps = { ...buffer.caps, readonly: true };
    const ran: string[] = [];
    buffer.field = { ...buffer.field, actions: () => new Set(["insert"]), action: (name: string) => ran.push(name) };
    const session = vim.attach(buffer);
    await session.idle();
    assert.equal(session.mode, "normal", "never insert mode");
    await type(session, buffer, "dwxcw");
    assert.equal(buffer.value, "one two three");
    assert.equal(session.mode, "normal");
    await type(session, buffer, "yiw");
    assert.equal((await vim.registers.get('"')).text, "two");
    await type(session, buffer, "i");
    assert.deepEqual(ran, ["insert", "insert"], "cw and i ask the page");
  });

  test("a page sets the mode (enterMode)", async () => {
    const vim = new Vim({ opt: { startInInsert: true } });
    const buffer = field("ab|");
    const session = vim.attach(buffer);
    await session.idle();
    session.enterMode("normal");
    await session.idle();
    assert.equal(session.mode, "normal");
    session.enterMode("insert");
    await session.idle();
    assert.equal(session.mode, "insert");
  });

  test("a place or a show the field's page doesn't have is relayed (PageKey); a slot it doesn't fill isn't", async () => {
    const vim = new Vim({ opt: { startInInsert: false } });
    const relayed: string[] = [];
    vim.on("PageKey", ({ name }: any) => relayed.push(name));
    const buffer = field("|abc");
    const session = vim.attach(buffer);
    await session.idle();
    await type(session, buffer, "gtztSHgx");
    assert.deepEqual(relayed, ["place.terminal", "show.terminal", "jump.significant", "open"]);
  });
});

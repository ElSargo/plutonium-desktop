// init.js's API (PLUTO_VIM.md, init.js, step 4): configure(vim, setup) on a
// Vim, then keys over a StringBuffer as in vim.test.ts.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import * as vimModule from "../web/vim/index.js";

const { Vim, StringBuffer, parseKeys, configure } = vimModule as any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function field(marked: string, { singleLine = false } = {}) {
  const cursor = marked.indexOf("|");
  return new StringBuffer(marked.slice(0, cursor) + marked.slice(cursor + 1), { cursor, singleLine });
}

const mark = (buffer: any) => buffer.value.slice(0, buffer.cursor) + "|" + buffer.value.slice(buffer.cursor);

async function type(session: any, buffer: any, keys: string) {
  for (const key of parseKeys(keys)) {
    const mine = session.feed(key);
    await session.idle();
    if (!mine) buffer.typeKey(key);
  }
}

/** A Vim set up by `setup`, a field in it, and `keys` typed. */
async function run(setup: (vim: any) => void, marked: string, keys: string, { insert = false, opt = {} } = {}) {
  const vim = new Vim({ opt: { startInInsert: insert, timeoutlen: 30, ...opt } });
  const result = configure(vim, setup);
  const buffer = field(marked);
  const session = vim.attach(buffer);
  await session.idle();
  await type(session, buffer, keys);
  return { vim, buffer, session, text: mark(buffer), warnings: result.warnings };
}

describe("mappings", () => {
  test("a normal-mode mapping to keys", async () => {
    const { text, vim } = await run((v) => v.keymap.set("n", "Y", "y$"), "a |bc d", "Y$p");
    assert.equal(text, "a bc dbc |d");
    assert.equal((await vim.registers.get('"')).text, "bc d");
  });

  test("insert mode jk leaves insert mode; j then another key types both, in order", async () => {
    const setup = (v: any) => v.keymap.set("i", "jk", "<C-[>");
    let r = await run(setup, "|", "foojk", { insert: true });
    assert.equal(r.session.mode, "normal");
    assert.equal(r.text, "fo|o");
    r = await run(setup, "|", "ajxb", { insert: true });
    assert.equal(r.session.mode, "insert");
    assert.equal(r.buffer.value, "ajxb");
  });

  test("a key held for a mapping is typed once timeoutlen passes", async () => {
    const r = await run((v) => v.keymap.set("i", "jk", "<C-[>"), "|", "aj", { insert: true });
    assert.equal(r.buffer.value, "a", "j waits");
    await sleep(60);
    await r.session.idle();
    assert.equal(r.buffer.value, "aj");
    assert.equal(r.session.mode, "insert");
  });

  test("a count and a register come before a mapping, as in vim", async () => {
    const { vim } = await run((v) => v.keymap.set("n", "Y", "y$"), "|abc", '"aY');
    assert.equal((await vim.registers.get("a")).text, "abc");
  });

  test("remap goes through other mappings; the default doesn't", async () => {
    const setup = (v: any) => {
      v.keymap.set("n", "x", "dd");
      v.keymap.set("n", "Q", "x", { remap: true });
      v.keymap.set("n", "R", "x");
    };
    assert.equal((await run(setup, "on|e\ntwo", "Q")).text, "|two");
    assert.equal((await run(setup, "on|e\ntwo", "R")).text, "o|n\ntwo", "R is the built-in x");
  });

  test("a loop of remapped mappings stops, with an error", async () => {
    const errors: unknown[] = [];
    const r = await run((v) => {
      v.keymap.set("n", "a", "b", { remap: true });
      v.keymap.set("n", "b", "a", { remap: true });
    }, "|x", "");
    r.vim.on("error", (e: unknown) => errors.push(e));
    r.session.feed("a");
    assert.match(String(errors[0]), /without end/);
  });

  test("<leader> is mapleader, when the mapping is made", async () => {
    const { text } = await run((v) => {
      v.opt.mapleader = " ";
      v.keymap.set("n", "<leader>d", "dd");
    }, "one\n|two\nthree", " d");
    assert.equal(text, "one\n|three");
  });

  test("a function, with the field's selection and mode", async () => {
    const seen: unknown[] = [];
    await run((v) => v.keymap.set("v", "gs", () => seen.push([v.mode(), v.selection()])), "a |bcd e", "veegs");
    assert.deepEqual(seen, [["visual", "bcd e"]]);
  });

  test("expr: the function's result is the keys", async () => {
    const { text } = await run((v) => v.keymap.set("n", "D", () => "dw", { expr: true }), "|one two", "D");
    assert.equal(text, "|two");
  });

  test("feedkeys from a function", async () => {
    const { text } = await run((v) => v.keymap.set("n", "Z", () => v.feedkeys("A!<C-[>")), "|hi", "Z");
    assert.equal(text, "hi|!");
  });

  test("nowait runs a mapping at once, though a longer one starts the same", async () => {
    const r = await run((v) => {
      v.keymap.set("n", "g", "x", { nowait: true });
      v.keymap.set("n", "gx", "dd");
    }, "|abc", "g");
    assert.equal(r.text, "|bc");
  });

  test("keymap.del removes one", async () => {
    const { text } = await run((v) => {
      v.keymap.set("n", "x", "dd");
      v.keymap.del("n", "x");
    }, "|abc", "x");
    assert.equal(text, "|bc");
  });
});

describe("motions, operators, text objects, commands", () => {
  test("a motion, also after an operator", async () => {
    const setup = (v: any) => v.motion("gl", (buf: any) => buf.line().to, { kind: "exclusive" });
    assert.equal((await run(setup, "|ab cd\nx", "dgl")).text, "|\nx");
  });

  test("a text object: a URL", async () => {
    const setup = (v: any) => v.textobject("u", (buf: any, around: boolean) => buf.matchAround(/https?:\/\/\S+/, around));
    const r = await run(setup, "see https://ex|ample.com now", "ciuX<C-[>");
    assert.equal(r.buffer.value, "see X now");
    assert.equal((await run(setup, "see https://ex|ample.com now", "dau")).buffer.value, "see now");
  });

  test("an operator over motions, text objects, its doubled form, visual mode and .", async () => {
    const reverse = (v: any) => v.operator("gz", async (buf: any, range: any) => {
      await buf.edit(range, [...buf.slice(range)].reverse().join(""));
    });
    assert.equal((await run(reverse, "|abc def", "gziw")).buffer.value, "cba def");
    assert.equal((await run(reverse, "|abc def", "gzz")).buffer.value, "fed cba");
    assert.equal((await run(reverse, "|abc def", "vllgz")).buffer.value, "cba def");
    assert.equal((await run(reverse, "|abc def", "gziww.")).buffer.value, "cba fed");
  });

  test("a command, from <Cmd> and vim.cmd", async () => {
    const setup = (v: any) => {
      v.command("Upper", async (buf: any, { args }: any) => {
        const line = buf.line();
        await buf.edit(line, line.text.toUpperCase() + args);
      });
      v.keymap.set("n", "U", "<Cmd>Upper !<CR>");
      v.keymap.set("n", "Q", () => v.cmd("Upper ?"));
    };
    assert.equal((await run(setup, "|abc\ndef", "U")).buffer.value, "ABC!\ndef");
    assert.equal((await run(setup, "|abc\ndef", "Qu")).buffer.value, "abc\ndef", "u undoes it");
    assert.equal((await run(setup, "|abc", "Q")).buffer.value, "ABC?");
  });
});

describe("configure", () => {
  test("options are checked", () => {
    const vim = new Vim();
    assert.throws(() => configure(vim, (v: any) => { v.opt.nope = 1; }), /no such option/);
    assert.throws(() => configure(vim, (v: any) => { v.opt.inputs = false; }), /one of "manual", "on", "off"/);
    assert.throws(() => configure(vim, (v: any) => { v.opt.whichwrap = "b"; }), /isn't built yet/);
    configure(vim, (v: any) => { v.opt.claim = ["<c-[>", "<C-Space>"]; });
    assert.deepEqual(vim.opt.claim, ["<C-[>", "<C- >"], "Space is \" \" in the notation");
  });

  test("running it again leaves nothing of the last setup", async () => {
    const vim = new Vim({ opt: { startInInsert: false } });
    const left: unknown[] = [];
    configure(vim, (v: any) => {
      v.opt.shiftwidth = 8;
      v.keymap.set("n", "x", "dd");
      v.command("Hi", () => {});
      v.on("InsertLeave", () => left.push(1));
    });
    configure(vim, () => {});
    assert.equal(vim.opt.shiftwidth, 2);
    assert.equal(vim.keymaps.n.size, 0);
    assert.equal(vim.user.commands.size, 0);
    const buffer = field("|ab");
    const session = vim.attach(buffer);
    await type(session, buffer, "ix<C-[>");
    assert.deepEqual(left, []);
  });

  test("a setup that throws leaves the built-ins, and an async one is refused", () => {
    const vim = new Vim();
    assert.throws(() => configure(vim, (v: any) => { v.keymap.set("n", "x", "dd"); throw new Error("oops"); }), /oops/);
    assert.equal(vim.keymaps.n.size, 0);
    assert.throws(() => configure(vim, async () => {}), /not return a promise/);
    assert.throws(() => configure(vim, "nope" as any), /default export must be a function/);
  });

  test("mistakes in calls say what was wrong", () => {
    const vim = new Vim();
    assert.throws(() => configure(vim, (v: any) => v.keymap.set("o", "x", "y")), /operator-pending/);
    assert.throws(() => configure(vim, (v: any) => v.keymap.set("n", "x", "y", { noremapp: true })), /no option noremapp/);
    assert.throws(() => configure(vim, (v: any) => v.command("lower", () => {})), /capital letter/);
    assert.throws(() => configure(vim, (v: any) => v.on("BufEnter", () => {})), /no such event/);
    assert.throws(() => configure(vim, (v: any) => v.disable({})), /empty rule/);
    assert.throws(() => configure(vim, (v: any) => v.registers.scope("+", "thread")), /always global/);
    assert.throws(() => configure(vim, (v: any) => v.keymap.del("n", "q")), /no n mapping/);
  });

  test("warnings: keys that now wait, and things set twice", () => {
    const vim = new Vim();
    const { warnings } = configure(vim, (v: any) => {
      v.keymap.set("n", "xx", "dd");
      v.keymap.set("n", "Y", "y$");
      v.keymap.set("n", "Y", "yy");
      v.keymap.set("i", "jk", "<C-[>");
      v.keymap.set("i", "j", "J");
      v.motion("w", () => null);
    });
    assert.ok(warnings.some((w: string) => /^n xx: x now waits/.test(w)), warnings.join("\n"));
    assert.ok(warnings.some((w: string) => /^n Y: mapped again/.test(w)));
    assert.ok(warnings.some((w: string) => /^i j: waits .* jk/.test(w)));
    assert.ok(warnings.some((w: string) => /^motion w: replaces the built-in/.test(w)));
  });

  test("disable and enable: the last matching rule wins", () => {
    const vim = new Vim();
    configure(vim, (v: any) => {
      v.disable({ site: "google.com" });
      v.enable({ site: "mail.google.com" });
      v.disable({ shell: "styx" });
    });
    assert.equal(vim.enabledFor({ site: "docs.google.com" }), false);
    assert.equal(vim.enabledFor({ site: "mail.google.com" }), true);
    assert.equal(vim.enabledFor({ site: "notgoogle.com" }), true);
    assert.equal(vim.enabledFor({ site: "example.com", shell: "styx" }), false);
  });

  test("registers: set, get, append, scope", async () => {
    const vim = new Vim();
    configure(vim, (v: any) => {
      v.registers.set("a", "one");
      v.registers.set("A", "two");
      v.registers.scope("t", "thread");
      v.registers.scope("0-2", "project");
    });
    await sleep(0);
    assert.equal((await vim.registers.get("a")).text, "onetwo");
    assert.equal(vim.registerScopes.get("t"), "thread");
    assert.deepEqual([...vim.registerScopes.keys()], ["t", "0", "1", "2"]);
  });

  test("events get the field's mode", async () => {
    const seen: unknown[] = [];
    await run((v) => v.on("InsertLeave", ({ inserted, mode }: any) => seen.push([inserted, mode])), "|", "ihi<C-[>");
    assert.deepEqual(seen, [["hi", "normal"]]);
  });

  test("desktop.call says config.js isn't there yet", async () => {
    let call: Promise<unknown> | undefined;
    configure(new Vim(), (v: any) => { call = v.desktop.call("x", {}); });
    await assert.rejects(call!, /config\.js/);
  });
});

describe("pages that integrate", () => {
  /** A field whose page declares `actions` and `commands`; what it's asked to do goes into `ran`. */
  function pageField(marked: string, actions: string[], commands: string[] = []) {
    const buffer = field(marked);
    const ran: string[] = [];
    buffer.field.actions = () => new Set(actions);
    buffer.field.commands = () => new Set(commands);
    buffer.field.action = (name: string) => ran.push(name);
    return { buffer, ran };
  }

  test("{ action } mappings, page commands, and Enter, j and k on an open menu", async () => {
    const vim = new Vim({ opt: { startInInsert: false } });
    const errors: Error[] = [];
    vim.on("error", (e: Error) => errors.push(e));
    configure(vim, (v: any) => {
      v.keymap.set("n", "<leader>m", { action: "model" });
      v.keymap.set("n", "<leader>x", { action: "nope" });
      v.keymap.set("n", "<leader>s", "<Cmd>stash<CR>");
    });
    const { buffer, ran } = pageField("|a\nb", ["model", "stash", "menu.next", "menu.prev", "menu.select", "submit"], ["stash"]);
    const session = vim.attach(buffer);
    await type(session, buffer, "\\m\\s\\xjk<CR>");
    assert.deepEqual(ran, ["model", "stash", "menu.next", "menu.prev", "menu.select"]);
    assert.match(errors[0]!.message, /no action nope/);
    assert.equal(mark(buffer), "|a\nb", "j and k went to the menu");
  });

  test("an open menu from insert mode: Ctrl+N, Ctrl+P, Ctrl+Y, Ctrl+E; without one they're the page's", async () => {
    const vim = new Vim({ opt: { startInInsert: true } });
    const { buffer, ran } = pageField("|", ["menu.next", "menu.prev", "menu.select", "menu.close"]);
    const session = vim.attach(buffer);
    assert.deepEqual(["<C-n>", "<C-p>", "<C-y>", "<C-e>"].map((k) => session.feed(k)), [true, true, true, true]);
    assert.deepEqual(ran, ["menu.next", "menu.prev", "menu.select", "menu.close"]);
    const plain = vim.attach(field("|"));
    assert.equal(plain.feed("<C-n>"), false);
  });

  test("init.js's startInInsert wins over the page's data-pvim-start", () => {
    const vim = new Vim();
    assert.equal(vim.userOpts.has("startInInsert"), false);
    configure(vim, (v: any) => { v.opt.startInInsert = false; });
    assert.equal(vim.userOpts.has("startInInsert"), true);
    configure(vim, () => {});
    assert.equal(vim.userOpts.has("startInInsert"), false, "a new version starts over");
  });
});

describe("where fields start", () => {
  test("vim.enable({ …, start }) names a field's starting mode; the last matching rule wins", () => {
    const vim = new Vim();
    configure(vim, (v: any) => {
      v.enable({ shell: "hydra", start: "normal" });
      v.enable({ shell: "hydra", selector: ".plain", start: "insert" });
    });
    const el = (plain: boolean) => ({ closest: (sel: string) => (sel === ".plain" && plain ? {} : null) });
    assert.equal(vim.startFor({ shell: "hydra", el: el(false) }), "normal");
    assert.equal(vim.startFor({ shell: "hydra", el: el(true) }), "insert");
    assert.equal(vim.startFor({ shell: "styx", el: el(false) }), null);
    assert.throws(() => configure(vim, (v: any) => v.disable({ shell: "x", start: "normal" })), /start is for vim.enable/);
    assert.throws(() => configure(vim, (v: any) => v.enable({ shell: "x", start: "visual" })), /"normal" or "insert"/);
  });
});

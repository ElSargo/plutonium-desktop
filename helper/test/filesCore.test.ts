// The file manager's core (web/ui/files.js): keys, the fuzzy matcher, lists, undo.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
// @ts-expect-error A plain ES module, as pages load it.
import * as core from "../web/ui/files.js";

const press = (keymap: InstanceType<typeof core.Keymap>, keys: string) =>
  [...keys].map((key) => keymap.feed({ key })).at(-1);

describe("keys", () => {
  test("spellings", () => {
    assert.equal(core.keyName({ key: "j" }), "j");
    assert.equal(core.keyName({ key: "G", shift: true }), "G");
    assert.equal(core.keyName({ key: "d", ctrl: true }), "<C-d>");
    assert.equal(core.keyName({ key: " " }), "<Space>");
    assert.equal(core.keyName({ key: "Enter", ctrl: true }), "<C-Enter>");
    assert.equal(core.keyName({ key: "Shift", shift: true }), "");
    assert.deepEqual(core.splitKeys("g<C-d>/"), ["g", "<C-d>", "/"]);
  });

  test("single keys, sequences, a wrong second key, an unbound key", () => {
    const keymap = new core.Keymap();
    assert.equal(keymap.feed({ key: "j" }).command, "down");
    assert.deepEqual(keymap.feed({ key: "g" }), { command: null, pending: "g", handled: true });
    assert.equal(keymap.feed({ key: "g" }).command, "top");
    assert.equal(press(keymap, ",m").command, "sortModified");
    keymap.feed({ key: "g" });
    assert.deepEqual(keymap.feed({ key: "q" }), { command: null, pending: "", handled: true });
    assert.deepEqual(keymap.feed({ key: "q" }), { command: null, pending: "", handled: false });
    assert.equal(keymap.feed({ key: "Shift", shift: true }).handled, false);
  });

  test("overrides rebind and unbind", () => {
    const keymap = new core.Keymap([["J", "bottom"], ["j", null]]);
    assert.equal(keymap.feed({ key: "J" }).command, "bottom");
    assert.equal(keymap.feed({ key: "j" }).handled, false);
    assert.ok(keymap.help().some(([keys]: string[]) => keys === "J"));
  });

  test("every default command is described once, with no key shadowing a sequence", () => {
    const keys = core.DEFAULT_KEYMAP.map(([sequence]: string[]) => sequence);
    assert.equal(new Set(keys).size, keys.length);
    for (const sequence of keys) {
      assert.ok(!keys.some((other: string) => other !== sequence && other.startsWith(sequence) && !sequence.startsWith("<")), sequence);
    }
  });
});

describe("the fuzzy matcher", () => {
  test("matches in order, ignoring case unless the query has a capital", () => {
    assert.ok(core.fuzzyMatch("abc", "a/b/c"));
    assert.equal(core.fuzzyMatch("cba", "a/b/c"), null);
    assert.ok(core.fuzzyMatch("read", "README.md"));
    assert.equal(core.fuzzyMatch("Read", "readme.md"), null);
    assert.deepEqual(core.fuzzyMatch("", "x"), { score: 0, positions: [] });
  });

  test("positions are the match", () => {
    assert.deepEqual(core.fuzzyMatch("fb", "foo/bar").positions, [0, 4]);
    assert.deepEqual(core.fuzzyMatch("bar", "foo/bar").positions, [4, 5, 6]);
  });

  test("a file's name beats its folders; a word start beats the middle of one", () => {
    const best = (query: string, paths: string[]) => core.fuzzyFilter(query, paths)[0].path;
    assert.equal(best("main", ["src/main/other.ts", "src/other/main.ts"]), "src/other/main.ts");
    assert.equal(best("fp", ["src/ramp.ts", "src/file_picker.ts"]), "src/file_picker.ts");
    assert.equal(best("chat", ["apps/web/src/components/ChatView.tsx", "apps/web/src/chatty/matching/a.ts"]), "apps/web/src/components/ChatView.tsx");
  });

  test("terms all have to match, in any order; a limit; an empty query", () => {
    const paths = ["src/a.ts", "test/a.ts", "src/b.ts"];
    assert.deepEqual(core.fuzzyFilter("a src", paths).map(({ path }: { path: string }) => path), ["src/a.ts"]);
    assert.equal(core.fuzzyFilter("ts", paths, 2).length, 2);
    assert.equal(core.fuzzyFilter("  ", paths).length, 3);
  });

  test("two hundred thousand paths in a moment", () => {
    const paths = Array.from({ length: 200_000 }, (_, n) => `some/folder/${n % 100}/file-${n}.ts`);
    const start = performance.now();
    core.fuzzyFilter("fl99", paths);
    assert.ok(performance.now() - start < 2000);
  });
});

describe("lists", () => {
  const entry = (name: string, kind = "file", size = 0, modified = 0) => ({ name, path: `/${name}`, kind, size, modified, hidden: false });

  test("sorts folders first; natural names; by size, date, type; reversed", () => {
    const entries = [entry("b10.txt", "file", 5, 1), entry("b2.png", "file", 9, 3), entry("z", "dir")];
    const names = (list: { name: string }[]) => list.map(({ name }) => name);
    assert.deepEqual(names(core.sortEntries(entries)), ["z", "b2.png", "b10.txt"]);
    assert.deepEqual(names(core.sortEntries(entries, "size")), ["z", "b2.png", "b10.txt"]);
    assert.deepEqual(names(core.sortEntries(entries, "modified", true)), ["z", "b10.txt", "b2.png"]);
    assert.deepEqual(names(core.sortEntries(entries, "extension")), ["z", "b2.png", "b10.txt"]);
  });

  test("globs, kinds, sizes, paths", () => {
    assert.ok(core.globMatch("*.PNG", "a.png"));
    assert.ok(!core.globMatch("*.png", "a.png.txt"));
    assert.ok(core.globMatch("*", "x"));
    assert.equal(core.fileKind("a.JPG"), "image");
    assert.equal(core.fileKind("a.rs"), "file");
    assert.ok(core.hasRawPreview("a.pdf"));
    assert.ok(!core.hasRawPreview("a.svg"));
    assert.equal(core.formatSize(512), "512 B");
    assert.equal(core.formatSize(1536), "1.5 KB");
    assert.equal(core.formatSize(5 * 1024 ** 3), "5.0 GB");
    assert.equal(core.parentOf("/a/b"), "/a");
    assert.equal(core.parentOf("/a"), "/");
    assert.equal(core.parentOf("/"), null);
    assert.equal(core.joinPath("/", "a"), "/a");
  });
});

describe("undo", () => {
  const job = (op: string, results: { from: string; to: string }[], state = "done") => ({ op, state, results });

  test("a copy is trashed, a trash restored, a move goes back folder by folder", () => {
    assert.deepEqual(core.undoOf(job("copy", [{ from: "/a", to: "/t/a" }])), { op: "trash", paths: ["/t/a"] });
    assert.deepEqual(core.undoOf(job("trash", [{ from: "/a", to: "/T/a" }])), { op: "restore", paths: ["/T/a"] });
    assert.deepEqual(core.undoOf(job("move", [{ from: "/x/a", to: "/t/a" }, { from: "/y/b", to: "/t/b" }])), [
      { op: "move", paths: ["/t/a"], target: "/x", conflict: "fail" },
      { op: "move", paths: ["/t/b"], target: "/y", conflict: "fail" },
    ]);
  });

  test("a delete, or a job that failed, can't be undone", () => {
    assert.equal(core.undoOf(job("delete", [{ from: "/a", to: "" }])), null);
    assert.equal(core.undoOf(job("copy", [{ from: "/a", to: "/b" }], "failed")), null);
  });
});

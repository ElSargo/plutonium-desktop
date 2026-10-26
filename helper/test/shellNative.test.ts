import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { NativeError, ShellNative } from "../src/shellNative.ts";
import { parseManifest, type InstalledShell } from "../src/shells.ts";

describe("a shell's storage and native side", () => {
  const home = mkdtempSync(join(tmpdir(), "plutonium-native-"));
  const events: [string, string, unknown][] = [];
  const native = new ShellNative(home, (shell, event, detail) => events.push([shell, event, detail]));
  const dir = join(home, "shells", "notes");
  mkdirSync(dir, { recursive: true });
  const shell: InstalledShell = {
    name: "notes",
    dir,
    manifest: parseManifest('{"title":"Notes","static":"index.html","native":"native.js"}', "notes"),
  };
  const write = (code: string) => writeFileSync(join(dir, "native.js"), code);

  after(() => {
    native.stopAll();
    rmSync(home, { recursive: true, force: true });
  });

  test("storage keeps JSON by key, outside the shell's folder", () => {
    assert.equal(native.get("notes", "todo"), undefined);
    native.set("notes", "todo", { items: ["milk"] });
    assert.deepEqual(native.get("notes", "todo"), { items: ["milk"] });
    native.set("notes", "count", 3);
    assert.deepEqual(native.keys("notes"), ["count", "todo"]);
    native.delete("notes", "count");
    assert.deepEqual(native.keys("notes"), ["todo"]);
    assert.deepEqual(native.keys("other"), []);
    assert.throws(() => native.set("notes", "../escape", 1), NativeError);
    assert.throws(() => native.get("notes", ".hidden"), NativeError);
  });

  test("the page calls the module's functions, and gets its events", async () => {
    write(`
      export function start(context) { context.emit("started", { shell: context.shell }); }
      export async function add({ a, b }) { return a + b; }
      export function where(_args, context) { console.log("log line"); return context.dataDir; }
      export function fail() { throw new Error("no thanks"); }
    `);
    assert.equal(await native.call(shell, "add", { a: 2, b: 3 }), 5);
    assert.equal(await native.call(shell, "where", {}), join(home, "data", "notes"));
    await assert.rejects(native.call(shell, "fail", {}), /no thanks/);
    await assert.rejects(native.call(shell, "missing", {}), (error: NativeError) => error.status === 404);
    await assert.rejects(native.call(shell, "start", {}), (error: NativeError) => error.status === 404);
    assert.deepEqual(events, [["notes", "started", { shell: "notes" }]]);
  });

  test("an edit takes effect on the next call; a broken module says so", async () => {
    write(`export const add = () => "new";`);
    native.stop("notes");
    assert.equal(await native.call(shell, "add", {}), "new");
    write(`export const add = (;`);
    native.stop("notes");
    await assert.rejects(native.call(shell, "add", {}), (error: NativeError) => error.status === 502);
    write(`export function die() { process.exit(3); }\nexport const ok = () => 1;`);
    await assert.rejects(native.call(shell, "die", {}), /exited/);
    assert.equal(await native.call(shell, "ok", {}), 1);
  });

  test("a shell without one", async () => {
    const plain = { ...shell, manifest: parseManifest('{"static":"index.html"}', "notes") };
    await assert.rejects(native.call(plain, "add", {}), (error: NativeError) => error.status === 404);
    assert.throws(() => parseManifest('{"static":"index.html","native":"../x.js"}', "notes"), /inside/);
  });
});

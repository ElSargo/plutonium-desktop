// The fuzzy finder, on real files, through its worker and fff.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { FileFinders } from "../src/fileFinder.ts";

let root: string;
const finders = new FileFinders({ idleMs: 60_000 });

async function settled(query: string, hidden = false) {
  for (;;) {
    const found = await finders.find(root, { query, hidden });
    if ("superseded" in found) throw new Error("superseded");
    if (!found.scanning) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "file-finder-"));
  process.env.XDG_DATA_HOME = join(root, ".data");
  mkdirSync(join(root, "src/deep"), { recursive: true });
  writeFileSync(join(root, "src/deep/needle.ts"), "");
  writeFileSync(join(root, "src/other.ts"), "");
  writeFileSync(join(root, ".secret-needle"), "");
});
after(() => {
  finders.close();
  rmSync(root, { recursive: true, force: true });
});

describe("FileFinders", () => {
  test("finds files and folders, off the helper's thread", async () => {
    const found = await settled("needle");
    assert.ok(found.paths.includes("src/deep/needle.ts"), String(found.paths));
    assert.ok((await settled("deep")).paths.some((path) => path.startsWith("src/deep")));
    assert.ok(found.total >= 2);
  });

  test("dot files only when asked", async () => {
    assert.ok(!(await settled("secret")).paths.some((path) => path.includes(".secret")));
    const shown = await settled("secret", true);
    assert.equal(shown.engine, "walk");
    assert.ok(shown.paths.includes(".secret-needle"));
  });

  test("a newer query replaces one that's waiting", async () => {
    const running = finders.find(root, { query: "a", hidden: false });
    const waiting = finders.find(root, { query: "b", hidden: false });
    const latest = finders.find(root, { query: "needle", hidden: false });
    assert.deepEqual(await waiting, { superseded: true });
    assert.ok(!("superseded" in (await running)));
    const found = await latest;
    assert.ok(!("superseded" in found) && found.paths.length > 0);
  });

  test("a search process that dies fails its search, and the next one starts another", async () => {
    await settled("needle");
    const worker = (finders as unknown as { worker: { kill(signal: string): void } }).worker;
    const dying = finders.find(root, { query: "needle", hidden: false });
    worker.kill("SIGSEGV");
    await dying.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok((await settled("needle")).paths.includes("src/deep/needle.ts"));
  });

  test("an idle index goes, and comes back", async () => {
    const quick = new FileFinders({ idleMs: 50 });
    const found = await quick.find(root, { query: "needle", hidden: false });
    assert.ok(!("superseded" in found));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal((quick as unknown as { worker: unknown }).worker, null);
    const again = await quick.find(root, { query: "needle", hidden: false });
    assert.ok(!("superseded" in again) && again.paths.length > 0);
    quick.close();
  });

  test("an old index is rebuilt, and new files turn up while it's searched", async () => {
    const quick = new FileFinders({ refreshMs: 1 });
    await quick.find(root, { query: "needle", hidden: false });
    writeFileSync(join(root, "src/freshly-made.ts"), "");
    await new Promise((resolve) => setTimeout(resolve, 200));
    let found;
    for (let tries = 0; tries < 100; tries += 1) {
      found = await quick.find(root, { query: "freshly", hidden: false });
      assert.ok(!("superseded" in found));
      if (found.paths.includes("src/freshly-made.ts")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(found && !("superseded" in found) && found.paths.includes("src/freshly-made.ts"));
    quick.close();
  });

  test("short of memory, the indexes go; a later search starts again", async () => {
    let memory = Number.POSITIVE_INFINITY;
    const quick = new FileFinders({ memory: () => memory, memoryCheckMs: 20 });
    await quick.find(root, { query: "needle", hidden: false });
    memory = 0;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((quick as unknown as { worker: unknown }).worker, null);
    memory = Number.POSITIVE_INFINITY;
    const again = await quick.find(root, { query: "needle", hidden: false });
    assert.ok(!("superseded" in again) && again.paths.length > 0);
    quick.close();
  });

  test("a new session indexes what was searched lately, in its own scope", async () => {
    const first = new FileFinders({ scope: "warm-test" });
    await first.find(root, { query: "needle", hidden: false });
    first.close();
    const second = new FileFinders({ scope: "warm-test" });
    await second.warm();
    const worker = () => (second as unknown as { worker: unknown }).worker;
    assert.ok(worker(), "indexed at the start");
    second.close();
    const other = new FileFinders({ scope: "another-slot" });
    await other.warm();
    assert.equal((other as unknown as { worker: unknown }).worker, null);
    other.close();
  });

  test("refuses a relative folder", () => {
    assert.throws(() => finders.find("relative", { query: "", hidden: false }), /absolute/);
  });
});

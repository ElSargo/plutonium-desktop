// The file manager's operations (fileOps.ts), on real files in a temporary folder.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  fileIndex,
  FileJobs,
  freeName,
  makeFile,
  previewText,
  rawFile,
  renamePath,
  restoreItem,
  trashItem,
  uploadTarget,
} from "../src/fileOps.ts";

let root: string;
let jobs: FileJobs;

async function finished(id: number) {
  for (;;) {
    const job = jobs.get(id)!;
    if (job.state !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "file-ops-"));
  jobs = new FileJobs(join(root, "home"));
});
after(() => rmSync(root, { recursive: true, force: true }));

function fresh(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("names", () => {
  test("freeName numbers a taken name before its extension", async () => {
    const dir = fresh("names");
    writeFileSync(join(dir, "a.txt"), "");
    writeFileSync(join(dir, "a (2).txt"), "");
    writeFileSync(join(dir, ".hidden"), "");
    assert.equal(await freeName(dir, "b.txt"), join(dir, "b.txt"));
    assert.equal(await freeName(dir, "a.txt"), join(dir, "a (3).txt"));
    assert.equal(await freeName(dir, ".hidden"), join(dir, ".hidden (2)"));
  });

  test("rename refuses a path, a taken name; makeFile a taken one", async () => {
    const dir = fresh("rename");
    writeFileSync(join(dir, "a"), "");
    writeFileSync(join(dir, "b"), "");
    await assert.rejects(renamePath(join(dir, "a"), "../c"), /isn't a name/);
    await assert.rejects(renamePath(join(dir, "a"), "b"), /already exists/);
    assert.deepEqual(await renamePath(join(dir, "a"), "c"), { path: join(dir, "c") });
    await assert.rejects(makeFile(join(dir, "b")), /already exists/);
  });
});

describe("jobs", () => {
  test("copy keeps links, numbers a conflict, copies beside itself", async () => {
    const dir = fresh("copy");
    const from = fresh("copy/from");
    writeFileSync(join(from, "file"), "hello");
    symlinkSync("file", join(from, "link"));
    const to = fresh("copy/to");
    mkdirSync(join(to, "from"));
    const job = await finished(jobs.start({ op: "copy", paths: [from], target: to }).id);
    assert.equal(job.state, "done");
    assert.equal(job.done, job.total);
    assert.equal(job.results[0]!.to, join(to, "from (2)"));
    assert.equal(readFileSync(join(to, "from (2)/file"), "utf8"), "hello");
    assert.equal(readlinkSync(join(to, "from (2)/link")), "file");
    const beside = await finished(jobs.start({ op: "copy", paths: [join(from, "file")], target: from }).id);
    assert.equal(beside.results[0]!.to, join(from, "file (2)"));
    assert.ok(dir);
  });

  test("conflicts: skip leaves it, overwrite replaces it, fail stops", async () => {
    const dir = fresh("conflict");
    const target = fresh("conflict/t");
    writeFileSync(join(dir, "a"), "new");
    writeFileSync(join(target, "a"), "old");
    await finished(jobs.start({ op: "copy", paths: [join(dir, "a")], target, conflict: "skip" }).id);
    assert.equal(readFileSync(join(target, "a"), "utf8"), "old");
    const failed = await finished(jobs.start({ op: "copy", paths: [join(dir, "a")], target, conflict: "fail" }).id);
    assert.equal(failed.state, "failed");
    assert.match(failed.error!, /already exists/);
    await finished(jobs.start({ op: "copy", paths: [join(dir, "a")], target, conflict: "overwrite" }).id);
    assert.equal(readFileSync(join(target, "a"), "utf8"), "new");
  });

  test("move, and moving onto itself does nothing", async () => {
    const dir = fresh("move");
    const target = fresh("move/t");
    writeFileSync(join(dir, "a"), "x");
    const job = await finished(jobs.start({ op: "move", paths: [join(dir, "a")], target }).id);
    assert.deepEqual(job.results, [{ from: join(dir, "a"), to: join(target, "a") }]);
    assert.ok(!existsSync(join(dir, "a")));
    const same = await finished(jobs.start({ op: "move", paths: [join(target, "a")], target }).id);
    assert.equal(same.state, "done");
    assert.deepEqual(same.results, []);
    assert.ok(existsSync(join(target, "a")));
  });

  test("refuses a folder into itself, and the root or home going away", async () => {
    const dir = fresh("guard");
    assert.throws(() => jobs.start({ op: "move", paths: [dir], target: join(dir, "in") }), /inside itself/);
    assert.throws(() => jobs.start({ op: "delete", paths: ["/"] }), /can't be removed/);
    assert.throws(() => jobs.start({ op: "trash", paths: [join(root, "home")] }), /can't be removed/);
    assert.throws(() => jobs.start({ op: "delete", paths: [root] }), /can't be removed/);
    assert.throws(() => jobs.start({ op: "delete", paths: ["relative"] }), /absolute/);
    assert.throws(() => jobs.start({ op: "copy", paths: [] }), /nothing/);
  });

  test("delete", async () => {
    const dir = fresh("delete/x");
    writeFileSync(join(dir, "a"), "");
    assert.equal((await finished(jobs.start({ op: "delete", paths: [dir] }).id)).state, "done");
    assert.ok(!existsSync(dir));
  });

  test("a cancelled copy leaves nothing half done", async () => {
    const dir = fresh("cancel");
    const from = fresh("cancel/from");
    for (let n = 0; n < 200; n++) writeFileSync(join(from, `f${n}`), "x");
    const target = fresh("cancel/t");
    const job = jobs.start({ op: "copy", paths: [from], target });
    assert.ok(jobs.cancel(job.id));
    assert.equal((await finished(job.id)).state, "cancelled");
    assert.ok(!existsSync(join(target, "from")));
    assert.ok(dir);
  });
});

describe("the trash", () => {
  test("freedesktop layout, a second of the same name, restored where it was", async () => {
    const trash = join(root, "Trash");
    const dir = fresh("trash");
    const path = join(dir, "a b#.txt");
    writeFileSync(path, "1");
    const first = await trashItem(path, trash);
    assert.equal(first, join(trash, "files/a b#.txt"));
    const info = readFileSync(join(trash, "info/a b#.txt.trashinfo"), "utf8");
    assert.match(info, /^\[Trash Info\]\nPath=.*a%20b%23\.txt\nDeletionDate=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\n$/);
    writeFileSync(path, "2");
    const second = await trashItem(path, trash);
    assert.equal(second, join(trash, "files/a b#.txt.2"));
    assert.ok(!existsSync(path));
    assert.equal(await restoreItem(first, trash), path);
    assert.equal(readFileSync(path, "utf8"), "1");
    assert.ok(!existsSync(join(trash, "info/a b#.txt.trashinfo")));
    // Its old place is taken now: it comes back beside it.
    assert.equal(await restoreItem(second, trash), join(dir, "a b# (2).txt"));
  });
});

describe("the index", () => {
  test("a walk without fd: folders marked, dot files and node_modules left out", async () => {
    const dir = fresh("index");
    mkdirSync(join(dir, "src/deep"), { recursive: true });
    mkdirSync(join(dir, "node_modules/x"), { recursive: true });
    writeFileSync(join(dir, "src/deep/a.ts"), "");
    writeFileSync(join(dir, ".secret"), "");
    const { paths } = await fileIndex(dir, { fd: "/nonexistent/fd" });
    assert.deepEqual(paths.sort(), ["src/", "src/deep/", "src/deep/a.ts"]);
    const all = await fileIndex(dir, { fd: "/nonexistent/fd", hidden: true });
    assert.ok(all.paths.includes(".secret"));
    const limited = await fileIndex(dir, { fd: "/nonexistent/fd", limit: 1 });
    assert.ok(limited.truncated);
  });
});

describe("previews", () => {
  test("text, its limit, and binary", async () => {
    const dir = fresh("preview");
    writeFileSync(join(dir, "t"), "hello world");
    writeFileSync(join(dir, "b"), Buffer.from([1, 0, 2]));
    assert.deepEqual(await previewText(join(dir, "t"), 5), {
      path: join(dir, "t"),
      size: 11,
      binary: false,
      text: "hello",
      truncated: true,
    });
    assert.equal((await previewText(join(dir, "b"))).binary, true);
  });

  test("raw serves media and ranges, never a page", async () => {
    const dir = fresh("raw");
    writeFileSync(join(dir, "a.png"), "0123456789");
    writeFileSync(join(dir, "a.svg"), "<svg/>");
    writeFileSync(join(dir, "a.html"), "<script>");
    const whole = await rawFile(join(dir, "a.png"), undefined);
    assert.equal(whole.contentType, "image/png");
    assert.equal(whole.partial, false);
    (whole.stream as unknown as { destroy(): void }).destroy();
    const part = await rawFile(join(dir, "a.png"), "bytes=2-4");
    assert.deepEqual([part.start, part.end, part.partial], [2, 4, true]);
    (part.stream as unknown as { destroy(): void }).destroy();
    await assert.rejects(rawFile(join(dir, "a.svg"), undefined), /no preview/);
    await assert.rejects(rawFile(join(dir, "a.html"), undefined), /no preview/);
    await assert.rejects(rawFile(join(dir, "a.png"), "bytes=99-"), /range/);
  });
});

describe("uploads", () => {
  test("numbers a taken name and refuses a path", async () => {
    const dir = fresh("upload");
    writeFileSync(join(dir, "a.png"), "");
    assert.equal(await uploadTarget(dir, "a.png"), join(dir, "a (2).png"));
    await assert.rejects(uploadTarget(dir, "../a"), /isn't a name/);
  });
});

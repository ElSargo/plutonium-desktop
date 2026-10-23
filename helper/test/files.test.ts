import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { countFiles, FilesError, listDirectory, makeFolder, places, recentFiles } from "../src/files.ts";

describe("files", () => {
  const home = mkdtempSync(join(tmpdir(), "plutonium-files-"));
  after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "Documents"));
  mkdirSync(join(home, "b-folder"));
  writeFileSync(join(home, "file10.txt"), "ten");
  writeFileSync(join(home, "file9.txt"), "nine");
  writeFileSync(join(home, ".hidden"), "");
  symlinkSync(join(home, "b-folder"), join(home, "a-link"));
  symlinkSync(join(home, "nowhere"), join(home, "dangling"));

  test("lists folders first, by name, numbers in order; follows links", async () => {
    const listing = await listDirectory(home);
    assert.equal(listing.dir, home);
    assert.deepEqual(
      listing.entries.map((entry) => `${entry.kind}:${entry.name}`),
      ["dir:a-link", "dir:b-folder", "dir:Documents", "file:file9.txt", "file:file10.txt"],
    );
    assert.equal(listing.entries.find((entry) => entry.name === "file9.txt")?.size, 4);
    const all = await listDirectory(home, { hidden: true });
    assert.ok(all.entries.some((entry) => entry.name === ".hidden" && entry.hidden));
    assert.equal((await listDirectory("/")).parent, null);
  });

  test("says why a listing fails", async () => {
    await assert.rejects(listDirectory("relative"), (error: FilesError) => error.status === 400);
    await assert.rejects(listDirectory(join(home, "missing")), (error: FilesError) => error.status === 404);
    await assert.rejects(listDirectory(join(home, "file9.txt")), (error: FilesError) => error.status === 400);
  });

  test("counts a folder upload's files, as Chrome does", async () => {
    // file10, file9, .hidden, and the dangling link; not the link to b-folder's contents.
    mkdirSync(join(home, "b-folder", "deep"), { recursive: true });
    writeFileSync(join(home, "b-folder", "deep", "x"), "");
    assert.deepEqual(await countFiles(join(home, "b-folder")), { dir: join(home, "b-folder"), files: 1, more: false });
    const all = await countFiles(home);
    assert.equal(all.files, 6); // file10, file9, .hidden, dangling, a-link (not followed), deep/x
    assert.deepEqual(await countFiles(home, 2), { dir: home, files: 2, more: true });
    await assert.rejects(countFiles(join(home, "missing")), (error: FilesError) => error.status === 404);
  });

  test("makes folders", async () => {
    assert.deepEqual(await makeFolder(join(home, "new")), { path: join(home, "new") });
    await assert.rejects(makeFolder(join(home, "new")), (error: FilesError) => error.status === 409);
  });

  test("places: home, the user folders that exist, the root", () => {
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(home, "config");
    mkdirSync(join(home, "config"), { recursive: true });
    mkdirSync(join(home, "Dl"));
    writeFileSync(join(home, "config/user-dirs.dirs"), 'XDG_DOWNLOAD_DIR="$HOME/Dl"\nXDG_MUSIC_DIR="$HOME/"\n');
    try {
      assert.deepEqual(
        places(home).map((place) => `${place.kind}:${place.path.replace(home, "~")}`),
        ["home:~", "documents:~/Documents", "downloads:~/Dl", "root:/"],
      );
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
    }
  });

  test("recent files, newest first, only those that exist", () => {
    const saved = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = join(home, "data");
    mkdirSync(join(home, "data"), { recursive: true });
    writeFileSync(
      join(home, "data/recently-used.xbel"),
      `<?xml version="1.0"?><xbel>
  <bookmark href="file://${home}/file9.txt" added="2026-01-01T00:00:00Z" visited="2026-01-02T00:00:00Z"></bookmark>
  <bookmark href="file://${home}/file10.txt" added="2026-01-01T00:00:00Z" visited="2026-02-01T00:00:00Z"></bookmark>
  <bookmark href="file://${home}/gone.txt" visited="2026-03-01T00:00:00Z"></bookmark>
  <bookmark href="https://example.com/" visited="2026-03-01T00:00:00Z"></bookmark>
</xbel>`,
    );
    try {
      assert.deepEqual(
        recentFiles(30, home).map((entry) => entry.name),
        ["file10.txt", "file9.txt"],
      );
    } finally {
      if (saved === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = saved;
    }
  });
});

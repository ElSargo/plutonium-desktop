// The FileChooser portal's requests and answers as the shells' picker sees
// them (fileChooser.ts); the D-Bus side is in portal.test.ts.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bytePath, fileChooserDetail, fileChooserResults, pickerFilter, plainGlob } from "../src/fileChooser.ts";

const bytes = (text: string) => [...Buffer.from(`${text}\0`)];
const globs = (type: string) => ({ "image/png": ["*.png"], "image/jpeg": ["*.jpg", "*.jpeg"] })[type] ?? [];

describe("file chooser requests", () => {
  test("filters: globs, MIME types through shared-mime-info, GTK's case-blind spelling", () => {
    assert.equal(plainGlob("*.[pP][nN][gG]"), "*.png");
    assert.equal(plainGlob("*.[ch]"), "*.[ch]");
    assert.deepEqual(pickerFilter(["Images", [[1, "image/png"], [1, "image/jpeg"], [0, "*.PNG"]]], globs), {
      name: "Images",
      patterns: ["*.png", "*.jpg", "*.jpeg", "*.PNG"],
      mimeTypes: ["image/png", "image/jpeg"],
    });
    assert.deepEqual(pickerFilter(["Odd", [[1, "x-unknown/thing"]]], globs).patterns, ["*"]);
    assert.equal(bytePath(bytes("/home/u/Documents")), "/home/u/Documents");
  });

  test("OpenFile: multiple, directory, the current filter, choices, the accept label", () => {
    const filters = [["Text", [[0, "*.txt"]]], ["All", [[0, "*"]]]];
    const detail = fileChooserDetail("OpenFile", "Open a thing", new Map<string, unknown>([
      ["multiple", true],
      ["filters", filters],
      ["current_filter", filters[1]],
      ["accept_label", "_Pick"],
      ["current_folder", bytes("/tmp")],
      ["choices", [["enc", "Encoding", [["utf8", "UTF-8"], ["latin1", "Latin-1"]], "latin1"], ["ro", "Read only", [], ""]]],
    ]), globs);
    assert.equal(detail.mode, "open-multiple");
    assert.equal(detail.currentFilter, 1);
    assert.equal(detail.acceptLabel, "Pick");
    assert.equal(detail.currentFolder, "/tmp");
    assert.deepEqual((detail.choices as { id: string; value: string }[]).map(({ id, value }) => [id, value]), [
      ["enc", "latin1"],
      ["ro", "false"],
    ]);
    assert.equal(fileChooserDetail("OpenFile", "", new Map([["directory", true]])).mode, "folder");

    const options = new Map<string, unknown>([["filters", filters], ["choices", [["enc", "Encoding", [["utf8", "UTF-8"]], "utf8"]]]]);
    const results = new Map(fileChooserResults("OpenFile", options, fileChooserDetail("OpenFile", "", options, globs), {
      paths: ["/tmp/a b.txt", "relative"],
      filter: 0,
      choices: { enc: "utf8" },
    }));
    assert.deepEqual(results.get("uris"), ["as", ["file:///tmp/a%20b.txt"]]);
    assert.deepEqual(results.get("current_filter"), ["(sa(us))", filters[0]]);
    assert.deepEqual(results.get("choices"), ["a(ss)", [["enc", "utf8"]]]);
    assert.deepEqual(results.get("writable"), ["b", true]);
    assert.equal(fileChooserResults("OpenFile", options, {}, null), null);
    assert.equal(fileChooserResults("OpenFile", options, {}, { paths: [] }), null);
  });

  test("SaveFile: the name and folder from current_file or current_name", () => {
    const fromFile = fileChooserDetail("SaveFile", "Save", new Map([["current_file", bytes("/home/u/notes.md")]]));
    assert.deepEqual([fromFile.mode, fromFile.currentFolder, fromFile.currentName], ["save", "/home/u", "notes.md"]);
    const named = fileChooserDetail("SaveFile", "Save", new Map([["current_name", "Untitled.txt"]]));
    assert.equal(named.currentName, "Untitled.txt");
  });

  test("SaveFiles: a folder, and a URI in it for each file", () => {
    const options = new Map<string, unknown>([["files", [bytes("a.png"), bytes("b.png")]]]);
    const detail = fileChooserDetail("SaveFiles", "Save images", options);
    assert.deepEqual([detail.mode, detail.acceptLabel, detail.files], ["folder", "Save", ["a.png", "b.png"]]);
    const results = new Map(fileChooserResults("SaveFiles", options, detail, { paths: ["/tmp/out"] }));
    assert.deepEqual(results.get("uris"), ["as", ["file:///tmp/out/a.png", "file:///tmp/out/b.png"]]);
    assert.equal(results.has("writable"), false);
  });
});

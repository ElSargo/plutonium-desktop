// The Print portal (printPortal.ts): GTK's settings to the dialog and back,
// and PreparePrint then Print with a stand-in shell and CUPS. printportal.py,
// its D-Bus side, is checked through xdg-desktop-portal (TAB_FEATURES.md).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { gtkPageRanges, gtkPageSetup, gtkSettings, PrintBackend, printDetail } from "../src/printPortal.ts";

const dir = mkdtempSync(join(tmpdir(), "plutonium-print-"));
after(() => rmSync(dir, { recursive: true, force: true }));

describe("print settings", () => {
  test("the app's settings start the dialog", () => {
    assert.deepEqual(printDetail("Doc", { printer: "Office", "n-copies": "2", orientation: "landscape" }, { Name: "iso_a5" }), {
      title: "Doc",
      printer: "Office",
      copies: 2,
      landscape: true,
      paper: "a5",
    });
    assert.deepEqual(printDetail("Doc", { printer: "Print to File" }, { PPDName: "na_letter_8.5x11in" }), { title: "Doc", paper: "letter" });
  });

  test("page ranges: one-based in the dialog, zero-based in GTK's", () => {
    assert.equal(gtkPageRanges("1-3, 5"), "0-2,4");
    assert.throws(() => gtkPageRanges("3-1"));
    assert.throws(() => gtkPageRanges("x"));
  });

  test("a choice as GTK's settings and page setup", () => {
    const settings = gtkSettings({ printer: "Office", copies: 3, duplex: "long-edge", color: false, paper: "letter", landscape: true, pageRanges: "2" }, "Doc");
    assert.deepEqual(settings.printer, ["s", "Office"]);
    assert.deepEqual(settings["n-copies"], ["s", "3"]);
    assert.deepEqual(settings.duplex, ["s", "horizontal"]);
    assert.deepEqual(settings["use-color"], ["s", "false"]);
    assert.deepEqual(settings["paper-format"], ["s", "na_letter"]);
    assert.deepEqual(settings["page-ranges"], ["s", "1"]);
    assert.equal(settings["output-uri"], undefined);
    const pdf = gtkSettings({ printer: "", path: "/tmp/a b.pdf" }, "Doc");
    assert.deepEqual(pdf.printer, ["s", "Print to File"]);
    assert.deepEqual(pdf["output-uri"], ["s", "file:///tmp/a%20b.pdf"]);
    const setup = gtkPageSetup({ printer: "", paper: "a4", landscape: true });
    assert.deepEqual([setup.Name, setup.Width, setup.Orientation], [["s", "iso_a4"], ["d", 210], ["s", "landscape"]]);
  });
});

describe("PreparePrint, then Print", () => {
  const asked: Record<string, unknown>[] = [];
  const jobs: unknown[] = [];
  let answer: unknown = null;
  const backend = new PrintBackend({
    address: "unused",
    askShell: async (op, args) => {
      asked.push({ op, ...args });
      return answer;
    },
    source: async (_handle, appId) => ({ source: { appId, pid: 1, windowId: 7, name: "App" }, thread: "t1" }),
    printPdf: async (pdf, options) => {
      jobs.push({ pdf: pdf.toString(), ...options });
      return { job: "Office-1" };
    },
  });
  const document = (text: string) => {
    const path = join(dir, `doc-${Math.random()}`);
    writeFileSync(path, text);
    return path;
  };
  const base = { handle: "/r/1", appId: "org.app", parent: "x11:1", title: "Doc" };

  test("the shell's choice prints with its token", async () => {
    answer = { printer: "Office", copies: 2, duplex: "none", color: true, paper: "a4", landscape: false, pageRanges: "" };
    const [code, results] = await backend.call({ ...base, id: 1, method: "PreparePrint", settings: { "n-copies": "2" }, pageSetup: {}, options: {} });
    assert.equal(code, 0);
    assert.equal((asked[0]!.source as { windowId: number }).windowId, 7);
    assert.equal(asked[0]!.op, "print_prepare");
    const token = results.token![1] as number;
    const path = document("%PDF-1.7 one");
    const [printed] = await backend.call({ ...base, id: 2, method: "Print", document: path, options: { token } });
    assert.equal(printed, 0);
    assert.equal(existsSync(path), false);
    assert.deepEqual(jobs.at(-1), { pdf: "%PDF-1.7 one", printer: "Office", copies: 2, duplex: "none", color: true, title: "Doc" });
    assert.equal(asked.length, 1);
  });

  test("Print without a token asks; Save as PDF writes the file; a refusal cancels", async () => {
    const out = join(dir, "out.pdf");
    answer = { printer: "", path: out };
    const [code] = await backend.call({ ...base, id: 3, method: "Print", document: document("%PDF two"), options: {} });
    assert.equal(code, 0);
    assert.equal(existsSync(out), true);
    answer = null;
    assert.equal((await backend.call({ ...base, id: 4, method: "PreparePrint", settings: {}, pageSetup: {}, options: {} }))[0], 1);
  });
});

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { listPrinters, pdfArguments, pdfFileName, printPdf, savePdf } from "../src/printing.ts";

// Stand-ins for CUPS's client tools: lpstat prints what $FAKE_LPSTAT holds,
// lp records its arguments and input in $FAKE_LP_DIR.
const LPSTAT = `#!/bin/sh
printf '%s' "$FAKE_LPSTAT_OUT"
exit "\${FAKE_LPSTAT_CODE:-0}"
`;
const LP = `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_LP_DIR/args"
cat > "$FAKE_LP_DIR/input"
echo "request id is Office-42 (1 file(s))"
`;

describe("printing", () => {
  let dir: string;
  let path: string | undefined;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "plutonium-printing-"));
    writeFileSync(join(dir, "lpstat"), LPSTAT);
    writeFileSync(join(dir, "lp"), LP);
    chmodSync(join(dir, "lpstat"), 0o755);
    chmodSync(join(dir, "lp"), 0o755);
    path = process.env.PATH;
    process.env.PATH = `${dir}:${path}`;
    process.env.FAKE_LP_DIR = dir;
  });
  after(() => {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  });

  test("lists printers and the default", async () => {
    process.env.FAKE_LPSTAT_OUT = [
      "printer Office is idle.  enabled since Fri 23 Oct 2026",
      "\tDescription: Office laser",
      "\tLocation: upstairs",
      "printer Photo disabled since Fri 23 Oct 2026 -",
      "\tDescription: Photo printer",
      "system default destination: Office",
      "",
    ].join("\n");
    assert.deepEqual(await listPrinters(), {
      available: true,
      printers: [
        { name: "Office", description: "Office laser", state: "idle", isDefault: true },
        { name: "Photo", description: "Photo printer", state: "disabled", isDefault: false },
      ],
    });
  });

  test("no server is unavailable", async () => {
    process.env.FAKE_LPSTAT_OUT = "";
    process.env.FAKE_LPSTAT_CODE = "1";
    try {
      const result = await listPrinters();
      assert.equal(result.available, false);
    } finally {
      delete process.env.FAKE_LPSTAT_CODE;
    }
  });

  test("prints with lp", async () => {
    const pdf = Buffer.from("%PDF-1.4 test");
    const result = await printPdf(pdf, { printer: "Office", copies: 2, duplex: "long-edge", color: false, title: "A page" });
    assert.deepEqual(result, { job: "Office-42" });
    assert.deepEqual(readFileSync(join(dir, "args"), "utf8").trim().split("\n"), [
      "-d",
      "Office",
      "-n",
      "2",
      "-o",
      "sides=two-sided-long-edge",
      "-o",
      "print-color-mode=monochrome",
      "-t",
      "A page",
      "--",
      "-",
    ]);
    assert.deepEqual(readFileSync(join(dir, "input")), pdf);
    await assert.rejects(printPdf(pdf, { copies: 0 }), /copies/);
  });

  test("saves without overwriting", () => {
    const pdf = Buffer.from("%PDF-1.4 saved");
    const first = savePdf(pdf, join(dir, "out", "page.pdf"));
    assert.equal(first.path, join(dir, "out", "page.pdf"));
    const second = savePdf(pdf, join(dir, "out", "page.pdf"));
    assert.equal(second.path, join(dir, "out", "page (1).pdf"));
    assert.ok(existsSync(second.path));
    assert.equal(savePdf(pdf, first.path, { overwrite: true }).path, first.path);
    assert.throws(() => savePdf(pdf, "relative.pdf"), /absolute/);
  });

  test("names and arguments", () => {
    assert.equal(pdfFileName("A/B: <c>"), "A B c.pdf");
    assert.equal(pdfFileName(""), "page.pdf");
    assert.deepEqual(pdfArguments({ paper: "A4", margins: "minimum", background: true, pageRanges: "1-2" }), {
      paperWidth: 8.27,
      paperHeight: 11.69,
      marginTop: 0.25,
      marginBottom: 0.25,
      marginLeft: 0.25,
      marginRight: 0.25,
      printBackground: true,
      pageRanges: "1-2",
    });
    assert.throws(() => pdfArguments({ paper: "b9" }), /Unknown paper/);
  });
});

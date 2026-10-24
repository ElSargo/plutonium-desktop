import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { appMatches, DesktopApps, expandExec, filterPattern, pathPrograms } from "../src/apps.ts";

describe("Exec field codes", () => {
  const entry = (exec: string) => ({ exec, name: "Calc", icon: "calc", path: "/apps/calc.desktop" });

  test("file and URL codes go, with Flatpak's empty forwarding markers", () => {
    assert.deepEqual(
      expandExec(
        entry(
          "flatpak run --branch=stable --arch=x86_64 --command=libreoffice --file-forwarding org.libreoffice.LibreOffice --calc @@u %U @@",
        ),
      ),
      [
        "flatpak",
        "run",
        "--branch=stable",
        "--arch=x86_64",
        "--command=libreoffice",
        "--file-forwarding",
        "org.libreoffice.LibreOffice",
        "--calc",
      ],
    );
    assert.deepEqual(expandExec(entry("gimp-2.10 %f")), ["gimp-2.10"]);
    assert.deepEqual(expandExec(entry("app %F --flag %u %D")), ["app", "--flag"]);
  });

  test("%i, %c, %k, %% and quoting", () => {
    assert.deepEqual(expandExec(entry("app %i")), ["app", "--icon", "calc"]);
    assert.deepEqual(expandExec(entry('app --title=%c "--class=%k" 100%%')), [
      "app",
      "--title=Calc",
      "--class=/apps/calc.desktop",
      "100%",
    ]);
    assert.deepEqual(expandExec(entry('sh -c "echo \\"hi there\\""')), ["sh", "-c", 'echo "hi there"']);
  });
});

describe("matching", () => {
  const calc = {
    name: "LibreOffice Calc",
    genericName: "Spreadsheet",
    keywords: ["Accounting", "Stats", "OpenOffice"],
    id: "org.libreoffice.LibreOffice.calc.desktop",
    exec: "flatpak run --command=libreoffice org.libreoffice.LibreOffice --calc",
  };

  test("name, generic name, keywords, id and Exec, case-insensitively", () => {
    for (const filter of ["spreadsheet", "calc", "STATS", "LibreOffice\\.calc", "command=libreoffice", "^libre"]) {
      assert.ok(appMatches(calc, filterPattern(filter)!), filter);
    }
    for (const filter of ["writer", "^office"]) assert.ok(!appMatches(calc, filterPattern(filter)!), filter);
  });

  test("a filter that isn't a regular expression is plain text", () => {
    assert.ok(filterPattern("c++")!.test("Qt for C++"));
    assert.ok(!filterPattern("c++")!.test("ccc"));
    assert.equal(filterPattern(""), undefined);
  });
});

describe("find", () => {
  const root = mkdtempSync(join(tmpdir(), "plutonium-apps-"));
  const saved = { ...process.env };
  const desktop = (dir: string, file: string, lines: Record<string, string>) => {
    mkdirSync(join(root, dir, "applications"), { recursive: true });
    writeFileSync(
      join(root, dir, "applications", file),
      ["[Desktop Entry]", "Type=Application", ...Object.entries(lines).map(([key, value]) => `${key}=${value}`)].join(
        "\n",
      ),
    );
  };
  const program = (dir: string, name: string, mode = 0o755) => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, name), "#!/bin/sh\n");
    chmodSync(join(root, dir, name), mode);
  };

  before(() => {
    process.env.HOME = join(root, "home");
    process.env.XDG_DATA_HOME = join(root, "home/.local/share");
    process.env.XDG_DATA_DIRS = [
      join(root, "flatpak/exports/share"),
      join(root, "home/.nix-profile/share"),
      join(root, "usr/share"),
    ].join(":");
    process.env.PATH = [join(root, "bin"), join(root, "bin2")].join(":");
    desktop("flatpak/exports/share", "org.libreoffice.LibreOffice.calc.desktop", {
      Name: "LibreOffice Calc",
      GenericName: "Spreadsheet",
      Keywords: "Accounting;Stats;",
      Exec: "flatpak run --branch=stable --command=libreoffice --file-forwarding org.libreoffice.LibreOffice --calc @@u %U @@",
    });
    desktop("home/.nix-profile/share", "calc.desktop", {
      Name: "LibreOffice Calc",
      GenericName: "Spreadsheet",
      Exec: "/nix/store/abc-libreoffice/bin/libreoffice --calc %U",
    });
    desktop("usr/share", "org.gnome.Calculator.desktop", { Name: "Calculator", Exec: "gnome-calculator" });
    desktop("usr/share", "hidden.desktop", { Name: "Hidden Calc", Exec: "hidden", NoDisplay: "true" });
    desktop("home/.local/share", "mine.desktop", { Name: "My Tool", Exec: "mytool %f", Path: "/srv" });
    program("bin", "libreoffice-calc-helper");
    program("bin", "calcurse");
    program("bin2", "calcurse");
    program("bin", "calc-notes.txt", 0o644);
    for (let i = 0; i < 25; i++) program("bin2", `office-${String(i).padStart(2, "0")}`);
  });
  after(() => {
    process.env = saved;
    rmSync(root, { recursive: true, force: true });
  });

  test("both installs of one app, each with its argv and where it's from", () => {
    const found = new DesktopApps().find("spreadsheet");
    assert.deepEqual(
      found.apps.map((app) => [app.id, app.source, app.argv]),
      [
        ["calc.desktop", "nix profile", ["/nix/store/abc-libreoffice/bin/libreoffice", "--calc"]],
        [
          "org.libreoffice.LibreOffice.calc.desktop",
          "flatpak",
          [
            "flatpak",
            "run",
            "--branch=stable",
            "--command=libreoffice",
            "--file-forwarding",
            "org.libreoffice.LibreOffice",
            "--calc",
          ],
        ],
      ],
    );
    assert.equal(found.apps[0]!.genericName, "Spreadsheet");
    assert.ok(found.apps[1]!.desktopFile.endsWith("/flatpak/exports/share/applications/org.libreoffice.LibreOffice.calc.desktop"));
    assert.deepEqual(found.onPath, []);
  });

  test("hidden apps are left out; PATH programs are listed separately, once each, executables only", () => {
    const found = new DesktopApps().find("calc");
    assert.deepEqual(
      found.apps.map((app) => app.name),
      ["Calculator", "LibreOffice Calc", "LibreOffice Calc"],
    );
    assert.equal(found.apps[0]!.source, "system");
    assert.deepEqual(found.onPath, ["calcurse", "libreoffice-calc-helper"]);
  });

  test("no filter: every app, no PATH programs", () => {
    const found = new DesktopApps().find();
    assert.equal(found.apps.length, 4);
    assert.equal(found.onPath, undefined);
    const mine = found.apps.find((app) => app.id === "mine.desktop")!;
    assert.deepEqual([mine.source, mine.argv, mine.cwd], ["user", ["mytool"], "/srv"]);
  });

  test("PATH programs are capped", () => {
    const found = new DesktopApps().find("^office-");
    assert.equal(found.onPath?.length, 20);
    assert.equal(found.moreOnPath, 5);
    assert.equal(pathPrograms(/^office-/).length, 25);
  });
});

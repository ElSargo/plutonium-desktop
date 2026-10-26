// `plutonium.ts shells …`: the installed shells (shells.ts), for bin/plutonium.
//
//   shells install [--default a,b] [name…]  copy shipped shells into $PLUTO_HOME/shells
//   shells update [name…]                    merge the shipped versions into the user's copies
//   shells list [--json]
//   shells entries [name…]                   what a session opens: SHELL_URL=, SHELLS=, ORIGINS=
//
// --home (default $PLUTO_HOME or ~/.pluto), --shipped (the checkout's shells/),
// and for entries --slot, --shells-port, --helper-url, --wayland-display.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  effectiveList,
  entryUrl,
  installedShells,
  installShell,
  plutoHome,
  readList,
  readManifest,
  shellDir,
  ShellError,
  shellOrigin,
  shippedNames,
  updateShell,
  writeList,
  type ShellContext,
  type ShellListEntry,
} from "./shells.ts";

export const PLUTONIUM_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function shellsUsage(): never {
  console.error(
    "usage: plutonium.ts shells install [--default <name>,…] [name…]\n" +
      "       plutonium.ts shells update [name…]\n" +
      "       plutonium.ts shells list [--json]\n" +
      "       plutonium.ts shells entries [--safe] [name…]   (--slot, --shells-port, --helper-url, --wayland-display)\n" +
      "       (all take --home <dir> and --shipped <dir>)",
  );
  process.exit(2);
}

export function runShellsCommand(args: string[]): number {
  const [command, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      home: { type: "string" },
      shipped: { type: "string" },
      default: { type: "string" },
      json: { type: "boolean" },
      safe: { type: "boolean" },
      slot: { type: "string" },
      "shells-port": { type: "string" },
      "helper-url": { type: "string" },
      "helper-socket": { type: "string" },
      "wayland-display": { type: "string" },
    },
  });
  const home = values.home ?? plutoHome();
  const shipped = values.shipped ?? join(PLUTONIUM_ROOT, "shells");
  try {
    switch (command) {
      case "install": {
        const names = positionals.length ? positionals : shippedNames(shipped);
        for (const name of names) {
          if (installShell(home, shipped, name)) console.log(`installed ${name} in ${shellDir(home, name)}`);
        }
        if (!readList(home)) {
          const wanted = (values.default ?? "").split(",").filter(Boolean);
          const list: ShellListEntry[] = wanted.map((name) => ({ name, enabled: true }));
          writeList(home, [...list, ...effectiveList(home).filter((e) => !wanted.includes(e.name))]);
        }
        return 0;
      }
      case "update": {
        let failed = 0;
        const shippedSet = new Set(shippedNames(shipped));
        const names = positionals.length
          ? positionals
          : installedShells(home)
              .map((shell) => shell.name)
              .filter((name) => shippedSet.has(name));
        for (const name of names) {
          const result = updateShell(home, shipped, name);
          if (result.status === "up-to-date") console.log(`${name}: up to date`);
          else if (result.status === "updated") console.log(`${name}: updated to ${result.version}`);
          else {
            failed++;
            console.log(
              `${name}: ${result.version} conflicts with your changes in ${result.files.join(", ")}; ` +
                `your copy is as it was. Merge it by hand: cd ${shellDir(home, name)} && git merge shipped`,
            );
          }
        }
        return failed ? 1 : 0;
      }
      case "list": {
        const list = effectiveList(home);
        const shells = installedShells(home).map((shell) => ({
          name: shell.name,
          title: shell.manifest?.title,
          kind: shell.manifest ? (shell.manifest.static ? "static" : `server (${shell.manifest.server!.run})`) : "broken",
          enabled: list.find((entry) => entry.name === shell.name)?.enabled ?? false,
          order: list.findIndex((entry) => entry.name === shell.name),
          dir: shell.dir,
          ...(shell.error ? { error: shell.error } : {}),
        }));
        if (values.json) console.log(JSON.stringify(shells, null, 2));
        else {
          shells.sort((a, b) => (a.order < 0 ? 1e9 : a.order) - (b.order < 0 ? 1e9 : b.order));
          for (const shell of shells) {
            console.log(
              `${shell.enabled ? "on " : "off"}  ${shell.name.padEnd(12)} ${shell.kind.padEnd(20)} ${shell.error ?? shell.dir}`,
            );
          }
        }
        return 0;
      }
      case "entries": {
        const context: ShellContext = {
          home,
          slot: Number(values.slot ?? 0),
          shellsPort: Number(values["shells-port"] ?? 8770),
          helperUrl: values["helper-url"] ?? "http://127.0.0.1:3780",
          plutonium: PLUTONIUM_ROOT,
          ...(values["helper-socket"] ? { helperSocket: values["helper-socket"] } : {}),
          ...(values["wayland-display"] ? { waylandDisplay: values["wayland-display"] } : {}),
        };
        let list: ShellListEntry[];
        if (values.safe) {
          // The shipped plain shell, from the checkout (served as safe.localhost).
          const manifest = { ...readManifest(join(shipped, "plain"), "plain"), name: "safe", title: "Safe mode" };
          printEntries([[manifest.title, true, entryUrl(manifest, context)]]);
          return 0;
        }
        if (positionals.length) list = positionals.map((name) => ({ name, enabled: true }));
        else list = effectiveList(home);
        if (!list.some((entry) => entry.enabled)) throw new ShellError(`no shell is on in ${join(home, "shells.json")}`);
        printEntries(
          list.map((entry) => {
            const manifest = readManifest(shellDir(home, entry.name), entry.name);
            // An off shell's URL is only listed: no entry command (pairing) for it.
            const url = entry.enabled ? entryUrl(manifest, context) : shellOrigin(manifest, context) + "/";
            return [manifest.title, entry.enabled, url];
          }),
        );
        return 0;
      }
      default:
        shellsUsage();
    }
  } catch (error) {
    if (!(error instanceof ShellError)) throw error;
    console.error(`plutonium: ${error.message}`);
    return 1;
  }
}

/**
 * The launcher's variables, one per line: the first shell that's on is the
 * startup shell; SHELLS lists them all, in order, with their names, "!"
 * before the ones that are off (--plutonium-shells-exact); ORIGINS are the
 * ones that are on, the startup shell's first.
 */
function printEntries(entries: [title: string, enabled: boolean, url: string][]): void {
  const first = entries.findIndex(([, enabled]) => enabled);
  console.log(`SHELL_URL=${entries[first]![2]}`);
  console.log(`SHELLS=${entries.map(([title, enabled, url]) => `${enabled ? "" : "!"}${title}=${url}`).join("|")}`);
  console.log(
    `ORIGINS=${[...new Set(entries.filter(([, enabled]) => enabled).map(([, , url]) => new URL(url).origin))].join(",")}`,
  );
}

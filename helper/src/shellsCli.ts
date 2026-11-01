// `plutonium.ts shells …`: the installed shells (shells.ts), for bin/plutonium.
//
//   shells install [name…]    copy shipped shells into $PLUTO_HOME/shells
//   shells update [name…]     merge the shipped versions into the user's copies
//   shells sync               both, for every shipped shell (a session's start)
//   shells list [--json]
//   shells check              the server shells that can't run here, and why
//   shells entries [name|name=url…]  what a session opens: SHELL_URL=, SHELLS=, ORIGINS=
//
// --home (default $PLUTO_HOME or ~/.pluto), --shipped (the checkout's shells/),
// and for entries --slot, --shells-port, --helper-url, --wayland-display.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  baseUrl,
  checkShell,
  effectiveList,
  entryUrl,
  installedShells,
  installShell,
  migrateRenamed,
  plutoHome,
  readList,
  readManifest,
  shellDir,
  ShellError,
  shippedManifest,
  shippedNames,
  updateShell,
  withHelper,
  writeList,
  type ShellContext,
  type ShellListEntry,
} from "./shells.ts";

export const PLUTONIUM_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function shellsUsage(): never {
  console.error(
    "usage: plutonium.ts shells install [name…]\n" +
      "       plutonium.ts shells update [name…]\n" +
      "       plutonium.ts shells sync\n" +
      "       plutonium.ts shells list [--json]\n" +
      "       plutonium.ts shells check\n" +
      "       plutonium.ts shells entries [--safe] [name|name=url…]   (--slot, --shells-port, --helper-url, --wayland-display)\n" +
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
  const context: ShellContext = {
    home,
    slot: Number(values.slot ?? 0),
    shellsPort: Number(values["shells-port"] ?? 8770),
    helperUrl: values["helper-url"] ?? "http://127.0.0.1:3780",
    plutonium: PLUTONIUM_ROOT,
    ...(values["helper-socket"] ? { helperSocket: values["helper-socket"] } : {}),
    ...(values["wayland-display"] ? { waylandDisplay: values["wayland-display"] } : {}),
  };
  try {
    switch (command) {
      case "install":
        install(home, shipped, positionals.length ? positionals : shippedNames(shipped), context);
        return 0;
      case "update":
        return update(home, shipped, positionals.length ? positionals : shippedInstalled(home, shipped), false);
      case "sync": {
        // A session's start: the shipped shells as this install ships them,
        // merged into the user's copies (their edits kept); quiet when nothing changed.
        for (const move of migrateRenamed(home, shipped)) console.log(`moved your shell ${move}`);
        install(home, shipped, shippedNames(shipped), context);
        update(home, shipped, shippedInstalled(home, shipped), true);
        return 0;
      }
      case "check": {
        for (const shell of installedShells(home)) {
          const why = shell.manifest ? checkShell(shell.manifest, context) : shell.error;
          if (why) console.log(`${shell.name}: ${why}`);
        }
        return 0;
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
          list.map((entry): [string, boolean, string] => {
            // <name>=<url>: any page; an installed shell's name gives it that
            // shell's title and helper parameter (a dev server of the shell).
            const eq = entry.name.indexOf("=");
            if (eq > 0) {
              const [name, url] = [entry.name.slice(0, eq), entry.name.slice(eq + 1)];
              try {
                const manifest = readManifest(shellDir(home, name), name);
                return [manifest.title, true, withHelper(url, manifest, context)];
              } catch {
                return [name, true, url];
              }
            }
            const manifest = readManifest(shellDir(home, entry.name), entry.name);
            // An off shell's URL is only listed: no entry command (pairing) for it.
            // It still names the helper, so the page finds it once switched on.
            const url = entry.enabled
              ? entryUrl(manifest, context)
              : withHelper(baseUrl(manifest, context), manifest, context);
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

const shippedInstalled = (home: string, shipped: string) => {
  const shippedSet = new Set(shippedNames(shipped));
  return installedShells(home)
    .map((shell) => shell.name)
    .filter((name) => shippedSet.has(name));
};

/**
 * Installs the shipped shells that aren't installed. The first time, the list
 * turns on those whose manifest says "default", in its order, if they can run
 * here (a server shell's check).
 */
function install(home: string, shipped: string, names: readonly string[], context: ShellContext): void {
  for (const name of names) {
    if (installShell(home, shipped, name)) console.log(`installed ${name} in ${shellDir(home, name)}`);
  }
  if (readList(home)) return;
  const wanted = shippedNames(shipped)
    .map((name) => ({ name, manifest: shippedManifest(shipped, name) }))
    .filter(({ name, manifest }) => manifest.default !== undefined && existsSync(shellDir(home, name)))
    .filter(({ name }) => {
      const why = checkShell(readManifest(shellDir(home, name), name), context);
      if (why) console.log(`${name} stays off: ${why}`);
      return !why;
    })
    .sort((a, b) => a.manifest.default! - b.manifest.default!)
    .map(({ name }) => name);
  const list: ShellListEntry[] = wanted.map((name) => ({ name, enabled: true }));
  writeList(home, [...list, ...effectiveList(home).filter((e) => !wanted.includes(e.name))]);
}

/** Merges the shipped versions in; `quiet` leaves out the ones up to date. Returns 1 if any conflicted. */
function update(home: string, shipped: string, names: readonly string[], quiet: boolean): number {
  let failed = 0;
  for (const name of names) {
    const result = updateShell(home, shipped, name);
    if (result.status === "up-to-date") {
      if (!quiet) console.log(`${name}: up to date`);
    } else if (result.status === "updated") console.log(`${name}: updated to the shipped ${result.version}`);
    else {
      failed++;
      console.log(
        `${name}: the shipped ${result.version} conflicts with your changes in ${result.files.join(", ")}; ` +
          `your copy is as it was. Merge it by hand: cd ${shellDir(home, name)} && git merge shipped`,
      );
    }
  }
  return failed ? 1 : 0;
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

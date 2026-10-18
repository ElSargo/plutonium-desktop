// Links from a thread's apps open as tabs in the shell, in that thread.
//
// Every way a Linux app opens a link leads to `plutonium.ts open`, which asks
// the helper for a tab in the caller's thread ($PLUTONIUM_THREAD_ID):
//   - xdg-open, x-www-browser, sensible-browser and www-browser: wrappers
//     first on the thread's PATH (terminals, Electron, most toolkits' fallback);
//   - $BROWSER (Python's webbrowser, git, gh, …);
//   - the desktop file of the user's default browser: a copy with the same id
//     first in the thread's XDG_DATA_DIRS, whose Exec opens a tab. GIO (GTK,
//     Firefox) and KIO (Qt/KDE, including kdeglobals' BrowserApplication)
//     look the browser up by id, so they find this one.
// Anything that isn't a web link goes to the real xdg-open with the thread's
// environment, so the app it starts belongs to the thread too.
//
// A tab is brought to the front only when the user started the caller
// (PLUTONIUM_SHOW, as on a terminal's processes); an agent's links wait in
// the thread.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { helperJson } from "./client.ts";
import { wantsShow } from "./threads.ts";

/** Where a thread's processes find the opener scripts (to step around them). */
export const OPENERS_VARIABLE = "PLUTONIUM_OPENERS";
const THREAD_ID_VARIABLE = "PLUTONIUM_THREAD_ID";
const COMMANDS = ["xdg-open", "x-www-browser", "sensible-browser", "www-browser", "plutonium-open"];
const BROWSER_TYPES = ["x-scheme-handler/http", "x-scheme-handler/https", "text/html"];

export interface Openers {
  readonly binDir: string;
  readonly dataDir: string;
}

const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

function writeAtomic(path: string, content: string, mode: number): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode });
  renameSync(temporary, path);
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Desktop file ids the user's settings name as the web browser. */
export function defaultBrowserIds(): string[] {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const configDirs = (process.env.XDG_CONFIG_DIRS || "/etc/xdg").split(delimiter).filter(Boolean);
  const ids = new Set<string>();
  for (const directory of [configHome, ...configDirs]) {
    let section = "";
    for (const line of readText(join(directory, "mimeapps.list")).split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("[")) section = trimmed;
      const [key, value] = trimmed.split("=", 2);
      if (section !== "[Default Applications]" || !value || !BROWSER_TYPES.includes(key!)) continue;
      for (const id of value.split(";")) if (id.endsWith(".desktop")) ids.add(id);
    }
  }
  // KIO asks kdeglobals before the mime defaults.
  const kde = readText(join(configHome, "kdeglobals")).match(/^BrowserApplication=(.+\.desktop)\s*$/m);
  if (kde) ids.add(kde[1]!);
  return [...ids].filter((id) => /^[\w.-]+\.desktop$/.test(id));
}

/** Writes the scripts and desktop files under `baseDir` (shared by every helper of the user). */
export function installOpeners(baseDir: string, node: string, cli: string): Openers {
  const binDir = join(baseDir, "bin");
  const dataDir = join(baseDir, "share");
  const applications = join(dataDir, "applications");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(applications, { recursive: true });
  const script =
    "#!/bin/sh\n" +
    "# Plutonium: opens web links as tabs in the shell (helper/src/opener.ts).\n" +
    `exec ${shellQuote(node)} ${shellQuote(cli)} open --as "\${0##*/}" "$@"\n`;
  for (const name of COMMANDS) writeAtomic(join(binDir, name), script, 0o755);
  const opener = join(binDir, "plutonium-open");
  for (const id of new Set(["plutonium-open.desktop", ...defaultBrowserIds()])) {
    writeAtomic(
      join(applications, id),
      "[Desktop Entry]\n" +
        "Type=Application\n" +
        "Name=Plutonium tab\n" +
        "Comment=Opens links as tabs in the Plutonium shell\n" +
        `Exec=${opener} %U\n` +
        "NoDisplay=true\n" +
        `MimeType=${BROWSER_TYPES.join(";")};\n`,
      0o644,
    );
  }
  return { binDir, dataDir };
}

/** What a thread's processes get, on top of the thread's other variables. */
export function openerEnvironment(openers: Openers): Record<string, string> {
  return {
    PATH: [openers.binDir, process.env.PATH ?? "/usr/bin:/bin"].join(delimiter),
    BROWSER: join(openers.binDir, "plutonium-open"),
    XDG_DATA_DIRS: [openers.dataDir, process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share"].join(delimiter),
    [OPENERS_VARIABLE]: openers.binDir,
  };
}

/** `environment` without the openers: what the user's own browser should see. */
function withoutOpeners(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const binDir = environment[OPENERS_VARIABLE];
  if (!binDir) return environment;
  const dataDir = join(binDir, "..", "share");
  const drop = (list: string | undefined, entry: string) =>
    (list ?? "")
      .split(delimiter)
      .filter((item) => item && resolve(item) !== resolve(entry))
      .join(delimiter);
  const result = { ...environment, PATH: drop(environment.PATH, binDir), XDG_DATA_DIRS: drop(environment.XDG_DATA_DIRS, dataDir) };
  delete result.BROWSER;
  delete result[OPENERS_VARIABLE];
  return result;
}

function findIn(path: string | undefined, name: string): string | undefined {
  for (const directory of (path ?? "").split(delimiter)) {
    if (directory && existsSync(join(directory, name))) return join(directory, name);
  }
  return undefined;
}

/** The URL a tab should load for `target`, or null if it isn't a web page. */
function tabUrl(target: string, anyFile: boolean): string | null {
  if (/^https?:\/\//i.test(target)) return target;
  if (!anyFile) return null;
  // Called as the browser: a local page or a file URL.
  if (/^file:\/\//i.test(target)) return target;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(target) && existsSync(target)) return pathToFileURL(resolve(target)).href;
  return null;
}

function run(program: string, args: readonly string[], environment: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((done) => {
    const child = spawn(program, args, { stdio: "inherit", env: environment });
    child.once("error", (error) => {
      console.error(`plutonium open: ${program}: ${error.message}`);
      done(1);
    });
    child.once("exit", (code) => done(code ?? 1));
  });
}

/**
 * `plutonium.ts open [--as <name>] <target>…`. As xdg-open, web links become
 * tabs and everything else goes to the real xdg-open. As the browser
 * (plutonium-open, $BROWSER, the desktop file), local pages become tabs too.
 */
export async function runOpen(args: readonly string[], socketPath: string): Promise<number> {
  let as = "plutonium-open";
  let targets = [...args];
  if (targets[0] === "--as") {
    as = targets[1] ?? as;
    targets = targets.slice(2);
  }
  const asBrowser = as !== "xdg-open";
  const thread = process.env[THREAD_ID_VARIABLE];
  // xdg-open's own options (--help, --version, --manual) are the real one's.
  const passThrough = targets.length === 0 || targets.some((target) => target.startsWith("--"));
  let status = 0;
  for (const target of passThrough ? [] : targets) {
    const url = tabUrl(target, asBrowser);
    if (url && thread) {
      try {
        await helperJson(socketPath, "POST", `/v1/threads/${encodeURIComponent(thread)}/tabs`, {
          url,
          focus: wantsShow(process.env),
          waitMs: 0,
        });
        continue;
      } catch (error) {
        console.error(`plutonium open: no tab for ${url} (${(error as Error).message}); using the browser`);
      }
    }
    // Not a web link (the thread's environment goes along, so the app it
    // starts is the thread's), or no shell: the user's own handler.
    const environment = url ? withoutOpeners(process.env) : process.env;
    const xdgOpen = findIn(withoutOpeners(process.env).PATH, "xdg-open");
    if (!xdgOpen) {
      console.error("plutonium open: no xdg-open on PATH");
      return 3;
    }
    status ||= await run(xdgOpen, [target], environment);
  }
  if (passThrough) {
    const xdgOpen = findIn(withoutOpeners(process.env).PATH, "xdg-open");
    if (!xdgOpen) return 3;
    return run(xdgOpen, targets, process.env);
  }
  return status;
}

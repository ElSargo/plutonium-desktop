// Pluto Vim's config (PLUTO_VIM.md, init.js, step 4): $PLUTO_HOME/vim/init.js
// and the plugins it imports, for every page's engine.
//
// - Bundling. A page's isolated world runs classic scripts, not ES modules,
//   so init.js and the files it imports become one script, as vimBundle.ts
//   does for the engine: each module a function returning its exports. Only
//   relative imports of files in the folder (`./plugins/surround.js`); the
//   world has no network of its own. Lines stay where they were, so an error's
//   line is the file's.
// - Checking. Before a version reaches a page, it runs in Node, in a fresh
//   context, against the real engine: configure() throws for anything wrong
//   (a bad option, a mode, a mapping), and says what's legal but likely not
//   meant (warnings). `plutonium vim check` is this.
// - Saving. A version that checks is committed in the folder's own git, as a
//   shell's edits are (SHELL_PACKAGES.md), and becomes the one pages run. One
//   that doesn't leaves the last good one running, with a notification.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createContext, runInContext } from "node:vm";

import { commitEdits, git } from "./shells.ts";
import { vimBundle } from "./vimBundle.ts";

export const configDir = (home: string) => join(home, "vim");
export const INIT = "init.js";

const STARTER = `// Pluto Vim's config (docs/features/PLUTO_VIM.md, "init.js"). Saving it
// applies it to every page; \`plutonium vim check\` reports mistakes first.
// Each saved version that works is committed in this folder's git.

export default function setup(vim) {
  // vim.opt.startInInsert = true;
  // vim.opt.clipboard = "unnamedplus";
  // vim.keymap.set("i", "jk", "<Esc>");
  // vim.keymap.set("n", "Y", "y$");
}
`;

export class VimConfigError extends Error {}

/** A module's id: its path in the folder, with "/" ("plugins/surround.js"). */
function idOf(dir: string, file: string): string {
  return relative(dir, file).split(sep).join("/");
}

/** The file a relative import names, which must be in the folder. */
function resolveImport(dir: string, from: string, spec: string): string {
  if (!spec.startsWith("./") && !spec.startsWith("../")) {
    throw new VimConfigError(`${idOf(dir, from)}: imports ${JSON.stringify(spec)}; a plugin is a file in ${dir}, imported by a relative path ("./plugins/x.js")`);
  }
  const file = resolve(dirname(from), spec);
  if (!file.startsWith(dir + sep)) throw new VimConfigError(`${idOf(dir, from)}: imports ${spec}, which is outside ${dir}`);
  if (!existsSync(file)) throw new VimConfigError(`${idOf(dir, from)}: imports ${spec}, which isn't there`);
  return file;
}

const IMPORT = /^import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s+as\s+([\w$]+))?\s*(?:from\s+)?(["'])([^"']+)\4\s*;?/gm;

interface Module {
  readonly id: string;
  readonly file: string;
  readonly code: string;
}

/** One module as a function of the others: imports read them, exports are what it returns. Lines stay put. */
function wrapModule(dir: string, file: string, source: string, deps: Set<string>): string {
  const id = idOf(dir, file);
  const exported: string[] = [];
  let body = source.replace(IMPORT, (_all, def: string | undefined, named: string | undefined, star: string | undefined, _q, spec: string) => {
    const dep = resolveImport(dir, file, spec);
    deps.add(dep);
    const from = `__mods[${JSON.stringify(idOf(dir, dep))}]`;
    const parts: string[] = [];
    if (def) parts.push(`const ${def} = ${from}.default;`);
    if (named != null) parts.push(`const {${named.replace(/\b([\w$]+)\s+as\s+([\w$]+)\b/g, "$1: $2")}} = ${from};`);
    if (star) parts.push(`const ${star} = ${from};`);
    return parts.join(" ");
  });
  body = body
    .replace(/^export\s+default\s+((?:async\s+)?function\*?\s+([\w$]+)|class\s+([\w$]+))/gm, (_all, decl: string, fn?: string, cls?: string) => {
      exported.push(`default: ${fn ?? cls}`);
      return decl;
    })
    .replace(/^export\s+default\s+/gm, () => {
      exported.push("default: __default");
      return "const __default = ";
    })
    .replace(/^export\s+((?:async\s+)?function\*?\s+|class\s+|const\s+|let\s+|var\s+)([\w$]+)/gm, (_all, kind: string, name: string) => {
      exported.push(name);
      return `${kind}${name}`;
    })
    .replace(/^export\s*\{([^}]*)\}\s*;?/gm, (_all, names: string) => {
      for (const part of names.split(",").map((s) => s.trim()).filter(Boolean)) {
        const m = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(part);
        if (!m) throw new VimConfigError(`${id}: can't read the export { ${part} }`);
        exported.push(m[2] ? `${m[2] === "default" ? "default" : m[2]}: ${m[1]}` : m[1]);
      }
      return "";
    });
  const left = /^\s*(import\s|export\s)/m.exec(body);
  if (left) {
    const line = body.slice(0, left.index).split("\n").length;
    throw new VimConfigError(
      `${id}:${line}: an import or export Pluto Vim can't bundle (${body.slice(left.index, body.indexOf("\n", left.index + 1)).trim()}); ` +
        "it reads import x / { a, b } / * as ns from \"./file.js\", and export default, export function / class / const / let, export { a, b }",
    );
  }
  return `__mods[${JSON.stringify(id)}] = (() => { "use strict"; ${body}\nreturn { ${exported.join(", ")} };\n})();\n`;
}

/** init.js and what it imports, each after the modules it imports. Null if there's no init.js. */
export function configModules(dir: string): Module[] | null {
  const root = join(dir, INIT);
  if (!existsSync(root)) return null;
  const order: Module[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (file: string, chain: string[]) => {
    if (state.get(file) === "done") return;
    if (state.get(file) === "visiting") throw new VimConfigError(`imports go round in a circle: ${[...chain, file].map((f) => idOf(dir, f)).join(" → ")}`);
    state.set(file, "visiting");
    const deps = new Set<string>();
    const code = wrapModule(dir, file, readFileSync(file, "utf8"), deps);
    for (const dep of deps) visit(dep, [...chain, file]);
    state.set(file, "done");
    order.push({ id: idOf(dir, file), file, code });
  };
  visit(root, []);
  return order;
}

/** The config as an expression: init.js's default export (setup), or null when there's no init.js. */
export function configExpression(dir: string): string {
  const modules = configModules(dir);
  if (!modules) return "null";
  return ["(() => {", "const __mods = {};", ...modules.map((m) => m.code), `return __mods[${JSON.stringify(INIT)}].default;`, "})()"].join("\n");
}

export interface CheckResult {
  readonly ok: boolean;
  readonly errors: string[];
  readonly warnings: string[];
  /** What it sets up: "3 mappings, 1 command". */
  readonly summary: string;
}

/**
 * Loads the config in a dry run, in a fresh Node context with the engine
 * (web/vim), as a page's world would: errors (with the file and line where
 * Node can tell) and warnings. `dir` defaults to configDir's.
 */
export function checkConfig(dir: string, engineDir: string): CheckResult {
  const errors: string[] = [];
  const logged: string[] = [];
  const context = createContext({
    console: { log: (...a: unknown[]) => logged.push(a.join(" ")), warn: (...a: unknown[]) => logged.push(a.join(" ")), error: (...a: unknown[]) => logged.push(a.join(" ")), info: () => {}, debug: () => {} },
    setTimeout,
    clearTimeout,
    queueMicrotask,
  });
  try {
    runInContext(vimBundle(engineDir), context, { filename: "pluto-vim-engine.js" });
  } catch (error) {
    return { ok: false, errors: [`the engine didn't load: ${(error as Error).message}`], warnings: [], summary: "" };
  }
  let modules: Module[] | null;
  try {
    modules = configModules(dir);
  } catch (error) {
    return { ok: false, errors: [(error as Error).message], warnings: [], summary: "" };
  }
  if (!modules) return { ok: true, errors: [], warnings: [], summary: `no ${INIT}: the defaults` };
  runInContext("globalThis.__mods = {};", context);
  for (const m of modules) {
    try {
      runInContext(m.code, context, { filename: m.file });
    } catch (error) {
      errors.push(describe(error, m.file));
      return { ok: false, errors, warnings: [], summary: "" };
    }
  }
  try {
    const result = runInContext(
      `(() => {
        const setup = __mods[${JSON.stringify(INIT)}].default;
        if (setup === undefined) throw new Error("pluto vim: init.js: it has no default export: export default function setup(vim) { … }");
        const vim = new plutoVim.Vim();
        const { warnings } = plutoVim.configure(vim, setup);
        const maps = Object.values(vim.keymaps).reduce((n, m) => n + m.size, 0);
        return { warnings, counts: [[maps, "mapping"], [vim.user.motions.length, "motion"], [vim.user.ops.size, "operator"],
          [Object.keys(vim.user.objects).length, "text object"], [vim.user.commands.size, "command"], [vim.rules.length, "rule"]] };
      })()`,
      context,
      { filename: "pluto-vim-check.js" },
    ) as { warnings: string[]; counts: [number, string][] };
    const parts = result.counts.filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}${n === 1 ? "" : "s"}`);
    return { ok: true, errors, warnings: [...result.warnings], summary: parts.length ? parts.join(", ") : "options only" };
  } catch (error) {
    errors.push(describe(error, join(dir, INIT)));
    return { ok: false, errors, warnings: [], summary: "" };
  }
}

/** An error, with where it was thrown in the user's files when the stack says. */
function describe(error: unknown, fallbackFile: string): string {
  const e = error as Error;
  const message = e?.message ?? String(error);
  const dir = dirname(fallbackFile);
  // A syntax error's stack starts "file:line"; a thrown one's has "at … (file:line:column)".
  const at = /^((?:\/[^\n:]+)+):(\d+)\n/.exec(e?.stack ?? "") ?? /\(?((?:\/[^\s:()]+)+):(\d+):(\d+)\)?/.exec(e?.stack ?? "");
  if (at && at[1].startsWith(dir) && !at[1].endsWith("pluto-vim-engine.js")) return `${idOf(dir, at[1])}:${at[2]}: ${message}`;
  return message;
}

export interface VimConfigOptions {
  readonly home: string;
  /** web/vim, for the dry run. */
  readonly engineDir: string;
  /** A new good version: its expression (configExpression), for every page. */
  readonly onChange: (expression: string) => void;
  readonly notify?: (summary: string, body: string) => void;
  readonly log?: (message: string) => void;
}

const DEBOUNCE_MS = 150;

/** The config folder, watched: each save checked, committed if good, and handed on. */
export class VimConfig {
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private good = "null";
  private readonly options: VimConfigOptions;

  constructor(options: VimConfigOptions) {
    this.options = options;
  }

  get dir(): string {
    return configDir(this.options.home);
  }

  /** The good version's expression, for a page that opens. */
  get expression(): string {
    return this.good;
  }

  /** Makes the folder (with a starter init.js and its git) if it isn't there, loads it, and watches it. */
  start(): void {
    const dir = this.dir;
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, INIT), STARTER);
    }
    if (!existsSync(join(dir, ".git"))) {
      git(dir, ["init", "-q"]);
      commitEdits(dir, "pluto vim");
    }
    this.load(false);
    this.watch();
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
  }

  private watch(): void {
    try {
      this.watcher = watch(this.dir, { recursive: true }, (_event, file) => {
        if (!file || file === ".git" || String(file).startsWith(".git/") || String(file).startsWith(".git\\")) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          // An editor's save by rename leaves the watcher on the old file: watched afresh.
          this.watcher?.close();
          this.watch();
          this.load(true);
        }, DEBOUNCE_MS);
      });
      this.watcher.on("error", () => {
        this.watcher?.close();
        setTimeout(() => this.watch(), 500).unref();
      });
    } catch (error) {
      this.options.log?.(`pluto vim: can't watch ${this.dir}: ${(error as Error).message}`);
    }
  }

  /** Checks the folder as it is; a good version is committed and handed on, a bad one leaves the last good one. */
  load(saved: boolean): CheckResult {
    const { log, notify, onChange, engineDir } = this.options;
    const result = checkConfig(this.dir, engineDir);
    if (result.ok) {
      this.good = configExpression(this.dir);
      try {
        commitEdits(this.dir, "pluto vim");
      } catch (error) {
        log?.(`pluto vim: couldn't commit ${this.dir}: ${(error as Error).message}`);
      }
      log?.(`pluto vim: init.js ${saved ? "reloaded" : "loaded"} (${result.summary})${result.warnings.length ? `; ${result.warnings.length} warning(s): ${result.warnings.join("; ")}` : ""}`);
      onChange(this.good);
      return result;
    }
    log?.(`pluto vim: init.js has errors, so the last good version stays: ${result.errors.join("; ")}`);
    notify?.("Pluto Vim: init.js has an error", `${result.errors[0]}\nThe last version that worked stays on. plutonium vim check says more.`);
    if (this.good === "null" && !saved) this.good = this.lastCommitted();
    if (!saved) onChange(this.good);
    return result;
  }

  /** The newest committed version that checks, when the folder as it is doesn't (at start). */
  private lastCommitted(): string {
    let tmp: string | undefined;
    try {
      const commits = git(this.dir, ["rev-list", "--max-count=20", "HEAD"]).trim().split("\n").filter(Boolean);
      for (const commit of commits) {
        tmp = mkdtempSync(join(tmpdir(), "pluto-vim-"));
        execFileSync("sh", ["-c", `git -C "$1" archive "$2" | tar -x -C "$3"`, "sh", this.dir, commit, tmp]);
        const ok = checkConfig(tmp, this.options.engineDir).ok;
        const expression = ok ? configExpression(tmp) : null;
        rmSync(tmp, { recursive: true, force: true });
        tmp = undefined;
        if (expression) {
          this.options.log?.(`pluto vim: running init.js as of ${commit.slice(0, 8)}`);
          return expression;
        }
      }
    } catch (error) {
      this.options.log?.(`pluto vim: no committed init.js to fall back on: ${(error as Error).message}`);
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
    return "null";
  }
}

// Turns parts into the source the helper injects (injector.ts). A part's
// script is an ES module whose default export gets `site`; it's wrapped as a
// function in the injected source (not a string the page could refuse to
// evaluate under its CSP). Its syntax is checked here first, so one broken
// part can't stop the others.
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

import type { TabContext } from "./context.ts";
import type { Part, Scope } from "./store.ts";

export const RUNTIME_SOURCE = readFileSync(new URL("./runtime.js", import.meta.url), "utf8");

/** What a part's script can't use yet. */
const IMPORT = /^\s*import\s[^(]/m;
const EXPORT_DEFAULT = /\bexport\s+default\s+/;
const OTHER_EXPORT = /^\s*export\s+(?!default\b)/m;

export interface CompiledPart {
  readonly part: Part;
  /** The function's source: `function (site, exports) { ... }`, or null with no script. */
  readonly run: string | null;
  readonly error: string | null;
}

export function compilePart(part: Part): CompiledPart {
  if (part.js === null) return { part, run: null, error: null };
  if (IMPORT.test(part.js)) {
    return { part, run: null, error: "A part's script can't import modules yet: put what it needs in the file." };
  }
  if (OTHER_EXPORT.test(part.js)) {
    return { part, run: null, error: "Only `export default` is supported in a part's script." };
  }
  const body = part.js.replace(EXPORT_DEFAULT, "exports.default = ");
  // Not strict: an imported user script is a classic script, and may need sloppy mode.
  const run = `function (site, exports) {\n${body}\n}`;
  try {
    new Script(`(${run})`, { filename: `${part.id}.js` });
  } catch (error) {
    return { part, run: null, error: `${part.id}.js: ${(error as Error).message}` };
  }
  return { part, run, error: null };
}

export interface RuntimeTheme {
  readonly scheme: "light" | "dark";
  readonly tokens: Readonly<Record<string, string>>;
}

export interface RuntimeData {
  readonly context?: TabContext;
  readonly theme?: RuntimeTheme;
  /** Parts, with the site scope each comes from. */
  readonly parts?: readonly { readonly compiled: CompiledPart; readonly siteScope: Scope; readonly matches: readonly string[]; readonly excludes: readonly string[] }[];
}

/** The data as a JavaScript expression (parts' functions inline). */
export function dataSource(data: RuntimeData): string {
  const fields: string[] = [];
  if (data.context) fields.push(`context: ${JSON.stringify(data.context)}`);
  if (data.theme) fields.push(`theme: ${JSON.stringify(data.theme)}`);
  if (data.parts) {
    const parts = data.parts
      .filter(({ compiled }) => !compiled.error && (compiled.run || compiled.part.css !== null))
      .map(({ compiled, siteScope, matches, excludes }) => {
        const { part } = compiled;
        const plain = JSON.stringify({
          id: part.id,
          site: part.site,
          name: part.name,
          hash: part.hash,
          spec: part.spec,
          siteScope,
          matches,
          excludes,
          css: part.css,
        });
        return `Object.assign(${plain}, { run: ${compiled.run ?? "null"} })`;
      });
    fields.push(`parts: [\n${parts.join(",\n")}\n]`);
  }
  return `{ ${fields.join(", ")} }`;
}

/** What runs at document start: the runtime, then boot. */
export function bootSource(data: RuntimeData): string {
  return `${RUNTIME_SOURCE}\n;globalThis.__plutoniumSites.boot(${dataSource(data)});\n//# sourceURL=plutonium-sites/boot.js\n`;
}

/** What updates a page that's already loaded (and boots one that never ran the runtime). */
export function updateSource(data: RuntimeData): string {
  return `${RUNTIME_SOURCE}\n;globalThis.__plutoniumSites.update(${dataSource(data)});\n//# sourceURL=plutonium-sites/update.js\n`;
}

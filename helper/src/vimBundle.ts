// Pluto Vim's engine as one classic script (PLUTO_VIM.md, step 3): what the
// helper injects into each frame's isolated world over DevTools
// (Page.addScriptToEvaluateOnNewDocument with a worldName), which runs a
// script, not ES modules. Each module of web/vim becomes a function returning
// its exports, in dependency order; the result sets `plutoVim` on the world's
// global (the isolated world's, which the page can't see).
//
// It knows only the import and export forms web/vim uses, and says so for any
// other, rather than guessing.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** web/vim's modules, each after the ones it imports. */
export const VIM_MODULES = ["text.js", "keys.js", "registers.js", "remoteStore.js", "commands.js", "userBuffer.js", "engine.js", "api.js", "stringBuffer.js", "dom.js"];

function wrap(name: string, source: string): string {
  const exported: string[] = [];
  const body = source
    .replace(/^import \* as (\w+) from "\.\/([\w.]+)";$/gm, (_, local, file) => `const ${local} = __pvim[${JSON.stringify(file)}];`)
    .replace(/^import \{([^}]+)\} from "\.\/([\w.]+)";$/gm, (_, names: string, file) =>
      `const {${names.replace(/\b(\w+) as (\w+)\b/g, "$1: $2")}} = __pvim[${JSON.stringify(file)}];`)
    .replace(/^export ((?:async )?function\*? |class |const |let )(\w+)/gm, (_, kind, id) => {
      exported.push(id);
      return `${kind}${id}`;
    })
    .replace(/^export \* as (\w+) from "\.\/([\w.]+)";$/gm, (_, local, file) => {
      exported.push(local);
      return `const ${local} = __pvim[${JSON.stringify(file)}];`;
    });
  const left = /^(import |export )/m.exec(body);
  if (left) throw new Error(`vimBundle: ${name} has an import or export it can't bundle: ${body.slice(left.index, body.indexOf("\n", left.index))}`);
  return `__pvim[${JSON.stringify(name)}] = (() => {\n${body}\nreturn { ${exported.join(", ")} };\n})();\n`;
}

/** The bundle of the modules in `dir` (web/vim). */
export function vimBundle(dir: string): string {
  const parts = VIM_MODULES.map((name) => wrap(name, readFileSync(join(dir, name), "utf8")));
  return [
    "// Pluto Vim's engine, bundled by the helper (src/vimBundle.ts) from web/vim.",
    "(() => {",
    "const __pvim = {};",
    ...parts,
    // text.js's helpers (next, prev, …) stay in their own namespace; the rest have distinct names.
    'const { "text.js": text, ...rest } = __pvim;',
    "globalThis.plutoVim = Object.assign({ text }, ...Object.values(rest));",
    "})();",
    "",
  ].join("\n");
}

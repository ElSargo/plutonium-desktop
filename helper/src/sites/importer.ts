// Importing user scripts and user styles (SITE_EXTENSIONS.md, "Importing and
// sharing"). A user script's `// ==UserScript==` header becomes a part of the
// site it matches, its code wrapped so GM_addStyle, GM_getValue/GM_setValue
// (and GM.*), GM_xmlhttpRequest and GM_info go to site.css, site.storage and
// site.fetch. A UserCSS file (`/* ==UserStyle==`) or `@-moz-document` blocks
// become a part's stylesheet.
import { SiteError } from "./store.ts";

export interface Imported {
  /** The site's folder name (its host). */
  readonly site: string;
  readonly part: string;
  readonly title: string;
  /** Match patterns for the site (added to its site.json). */
  readonly matches: readonly string[];
  readonly excludes: readonly string[];
  readonly runAt: "start" | "ready" | "idle";
  readonly js: string | null;
  readonly css: string | null;
  /** What wasn't carried over, for the user. */
  readonly notes: readonly string[];
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "imported";

function header(text: string, start: RegExp, end: RegExp): Map<string, string[]> | null {
  const open = start.exec(text);
  if (!open) return null;
  const rest = text.slice(open.index + open[0].length);
  const close = end.exec(rest);
  if (!close) return null;
  const fields = new Map<string, string[]>();
  for (const line of rest.slice(0, close.index).split("\n")) {
    const field = /^\s*(?:\/\/)?\s*@([\w:-]+)\s*(.*?)\s*$/.exec(line);
    if (!field) continue;
    const list = fields.get(field[1]!) ?? [];
    list.push(field[2]!);
    fields.set(field[1]!, list);
  }
  return fields;
}

/** An @include glob as a match pattern, where it can be one. */
export function includeToMatch(glob: string): string | null {
  if (glob === "*") return "<all_urls>";
  const match = /^(\*|https?\*?|http\*):\/\/([^/]+)(\/.*)?$/.exec(glob);
  if (!match) return null;
  const scheme = match[1] === "http" || match[1] === "https" ? match[1] : "*";
  let host = match[2]!;
  if (host.startsWith("*.")) host = `*.${host.slice(2).replace(/\*/g, "")}`;
  else if (host.includes("*")) return null;
  // ".tld" wildcards (google.*) can't be a match pattern.
  if (/\.\*$/.test(match[2]!)) return null;
  return `${scheme}://${host}${match[3] ?? "/*"}`;
}

/** The host a match pattern names (without `*.`), for the site's folder. */
function patternHost(pattern: string): string | null {
  const host = /^[^:]+:\/\/([^/]+)\//.exec(pattern)?.[1];
  if (!host || host === "*") return null;
  return host.replace(/^\*\./, "").replace(/^www\./, "");
}

const RUN_AT: Record<string, Imported["runAt"]> = {
  "document-start": "start",
  "document-body": "ready",
  "document-end": "ready",
  "document-idle": "idle",
};

const GM_WRAPPER = (code: string) => `export default async function (site) {
  // The Greasemonkey API, on site.* (plutonium sites import). Its values are this
  // part's own, in the site's storage under "<part>:".
  const prefix = \`\${site.part.name}:\`;
  const values = {};
  for (const [key, value] of Object.entries((await site.storage.all()) || {})) {
    if (key.startsWith(prefix)) values[key.slice(prefix.length)] = value;
  }
  const GM_addStyle = (css) => { site.css(css); };
  const GM_getValue = (key, fallback) => (key in values ? values[key] : fallback);
  const GM_setValue = (key, value) => { values[key] = value; void site.storage.set(prefix + key, value); };
  const GM_deleteValue = (key) => { delete values[key]; void site.storage.set(prefix + key, null); };
  const GM_listValues = () => Object.keys(values);
  const GM_xmlhttpRequest = (details) => {
    site
      .fetch(details.url, { method: details.method, headers: details.headers, body: details.data })
      .then(async (response) => {
        const responseText = await response.text();
        details.onload?.({ status: response.status, responseText, response: responseText, finalUrl: details.url });
      })
      .catch((error) => details.onerror?.(error));
  };
  const GM_info = { script: { name: site.part.name }, scriptHandler: "Plutonium" };
  const GM = {
    addStyle: async (css) => GM_addStyle(css),
    getValue: async (key, fallback) => GM_getValue(key, fallback),
    setValue: async (key, value) => GM_setValue(key, value),
    deleteValue: async (key) => GM_deleteValue(key),
    listValues: async () => GM_listValues(),
    xmlHttpRequest: GM_xmlhttpRequest,
    info: GM_info,
  };
  // The page's own window isn't reachable from an isolated world.
  const unsafeWindow = window;
  void GM; void unsafeWindow;
${code
  .split("\n")
  .map((line) => `  ${line}`)
  .join("\n")}
}
`;

/** A user script, as a part. */
export function importUserScript(text: string, source: string): Imported {
  const fields = header(text, /\/\/\s*==UserScript==/, /\/\/\s*==\/UserScript==/);
  if (!fields) throw new SiteError("Not a user script: no // ==UserScript== header.");
  const notes: string[] = [];
  const matches = [...(fields.get("match") ?? [])];
  for (const include of fields.get("include") ?? []) {
    const pattern = includeToMatch(include);
    if (pattern) matches.push(pattern);
    else notes.push(`@include ${include} isn't a match pattern; left out`);
  }
  const excludes: string[] = [];
  for (const exclude of [...(fields.get("exclude") ?? []), ...(fields.get("exclude-match") ?? [])]) {
    const pattern = exclude.includes("://") && !exclude.startsWith("/") ? (includeToMatch(exclude) ?? exclude) : null;
    if (pattern && /^(\*|https?|file):\/\/[^/]*\//.test(pattern)) excludes.push(pattern);
    else notes.push(`@exclude ${exclude} left out`);
  }
  if (matches.length === 0) throw new SiteError("The user script matches no site (@match or @include).");
  const site = matches.map(patternHost).find((host): host is string => host !== null);
  if (!site) throw new SiteError("The user script runs on every site; give it a site with --site.");
  const title = fields.get("name")?.[0] ?? "Imported script";
  for (const grant of fields.get("grant") ?? []) {
    if (!/^(none|GM[_.](addStyle|getValue|setValue|deleteValue|listValues|xmlhttpRequest|xmlHttpRequest|info))$/.test(grant)) {
      notes.push(`@grant ${grant} isn't supported`);
    }
  }
  for (const require of fields.get("require") ?? []) notes.push(`@require ${require} isn't loaded: paste it into the part`);
  if (/\bunsafeWindow\b/.test(text)) notes.push("unsafeWindow is the isolated world's window, not the page's");
  const code = text.slice(text.search(/\/\/\s*==\/UserScript==/)).replace(/^\/\/\s*==\/UserScript==[^\n]*\n?/, "");
  return {
    site,
    part: slug(title),
    title,
    matches: [...new Set(matches)],
    excludes,
    runAt: RUN_AT[fields.get("run-at")?.[0] ?? "document-end"] ?? "ready",
    js: `// Imported from ${source}\n${GM_WRAPPER(code.trim())}`,
    css: null,
    notes,
  };
}

/** A user style (UserCSS or @-moz-document blocks), as a part. */
export function importUserStyle(text: string, source: string): Imported {
  const fields = header(text, /\/\*\s*==UserStyle==/, /==\/UserStyle==\s*\*\//);
  const notes: string[] = [];
  const matches: string[] = [];
  const blocks: string[] = [];
  const doc = /@-moz-document\s+([^{]+)\{/g;
  let found: RegExpExecArray | null;
  while ((found = doc.exec(text))) {
    for (const rule of found[1]!.matchAll(/(domain|url-prefix|url|regexp)\(\s*["']?([^"')]+)["']?\s*\)/g)) {
      const [, kind, value] = rule as unknown as [string, string, string];
      if (kind === "domain") matches.push(`*://${value}/*`, `*://*.${value}/*`);
      else if (kind === "url-prefix" || kind === "url") {
        const pattern = includeToMatch(`${value}${kind === "url-prefix" ? "*" : ""}`);
        if (pattern) matches.push(pattern);
        else notes.push(`${kind}(${value}) left out`);
      } else notes.push(`regexp(${value}) isn't a match pattern; left out`);
    }
    // The block's body, up to its matching brace.
    let depth = 1;
    let index = found.index + found[0].length;
    const start = index;
    while (index < text.length && depth > 0) {
      if (text[index] === "{") depth += 1;
      else if (text[index] === "}") depth -= 1;
      index += 1;
    }
    blocks.push(text.slice(start, index - 1).trim());
    doc.lastIndex = index;
  }
  if (blocks.length === 0) throw new SiteError("Not a user style: no @-moz-document block.");
  const site = matches.map(patternHost).find((host): host is string => host !== null);
  if (!site) throw new SiteError("The user style names no site.");
  if (fields?.has("preprocessor") && fields.get("preprocessor")![0] !== "default") {
    notes.push(`@preprocessor ${fields.get("preprocessor")![0]} isn't run; its variables are left as written`);
  }
  if (fields?.has("var")) notes.push("@var settings aren't offered; their defaults aren't filled in");
  const title = fields?.get("name")?.[0] ?? "Imported style";
  return {
    site,
    part: slug(title),
    title,
    matches: [...new Set(matches)],
    excludes: [],
    runAt: "start",
    js: null,
    css: `/* Imported from ${source} */\n${blocks.join("\n\n")}\n`,
    notes,
  };
}

/** A user script or a user style, whichever `text` is. */
export function importSource(text: string, source: string): Imported {
  if (/\/\/\s*==UserScript==/.test(text)) return importUserScript(text, source);
  if (/==UserStyle==|@-moz-document/.test(text)) return importUserStyle(text, source);
  throw new SiteError("Neither a user script (// ==UserScript==) nor a user style (@-moz-document).");
}

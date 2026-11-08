// A site's "block" list (SITE_EXTENSIONS.md) as declarativeNetRequest rules,
// for the sites host extension. The filters are uBlock's network syntax, a
// subset: `||host/path^`, a plain URL fragment, `@@` for an exception, and the
// options `$script`, `image`, `stylesheet`, `xhr`, `font`, `media`,
// `subdocument`, `websocket`, `other`, `third-party`, `first-party`. A site's
// rules apply to requests its own pages make (initiatorDomains: its hosts).
import type { Site } from "./store.ts";

export interface DnrRule {
  readonly id: number;
  readonly priority: number;
  readonly action: { readonly type: "block" | "allow" };
  readonly condition: {
    readonly urlFilter: string;
    readonly resourceTypes?: readonly string[];
    readonly domainType?: "firstParty" | "thirdParty";
    readonly initiatorDomains?: readonly string[];
  };
}

const TYPES: Record<string, string> = {
  script: "script",
  image: "image",
  stylesheet: "stylesheet",
  css: "stylesheet",
  xhr: "xmlhttprequest",
  xmlhttprequest: "xmlhttprequest",
  font: "font",
  media: "media",
  subdocument: "sub_frame",
  frame: "sub_frame",
  websocket: "websocket",
  ping: "ping",
  other: "other",
};
/** Every type but the page itself: a site's block list never blocks its own page. */
const ALL_TYPES = [...new Set(Object.values(TYPES))];

/** The hosts a site's pages are on, from its match patterns (none for `*`). */
export function siteHosts(site: Site): string[] {
  const hosts = new Set<string>();
  for (const pattern of site.manifest.matches) {
    const host = /^[^:]+:\/\/([^/]*)\//.exec(pattern)?.[1];
    if (!host || host === "*") continue;
    hosts.add(host.replace(/^\*\./, ""));
  }
  return [...hosts];
}

/** One filter as a rule (without its id), or why it can't be one. */
export function filterRule(filter: string, initiators: readonly string[]): Omit<DnrRule, "id"> | { error: string } {
  let text = filter.trim();
  if (!text || text.startsWith("!")) return { error: "empty" };
  if (text.includes("##") || text.includes("#@#")) return { error: "cosmetic filters go in a part's stylesheet" };
  const allow = text.startsWith("@@");
  if (allow) text = text.slice(2);
  let options: string[] = [];
  const dollar = text.lastIndexOf("$");
  if (dollar > 0) {
    options = text.slice(dollar + 1).split(",").map((option) => option.trim().toLowerCase());
    text = text.slice(0, dollar);
  }
  if (!text) return { error: "no URL" };
  const resourceTypes: string[] = [];
  let domainType: "firstParty" | "thirdParty" | undefined;
  for (const option of options) {
    if (TYPES[option]) resourceTypes.push(TYPES[option]!);
    else if (option === "third-party" || option === "3p") domainType = "thirdParty";
    else if (option === "first-party" || option === "1p" || option === "~third-party") domainType = "firstParty";
    else return { error: `unsupported option $${option}` };
  }
  return {
    priority: allow ? 2 : 1,
    action: { type: allow ? "allow" : "block" },
    condition: {
      urlFilter: text,
      resourceTypes: resourceTypes.length ? [...new Set(resourceTypes)] : ALL_TYPES,
      ...(domainType ? { domainType } : {}),
      ...(initiators.length ? { initiatorDomains: initiators } : {}),
    },
  };
}

/** Every site's rules, numbered, and the filters that couldn't be rules. */
export function blockRules(sites: readonly Site[]): { rules: DnrRule[]; errors: Record<string, string[]> } {
  const rules: DnrRule[] = [];
  const errors: Record<string, string[]> = {};
  for (const site of sites) {
    if (site.error) continue;
    const hosts = siteHosts(site);
    for (const filter of site.manifest.block) {
      const rule = filterRule(filter, hosts);
      if ("error" in rule) {
        if (rule.error !== "empty") (errors[site.name] ??= []).push(`${filter}: ${rule.error}`);
        continue;
      }
      rules.push({ id: rules.length + 1, ...rule });
    }
  }
  return { rules, errors };
}

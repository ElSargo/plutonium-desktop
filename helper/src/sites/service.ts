// Site extensions in the helper (SITE_EXTENSIONS.md): the store, the tabs'
// contexts and the DevTools injector together, and the /v1/sites routes.
//
//   GET  /v1/sites                          every site: its parts, errors, the tabs it applies to
//   GET  /v1/sites/<site>                   one site, with its recent errors and logs
//   POST /v1/sites/<site>/parts/<part>      { enabled }: turn a part on or off
//   GET  /v1/sites/tabs/<tab>               what runs in a tab, and its context
//   POST /v1/sites/tabs/<tab>/apply         apply the folder to a tab now, then report
//   POST /v1/sites/request                  { tab, text, preset?, part? }: a request to change the tab's
//                                           site: its folder, requests.md, and the prompt for an agent
//   GET  /v1/sites/log                      the folder's history
//   POST /v1/sites/reload                   read every site again
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { BrowserCdp } from "../cdp.ts";
import type { Desktop } from "../desktop.ts";
import { ContextSource, type ThreadDirectory } from "./context.ts";
import { SiteInjector, type SiteEvent } from "./injector.ts";
import { isSiteName, SITE_MANIFEST, SiteError, SiteStore, type Site } from "./store.ts";

/** The checkout (or install) the helper runs from. */
const PLUTONIUM = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Writes `text` to `file` if it's different (so the folder's watcher doesn't see a change). */
function writeIfChanged(file: string, text: string): void {
  let current: string | undefined;
  try {
    current = readFileSync(file, "utf8");
  } catch {}
  if (current !== text) writeFileSync(file, text);
}

/** The presets the skill describes. */
const PRESETS = new Set(["theme", "keys", "declutter", "readable", "dark"]);

export interface SiteRequest {
  readonly site: string;
  readonly dir: string;
  readonly part: string | null;
  readonly preset: string | null;
  /** What to give an agent: in a new thread the tab is lent to (or copied, without the agent engine). */
  readonly prompt: string;
}

export interface SitesOptions {
  readonly cdp: BrowserCdp;
  readonly desktop: Desktop;
  /** $PLUTO_HOME (a test slot's own). */
  readonly home: string;
  readonly directory?: ThreadDirectory;
}

export class SitesService {
  readonly store: SiteStore;
  readonly injector: SiteInjector;
  private readonly logDir: string;
  private readonly desktop: Desktop;

  constructor(options: SitesOptions) {
    this.logDir = join(options.home, "logs", "sites");
    this.desktop = options.desktop;
    this.store = new SiteStore({
      dir: join(options.home, "sites"),
      onChange: (changed) => {
        console.log(`plutoniumd: sites: ${[...changed].join(", ")} changed`);
        this.injector.storeChanged();
      },
    });
    this.injector = new SiteInjector(
      options.cdp,
      options.desktop,
      this.store,
      new ContextSource(options.home, options.directory),
    );
    this.injector.onEvent = (site, event) => this.log(site, event);
    this.store.start();
    this.installSkill(options.home);
    const broken = this.store.sites().filter((site) => site.error);
    console.log(
      `plutoniumd: sites: ${this.store.sites().length} in ${this.store.dir}` +
        (broken.length ? ` (${broken.map((site) => site.name).join(", ")} can't be read)` : ""),
    );
  }

  /** The skill agents read (skill/SITES.md) and the types for `site`, in the sites folder (not committed). */
  private installSkill(home: string): void {
    try {
      const skill = readFileSync(join(PLUTONIUM, "skill", "SITES.md"), "utf8")
        .replaceAll("{{PLUTONIUM}}", PLUTONIUM)
        .replaceAll("{{PLUTO_HOME}}", home)
        .replaceAll("{{SITES}}", this.store.dir);
      writeIfChanged(join(this.store.dir, "SKILL.md"), skill);
      writeIfChanged(join(this.store.dir, "site.d.ts"), readFileSync(new URL("./site.d.ts", import.meta.url), "utf8"));
    } catch (error) {
      console.warn(`plutoniumd: sites: can't write the skill: ${(error as Error).message}`);
    }
  }

  private log(site: string, event: SiteEvent): void {
    try {
      mkdirSync(this.logDir, { recursive: true });
      const line =
        `${new Date(event.at).toISOString()} ${event.kind === "error" ? "ERROR" : (event.level ?? "log").toUpperCase()} ` +
        `${event.part} tab ${event.tabId} ${event.url}\n  ${event.message}${event.stack ? `\n  ${event.stack.replace(/\n/g, "\n  ")}` : ""}\n`;
      appendFileSync(join(this.logDir, `${site}.log`), line);
    } catch {}
  }

  private describe(site: Site): Record<string, unknown> {
    const compileErrors = this.injector.compileErrors();
    return {
      name: site.name,
      title: site.manifest.title,
      dir: site.dir,
      matches: site.manifest.matches,
      excludes: site.manifest.excludes,
      scope: site.manifest.scope,
      error: site.error ?? null,
      parts: site.parts.map((part) => ({
        name: part.name,
        title: part.spec.title,
        enabled: part.spec.enabled,
        runAt: part.spec.runAt,
        preset: part.spec.preset,
        scope: part.spec.scope,
        css: part.css !== null,
        js: part.js !== null,
        hash: part.hash,
        error: compileErrors.get(part.id) ?? null,
      })),
      tabs: this.injector.tabsFor(site.name),
      ...(site.manifest.block.length ? { blockIgnored: "block rules need the sites host extension (not built yet)" } : {}),
    };
  }

  /**
   * A request to change a tab's site (the button, SITE_EXTENSIONS.md "The run"):
   * the site's folder (the one matching the tab, or a new one named by its host),
   * the request appended to its requests.md, and the prompt for the agent.
   */
  request(tabId: number, text: string, options: { preset?: string | undefined; part?: string | undefined } = {}): SiteRequest {
    const tab = this.desktop.tabs().find((candidate) => candidate.id === tabId);
    if (!tab) throw new SiteError(`No tab ${tabId}.`, 404);
    let url: URL;
    try {
      url = new URL(tab.url);
    } catch {
      throw new SiteError(`Tab ${tabId} has no page to change.`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new SiteError(`Tab ${tabId} isn't a website (${url.protocol}).`);
    const preset = options.preset && PRESETS.has(options.preset) ? options.preset : null;
    if (options.preset && !preset) throw new SiteError(`No preset ${options.preset}: ${[...PRESETS].join(", ")}.`);
    const part = options.part ?? preset ?? null;
    if (part !== null && !/^[a-z0-9][a-z0-9_-]*$/.test(part)) throw new SiteError(`Not a part name: ${part}.`);
    if (!text.trim() && !preset) throw new SiteError("Say what to change, or pick a preset.");
    const existing = this.store.sitesFor(tab.url)[0];
    const name = existing?.name ?? url.hostname.toLowerCase().replace(/^www\./, "");
    if (!isSiteName(name)) throw new SiteError(`Can't make a site folder for ${url.hostname}.`);
    const dir = join(this.store.dir, name);
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, SITE_MANIFEST))) {
      writeFileSync(join(dir, SITE_MANIFEST), `${JSON.stringify({ title: url.hostname.replace(/^www\./, "") }, null, 2)}\n`);
    }
    const what = [preset ? `preset ${preset}` : null, part ? `part ${part}` : null].filter(Boolean).join(", ");
    const requests = join(dir, "requests.md");
    if (!existsSync(requests)) writeFileSync(requests, `# What was asked of ${name}\n`);
    appendFileSync(
      requests,
      `\n## ${new Date().toISOString().slice(0, 16).replace("T", " ")}${what ? ` (${what})` : ""}\n\n${text.trim() || "(the preset, as it is)"}\n\nFrom ${tab.url}\n`,
    );
    const context = this.injector.contextOf(tabId);
    const prompt = [
      `Change ${name} for me with a Plutonium site extension. First read ${join(this.store.dir, "SKILL.md")}.`,
      "",
      `The request: ${text.trim() || `the ${preset} preset, as the skill describes it`}`,
      preset ? `Preset: ${preset} (write the "${preset}" part).` : part ? `Edit the "${part}" part.` : "Pick the part from the request and the parts already there (or add one).",
      "",
      `The site's folder is ${dir}; what was asked before is in its requests.md.`,
      `The tab is ${tabId} (${tab.url}), lent to this thread: check each change with site_apply on it, then look at it (snapshot_tab).`,
      context?.project ? `The tab is in project "${context.project.title ?? context.project.id}" (id ${context.project.id}).` : "",
      "Saving applies the change to every tab of the site at once; there's no need to reload.",
    ]
      .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
      .join("\n");
    return { site: name, dir, part, preset, prompt };
  }

  async route(method: string, path: string, body: () => Promise<Record<string, unknown>>): Promise<unknown> {
    if (method === "POST" && path === "/v1/sites/request") {
      const { tab, text, preset, part } = await body();
      if (typeof tab !== "number") throw new SiteError("Expected { tab, text, preset?, part? }.");
      return this.request(tab, typeof text === "string" ? text : "", {
        preset: typeof preset === "string" ? preset : undefined,
        part: typeof part === "string" ? part : undefined,
      });
    }
    if (method === "GET" && path === "/v1/sites") {
      return { dir: this.store.dir, sites: this.store.sites().map((site) => this.describe(site)) };
    }
    if (method === "GET" && path === "/v1/sites/log") return { log: this.store.log() };
    if (method === "POST" && path === "/v1/sites/reload") {
      this.store.reload();
      this.injector.storeChanged();
      return { sites: this.store.sites().length };
    }
    const tab = path.match(/^\/v1\/sites\/tabs\/(\d+)(\/apply)?$/);
    if (tab) {
      const tabId = Number(tab[1]);
      try {
        if (method === "GET" && !tab[2]) return await this.injector.report(tabId);
        if (method === "POST" && tab[2]) return await this.injector.applyNow(tabId);
      } catch (error) {
        throw new SiteError((error as Error).message, /No tab/.test((error as Error).message) ? 404 : 409);
      }
      return undefined;
    }
    const part = path.match(/^\/v1\/sites\/([a-z0-9.-]+)\/parts\/([a-z0-9_-]+)$/);
    if (part && method === "POST") {
      const { enabled } = await body();
      if (typeof enabled !== "boolean") throw new SiteError("Expected { enabled: true | false }.");
      this.store.setPartEnabled(part[1]!, part[2]!, enabled);
      return { site: part[1], part: part[2], enabled };
    }
    const one = path.match(/^\/v1\/sites\/([a-z0-9.-]+)$/);
    if (one && method === "GET") {
      const site = this.store.site(one[1]!);
      if (!site) throw new SiteError(`No site ${one[1]}.`, 404);
      return { ...this.describe(site), events: this.injector.siteEvents(site.name) };
    }
    return undefined;
  }
}

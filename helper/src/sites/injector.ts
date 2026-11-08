// Applies site extensions to the browser's tabs over DevTools
// (SITE_EXTENSIONS.md, "DevTools from the helper"). For each tab in the
// browser's registry it keeps a flat session, and in it:
// - a document-start script (Page.addScriptToEvaluateOnNewDocument) in the
//   "plutonium-sites" isolated world: the runtime, every site's parts (the
//   runtime picks the ones whose patterns match the page) and the tab's
//   context;
// - for the page that's already loaded, the same world
//   (Page.createIsolatedWorld) and Runtime.evaluate, so a change applies in
//   place;
// - a binding in that world only, for storage, fetch, logs and errors.
import type { BrowserCdp, CdpEvent } from "../cdp.ts";
import type { Desktop, DesktopTab } from "../desktop.ts";
import { bootSource, compilePart, updateSource, type CompiledPart, type RuntimeData } from "./compile.ts";
import { NO_CONTEXT, type ContextSource, type TabContext } from "./context.ts";
import type { Site, SiteStore } from "./store.ts";

export const WORLD = "plutonium-sites";
const BINDING = "__plutoniumSitesSend";
const MAX_FETCH_BYTES = 8 << 20;
const MAX_SITE_EVENTS = 100;

interface TabState {
  readonly tabId: number;
  readonly targetId: string;
  sessionId: string | null;
  attaching: Promise<void> | null;
  scriptId: string | null;
  /** The world context the binding was last added to. */
  boundContext: number | null;
  /** What the tab has now: the parts' key and the context, as JSON. */
  appliedKey: string;
  context: TabContext;
  url: string;
  /** Updates to this tab, one at a time. */
  queue: Promise<unknown>;
}

/** An error or a log line from a part, for the API and the agent's tools. */
export interface SiteEvent {
  readonly kind: "error" | "log";
  readonly part: string;
  readonly tabId: number;
  readonly url: string;
  readonly message: string;
  readonly stack?: string;
  readonly level?: string;
  readonly at: number;
}

export interface PartReport {
  readonly id: string;
  readonly hash: string;
  readonly applies: boolean;
  readonly running: boolean;
  readonly errors: readonly { message: string; stack: string; where: string; url: string; at: number }[];
  readonly logs: readonly { level: string; message: string; at: number }[];
  readonly observers: readonly { selector: string; matched: number }[];
  readonly keys: readonly { keys: string; title: string }[];
}

export interface TabReport {
  readonly url: string;
  readonly top: boolean;
  readonly context: TabContext;
  readonly parts: readonly PartReport[];
}

export class SiteInjector {
  private readonly cdp: BrowserCdp;
  private readonly desktop: Desktop;
  private readonly store: SiteStore;
  private readonly contexts: ContextSource;
  private readonly tabs = new Map<number, TabState>();
  private readonly sessions = new Map<string, TabState>();
  private compiled: { key: string; parts: RuntimeData["parts"]; errors: Map<string, string> } | null = null;
  /** Recent errors and logs, by site. */
  private readonly events = new Map<string, SiteEvent[]>();
  /** Called with each error or log line (the daemon writes the site's log). */
  onEvent: ((site: string, event: SiteEvent) => void) | null = null;

  constructor(cdp: BrowserCdp, desktop: Desktop, store: SiteStore, contexts: ContextSource) {
    this.cdp = cdp;
    this.desktop = desktop;
    this.store = store;
    this.contexts = contexts;
    cdp.addEventListener((event) => this.event(event));
    cdp.addCloseListener(() => {
      this.tabs.clear();
      this.sessions.clear();
    });
    desktop.changeListeners.add(() => this.reconcile());
    desktop.enableListeners.add(() => this.reconcile());
  }

  /** Every site's parts, compiled once per change of the store. */
  private parts(): NonNullable<typeof this.compiled> {
    const sites = this.store.sites().filter((site) => !site.error);
    const key = sites.map((site) => `${site.name}:${JSON.stringify(site.manifest)}:${site.parts.map((part) => part.hash).join(",")}`).join("|");
    if (this.compiled?.key === key) return this.compiled;
    const errors = new Map<string, string>();
    const parts: { compiled: CompiledPart; siteScope: Site["manifest"]["scope"]; matches: readonly string[]; excludes: readonly string[] }[] = [];
    for (const site of sites) {
      for (const part of site.parts) {
        const compiled = compilePart(part);
        if (compiled.error) errors.set(part.id, compiled.error);
        parts.push({ compiled, siteScope: site.manifest.scope, matches: site.manifest.matches, excludes: site.manifest.excludes });
      }
    }
    this.compiled = { key, parts, errors };
    return this.compiled;
  }

  /** Parts that don't compile, by id. */
  compileErrors(): ReadonlyMap<string, string> {
    return this.parts().errors;
  }

  /** Brings every tab up to date: new tabs attached, changed ones updated, gone ones forgotten. */
  reconcile(): void {
    const tabs = this.desktop.tabs();
    const live = new Set<number>();
    for (const tab of tabs) {
      if (tab.openedBy === "devtools") continue;
      live.add(tab.id);
      this.ensure(tab);
    }
    for (const [id, state] of this.tabs) {
      if (live.has(id)) continue;
      this.tabs.delete(id);
      if (state.sessionId) this.sessions.delete(state.sessionId);
    }
  }

  /** The store changed: every tab gets the new parts. */
  storeChanged(): void {
    this.reconcile();
  }

  private ensure(tab: DesktopTab): void {
    let state = this.tabs.get(tab.id);
    if (state && state.targetId !== tab.targetId) {
      if (state.sessionId) this.sessions.delete(state.sessionId);
      state = undefined;
    }
    if (!state) {
      state = {
        tabId: tab.id,
        targetId: tab.targetId,
        sessionId: null,
        attaching: null,
        scriptId: null,
        boundContext: null,
        appliedKey: "",
        context: NO_CONTEXT,
        url: tab.url,
        queue: Promise.resolve(),
      };
      this.tabs.set(tab.id, state);
    }
    state.url = tab.url;
    const context = this.contexts.contextFor(tab.tags);
    const key = `${this.parts().key}#${JSON.stringify(context)}`;
    if (key === state.appliedKey) return;
    state.appliedKey = key;
    state.context = context;
    const target = state;
    target.queue = target.queue
      .then(() => this.apply(target))
      .catch((error: unknown) => {
        // Try again on the next change.
        target.appliedKey = "";
        console.warn(`plutoniumd: sites: tab ${target.tabId}: ${(error as Error).message}`);
      });
  }

  private async attach(state: TabState): Promise<string> {
    if (state.sessionId) return state.sessionId;
    const { sessionId } = (await this.cdp.send("Target.attachToTarget", { targetId: state.targetId, flatten: true })) as {
      sessionId: string;
    };
    state.sessionId = sessionId;
    this.sessions.set(sessionId, state);
    // Page events tell a new document (the binding goes into its world); Runtime
    // stays disabled, as sites can tell when it's on.
    await this.cdp.send("Page.enable", {}, sessionId);
    return sessionId;
  }

  private data(state: TabState): RuntimeData {
    return { context: state.context, parts: this.parts().parts };
  }

  private async apply(state: TabState): Promise<void> {
    if (this.tabs.get(state.tabId) !== state) return;
    const sessionId = await this.attach(state);
    const data = this.data(state);
    if (state.scriptId) {
      await this.cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: state.scriptId }, sessionId).catch(() => {});
      state.scriptId = null;
    }
    const { identifier } = (await this.cdp.send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: bootSource(data), worldName: WORLD },
      sessionId,
    )) as { identifier: string };
    state.scriptId = identifier;
    await this.evaluateInWorld(state, updateSource(data));
    await this.connect(state);
  }

  /** The main frame's sites world: its context id, with the binding in it. */
  private async world(state: TabState): Promise<{ sessionId: string; contextId: number }> {
    const sessionId = await this.attach(state);
    const { executionContextId } = (await this.cdp.send(
      "Page.createIsolatedWorld",
      { frameId: state.targetId, worldName: WORLD },
      sessionId,
    )) as { executionContextId: number };
    if (state.boundContext !== executionContextId) {
      // By context id: a binding by context name only reaches new contexts while Runtime is enabled.
      await this.cdp.send("Runtime.addBinding", { name: BINDING, executionContextId }, sessionId);
      state.boundContext = executionContextId;
    }
    return { sessionId, contextId: executionContextId };
  }

  /** A new document: its world gets the binding, and the runtime sends what it queued. */
  private async connect(state: TabState): Promise<void> {
    const { sessionId, contextId } = await this.world(state);
    await this.cdp.send(
      "Runtime.evaluate",
      { expression: "globalThis.__plutoniumSites && globalThis.__plutoniumSites.connected()", contextId },
      sessionId,
    );
  }

  /** Evaluates `expression` in the tab's main frame's sites world. */
  private async evaluateInWorld(state: TabState, expression: string): Promise<unknown> {
    const { sessionId, contextId: executionContextId } = await this.world(state);
    const result = (await this.cdp.send(
      "Runtime.evaluate",
      { expression, contextId: executionContextId, returnByValue: true, awaitPromise: true },
      sessionId,
    )) as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "The script threw.");
    }
    return result.result?.value;
  }

  /** Applies the current parts and context to a tab now, and reports what runs there. */
  async applyNow(tabId: number): Promise<TabReport> {
    const tab = this.desktop.tabs().find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error(`No tab ${tabId}.`);
    const state = this.tabs.get(tabId);
    if (state) state.appliedKey = "";
    this.ensure(tab);
    await this.tabs.get(tabId)!.queue;
    return this.report(tabId);
  }

  /** What runs in a tab's main frame: each part, its errors, logs, observers and keys. */
  async report(tabId: number): Promise<TabReport> {
    const state = this.tabs.get(tabId);
    if (!state) throw new Error(`No tab ${tabId} (or it isn't attached yet).`);
    await state.queue;
    const report = (await this.evaluateInWorld(state, "globalThis.__plutoniumSites ? globalThis.__plutoniumSites.report() : null")) as
      | (Omit<TabReport, "context"> & { context: unknown })
      | null;
    if (!report) throw new Error(`The sites runtime isn't running in tab ${tabId}.`);
    return { ...report, context: state.context };
  }

  /** Recent errors and logs of a site's parts. */
  siteEvents(site: string): readonly SiteEvent[] {
    return this.events.get(site) ?? [];
  }

  /** The tabs a site applies to now (by URL), with their ids. */
  tabsFor(siteName: string): { id: number; url: string }[] {
    const site = this.store.site(siteName);
    if (!site) return [];
    return this.desktop
      .tabs()
      .filter((tab) => this.store.sitesFor(tab.url).some((candidate) => candidate.name === siteName))
      .map((tab) => ({ id: tab.id, url: tab.url }));
  }

  contextOf(tabId: number): TabContext | null {
    const tab = this.desktop.tabs().find((candidate) => candidate.id === tabId);
    return tab ? this.contexts.contextFor(tab.tags) : null;
  }

  // ---- The binding -----------------------------------------------------------------

  private event({ method, params, sessionId }: CdpEvent): void {
    if (!sessionId) return;
    if (method === "Page.frameNavigated") {
      const state = this.sessions.get(sessionId);
      const { frame } = params as { frame: { id: string; parentId?: string } };
      if (!state || frame.parentId) return;
      state.boundContext = null;
      state.queue = state.queue.then(() => this.connect(state)).catch(() => {});
      return;
    }
    if (method !== "Runtime.bindingCalled") return;
    const state = this.sessions.get(sessionId);
    const { name, payload, executionContextId } = params as { name: string; payload: string; executionContextId: number };
    if (!state || name !== BINDING) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }
    void this.handle(state, sessionId, executionContextId, message);
  }

  private record(site: string, event: SiteEvent): void {
    const list = this.events.get(site) ?? [];
    list.push(event);
    if (list.length > MAX_SITE_EVENTS) list.shift();
    this.events.set(site, list);
    this.onEvent?.(site, event);
  }

  private async handle(state: TabState, sessionId: string, contextId: number, message: Record<string, unknown>): Promise<void> {
    const type = message.type;
    const part = typeof message.part === "string" ? message.part : "";
    const site = part.split("/")[0] ?? "";
    if (type === "error" || type === "log") {
      if (!site) return;
      this.record(site, {
        kind: type,
        part,
        tabId: state.tabId,
        url: typeof message.url === "string" ? message.url : state.url,
        message: String(message.message ?? ""),
        ...(typeof message.stack === "string" && message.stack ? { stack: message.stack } : {}),
        ...(typeof message.level === "string" ? { level: message.level } : {}),
        at: Date.now(),
      });
      return;
    }
    if (typeof message.id !== "number") return;
    const id = message.id;
    let ok = true;
    let value: unknown;
    try {
      value = await this.call(String(type), message);
    } catch (error) {
      ok = false;
      value = (error as Error).message;
    }
    const expression = `globalThis.__plutoniumSites.reply(${id}, ${ok}, ${JSON.stringify(value ?? null)})`;
    await this.cdp.send("Runtime.evaluate", { expression, contextId }, sessionId).catch(() => {});
  }

  private async call(type: string, message: Record<string, unknown>): Promise<unknown> {
    const siteName = typeof message.site === "string" ? message.site : "";
    const site = this.store.site(siteName);
    if (!site) throw new Error(`No site ${siteName}.`);
    switch (type) {
      case "storage.get": {
        const values = this.store.readStorage(siteName);
        return typeof message.key === "string" ? (values[message.key] ?? null) : values;
      }
      case "storage.set": {
        if (typeof message.key !== "string") throw new Error("storage.set needs a key.");
        const values = this.store.readStorage(siteName);
        if (message.value === undefined || message.value === null) delete values[message.key];
        else values[message.key] = message.value;
        this.store.writeStorage(siteName, values);
        return null;
      }
      case "fetch":
        return this.fetch(site, message);
      default:
        throw new Error(`Unknown call ${type}.`);
    }
  }

  /** site.fetch: through the helper, to the hosts the site lists. */
  private async fetch(site: Site, message: Record<string, unknown>): Promise<unknown> {
    const url = new URL(String(message.url));
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("site.fetch takes http(s) URLs.");
    const allowed = site.manifest.hosts.some((host) =>
      host.startsWith("*.") ? url.hostname === host.slice(2) || url.hostname.endsWith(host.slice(1)) : url.hostname === host,
    );
    if (!allowed) throw new Error(`${url.hostname} isn't in ${site.name}'s "hosts".`);
    const init = (message.init ?? {}) as { method?: string; headers?: Record<string, string>; body?: string };
    const response = await fetch(url, {
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    if (body.length > MAX_FETCH_BYTES) throw new Error("The response is too big for site.fetch.");
    return { status: response.status, headers: Object.fromEntries(response.headers), body };
  }
}

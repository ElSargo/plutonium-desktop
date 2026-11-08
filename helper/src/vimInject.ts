// Pluto Vim in every page (PLUTO_VIM.md, step 3): the helper puts the engine
// (vimBundle.ts) into each page's own isolated world, "pluto-vim", over the
// browser's DevTools, shell pages and browser tabs alike. With Plutonium's key
// hook (Chromium, "Pluto Vim's key hook") the engine gets each key after every
// handler of the page's; without it, it falls back to its own listeners.
//
// An injected script lasts as long as the DevTools session that added it, so
// the helper keeps one session per page. Off unless PLUTONIUM_VIM=1, while
// it's young.
//
// A script added to a page while its document commits reaches neither that
// document nor, as a new one, the next: Chromium's runImmediately misses a
// document mid-commit, and waitForDebuggerOnStart doesn't always hold the
// first commit back. So after adding it, the injector also runs it in the
// page's world as it is now (ensure): a document made after the script went
// in gets it as a new document, and one made before is the one it runs in.
// The script skips itself where the engine already is.
//
// New pages are auto-attached and wait (waitForDebuggerOnStart) until their
// script is in, so mostly the engine is in before the page's own scripts.
// Pages open at start are attached as they are. Every page gets the script,
// and it goes on only in http(s) documents, so a tab that starts at
// about:blank still gets it.
//
// The script also carries init.js (vimConfig.ts), configured before the
// engine attaches. A new version replaces each page's script, for its next
// document, and is configured into the world the page has now.
//
// Registers are the helper's (vimRegisters.ts): each page's session gets a
// binding, plutoVimStore, only in the engine's world, and its calls are
// answered there (remoteStore.js). The page's own scripts can't reach it.
import type { BrowserCdp } from "./cdp.ts";
import type { RegisterPlace, RegisterStore } from "./vimRegisters.ts";

const WORLD = "pluto-vim";
/** remoteStore.js's binding and reply. */
const BINDING = "plutoVimStore";
const REPLY = "plutoVimStoreReply";
/** When a page open at start is checked again for the engine (ensure). */
const ENSURE_AGAIN_MS = 1000;

interface TargetInfo {
  readonly targetId: string;
  readonly type: string;
  readonly url: string;
}

/** Documents the engine goes on in: http(s), the shells' own included, not chrome://, devtools:// or about:. */
export function wantsVim(url: string): boolean {
  return /^https?:/.test(url);
}

export interface VimInjectorOptions {
  /** init.js as an expression (vimConfig.ts's configExpression): its setup function, or null. */
  readonly config?: () => string;
  /** The installed shells by origin, for vim.disable({ shell }). */
  readonly shellOrigins?: () => Record<string, string>;
  /** The register store every page shares; without it each page keeps its own. */
  readonly registers?: RegisterStore;
  /** Where a page's fields are, for registers' thread and project scopes. */
  readonly placeOf?: (targetId: string) => RegisterPlace;
  /** An uppercase mark set in page `targetId` (m{A-Z}), and a jump to one from a page. */
  readonly onMarkSet?: (targetId: string, name: string, offset: number) => void;
  readonly onMarkJump?: (name: string) => void;
}

interface PageSession {
  readonly sessionId: string;
  identifier: string;
  url: string;
}

export class VimInjector {
  private readonly sessions = new Map<string, PageSession>();
  private readonly attaching = new Set<string>();
  private listener: ((event: { method: string; params?: unknown; sessionId?: string }) => void) | null = null;

  private readonly cdp: BrowserCdp;
  private readonly source: () => string;
  private readonly log: (message: string) => void;
  private readonly options: VimInjectorOptions;

  constructor(cdp: BrowserCdp, source: () => string, log: (message: string) => void = () => {}, options: VimInjectorOptions = {}) {
    this.cdp = cdp;
    this.source = source;
    this.log = log;
    this.options = options;
  }

  /** The script every page's world runs: in an http(s) document, the engine, init.js configured into a Vim, and the Vim attached. */
  pageScript(): string {
    const config = this.options.config?.() ?? "null";
    let shells = "{}";
    try {
      shells = JSON.stringify(this.options.shellOrigins?.() ?? {});
    } catch {
      // No shells' names: vim.disable({ shell }) matches nothing.
    }
    return [
      "if (/^https?:$/.test(location.protocol) && !globalThis.plutoVimPage) {",
      this.source(),
      "  const store = new globalThis.plutoVim.RemoteStore();",
      "  const vim = new globalThis.plutoVim.Vim({ store });",
      `  try { globalThis.plutoVim.configure(vim, ${config}); } catch (error) { console.error("pluto vim: init.js:", error); }`,
      `  globalThis.plutoVimPage = globalThis.plutoVim.attach(document, { vim, shell: (${shells})[location.origin] ?? null });`,
      "  globalThis.plutoVim.connectHost(vim, store);",
      "}",
      "",
    ].join("\n");
  }

  /**
   * Watches for pages, and puts the engine into the ones open now. Call it
   * again whenever the helper connects to the browser anew (its sessions
   * went with the old connection).
   */
  async start(): Promise<void> {
    if (!this.listener) this.listen();
    this.sessions.clear();
    await this.cdp.send("Target.setDiscoverTargets", { discover: true });
    await this.cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const { targetInfos } = (await this.cdp.send("Target.getTargets")) as { targetInfos: TargetInfo[] };
    await Promise.all(targetInfos.map((target) => this.attachOpen(target)));
  }

  /** Stops: no more pages get the engine, and the ones that have it keep it until their session goes. */
  async stop(): Promise<void> {
    if (this.listener) this.cdp.removeEventListener(this.listener);
    this.listener = null;
    await this.cdp.send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
    await Promise.all([...this.sessions.values()].map((page) => this.cdp.send("Target.detachFromTarget", { sessionId: page.sessionId }).catch(() => {})));
    this.sessions.clear();
  }

  private listen(): void {
    this.listener = ({ method, params, sessionId }) => {
      if (sessionId) {
        if (method === "Runtime.bindingCalled") void this.storeCall(sessionId, params as { name: string; payload: string; executionContextId: number });
        return;
      }
      const value = params as { targetInfo?: TargetInfo; targetId?: string; sessionId?: string; waitingForDebugger?: boolean };
      if (method === "Target.attachedToTarget" && value.waitingForDebugger && value.sessionId && value.targetInfo) {
        void this.attachNew(value.sessionId, value.targetInfo);
      } else if (method === "Target.targetInfoChanged" && value.targetInfo) {
        const known = this.sessions.get(value.targetInfo.targetId);
        if (known) known.url = value.targetInfo.url;
      } else if (method === "Target.targetDestroyed" && value.targetId) {
        this.sessions.delete(value.targetId);
      } else if (method === "Target.detachedFromTarget" && value.sessionId) {
        for (const [target, page] of this.sessions) if (page.sessionId === value.sessionId) this.sessions.delete(target);
      }
    };
    this.cdp.addEventListener(this.listener);
  }

  /** The pages that have the engine's script. */
  get pages(): number {
    return this.sessions.size;
  }

  /** A new target, waiting for us: a page gets its script; then it runs, whatever happened. */
  private async attachNew(sessionId: string, target: TargetInfo): Promise<void> {
    try {
      if (target.type === "page" && !this.sessions.has(target.targetId)) {
        await this.bind(sessionId);
        const { identifier } = (await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: this.pageScript(), worldName: WORLD }, sessionId)) as { identifier: string };
        this.sessions.set(target.targetId, { sessionId, identifier, url: target.url });
        if (wantsVim(target.url)) this.log(`pluto vim: in ${target.url}`);
      }
    } catch (error) {
      this.log(`pluto vim: couldn't go into ${target.url || target.type}: ${(error as Error).message}`);
    } finally {
      await this.cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
      const page = this.sessions.get(target.targetId);
      if (!page || page.sessionId !== sessionId) await this.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      // Waiting doesn't always hold back the first document's commit: run it there too.
      else await this.ensure(target.targetId, page);
    }
  }

  /** A page open when we started: attached as it is, the script run in its document now too. */
  private async attachOpen(target: TargetInfo): Promise<void> {
    if (target.type !== "page" || this.sessions.has(target.targetId) || this.attaching.has(target.targetId)) return;
    this.attaching.add(target.targetId);
    try {
      const { sessionId } = (await this.cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })) as { sessionId: string };
      await this.bind(sessionId);
      const { identifier } = (await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: this.pageScript(), worldName: WORLD, runImmediately: true }, sessionId)) as { identifier: string };
      const page = { sessionId, identifier, url: target.url };
      this.sessions.set(target.targetId, page);
      if (wantsVim(target.url)) this.log(`pluto vim: in ${target.url}`);
      await this.ensure(target.targetId, page);
      setTimeout(() => void this.ensure(target.targetId, page), ENSURE_AGAIN_MS).unref?.();
    } catch (error) {
      this.log(`pluto vim: couldn't go into ${target.url}: ${(error as Error).message}`);
    } finally {
      this.attaching.delete(target.targetId);
    }
  }

  /** The register store's binding, in the engine's world of this page (now and in its next documents). */
  private async bind(sessionId: string): Promise<void> {
    if (!this.options.registers) return;
    // A binding named for a world reaches that world's contexts only while
    // Runtime is enabled on the session (disabled again, new documents' worlds
    // go without it). Enabled, the page's console messages come to the
    // session too; they're dropped (listen).
    await this.cdp.send("Runtime.enable", {}, sessionId);
    await this.cdp.send("Runtime.addBinding", { name: BINDING, executionContextName: WORLD }, sessionId);
  }

  /** A call from a page's engine to the register store, answered in the same world. */
  private async storeCall(sessionId: string, call: { name: string; payload: string; executionContextId: number }): Promise<void> {
    const store = this.options.registers;
    if (call.name !== BINDING || !store) return;
    // (Marks need the binding too, which comes with the register store.)
    const target = [...this.sessions].find(([, page]) => page.sessionId === sessionId)?.[0];
    if (!target) return;
    let id = 0;
    let result: unknown = null;
    try {
      const message = JSON.parse(call.payload) as { id: number; op: string; name: string; scope: string; value?: unknown };
      id = Number(message.id);
      const place = this.options.placeOf?.(target) ?? {};
      if (message.op === "get") result = await store.get(message.name, message.scope, place);
      else if (message.op === "set") await store.set(message.name, message.value, message.scope, place);
      else if (message.op === "mark.set") this.options.onMarkSet?.(target, message.name, Number((message as { offset?: unknown }).offset));
      else if (message.op === "mark.jump") this.options.onMarkJump?.(message.name);
    } catch (error) {
      this.log(`pluto vim: register store: ${(error as Error).message}`);
    }
    if (!Number.isSafeInteger(id) || id <= 0) return;
    await this.cdp.send("Runtime.evaluate", {
      contextId: call.executionContextId,
      expression: `globalThis.${REPLY}?.(${id}, ${JSON.stringify(result ?? null)})`,
    }, sessionId).catch(() => {});
  }

  /** Uppercase mark `name` in page `targetId`: its field takes focus and the cursor goes to the mark. */
  async jumpInPage(targetId: string, name: string, offset: number): Promise<boolean> {
    const page = this.sessions.get(targetId);
    if (!page) return false;
    try {
      const { executionContextId } = (await this.cdp.send("Page.createIsolatedWorld", { frameId: targetId, worldName: WORLD }, page.sessionId)) as { executionContextId: number };
      const { result } = (await this.cdp.send("Runtime.evaluate", {
        contextId: executionContextId,
        expression: `!!globalThis.plutoVimPage?.jumpToMark(${JSON.stringify(name)}, ${Number(offset) || 0})`,
        returnByValue: true,
      }, page.sessionId)) as { result: { value?: boolean } };
      return result.value === true;
    } catch {
      return false;
    }
  }

  /** Runs the script in the page's world now, if it's still ours; it does nothing where the engine already is. */
  private async ensure(targetId: string, page: PageSession): Promise<void> {
    if (this.sessions.get(targetId) !== page) return;
    try {
      const { executionContextId } = (await this.cdp.send("Page.createIsolatedWorld", { frameId: targetId, worldName: WORLD }, page.sessionId)) as { executionContextId: number };
      await this.cdp.send("Runtime.evaluate", { contextId: executionContextId, expression: this.pageScript() }, page.sessionId);
    } catch {
      // The page went, or is between documents: its next document gets the script anyway.
    }
  }

  /**
   * init.js changed: each page's script is replaced (for its next document),
   * and the new version is configured into the world it has now.
   */
  async reconfigure(): Promise<void> {
    const config = this.options.config?.() ?? "null";
    const source = this.pageScript();
    await Promise.all([...this.sessions].map(async ([targetId, page]) => {
      try {
        await this.cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: page.identifier }, page.sessionId);
        const { identifier } = (await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source, worldName: WORLD }, page.sessionId)) as { identifier: string };
        page.identifier = identifier;
        if (!wantsVim(page.url)) return;
        const { executionContextId } = (await this.cdp.send("Page.createIsolatedWorld", { frameId: targetId, worldName: WORLD }, page.sessionId)) as { executionContextId: number };
        const { exceptionDetails } = (await this.cdp.send("Runtime.evaluate", {
          contextId: executionContextId,
          expression: `globalThis.plutoVimPage && globalThis.plutoVim.configure(globalThis.plutoVimPage.vim, ${config}), true`,
        }, page.sessionId)) as { exceptionDetails?: { exception?: { description?: string }; text?: string } };
        if (exceptionDetails) this.log(`pluto vim: init.js failed in ${page.url}: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
      } catch (error) {
        this.log(`pluto vim: couldn't reconfigure ${page.url}: ${(error as Error).message}`);
      }
    }));
  }
}

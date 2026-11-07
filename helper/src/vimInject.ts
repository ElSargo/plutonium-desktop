// Pluto Vim in every page (PLUTO_VIM.md, step 3): the helper puts the engine
// (vimBundle.ts) into each page's own isolated world, "pluto-vim", over the
// browser's DevTools, shell pages and browser tabs alike. With Plutonium's key
// hook (Chromium, "Pluto Vim's key hook") the engine gets each key after every
// handler of the page's; without it, it falls back to its own listeners.
//
// An injected script lasts as long as the DevTools session that added it, so
// the helper keeps one session per page. Off unless PLUTONIUM_VIM=1, while
// it's young.
import type { BrowserCdp } from "./cdp.ts";

const WORLD = "pluto-vim";

interface TargetInfo {
  readonly targetId: string;
  readonly type: string;
  readonly url: string;
}

/** Pages the engine goes into: http(s) and the shells' own, not the browser's chrome:// and devtools:// pages. */
export function wantsVim(target: TargetInfo): boolean {
  return target.type === "page" && /^https?:/.test(target.url);
}

export class VimInjector {
  private readonly sessions = new Map<string, string>();
  private readonly attaching = new Set<string>();

  private readonly cdp: BrowserCdp;
  private readonly source: () => string;
  private readonly log: (message: string) => void;

  constructor(cdp: BrowserCdp, source: () => string, log: (message: string) => void = () => {}) {
    this.cdp = cdp;
    this.source = source;
    this.log = log;
  }

  private listening = false;

  /**
   * Watches for pages, and puts the engine into the ones open now. Call it
   * again whenever the helper connects to the browser anew (its sessions
   * went with the old connection).
   */
  async start(): Promise<void> {
    if (!this.listening) this.listen();
    this.sessions.clear();
    await this.cdp.send("Target.setDiscoverTargets", { discover: true });
    const { targetInfos } = (await this.cdp.send("Target.getTargets")) as { targetInfos: TargetInfo[] };
    await Promise.all(targetInfos.map((target) => this.consider(target)));
  }

  private listen(): void {
    this.listening = true;
    this.cdp.addEventListener(({ method, params, sessionId }) => {
      if (sessionId) return;
      const value = params as { targetInfo?: TargetInfo; targetId?: string; sessionId?: string };
      if ((method === "Target.targetCreated" || method === "Target.targetInfoChanged") && value.targetInfo) {
        void this.consider(value.targetInfo);
      } else if (method === "Target.targetDestroyed" && value.targetId) {
        this.sessions.delete(value.targetId);
      } else if (method === "Target.detachedFromTarget" && value.sessionId) {
        for (const [target, session] of this.sessions) if (session === value.sessionId) this.sessions.delete(target);
      }
    });
  }

  /** The pages that have the engine. */
  get pages(): number {
    return this.sessions.size;
  }

  private async consider(target: TargetInfo): Promise<void> {
    if (!wantsVim(target) || this.sessions.has(target.targetId) || this.attaching.has(target.targetId)) return;
    this.attaching.add(target.targetId);
    try {
      const { sessionId } = (await this.cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })) as { sessionId: string };
      const source = `${this.source()}\nglobalThis.plutoVimPage ??= globalThis.plutoVim.attach(document);\n`;
      await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source, worldName: WORLD, runImmediately: true }, sessionId);
      this.sessions.set(target.targetId, sessionId);
      this.log(`pluto vim: in ${target.url}`);
    } catch (error) {
      this.log(`pluto vim: couldn't go into ${target.url}: ${(error as Error).message}`);
    } finally {
      this.attaching.delete(target.targetId);
    }
  }
}

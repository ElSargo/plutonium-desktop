// The `site` a site extension's part gets (SITE_EXTENSIONS.md). Written into
// $PLUTO_HOME/sites/site.d.ts by the helper, for editors and agents:
//   /** @param {import("../site").Site} site */
//   export default function (site) { ... }

export interface SiteContext {
  /** The tab's thread, or null for a tab in none. */
  readonly thread: { readonly id: string; readonly title: string | null } | null;
  /** The tab's project, or null. */
  readonly project: { readonly id: string; readonly title: string | null; readonly folder: string | null } | null;
  /** This site's settings in the tab's project ("sites" in the project's file), or {}. */
  readonly settings: Readonly<Record<string, unknown>>;
  /** The shell the tab belongs to ("hydra"), when known. */
  readonly shell: string | null;
}

export interface StyleHandle {
  set(text: string): void;
  remove(): void;
}

export interface KeyOptions {
  /** Shown in key lists. */
  readonly title?: string;
  /** Also in text fields (default false). */
  readonly inText?: boolean;
}

export type SiteEvent = "navigate" | "visible" | "hidden" | "appearance" | "context";

export interface Site {
  readonly context: SiteContext;
  readonly theme: { readonly scheme: "light" | "dark"; readonly tokens: Readonly<Record<string, string>> };
  readonly url: string;
  readonly part: { readonly id: string; readonly site: string; readonly name: string };

  /** A stylesheet, removed with the part. */
  css(text: string): StyleHandle;
  /** Runs `fn` on each element matching `selector`, now and as they appear; returns a stop function. */
  observe(selector: string, fn: (element: Element) => void, options?: { readonly once?: boolean }): () => void;
  on(event: "navigate", fn: (detail: { url: string }) => void): () => void;
  on(event: "appearance", fn: (scheme: "light" | "dark") => void): () => void;
  on(event: "context", fn: (context: SiteContext) => void): () => void;
  on(event: "visible" | "hidden", fn: () => void): () => void;

  readonly keys: {
    /** "j", "?", "Ctrl+KeyK", chords "g i". Never with Super, never in text fields unless inText. */
    bind(keys: string, fn: (event: KeyboardEvent) => void, options?: KeyOptions): () => void;
    list(): { keys: string; title: string }[];
  };
  focusNext(selector: string): Element | null;
  focusPrev(selector: string): Element | null;
  go(path: string): void;
  click(selector: string): boolean;

  setTimeout(fn: () => void, ms: number): number;
  setInterval(fn: () => void, ms: number): number;
  listen<K extends keyof WindowEventMap>(target: EventTarget, type: K | string, fn: (event: Event) => void, options?: AddEventListenerOptions): void;
  onCleanup(fn: () => void): void;

  readonly storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    all(): Promise<Record<string, unknown>>;
  };
  /** Through the helper, to the hosts in site.json's "hosts" only. */
  fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Response>;
  readonly desktop: { call(name: string, args?: unknown): Promise<unknown> };

  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

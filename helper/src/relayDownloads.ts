// Playwright's download events for the relays (pages.ts, serverTabs.ts;
// TAB_FEATURES.md, "Downloads"). The browser's downloads are the user's, so
// the relays only acknowledge Browser.setDownloadBehavior: files land where
// the user's do. What Playwright needs for waitForEvent("download") and
// download.path() is the events Chromium would send, which come from the
// browser's own Plutonium.downloadAdded/Changed here, and the file at
// `<downloadPath>/<guid>`, which is a link to where it really went.
import { randomUUID } from "node:crypto";
import { mkdir, rm, symlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { CdpEvent } from "./cdp.ts";
import { type DesktopDownload, parseDownload } from "./desktop.ts";

const debug = process.env.PLUTONIUM_DEBUG_PAGES ? (...args: unknown[]) => console.log("downloads:", ...args) : () => {};

interface Tracked {
  readonly guid: string;
  /** Browser.downloadWillBegin went (once the browser knows the name). */
  begun: boolean;
  /** The last progress sent, so a change that doesn't touch it sends nothing. */
  last: string;
  done: boolean;
}

/** One relay connection's downloads: what Browser.setDownloadBehavior asked, and the events. */
export class RelayDownloads {
  /** Browser.setDownloadBehavior's: events wanted, and where Playwright looks for files. */
  private behavior: { readonly events: boolean; readonly downloadPath: string } | null = null;
  private readonly tracked = new Map<number, Tracked>();
  private readonly send: (method: string, params: Record<string, unknown>) => void;
  private readonly frameOf: (tabId: number) => string | undefined;
  private readonly cancelDownload: (id: number) => Promise<void>;

  /**
   * `send` writes a browser-level event to the connection; `frameOf` is the
   * main frame (the target id) of a tab the connection has, or undefined for
   * one it hasn't; `cancel` cancels a download in the browser.
   */
  constructor(
    send: (method: string, params: Record<string, unknown>) => void,
    frameOf: (tabId: number) => string | undefined,
    cancel: (id: number) => Promise<void>,
  ) {
    this.send = send;
    this.frameOf = frameOf;
    this.cancelDownload = cancel;
  }

  /** Browser.setDownloadBehavior: acknowledged, and remembered for the events. */
  setBehavior(params: Record<string, unknown>): void {
    const behavior = params.behavior;
    const downloadPath = typeof params.downloadPath === "string" ? params.downloadPath : "";
    // "deny" and "default" get no events: Chromium's would cancel the download,
    // and the user's own downloads aren't the automation's to refuse.
    const events = params.eventsEnabled === true && (behavior === "allow" || behavior === "allowAndName");
    this.behavior = { events, downloadPath: isAbsolute(downloadPath) ? downloadPath : "" };
    debug("behavior", behavior, downloadPath, events);
  }

  /** Browser.cancelDownload {guid}. */
  async cancel(params: Record<string, unknown>): Promise<void> {
    for (const [id, tracked] of this.tracked) {
      if (tracked.guid === params.guid && !tracked.done) return this.cancelDownload(id);
    }
  }

  /** One event of the real browser's connection; Plutonium's download ones count. */
  browserEvent({ method, params, sessionId }: CdpEvent): void {
    if (sessionId || !this.behavior?.events) return;
    if (method !== "Plutonium.downloadAdded" && method !== "Plutonium.downloadChanged") return;
    const download = parseDownload((params as { downloadJson?: unknown }).downloadJson);
    if (!download) return;
    let tracked = this.tracked.get(download.id);
    if (!tracked) {
      // Only downloads that start while the connection wants them, from its tabs.
      if (method !== "Plutonium.downloadAdded" || this.frameOf(download.tabId) === undefined) return;
      tracked = { guid: randomUUID(), begun: false, last: "", done: false };
      this.tracked.set(download.id, tracked);
    }
    void this.update(download, tracked);
  }

  private async update(download: DesktopDownload, tracked: Tracked): Promise<void> {
    if (tracked.done) return;
    const finished = download.state === "complete" || download.state === "cancelled" || download.state === "interrupted";
    if (!tracked.begun) {
      // The name comes once the browser has picked the file; Playwright keeps the first one.
      if (!download.filename && !finished) return;
      const frameId = this.frameOf(download.tabId);
      if (frameId === undefined) {
        // The tab left the connection before the name came.
        this.tracked.delete(download.id);
        return;
      }
      tracked.begun = true;
      this.send("Browser.downloadWillBegin", {
        frameId,
        guid: tracked.guid,
        url: download.url,
        suggestedFilename: download.filename || fileNameOf(download.url),
      });
    }
    const progress = {
      guid: tracked.guid,
      totalBytes: download.totalBytes,
      receivedBytes: download.receivedBytes,
      state: download.state === "complete" ? "completed" : finished ? "canceled" : "inProgress",
    };
    if (finished) {
      tracked.done = true;
      // The file first: Playwright reads it as soon as it hears "completed".
      if (download.state === "complete") await this.link(download, tracked.guid);
    }
    const key = JSON.stringify(progress);
    if (key === tracked.last) return;
    tracked.last = key;
    this.send("Browser.downloadProgress", progress);
  }

  // <downloadPath>/<guid>, where Playwright looks: a symlink to the file, so
  // download.delete() and Playwright's own clean-up leave the user's file.
  private async link(download: DesktopDownload, guid: string): Promise<void> {
    const folder = this.behavior?.downloadPath;
    if (!folder || !download.path) return;
    const target = join(folder, guid);
    try {
      await mkdir(folder, { recursive: true });
      await rm(target, { force: true });
      await symlink(download.path, target);
    } catch (error) {
      console.warn(`plutoniumd: download ${download.id} for Playwright: ${(error as Error).message}`);
    }
  }
}

function fileNameOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "") || "download";
  } catch {
    return "download";
  }
}

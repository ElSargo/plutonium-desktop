// A website's own icon, for shells (GET /v1/sites/icon?url=…).
//
// A shell page can't reliably show `https://site/favicon.ico` in an <img>:
// sites that answer with `Cross-Origin-Resource-Policy: same-origin` (claude.ai
// does) are blocked, and many keep their icon somewhere else, named by the
// page's <link rel="icon">. The helper isn't a page, so it fetches the icon
// itself: the one the page names, else the origin's /favicon.ico. No
// third-party icon service; the site learns only that its icon was asked for,
// without cookies. Icons are kept per origin for a while, failures briefly.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

const PAGE_LIMIT = 1024 * 1024;
const ICON_LIMIT = 512 * 1024;
const TIMEOUT_MS = 8000;
const KEEP_MS = 6 * 60 * 60 * 1000;
const KEEP_MISSING_MS = 10 * 60 * 1000;
const MAX_KEPT = 200;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export interface SiteIcon {
  readonly data: Buffer;
  readonly contentType: string;
}

/** An icon a page names with <link rel="…icon…" href sizes type>. */
export interface IconLink {
  readonly href: string;
  readonly rel: string;
  readonly sizes: string;
  readonly type: string;
}

/** The <link> elements in `html` whose rel names an icon, in document order. */
export function iconLinks(html: string): IconLink[] {
  const links: IconLink[] = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const attributes = new Map<string, string>();
    for (const match of tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attributes.set(match[1]!.toLowerCase(), decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
    }
    const rel = (attributes.get("rel") ?? "").toLowerCase().split(/\s+/);
    const href = attributes.get("href")?.trim();
    if (!href) continue;
    const kind = rel.includes("icon") ? "icon" : rel.includes("apple-touch-icon") ? "apple-touch-icon" : null;
    if (!kind) continue;
    links.push({
      href,
      rel: kind,
      sizes: (attributes.get("sizes") ?? "").toLowerCase(),
      type: (attributes.get("type") ?? "").toLowerCase(),
    });
  }
  return links;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** The largest side a link's sizes name (`any` counts as big; none: 0). */
function linkSize(link: IconLink): number {
  if (link.sizes.split(/\s+/).includes("any")) return 1024;
  let best = 0;
  for (const match of link.sizes.matchAll(/(\d+)x(\d+)/g)) best = Math.max(best, Number(match[1]));
  return best;
}

/**
 * The icons worth trying, best first: a page's "icon" links (an SVG, then
 * the smallest at least 32 px, then larger, then unsized, then smaller), then
 * its apple-touch-icons.
 */
export function rankIconLinks(links: readonly IconLink[]): IconLink[] {
  const score = (link: IconLink): number => {
    const touch = link.rel === "apple-touch-icon" ? 10_000 : 0;
    if (link.type === "image/svg+xml" || /\.svg(?:[?#]|$)/i.test(link.href)) return touch;
    const size = linkSize(link);
    if (size >= 32) return touch + 1 + size;
    if (size === 0) return touch + 2000;
    return touch + 3000 - size;
  };
  return [...links].sort((a, b) => score(a) - score(b));
}

/** The image type of `data`, from its first bytes (null: not an image a page can show). */
export function sniffImage(data: Buffer, declared: string): string | null {
  if (data.length < 4) return null;
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data[0] === 0 && data[1] === 0 && (data[2] === 1 || data[2] === 2) && data[3] === 0) return "image/x-icon";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP")
    return "image/webp";
  const text = data.subarray(0, 1024).toString("utf8").trimStart().toLowerCase();
  if (declared.includes("svg") || text.startsWith("<svg") || (text.startsWith("<?xml") && text.includes("<svg")))
    return text.includes("<svg") ? "image/svg+xml" : null;
  return null;
}

function httpUrl(raw: string, base?: string): URL | null {
  try {
    const url = new URL(raw, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** What a GET answered: its status, final URL, type, and body (null: larger than allowed). */
export interface Fetched {
  readonly status: number;
  readonly url: string;
  readonly contentType: string;
  readonly body: Buffer | null;
}

/** GETs `url` (an icon or a page), up to `limit` bytes of it. */
export type Fetch = (url: string, accept: string, limit: number) => Promise<Fetched>;

/**
 * A GET without cookies, following redirects, through node:https: for sites
 * (Google's) that answer with more headers than fetch() takes. A page past
 * `limit` is cut there (its icons are near the top); an icon past it is none.
 */
export function httpGet(url: string, accept: string, limit: number, redirects = 5): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const get = target.protocol === "https:" ? httpsRequest : httpRequest;
    const page = accept.startsWith("text/html");
    const request = get(
      target,
      {
        headers: { Accept: accept, "Accept-Encoding": "gzip, deflate, br", "User-Agent": USER_AGENT },
        maxHeaderSize: 256 * 1024,
        timeout: TIMEOUT_MS,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.resume();
          const next = httpUrl(location, target.href);
          if (!next || redirects <= 0) return resolve({ status, url: target.href, contentType: "", body: null });
          return resolve(httpGet(next.href, accept, limit, redirects - 1));
        }
        const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
        const encoding = String(response.headers["content-encoding"] ?? "").toLowerCase();
        const stream: NodeJS.ReadableStream =
          encoding === "gzip" || encoding === "x-gzip"
            ? response.pipe(createGunzip())
            : encoding === "deflate"
              ? response.pipe(createInflate())
              : encoding === "br"
                ? response.pipe(createBrotliDecompress())
                : response;
        const chunks: Buffer[] = [];
        let length = 0;
        let done = false;
        const finish = (body: Buffer | null) => {
          if (done) return;
          done = true;
          request.destroy();
          resolve({ status, url: target.href, contentType, body });
        };
        stream.on("data", (chunk: Buffer) => {
          if (done) return;
          chunks.push(chunk);
          length += chunk.length;
          if (length >= limit) finish(page ? Buffer.concat(chunks).subarray(0, limit) : null);
        });
        stream.on("end", () => finish(Buffer.concat(chunks)));
        stream.on("error", (error) => (done ? undefined : reject(error)));
      },
    );
    request.on("timeout", () => request.destroy(new Error("timed out")));
    request.on("error", reject);
    request.end();
  });
}

/** fetch()'s GET (bot checks such as Cloudflare's let it through, not node:https), else httpGet's. */
export async function siteGet(url: string, accept: string, limit: number): Promise<Fetched> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: accept, "User-Agent": USER_AGENT },
      redirect: "follow",
      credentials: "omit",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return httpGet(url, accept, limit);
  }
  const fetched = { status: response.status, url: response.url || url, contentType: (response.headers.get("content-type") ?? "").toLowerCase() };
  if (Number(response.headers.get("content-length")) > limit && !accept.startsWith("text/html")) {
    await response.body?.cancel();
    return { ...fetched, body: null };
  }
  const chunks: Buffer[] = [];
  let length = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      chunks.push(Buffer.from(chunk));
      length += chunk.length;
      if (length >= limit) {
        await response.body.cancel().catch(() => undefined);
        return { ...fetched, body: accept.startsWith("text/html") ? Buffer.concat(chunks).subarray(0, limit) : null };
      }
    }
  }
  return { ...fetched, body: Buffer.concat(chunks) };
}

function dataUrlIcon(href: string): SiteIcon | null {
  const match = href.match(/^data:([^;,]*)(;base64)?,(.*)$/s);
  if (!match) return null;
  const data = match[2] ? Buffer.from(match[3]!, "base64") : Buffer.from(decodeURIComponent(match[3]!), "utf8");
  const contentType = sniffImage(data, match[1]!.toLowerCase());
  return contentType && data.length <= ICON_LIMIT ? { data, contentType } : null;
}

export class SiteIcons {
  private readonly kept = new Map<string, { icon: SiteIcon | null; until: number }>();
  private readonly pending = new Map<string, Promise<SiteIcon | null>>();

  private readonly fetcher: Fetch;
  private readonly now: () => number;

  constructor(fetcher: Fetch = siteGet, now: () => number = Date.now) {
    this.fetcher = fetcher;
    this.now = now;
  }

  /** The icon of the site page `pageUrl` is on (null: none found). */
  async icon(pageUrl: string): Promise<SiteIcon | null> {
    const page = httpUrl(pageUrl);
    if (!page) return null;
    const origin = page.origin;
    const kept = this.kept.get(origin);
    if (kept && kept.until > this.now()) return kept.icon;
    let pending = this.pending.get(origin);
    if (!pending) {
      pending = this.find(page).catch(() => null);
      this.pending.set(origin, pending);
      void pending.then((icon) => {
        this.pending.delete(origin);
        this.kept.delete(origin);
        this.kept.set(origin, { icon, until: this.now() + (icon ? KEEP_MS : KEEP_MISSING_MS) });
        while (this.kept.size > MAX_KEPT) this.kept.delete(this.kept.keys().next().value!);
      });
    }
    return pending;
  }

  private async find(page: URL): Promise<SiteIcon | null> {
    // The site's front page names its icon; the page itself may need a sign-in.
    const front = new URL("/", page.origin);
    const { links, base } = await this.pageLinks(front);
    const candidates = rankIconLinks(links)
      .map((link) => link.href)
      .concat(["/favicon.ico"]);
    if (base.origin !== front.origin) candidates.push(new URL("/favicon.ico", front.origin).href);
    const tried = new Set<string>();
    for (const href of candidates) {
      if (href.startsWith("data:")) {
        const icon = dataUrlIcon(href);
        if (icon) return icon;
        continue;
      }
      const url = httpUrl(href, base.href);
      if (!url || tried.has(url.href)) continue;
      tried.add(url.href);
      const icon = await this.fetchIcon(url);
      if (icon) return icon;
    }
    return null;
  }

  private async pageLinks(front: URL): Promise<{ links: IconLink[]; base: URL }> {
    try {
      const response = await this.fetcher(front.href, "text/html,application/xhtml+xml", PAGE_LIMIT);
      const base = httpUrl(response.url) ?? front;
      if (response.status !== 200 || !response.contentType.includes("html") || !response.body) {
        return { links: [], base };
      }
      const html = response.body.toString("utf8");
      const baseHref = html.match(/<base\b[^>]*\bhref\s*=\s*["']?([^"'\s>]+)/i)?.[1];
      return { links: iconLinks(html), base: (baseHref && httpUrl(baseHref, base.href)) || base };
    } catch {
      return { links: [], base: front };
    }
  }

  private async fetchIcon(url: URL): Promise<SiteIcon | null> {
    try {
      const response = await this.fetcher(url.href, "image/avif,image/webp,image/svg+xml,image/*,*/*;q=0.8", ICON_LIMIT);
      if (response.status !== 200 || !response.body) return null;
      const contentType = sniffImage(response.body, response.contentType);
      return contentType ? { data: response.body, contentType } : null;
    } catch {
      return null;
    }
  }
}

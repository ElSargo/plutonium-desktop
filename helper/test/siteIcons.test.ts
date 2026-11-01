import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { iconLinks, rankIconLinks, SiteIcons, sniffImage } from "../src/siteIcons.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const ICO = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

type Route = { status?: number; type?: string; body: string | Buffer; url?: string };

function fakeFetch(routes: Record<string, Route>) {
  const asked: string[] = [];
  const fetcher = async (url: string, _accept: string, limit: number) => {
    asked.push(url);
    const route = routes[url] ?? { status: 404, type: "text/html", body: "no" };
    const body = Buffer.from(route.body);
    return {
      status: route.status ?? 200,
      url: route.url ?? url,
      contentType: route.type ?? "",
      body: body.length > limit ? null : body,
    };
  };
  return { fetcher, asked };
}

describe("a page's icon links", () => {
  test("rel, href, sizes and type, with quoting and entities", () => {
    const html = `<html><head>
      <link rel="stylesheet" href="/a.css">
      <link rel='shortcut icon' href='/fav.ico'>
      <LINK REL=icon HREF=/i-16.png sizes=16x16 type=image/png>
      <link href="/i.svg?a=1&amp;b=2" rel="icon" type="image/svg+xml">
      <link rel="apple-touch-icon" href="/touch.png" sizes="180x180">
      <link rel="icon">
    </head><body></body></html>`;
    assert.deepEqual(iconLinks(html), [
      { href: "/fav.ico", rel: "icon", sizes: "", type: "" },
      { href: "/i-16.png", rel: "icon", sizes: "16x16", type: "image/png" },
      { href: "/i.svg?a=1&b=2", rel: "icon", sizes: "", type: "image/svg+xml" },
      { href: "/touch.png", rel: "apple-touch-icon", sizes: "180x180", type: "" },
    ]);
  });

  test("ranked: SVG, then the smallest at least 32 px, unsized, smaller, then touch icons", () => {
    const link = (href: string, sizes = "", rel = "icon") => ({ href, rel, sizes, type: "" });
    const ranked = rankIconLinks([
      link("/touch.png", "180x180", "apple-touch-icon"),
      link("/16.png", "16x16"),
      link("/fav.ico"),
      link("/192.png", "192x192"),
      link("/32.png", "32x32"),
      link("/i.svg"),
    ]).map((l) => l.href);
    assert.deepEqual(ranked, ["/i.svg", "/32.png", "/192.png", "/fav.ico", "/16.png", "/touch.png"]);
  });
});

describe("sniffing", () => {
  test("images by their bytes; HTML isn't one", () => {
    assert.equal(sniffImage(PNG, "text/html"), "image/png");
    assert.equal(sniffImage(ICO, ""), "image/x-icon");
    assert.equal(sniffImage(SVG, "text/plain"), "image/svg+xml");
    assert.equal(sniffImage(Buffer.from("<!doctype html><html>"), "image/x-icon"), null);
  });
});

describe("SiteIcons", () => {
  test("the icon the front page names, resolved against where it ended up", async () => {
    const { fetcher, asked } = fakeFetch({
      "https://example.com/": {
        type: "text/html; charset=utf-8",
        url: "https://www.example.com/home/",
        body: '<link rel="icon" href="img/icon.png">',
      },
      "https://www.example.com/home/img/icon.png": { type: "image/png", body: PNG },
    });
    const icons = new SiteIcons(fetcher);
    const icon = await icons.icon("https://example.com/some/page?q=1");
    assert.equal(icon?.contentType, "image/png");
    assert.deepEqual(asked, ["https://example.com/", "https://www.example.com/home/img/icon.png"]);
    // Kept per origin.
    await icons.icon("https://example.com/other");
    assert.equal(asked.length, 2);
  });

  test("/favicon.ico when the page names none or is refused, even served as the wrong type", async () => {
    const { fetcher } = fakeFetch({
      "https://claude.example/": { status: 403, type: "text/html", body: "challenge" },
      "https://claude.example/favicon.ico": { type: "application/octet-stream", body: ICO },
    });
    const icon = await new SiteIcons(fetcher).icon("https://claude.example/new");
    assert.equal(icon?.contentType, "image/x-icon");
  });

  test("a named icon that isn't an image is skipped; a data: icon works", async () => {
    const { fetcher } = fakeFetch({
      "https://a.example/": {
        type: "text/html",
        body: `<link rel="icon" href="/broken.png"><link rel="icon" href="data:image/svg+xml,${encodeURIComponent(SVG.toString())}">`,
      },
      "https://a.example/broken.png": { type: "image/png", body: "<html>not found</html>" },
    });
    const icon = await new SiteIcons(fetcher).icon("https://a.example/");
    assert.equal(icon?.contentType, "image/svg+xml");
  });

  test("none: null, kept briefly; not http(s): not fetched", async () => {
    let now = 0;
    const { fetcher, asked } = fakeFetch({});
    const icons = new SiteIcons(fetcher, () => now);
    assert.equal(await icons.icon("https://none.example/"), null);
    const first = asked.length;
    assert.equal(await icons.icon("https://none.example/x"), null);
    assert.equal(asked.length, first);
    now += 11 * 60 * 1000;
    await icons.icon("https://none.example/");
    assert.ok(asked.length > first);
    assert.equal(await icons.icon("file:///etc/passwd"), null);
    assert.equal(await icons.icon("not a url"), null);
  });
});

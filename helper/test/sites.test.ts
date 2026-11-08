import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { after, describe, test } from "node:test";

import { bootSource, compilePart, dataSource } from "../src/sites/compile.ts";
import { ContextSource, type ThreadDirectory } from "../src/sites/context.ts";
import {
  defaultMatches,
  matchesPattern,
  parseMatchPattern,
  parseSiteManifest,
  readSite,
  SiteError,
  siteMatches,
  SiteStore,
} from "../src/sites/store.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "plutonium-sites-"));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("match patterns", () => {
  test("Chrome's patterns", () => {
    assert.ok(matchesPattern("*://github.com/*", "https://github.com/a/b?q=1"));
    assert.ok(matchesPattern("*://github.com/*", "http://github.com/"));
    assert.ok(!matchesPattern("*://github.com/*", "https://gist.github.com/"));
    assert.ok(matchesPattern("*://*.github.com/*", "https://gist.github.com/x"));
    assert.ok(matchesPattern("*://*.github.com/*", "https://github.com/x"));
    assert.ok(!matchesPattern("*://*.github.com/*", "https://notgithub.com/x"));
    assert.ok(matchesPattern("https://example.com/docs/*", "https://example.com/docs/a"));
    assert.ok(!matchesPattern("https://example.com/docs/*", "https://example.com/other"));
    assert.ok(!matchesPattern("https://example.com/*", "http://example.com/"));
    assert.ok(matchesPattern("<all_urls>", "https://anything.test/"));
    assert.ok(!matchesPattern("*://example.com/*", "chrome://settings/"));
    // Ports don't matter, as in Chrome.
    assert.ok(matchesPattern("*://localhost/*", "http://localhost:8080/x"));
  });

  test("bad patterns", () => {
    for (const pattern of ["github.com", "*://git*hub.com/*", "ftp://x/*", "*://github.com"]) {
      assert.equal(parseMatchPattern(pattern), null, pattern);
    }
  });

  test("a site's matches and excludes", () => {
    const manifest = parseSiteManifest(JSON.stringify({ excludes: ["*://github.com/settings/*"] }), "github.com");
    assert.deepEqual(manifest.matches, defaultMatches("github.com"));
    assert.ok(siteMatches(manifest, "https://github.com/x"));
    assert.ok(siteMatches(manifest, "https://gist.github.com/x"));
    assert.ok(!siteMatches(manifest, "https://github.com/settings/keys"));
  });
});

describe("site.json", () => {
  test("parts, scopes and defaults", () => {
    const manifest = parseSiteManifest(
      JSON.stringify({
        title: "GitHub",
        scope: { project: "p1" },
        parts: { keys: { title: "Keys", runAt: "ready" }, quiet: { enabled: false, scope: { thread: "t1" } } },
        hosts: ["api.github.com"],
      }),
      "github.com",
    );
    assert.equal(manifest.title, "GitHub");
    assert.deepEqual(manifest.scope, { project: "p1" });
    assert.equal(manifest.parts.keys!.runAt, "ready");
    assert.equal(manifest.parts.keys!.enabled, true);
    assert.equal(manifest.parts.quiet!.enabled, false);
    assert.deepEqual(manifest.parts.quiet!.scope, { thread: "t1" });
    assert.deepEqual(manifest.hosts, ["api.github.com"]);
  });

  test("errors say what's wrong", () => {
    assert.throws(() => parseSiteManifest("{", "x.com"), SiteError);
    assert.throws(() => parseSiteManifest('{"matches":["nope"]}', "x.com"), /Not a match pattern/);
    assert.throws(() => parseSiteManifest('{"parts":{"Bad Name":{}}}', "x.com"), /Not a part name/);
    assert.throws(() => parseSiteManifest('{"scope":"project"}', "x.com"), /scope must be/);
    assert.throws(() => parseSiteManifest('{"parts":{"a":{"runAt":"later"}}}', "x.com"), /runAt/);
  });
});

describe("a site's folder", () => {
  test("every .css and .js is a part, listed or not", () => {
    const dir = join(tempDir(), "example.com");
    mkdirSync(dir);
    writeFileSync(join(dir, "site.json"), JSON.stringify({ parts: { theme: { title: "Theme" } } }));
    writeFileSync(join(dir, "theme.css"), "body { color: red }");
    writeFileSync(join(dir, "keys.js"), "export default function (site) {}");
    writeFileSync(join(dir, "keys.css"), ".x {}");
    writeFileSync(join(dir, "requests.md"), "# requests");
    const site = readSite(dir, "example.com");
    assert.equal(site.error, undefined);
    assert.deepEqual(
      site.parts.map((part) => [part.id, part.css !== null, part.js !== null, part.spec.title]),
      [
        ["example.com/keys", true, true, "keys"],
        ["example.com/theme", true, false, "Theme"],
      ],
    );
  });

  test("a part's hash changes with its code or its settings", () => {
    const dir = join(tempDir(), "example.com");
    mkdirSync(dir);
    writeFileSync(join(dir, "a.css"), "a {}");
    const first = readSite(dir, "example.com").parts[0]!.hash;
    writeFileSync(join(dir, "a.css"), "a { color: blue }");
    const second = readSite(dir, "example.com").parts[0]!.hash;
    writeFileSync(join(dir, "site.json"), JSON.stringify({ parts: { a: { enabled: false } } }));
    const third = readSite(dir, "example.com").parts[0]!.hash;
    assert.notEqual(first, second);
    assert.notEqual(second, third);
  });

  test("a bad site.json leaves the site out, with the error", () => {
    const dir = join(tempDir(), "example.com");
    mkdirSync(dir);
    writeFileSync(join(dir, "site.json"), "{ nope");
    writeFileSync(join(dir, "a.css"), "a {}");
    const site = readSite(dir, "example.com");
    assert.match(site.error ?? "", /isn't JSON/);
    assert.equal(site.parts.length, 0);
  });
});

describe("the store", () => {
  test("reads sites, matches URLs, turns parts on and off", () => {
    const root = tempDir();
    mkdirSync(join(root, "github.com"));
    writeFileSync(join(root, "github.com", "quiet.css"), ".x { display: none }");
    mkdirSync(join(root, "presets"));
    mkdirSync(join(root, "Not A Site"));
    const store = new SiteStore({ dir: root, commit: false });
    store.reload();
    assert.deepEqual(
      store.sites().map((site) => site.name),
      ["github.com"],
    );
    assert.equal(store.sitesFor("https://github.com/a").length, 1);
    assert.equal(store.sitesFor("https://example.com/").length, 0);
    store.setPartEnabled("github.com", "quiet", false);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "github.com", "site.json"), "utf8")), {
      parts: { quiet: { enabled: false } },
    });
    assert.throws(() => store.setPartEnabled("github.com", "nope", false), /no part/);
  });

  test("storage stays out of the sites", () => {
    const root = tempDir();
    const store = new SiteStore({ dir: root, commit: false });
    store.writeStorage("github.com", { a: 1 });
    assert.deepEqual(store.readStorage("github.com"), { a: 1 });
    assert.deepEqual(store.readStorage("other.com"), {});
    store.reload();
    assert.equal(store.sites().length, 0);
  });

  test("the folder is a git repository, a commit per change", () => {
    const root = tempDir();
    const store = new SiteStore({ dir: root });
    store.start();
    store.stop();
    mkdirSync(join(root, "example.com"));
    writeFileSync(join(root, "example.com", "a.css"), "a {}");
    assert.ok(store.commit("edit: example.com"));
    assert.equal(store.commit("nothing"), null);
    assert.match(store.log(), /edit: example.com[\s\S]*sites: start/);
  });
});

describe("compiling parts", () => {
  const part = (js: string | null, css: string | null = null) => ({
    id: "example.com/a",
    site: "example.com",
    name: "a",
    spec: { title: "a", enabled: true, runAt: "start" as const, allFrames: false, preset: null, scope: null },
    css,
    js,
    hash: "h",
  });

  test("export default becomes a function the runtime calls", () => {
    const compiled = compilePart(part("export default function (site) { site.log('hi'); }"));
    assert.equal(compiled.error, null);
    const run = runInNewContext(`(${compiled.run})`) as (site: unknown, exports: { default?: unknown }) => void;
    const exports: { default?: (site: { log(text: string): void }) => void } = {};
    run({}, exports);
    const logged: string[] = [];
    exports.default!({ log: (text) => logged.push(text) });
    assert.deepEqual(logged, ["hi"]);
  });

  test("syntax errors, imports and named exports are refused, per part", () => {
    assert.match(compilePart(part("export default function ( {")).error ?? "", /example.com\/a.js/);
    assert.match(compilePart(part("import x from './x.js';\nexport default () => {}")).error ?? "", /can't import/);
    assert.match(compilePart(part("export const a = 1;")).error ?? "", /Only `export default`/);
    assert.equal(compilePart(part(null, "a {}")).error, null);
  });

  test("the boot source runs, and a broken part is left out", () => {
    const good = compilePart(part("export default function (site) {}"));
    const bad = compilePart({ ...part("export default {"), id: "example.com/b", name: "b" });
    const source = dataSource({
      parts: [
        { compiled: good, siteScope: "global", matches: ["*://example.com/*"], excludes: [] },
        { compiled: bad, siteScope: "global", matches: ["*://example.com/*"], excludes: [] },
      ],
    });
    const data = runInNewContext(`(${source})`) as { parts: { id: string; run: unknown }[] };
    assert.deepEqual([...data.parts.map((p) => p.id)], ["example.com/a"]);
    assert.equal(typeof data.parts[0]!.run, "function");
    assert.match(bootSource({ parts: [] }), /__plutoniumSites\.boot/);
  });
});

describe("a tab's context", () => {
  const directory: ThreadDirectory = {
    thread: (id) => (id === "th-1" ? { title: "Vim mode", projectId: "p1" } : null),
    project: (id) => (id === "p1" ? { title: "Plutonium", folder: "/src/plutonium" } : null),
  };

  test("a thread's tab: its thread and project, and the project's site settings", () => {
    const home = tempDir();
    mkdirSync(join(home, "projects"));
    writeFileSync(
      join(home, "projects", "p1.json"),
      JSON.stringify({ sites: { "github.com": { org: "acme" }, bad: 3 } }),
    );
    const context = new ContextSource(home, directory).contextFor(["th-1"]);
    assert.deepEqual(context, {
      thread: { id: "th-1", title: "Vim mode" },
      project: { id: "p1", title: "Plutonium", folder: "/src/plutonium" },
      sites: { "github.com": { org: "acme" } },
      shell: "hydra",
    });
  });

  test("Hydra's thread tag", () => {
    const context = new ContextSource(tempDir(), directory).contextFor(["t3:thread/th-1"]);
    assert.deepEqual(context.thread, { id: "th-1", title: "Vim mode" });
    assert.equal(context.project?.id, "p1");
    assert.equal(context.shell, "hydra");
  });

  test("a tab kept per project, an unknown thread, no tags", () => {
    const home = tempDir();
    const source = new ContextSource(home, directory);
    assert.deepEqual(source.contextFor(["t3:project/p1"]).project, { id: "p1", title: "Plutonium", folder: "/src/plutonium" });
    assert.equal(source.contextFor(["t3:project/p1"]).thread, null);
    assert.deepEqual(source.contextFor(["th-9"]), {
      thread: { id: "th-9", title: null },
      project: null,
      sites: {},
      shell: null,
    });
    assert.deepEqual(source.contextFor([]), { thread: null, project: null, sites: {}, shell: null });
  });
});

describe("presets", () => {
  test("a preset file: front matter, then the prompt", async () => {
    const { parsePreset } = await import("../src/sites/presets.ts");
    const preset = parsePreset("---\ntitle: Theme\ndescription: Match the desktop\norder: 2\n---\nDo the theme.\n", "theme");
    assert.deepEqual(preset, { id: "theme", title: "Theme", description: "Match the desktop", order: 2, prompt: "Do the theme." });
    assert.equal(parsePreset("Just a prompt.", "x").title, "x");
  });

  test("shipped presets are installed, updated, and an edited copy is kept", async () => {
    const { installPresets, listPresets } = await import("../src/sites/presets.ts");
    const shipped = tempDir();
    writeFileSync(join(shipped, "keys.md"), "---\ntitle: Keys\norder: 2\n---\nv1");
    writeFileSync(join(shipped, "theme.md"), "---\ntitle: Theme\norder: 1\n---\nv1");
    const dir = join(tempDir(), "presets");
    const state = join(tempDir(), "presets.json");
    const url = new URL(`file://${shipped}/`);
    assert.deepEqual(installPresets(dir, state, url).sort(), ["keys", "theme"]);
    assert.deepEqual(listPresets(dir).map((preset) => preset.id), ["theme", "keys"]);
    // The user edits keys; both are shipped again, changed.
    writeFileSync(join(dir, "keys.md"), "---\ntitle: Keys\n---\nmine");
    writeFileSync(join(shipped, "keys.md"), "---\ntitle: Keys\n---\nv2");
    writeFileSync(join(shipped, "theme.md"), "---\ntitle: Theme\n---\nv2");
    assert.deepEqual(installPresets(dir, state, url), ["theme"]);
    assert.match(readFileSync(join(dir, "keys.md"), "utf8"), /mine/);
    assert.match(readFileSync(join(dir, "theme.md"), "utf8"), /v2/);
  });

  test("the shipped presets parse", async () => {
    const { listPresets } = await import("../src/sites/presets.ts");
    const presets = listPresets(new URL("../src/sites/presets/", import.meta.url).pathname);
    assert.deepEqual(presets.map((preset) => preset.id), ["theme", "keys", "declutter", "readable", "dark"]);
    for (const preset of presets) assert.ok(preset.prompt.length > 100 && preset.description, preset.id);
  });
});

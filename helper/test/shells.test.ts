import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, get as httpGet, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { mayUse } from "../src/services.ts";

import { ShellPackages } from "../src/shellPackages.ts";
import { ShellServer } from "../src/shellServers.ts";
import {
  addShell,
  effectiveList,
  previewShell,
  entryUrl,
  installShell,
  parseManifest,
  readList,
  serveStaticShell,
  shellDir,
  ShellError,
  shellOrigin,
  updateShell,
  writeList,
  type ShellContext,
} from "../src/shells.ts";

const scratch = mkdtempSync(join(tmpdir(), "plutonium-shells-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const fresh = (label: string) => {
  const dir = join(scratch, `${label}-${++counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const context = (home: string): ShellContext => ({
  home,
  slot: 2,
  shellsPort: 8970,
  helperUrl: "http://127.0.0.1:3981",
  plutonium: "/opt/plutonium",
  waylandDisplay: "wayland-test",
});

/** A shipped shells/ folder with one static shell. */
function shipped(version = "1", page = "<h1>one</h1>\n"): string {
  const root = fresh("shipped");
  mkdirSync(join(root, "demo"));
  writeFileSync(join(root, "demo", "shell.json"), JSON.stringify({ title: "Demo", version, static: "index.html" }));
  writeFileSync(join(root, "demo", "index.html"), page);
  return root;
}

const gitLog = (dir: string) =>
  execFileSync("git", ["-C", dir, "log", "--format=%s", "main"], { encoding: "utf8" }).trim().split("\n");

describe("manifests", () => {
  test("static and server shells; the folder's name wins", () => {
    const manifest = parseManifest('{"name":"other","static":"index.html"}', "mine");
    assert.equal(manifest.name, "mine");
    assert.equal(manifest.title, "mine");
    const server = parseManifest(
      JSON.stringify({ title: "T", server: { run: "plutonium", argv: ["x", "{port}"], port: 3000 } }),
      "t",
    );
    assert.equal(server.server?.run, "plutonium");
  });

  test("refuses what can't work", () => {
    for (const [text, name] of [
      ["{}", "a"],
      ['{"static":"a.html","server":{"run":"external","url":"http://x/"}}', "a"],
      ['{"static":"../a.html"}', "a"],
      ['{"static":"a.html"}', "Not A Name"],
      ['{"server":{"run":"plutonium"}}', "a"],
      ['{"server":{"run":"external"}}', "a"],
      ["not json", "a"],
    ] as const) {
      assert.throws(() => parseManifest(text, name), ShellError, text);
    }
  });

  test("origins and entry URLs: <name>.localhost, slot ports, the helper parameter", () => {
    const ctx = context("/h");
    const page = parseManifest('{"static":"index.html"}', "demo");
    assert.equal(shellOrigin(page, ctx), "http://demo.localhost:8970");
    assert.equal(entryUrl(page, ctx), "http://demo.localhost:8970/?helper=http://127.0.0.1:3981");
    const server = parseManifest(
      JSON.stringify({ helperParam: "plutoniumHelper", server: { run: "plutonium", argv: ["x"], port: 3773 } }),
      "t3",
    );
    assert.equal(shellOrigin(server, ctx), "http://127.0.0.1:3973");
    const external = parseManifest('{"server":{"run":"external","url":"https://example.com/a?b=1#c"}}', "ext");
    assert.equal(entryUrl(external, ctx), "https://example.com/a?b=1&helper=http://127.0.0.1:3981#c");
  });

  test("an entry command's URL is opened (T3's pairing token)", () => {
    const manifest = parseManifest(
      JSON.stringify({ server: { run: "plutonium", argv: ["x"], port: 1, entryCommand: ["echo", "http://127.0.0.1:{port}/#t=1"] } }),
      "t",
    );
    const home = fresh("home");
    mkdirSync(shellDir(home, "t"), { recursive: true });
    assert.equal(entryUrl(manifest, context(home)), "http://127.0.0.1:201/?helper=http://127.0.0.1:3981#t=1");
  });
});

describe("installing and updating", () => {
  test("install makes a git repository at the shipped version", () => {
    const home = fresh("home");
    const root = shipped();
    assert.equal(installShell(home, root, "demo"), true);
    assert.equal(installShell(home, root, "demo"), false);
    assert.deepEqual(gitLog(shellDir(home, "demo")), ["shipped: demo 1"]);
    assert.deepEqual(effectiveList(home), [{ name: "demo", enabled: false }]);
    writeList(home, [{ name: "demo", enabled: true }, { name: "gone", enabled: true }]);
    assert.deepEqual(effectiveList(home), [{ name: "demo", enabled: true }]);
    assert.equal(readList(home)?.length, 2);
  });

  test("update merges a new shipped version with the user's edits", () => {
    const home = fresh("home");
    installShell(home, shipped("1", "<h1>one</h1>\n<p>body</p>\n"), "demo");
    const dir = shellDir(home, "demo");
    writeFileSync(join(dir, "mine.css"), "body {}\n");
    assert.deepEqual(updateShell(home, shipped("1", "<h1>one</h1>\n<p>body</p>\n"), "demo"), { status: "up-to-date" });
    assert.equal(gitLog(dir)[0], "edit: mine.css");
    const result = updateShell(home, shipped("2", "<h1>two</h1>\n<p>body</p>\n"), "demo");
    assert.deepEqual(result, { status: "updated", version: "2" });
    assert.match(readFileSync(join(dir, "index.html"), "utf8"), /two/);
    assert.equal(readFileSync(join(dir, "mine.css"), "utf8"), "body {}\n");
  });

  test("a conflicting update is reported and leaves the copy as it was", () => {
    const home = fresh("home");
    installShell(home, shipped(), "demo");
    const dir = shellDir(home, "demo");
    writeFileSync(join(dir, "index.html"), "<h1>mine</h1>\n");
    const result = updateShell(home, shipped("2", "<h1>theirs</h1>\n"), "demo");
    assert.equal(result.status, "conflict");
    assert.deepEqual(result.status === "conflict" && result.files, ["index.html"]);
    assert.equal(readFileSync(join(dir, "index.html"), "utf8"), "<h1>mine</h1>\n");
    assert.equal(execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" }), "");
  });
});

describe("adding a shell", () => {
  test("a folder: previewed with its origin and server command, then copied as a git repository", () => {
    const home = fresh("home");
    const source = fresh("mine");
    writeFileSync(
      join(source, "shell.json"),
      JSON.stringify({ title: "Mine", server: { run: "plutonium", argv: ["node", "server.js", "{port}"], port: 5000 } }),
    );
    const preview = previewShell(home, source, context(home));
    assert.equal(preview.kind, "folder");
    assert.equal(preview.origin, "http://127.0.0.1:5200");
    assert.equal(preview.command, "node server.js 5200");
    const name = addShell(home, preview);
    assert.deepEqual(gitLog(shellDir(home, name)), ["added: shell.json"]);
  });

  test("an address becomes an external shell", () => {
    const home = fresh("home");
    const preview = previewShell(home, "http://localhost:5173/app", context(home));
    assert.equal(preview.kind, "address");
    assert.equal(preview.origin, "http://localhost:5173");
    const name = addShell(home, preview);
    assert.equal(name, "port-5173");
    assert.throws(() => previewShell(home, "nonsense", context(home)), ShellError);
  });
});

describe("the built-in server", () => {
  const home = fresh("home");
  installShell(home, shipped(), "demo");
  let server: Server;
  let port = 0;
  // (fetch sets its own Host.)
  const get = (host: string, path: string) =>
    new Promise<{ status: number; type: string | undefined; text: string }>((resolve, reject) => {
      httpGet({ host: "127.0.0.1", port, path, headers: { Host: host } }, (response) => {
        let text = "";
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () => resolve({ status: response.statusCode!, type: response.headers["content-type"], text }));
      }).on("error", reject);
    });
  test("serves a static shell by host, never dot files", async () => {
    server = createServer((request, response) => serveStaticShell(home, request, response));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    after(() => server.close());
    const page = await get(`demo.localhost:${port}`, "/?helper=x");
    assert.equal(page.status, 200);
    assert.equal(page.type, "text/html; charset=utf-8");
    assert.match(page.text, /one/);
    assert.equal((await get(`demo.localhost:${port}`, "/.git/config")).status, 404);
    assert.equal((await get(`demo.localhost:${port}`, "/%2e%2e/%2e%2e/etc/passwd")).status, 404);
    assert.equal((await get(`other.localhost:${port}`, "/")).status, 404);
    assert.equal((await get(`127.0.0.1:${port}`, "/")).status, 404);
  });
});

describe("edits", () => {
  test("a save is committed; no page coming up rolls it back, and Retry applies it again", async () => {
    const home = fresh("home");
    installShell(home, shipped(), "demo");
    const ctx = context(home);
    const reloads: string[] = [];
    const packages = new ShellPackages(ctx, {
      connectTimeoutMs: 600,
      hooks: { reloadPages: async (origin) => (reloads.push(origin), 1) },
    });
    const origin = "http://demo.localhost:8970";
    packages.start([origin]);
    after(() => packages.stop());
    const dir = shellDir(home, "demo");
    packages.connected(origin);

    // Comes up: kept.
    writeFileSync(join(dir, "index.html"), "<h1>good edit</h1>\n");
    await waitFor(() => gitLog(dir)[0] === "edit: index.html");
    await waitFor(() => reloads.length === 1);
    packages.connected(origin);
    await sleep(800);
    assert.equal(gitLog(dir)[0], "edit: index.html");

    // Doesn't: rolled back to the good edit.
    writeFileSync(join(dir, "index.html"), "<h1>broken</h1>\n");
    await waitFor(() => gitLog(dir)[0]!.startsWith("rollback: "), 5_000);
    assert.equal(readFileSync(join(dir, "index.html"), "utf8"), "<h1>good edit</h1>\n");
    const status = packages.status().find((shell) => shell.name === "demo")!;
    assert.match(status.notice ?? "", /didn't come up/);
    assert.equal(status.failed?.subject, "edit: index.html");
    assert.match(packages.text("demo", "diff"), /broken/);

    await packages.action("demo", "retry");
    assert.equal(readFileSync(join(dir, "index.html"), "utf8"), "<h1>broken</h1>\n");
    packages.connected(origin);
    await sleep(800);
    assert.equal(gitLog(dir)[0], "retry: edit: index.html");
    assert.equal(packages.status().find((shell) => shell.name === "demo")!.failed, undefined);
  });

  test("the browser's list is saved; an unknown page becomes an external shell", () => {
    const home = fresh("home");
    installShell(home, shipped(), "demo");
    const packages = new ShellPackages(context(home), { persist: true });
    after(() => packages.stop());
    packages.browserList([
      { name: "Elsewhere", url: "http://localhost:5173/?helper=http://127.0.0.1:3981", enabled: true },
      { name: "Demo", url: "http://demo.localhost:8970/?helper=x", enabled: false },
    ]);
    assert.deepEqual(readList(home), [
      { name: "elsewhere", enabled: true },
      { name: "demo", enabled: false },
    ]);
    const manifest = JSON.parse(readFileSync(join(shellDir(home, "elsewhere"), "shell.json"), "utf8"));
    assert.deepEqual(manifest.server, { run: "external", url: "http://localhost:5173/" });

    // Added on the shells page: on, even before the browser lists it.
    const source = fresh("added");
    writeFileSync(join(source, "shell.json"), '{"static":"index.html"}');
    const { token } = packages.add({ source }) as { token: string };
    const added = packages.add({ token }) as { name: string; add?: boolean };
    assert.equal(added.add, true);
    packages.browserList([{ name: "Demo", url: "http://demo.localhost:8970/", enabled: true }]);
    assert.deepEqual(readList(home)?.find((entry) => entry.name === added.name), { name: added.name, enabled: true });
    packages.browserList([
      { name: "Demo", url: "http://demo.localhost:8970/", enabled: true },
      { name: "Added", url: `http://${added.name}.localhost:8970/`, enabled: true },
    ]);
    assert.equal(packages.status().find((shell) => shell.name === added.name)?.add, undefined);
  });
});

describe("new shells", () => {
  test("a copy of an installed shell, without its history, on; prompts name the skill", () => {
    const home = fresh("home");
    installShell(home, shipped(), "demo");
    const packages = new ShellPackages(context(home), { persist: true });
    after(() => packages.stop());
    const made = packages.create({ name: "mine", from: "demo" }) as { name: string; add?: boolean; title?: string };
    assert.equal(made.name, "mine");
    assert.equal(made.title, "mine");
    assert.equal(made.add, true);
    assert.equal(readFileSync(join(shellDir(home, "mine"), "index.html"), "utf8"), "<h1>one</h1>\n");
    assert.equal(JSON.parse(readFileSync(join(shellDir(home, "mine"), "shell.json"), "utf8")).description, "Made from Demo.");
    assert.equal(gitLog(shellDir(home, "mine")).length, 1);
    assert.deepEqual(readList(home)?.at(-1), { name: "mine", enabled: true });
    assert.throws(() => packages.create({ name: "mine" }), ShellError);
    assert.throws(() => packages.create({ name: "Not OK" }), ShellError);
    assert.match(packages.newShellPrompt(), /^Read the Plutonium skill at \/opt\/plutonium\/skill\/SKILL\.md first\. /);
    assert.match(packages.status().find((shell) => shell.name === "mine")?.prompt ?? "", /shell "mine", in .*\/mine\./);
  });
});

describe("servers", () => {
  test("started, healthy, restarted after a crash, stopped", async () => {
    const home = fresh("home");
    const port = 20000 + Math.floor(Math.random() * 20000);
    const script = join(home, "server.mjs");
    writeFileSync(
      script,
      `import { createServer } from "node:http";
       createServer((q, r) => r.end("ok")).listen(Number(process.env.PORT), "127.0.0.1");`,
    );
    const manifest = parseManifest(
      JSON.stringify({ server: { run: "plutonium", argv: [process.execPath, script], port: port - 200, restart: "on-failure" } }),
      "srv",
    );
    mkdirSync(shellDir(home, "srv"), { recursive: true });
    const server = new ShellServer(manifest, { ...context(home), waylandDisplay: `test-${port}` });
    assert.equal(await server.start(), true);
    const first = server.pid!;
    process.kill(first, "SIGKILL");
    await waitFor(() => server.state === "running" && server.pid !== first, 10_000);
    assert.equal(server.status().restarts, 1);
    await server.stop();
    assert.equal(server.state, "stopped");
    assert.match(readFileSync(join(home, "logs", "srv.log"), "utf8"), /plutonium: starting/);
  });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) throw new Error("timed out");
    await sleep(50);
  }
}

describe("a shell's uses", () => {
  test("names known desktop services only", () => {
    const base = { title: "Mine", static: "index.html" };
    assert.deepEqual(parseManifest(JSON.stringify({ ...base, uses: ["audio", "network"] }), "mine").uses, ["audio", "network"]);
    assert.equal(parseManifest(JSON.stringify(base), "mine").uses, undefined);
    assert.throws(() => parseManifest(JSON.stringify({ ...base, uses: ["telepathy"] }), "mine"), /telepathy/);
    assert.throws(() => parseManifest(JSON.stringify({ ...base, uses: "audio" }), "mine"), /list/);
  });

  test("an installed shell gets what it names; another page all", () => {
    assert.equal(mayUse(["audio"], true, "audio"), true);
    assert.equal(mayUse(["audio"], true, "network"), false);
    assert.equal(mayUse(undefined, true, "audio"), false);
    assert.equal(mayUse(undefined, false, "audio"), true);
  });
});

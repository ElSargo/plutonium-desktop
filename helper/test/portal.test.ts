// The portal backend (portal.ts): its restore data and handle parsing, and
// its D-Bus side end to end on a private dbus-daemon (skipped without one),
// called as xdg-desktop-portal calls it, with a stand-in for the browser.
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { DBusConnection } from "../src/dbus.ts";
import { type DesktopCapture } from "../src/desktop.ts";
import {
  findRestoredWindow,
  parseRestoreData,
  PORTAL_NAME,
  Portal,
  restoreData,
  senderOfHandle,
} from "../src/portal.ts";
import { isPng, saveScreenshot, screenshotName } from "../src/screenshots.ts";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest")]);

describe("portal restore data", () => {
  test("goes back to what it names", () => {
    const targets = [{ type: "output", name: "Built-in" } as const, { type: "window", appId: "foot", title: "~" } as const];
    const data = restoreData(targets);
    assert.equal(data[0], "plutonium");
    // Variants arrive unwrapped from the bus.
    assert.deepEqual(parseRestoreData([data[0], data[1], data[2][1]]), targets);
    assert.equal(parseRestoreData(["gnome", 1, "{}"]), null);
    assert.equal(parseRestoreData(["plutonium", 1, "not json"]), null);
    assert.equal(parseRestoreData(undefined), null);
  });

  test("a window comes back by app id, its title first", () => {
    const windows = [
      { id: 1, appId: "foot", title: "a" },
      { id: 2, appId: "foot", title: "b" },
      { id: 3, appId: "firefox", title: "b" },
    ];
    assert.equal(findRestoredWindow(windows, { appId: "foot", title: "b" }), 2);
    assert.equal(findRestoredWindow(windows, { appId: "foot", title: "c" }), 1);
    assert.equal(findRestoredWindow(windows, { appId: "obs", title: "b" }), undefined);
  });

  test("a request handle names its sender", () => {
    assert.equal(senderOfHandle("/org/freedesktop/portal/desktop/request/1_42/obs1"), ":1.42");
    assert.equal(senderOfHandle("/org/freedesktop/portal/desktop/session/1_7/s"), ":1.7");
    assert.equal(senderOfHandle("/elsewhere"), undefined);
  });
});

describe("screenshots on disk", () => {
  test("named by the time, never overwritten", () => {
    const dir = mkdtempSync(join(tmpdir(), "plutonium-shots-"));
    try {
      const date = new Date(2026, 9, 24, 14, 3, 12);
      assert.equal(screenshotName(date), "Screenshot from 2026-10-24 14-03-12.png");
      const first = saveScreenshot(PNG, { dir, date });
      const second = saveScreenshot(PNG, { dir, date });
      assert.equal(first.path, join(dir, "Screenshot from 2026-10-24 14-03-12.png"));
      assert.equal(second.path, join(dir, "Screenshot from 2026-10-24 14-03-12 (1).png"));
      assert.deepEqual(readFileSync(second.path), PNG);
      assert.throws(() => saveScreenshot(Buffer.from("GIF89a"), { dir }), /PNG/);
      assert.ok(isPng(PNG));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** The browser's capture API, as the portal uses it. */
class FakeDesktop {
  readonly captureListeners = new Set<(type: "start" | "change" | "stop", capture: DesktopCapture) => void>();
  readonly commands: { command: string; args: Record<string, unknown> }[] = [];
  /** What "request" answers. */
  answer: unknown = { sources: [{ type: "window", id: 7 }] };
  private nextId = 1;

  async available(): Promise<boolean> {
    return true;
  }

  async captureSources() {
    return {
      outputs: [{ id: "21299991680", name: "Built-in", width: 1600, height: 1000, scaleFactor: 1, primary: true }],
      windows: [{ id: 7, title: "~", appId: "foot", width: 800, height: 600, tags: [] }],
      tabs: [],
    };
  }

  async captureCommand(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.commands.push({ command, args });
    if (command === "request") return this.answer;
    if (command === "start") return { captureId: this.nextId++, nodeId: 77, width: 800, height: 600 };
    return null;
  }

  async screenshot() {
    return { data: PNG, width: 1, height: 1 };
  }

  stopped(id: number): void {
    for (const listener of this.captureListeners) {
      listener("stop", { id, kind: "pipewire", source: { type: "window", id: 7 }, label: "~", consumer: {}, cursor: "hidden", startTime: 0 });
    }
  }
}

const dbusDaemon = spawnSync("sh", ["-c", "command -v dbus-daemon"]).stdout.toString().trim();

describe("portal backend on a bus", { skip: dbusDaemon ? false : "no dbus-daemon" }, () => {
  let dir: string;
  let daemon: ChildProcess;
  let address: string;
  let desktop: FakeDesktop;
  let portal: Portal;
  let client: DBusConnection;
  let shots: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "plutonium-portal-"));
    shots = join(dir, "shots");
    process.env.PLUTONIUM_SCREENSHOTS_DIR = shots;
    address = `unix:path=${join(dir, "bus")}`;
    daemon = spawn(dbusDaemon, ["--session", "--nofork", `--address=${address}`], { stdio: "ignore" });
    for (let i = 0; i < 50 && !existsSync(join(dir, "bus")); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    desktop = new FakeDesktop();
    portal = new Portal({
      desktop: desktop as never,
      apps: { list: () => [{ id: "com.obsproject.Studio.desktop", name: "OBS Studio" }] } as never,
      threadForPid: () => "t3:thread/1",
      address,
    });
    await portal.start();
    client = await DBusConnection.connect(address);
  });

  after(() => {
    client?.close();
    portal?.stop();
    daemon?.kill();
    delete process.env.PLUTONIUM_SCREENSHOTS_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  const call = (iface: string, member: string, signature: string, body: unknown[]) =>
    client.call({ destination: PORTAL_NAME, path: "/org/freedesktop/portal/desktop", interface: iface, member, signature, body });
  const handle = () => `/org/freedesktop/portal/desktop/request/${client.name.slice(1).replace(".", "_")}/t${Math.random().toString(36).slice(2)}`;
  const session = "/org/freedesktop/portal/desktop/session/1_1/s1";
  const SCREENCAST = "org.freedesktop.impl.portal.ScreenCast";

  test("says what it can do", async () => {
    const [properties] = (await client.call({
      destination: PORTAL_NAME,
      path: "/org/freedesktop/portal/desktop",
      interface: "org.freedesktop.DBus.Properties",
      member: "GetAll",
      signature: "s",
      body: [SCREENCAST],
    })) as [Map<string, unknown>];
    assert.equal(properties.get("version"), 5);
    assert.equal(properties.get("AvailableSourceTypes"), 3);
    assert.equal(properties.get("AvailableCursorModes"), 7);
  });

  test("a screencast asks, starts a node and hands back restore data", async () => {
    let [response] = await call(SCREENCAST, "CreateSession", "oosa{sv}", [handle(), session, "com.obsproject.Studio", new Map()]);
    assert.equal(response, 0);
    [response] = await call(SCREENCAST, "SelectSources", "oosa{sv}", [
      handle(),
      session,
      "com.obsproject.Studio",
      new Map([
        ["types", ["u", 3]],
        ["cursor_mode", ["u", 4]],
        ["persist_mode", ["u", 2]],
      ]),
    ]);
    assert.equal(response, 0);
    const [code, results] = (await call(SCREENCAST, "Start", "oossa{sv}", [
      handle(),
      session,
      "com.obsproject.Studio",
      "",
      new Map(),
    ])) as [number, Map<string, unknown>];
    assert.equal(code, 0);
    const request = desktop.commands.find((entry) => entry.command === "request")!;
    assert.deepEqual(request.args.types, ["output", "window", "tab"]);
    const consumer = request.args.consumer as Record<string, unknown>;
    assert.equal(consumer.name, "OBS Studio");
    assert.equal(consumer.pid, process.pid);
    assert.equal(consumer.thread, "t3:thread/1");
    const start = desktop.commands.find((entry) => entry.command === "start")!;
    assert.equal(start.args.cursor, "metadata");
    const streams = results.get("streams") as [number, Map<string, unknown>][];
    assert.equal(streams[0]![0], 77);
    assert.deepEqual(streams[0]![1].get("size"), [800, 600]);
    assert.equal(streams[0]![1].get("source_type"), 2);
    assert.equal(results.get("persist_mode"), 2);
    const restore = results.get("restore_data") as unknown[];
    assert.deepEqual(parseRestoreData(restore), [{ type: "window", appId: "foot", title: "~" }]);

    // Restored: no request this time.
    const restored = "/org/freedesktop/portal/desktop/session/1_1/s2";
    await call(SCREENCAST, "CreateSession", "oosa{sv}", [handle(), restored, "com.obsproject.Studio", new Map()]);
    await call(SCREENCAST, "SelectSources", "oosa{sv}", [
      handle(),
      restored,
      "com.obsproject.Studio",
      new Map([["restore_data", ["(suv)", restoreData([{ type: "window", appId: "foot", title: "~" }])]]]),
    ]);
    const requests = desktop.commands.filter((entry) => entry.command === "request").length;
    const [again] = await call(SCREENCAST, "Start", "oossa{sv}", [handle(), restored, "com.obsproject.Studio", "", new Map()]);
    assert.equal(again, 0);
    assert.equal(desktop.commands.filter((entry) => entry.command === "request").length, requests);

    // Closing the session stops its capture.
    await client.call({ destination: PORTAL_NAME, path: session, interface: "org.freedesktop.impl.portal.Session", member: "Close" });
    assert.ok(desktop.commands.some((entry) => entry.command === "stop" && entry.args.id === 1));
  });

  test("a refused request is cancelled", async () => {
    desktop.answer = null;
    const refused = "/org/freedesktop/portal/desktop/session/1_1/s3";
    await call(SCREENCAST, "CreateSession", "oosa{sv}", [handle(), refused, "", new Map()]);
    const [code] = await call(SCREENCAST, "Start", "oossa{sv}", [handle(), refused, "", "", new Map()]);
    assert.equal(code, 1);
    desktop.answer = { sources: [{ type: "window", id: 7 }] };
  });

  test("a screenshot is a file", async () => {
    const [code, results] = (await call("org.freedesktop.impl.portal.Screenshot", "Screenshot", "ossa{sv}", [
      handle(),
      "",
      "",
      new Map([["interactive", ["b", false]]]),
    ])) as [number, Map<string, unknown>];
    assert.equal(code, 0);
    const path = fileURLToPath(String(results.get("uri")));
    assert.ok(path.startsWith(shots));
    assert.deepEqual(readFileSync(path), PNG);
  });
});

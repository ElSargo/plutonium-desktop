import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { describe, test } from "node:test";

import { DBusConnection } from "../src/dbus.ts";
import type { WebNotification } from "../src/desktop.ts";
import {
  type BrowserNotifications,
  CLOSED,
  fromWeb,
  NotificationsService,
  parseNotify,
  type NotificationsState,
} from "../src/services/notifications.ts";

const run = promisify(execFile);
const notifyArgs = (summary: string, extra: { actions?: string[]; hints?: Map<string, unknown>; timeout?: number; replaces?: number } = {}) => [
  "app",
  extra.replaces ?? 0,
  "dialog-information",
  summary,
  "the body",
  extra.actions ?? [],
  extra.hints ?? new Map(),
  extra.timeout ?? -1,
];

describe("notifications", () => {
  test("what Notify describes", () => {
    const n = parseNotify(7, notifyArgs("Hi", {
      actions: ["default", "Open", "later", "Later"],
      hints: new Map<string, unknown>([["urgency", 2], ["desktop-entry", "org.gnome.Nautilus"], ["transient", true]]),
    }), 1000);
    assert.deepEqual(n, {
      id: 7, app: "app", icon: "dialog-information", summary: "Hi", body: "the body",
      actions: [{ key: "default", label: "Open" }, { key: "later", label: "Later" }],
      urgency: "critical", desktopEntry: "org.gnome.Nautilus", transient: true, time: 1000,
    });
    assert.equal(parseNotify(1, notifyArgs("x")).urgency, "normal");
  });

  test("the list: newest first, replace, dismiss, invoke, clear, expiry, do not disturb", async () => {
    const service = new NotificationsService();
    const states: NotificationsState[] = [];
    // Not started: no bus, but the list works.
    (service as unknown as { changed: (s: unknown) => void }).changed = (s) => states.push(s as NotificationsState);
    const a = service.notify(notifyArgs("A"));
    const b = service.notify(notifyArgs("B"));
    assert.deepEqual((await service.state()).notifications.map((n) => n.summary), ["B", "A"]);
    assert.equal(service.notify(notifyArgs("A again", { replaces: a })), a);
    assert.deepEqual((await service.state()).notifications.map((n) => n.summary), ["A again", "B"]);
    await service.call("dismiss", { id: b });
    await service.call("invoke", { id: a, action: "default" });
    assert.equal((await service.state()).notifications.length, 0);
    await assert.rejects(service.call("invoke", { id: 99 }), /no notification/);
    service.notify(notifyArgs("C"));
    service.notify(notifyArgs("D"));
    await service.call("clear", {});
    assert.equal((await service.state()).notifications.length, 0);
    service.notify(notifyArgs("brief", { timeout: 30 }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal((await service.state()).notifications.length, 0);
    assert.equal(await service.call("set-do-not-disturb", { on: true }), true);
    assert.equal(states.at(-1)?.doNotDisturb, true);
    await assert.rejects(service.call("explode", {}), /no action/);
    service.stop();
  });

  test("tabs' web notifications: the site as the app, click, buttons, dismiss, closed by the page", async () => {
    const web = (id: string, title: string): WebNotification => ({
      id, origin: "https://chat.example:8443", title, body: "a message", icon: "data:image/png;base64,AA==",
      buttons: ["Reply"], requireInteraction: false, silent: false,
    });
    assert.deepEqual(fromWeb(3, web("w", "Hi"), 5), {
      id: 3, app: "chat.example:8443", icon: "data:image/png;base64,AA==", summary: "Hi", body: "a message",
      actions: [{ key: "default", label: "Open" }, { key: "button-0", label: "Reply" }],
      urgency: "normal", transient: false, time: 5, site: "https://chat.example:8443",
    });
    const calls: unknown[][] = [];
    let listener: Parameters<BrowserNotifications["onChange"]>[0] = () => {};
    const browser: BrowserNotifications = {
      onChange: (l) => (listener = l),
      action: async (...args) => void calls.push(["action", ...args]),
      showSite: async (origin) => void calls.push(["show", origin]),
    };
    // serveBus false: a test session's, which leaves the bus alone.
    const service = new NotificationsService("unix:path=/nonexistent", browser, false);
    await service.start(() => {});
    listener({ shown: web("w1", "First") });
    listener({ shown: web("w2", "Second") });
    listener({ shown: web("w1", "First, updated") });
    const [first, second] = (await service.state()).notifications;
    assert.deepEqual([first?.summary, second?.summary], ["First, updated", "Second"]);
    // Its button, then itself: the page's handlers, and the tab shows for a click on it.
    await service.call("invoke", { id: first!.id, action: "button-0" });
    assert.deepEqual(calls.splice(0), [["action", "w1", "click", 0], ["action", "w1", "close"]]);
    await service.call("invoke", { id: second!.id, action: "default" });
    assert.deepEqual(calls.splice(0), [
      ["action", "w2", "click", undefined],
      ["show", "https://chat.example:8443"],
      ["action", "w2", "close"],
    ]);
    // Dismissed here: closed there; closed there (the page): gone here, nothing sent back.
    const third = service.notifyWeb(web("w3", "Third"));
    await service.call("dismiss", { id: third });
    assert.deepEqual(calls.splice(0), [["action", "w3", "close"]]);
    service.notifyWeb(web("w4", "Fourth"));
    listener({ closed: "w4" });
    listener({ closed: "unknown" });
    assert.equal((await service.state()).notifications.length, 0);
    assert.deepEqual(calls, []);
    service.stop();
  });

  test("apps reach it over D-Bus (a private bus, notify-send)", async (t) => {
    let daemon;
    try {
      daemon = spawn("dbus-daemon", ["--session", "--nofork", "--print-address=1"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return t.skip("no dbus-daemon");
    }
    const address = await new Promise<string>((resolve, reject) => {
      daemon.once("error", reject);
      daemon.stdout!.once("data", (data: Buffer) => resolve(data.toString().trim()));
    }).catch(() => "");
    if (!address) return t.skip("no dbus-daemon");
    const service = new NotificationsService(address);
    const states: NotificationsState[] = [];
    try {
      await service.start((state) => states.push(state as NotificationsState));
      const env = { ...process.env, DBUS_SESSION_BUS_ADDRESS: address };
      const { stdout } = await run("notify-send", ["-p", "-u", "critical", "-a", "Tester", "Hello", "from an app"], { env });
      const id = Number(stdout.trim());
      const [n] = (await service.state()).notifications;
      assert.equal(n?.id, id);
      assert.equal(n?.summary, "Hello");
      assert.equal(n?.app, "Tester");
      assert.equal(n?.urgency, "critical");
      assert.equal(states.length, 1);
      const info = await run("gdbus", ["call", "--session", "--dest", "org.freedesktop.Notifications", "--object-path",
        "/org/freedesktop/Notifications", "--method", "org.freedesktop.Notifications.GetServerInformation"], { env }).catch(() => null);
      if (info) assert.match(info.stdout, /Plutonium/);
      assert.equal(CLOSED.dismissed, 2);
      // A test session's (serve false) stays off the bus, even started.
      const quiet = new NotificationsService(address, undefined, false);
      await quiet.start(() => {});
      quiet.notify(["Shell", 0, "", "Its own", "", [], new Map(), -1]);
      assert.equal((await quiet.state()).notifications[0]?.summary, "Its own");
      service.stop();
      const bus = await DBusConnection.connect(address);
      const hasOwner = async () => ((await bus.call({ destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus",
        interface: "org.freedesktop.DBus", member: "NameHasOwner", signature: "s", body: ["org.freedesktop.Notifications"] })) as [boolean])[0];
      for (let i = 0; i < 50 && (await hasOwner()); i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(await hasOwner(), false);
      bus.close();
      quiet.stop();
    } finally {
      service.stop();
      daemon.kill();
    }
  });
});

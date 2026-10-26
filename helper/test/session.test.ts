import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { DBusConnection } from "../src/dbus.ts";
import { findChecker, unixChecker } from "../src/password.ts";
import {
  SessionService,
  wakeLockInhibitors,
  type BrowserIdle,
  type SessionBrowser,
  type SessionState,
} from "../src/services/session.ts";
import { FakeBus } from "./fixtures/fakeBus.ts";

const SESSION = "/org/freedesktop/login1/session/_3";
const LOGIN = "org.freedesktop.login1";

/** Ash's side, as the Plutonium domain answers it. */
class FakeBrowser implements SessionBrowser {
  idleSeconds = 0;
  locked = false;
  displaysOff = false;
  wakeLocks: string[] = [];
  /** setDisplaysOff's answer: false as on X11. */
  canTurnOff = true;
  readonly locks: { user: string; message: string }[] = [];
  private readonly listeners = new Set<(locked: boolean) => void>();

  async lock(user: string, message: string): Promise<void> {
    this.locks.push({ user, message });
    this.setLocked(true);
  }
  async idle(): Promise<BrowserIdle> {
    return { locked: this.locked, idleSeconds: this.idleSeconds, displaysOff: this.displaysOff, wakeLocks: this.wakeLocks };
  }
  async setDisplaysOff(off: boolean): Promise<boolean> {
    if (!this.canTurnOff) return false;
    this.displaysOff = off;
    return true;
  }
  onLockChanged(listener: (locked: boolean) => void): void {
    this.listeners.add(listener);
  }
  /** As Ash does: the lock went up or down. */
  setLocked(locked: boolean): void {
    this.locked = locked;
    for (const listener of this.listeners) listener(locked);
  }
}

/** The test double for unix_chkpwd's answer. */
const checker = async (password: string) => password === "right";

describe("session service", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "plutonium-session-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const make = (browser: FakeBrowser | null, options: Partial<ConstructorParameters<typeof SessionService>[0]> = {}) =>
    new SessionService({
      browser,
      checker,
      settingsFile: join(dir, `session-${Math.random()}.json`),
      user: "Test User",
      failureDelayMs: 0,
      ...options,
    });

  test("locks, and only the password unlocks", async () => {
    const browser = new FakeBrowser();
    const session = make(browser);
    const states: SessionState[] = [];
    await session.start((state) => states.push(state as SessionState));
    const state = (await session.call("lock", {})) as SessionState;
    assert.equal(state.locked, true);
    assert.deepEqual(browser.locks, [{ user: "Test User", message: "" }]);
    assert.deepEqual(await session.unlock("wrong"), { ok: false, error: "That's not the password." });
    assert.deepEqual(await session.unlock("right"), { ok: true });
    // Ash takes it down on the yes, and says so.
    browser.setLocked(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await session.state()).locked, false);
    assert.equal(states.at(-1)?.locked, false);
    session.stop();
  });

  test("wrong passwords make the next ones wait", async () => {
    const session = make(new FakeBrowser());
    for (let i = 0; i < 4; i++) assert.equal((await session.unlock("guess")).retryAfter, undefined);
    assert.equal((await session.unlock("guess")).retryAfter, 30);
    const refused = await session.unlock("right");
    assert.equal(refused.ok, false, "not even the right one, while it waits");
    assert.match(refused.error!, /Too many/);
  });

  test("refuses to lock with no way to check the password, with a notice", async () => {
    const notices: string[] = [];
    const browser = new FakeBrowser();
    const session = make(browser, { checker: null, notify: (summary) => notices.push(summary) });
    await session.start(() => {});
    const state = await session.state();
    assert.equal(state.canLock, false);
    assert.match(state.problem!, /unix_chkpwd/);
    await assert.rejects(session.call("lock", {}), (error: Error & { status?: number }) => error.status === 409);
    assert.equal(browser.locks.length, 0);
    assert.deepEqual(notices, ["The screen wasn't locked"]);
    assert.deepEqual(await session.unlock("right"), { ok: false, error: state.problem });
    session.stop();
  });

  test("idle: the screen off, then the lock; kept settings", async () => {
    const browser = new FakeBrowser();
    const settingsFile = join(dir, "idle.json");
    const session = make(browser, { settingsFile });
    await session.start(() => {});
    assert.deepEqual(
      { lockAfter: (await session.state()).lockAfter, screenOffAfter: (await session.state()).screenOffAfter },
      { lockAfter: 600, screenOffAfter: 300 },
    );
    await assert.rejects(session.call("set-idle", { lockAfter: -1 }), /whole seconds/);
    browser.idleSeconds = 1.5;
    let state = (await session.call("set-idle", { lockAfter: 3, screenOffAfter: 1 })) as SessionState;
    assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")), { lockAfter: 3, screenOffAfter: 1 });
    assert.equal(state.idleAction, "screen-off");
    assert.equal(browser.displaysOff, true);
    assert.equal(browser.locks.length, 0);
    // It looks again when the lock is due.
    browser.idleSeconds = 3.2;
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    state = await session.state();
    assert.equal(state.idleAction, "lock");
    assert.equal(state.locked, true);
    assert.equal(browser.locks.length, 1);
    session.stop();
    // Another start reads them back.
    const again = make(new FakeBrowser(), { settingsFile });
    await again.start(() => {});
    assert.equal((await again.state()).lockAfter, 3);
    again.stop();
  });

  test("on X11 the screen off is only reported", async () => {
    const browser = new FakeBrowser();
    browser.canTurnOff = false;
    browser.idleSeconds = 10;
    const session = make(browser);
    await session.start(() => {});
    const state = (await session.call("set-idle", { lockAfter: 0, screenOffAfter: 5 })) as SessionState;
    assert.equal(state.idleAction, "screen-off");
    assert.equal(state.locked, false, "0: never locks");
    session.stop();
  });

  test("inhibitors hold it off, and idle counts from when they went", async () => {
    const browser = new FakeBrowser();
    browser.idleSeconds = 100;
    const session = make(browser);
    await session.start(() => {});
    await session.call("inhibit", { why: "Presenting" }, "niri");
    let state = (await session.call("set-idle", { lockAfter: 5, screenOffAfter: 2 })) as SessionState;
    assert.deepEqual(state.inhibitors, [{ who: "niri", why: "Presenting" }]);
    assert.equal(state.idleSeconds, 0);
    assert.equal(state.idleAction, "none");
    assert.equal(browser.locks.length, 0);
    state = (await session.call("uninhibit", {}, "niri")) as SessionState;
    assert.deepEqual(state.inhibitors, []);
    assert.equal(state.locked, false, "not straight away: idle starts again");
    // A tab playing video, through the browser's wake locks; the browser's own captures don't count.
    browser.wakeLocks = ["Video Wake Lock", "Capturing"];
    state = (await session.call("set-idle", {})) as SessionState;
    assert.deepEqual(state.inhibitors, [{ who: "browser", why: "Playing video" }]);
    // A shell that went away takes its inhibitor with it.
    await session.call("inhibit", {}, "plain");
    session.keepShells(new Set(["niri"]));
    assert.deepEqual((await session.state()).inhibitors, [{ who: "browser", why: "Playing video" }]);
    session.portalInhibit("/request/1", "mpv", "Playing");
    assert.equal((await session.state()).inhibitors.length, 2);
    session.portalUninhibit("/request/1");
    assert.equal((await session.state()).inhibitors.length, 1);
    session.stop();
  });

  test("the wake locks' names", () => {
    assert.deepEqual(
      wakeLockInhibitors([
        "Blink Wake Lock",
        "Power save blocker created by exo wayland idle inhibitor",
        "GetSnapshot",
        "Blink Wake Lock",
        "Something else",
      ]),
      [
        { who: "browser", why: "A page keeps the screen on" },
        { who: "app", why: "A Wayland app keeps the screen on" },
        { who: "browser", why: "Something else" },
      ],
    );
  });

  test("logind: its Lock signal for this session, and the lock before sleep", async () => {
    const bus = await FakeBus.start();
    bus.serveObject(LOGIN, "/org/freedesktop/login1", (method, body) =>
      method === `${LOGIN}.Manager.GetSession` && body[0] === "3"
        ? { signature: "o", body: [SESSION] }
        : { error: "org.freedesktop.login1.NoSuchSession" },
    );
    bus.serveObject(LOGIN, SESSION, (method, body) =>
      method === "org.freedesktop.DBus.Properties.Get" && body[1] === "TTY"
        ? { signature: "v", body: [["s", "tty5"]] }
        : { error: "org.freedesktop.DBus.Error.UnknownMethod" },
    );
    // Another session's helper (started from tty4, its own on tty5): it doesn't follow this one.
    const stranger = new FakeBrowser();
    const strangerHeld: string[] = [];
    const notOurs = make(stranger, {
      systemBus: bus.address,
      sessionId: "3",
      sessionTty: "tty4",
      inhibitSleep: () => (strangerHeld.push("take"), { release: () => {} }),
    });
    await notOurs.start(() => {});
    const browser = new FakeBrowser();
    const held: string[] = [];
    const session = make(browser, {
      systemBus: bus.address,
      sessionId: "3",
      sessionTty: "tty5",
      inhibitSleep: () => (held.push("take"), { release: () => held.push("release") }),
    });
    await session.start(() => {});
    assert.deepEqual(held, ["take"]);
    const wait = () => new Promise((resolve) => setTimeout(resolve, 100));
    // Another session's Lock isn't ours.
    bus.signal(LOGIN, "/org/freedesktop/login1/session/_9", `${LOGIN}.Session`, "Lock");
    await wait();
    assert.equal(browser.locks.length, 0);
    bus.signal(LOGIN, SESSION, `${LOGIN}.Session`, "Lock");
    await wait();
    assert.equal(browser.locks.length, 1);
    assert.equal(stranger.locks.length, 0, "a session on another TTY isn't followed");
    assert.deepEqual(strangerHeld, [], "nor does it hold sleep");
    // Unlock isn't followed: only the password takes it down.
    bus.signal(LOGIN, SESSION, `${LOGIN}.Session`, "Unlock");
    await wait();
    assert.equal(browser.locked, true);
    browser.setLocked(false);
    bus.signal(LOGIN, "/org/freedesktop/login1", `${LOGIN}.Manager`, "PrepareForSleep", "b", [true]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(browser.locks.at(-1), { user: "Test User", message: "Locked before sleep" });
    assert.deepEqual(held, ["take", "release"], "logind may sleep once the lock is up");
    bus.signal(LOGIN, "/org/freedesktop/login1", `${LOGIN}.Manager`, "PrepareForSleep", "b", [false]);
    await wait();
    assert.deepEqual(held, ["take", "release", "take"], "held again after waking");
    assert.equal(stranger.locks.length, 0);
    notOurs.stop();
    session.stop();
    await bus.stop();
  });

  test("org.freedesktop.ScreenSaver for apps (a private bus)", async (t) => {
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
    const browser = new FakeBrowser();
    const session = make(browser, { sessionBus: address });
    try {
      await session.start(() => {});
      const app = await DBusConnection.connect(address);
      const call = (member: string, signature = "", body: unknown[] = []) =>
        app.call({
          destination: "org.freedesktop.ScreenSaver",
          path: "/org/freedesktop/ScreenSaver",
          interface: "org.freedesktop.ScreenSaver",
          member,
          signature,
          body,
        });
      const [cookie] = (await call("Inhibit", "ss", ["mpv", "Playing a film"])) as [number];
      assert.deepEqual((await session.state()).inhibitors, [{ who: "mpv", why: "Playing a film" }]);
      await call("UnInhibit", "u", [cookie]);
      assert.deepEqual((await session.state()).inhibitors, []);
      await call("Inhibit", "ss", ["firefox", "video"]);
      assert.deepEqual(await call("GetActive"), [false]);
      // The app goes: so does its inhibitor.
      app.close();
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual((await session.state()).inhibitors, []);
      // xdg-screensaver lock.
      const other = await DBusConnection.connect(address);
      await other.call({
        destination: "org.freedesktop.ScreenSaver",
        path: "/ScreenSaver",
        interface: "org.freedesktop.ScreenSaver",
        member: "Lock",
      });
      assert.equal(browser.locks.length, 1);
      other.close();
    } finally {
      session.stop();
      daemon.kill();
    }
  });
});

describe("password checker", () => {
  test("unix_chkpwd's interface: the password on stdin with a NUL, the answer its exit status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plutonium-chkpwd-"));
    try {
      // A stand-in: 0 for "right", 7 (PAM_AUTH_ERR) for anything else, 9 for another user.
      const fake = join(dir, "unix_chkpwd");
      writeFileSync(
        fake,
        `#!${process.execPath}\n` +
          `const input = require("fs").readFileSync(0);\n` +
          `if (process.argv[2] !== ${JSON.stringify(userInfo().username)} || process.argv[3] !== "nullok") process.exit(9);\n` +
          `process.exit(input.equals(Buffer.from("right\\0")) ? 0 : 7);\n`,
      );
      chmodSync(fake, 0o755);
      assert.equal(findChecker([join(dir, "nothing"), fake]), fake);
      assert.equal(findChecker([join(dir, "nothing")]), null);
      const check = unixChecker(fake);
      assert.equal(await check("right"), true);
      assert.equal(await check("wrong"), false);
      await assert.rejects(unixChecker(fake, "someone-else")("right"), /exited with 9/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Opt-in: each run logs a failed password check in the journal.
  test("the real one says no to a wrong password (PLUTONIUM_TEST_CHKPWD=1)", async (t) => {
    const real = findChecker();
    if (process.env.PLUTONIUM_TEST_CHKPWD !== "1") return t.skip("PLUTONIUM_TEST_CHKPWD isn't 1");
    if (!real) return t.skip("no unix_chkpwd");
    assert.equal(await unixChecker(real)("not-the-password-☃-plutonium-test"), false);
  });
});

// The session service (DESKTOP_SERVICES.md, "session"): the lock screen and
// idle. Ash draws the lock (patch "the lock screen and idle"), over every
// display and above every shell, tab and app, and only takes it down for the
// password, which it hands to the helper (POST /v1/session/unlock) to check
// with unix_chkpwd (password.ts). This service decides when to lock: its
// `lock` action, Super+L (POST /v1/session/lock from Ash), logind's Lock
// signal for this session, before the computer sleeps (logind's
// PrepareForSleep, holding a delay inhibitor until the lock is up), and idle.
//
// Idle: the browser knows when the user last did anything; the service asks
// it (Plutonium.getIdle) when the next step is due, turns the displays off
// after `screenOffAfter` and locks after `lockAfter` (seconds; 0: never).
// Inhibitors hold both off: apps through org.freedesktop.ScreenSaver.Inhibit
// (served here on the session bus if nothing else has it) and the portal's
// Inhibit, the browser's wake locks (a tab playing video, the Screen Wake
// Lock API, a Wayland app's idle inhibitor), and shells' `inhibit`. Idle
// counts again from when the last inhibitor went.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { userInfo } from "node:os";
import { DBusConnection, DBusError, type Message, type Reply } from "../dbus.ts";
import { ServiceError, type DesktopService } from "../services.ts";
import type { PasswordChecker } from "../password.ts";

const SYSTEM_BUS = "unix:path=/run/dbus/system_bus_socket";
const LOGIN = "org.freedesktop.login1";
const LOGIN_PATH = "/org/freedesktop/login1";
const SCREENSAVER = "org.freedesktop.ScreenSaver";
const SCREENSAVER_PATHS = ["/org/freedesktop/ScreenSaver", "/ScreenSaver"];

/** What Plutonium.getIdle answers. */
export interface BrowserIdle {
  readonly locked: boolean;
  readonly idleSeconds: number;
  readonly displaysOff: boolean;
  readonly wakeLocks: readonly string[];
}

/** The browser's side: Ash's lock and what it knows of idle. */
export interface SessionBrowser {
  lock(user: string, message: string): Promise<void>;
  idle(): Promise<BrowserIdle>;
  setDisplaysOff(off: boolean): Promise<boolean>;
  onLockChanged(listener: (locked: boolean) => void): void;
}

export interface Inhibitor {
  readonly who: string;
  readonly why: string;
}

export interface SessionState {
  readonly locked: boolean;
  /** Since the user last did anything, as idle counts it (0 while inhibited). */
  readonly idleSeconds: number;
  /** What idle has done now: "none", "screen-off" (on X11 only reported) or "lock". */
  readonly idleAction: "none" | "screen-off" | "lock";
  /** Seconds; 0: never. */
  readonly lockAfter: number;
  readonly screenOffAfter: number;
  readonly inhibitors: readonly Inhibitor[];
  /** Whether it can lock: a password checker (unix_chkpwd) and a browser. */
  readonly canLock: boolean;
  /** Why it can't, when it can't. */
  readonly problem: string | null;
}

/** Something held until released (logind's delay inhibitor). */
export interface Held {
  release(): void;
}

export interface SessionOptions {
  /** Null without a browser with the Plutonium domain (no lock, no idle). */
  readonly browser: SessionBrowser | null;
  /** Null when there's none (it then refuses to lock). */
  readonly checker: PasswordChecker | null;
  /** Where lockAfter and screenOffAfter are kept. */
  readonly settingsFile: string;
  /** The session bus, for org.freedesktop.ScreenSaver; null: don't serve it. */
  readonly sessionBus?: string | null;
  /** The system bus, for logind (Lock, PrepareForSleep); null: don't listen (an X11 session). */
  readonly systemBus?: string | null;
  /** Our logind session (XDG_SESSION_ID), whose Lock signal locks. */
  readonly sessionId?: string;
  /** Takes logind's delay inhibitor for sleep (default: systemd-inhibit). */
  readonly inhibitSleep?: () => Held | null;
  /** The name shown on the lock (default: the account's full name). */
  readonly user?: string;
  /** How long a wrong password takes to answer (default 1 s). */
  readonly failureDelayMs?: number;
  /** Tells the user something (a notification). */
  readonly notify?: (summary: string, body: string) => void;
}

const DEFAULTS = { lockAfter: 600, screenOffAfter: 300 };
/** The longest wait between two looks at idle. */
const MAX_POLL_MS = 30_000;
/** While inhibited or idle has acted: to see it end soon. */
const WATCH_POLL_MS = 5_000;

/** The browser's wake locks as inhibitors; the browser's own captures don't count. */
export function wakeLockInhibitors(descriptions: readonly string[]): Inhibitor[] {
  const known: Record<string, Inhibitor | null> = {
    "Video Wake Lock": { who: "browser", why: "Playing video" },
    "Blink Wake Lock": { who: "browser", why: "A page keeps the screen on" },
    "Power save blocker created by exo wayland idle inhibitor": {
      who: "app",
      why: "A Wayland app keeps the screen on",
    },
    // A tab captured (the switcher, an agent's screencast), a snapshot.
    Capturing: null,
    GetSnapshot: null,
  };
  const result: Inhibitor[] = [];
  for (const description of descriptions) {
    const inhibitor = description in known ? known[description] : { who: "browser", why: description };
    if (inhibitor && !result.some((other) => other.who === inhibitor.who && other.why === inhibitor.why)) {
      result.push(inhibitor);
    }
  }
  return result;
}

/** The account's full name (its GECOS field), else its user name. */
export function displayName(passwd = "/etc/passwd"): string {
  const { username, uid } = userInfo();
  try {
    for (const line of readFileSync(passwd, "utf8").split("\n")) {
      const fields = line.split(":");
      if (Number(fields[2]) === uid && fields[4]) return fields[4].split(",")[0] || username;
    }
  } catch {}
  return username;
}

/** logind's delay inhibitor for sleep, as long as systemd-inhibit runs. */
function systemdInhibit(): Held | null {
  try {
    const child = spawn(
      "systemd-inhibit",
      ["--what=sleep", "--mode=delay", "--who=Plutonium", "--why=Locks the screen first", "cat"],
      // cat waits on our pipe: it ends with the helper.
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    child.on("error", (error) => console.warn(`session: systemd-inhibit: ${error.message}`));
    return { release: () => child.kill() };
  } catch {
    return null;
  }
}

export class SessionService implements DesktopService {
  readonly name = "session";
  private readonly options: SessionOptions;
  private changed: (state: unknown) => void = () => {};
  private locked = false;
  private idleSeconds = 0;
  private displaysOff = false;
  private idleAction: SessionState["idleAction"] = "none";
  private settings = { ...DEFAULTS };
  private browserInhibitors: Inhibitor[] = [];
  private readonly shellInhibitors = new Map<string, Inhibitor>();
  private readonly appInhibitors = new Map<string, Inhibitor & { sender?: string }>();
  /** When the last inhibitor went (ms): idle counts from then. */
  private inhibitedUntil = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticking: Promise<void> | null = null;
  private stopped = false;
  private failures = 0;
  private retryAt = 0;
  private checking = false;
  private nextCookie = 1;
  private session: DBusConnection | null = null;
  private system: DBusConnection | null = null;
  private sleepInhibitor: Held | null = null;
  private text = "";

  constructor(options: SessionOptions) {
    this.options = options;
  }

  async start(changed: (state: unknown) => void): Promise<void> {
    this.changed = changed;
    this.settings = this.readSettings();
    this.stopped = false;
    this.options.browser?.onLockChanged((locked) => {
      this.locked = locked;
      void this.tick();
    });
    if (this.options.sessionBus) {
      await this.serveScreenSaver(this.options.sessionBus).catch((error: Error) =>
        console.warn(`session: no ${SCREENSAVER}: ${error.message}`),
      );
    }
    if (this.options.systemBus) {
      await this.watchLogind(this.options.systemBus).catch((error: Error) =>
        console.warn(`session: no logind: ${error.message}`),
      );
    }
    await this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.sleepInhibitor?.release();
    this.sleepInhibitor = null;
    this.session?.close();
    this.system?.close();
    this.session = this.system = null;
  }

  async state(): Promise<SessionState> {
    const problem = this.problem();
    return {
      locked: this.locked,
      idleSeconds: Math.floor(this.idleSeconds),
      idleAction: this.idleAction,
      lockAfter: this.settings.lockAfter,
      screenOffAfter: this.settings.screenOffAfter,
      inhibitors: this.inhibitors(),
      canLock: problem === null,
      problem,
    };
  }

  async call(action: string, args: Record<string, unknown>, caller?: string): Promise<SessionState> {
    switch (action) {
      case "lock":
        await this.lock(typeof args.message === "string" ? args.message : "");
        return this.state();
      case "set-idle": {
        const next = { ...this.settings };
        for (const key of ["lockAfter", "screenOffAfter"] as const) {
          if (args[key] === undefined) continue;
          const value = Number(args[key]);
          if (!Number.isInteger(value) || value < 0) {
            throw new ServiceError(400, `${key}: whole seconds, 0 for never.`);
          }
          next[key] = value;
        }
        this.settings = next;
        this.writeSettings();
        await this.tick();
        return this.state();
      }
      case "inhibit": {
        const why = typeof args.why === "string" && args.why ? args.why : "A shell keeps the screen on";
        this.shellInhibitors.set(caller ?? "shell", { who: caller ?? "shell", why });
        await this.tick();
        return this.state();
      }
      case "uninhibit":
        this.release(() => this.shellInhibitors.delete(caller ?? "shell"));
        await this.tick();
        return this.state();
      default:
        throw new ServiceError(404, `session has no action "${action}".`);
    }
  }

  /**
   * Puts the lock up. Refuses (409) when there'd be no way back: no password
   * checker, or no browser to draw it.
   */
  async lock(message = ""): Promise<void> {
    const problem = this.problem();
    if (problem) {
      this.options.notify?.("The screen wasn't locked", problem);
      throw new ServiceError(409, `Can't lock: ${problem}`);
    }
    await this.options.browser!.lock(this.options.user ?? displayName(), message);
    this.locked = true;
    console.log(`plutoniumd: session: locked${message ? ` (${message})` : ""}`);
    this.emit();
  }

  /**
   * The password typed on the lock (POST /v1/session/unlock, from Ash):
   * whether it's the user's. Ash takes the lock down on a yes. Wrong ones
   * take a second to answer, and from the fifth in a row each makes the next
   * wait (30 s, doubling, up to 5 min).
   */
  async unlock(password: string): Promise<{ ok: boolean; error?: string; retryAfter?: number }> {
    const checker = this.options.checker;
    if (!checker) return { ok: false, error: this.problem() ?? "There's no way to check the password." };
    const now = Date.now();
    if (now < this.retryAt) {
      return { ok: false, error: "Too many wrong passwords.", retryAfter: Math.ceil((this.retryAt - now) / 1000) };
    }
    if (this.checking) return { ok: false, error: "A password is being checked." };
    this.checking = true;
    let ok: boolean;
    try {
      ok = await checker(password);
    } catch (error) {
      return { ok: false, error: `Couldn't check the password: ${(error as Error).message}` };
    } finally {
      this.checking = false;
    }
    if (ok) {
      this.failures = 0;
      this.retryAt = 0;
      console.log("plutoniumd: session: unlocked");
      return { ok: true };
    }
    this.failures++;
    console.warn(`plutoniumd: session: a wrong password (${this.failures} in a row)`);
    await new Promise((resolve) => setTimeout(resolve, this.options.failureDelayMs ?? 1_000));
    const wait = this.failures >= 5 ? Math.min(300, 30 * 2 ** (this.failures - 5)) : 0;
    this.retryAt = Date.now() + wait * 1000;
    return { ok: false, error: "That's not the password.", ...(wait ? { retryAfter: wait } : {}) };
  }

  /** Every inhibitor there is: shells', apps', the browser's. */
  inhibitors(): Inhibitor[] {
    return [
      ...[...this.shellInhibitors.values()],
      ...[...this.appInhibitors.values()].map(({ who, why }) => ({ who, why })),
      ...this.browserInhibitors,
    ];
  }

  /** The shells still connected: the others' inhibitors go (a shell closed or crashed). */
  keepShells(callers: ReadonlySet<string>): void {
    const gone = [...this.shellInhibitors.keys()].filter((caller) => !callers.has(caller));
    if (!gone.length) return;
    this.release(() => gone.forEach((caller) => this.shellInhibitors.delete(caller)));
    void this.tick();
  }

  /** The portal's Inhibit (portal.ts). */
  portalInhibit(key: string, who: string, why: string): void {
    this.appInhibitors.set(`portal:${key}`, { who, why: why || "Keeps the screen on" });
    void this.tick();
  }

  portalUninhibit(key: string): void {
    this.release(() => this.appInhibitors.delete(`portal:${key}`));
    void this.tick();
  }

  private problem(): string | null {
    if (!this.options.checker) {
      return "there's no way to check your password here (unix_chkpwd wasn't found; see plutonium doctor).";
    }
    if (!this.options.browser) return "this browser can't draw the lock (no Plutonium DevTools domain).";
    return null;
  }

  /** Runs `change` to inhibitors; if that was the last of them, idle counts from now. */
  private release(change: () => void): void {
    const before = this.inhibitors().length;
    change();
    if (before && !this.inhibitors().length) this.inhibitedUntil = Date.now();
  }

  /** Looks at idle now, acts on it, and sets when to look again. */
  private tick(): Promise<void> {
    if (!this.ticking) {
      this.ticking = this.look().finally(() => {
        this.ticking = null;
      });
    }
    return this.ticking;
  }

  private async look(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const browser = this.options.browser;
    if (!browser || this.stopped) return;
    let idle: BrowserIdle;
    try {
      idle = await browser.idle();
    } catch {
      this.schedule(10_000);
      return;
    }
    this.locked = idle.locked;
    this.displaysOff = idle.displaysOff;
    this.release(() => (this.browserInhibitors = wakeLockInhibitors(idle.wakeLocks)));
    const inhibited = this.inhibitors().length > 0;
    const sinceInhibited = (Date.now() - this.inhibitedUntil) / 1000;
    this.idleSeconds = inhibited ? 0 : Math.min(idle.idleSeconds, sinceInhibited);
    const { lockAfter, screenOffAfter } = this.settings;
    let action: SessionState["idleAction"] = "none";
    if (screenOffAfter && this.idleSeconds >= screenOffAfter) {
      action = "screen-off";
      if (!this.displaysOff && this.idleAction === "none") {
        this.displaysOff = await browser.setDisplaysOff(true).catch(() => false);
      }
    }
    if (lockAfter && this.idleSeconds >= lockAfter) {
      action = "lock";
      if (!this.locked && this.idleAction !== "lock") {
        await this.lock("").catch((error: Error) => console.warn(`session: idle: ${error.message}`));
      }
    }
    this.idleAction = action;
    // When the next step is due (activity since only pushes it later).
    const due = [screenOffAfter, lockAfter].filter((after) => after && after > this.idleSeconds);
    let next = due.length ? (Math.min(...due) - this.idleSeconds) * 1000 : MAX_POLL_MS;
    if (inhibited || action !== "none") next = Math.min(next, WATCH_POLL_MS);
    this.schedule(Math.min(MAX_POLL_MS, Math.max(250, next)));
    this.emit();
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref();
  }

  private readSettings(): typeof DEFAULTS {
    try {
      const saved = JSON.parse(readFileSync(this.options.settingsFile, "utf8")) as Partial<typeof DEFAULTS>;
      const pick = (value: unknown, fallback: number) =>
        Number.isInteger(value) && (value as number) >= 0 ? (value as number) : fallback;
      return {
        lockAfter: pick(saved.lockAfter, DEFAULTS.lockAfter),
        screenOffAfter: pick(saved.screenOffAfter, DEFAULTS.screenOffAfter),
      };
    } catch {
      return { ...DEFAULTS };
    }
  }

  private writeSettings(): void {
    try {
      mkdirSync(dirname(this.options.settingsFile), { recursive: true });
      writeFileSync(this.options.settingsFile, `${JSON.stringify(this.settings, null, 2)}\n`);
    } catch (error) {
      console.warn(`session: couldn't keep the idle settings: ${(error as Error).message}`);
    }
  }

  private emit(): void {
    void this.state().then((state) => {
      const text = JSON.stringify(state);
      if (text === this.text) return;
      this.text = text;
      this.changed(state);
    });
  }

  // org.freedesktop.ScreenSaver, for apps (mpv, Firefox, Electron, SDL games…).

  private async serveScreenSaver(address: string): Promise<void> {
    const bus = await DBusConnection.connect(address);
    bus.onCall = (message) => this.onScreenSaver(message);
    bus.onSignal = (message) => {
      // An app that inhibited went away: so does its inhibitor.
      if (message.member !== "NameOwnerChanged") return;
      const [name, , owner] = (message.body ?? []) as [string, string, string];
      if (owner) return;
      const gone = [...this.appInhibitors].filter(([, inhibitor]) => inhibitor.sender === name);
      if (!gone.length) return;
      this.release(() => gone.forEach(([key]) => this.appInhibitors.delete(key)));
      void this.tick();
    };
    // 4: don't queue. Another screensaver (a desktop's) keeps it.
    const [result] = (await bus.call({
      destination: "org.freedesktop.DBus",
      path: "/org/freedesktop/DBus",
      interface: "org.freedesktop.DBus",
      member: "RequestName",
      signature: "su",
      body: [SCREENSAVER, 4],
    })) as [number];
    if (result !== 1) {
      bus.close();
      console.log(`plutoniumd: session: ${SCREENSAVER} is someone else's`);
      return;
    }
    await bus.call({
      destination: "org.freedesktop.DBus",
      path: "/org/freedesktop/DBus",
      interface: "org.freedesktop.DBus",
      member: "AddMatch",
      signature: "s",
      body: ["type='signal',sender='org.freedesktop.DBus',member='NameOwnerChanged'"],
    });
    this.session = bus;
    console.log(`plutoniumd: session: serving ${SCREENSAVER}`);
  }

  private async onScreenSaver(message: Message): Promise<Reply> {
    const body = message.body ?? [];
    if (message.interface === "org.freedesktop.DBus.Introspectable" && message.member === "Introspect") {
      return { signature: "s", body: [SCREENSAVER_INTROSPECTION] };
    }
    if (!SCREENSAVER_PATHS.includes(message.path ?? "") || message.interface !== SCREENSAVER) {
      throw new DBusError("org.freedesktop.DBus.Error.UnknownMethod", `No such method ${message.interface}.${message.member}`);
    }
    switch (message.member) {
      case "Inhibit": {
        const cookie = this.nextCookie++;
        this.appInhibitors.set(`screensaver:${cookie}`, {
          who: String(body[0] || "An app"),
          why: String(body[1] || "Keeps the screen on"),
          sender: message.sender,
        });
        void this.tick();
        return { signature: "u", body: [cookie] };
      }
      case "UnInhibit":
        this.release(() => this.appInhibitors.delete(`screensaver:${Number(body[0])}`));
        void this.tick();
        return {};
      case "Lock":
        await this.lock("");
        return {};
      case "SetActive":
        if (body[0] === true) await this.lock("").catch(() => {});
        return { signature: "b", body: [this.locked] };
      case "GetActive":
        return { signature: "b", body: [this.locked] };
      case "GetActiveTime":
      case "GetSessionIdleTime":
        return { signature: "u", body: [Math.floor(this.idleSeconds)] };
      case "SimulateUserActivity":
        return {};
    }
    throw new DBusError("org.freedesktop.DBus.Error.UnknownMethod", `No such method ${SCREENSAVER}.${message.member}`);
  }

  // logind: its Lock signal for this session, and locking before sleep.

  private async watchLogind(address: string): Promise<void> {
    const bus = await DBusConnection.connect(address);
    this.system = bus;
    const call = (path: string, iface: string, member: string, signature = "", body: unknown[] = []) =>
      bus.call({ destination: LOGIN, path, interface: iface, member, signature, body });
    const match = (rule: string) =>
      bus.call({
        destination: "org.freedesktop.DBus",
        path: "/org/freedesktop/DBus",
        interface: "org.freedesktop.DBus",
        member: "AddMatch",
        signature: "s",
        body: [rule],
      });
    let sessionPath: string | null = null;
    if (this.options.sessionId) {
      [sessionPath] = (await call(LOGIN_PATH, `${LOGIN}.Manager`, "GetSession", "s", [this.options.sessionId])) as [string];
      await match(`type='signal',sender='${LOGIN}',path='${sessionPath}',interface='${LOGIN}.Session',member='Lock'`);
    }
    await match(`type='signal',sender='${LOGIN}',path='${LOGIN_PATH}',interface='${LOGIN}.Manager',member='PrepareForSleep'`);
    bus.onSignal = (message) => {
      if (message.member === "Lock" && message.path === sessionPath) {
        // (Unlock isn't followed: only the password takes the lock down.)
        void this.lock("").catch((error: Error) => console.warn(`session: logind Lock: ${error.message}`));
      } else if (message.member === "PrepareForSleep") {
        void this.prepareForSleep(message.body?.[0] === true);
      }
    };
    this.sleepInhibitor = (this.options.inhibitSleep ?? systemdInhibit)();
    console.log(`plutoniumd: session: following logind${sessionPath ? ` (${sessionPath})` : ""}`);
  }

  /** Before sleep: the lock up, then logind may go on. After: hold it again. */
  private async prepareForSleep(sleeping: boolean): Promise<void> {
    if (!sleeping) {
      this.sleepInhibitor ??= (this.options.inhibitSleep ?? systemdInhibit)();
      void this.tick();
      return;
    }
    if (!this.locked) {
      await this.lock("Locked before sleep").catch((error: Error) => console.warn(`session: before sleep: ${error.message}`));
      // A frame for Ash to draw it, so it's what shows on waking.
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    this.sleepInhibitor?.release();
    this.sleepInhibitor = null;
  }
}

const SCREENSAVER_INTROSPECTION = `<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">
<node>
  <interface name="${SCREENSAVER}">
    <method name="Inhibit"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="u" direction="out"/></method>
    <method name="UnInhibit"><arg type="u" direction="in"/></method>
    <method name="Lock"/>
    <method name="SetActive"><arg type="b" direction="in"/><arg type="b" direction="out"/></method>
    <method name="GetActive"><arg type="b" direction="out"/></method>
    <method name="GetActiveTime"><arg type="u" direction="out"/></method>
    <method name="GetSessionIdleTime"><arg type="u" direction="out"/></method>
    <method name="SimulateUserActivity"/>
  </interface>
</node>`;

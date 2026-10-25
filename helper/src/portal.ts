// The desktop portal's backend (docs/features/CAPTURE.md, "The portal
// backend"): org.freedesktop.impl.portal.ScreenCast and Screenshot on the
// session bus, as org.freedesktop.impl.portal.desktop.plutonium. Apps call
// xdg-desktop-portal (OBS, Firefox, Discord, a GStreamer pipeline); it calls
// this backend, which works through the browser's capture API (the DevTools
// Plutonium domain's captureCommand):
//
// - A request goes to the shell the user has in focus as "capturerequest"
//   (else Ash's picker); the answer names the sources.
// - Each source becomes a capture with a PipeWire node Ash produces; the
//   node ids go back to the app, which xdg-desktop-portal lets reach them.
// - Restore data names stable things ("the output", an app id and title, a
//   tab's URL), so a restored session skips the picker; it still goes to
//   every shell as "capturestart".
// - Screenshot: interactive asks; otherwise the output, without asking.
//   The file goes to ~/Pictures/Screenshots.
//
// The session's environment picks it: XDG_CURRENT_DESKTOP=Plutonium and
// plutonium-portals.conf (helper/portal/).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { type DesktopApps } from "./apps.ts";
import { DBusConnection, DBusError, type Message, type Reply, type Variant } from "./dbus.ts";
import { type Desktop, type DesktopCapture } from "./desktop.ts";
import { saveScreenshot } from "./screenshots.ts";

export const PORTAL_NAME = "org.freedesktop.impl.portal.desktop.plutonium";
const PORTAL_PATH = "/org/freedesktop/portal/desktop";
const SCREENCAST = "org.freedesktop.impl.portal.ScreenCast";
const SCREENSHOT = "org.freedesktop.impl.portal.Screenshot";
const REQUEST = "org.freedesktop.impl.portal.Request";
const SESSION = "org.freedesktop.impl.portal.Session";
const PROPERTIES = "org.freedesktop.DBus.Properties";
const INTROSPECTABLE = "org.freedesktop.DBus.Introspectable";

/** The portal's response codes. */
const SUCCESS = 0;
const CANCELLED = 1;
const OTHER = 2;

/** Source types (bits) and cursor modes (bits), as the portal numbers them. */
const MONITOR = 1;
const WINDOW = 2;
const CURSOR_HIDDEN = 1;
const CURSOR_EMBEDDED = 2;
const CURSOR_METADATA = 4;
const CURSOR_NAMES: Record<number, string> = {
  [CURSOR_HIDDEN]: "hidden",
  [CURSOR_EMBEDDED]: "embedded",
  [CURSOR_METADATA]: "metadata",
};

/** What restore data names: stable things, not ids. */
export type RestoreTarget =
  | { readonly type: "output"; readonly name?: string }
  | { readonly type: "window"; readonly appId: string; readonly title: string }
  | { readonly type: "tab"; readonly url: string };

type Source = { readonly type: "output" | "window" | "tab"; readonly id: number | string };

interface Session {
  readonly handle: string;
  readonly appId: string;
  /** SelectSources' options. */
  types: number;
  multiple: boolean;
  cursorMode: number;
  persistMode: number;
  restore: RestoreTarget[] | null;
  /** Start's captures, by capture id. */
  readonly captures: Set<number>;
  closed: boolean;
}

/** The options of a call, a{sv}: their values, by name (variants arrive unwrapped). */
function optionsOf(value: unknown): Map<string, unknown> {
  return value instanceof Map ? (value as Map<string, unknown>) : new Map();
}

/** Restore data, (suv), back to what it names, if it's ours (its variant arrives unwrapped). */
export function parseRestoreData(value: unknown): RestoreTarget[] | null {
  if (!Array.isArray(value) || value[0] !== "plutonium" || value[1] !== 1) return null;
  if (typeof value[2] !== "string") return null;
  try {
    const targets = JSON.parse(value[2]) as RestoreTarget[];
    return Array.isArray(targets) && targets.length ? targets : null;
  } catch {
    return null;
  }
}

export function restoreData(targets: readonly RestoreTarget[]): [string, number, Variant] {
  return ["plutonium", 1, ["s", JSON.stringify(targets)]];
}

/** The window whose app id is `target.appId`: the one with its title, else its first. */
export function findRestoredWindow(
  windows: readonly { id: number; appId: string; title: string }[],
  target: { appId: string; title: string },
): number | undefined {
  const same = windows.filter((window) => window.appId === target.appId);
  return (same.find((window) => window.title === target.title) ?? same[0])?.id;
}

/** The sender's unique name from a request handle (/…/request/1_42/token → ":1.42"). */
export function senderOfHandle(handle: string): string | undefined {
  const match = /\/request\/([^/]+)\/[^/]+$/.exec(handle) ?? /\/session\/([^/]+)\/[^/]+$/.exec(handle);
  return match ? `:${match[1]!.replaceAll("_", ".")}` : undefined;
}

export interface PortalOptions {
  readonly desktop: Desktop;
  readonly apps: DesktopApps;
  /** The thread a pid's process belongs to, if any. */
  readonly threadForPid: (pid: number) => string | undefined;
  /** The bus to serve on; default $PLUTONIUM_PORTAL_BUS, else the session bus. */
  readonly address?: string;
}

export class Portal {
  private readonly options: PortalOptions;
  private bus: DBusConnection | null = null;
  private readonly sessions = new Map<string, Session>();
  /** Requests waiting on the user, by handle: how to cancel each. */
  private readonly requests = new Map<string, () => void>();

  constructor(options: PortalOptions) {
    this.options = options;
    options.desktop.captureListeners.add((type, capture) => {
      if (type === "stop") this.onCaptureStopped(capture);
    });
  }

  /** Connects and takes the portal's name. Resolves once served, or rejects. */
  async start(): Promise<void> {
    const address = this.options.address ?? process.env.PLUTONIUM_PORTAL_BUS ?? process.env.DBUS_SESSION_BUS_ADDRESS;
    if (!address) throw new Error("no session bus (DBUS_SESSION_BUS_ADDRESS)");
    const bus = await DBusConnection.connect(address);
    bus.onCall = (message) => this.call(message);
    // 1: replace it if allowed; queued otherwise (another session's helper serves now).
    const [result] = (await bus.call({
      destination: "org.freedesktop.DBus",
      path: "/org/freedesktop/DBus",
      interface: "org.freedesktop.DBus",
      member: "RequestName",
      signature: "su",
      body: [PORTAL_NAME, 1],
    })) as [number];
    this.bus = bus;
    console.log(`plutoniumd: portal backend ${result === 1 ? "serving" : "queued"} as ${PORTAL_NAME}`);
  }

  stop(): void {
    this.bus?.close();
    this.bus = null;
  }

  private async call(message: Message): Promise<Reply> {
    const iface = message.interface;
    const member = message.member;
    const body = message.body ?? [];
    if (iface === INTROSPECTABLE && member === "Introspect") {
      return { signature: "s", body: [INTROSPECTION] };
    }
    if (iface === PROPERTIES && (member === "Get" || member === "GetAll")) {
      const properties = this.properties(String(body[0]));
      if (member === "GetAll") return { signature: "a{sv}", body: [new Map(Object.entries(properties))] };
      const value = properties[String(body[1])];
      if (!value) throw new DBusError("org.freedesktop.DBus.Error.UnknownProperty", `No property ${body[1]}`);
      return { signature: "v", body: [value] };
    }
    if (iface === REQUEST && member === "Close") {
      this.requests.get(message.path ?? "")?.();
      return {};
    }
    if (iface === SESSION && member === "Close") {
      await this.closeSession(message.path ?? "", { signal: false });
      return {};
    }
    if (iface === SCREENCAST) {
      switch (member) {
        case "CreateSession":
          return this.createSession(String(body[1]), String(body[2]));
        case "SelectSources":
          return this.selectSources(String(body[1]), optionsOf(body[3]));
        case "Start":
          return this.startSession(String(body[0]), String(body[1]), String(body[2]));
      }
    }
    if (iface === SCREENSHOT) {
      switch (member) {
        case "Screenshot":
          return this.screenshot(String(body[0]), String(body[1]), optionsOf(body[3]));
        case "PickColor":
          return this.pickColor();
      }
    }
    throw new DBusError("org.freedesktop.DBus.Error.UnknownMethod", `No such method ${iface}.${member}`);
  }

  private properties(iface: string): Record<string, Variant> {
    if (iface === SCREENCAST) {
      return {
        AvailableSourceTypes: ["u", MONITOR | WINDOW],
        AvailableCursorModes: ["u", CURSOR_HIDDEN | CURSOR_EMBEDDED | CURSOR_METADATA],
        version: ["u", 5],
      };
    }
    if (iface === SCREENSHOT) return { version: ["u", 2] };
    return {};
  }

  private response(code: number, results: [string, Variant][] = []): Reply {
    return { signature: "ua{sv}", body: [code, new Map(results)] };
  }

  private createSession(sessionHandle: string, appId: string): Reply {
    this.sessions.set(sessionHandle, {
      handle: sessionHandle,
      appId,
      types: MONITOR,
      multiple: false,
      cursorMode: CURSOR_HIDDEN,
      persistMode: 0,
      restore: null,
      captures: new Set(),
      closed: false,
    });
    return this.response(SUCCESS, [["session_id", ["s", sessionHandle]]]);
  }

  private selectSources(sessionHandle: string, options: Map<string, unknown>): Reply {
    const session = this.sessions.get(sessionHandle);
    if (!session) return this.response(OTHER);
    if (typeof options.get("types") === "number") session.types = (options.get("types") as number) || MONITOR;
    if (typeof options.get("multiple") === "boolean") session.multiple = options.get("multiple") as boolean;
    if (typeof options.get("cursor_mode") === "number") session.cursorMode = options.get("cursor_mode") as number;
    if (typeof options.get("persist_mode") === "number") session.persistMode = options.get("persist_mode") as number;
    session.restore = parseRestoreData(options.get("restore_data"));
    return this.response(SUCCESS);
  }

  /** Who asks: the app behind request `handle`. */
  private async consumer(handle: string, appId: string): Promise<Record<string, unknown>> {
    const consumer: Record<string, unknown> = { kind: "app", appId };
    const sender = senderOfHandle(handle);
    let pid = 0;
    if (sender && this.bus) {
      try {
        [pid] = (await this.bus.call({
          destination: "org.freedesktop.DBus",
          path: "/org/freedesktop/DBus",
          interface: "org.freedesktop.DBus",
          member: "GetConnectionUnixProcessID",
          signature: "s",
          body: [sender],
        })) as [number];
      } catch {
        // Gone already, or another bus.
      }
    }
    if (pid > 0) {
      consumer.pid = pid;
      const thread = this.options.threadForPid(pid);
      if (thread) consumer.thread = thread;
    }
    consumer.name = this.appName(appId, pid);
    return consumer;
  }

  /** The app's name: its desktop entry's, else its process's. */
  private appName(appId: string, pid: number): string {
    if (appId) {
      const app = this.options.apps.list().find((entry) => entry.id === `${appId}.desktop` || entry.id === appId);
      if (app) return app.name;
    }
    if (pid > 0) {
      try {
        const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
        if (comm) return comm;
      } catch {
        // It ended.
      }
    }
    return appId || "An app";
  }

  /** Asks the focused shell (else Ash's picker); null if the user refused or the app gave up. */
  private async ask(handle: string, detail: Record<string, unknown>): Promise<{ sources: Source[]; persist?: boolean } | null> {
    let cancelled = false;
    this.requests.set(handle, () => {
      cancelled = true;
      void this.options.desktop.captureCommand("cancelRequest", { handle }).catch(() => {});
    });
    try {
      const answer = (await this.options.desktop.captureCommand("request", { ...detail, handle })) as {
        sources?: Source[];
        persist?: boolean;
      } | null;
      if (cancelled || !answer?.sources?.length) return null;
      return { sources: answer.sources, persist: answer.persist };
    } finally {
      this.requests.delete(handle);
    }
  }

  /** What restore data says, as sources there are now; null if any is gone. */
  private async restored(targets: readonly RestoreTarget[]): Promise<Source[] | null> {
    const sources = await this.options.desktop.captureSources();
    const result: Source[] = [];
    for (const target of targets) {
      if (target.type === "output") {
        const output = sources.outputs.find((entry) => entry.name === target.name) ??
          sources.outputs.find((entry) => entry.primary) ?? sources.outputs[0];
        if (!output) return null;
        result.push({ type: "output", id: output.id });
      } else if (target.type === "window") {
        const id = findRestoredWindow(sources.windows, target);
        if (id === undefined) return null;
        result.push({ type: "window", id });
      } else {
        const tab = sources.tabs.find((entry) => entry.url === target.url);
        if (!tab) return null;
        result.push({ type: "tab", id: tab.id });
      }
    }
    return result;
  }

  /** What stays the same about `source` for restore data. */
  private async restoreTarget(source: Source): Promise<RestoreTarget | null> {
    const sources = await this.options.desktop.captureSources();
    if (source.type === "output") {
      return { type: "output", name: sources.outputs.find((entry) => entry.id === source.id)?.name };
    }
    if (source.type === "window") {
      const window = sources.windows.find((entry) => entry.id === source.id);
      return window ? { type: "window", appId: window.appId, title: window.title } : null;
    }
    const tab = sources.tabs.find((entry) => entry.id === source.id);
    return tab ? { type: "tab", url: tab.url } : null;
  }

  private async startSession(handle: string, sessionHandle: string, appId: string): Promise<Reply> {
    const session = this.sessions.get(sessionHandle);
    if (!session || session.closed) return this.response(OTHER);
    // For the captures' events (a shell stopping one ends the session).
    if (!(await this.options.desktop.available())) return this.response(OTHER);
    const consumer = await this.consumer(handle, appId || session.appId);
    const cursor = CURSOR_NAMES[session.cursorMode] ?? "hidden";
    let sources = session.restore ? await this.restored(session.restore).catch(() => null) : null;
    let persist = session.persistMode > 0;
    if (!sources) {
      const types: string[] = [];
      if (session.types & MONITOR) types.push("output");
      if (session.types & WINDOW) types.push("window", "tab");
      const cursorModes = Object.entries(CURSOR_NAMES).map(([, name]) => name);
      let answer;
      try {
        answer = await this.ask(handle, { kind: "screencast", consumer, types, multiple: session.multiple, cursorModes });
      } catch (error) {
        console.warn(`plutoniumd: portal: screencast request: ${(error as Error).message}`);
        return this.response(OTHER);
      }
      if (!answer) return this.response(CANCELLED);
      sources = answer.sources;
      if (answer.persist === false) persist = false;
    }
    if (session.closed) return this.response(CANCELLED);
    const streams: [number, Map<string, Variant>][] = [];
    const targets: RestoreTarget[] = [];
    try {
      for (const source of sources) {
        const started = (await this.options.desktop.captureCommand("start", { source, cursor, consumer })) as {
          captureId: number;
          nodeId: number;
          width: number;
          height: number;
        };
        session.captures.add(started.captureId);
        streams.push([
          started.nodeId,
          new Map<string, Variant>([
            ["position", ["(ii)", [0, 0]]],
            ["size", ["(ii)", [started.width, started.height]]],
            ["source_type", ["u", source.type === "output" ? MONITOR : WINDOW]],
            ["id", ["s", `${source.type}:${source.id}`]],
          ]),
        ]);
        const target = await this.restoreTarget(source).catch(() => null);
        if (target) targets.push(target);
      }
    } catch (error) {
      console.warn(`plutoniumd: portal: starting the capture: ${(error as Error).message}`);
      await this.closeSession(sessionHandle, { signal: false });
      return this.response(OTHER);
    }
    console.log(`plutoniumd: portal: ${consumer.name} captures ${sources.map((s) => `${s.type} ${s.id}`).join(", ")}`);
    const results: [string, Variant][] = [["streams", ["a(ua{sv})", streams]]];
    if (persist && targets.length === sources.length) {
      results.push(["persist_mode", ["u", session.persistMode]]);
      results.push(["restore_data", ["(suv)", restoreData(targets)]]);
    }
    return this.response(SUCCESS, results);
  }

  private async closeSession(sessionHandle: string, { signal }: { signal: boolean }): Promise<void> {
    const session = this.sessions.get(sessionHandle);
    if (!session || session.closed) return;
    session.closed = true;
    this.sessions.delete(sessionHandle);
    for (const id of session.captures) {
      await this.options.desktop.captureCommand("stop", { id }).catch(() => {});
    }
    if (signal) this.bus?.emit(sessionHandle, SESSION, "Closed");
  }

  /** A capture stopped (a shell's Stop, its window closed): its session ends. */
  private onCaptureStopped(capture: DesktopCapture): void {
    for (const session of this.sessions.values()) {
      if (!session.captures.delete(capture.id)) continue;
      if (session.captures.size === 0) void this.closeSession(session.handle, { signal: true });
    }
  }

  private async screenshot(handle: string, appId: string, options: Map<string, unknown>): Promise<Reply> {
    const desktop = this.options.desktop;
    let source: Source & { region?: unknown };
    try {
      if (options.get("interactive") === true) {
        const consumer = await this.consumer(handle, appId);
        const answer = await this.ask(handle, { kind: "screenshot", consumer, types: ["output", "window", "tab"], multiple: false });
        if (!answer) return this.response(CANCELLED);
        source = answer.sources[0]!;
      } else {
        const { outputs } = await desktop.captureSources();
        const output = outputs.find((entry) => entry.primary) ?? outputs[0];
        if (!output) return this.response(OTHER);
        source = { type: "output", id: output.id };
      }
      const shot = await desktop.screenshot(source);
      const { path } = saveScreenshot(shot.data);
      console.log(`plutoniumd: portal: screenshot of ${source.type} ${source.id} for ${appId || "an app"}: ${path}`);
      return this.response(SUCCESS, [["uri", ["s", pathToFileURL(path).href]]]);
    } catch (error) {
      console.warn(`plutoniumd: portal: screenshot: ${(error as Error).message}`);
      return this.response(OTHER);
    }
  }

  private pickColor(): Reply {
    // Not yet: there's no color picker to show.
    return this.response(OTHER);
  }
}

const INTROSPECTION = `<!DOCTYPE node PUBLIC "-//freedesktop//DTD D-BUS Object Introspection 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/introspect.dtd">
<node>
  <interface name="${SCREENCAST}">
    <method name="CreateSession"><arg type="o" direction="in"/><arg type="o" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="u" direction="out"/><arg type="a{sv}" direction="out"/></method>
    <method name="SelectSources"><arg type="o" direction="in"/><arg type="o" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="u" direction="out"/><arg type="a{sv}" direction="out"/></method>
    <method name="Start"><arg type="o" direction="in"/><arg type="o" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="u" direction="out"/><arg type="a{sv}" direction="out"/></method>
    <property name="AvailableSourceTypes" type="u" access="read"/>
    <property name="AvailableCursorModes" type="u" access="read"/>
    <property name="version" type="u" access="read"/>
  </interface>
  <interface name="${SCREENSHOT}">
    <method name="Screenshot"><arg type="o" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="u" direction="out"/><arg type="a{sv}" direction="out"/></method>
    <method name="PickColor"><arg type="o" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="u" direction="out"/><arg type="a{sv}" direction="out"/></method>
    <property name="version" type="u" access="read"/>
  </interface>
</node>`;

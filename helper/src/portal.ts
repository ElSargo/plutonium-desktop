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
// - GlobalShortcuts: the focused shell shows the binding UI ("bind_shortcuts"
//   over the shell relay; without a shell, the app's preferred keys are
//   taken). Every shell catches the bound keys (setShellShortcuts) and posts
//   them back; they go to the app as Activated and Deactivated
//   (shortcuts.ts).
// - FileChooser: OpenFile, SaveFile and SaveFiles ask the focused shell
//   ("file_chooser" over the shell relay), whose picker is the one tabs use,
//   over the app's window (fileChooser.ts).
// - Print: the shell's print dialog, then CUPS; served under a name of its
//   own by printportal.py, which can take the document's fd (printPortal.ts).
//
// The session's environment picks it: XDG_CURRENT_DESKTOP=Plutonium and
// plutonium-portals.conf (helper/portal/).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { type DesktopApps } from "./apps.ts";
import { DBusConnection, DBusError, type Message, type Reply, type Variant } from "./dbus.ts";
import { type Desktop, type DesktopCapture } from "./desktop.ts";
import { type FileChooserMethod, fileChooserDetail, fileChooserResults, type PickerAnswer } from "./fileChooser.ts";
import { PrintBackend } from "./printPortal.ts";
import { saveScreenshot } from "./screenshots.ts";
import {
  type Bindings,
  bindingsPath,
  comboOfTrigger,
  describeCombo,
  loadBindings,
  saveBindings,
  triggerOfCombo,
} from "./shortcuts.ts";

export const PORTAL_NAME = "org.freedesktop.impl.portal.desktop.plutonium";
const PORTAL_PATH = "/org/freedesktop/portal/desktop";
const SCREENCAST = "org.freedesktop.impl.portal.ScreenCast";
const SCREENSHOT = "org.freedesktop.impl.portal.Screenshot";
const GLOBAL_SHORTCUTS = "org.freedesktop.impl.portal.GlobalShortcuts";
const FILE_CHOOSER = "org.freedesktop.impl.portal.FileChooser";
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
  /** Asks the focused shell (the shell relay); rejects if none answers. */
  readonly askShell?: (op: string, args: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
  /** Tells every shell. */
  readonly notifyShells?: (op: string, args: Record<string, unknown>) => void;
  /** Where global shortcuts are kept (default shortcuts.ts' bindingsPath()). */
  readonly bindingsPath?: string;
  /** Whether to serve the Print portal too (printportal.py; default true). */
  readonly print?: boolean;
  /** The native windows (the shell relay's), to find a request's parent. */
  readonly windows?: () => Promise<readonly { id: number; appId: string; pid: number; focused: boolean }[]>;
}

/** A global shortcut an app bound: its combo, if it has one. */
interface BoundShortcut {
  readonly description: string;
  combo: string | undefined;
}

interface ShortcutSession {
  readonly handle: string;
  /** Whose bindings: the app id, else its process's name. */
  readonly app: string;
  readonly name: string;
  readonly shortcuts: Map<string, BoundShortcut>;
}

export class Portal {
  private readonly options: PortalOptions;
  private bus: DBusConnection | null = null;
  private readonly sessions = new Map<string, Session>();
  /** Requests waiting on the user, by handle: how to cancel each. */
  private readonly requests = new Map<string, () => void>();
  private readonly shortcutSessions = new Map<string, ShortcutSession>();
  private printBackend: PrintBackend | null = null;

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
    const askShell = this.options.askShell;
    if (askShell && this.options.print !== false) {
      this.printBackend = new PrintBackend({
        address,
        askShell,
        notifyShells: this.options.notifyShells,
        source: (handle, appId) => this.source(handle, appId),
      });
      this.printBackend.start();
    }
  }

  stop(): void {
    this.printBackend?.stop();
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
      if (this.shortcutSessions.delete(message.path ?? "")) this.announceShortcuts();
      await this.closeSession(message.path ?? "", { signal: false });
      return {};
    }
    if (iface === GLOBAL_SHORTCUTS) {
      switch (member) {
        case "CreateSession":
          return this.createShortcutSession(String(body[0]), String(body[1]), String(body[2]));
        case "BindShortcuts":
          return this.bindShortcuts(String(body[1]), body[2] as [string, Map<string, unknown>][]);
        case "ListShortcuts":
          return this.listShortcuts(String(body[1]));
      }
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
    if (iface === FILE_CHOOSER && (member === "OpenFile" || member === "SaveFile" || member === "SaveFiles")) {
      return this.chooseFiles(member, String(body[0]), String(body[1]), String(body[2]), String(body[3]), optionsOf(body[4]));
    }
    if (iface === SCREENSHOT) {
      switch (member) {
        case "Screenshot":
          return this.screenshot(String(body[0]), String(body[1]), optionsOf(body[3]));
        case "PickColor":
          return this.pickColor(String(body[1]));
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
    if (iface === GLOBAL_SHORTCUTS) return { version: ["u", 1] };
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
        // Nix wraps programs: ".zenity-wrapped" is zenity (cut to 15 characters).
        if (comm) return comm.replace(/^\.(.+)-wrap(?:p|pe|ped)?$/, "$1");
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

  private async createShortcutSession(handle: string, sessionHandle: string, appId: string): Promise<Reply> {
    const consumer = await this.consumer(handle, appId);
    this.shortcutSessions.set(sessionHandle, {
      handle: sessionHandle,
      app: appId || String(consumer.name),
      name: String(consumer.name),
      shortcuts: new Map(),
    });
    return this.response(SUCCESS, [["session_handle", ["s", sessionHandle]]]);
  }

  /** The shortcuts as the portal lists them: a(sa{sv}). */
  private shortcutResults(session: ShortcutSession): [string, Variant][] {
    const list = [...session.shortcuts].map(([id, shortcut]): [string, Map<string, Variant>] => [
      id,
      new Map<string, Variant>([
        ["description", ["s", shortcut.description]],
        ["trigger_description", ["s", shortcut.combo ? describeCombo(shortcut.combo) : ""]],
      ]),
    ]);
    return [["shortcuts", ["a(sa{sv})", list]]];
  }

  private async bindShortcuts(sessionHandle: string, requested: [string, Map<string, unknown>][]): Promise<Reply> {
    const session = this.shortcutSessions.get(sessionHandle);
    if (!session) return this.response(OTHER);
    const path = this.options.bindingsPath ?? bindingsPath();
    const bindings: Bindings = loadBindings(path);
    const kept = bindings[session.app] ?? {};
    const proposed = requested.map(([id, options]): { id: string; description: string; combo: string | undefined } => {
      const preferred = typeof options.get("preferred_trigger") === "string"
        ? comboOfTrigger(options.get("preferred_trigger") as string)
        : undefined;
      return { id, description: String(options.get("description") ?? id), combo: id in kept ? kept[id] : preferred };
    });
    let chosen = proposed;
    // Asked unless every one was bound before.
    if (proposed.some(({ id }) => !(id in kept)) && this.options.askShell) {
      try {
        const answer = (await this.options.askShell(
          "bind_shortcuts",
          { appName: session.name, shortcuts: proposed },
          120_000,
        )) as { shortcuts?: { id: string; combo?: string }[] } | null;
        if (!answer) return this.response(CANCELLED);
        const combos = new Map((answer.shortcuts ?? []).map(({ id, combo }) => [id, combo]));
        chosen = proposed.map((shortcut) => ({ ...shortcut, combo: combos.get(shortcut.id) }));
      } catch (error) {
        // No shell to ask: the app's own choice.
        console.warn(`plutoniumd: portal: no shell for the shortcuts (${(error as Error).message}); taking the app's keys`);
      }
    }
    session.shortcuts.clear();
    for (const { id, description, combo } of chosen) {
      session.shortcuts.set(id, { description, combo: combo && triggerOfCombo(combo) ? combo : undefined });
    }
    bindings[session.app] = Object.fromEntries(
      [...session.shortcuts].filter(([, s]) => s.combo).map(([id, s]) => [id, s.combo!]),
    );
    saveBindings(bindings, path);
    console.log(
      `plutoniumd: portal: ${session.name} bound ` +
        [...session.shortcuts].map(([id, s]) => `${id}=${s.combo ?? "none"}`).join(", "),
    );
    this.announceShortcuts();
    return this.response(SUCCESS, this.shortcutResults(session));
  }

  private listShortcuts(sessionHandle: string): Reply {
    const session = this.shortcutSessions.get(sessionHandle);
    if (!session) return this.response(OTHER);
    return this.response(SUCCESS, this.shortcutResults(session));
  }

  /** The keys the shells catch: every session's bound shortcuts. */
  globalShortcuts(): { session: string; id: string; combo: string }[] {
    const all: { session: string; id: string; combo: string }[] = [];
    for (const session of this.shortcutSessions.values()) {
      for (const [id, shortcut] of session.shortcuts) {
        if (shortcut.combo) all.push({ session: session.handle, id, combo: shortcut.combo });
      }
    }
    return all;
  }

  private announceShortcuts(): void {
    this.options.notifyShells?.("global_shortcuts", { shortcuts: this.globalShortcuts() });
  }

  /** A shell caught a bound key: the app hears of it. */
  shortcut(sessionHandle: string, id: string, phase: "activated" | "deactivated"): boolean {
    if (!this.shortcutSessions.get(sessionHandle)?.shortcuts.has(id)) return false;
    this.bus?.emit(PORTAL_PATH, GLOBAL_SHORTCUTS, phase === "activated" ? "Activated" : "Deactivated", "osta{sv}", [
      sessionHandle,
      id,
      Date.now(),
      new Map(),
    ]);
    return true;
  }

  /** The window a request's dialog belongs over: the app's focused one, else its newest. */
  private async parentWindow(pid: number, appId: string): Promise<number | undefined> {
    if (!this.options.windows) return undefined;
    const windows = await this.options.windows().catch(() => []);
    // Wayland and X11 handles (xdg-foreign, an XID) aren't Exo's ids: the app's own windows stand in.
    let own = pid > 0 ? windows.filter((window) => window.pid === pid) : [];
    if (own.length === 0 && appId) own = windows.filter((window) => window.appId === appId);
    return (own.find((window) => window.focused) ?? own.at(-1))?.id;
  }

  /** A dialog's source ({appId, pid, windowId, name}: who asks, over which window) and thread. */
  private async source(handle: string, appId: string): Promise<{ source: Record<string, unknown>; thread: string | null }> {
    const consumer = await this.consumer(handle, appId);
    const pid = (consumer.pid as number | undefined) ?? 0;
    const windowId = await this.parentWindow(pid, appId);
    return { source: { appId, pid, windowId, name: consumer.name }, thread: (consumer.thread as string | undefined) ?? null };
  }

  /** OpenFile, SaveFile, SaveFiles: the shell's file picker; without a shell, there's none to show. */
  private async chooseFiles(
    method: FileChooserMethod,
    handle: string,
    appId: string,
    parent: string,
    title: string,
    options: Map<string, unknown>,
  ): Promise<Reply> {
    if (!this.options.askShell) return this.response(OTHER);
    const { source, thread } = await this.source(handle, appId);
    const detail = fileChooserDetail(method, title, options);
    let cancelled = false;
    this.requests.set(handle, () => {
      cancelled = true;
      this.options.notifyShells?.("file_chooser_cancel", { handle });
    });
    try {
      const answer = (await this.options.askShell(
        "file_chooser",
        {
          handle,
          detail,
          source: { ...source, parent },
          thread,
        },
        3_600_000,
      )) as PickerAnswer | null;
      const results = cancelled ? null : fileChooserResults(method, options, detail, answer);
      if (!results) return this.response(CANCELLED);
      console.log(`plutoniumd: portal: ${source.name} ${method}: ${(results[0]![1][1] as string[]).join(" ")}`);
      return this.response(SUCCESS, results);
    } catch (error) {
      console.warn(`plutoniumd: portal: file chooser: ${(error as Error).message}`);
      this.options.notifyShells?.("file_chooser_cancel", { handle });
      return this.response(OTHER);
    } finally {
      this.requests.delete(handle);
    }
  }

  /** The focused shell's color picker; without a shell, there's none to show. */
  private async pickColor(appId: string): Promise<Reply> {
    if (!this.options.askShell) return this.response(OTHER);
    try {
      const answer = (await this.options.askShell("pick_color", { appName: this.appName(appId, 0) }, 120_000)) as {
        color?: number[] | null;
      } | null;
      const color = answer?.color;
      if (!Array.isArray(color) || color.length !== 3) return this.response(CANCELLED);
      return this.response(SUCCESS, [["color", ["(ddd)", color.map((value) => Math.min(1, Math.max(0, value / 255)))]]]);
    } catch (error) {
      console.warn(`plutoniumd: portal: pick color: ${(error as Error).message}`);
      return this.response(OTHER);
    }
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
  <interface name="${FILE_CHOOSER}">
    <method name="OpenFile"><arg type="o" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="u" direction="out"/><arg type="a{sv}" direction="out"/></method>
    <method name="SaveFile"><arg type="o" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="u" direction="out"/><arg type="a{sv}" direction="out"/></method>
    <method name="SaveFiles"><arg type="o" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="u" direction="out"/><arg type="a{sv}" direction="out"/></method>
  </interface>
  <interface name="${GLOBAL_SHORTCUTS}">
    <method name="CreateSession"><arg type="o" direction="in"/><arg type="o" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="u" direction="out"/><arg type="a{sv}" direction="out"/></method>
    <method name="BindShortcuts"><arg type="o" direction="in"/><arg type="o" direction="in"/><arg type="a(sa{sv})" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="u" direction="out"/><arg type="a{sv}" direction="out"/></method>
    <method name="ListShortcuts"><arg type="o" direction="in"/><arg type="o" direction="in"/><arg type="u" direction="out"/><arg type="a{sv}" direction="out"/></method>
    <signal name="Activated"><arg type="o"/><arg type="s"/><arg type="t"/><arg type="a{sv}"/></signal>
    <signal name="Deactivated"><arg type="o"/><arg type="s"/><arg type="t"/><arg type="a{sv}"/></signal>
    <signal name="ShortcutsChanged"><arg type="o"/><arg type="a(sa{sv})"/></signal>
    <property name="version" type="u" access="read"/>
  </interface>
</node>`;

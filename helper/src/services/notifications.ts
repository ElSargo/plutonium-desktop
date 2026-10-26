// The notifications service (DESKTOP_SERVICES.md, "notifications"): the
// helper is the session's notification server (org.freedesktop.Notifications,
// what notify-send, GTK, Qt and Electron apps send to), and the shell draws
// them: popups, a list, do not disturb. The tabs' web notifications join them
// (the browser's Plutonium domain): their app is the site.
import type { WebNotification } from "../desktop.ts";
import { DBusConnection, DBusError, type Message, type Reply } from "../dbus.ts";
import { type DesktopService, ServiceError } from "../services.ts";

const NAME = "org.freedesktop.Notifications";
const PATH = "/org/freedesktop/Notifications";
const INTROSPECTABLE = "org.freedesktop.DBus.Introspectable";
/** Kept at most: the oldest go first. */
const LIMIT = 100;

const INTROSPECTION = `<node>
 <interface name="${NAME}">
  <method name="GetCapabilities"><arg type="as" direction="out"/></method>
  <method name="Notify">
   <arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="s" direction="in"/>
   <arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="as" direction="in"/>
   <arg type="a{sv}" direction="in"/><arg type="i" direction="in"/><arg type="u" direction="out"/>
  </method>
  <method name="CloseNotification"><arg type="u" direction="in"/></method>
  <method name="GetServerInformation">
   <arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/>
  </method>
  <signal name="NotificationClosed"><arg type="u"/><arg type="u"/></signal>
  <signal name="ActionInvoked"><arg type="u"/><arg type="s"/></signal>
 </interface>
</node>`;

/** Why a notification closed (the spec's numbers). */
export const CLOSED = { expired: 1, dismissed: 2, byApp: 3 } as const;

export interface Notification {
  readonly id: number;
  readonly app: string;
  readonly icon: string;
  readonly summary: string;
  readonly body: string;
  readonly actions: readonly { key: string; label: string }[];
  /** "low", "normal" or "critical". */
  readonly urgency: string;
  /** The app's .desktop name, when it said. */
  readonly desktopEntry?: string;
  /** Whether the shell should keep it out of its list once its popup is gone. */
  readonly transient: boolean;
  readonly time: number;
  /** A tab's web notification: the site's origin (its app is the site's host). */
  readonly site?: string;
}

/** The browser's side (desktop.ts): the tabs' web notifications, and acting on them. */
export interface BrowserNotifications {
  /** Calls `listener` as they come, change (`shown`) and go (`closed`, the browser's id). */
  onChange(listener: (event: { shown: WebNotification } | { closed: string }) => void): void;
  /** Clicks one (or its button), or closes it as the user would: the page's own handlers run. */
  action(id: string, action: "click" | "close", button?: number): Promise<void>;
  /** Shows the site's tab (a click on its notification). */
  showSite(origin: string): Promise<void>;
}

/** The notification a web notification is, with `id` as ours. */
export function fromWeb(id: number, web: WebNotification, now = Date.now()): Notification {
  let app = web.origin;
  try {
    app = new URL(web.origin).host || web.origin;
  } catch {}
  return {
    id,
    app,
    icon: web.icon,
    summary: web.title,
    body: web.body,
    // "default" is the notification itself, as on the bus; the buttons by index.
    actions: [{ key: "default", label: "Open" }, ...web.buttons.map((label, index) => ({ key: `button-${index}`, label }))],
    urgency: web.requireInteraction ? "critical" : "normal",
    transient: false,
    time: now,
    site: web.origin,
  };
}

export interface NotificationsState {
  /** Newest first. */
  readonly notifications: readonly Notification[];
  /** Whether popups are held back (critical ones still show). */
  readonly doNotDisturb: boolean;
}

const URGENCY = ["low", "normal", "critical"];

/** The notification `Notify`'s arguments describe. */
export function parseNotify(id: number, body: readonly unknown[], now = Date.now()): Notification {
  const [app, , icon, summary, text, actions, hints] = body as [string, number, string, string, string, string[], Map<string, unknown>];
  const hint = (key: string) => (hints instanceof Map ? hints.get(key) : undefined);
  const pairs: { key: string; label: string }[] = [];
  for (let i = 0; i + 1 < (actions?.length ?? 0); i += 2) pairs.push({ key: actions[i]!, label: actions[i + 1]! });
  const entry = hint("desktop-entry");
  const image = hint("image-path") ?? hint("image_path");
  return {
    id,
    app: String(app ?? ""),
    icon: String(icon || (typeof image === "string" ? image : "")),
    summary: String(summary ?? ""),
    body: String(text ?? ""),
    actions: pairs,
    urgency: URGENCY[Number(hint("urgency") ?? 1)] ?? "normal",
    ...(typeof entry === "string" && entry ? { desktopEntry: entry } : {}),
    transient: Boolean(hint("transient")),
    time: now,
  };
}

export class NotificationsService implements DesktopService {
  readonly name = "notifications";
  private readonly address: string | undefined;
  private bus: DBusConnection | null = null;
  private list: Notification[] = [];
  private readonly timers = new Map<number, NodeJS.Timeout>();
  private nextId = 1;
  private doNotDisturb = false;
  private changed: (state: unknown) => void = () => {};
  private readonly browser: BrowserNotifications | undefined;
  /** Web notifications: the browser's id → ours, and back. */
  private readonly webIds = new Map<string, number>();
  private readonly webOf = new Map<number, string>();

  private readonly serveBus: boolean;

  /**
   * `address`: the session bus (default $DBUS_SESSION_BUS_ADDRESS); `browser`:
   * the tabs' notifications; `serveBus`: false leaves the bus's name alone
   * (a test session's helper: only the tabs' then).
   */
  constructor(address?: string, browser?: BrowserNotifications, serveBus = true) {
    this.address = address;
    this.browser = browser;
    this.serveBus = serveBus;
  }

  async start(changed: (state: unknown) => void): Promise<void> {
    this.changed = changed;
    this.browser?.onChange((event) => ("shown" in event ? this.notifyWeb(event.shown) : this.closeWeb(event.closed)));
    if (!this.serveBus) {
      console.log(`plutoniumd: notifications from tabs only (not serving ${NAME})`);
      return;
    }
    const address = this.address ?? process.env.DBUS_SESSION_BUS_ADDRESS;
    if (!address) throw new ServiceError(503, "There's no session bus (DBUS_SESSION_BUS_ADDRESS).");
    const bus = await DBusConnection.connect(address);
    bus.onCall = (message) => this.onBus(message);
    // 1|2: another server may take the name from us, and we take it from one that
    // allows it (a test session's helper); a daemon the user runs that doesn't
    // allow it keeps it, and we wait in the queue.
    const [result] = (await bus.call({
      destination: "org.freedesktop.DBus",
      path: "/org/freedesktop/DBus",
      interface: "org.freedesktop.DBus",
      member: "RequestName",
      signature: "su",
      body: [NAME, 3],
    })) as [number];
    this.bus = bus;
    console.log(`plutoniumd: notifications ${result === 1 ? "serving" : "queued"} as ${NAME}`);
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.bus?.close();
    this.bus = null;
  }

  async state(): Promise<NotificationsState> {
    return { notifications: this.list, doNotDisturb: this.doNotDisturb };
  }

  async call(action: string, args: Record<string, unknown>): Promise<unknown> {
    const id = Number(args.id);
    switch (action) {
      case "dismiss":
        this.close(id, CLOSED.dismissed);
        return null;
      case "invoke": {
        const notification = this.list.find((n) => n.id === id);
        const key = String(args.action ?? "default");
        if (!notification) throw new ServiceError(404, `There's no notification ${args.id}.`);
        const web = this.webOf.get(id);
        if (web !== undefined) {
          // The page's onclick (or the worker's notificationclick) runs, and its tab shows.
          const button = /^button-(\d+)$/.exec(key);
          await this.browser?.action(web, "click", button ? Number(button[1]) : undefined);
          if (!button && notification.site) await this.browser?.showSite(notification.site).catch(() => {});
          this.close(id, CLOSED.dismissed);
          return null;
        }
        this.bus?.emit(PATH, NAME, "ActionInvoked", "us", [id, key]);
        // Clicked: it has done its job (apps that want it to stay send it again).
        this.close(id, CLOSED.dismissed);
        return null;
      }
      case "clear":
        for (const notification of [...this.list]) this.close(notification.id, CLOSED.dismissed, false);
        this.changed(await this.state());
        return null;
      case "set-do-not-disturb":
        this.doNotDisturb = Boolean(args.on);
        this.changed(await this.state());
        return this.doNotDisturb;
      default:
        throw new ServiceError(404, `notifications has no action "${action}".`);
    }
  }

  /** Sends a notification as an app would (the shell's own, or a test). */
  notify(body: readonly unknown[]): number {
    const replaces = Number(body[1] ?? 0);
    const id = replaces && this.list.some((n) => n.id === replaces) ? replaces : this.nextId++;
    const notification = parseNotify(id, body);
    this.list = [notification, ...this.list.filter((n) => n.id !== id)].slice(0, LIMIT);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    // -1: the server decides (it stays in the list); 0: never; else it closes then.
    const timeout = Number(body[7] ?? -1);
    if (timeout > 0) {
      const timer = setTimeout(() => this.close(id, CLOSED.expired), timeout);
      timer.unref();
      this.timers.set(id, timer);
    }
    this.changed({ notifications: this.list, doNotDisturb: this.doNotDisturb });
    return id;
  }

  /** A tab's web notification came or changed (public for tests). */
  notifyWeb(web: WebNotification): number {
    const known = this.webIds.get(web.id);
    const id = known !== undefined && this.list.some((n) => n.id === known) ? known : this.nextId++;
    this.webIds.set(web.id, id);
    this.webOf.set(id, web.id);
    this.list = [fromWeb(id, web), ...this.list.filter((n) => n.id !== id)].slice(0, LIMIT);
    this.changed({ notifications: this.list, doNotDisturb: this.doNotDisturb });
    return id;
  }

  /** The browser closed one (the page did, or it was acted on). */
  private closeWeb(webId: string): void {
    const id = this.webIds.get(webId);
    if (id === undefined) return;
    this.webIds.delete(webId);
    this.webOf.delete(id);
    this.close(id, CLOSED.byApp);
  }

  private close(id: number, reason: number, announce = true): void {
    if (!this.list.some((n) => n.id === id)) return;
    this.list = this.list.filter((n) => n.id !== id);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const web = this.webOf.get(id);
    if (web !== undefined) {
      this.webOf.delete(id);
      this.webIds.delete(web);
      // Dismissed or clicked here: closed in the browser too, as a desktop's
      // notification server does (the page's onclose runs).
      if (reason === CLOSED.dismissed) void this.browser?.action(web, "close").catch(() => {});
      if (announce) this.changed({ notifications: this.list, doNotDisturb: this.doNotDisturb });
      return;
    }
    this.bus?.emit(PATH, NAME, "NotificationClosed", "uu", [id, reason]);
    if (announce) this.changed({ notifications: this.list, doNotDisturb: this.doNotDisturb });
  }

  /** A method call on the bus (public for tests). */
  async onBus(message: Message): Promise<Reply> {
    const body = message.body ?? [];
    if (message.interface === INTROSPECTABLE && message.member === "Introspect") {
      return { signature: "s", body: [INTROSPECTION] };
    }
    if (message.interface === NAME || message.interface === undefined) {
      switch (message.member) {
        case "GetCapabilities":
          return { signature: "as", body: [["actions", "body", "icon-static", "persistence"]] };
        case "GetServerInformation":
          return { signature: "ssss", body: ["Plutonium", "Plutonium", "1", "1.2"] };
        case "Notify":
          return { signature: "u", body: [this.notify(body)] };
        case "CloseNotification":
          this.close(Number(body[0]), CLOSED.byApp);
          return {};
      }
    }
    throw new DBusError("org.freedesktop.DBus.Error.UnknownMethod", `No such method ${message.interface}.${message.member}`);
  }
}

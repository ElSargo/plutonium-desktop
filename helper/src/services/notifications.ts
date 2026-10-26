// The notifications service (DESKTOP_SERVICES.md, "notifications"): the
// helper is the session's notification server (org.freedesktop.Notifications,
// what notify-send, GTK, Qt and Electron apps send to), and the shell draws
// them: popups, a list, do not disturb.
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

  /** `address`: the session bus (default $DBUS_SESSION_BUS_ADDRESS). */
  constructor(address?: string) {
    this.address = address;
  }

  async start(changed: (state: unknown) => void): Promise<void> {
    this.changed = changed;
    const address = this.address ?? process.env.DBUS_SESSION_BUS_ADDRESS;
    if (!address) throw new ServiceError(503, "There's no session bus (DBUS_SESSION_BUS_ADDRESS).");
    const bus = await DBusConnection.connect(address);
    bus.onCall = (message) => this.onBus(message);
    // 1: another server may take the name from us. Queued while one has it
    // (another session's helper, or a notification daemon the user runs).
    const [result] = (await bus.call({
      destination: "org.freedesktop.DBus",
      path: "/org/freedesktop/DBus",
      interface: "org.freedesktop.DBus",
      member: "RequestName",
      signature: "su",
      body: [NAME, 1],
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

  private close(id: number, reason: number, announce = true): void {
    if (!this.list.some((n) => n.id === id)) return;
    this.list = this.list.filter((n) => n.id !== id);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
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

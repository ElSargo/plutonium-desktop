// The host's color scheme (LINUX_COMPAT.md, "Dark mode"): the settings
// portal's org.freedesktop.appearance color-scheme, which GNOME, KDE and the
// other desktops set. The helper reads it, watches it, and hands it to the
// browser, whose Ash dark mode then makes prefers-color-scheme in shells and
// tabs the desktop's.
import { DBusConnection, type Message } from "./dbus.ts";

const PORTAL = "org.freedesktop.portal.Desktop";
const PORTAL_PATH = "/org/freedesktop/portal/desktop";
const SETTINGS = "org.freedesktop.portal.Settings";
const NAMESPACE = "org.freedesktop.appearance";
const KEY = "color-scheme";

/** The portal's color-scheme: 1 is dark; 0 (no preference) and 2 are light. */
export function isDark(value: unknown): boolean {
  return Number(value) === 1;
}

export class Appearance {
  private bus: DBusConnection | null = null;
  /** The host's scheme, once read: null until then, or without a portal. */
  private dark: boolean | null = null;
  private readonly listeners = new Set<(dark: boolean) => void>();

  /**
   * `address`: the bus the portal is on (default $PLUTONIUM_APPEARANCE_BUS, a
   * test's fake portal, then $DBUS_SESSION_BUS_ADDRESS).
   */
  private readonly address: string | undefined;

  constructor(address?: string) {
    this.address = address;
  }

  /** Reads the setting and watches it. Without a session bus or portal, nothing changes. */
  async start(): Promise<void> {
    const address = this.address ?? process.env.PLUTONIUM_APPEARANCE_BUS ?? process.env.DBUS_SESSION_BUS_ADDRESS;
    if (!address) return;
    try {
      const bus = await DBusConnection.connect(address);
      this.bus = bus;
      bus.onSignal = (message) => this.onSignal(message);
      await bus.call({
        destination: "org.freedesktop.DBus",
        path: "/org/freedesktop/DBus",
        interface: "org.freedesktop.DBus",
        member: "AddMatch",
        signature: "s",
        body: [`type='signal',interface='${SETTINGS}',member='SettingChanged',arg0='${NAMESPACE}'`],
      });
      this.set(isDark(await this.read(bus)));
    } catch (error) {
      console.warn(`plutoniumd: no host color scheme (the settings portal): ${(error as Error).message}`);
    }
  }

  stop(): void {
    this.bus?.close();
    this.bus = null;
  }

  /** The host's scheme, if known. */
  get current(): boolean | null {
    return this.dark;
  }

  /** Calls `listener` with each change. */
  onChange(listener: (dark: boolean) => void): void {
    this.listeners.add(listener);
  }

  private async read(bus: DBusConnection): Promise<unknown> {
    const call = (member: string) =>
      bus.call({ destination: PORTAL, path: PORTAL_PATH, interface: SETTINGS, member, signature: "ss", body: [NAMESPACE, KEY] });
    // ReadOne is version 2's; Read (the value in one more variant) is older.
    const [value] = await call("ReadOne").catch(() => call("Read"));
    return value;
  }

  private onSignal(message: Message): void {
    const [namespace, key, value] = message.body ?? [];
    if (message.member === "SettingChanged" && namespace === NAMESPACE && key === KEY) this.set(isDark(value));
  }

  private set(dark: boolean): void {
    if (this.dark === dark) return;
    this.dark = dark;
    for (const listener of this.listeners) listener(dark);
  }
}

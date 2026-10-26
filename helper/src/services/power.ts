// The power service (DESKTOP_SERVICES.md, "power"): the battery and AC from
// UPower, the backlight, and suspend, restart, power off and log out. All on
// the system bus: UPower's PropertiesChanged signals for the battery, logind's
// Session.SetBrightness for the backlight (no root: logind lets the session's
// owner set it), logind's Manager for the rest. Log out ends this Plutonium
// session (`plutonium stop` for it), not the user's login, which is the
// console Plutonium was started from.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { DBusConnection, type Message } from "../dbus.ts";
import { ServiceError, type DesktopService } from "../services.ts";

const SYSTEM_BUS = "unix:path=/run/dbus/system_bus_socket";
const UPOWER = "org.freedesktop.UPower";
const DISPLAY_DEVICE = "/org/freedesktop/UPower/devices/DisplayDevice";
const LOGIN = "org.freedesktop.login1";
const LOGIN_PATH = "/org/freedesktop/login1";
const PROPERTIES = "org.freedesktop.DBus.Properties";

/** UPower's Device.State. */
const BATTERY_STATES = ["unknown", "charging", "discharging", "empty", "full", "pending-charge", "pending-discharge"];
/** UPower's Device.Type for a battery. */
const BATTERY = 2;

export interface PowerState {
  /** null on a computer without one (a desktop). */
  readonly battery: {
    readonly percent: number;
    readonly charging: boolean;
    /** "charging", "discharging", "full", … (UPower's). */
    readonly state: string;
    /** Seconds to empty (discharging) or to full (charging); null when UPower doesn't know. */
    readonly timeLeft: number | null;
  } | null;
  /** On mains power; null without UPower. */
  readonly ac: boolean | null;
  /** The backlight, 0–1; not available on a desktop monitor. */
  readonly brightness: { readonly available: boolean; readonly value: number };
  /** Which actions logind allows ("yes", "challenge": it asks for a password, "na", "no"). */
  readonly can: { readonly suspend: string; readonly reboot: string; readonly powerOff: string; readonly logOut: string };
}

export interface PowerOptions {
  /** The system bus (tests: a fake one). */
  readonly address?: string;
  /** Where backlights are (tests: a directory of fake ones). */
  readonly backlights?: string;
  /** How often the backlight is read again for changes made elsewhere (sysfs has no change events). */
  readonly backlightPollMs?: number;
  /** Ends this Plutonium session; without one, log-out isn't offered. */
  readonly logOut?: () => void;
}

interface Backlight {
  readonly name: string;
  readonly dir: string;
  readonly max: number;
}

export class PowerService implements DesktopService {
  readonly name = "power";
  private readonly options: PowerOptions;
  private bus: DBusConnection | null = null;
  private changed: (state: unknown) => void = () => {};
  private battery: PowerState["battery"] = null;
  private ac: boolean | null = null;
  private can: PowerState["can"] = { suspend: "na", reboot: "na", powerOff: "na", logOut: "na" };
  private backlight: Backlight | null = null;
  private brightness = 0;
  private session: string | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private text = "";

  constructor(options: PowerOptions = {}) {
    this.options = options;
  }

  async start(changed: (state: unknown) => void): Promise<void> {
    this.changed = changed;
    this.backlight = findBacklight(this.options.backlights ?? "/sys/class/backlight");
    this.brightness = this.readBrightness();
    this.can = { ...this.can, logOut: this.options.logOut ? "yes" : "na" };
    try {
      const bus = await DBusConnection.connect(this.options.address ?? SYSTEM_BUS);
      this.bus = bus;
      bus.onSignal = (message) => this.onSignal(message);
      for (const path of [DISPLAY_DEVICE, "/org/freedesktop/UPower"]) {
        await this.dbus("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "AddMatch", "s", [
          `type='signal',sender='${UPOWER}',path='${path}',interface='${PROPERTIES}',member='PropertiesChanged'`,
        ]).catch(() => {});
      }
      await this.readUPower();
      const can = async (member: string) =>
        String((await this.dbus(LOGIN, LOGIN_PATH, `${LOGIN}.Manager`, member).catch(() => ["na"]))[0]);
      this.can = { ...this.can, suspend: await can("CanSuspend"), reboot: await can("CanReboot"), powerOff: await can("CanPowerOff") };
      this.session = await this.findSession();
    } catch (error) {
      console.warn(`power: no system bus: ${(error as Error).message}`);
    }
    if (this.backlight) {
      this.poll = setInterval(() => {
        const value = this.readBrightness();
        if (value !== this.brightness) {
          this.brightness = value;
          this.emit();
        }
      }, this.options.backlightPollMs ?? 3_000);
      this.poll.unref();
    }
    this.emit();
  }

  async state(): Promise<PowerState> {
    return {
      battery: this.battery,
      ac: this.ac,
      brightness: { available: this.backlight !== null, value: Math.round(this.brightness * 1000) / 1000 },
      can: this.can,
    };
  }

  async call(action: string, args: Record<string, unknown>): Promise<PowerState | null> {
    switch (action) {
      case "set-brightness": {
        const value = Number(args.brightness);
        if (!Number.isFinite(value)) throw new ServiceError(400, "brightness: a number from 0 to 1.");
        await this.setBrightness(value);
        return this.state();
      }
      case "step": {
        const by = Number(args.by ?? 0.05);
        if (!Number.isFinite(by)) throw new ServiceError(400, "by: a number, + or −.");
        await this.setBrightness(this.readBrightness() + by);
        return this.state();
      }
      case "suspend":
        await this.manager("Suspend");
        return null;
      case "reboot":
        await this.manager("Reboot");
        return null;
      case "power-off":
        await this.manager("PowerOff");
        return null;
      case "log-out":
        if (!this.options.logOut) throw new ServiceError(404, "This session can't be logged out of from here.");
        this.options.logOut();
        return null;
      default:
        throw new ServiceError(404, `power has no action "${action}".`);
    }
  }

  stop(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.bus?.close();
    this.bus = null;
  }

  private dbus(destination: string, path: string, iface: string, member: string, signature = "", body: unknown[] = []) {
    if (!this.bus?.isOpen) return Promise.reject(new ServiceError(503, "No system bus."));
    return this.bus.call({ destination, path, interface: iface, member, signature, body });
  }

  private async manager(member: string): Promise<void> {
    try {
      // Not interactive: there's no polkit agent to ask for a password.
      await this.dbus(LOGIN, LOGIN_PATH, `${LOGIN}.Manager`, member, "b", [false]);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(403, `${member}: ${(error as Error).message}`);
    }
  }

  private async readUPower(): Promise<void> {
    const all = async (path: string, iface: string) =>
      ((await this.dbus(UPOWER, path, PROPERTIES, "GetAll", "s", [iface]).catch(() => [new Map()]))[0] as Map<string, unknown>);
    const manager = await all("/org/freedesktop/UPower", UPOWER);
    this.ac = manager.has("OnBattery") ? !manager.get("OnBattery") : null;
    this.battery = batteryOf(await all(DISPLAY_DEVICE, `${UPOWER}.Device`));
  }

  private onSignal(message: Message): void {
    if (message.interface !== PROPERTIES || message.member !== "PropertiesChanged") return;
    if (message.path !== DISPLAY_DEVICE && message.path !== "/org/freedesktop/UPower") return;
    // A few properties change at once, in one signal or several: read them all again.
    void this.readUPower().then(() => this.emit());
  }

  /**
   * The user's session with a seat, which logind lets set the backlight: the
   * helper's own (XDG_SESSION_ID), or the user's display session.
   */
  private async findSession(): Promise<string | null> {
    const own = process.env.XDG_SESSION_ID;
    if (own) {
      try {
        const [path] = (await this.dbus(LOGIN, LOGIN_PATH, `${LOGIN}.Manager`, "GetSession", "s", [own])) as [string];
        const [seat] = (await this.dbus(LOGIN, path, PROPERTIES, "Get", "ss", [`${LOGIN}.Session`, "Seat"])) as [[string, string]];
        if (seat[0]) return path;
      } catch {}
    }
    try {
      const [user] = (await this.dbus(LOGIN, LOGIN_PATH, `${LOGIN}.Manager`, "GetUser", "u", [userInfo().uid])) as [string];
      const [display] = (await this.dbus(LOGIN, user, PROPERTIES, "Get", "ss", [`${LOGIN}.User`, "Display"])) as [[string, string]];
      return display[1] && display[1] !== "/" ? display[1] : null;
    } catch {
      return null;
    }
  }

  private readBrightness(): number {
    if (!this.backlight) return 0;
    try {
      return Number(readFileSync(join(this.backlight.dir, "brightness"), "utf8").trim()) / this.backlight.max;
    } catch {
      return this.brightness;
    }
  }

  private async setBrightness(value: number): Promise<void> {
    const backlight = this.backlight;
    if (!backlight) throw new ServiceError(404, "There is no backlight here.");
    if (!this.session) throw new ServiceError(503, "No logind session to set the backlight through.");
    // Never quite off: a black screen looks broken.
    const raw = Math.round(Math.min(1, Math.max(0.01, value)) * backlight.max);
    try {
      await this.dbus(LOGIN, this.session, `${LOGIN}.Session`, "SetBrightness", "ssu", ["backlight", backlight.name, raw]);
    } catch (error) {
      throw new ServiceError(error instanceof ServiceError ? error.status : 403, `SetBrightness: ${(error as Error).message}`);
    }
    this.brightness = raw / backlight.max;
    this.emit();
  }

  private emit(): void {
    void this.state().then((state) => {
      const text = JSON.stringify(state);
      if (text === this.text) return;
      this.text = text;
      this.changed(state);
    });
  }
}

/** The battery in UPower's DisplayDevice properties, or null if there's none. */
export function batteryOf(props: Map<string, unknown>): PowerState["battery"] {
  if (props.get("Type") !== BATTERY || props.get("IsPresent") === false) return null;
  const state = BATTERY_STATES[Number(props.get("State"))] ?? "unknown";
  const charging = state === "charging" || state === "pending-charge";
  const seconds = Number(props.get(charging ? "TimeToFull" : "TimeToEmpty"));
  return {
    percent: Math.round(Number(props.get("Percentage") ?? 0)),
    charging,
    state,
    timeLeft: seconds > 0 ? seconds : null,
  };
}

/** The backlight to use: a firmware or platform one before a raw one, as desktops pick. */
function findBacklight(root: string): Backlight | null {
  const order = ["firmware", "platform", "raw"];
  const found: (Backlight & { rank: number })[] = [];
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return null;
  }
  for (const name of names) {
    const dir = join(root, name);
    try {
      const max = Number(readFileSync(join(dir, "max_brightness"), "utf8").trim());
      const type = readFileSync(join(dir, "type"), "utf8").trim();
      if (max > 0) found.push({ name, dir, max, rank: order.indexOf(type) < 0 ? order.length : order.indexOf(type) });
    } catch {}
  }
  found.sort((a, b) => a.rank - b.rank);
  return found[0] ? { name: found[0].name, dir: found[0].dir, max: found[0].max } : null;
}

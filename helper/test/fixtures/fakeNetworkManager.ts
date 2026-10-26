// A fake NetworkManager on a FakeBus, for the network service: a wired and a
// Wi-Fi device, access points, saved connections, and the calls the service
// makes (each one in `log`). It sends PropertiesChanged as NetworkManager
// does, and calls the secret agent the service registered.
import type { Message, Variant } from "../../src/dbus.ts";
import type { FakeBus, Reply } from "./fakeBus.ts";

const NM = "org.freedesktop.NetworkManager";
const NM_PATH = "/org/freedesktop/NetworkManager";
const PROPERTIES = "org.freedesktop.DBus.Properties";
export const WIFI_DEVICE = `${NM_PATH}/Devices/2`;
const WIRED_DEVICE = `${NM_PATH}/Devices/1`;

type Props = Record<string, Variant>;
type Settings = Record<string, Record<string, Variant>>;

const ssid = (text: string): Variant => ["ay", [...Buffer.from(text)]];
const ok = (signature = "", body: unknown[] = []): Reply => ({ signature, body });

export interface FakeAp {
  ssid: string;
  strength: number;
  /** "open", "wpa" (the default), "sae", "wep" or "enterprise". */
  security?: string;
  frequency?: number;
}

export class FakeNetworkManager {
  readonly log: string[] = [];
  /** The secret agent the service registered: its unique name and identifier. */
  agent: { sender: string; id: string } | null = null;
  private readonly bus: FakeBus;
  private readonly objects = new Map<string, Record<string, Props>>();
  private readonly settings = new Map<string, Settings>();
  private nextAp = 1;
  private nextConnection = 1;
  private nextActive = 1;

  constructor(bus: FakeBus) {
    this.bus = bus;
    this.objects.set(NM_PATH, {
      [NM]: {
        State: ["u", 70],
        Connectivity: ["u", 4],
        WirelessEnabled: ["b", true],
        WirelessHardwareEnabled: ["b", true],
        Devices: ["ao", [WIRED_DEVICE, WIFI_DEVICE]],
        ActiveConnections: ["ao", []],
        PrimaryConnection: ["o", "/"],
      },
    });
    this.objects.set(WIRED_DEVICE, { [`${NM}.Device`]: { DeviceType: ["u", 1], Interface: ["s", "eth0"] } });
    this.objects.set(WIFI_DEVICE, {
      [`${NM}.Device`]: { DeviceType: ["u", 2], Interface: ["s", "wlan0"] },
      [`${NM}.Device.Wireless`]: { AccessPoints: ["ao", []], ActiveAccessPoint: ["o", "/"], LastScan: ["x", 1000] },
    });
  }

  /** Takes NetworkManager's name on the bus. */
  start(): void {
    this.bus.own(NM, (message, sender) => this.handle(message, sender));
  }

  addAp(ap: FakeAp): string {
    const path = `${NM_PATH}/AccessPoint/${this.nextAp++}`;
    const security = ap.security ?? "wpa";
    const keyMgmt = { wpa: 0x100, sae: 0x400, enterprise: 0x200 }[security] ?? 0;
    this.objects.set(path, {
      [`${NM}.AccessPoint`]: {
        Ssid: ssid(ap.ssid),
        Strength: ["y", ap.strength],
        Flags: ["u", security === "open" ? 0 : 1],
        WpaFlags: ["u", 0],
        RsnFlags: ["u", keyMgmt],
        Frequency: ["u", ap.frequency ?? 2437],
      },
    });
    const wireless = this.props(WIFI_DEVICE, `${NM}.Device.Wireless`);
    this.set(WIFI_DEVICE, `${NM}.Device.Wireless`, { AccessPoints: ["ao", [...(wireless.AccessPoints![1] as string[]), path]] });
    return path;
  }

  /** A saved connection: `type` NetworkManager's ("802-11-wireless", "802-3-ethernet", "vpn"…). */
  addConnection(name: string, type: string, extra: Settings = {}): { path: string; uuid: string } {
    const path = `${NM_PATH}/Settings/${this.nextConnection++}`;
    const uuid = `uuid-${name.toLowerCase().replace(/\W+/g, "-")}`;
    const settings: Settings = { connection: { id: ["s", name], uuid: ["s", uuid], type: ["s", type] }, ...extra };
    if (type === "802-11-wireless" && !settings["802-11-wireless"]) settings["802-11-wireless"] = { ssid: ssid(name) };
    this.settings.set(path, settings);
    this.bus.signal(NM, `${NM_PATH}/Settings`, `${NM}.Settings`, "NewConnection", "o", [path]);
    return { path, uuid };
  }

  /** Makes saved connection `path` active (on the Wi-Fi device, through `ap`, if given), and the primary one. */
  activate(path: string, ap?: string): string {
    const settings = this.settings.get(path)!;
    const active = `${NM_PATH}/ActiveConnection/${this.nextActive++}`;
    const type = settings.connection!.type![1] as string;
    this.objects.set(active, {
      [`${NM}.Connection.Active`]: {
        Id: settings.connection!.id!,
        Uuid: settings.connection!.uuid!,
        Type: ["s", type],
        State: ["u", 2],
        Devices: ["ao", ap ? [WIFI_DEVICE] : type === "802-3-ethernet" ? [WIRED_DEVICE] : []],
        Connection: ["o", path],
      },
    });
    if (ap) this.set(WIFI_DEVICE, `${NM}.Device.Wireless`, { ActiveAccessPoint: ["o", ap] });
    // A connection is active once: activating it again replaces it.
    const others = (this.props(NM_PATH, NM).ActiveConnections![1] as string[]).filter(
      (entry) => this.props(entry, `${NM}.Connection.Active`).Uuid![1] !== settings.connection!.uuid![1],
    );
    this.set(NM_PATH, NM, {
      ActiveConnections: ["ao", [...others, active]],
      PrimaryConnection: ["o", active],
    });
    return active;
  }

  props(path: string, iface: string): Props {
    return this.objects.get(path)![iface]!;
  }

  /** Changes properties, with PropertiesChanged. */
  set(path: string, iface: string, changes: Props): void {
    Object.assign(this.props(path, iface), changes);
    this.bus.signal(NM, path, PROPERTIES, "PropertiesChanged", "sa{sv}as", [iface, changes, []]);
  }

  /** NetworkManager asks the agent for `setting`'s secrets of saved connection `path`. */
  getSecrets(path: string, setting: string, flags: number): Promise<Message> {
    return this.bus.callClient(this.agent!.sender, {
      path: `${NM_PATH}/SecretAgent`,
      interface: `${NM}.SecretAgent`,
      member: "GetSecrets",
      signature: "a{sa{sv}}osasu",
      body: [this.settings.get(path), path, setting, [], flags],
    });
  }

  cancelSecrets(path: string, setting: string): Promise<Message> {
    return this.bus.callClient(this.agent!.sender, {
      path: `${NM_PATH}/SecretAgent`,
      interface: `${NM}.SecretAgent`,
      member: "CancelGetSecrets",
      signature: "os",
      body: [path, setting],
    });
  }

  private handle(message: Message, sender: string): Reply {
    const body = (message.body ?? []) as unknown[];
    const path = message.path ?? "";
    const method = `${message.interface}.${message.member}`;
    switch (method) {
      case `${PROPERTIES}.GetAll`: {
        const props = this.objects.get(path)?.[String(body[0])];
        if (!props) return { error: "org.freedesktop.DBus.Error.UnknownObject" };
        return ok("a{sv}", [props]);
      }
      case `${PROPERTIES}.Set`: {
        const [iface, name, value] = body as [string, string, unknown];
        this.log.push(`Set ${name} ${value}`);
        this.set(path, iface, { [name]: ["b", value] });
        return ok();
      }
      case `${NM}.Settings.ListConnections`:
        return ok("ao", [[...this.settings.keys()]]);
      case `${NM}.Settings.Connection.GetSettings`: {
        const settings = this.settings.get(path);
        return settings ? ok("a{sa{sv}}", [settings]) : { error: "org.freedesktop.DBus.Error.UnknownObject" };
      }
      case `${NM}.Settings.Connection.Delete`:
        this.log.push(`Delete ${path}`);
        this.settings.delete(path);
        this.bus.signal(NM, `${NM_PATH}/Settings`, `${NM}.Settings`, "ConnectionRemoved", "o", [path]);
        return ok();
      case `${NM}.ActivateConnection`: {
        const [connection, device, ap] = body as string[];
        this.log.push(`ActivateConnection ${connection} ${device} ${ap}`);
        return ok("o", [this.activate(connection!, ap === "/" ? undefined : ap)]);
      }
      case `${NM}.AddAndActivateConnection`: {
        const [settings, device, ap] = body as [Map<string, Map<string, unknown>>, string, string];
        const security = settings.get("802-11-wireless-security");
        this.log.push(
          `AddAndActivateConnection ${device} ${ap}` +
            (security ? ` ${[...security].map(([key, value]) => `${key}=${value}`).join(" ")}` : ""),
        );
        const name = Buffer.from(this.props(ap, `${NM}.AccessPoint`).Ssid![1] as number[]).toString();
        const { path: connection } = this.addConnection(name, "802-11-wireless");
        return ok("oo", [connection, this.activate(connection, ap)]);
      }
      case `${NM}.DeactivateConnection`: {
        const [active] = body as string[];
        this.log.push(`DeactivateConnection ${active}`);
        const root = this.props(NM_PATH, NM);
        this.objects.delete(active!);
        this.set(NM_PATH, NM, {
          ActiveConnections: ["ao", (root.ActiveConnections![1] as string[]).filter((entry) => entry !== active)],
          PrimaryConnection: ["o", "/"],
        });
        return ok();
      }
      case `${NM}.Device.Wireless.RequestScan`:
        this.log.push(`RequestScan ${path}`);
        return ok();
      case `${NM}.AgentManager.RegisterWithCapabilities`:
        this.agent = { sender, id: String(body[0]) };
        return ok();
      default:
        return { error: "org.freedesktop.DBus.Error.UnknownMethod", message: method };
    }
  }
}

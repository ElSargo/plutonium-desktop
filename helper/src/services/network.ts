// The network service (docs/features/DESKTOP_SERVICES.md, "network"):
// NetworkManager over the system bus. Its state is the overall state, the
// primary connection, Wi-Fi and its access points, and the saved
// connections; NetworkManager's PropertiesChanged signals keep a cache of its
// objects current, and the state is made again from the cache. The helper is
// also a NetworkManager secret agent: when a connection needs a password
// (a known network's changed, a new one's was wrong, 802.1X), a shell asks
// the user.
import { DBusConnection, DBusError, type Message, type Reply, type Variant } from "../dbus.ts";
import { type DesktopService, ServiceError } from "../services.ts";
import {
  addMatch,
  type AskUser,
  bytesText,
  getAll,
  hasOwner,
  PROPERTIES,
  type Props,
  setProperty,
  SYSTEM_BUS,
  type SystemBusOptions,
} from "./systemBus.ts";

const NM = "org.freedesktop.NetworkManager";
const NM_PATH = "/org/freedesktop/NetworkManager";
const SETTINGS_PATH = `${NM_PATH}/Settings`;
const AGENT_PATH = `${NM_PATH}/SecretAgent`;
const SECRET_AGENT = `${NM}.SecretAgent`;
const DEVICE = `${NM}.Device`;
const WIRELESS = `${NM}.Device.Wireless`;
const ACCESS_POINT = `${NM}.AccessPoint`;
const ACTIVE = `${NM}.Connection.Active`;
const CONNECTION = `${NM}.Settings.Connection`;

const DEVICE_WIFI = 2;
// NM80211ApFlags, NM80211ApSecurityFlags.
const AP_PRIVACY = 0x1;
const KEY_MGMT_PSK = 0x100;
const KEY_MGMT_802_1X = 0x200;
const KEY_MGMT_SAE = 0x400;
const KEY_MGMT_OWE = 0x800 | 0x1000;
const KEY_MGMT_SUITE_B = 0x2000;
// NMSecretAgentGetSecretsFlags.
const ALLOW_INTERACTION = 0x1;
const REQUEST_NEW = 0x2;

/** NetworkManager's connection types, as the state names them. */
const KINDS: Record<string, string> = {
  "802-11-wireless": "wifi",
  "802-3-ethernet": "ethernet",
  vpn: "vpn",
  wireguard: "vpn",
  gsm: "mobile",
  cdma: "mobile",
  bluetooth: "bluetooth",
};
const kindOf = (type: unknown) => KINDS[String(type)] ?? String(type);

const STATES: Record<number, NetworkState["state"]> = {
  10: "offline",
  20: "offline",
  30: "disconnecting",
  40: "connecting",
  50: "connected",
  60: "connected",
  70: "connected",
};
const CONNECTIVITY = ["unknown", "none", "portal", "limited", "full"] as const;
const ACTIVE_STATES = [null, "activating", "activated", "deactivating", null] as const;

export interface AccessPoint {
  readonly ssid: string;
  /** 0–100. */
  readonly strength: number;
  /** Needs a password (or 802.1X). */
  readonly secured: boolean;
  readonly security: "open" | "owe" | "wep" | "wpa" | "sae" | "enterprise";
  /** A saved connection for it: its id. */
  readonly known: boolean;
  readonly id: string | null;
  readonly active: boolean;
  /** MHz. */
  readonly frequency: number;
}

export interface SavedConnection {
  /** Its UUID. */
  readonly id: string;
  readonly name: string;
  /** "wifi", "ethernet", "vpn", "mobile", "bluetooth" or NetworkManager's own type. */
  readonly type: string;
  readonly ssid?: string;
  readonly active: boolean;
  readonly state: "activating" | "activated" | "deactivating" | null;
}

export interface NetworkState {
  readonly available: boolean;
  readonly state: "connected" | "connecting" | "disconnecting" | "offline" | "unknown";
  readonly connectivity: (typeof CONNECTIVITY)[number];
  /** The connection the default route goes through. */
  readonly primary: { id: string; name: string; type: string; strength?: number } | null;
  readonly wifi: { available: boolean; enabled: boolean; hardwareEnabled: boolean; scanning: boolean };
  readonly accessPoints: AccessPoint[];
  readonly connections: SavedConnection[];
}

const UNAVAILABLE: NetworkState = {
  available: false,
  state: "unknown",
  connectivity: "unknown",
  primary: null,
  wifi: { available: false, enabled: false, hardwareEnabled: false, scanning: false },
  accessPoints: [],
  connections: [],
};

function securityOf(ap: Props): AccessPoint["security"] {
  const flags = Number(ap.get("WpaFlags") ?? 0) | Number(ap.get("RsnFlags") ?? 0);
  if (flags & (KEY_MGMT_802_1X | KEY_MGMT_SUITE_B)) return "enterprise";
  if (flags & KEY_MGMT_PSK) return "wpa";
  if (flags & KEY_MGMT_SAE) return "sae";
  if (flags & KEY_MGMT_OWE) return "owe";
  return Number(ap.get("Flags") ?? 0) & AP_PRIVACY ? "wep" : "open";
}

export interface NetworkOptions extends SystemBusOptions {
  /** The secret agent's identifier, one per helper (NetworkManager replaces an agent with the same one). */
  readonly agentId?: string;
}

export class NetworkService implements DesktopService {
  readonly name = "network";
  private readonly options: NetworkOptions;
  private bus: DBusConnection | null = null;
  private changed: (state: unknown) => void = () => {};
  /** NetworkManager's objects we've read: path → interface → properties. */
  private objects = new Map<string, Map<string, Props>>();
  /** The saved connections' settings, by path. */
  private settings = new Map<string, Map<string, Props>>();
  private connectionPaths: string[] | null = null;
  private current: NetworkState = UNAVAILABLE;
  private sent = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private syncing: Promise<void> | null = null;
  private again = false;
  /** Until this time (or the next scan's result), Wi-Fi is scanning. */
  private scanUntil = 0;
  /** Passwords `connect` was given for known networks, for NetworkManager to ask the agent for. */
  private readonly offered = new Map<string, { password: string; until: number }>();
  /** Secret requests a shell is asking, by connection path and setting. */
  private readonly asking = new Map<string, AbortController>();

  constructor(options: NetworkOptions = {}) {
    this.options = options;
  }

  async start(changed: (state: unknown) => void): Promise<void> {
    this.changed = changed;
    const bus = await DBusConnection.connect(this.options.address ?? SYSTEM_BUS);
    this.bus = bus;
    bus.onSignal = (message) => this.onSignal(message);
    bus.onCall = (message) => this.onAgentCall(message);
    await addMatch(bus, `type='signal',sender='${NM}'`);
    await addMatch(bus, `type='signal',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='${NM}'`);
    if (await hasOwner(bus, NM)) await this.appeared();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const controller of this.asking.values()) controller.abort();
    this.bus?.close();
    this.bus = null;
  }

  async state(): Promise<NetworkState> {
    await this.syncing;
    return this.current;
  }

  /** NetworkManager is there (at the start, or it started again): read it all, and be its agent. */
  private async appeared(): Promise<void> {
    this.objects.clear();
    this.settings.clear();
    this.connectionPaths = null;
    await this.sync();
    // PLUTONIUM_NM_AGENT=0 leaves the secrets to another agent (a test session's helper on the real computer).
    if (this.options.ask && process.env.PLUTONIUM_NM_AGENT !== "0") {
      try {
        await this.nm("AgentManager", `${NM}.AgentManager`, "RegisterWithCapabilities", "su", [
          this.options.agentId ?? "org.plutonium.helper",
          0,
        ]);
      } catch (error) {
        console.warn(`plutoniumd: not a NetworkManager secret agent: ${(error as Error).message}`);
      }
    }
  }

  private nm(path: string, iface: string, member: string, signature = "", body: unknown[] = [], timeoutMs?: number) {
    if (!this.bus) throw new ServiceError(503, "There is no NetworkManager.");
    return this.bus.call({
      destination: NM,
      path: path.startsWith("/") ? path : `${NM_PATH}/${path}`,
      interface: iface,
      member,
      signature,
      body,
      timeoutMs,
    });
  }

  private onSignal(message: Message): void {
    const body = message.body ?? [];
    if (message.member === "NameOwnerChanged") {
      if (body[0] !== NM) return;
      const [, , owner] = body as string[];
      this.current = UNAVAILABLE;
      this.objects.clear();
      if (owner) void this.appeared();
      else this.publish();
      return;
    }
    if (message.interface === PROPERTIES && message.member === "PropertiesChanged") {
      const [iface, changes] = body as [string, Props];
      const props = this.objects.get(message.path ?? "")?.get(iface);
      if (!props) return;
      for (const [name, value] of changes) props.set(name, value);
      if (iface === WIRELESS && changes.has("LastScan")) this.scanUntil = 0;
      this.schedule();
      return;
    }
    if (message.interface === `${NM}.Settings` || message.interface === CONNECTION) {
      // NewConnection, ConnectionRemoved, a connection's Updated.
      this.connectionPaths = null;
      if (message.member === "Updated") this.settings.delete(message.path ?? "");
      this.schedule();
    }
  }

  /** Makes the state again soon (a burst of signals makes it once). */
  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sync();
    }, 30);
  }

  private sync(): Promise<void> {
    if (this.syncing) {
      this.again = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      do {
        this.again = false;
        try {
          this.current = await this.read();
        } catch (error) {
          console.warn(`plutoniumd: network: ${(error as Error).message}`);
          this.current = UNAVAILABLE;
        }
      } while (this.again);
    })().finally(() => {
      this.syncing = null;
      this.publish();
    });
    return this.syncing;
  }

  private publish(): void {
    const text = JSON.stringify(this.current);
    if (text === this.sent) return;
    this.sent = text;
    this.changed(this.current);
  }

  /** `path`'s properties on `iface`, from the cache or NetworkManager; null if it's gone. */
  private async props(path: string, iface: string, seen: Set<string>): Promise<Props | null> {
    seen.add(path);
    let interfaces = this.objects.get(path);
    const cached = interfaces?.get(iface);
    if (cached) return cached;
    try {
      const props = await getAll(this.bus!, NM, path, iface);
      if (!interfaces) this.objects.set(path, (interfaces = new Map()));
      interfaces.set(iface, props);
      return props;
    } catch (error) {
      if (error instanceof DBusError) return null;
      throw error;
    }
  }

  private async read(): Promise<NetworkState> {
    if (!this.bus) return UNAVAILABLE;
    const seen = new Set<string>();
    const root = await this.props(NM_PATH, NM, seen);
    if (!root) return UNAVAILABLE;
    const paths = (value: unknown) => ((value as string[] | undefined) ?? []).filter((path) => path !== "/");

    // Devices, and the Wi-Fi ones' access points.
    const wifiDevices: { path: string; device: Props; wireless: Props }[] = [];
    await Promise.all(
      paths(root.get("Devices")).map(async (path) => {
        const device = await this.props(path, DEVICE, seen);
        if (Number(device?.get("DeviceType")) !== DEVICE_WIFI) return;
        const wireless = await this.props(path, WIRELESS, seen);
        if (device && wireless) wifiDevices.push({ path, device, wireless });
      }),
    );
    const accessPoints = new Map<string, Props>();
    await Promise.all(
      wifiDevices.flatMap(({ wireless }) =>
        paths(wireless.get("AccessPoints")).map(async (path) => {
          const ap = await this.props(path, ACCESS_POINT, seen);
          if (ap) accessPoints.set(path, ap);
        }),
      ),
    );
    const actives = new Map<string, Props>();
    await Promise.all(
      paths(root.get("ActiveConnections")).map(async (path) => {
        const active = await this.props(path, ACTIVE, seen);
        if (active) actives.set(path, active);
      }),
    );

    // The saved connections (their settings change seldom: kept until a signal says so).
    if (!this.connectionPaths) {
      const [list] = await this.nm(SETTINGS_PATH, `${NM}.Settings`, "ListConnections");
      this.connectionPaths = list as string[];
    }
    const saved = new Map<string, Map<string, Props>>();
    await Promise.all(
      this.connectionPaths.map(async (path) => {
        let settings = this.settings.get(path);
        if (!settings) {
          try {
            settings = (await this.nm(path, CONNECTION, "GetSettings"))[0] as Map<string, Props>;
          } catch (error) {
            if (error instanceof DBusError) return;
            throw error;
          }
          this.settings.set(path, settings);
        }
        saved.set(path, settings);
      }),
    );
    for (const path of this.settings.keys()) if (!saved.has(path)) this.settings.delete(path);
    for (const path of this.objects.keys()) if (!seen.has(path)) this.objects.delete(path);

    const activeByUuid = new Map([...actives.values()].map((active) => [String(active.get("Uuid")), active]));
    const connections: SavedConnection[] = [];
    const knownBySsid = new Map<string, string>();
    for (const settings of saved.values()) {
      const connection = settings.get("connection");
      const type = String(connection?.get("type") ?? "");
      if (type === "loopback") continue;
      const id = String(connection?.get("uuid") ?? "");
      const ssid = type === "802-11-wireless" ? bytesText(settings.get("802-11-wireless")?.get("ssid")) : undefined;
      if (ssid) knownBySsid.set(ssid, id);
      const active = activeByUuid.get(id);
      connections.push({
        id,
        name: String(connection?.get("id") ?? ""),
        type: kindOf(type),
        ...(ssid !== undefined ? { ssid } : {}),
        active: active !== undefined,
        state: active ? (ACTIVE_STATES[Number(active.get("State"))] ?? null) : null,
      });
    }
    connections.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));

    // One entry per network: its strongest access point.
    const activeAps = new Set(wifiDevices.map(({ wireless }) => String(wireless.get("ActiveAccessPoint"))));
    const networks = new Map<string, AccessPoint>();
    for (const [path, ap] of accessPoints) {
      const ssid = bytesText(ap.get("Ssid"));
      if (!ssid) continue; // A hidden network.
      const security = securityOf(ap);
      const entry: AccessPoint = {
        ssid,
        strength: Number(ap.get("Strength") ?? 0),
        secured: security !== "open" && security !== "owe",
        security,
        known: knownBySsid.has(ssid),
        id: knownBySsid.get(ssid) ?? null,
        active: activeAps.has(path) || networks.get(ssid)?.active === true,
        frequency: Number(ap.get("Frequency") ?? 0),
      };
      const before = networks.get(ssid);
      if (!before || entry.strength > before.strength) networks.set(ssid, entry);
      else if (entry.active) networks.set(ssid, { ...before, active: true });
    }
    const list = [...networks.values()].sort(
      (a, b) => Number(b.active) - Number(a.active) || b.strength - a.strength || a.ssid.localeCompare(b.ssid),
    );

    const primaryActive = actives.get(String(root.get("PrimaryConnection")));
    let primary: NetworkState["primary"] = null;
    if (primaryActive) {
      const type = kindOf(primaryActive.get("Type"));
      const device = wifiDevices.find(({ path }) => paths(primaryActive.get("Devices")).includes(path));
      const ap = device ? accessPoints.get(String(device.wireless.get("ActiveAccessPoint"))) : undefined;
      primary = {
        id: String(primaryActive.get("Uuid")),
        name: String(primaryActive.get("Id")),
        type,
        ...(type === "wifi" && ap ? { strength: Number(ap.get("Strength") ?? 0) } : {}),
      };
    }
    return {
      available: true,
      state: STATES[Number(root.get("State"))] ?? "unknown",
      connectivity: CONNECTIVITY[Number(root.get("Connectivity"))] ?? "unknown",
      primary,
      wifi: {
        available: wifiDevices.length > 0,
        enabled: root.get("WirelessEnabled") === true,
        hardwareEnabled: root.get("WirelessHardwareEnabled") === true,
        scanning: Date.now() < this.scanUntil,
      },
      accessPoints: list,
      connections,
    };
  }

  async call(action: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.bus || !this.current.available) throw new ServiceError(409, "There is no NetworkManager.");
    try {
      switch (action) {
        case "scan":
          return await this.scan();
        case "connect":
          return await this.connect(args);
        case "disconnect":
          return await this.disconnect(args);
        case "set-wifi":
          if (typeof args.enabled !== "boolean") throw new ServiceError(400, "set-wifi takes { enabled: true | false }.");
          await setProperty(this.bus, NM, NM_PATH, NM, "WirelessEnabled", ["b", args.enabled]);
          return null;
        case "forget":
          return await this.forget(args);
        default:
          throw new ServiceError(404, `The network service has no action "${action}".`);
      }
    } catch (error) {
      if (error instanceof DBusError) throw new ServiceError(409, error.message);
      throw error;
    }
  }

  private wifiDevices(): string[] {
    const devices = (this.objects.get(NM_PATH)?.get(NM)?.get("Devices") as string[] | undefined) ?? [];
    return devices.filter((path) => this.objects.get(path)?.has(WIRELESS));
  }

  private async scan(): Promise<null> {
    const devices = this.wifiDevices();
    if (devices.length === 0) throw new ServiceError(409, "There is no Wi-Fi.");
    for (const path of devices) {
      try {
        await this.nm(path, WIRELESS, "RequestScan", "a{sv}", [{}]);
      } catch (error) {
        // "Scanning not allowed immediately following previous scan": one is under way.
        if (!(error instanceof DBusError) || !/scan/i.test(error.message)) throw error;
      }
    }
    this.scanUntil = Date.now() + 15_000;
    setTimeout(() => this.schedule(), 15_100).unref();
    this.schedule();
    return null;
  }

  /** The strongest access point named `ssid`, and its device. */
  private accessPoint(ssid: string): { device: string; path: string; props: Props } | null {
    let best: { device: string; path: string; props: Props } | null = null;
    for (const device of this.wifiDevices()) {
      const aps = (this.objects.get(device)?.get(WIRELESS)?.get("AccessPoints") as string[] | undefined) ?? [];
      for (const path of aps) {
        const props = this.objects.get(path)?.get(ACCESS_POINT);
        if (!props || bytesText(props.get("Ssid")) !== ssid) continue;
        if (!best || Number(props.get("Strength")) > Number(best.props.get("Strength"))) best = { device, path, props };
      }
    }
    return best;
  }

  private savedPath(id: string): string | undefined {
    for (const [path, settings] of this.settings) if (settings.get("connection")?.get("uuid") === id) return path;
    return undefined;
  }

  private async connect(args: Record<string, unknown>): Promise<null> {
    const password = typeof args.password === "string" ? args.password : undefined;
    if (typeof args.id === "string") {
      const path = this.savedPath(args.id);
      if (!path) throw new ServiceError(404, `There is no saved connection ${args.id}.`);
      if (password) this.offer(args.id, password);
      await this.nm(NM_PATH, NM, "ActivateConnection", "ooo", [path, "/", "/"]);
      return null;
    }
    if (typeof args.ssid !== "string") throw new ServiceError(400, "connect takes { ssid, password? } or { id }.");
    const ap = this.accessPoint(args.ssid);
    if (!ap) throw new ServiceError(404, `There is no network "${args.ssid}" in range.`);
    const known = this.current.connections.find((connection) => connection.type === "wifi" && connection.ssid === args.ssid);
    if (known) {
      if (password) this.offer(known.id, password);
      await this.nm(NM_PATH, NM, "ActivateConnection", "ooo", [this.savedPath(known.id), ap.device, ap.path]);
      return null;
    }
    // A new network: NetworkManager makes and keeps the connection, with the password.
    const security = securityOf(ap.props);
    if (security === "enterprise") throw new ServiceError(409, "Joining a new 802.1X (enterprise) network isn't supported yet.");
    const settings: Record<string, Record<string, Variant>> = {};
    if (security === "wpa" || security === "sae" || security === "wep") {
      if (!password) throw new ServiceError(400, `"${args.ssid}" needs a password.`);
      settings["802-11-wireless-security"] =
        security === "wep"
          ? { "key-mgmt": ["s", "none"], "wep-key0": ["s", password] }
          : { "key-mgmt": ["s", security === "sae" ? "sae" : "wpa-psk"], psk: ["s", password] };
    }
    await this.nm(NM_PATH, NM, "AddAndActivateConnection", "a{sa{sv}}oo", [settings, ap.device, ap.path], 30_000);
    return null;
  }

  private offer(id: string, password: string): void {
    this.offered.set(id, { password, until: Date.now() + 60_000 });
  }

  private async disconnect(args: Record<string, unknown>): Promise<null> {
    if (typeof args.id !== "string") throw new ServiceError(400, "disconnect takes { id } (a connection's).");
    const actives = (this.objects.get(NM_PATH)?.get(NM)?.get("ActiveConnections") as string[] | undefined) ?? [];
    const active = actives.find((path) => this.objects.get(path)?.get(ACTIVE)?.get("Uuid") === args.id);
    if (!active) throw new ServiceError(404, `Connection ${args.id} isn't active.`);
    await this.nm(NM_PATH, NM, "DeactivateConnection", "o", [active]);
    return null;
  }

  private async forget(args: Record<string, unknown>): Promise<null> {
    const matches = this.current.connections.filter((connection) =>
      typeof args.id === "string" ? connection.id === args.id : connection.type === "wifi" && connection.ssid === args.ssid,
    );
    if (typeof args.id !== "string" && typeof args.ssid !== "string") throw new ServiceError(400, "forget takes { id } or { ssid }.");
    if (matches.length === 0) throw new ServiceError(404, "There is no such saved connection.");
    for (const { id } of matches) {
      const path = this.savedPath(id);
      if (path) await this.nm(path, CONNECTION, "Delete");
    }
    return null;
  }

  // The secret agent (org.freedesktop.NetworkManager.SecretAgent).

  private async onAgentCall(message: Message): Promise<Reply> {
    const unknown = () => {
      throw new DBusError("org.freedesktop.DBus.Error.UnknownMethod", `No such method ${message.member}`);
    };
    if (message.path !== AGENT_PATH || message.interface !== SECRET_AGENT) return unknown();
    const body = message.body ?? [];
    switch (message.member) {
      case "GetSecrets": {
        const [connection, path, setting, , flags] = body as [Map<string, Props>, string, string, string[], number];
        return { signature: "a{sa{sv}}", body: [await this.secrets(connection, path, setting, flags)] };
      }
      case "CancelGetSecrets":
        this.asking.get(`${body[0]}\0${body[1]}`)?.abort();
        return {};
      case "SaveSecrets":
      case "DeleteSecrets":
        // NetworkManager keeps the secrets (system-owned); we keep none.
        return {};
      default:
        return unknown();
    }
  }

  private async secrets(connection: Map<string, Props>, path: string, setting: string, flags: number) {
    const noSecrets = () => new DBusError(`${SECRET_AGENT}.Error.NoSecrets`, "No secrets.");
    const about = connection.get("connection");
    const id = String(about?.get("uuid") ?? "");
    const name = String(about?.get("id") ?? "");
    const ssid = bytesText(connection.get("802-11-wireless")?.get("ssid"));
    const keyMgmt = String(connection.get("802-11-wireless-security")?.get("key-mgmt") ?? "");
    let field: string;
    if (setting === "802-11-wireless-security") field = keyMgmt === "none" ? "wep-key0" : "psk";
    else if (setting === "802-1x") field = "password";
    else throw noSecrets(); // VPNs' own secrets: later.
    const answer = (values: Record<string, unknown>) => {
      const secrets: Record<string, Variant> = { [field]: ["s", String(values.password ?? "")] };
      if (setting === "802-1x" && typeof values.identity === "string" && values.identity) {
        secrets.identity = ["s", values.identity];
      }
      return { [setting]: secrets };
    };

    const offered = this.offered.get(id);
    this.offered.delete(id);
    if (offered && offered.until > Date.now() && !(flags & REQUEST_NEW)) return answer(offered);
    if (!(flags & ALLOW_INTERACTION) || !this.options.ask) throw noSecrets();
    const key = `${path}\0${setting}`;
    this.asking.get(key)?.abort();
    const controller = new AbortController();
    this.asking.set(key, controller);
    const enterprise = setting === "802-1x";
    const fields = [
      ...(enterprise ? [{ name: "identity", label: "User name", type: "text", value: String(connection.get("802-1x")?.get("identity") ?? "") }] : []),
      { name: "password", label: "Password", type: "password" },
    ];
    const label = ssid || name;
    try {
      const values = await this.options.ask(
        "secret",
        {
          title: (flags & REQUEST_NEW) ? `The password for "${label}" didn't work` : `"${label}" needs a password`,
          message: ssid ? "Enter the Wi-Fi network's password." : `Enter the password for ${name}.`,
          fields,
          acceptLabel: "Connect",
          id,
          name,
          ...(ssid ? { ssid } : {}),
          type: kindOf(about?.get("type")),
          setting,
          retry: (flags & REQUEST_NEW) !== 0,
        },
        controller.signal,
      );
      if (controller.signal.aborted) throw new DBusError(`${SECRET_AGENT}.Error.AgentCanceled`, "Canceled.");
      if (values === undefined) throw noSecrets();
      if (values === null) throw new DBusError(`${SECRET_AGENT}.Error.UserCanceled`, "The user canceled.");
      return answer(values);
    } finally {
      if (this.asking.get(key) === controller) this.asking.delete(key);
    }
  }
}

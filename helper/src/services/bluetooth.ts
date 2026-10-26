// The Bluetooth service (docs/features/DESKTOP_SERVICES.md, "bluetooth"):
// BlueZ over the system bus. Its state is the adapter and the devices
// (paired ones, and named ones found by discovering); BlueZ's ObjectManager
// and PropertiesChanged signals keep a copy of its objects current. The
// helper registers a BlueZ agent (Agent1) for the pairings it starts, so a
// PIN, a passkey or a confirmation goes to a shell; it doesn't ask to be the
// default agent, so other pairings stay with whoever has them.
import { DBusConnection, DBusError, type Message, type Reply } from "../dbus.ts";
import { type DesktopService, ServiceError } from "../services.ts";
import {
  addMatch,
  type AskUser,
  hasOwner,
  OBJECT_MANAGER,
  PROPERTIES,
  type Props,
  setProperty,
  SYSTEM_BUS,
  type SystemBusOptions,
} from "./systemBus.ts";

const BLUEZ = "org.bluez";
const ADAPTER = "org.bluez.Adapter1";
const DEVICE = "org.bluez.Device1";
const BATTERY = "org.bluez.Battery1";
const AGENT = "org.bluez.Agent1";
const AGENT_PATH = "/org/plutonium/BluetoothAgent";
/** The longest discovery a shell can ask for (s). */
const MAX_DISCOVERY = 120;

export interface BluetoothDevice {
  /** Its object path (what the actions take). */
  readonly id: string;
  readonly address: string;
  readonly name: string;
  /** BlueZ's icon name ("input-mouse", "audio-headset", …), or "". */
  readonly icon: string;
  readonly paired: boolean;
  readonly trusted: boolean;
  readonly connected: boolean;
  /** 0–100, where BlueZ knows it. */
  readonly battery: number | null;
  /** A pair this service started is under way. */
  readonly pairing: boolean;
}

export interface BluetoothState {
  readonly available: boolean;
  readonly adapter: {
    id: string;
    name: string;
    address: string;
    powered: boolean;
    discovering: boolean;
    discoverable: boolean;
  } | null;
  readonly devices: BluetoothDevice[];
}

const UNAVAILABLE: BluetoothState = { available: false, adapter: null, devices: [] };

export class BluetoothService implements DesktopService {
  readonly name = "bluetooth";
  private readonly options: SystemBusOptions;
  private bus: DBusConnection | null = null;
  private changed: (state: unknown) => void = () => {};
  /** BlueZ's objects: path → interface → properties. */
  private objects = new Map<string, Map<string, Props>>();
  private present = false;
  private sent = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private discoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pairing = new Set<string>();
  /** Questions a shell is asking, by device (BlueZ's Cancel takes them all back). */
  private readonly asking = new Map<string, AbortController>();

  constructor(options: SystemBusOptions = {}) {
    this.options = options;
  }

  async start(changed: (state: unknown) => void): Promise<void> {
    this.changed = changed;
    const bus = await DBusConnection.connect(this.options.address ?? SYSTEM_BUS);
    this.bus = bus;
    bus.onSignal = (message) => this.onSignal(message);
    bus.onCall = (message) => this.onAgentCall(message);
    await addMatch(bus, `type='signal',sender='${BLUEZ}'`);
    await addMatch(bus, `type='signal',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='${BLUEZ}'`);
    if (await hasOwner(bus, BLUEZ)) await this.appeared();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
    for (const controller of this.asking.values()) controller.abort();
    this.bus?.close();
    this.bus = null;
  }

  async state(): Promise<BluetoothState> {
    return this.read();
  }

  /** BlueZ is there (at the start, or it started again): read its objects, and register the agent. */
  private async appeared(): Promise<void> {
    const [managed] = await this.bluez("/", OBJECT_MANAGER, "GetManagedObjects");
    this.objects = managed as Map<string, Map<string, Props>>;
    this.present = true;
    this.publish();
    if (this.options.ask) {
      try {
        await this.bluez("/org/bluez", "org.bluez.AgentManager1", "RegisterAgent", "os", [AGENT_PATH, "KeyboardDisplay"]);
      } catch (error) {
        console.warn(`plutoniumd: no Bluetooth agent: ${(error as Error).message}`);
      }
    }
  }

  private bluez(path: string, iface: string, member: string, signature = "", body: unknown[] = [], timeoutMs?: number) {
    if (!this.bus) throw new ServiceError(503, "There is no BlueZ.");
    return this.bus.call({ destination: BLUEZ, path, interface: iface, member, signature, body, timeoutMs });
  }

  private onSignal(message: Message): void {
    const body = message.body ?? [];
    const path = message.path ?? "";
    if (message.member === "NameOwnerChanged") {
      if (body[0] !== BLUEZ) return;
      this.objects.clear();
      this.present = false;
      if (body[2]) void this.appeared().catch(() => {});
      this.publish();
      return;
    }
    if (message.interface === OBJECT_MANAGER && message.member === "InterfacesAdded") {
      const [added, interfaces] = body as [string, Map<string, Props>];
      const known = this.objects.get(added) ?? new Map<string, Props>();
      for (const [iface, props] of interfaces) known.set(iface, props);
      this.objects.set(added, known);
    } else if (message.interface === OBJECT_MANAGER && message.member === "InterfacesRemoved") {
      const [removed, interfaces] = body as [string, string[]];
      const known = this.objects.get(removed);
      for (const iface of interfaces) known?.delete(iface);
      if (known?.size === 0) this.objects.delete(removed);
    } else if (message.interface === PROPERTIES && message.member === "PropertiesChanged") {
      const [iface, changes, invalidated] = body as [string, Props, string[]];
      const props = this.objects.get(path)?.get(iface);
      if (!props) return;
      for (const [name, value] of changes) props.set(name, value);
      for (const name of invalidated ?? []) props.delete(name);
    } else {
      return;
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.publish();
    }, 30);
  }

  private publish(): void {
    const state = this.read();
    const text = JSON.stringify(state);
    if (text === this.sent) return;
    this.sent = text;
    this.changed(state);
  }

  /** The adapter: the first one there is. */
  private adapterPath(): string | undefined {
    return [...this.objects].filter(([, interfaces]) => interfaces.has(ADAPTER)).map(([path]) => path).sort()[0];
  }

  private read(): BluetoothState {
    if (!this.present) return UNAVAILABLE;
    const adapterPath = this.adapterPath();
    if (!adapterPath) return { available: true, adapter: null, devices: [] };
    const adapter = this.objects.get(adapterPath)!.get(ADAPTER)!;
    const devices: BluetoothDevice[] = [];
    for (const [path, interfaces] of this.objects) {
      const device = interfaces.get(DEVICE);
      if (!device || device.get("Adapter") !== adapterPath) continue;
      const paired = device.get("Paired") === true;
      // Unnamed ones found nearby (beacons, most of them) aren't listed.
      if (!paired && !device.has("Name")) continue;
      const battery = interfaces.get(BATTERY)?.get("Percentage");
      devices.push({
        id: path,
        address: String(device.get("Address") ?? ""),
        name: String(device.get("Alias") ?? device.get("Name") ?? device.get("Address") ?? ""),
        icon: String(device.get("Icon") ?? ""),
        paired,
        trusted: device.get("Trusted") === true,
        connected: device.get("Connected") === true,
        battery: typeof battery === "number" ? battery : null,
        pairing: this.pairing.has(path),
      });
    }
    devices.sort(
      (a, b) =>
        Number(b.connected) - Number(a.connected) || Number(b.paired) - Number(a.paired) || a.name.localeCompare(b.name),
    );
    return {
      available: true,
      adapter: {
        id: adapterPath,
        name: String(adapter.get("Alias") ?? adapter.get("Name") ?? ""),
        address: String(adapter.get("Address") ?? ""),
        powered: adapter.get("Powered") === true,
        discovering: adapter.get("Discovering") === true,
        discoverable: adapter.get("Discoverable") === true,
      },
      devices,
    };
  }

  async call(action: string, args: Record<string, unknown>): Promise<unknown> {
    const adapter = this.adapterPath();
    if (!this.bus || !this.present || !adapter) throw new ServiceError(409, "There is no Bluetooth adapter.");
    const device = () => {
      const id = args.device;
      if (typeof id !== "string" || !this.objects.get(id)?.has(DEVICE)) {
        throw new ServiceError(typeof id === "string" ? 404 : 400, `${action} takes { device } (a device's id).`);
      }
      return id;
    };
    try {
      switch (action) {
        case "set-powered":
          if (typeof args.powered !== "boolean") throw new ServiceError(400, "set-powered takes { powered: true | false }.");
          await setProperty(this.bus, BLUEZ, adapter, ADAPTER, "Powered", ["b", args.powered]);
          return null;
        case "discover":
          return await this.discover(adapter, args);
        case "pair":
          return await this.pair(device());
        case "connect":
          await this.bluez(device(), DEVICE, "Connect", "", [], 30_000);
          return null;
        case "disconnect":
          await this.bluez(device(), DEVICE, "Disconnect", "", [], 15_000);
          return null;
        case "forget":
          await this.bluez(adapter, ADAPTER, "RemoveDevice", "o", [device()]);
          return null;
        default:
          throw new ServiceError(404, `The bluetooth service has no action "${action}".`);
      }
    } catch (error) {
      if (error instanceof DBusError) throw new ServiceError(409, error.message);
      throw error;
    }
  }

  /** { on: true, seconds? } looks for devices for a while (30 s; at most 120); { on: false } stops. */
  private async discover(adapter: string, args: Record<string, unknown>): Promise<null> {
    if (typeof args.on !== "boolean") throw new ServiceError(400, "discover takes { on: true | false, seconds? }.");
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
    this.discoveryTimer = null;
    const ignore = (word: string) => (error: unknown) => {
      if (!(error instanceof DBusError) || !error.errorName.endsWith(word)) throw error;
    };
    if (!args.on) {
      await this.bluez(adapter, ADAPTER, "StopDiscovery").catch(ignore("Failed"));
      return null;
    }
    await this.bluez(adapter, ADAPTER, "StartDiscovery").catch(ignore("InProgress"));
    const seconds = Math.min(MAX_DISCOVERY, Math.max(1, Number(args.seconds ?? 30) || 30));
    this.discoveryTimer = setTimeout(() => {
      this.discoveryTimer = null;
      this.bluez(adapter, ADAPTER, "StopDiscovery").catch(() => {});
    }, seconds * 1000);
    this.discoveryTimer.unref();
    return null;
  }

  /** Pairs (the agent asks the shell what BlueZ needs), trusts and connects. */
  private async pair(device: string): Promise<null> {
    this.pairing.add(device);
    this.schedule();
    try {
      await this.bluez(device, DEVICE, "Pair", "", [], 90_000);
    } finally {
      this.pairing.delete(device);
      this.asking.get(device)?.abort();
      this.schedule();
    }
    await setProperty(this.bus!, BLUEZ, device, DEVICE, "Trusted", ["b", true]);
    // Most devices connect as they pair; the rest now.
    if (this.objects.get(device)?.get(DEVICE)?.get("Connected") !== true) {
      await this.bluez(device, DEVICE, "Connect", "", [], 30_000).catch(() => {});
    }
    return null;
  }

  // The agent (org.bluez.Agent1), for the pairings this service starts.

  private async onAgentCall(message: Message): Promise<Reply> {
    if (message.path !== AGENT_PATH || message.interface !== AGENT) {
      throw new DBusError("org.freedesktop.DBus.Error.UnknownMethod", `No such method ${message.member}`);
    }
    const [device, value, entered] = (message.body ?? []) as [string, unknown, number];
    const name = String(this.objects.get(device)?.get(DEVICE)?.get("Alias") ?? "the device");
    const code = (number: unknown) => String(number).padStart(6, "0");
    switch (message.member) {
      case "Release":
        return {};
      case "Cancel":
        for (const controller of this.asking.values()) controller.abort();
        return {};
      case "RequestPinCode": {
        const values = await this.ask(device, "pin", {
          title: `Pair with ${name}`,
          message: "Enter the PIN for the device (often 0000 or 1234, or the one it shows).",
          fields: [{ name: "pin", label: "PIN", type: "text" }],
          acceptLabel: "Pair",
        });
        return { signature: "s", body: [String(values.pin ?? "")] };
      }
      case "RequestPasskey": {
        const values = await this.ask(device, "passkey", {
          title: `Pair with ${name}`,
          message: "Enter the passkey the device shows.",
          fields: [{ name: "passkey", label: "Passkey", type: "number" }],
          acceptLabel: "Pair",
        });
        return { signature: "u", body: [Number(values.passkey ?? 0) >>> 0] };
      }
      case "DisplayPinCode":
      case "DisplayPasskey": {
        // Shown until the pairing ends; the user's "Cancel" cancels it. Called again as keys
        // are typed on the device: the code stays up.
        if (this.asking.has(device)) return {};
        const shown = message.member === "DisplayPinCode" ? String(value) : code(value);
        this.ask(device, "display", {
          title: `Pair with ${name}`,
          message: "Type this code on the device, then press Enter.",
          code: shown,
          entered: entered ?? 0,
        }).catch((error: unknown) => {
          // The user's "Cancel" (not the pairing ending, which takes the code back).
          if (error instanceof DBusError && error.errorName.endsWith("Rejected")) {
            this.bluez(device, DEVICE, "CancelPairing").catch(() => {});
          }
        });
        return {};
      }
      case "RequestConfirmation":
        await this.ask(device, "confirm", {
          title: `Pair with ${name}?`,
          message: "Check that the device shows the same code.",
          code: code(value),
          acceptLabel: "Pair",
        });
        return {};
      case "RequestAuthorization":
        await this.ask(device, "confirm", { title: `Pair with ${name}?`, message: `${name} asks to pair.`, acceptLabel: "Pair" });
        return {};
      case "AuthorizeService":
        // Only for the devices this agent pairs: a paired one may use its services.
        if (this.objects.get(device)?.get(DEVICE)?.get("Paired") === true) return {};
        throw new DBusError("org.bluez.Error.Rejected", "Not paired.");
      default:
        throw new DBusError("org.freedesktop.DBus.Error.UnknownMethod", `No such method ${message.member}`);
    }
  }

  /** Asks the shell for `device`; throws BlueZ's Rejected (the user said no) or Canceled. */
  private async ask(device: string, kind: string, detail: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.options.ask) throw new DBusError("org.bluez.Error.Canceled", "No shell to ask.");
    this.asking.get(device)?.abort();
    const controller = new AbortController();
    this.asking.set(device, controller);
    const name = String(this.objects.get(device)?.get(DEVICE)?.get("Alias") ?? "");
    try {
      const values = await this.options.ask(kind, { ...detail, device, name }, controller.signal);
      if (controller.signal.aborted || values === undefined) throw new DBusError("org.bluez.Error.Canceled", "Canceled.");
      if (values === null) throw new DBusError("org.bluez.Error.Rejected", "The user said no.");
      return values;
    } finally {
      if (this.asking.get(device) === controller) this.asking.delete(device);
    }
  }
}

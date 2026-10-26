// A fake BlueZ on a FakeBus, for the Bluetooth service: an adapter, devices,
// ObjectManager and PropertiesChanged signals as BlueZ sends them, and
// pairing that calls the agent the service registered (`pairWith` says
// which agent method). The calls it got are in `log`.
import type { Message, Variant } from "../../src/dbus.ts";
import type { FakeBus, Reply } from "./fakeBus.ts";

const BLUEZ = "org.bluez";
const PROPERTIES = "org.freedesktop.DBus.Properties";
const OBJECT_MANAGER = "org.freedesktop.DBus.ObjectManager";
export const ADAPTER_PATH = "/org/bluez/hci0";

type Props = Record<string, Variant>;

const ok = (signature = "", body: unknown[] = []): Reply => ({ signature, body });

export interface FakeDevice {
  address: string;
  name?: string;
  icon?: string;
  paired?: boolean;
  connected?: boolean;
  battery?: number;
  /** What pairing asks the agent: "RequestConfirmation" (the default), "RequestPinCode", "DisplayPasskey"… */
  pairWith?: string;
}

export class FakeBluez {
  readonly log: string[] = [];
  agent: { sender: string; path: string; capability: string } | null = null;
  /** The agent's last reply to a pairing. */
  lastAgentReply: Message | null = null;
  private readonly bus: FakeBus;
  private readonly objects = new Map<string, Record<string, Props>>();
  private readonly pairWith = new Map<string, string>();
  /** A pairing waiting on CancelPairing (DisplayPasskey). */
  private waiting: ((reply: Reply) => void) | null = null;
  /** CancelPairing came before the pairing waited. */
  private canceled = false;

  constructor(bus: FakeBus) {
    this.bus = bus;
    this.objects.set(ADAPTER_PATH, {
      "org.bluez.Adapter1": {
        Address: ["s", "00:11:22:33:44:55"],
        Name: ["s", "laptop"],
        Alias: ["s", "laptop"],
        Powered: ["b", true],
        Discovering: ["b", false],
        Discoverable: ["b", false],
      },
    });
  }

  start(): void {
    this.bus.own(BLUEZ, (message, sender) => this.handle(message, sender));
  }

  /** A device, with InterfacesAdded; its path. */
  addDevice(device: FakeDevice): string {
    const path = `${ADAPTER_PATH}/dev_${device.address.replaceAll(":", "_")}`;
    const interfaces: Record<string, Props> = {
      "org.bluez.Device1": {
        Address: ["s", device.address],
        ...(device.name ? { Name: ["s", device.name], Alias: ["s", device.name] } : { Alias: ["s", device.address.replaceAll(":", "-")] }),
        Icon: ["s", device.icon ?? ""],
        Paired: ["b", device.paired ?? false],
        Trusted: ["b", device.paired ?? false],
        Connected: ["b", device.connected ?? false],
        Adapter: ["o", ADAPTER_PATH],
      },
      ...(device.battery !== undefined ? { "org.bluez.Battery1": { Percentage: ["y", device.battery] } } : {}),
    };
    this.objects.set(path, interfaces);
    this.pairWith.set(path, device.pairWith ?? "RequestConfirmation");
    this.bus.signal(BLUEZ, "/", OBJECT_MANAGER, "InterfacesAdded", "oa{sa{sv}}", [path, interfaces]);
    return path;
  }

  set(path: string, iface: string, changes: Props): void {
    Object.assign(this.objects.get(path)![iface]!, changes);
    this.bus.signal(BLUEZ, path, PROPERTIES, "PropertiesChanged", "sa{sv}as", [iface, changes, []]);
  }

  private async handle(message: Message, sender: string): Promise<Reply> {
    const body = (message.body ?? []) as unknown[];
    const path = message.path ?? "";
    const method = `${message.interface}.${message.member}`;
    switch (method) {
      case `${OBJECT_MANAGER}.GetManagedObjects`:
        return ok("a{oa{sa{sv}}}", [Object.fromEntries(this.objects)]);
      case `${PROPERTIES}.Set`: {
        const [iface, name, value] = body as [string, string, unknown];
        this.log.push(`Set ${path} ${name} ${value}`);
        this.set(path, iface, { [name]: ["b", value] });
        return ok();
      }
      case "org.bluez.AgentManager1.RegisterAgent":
        this.agent = { sender, path: String(body[0]), capability: String(body[1]) };
        return ok();
      case "org.bluez.Adapter1.StartDiscovery":
      case "org.bluez.Adapter1.StopDiscovery":
        this.log.push(String(message.member));
        this.set(ADAPTER_PATH, "org.bluez.Adapter1", { Discovering: ["b", message.member === "StartDiscovery"] });
        return ok();
      case "org.bluez.Adapter1.RemoveDevice": {
        const [device] = body as string[];
        this.log.push(`RemoveDevice ${device}`);
        this.objects.delete(device!);
        this.bus.signal(BLUEZ, "/", OBJECT_MANAGER, "InterfacesRemoved", "oas", [
          device,
          ["org.bluez.Device1", "org.freedesktop.DBus.Properties"],
        ]);
        return ok();
      }
      case "org.bluez.Device1.Connect":
      case "org.bluez.Device1.Disconnect":
        this.log.push(`${message.member} ${path}`);
        this.set(path, "org.bluez.Device1", { Connected: ["b", message.member === "Connect"] });
        return ok();
      case "org.bluez.Device1.CancelPairing":
        this.log.push(`CancelPairing ${path}`);
        if (this.waiting) this.waiting({ error: "org.bluez.Error.AuthenticationCanceled", message: "Authentication Canceled" });
        else this.canceled = true;
        return ok();
      case "org.bluez.Device1.Pair":
        return this.pair(path);
      default:
        return { error: "org.freedesktop.DBus.Error.UnknownMethod", message: method };
    }
  }

  private async pair(path: string): Promise<Reply> {
    this.log.push(`Pair ${path}`);
    const how = this.pairWith.get(path)!;
    const call = (member: string, signature: string, body: unknown[]) =>
      this.bus.callClient(this.agent!.sender, { path: this.agent!.path, interface: "org.bluez.Agent1", member, signature, body });
    let reply: Message;
    if (how === "DisplayPasskey") {
      reply = await call(how, "ouq", [path, 1234, 0]);
      // Pairs when the test says, or not when the user cancels.
      const result = this.canceled
        ? { error: "org.bluez.Error.AuthenticationCanceled", message: "Authentication Canceled" }
        : await new Promise<Reply>((resolve) => (this.waiting = resolve));
      this.canceled = false;
      this.waiting = null;
      if ("error" in result) return result;
    } else {
      const args: Record<string, [string, unknown[]]> = {
        RequestConfirmation: ["ou", [path, 987654]],
        RequestPinCode: ["o", [path]],
        RequestPasskey: ["o", [path]],
        RequestAuthorization: ["o", [path]],
      };
      const [signature, body] = args[how]!;
      reply = await call(how, signature, body);
      this.lastAgentReply = reply;
      if (reply.type === 3) return { error: "org.bluez.Error.AuthenticationRejected", message: "Authentication Rejected" };
      this.log.push(`agent ${how} → ${JSON.stringify(reply.body ?? [])}`);
    }
    this.set(path, "org.bluez.Device1", { Paired: ["b", true] });
    return ok();
  }

  /** The DisplayPasskey pairing finishes (the user typed the code on the device). */
  typed(): void {
    this.waiting?.({ signature: "", body: [] });
  }
}

// A D-Bus bus in-process, speaking the wire protocol through dbus.ts's own
// encoder: the session bus (it names itself as the accessibility bus too) and
// AT-SPI apps on it, for a11y.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeMessage, encodeMessage, ERROR, METHOD_CALL, METHOD_RETURN, messageLength, type Message } from "../../src/dbus.ts";

export type Reply = { signature: string; body: unknown[] } | { error: string; message?: string };

const ACCESSIBLE = "org.a11y.atspi.Accessible";
const PROPERTIES = "org.freedesktop.DBus.Properties";
const ROOT_PATH = "/org/a11y/atspi/accessible/root";
const REGISTRY = "org.a11y.atspi.Registry";

/** AtspiStateType bits (a11y.ts's STATE). */
export const STATE = {
  active: 1,
  checked: 4,
  editable: 7,
  enabled: 8,
  focused: 12,
  sensitive: 24,
  showing: 25,
  checkable: 41,
} as const;

/** An element of a fake app's tree. */
export interface FakeNode {
  role: string;
  name?: string;
  description?: string;
  states?: number[];
  extents?: [number, number, number, number];
  text?: string;
  editable?: boolean;
  value?: { current: number; min: number; max: number };
  actions?: string[];
  children?: FakeNode[];
  /** What the app did, in order: "DoAction click", "SetTextContents hi", … */
  log?: string[];
}

interface Placed {
  readonly node: FakeNode;
  readonly bus: string;
  readonly path: string;
  readonly parent?: Placed;
  readonly index: number;
  readonly children: Placed[];
}

// Role numbers, stable per name (a11y.ts caches role names by number).
const ROLES = new Map<string, number>();
const roleNumber = (name: string) => {
  if (!ROLES.has(name)) ROLES.set(name, ROLES.size + 1);
  return ROLES.get(name)!;
};

function stateWords(bits: readonly number[] = []): number[] {
  const words = [0, 0];
  for (const bit of bits) words[bit >> 5]! |= 1 << (bit & 31);
  return words.map((word) => word >>> 0);
}

export class FakeBus {
  readonly address: string;
  /** Every method call the bus got. */
  readonly calls: Message[] = [];
  private readonly dir: string;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly objects = new Map<string, Placed>();
  private readonly apps: Placed[] = [];
  private readonly pids = new Map<string, number>();
  private nextName = 1;

  private constructor(dir: string, server: Server) {
    this.dir = dir;
    this.server = server;
    this.address = `unix:path=${join(dir, "bus")}`;
  }

  static async start(): Promise<FakeBus> {
    const dir = mkdtempSync(join(tmpdir(), "plutonium-bus-"));
    const server = createServer();
    const bus = new FakeBus(dir, server);
    server.on("connection", (socket) => bus.serve(socket));
    await new Promise<void>((resolve) => server.listen(join(dir, "bus"), resolve));
    return bus;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** Puts an app (its frames as `windows`) on the bus as process `pid`. */
  addApp(pid: number, windows: FakeNode[]): string {
    const bus = `:1.${100 + this.apps.length}`;
    this.pids.set(bus, pid);
    let counter = 0;
    const place = (node: FakeNode, path: string, index: number, parent?: Placed): Placed => {
      const placed: Placed = { node, bus, path, parent, index, children: [] };
      this.objects.set(`${bus}${path}`, placed);
      (node.children ?? []).forEach((child, at) =>
        placed.children.push(place(child, `/org/a11y/atspi/accessible/${++counter}`, at, placed)),
      );
      return placed;
    };
    const app = place({ role: "application", name: `app ${pid}`, children: windows }, ROOT_PATH, this.apps.length);
    this.apps.push(app);
    return bus;
  }

  private serve(socket: Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    const name = `:1.${this.nextName++}`;
    let authenticated = false;
    let input: Buffer = Buffer.alloc(0);
    socket.on("data", (data: Buffer) => {
      input = input.length ? Buffer.concat([input, data]) : data;
      // SASL lines until BEGIN; messages after it.
      while (!authenticated) {
        const end = input.indexOf("\r\n");
        if (end < 0) return;
        const line = input.subarray(0, end).toString("latin1").replace(/^\0/, "");
        input = input.subarray(end + 2);
        if (line.startsWith("AUTH ")) socket.write("OK 0123456789abcdef0123456789abcdef\r\n");
        else if (line === "BEGIN") authenticated = true;
      }
      for (;;) {
        const length = messageLength(input);
        if (length === undefined || input.length < length) return;
        const message = decodeMessage(input.subarray(0, length));
        input = input.subarray(length);
        if (message.type === METHOD_CALL) this.answer(socket, name, message);
      }
    });
  }

  private answer(socket: Socket, sender: string, message: Message): void {
    this.calls.push(message);
    let reply: Reply;
    try {
      reply = this.dispatch(sender, message);
    } catch (error) {
      reply = { error: "org.freedesktop.DBus.Error.Failed", message: (error as Error).message };
    }
    const common = { serial: 1, replySerial: message.serial, destination: sender, sender: "org.freedesktop.DBus" };
    socket.write(
      "error" in reply
        ? encodeMessage({ ...common, type: ERROR, errorName: reply.error, signature: "s", body: [reply.message ?? ""] })
        : encodeMessage({ ...common, type: METHOD_RETURN, signature: reply.signature, body: reply.body }),
    );
  }

  private dispatch(sender: string, message: Message): Reply {
    const { interface: iface, member, body = [] } = message;
    if (message.destination === "org.freedesktop.DBus") {
      if (member === "Hello") return { signature: "s", body: [sender] };
      if (member === "GetConnectionUnixProcessID") {
        const pid = this.pids.get(String(body[0]));
        return pid === undefined ? { error: "org.freedesktop.DBus.Error.NameHasNoOwner" } : { signature: "u", body: [pid] };
      }
    }
    if (iface === "org.a11y.Bus" && member === "GetAddress") return { signature: "s", body: [this.address] };
    if (message.destination === REGISTRY && message.path === ROOT_PATH) {
      if (member === "GetChildren") return { signature: "a(so)", body: [this.apps.map((app) => [app.bus, app.path])] };
      return { error: "org.freedesktop.DBus.Error.UnknownMethod" };
    }
    const placed = this.objects.get(`${message.destination}${message.path}`);
    if (!placed) return { error: "org.freedesktop.DBus.Error.UnknownObject", message: `No ${message.path}` };
    return this.element(placed, `${iface}.${member}`, body);
  }

  private element(placed: Placed, method: string, body: readonly unknown[]): Reply {
    const { node } = placed;
    const log = (entry: string) => (node.log ??= []).push(entry);
    const interfaces = [
      ACCESSIBLE,
      "org.a11y.atspi.Component",
      ...(node.text !== undefined ? ["org.a11y.atspi.Text"] : []),
      ...(node.editable ? ["org.a11y.atspi.EditableText"] : []),
      ...(node.value ? ["org.a11y.atspi.Value"] : []),
      ...(node.actions ? ["org.a11y.atspi.Action"] : []),
    ];
    switch (method) {
      case `${ACCESSIBLE}.GetChildren`:
        return { signature: "a(so)", body: [placed.children.map((child) => [child.bus, child.path])] };
      case `${ACCESSIBLE}.GetRole`:
        return { signature: "u", body: [roleNumber(node.role)] };
      case `${ACCESSIBLE}.GetRoleName`:
        return { signature: "s", body: [node.role] };
      case `${ACCESSIBLE}.GetState`:
        return { signature: "au", body: [stateWords(node.states)] };
      case `${ACCESSIBLE}.GetInterfaces`:
        return { signature: "as", body: [interfaces] };
      case `${ACCESSIBLE}.GetIndexInParent`:
        return { signature: "i", body: [placed.index] };
      case `${PROPERTIES}.Get`: {
        const [on, name] = body as [string, string];
        if (on === ACCESSIBLE && name === "Name") return { signature: "v", body: [["s", node.name ?? ""]] };
        if (on === ACCESSIBLE && name === "Parent") {
          const parent = placed.parent;
          return { signature: "v", body: [["(so)", parent ? [parent.bus, parent.path] : ["", "/org/a11y/atspi/null"]]] };
        }
        if (on === "org.a11y.atspi.Text" && name === "CharacterCount") {
          return { signature: "v", body: [["i", node.text?.length ?? 0]] };
        }
        return { error: "org.freedesktop.DBus.Error.UnknownProperty" };
      }
      case `${PROPERTIES}.GetAll`: {
        const [on] = body as [string];
        if (on === ACCESSIBLE) {
          return {
            signature: "a{sv}",
            body: [
              new Map<string, unknown>([
                ["Name", ["s", node.name ?? ""]],
                ["Description", ["s", node.description ?? ""]],
                ["ChildCount", ["i", placed.children.length]],
              ]),
            ],
          };
        }
        if (on === "org.a11y.atspi.Value" && node.value) {
          return {
            signature: "a{sv}",
            body: [
              new Map<string, unknown>([
                ["CurrentValue", ["d", node.value.current]],
                ["MinimumValue", ["d", node.value.min]],
                ["MaximumValue", ["d", node.value.max]],
              ]),
            ],
          };
        }
        return { signature: "a{sv}", body: [new Map()] };
      }
      case `${PROPERTIES}.Set`: {
        // The variant arrives as its value.
        const [on, name, value] = body as [string, string, number];
        if (on === "org.a11y.atspi.Value" && name === "CurrentValue" && node.value) {
          node.value.current = value;
          log(`SetValue ${value}`);
          return { signature: "", body: [] };
        }
        return { error: "org.freedesktop.DBus.Error.PropertyReadOnly" };
      }
      case "org.a11y.atspi.Component.GetExtents":
        return { signature: "(iiii)", body: [node.extents ?? [0, 0, 0, 0]] };
      case "org.a11y.atspi.Component.GrabFocus":
        log("GrabFocus");
        return { signature: "b", body: [true] };
      case "org.a11y.atspi.Text.GetText": {
        const [start, end] = body as [number, number];
        return { signature: "s", body: [(node.text ?? "").slice(start, end)] };
      }
      case "org.a11y.atspi.EditableText.SetTextContents":
        node.text = String(body[0]);
        log(`SetTextContents ${node.text}`);
        return { signature: "b", body: [true] };
      case "org.a11y.atspi.Action.GetActions":
        return { signature: "a(sss)", body: [(node.actions ?? []).map((name) => [name, "", ""])] };
      case "org.a11y.atspi.Action.DoAction":
        log(`DoAction ${node.actions?.[Number(body[0])]}`);
        return { signature: "b", body: [true] };
      default:
        return { error: "org.freedesktop.DBus.Error.UnknownMethod", message: method };
    }
  }
}


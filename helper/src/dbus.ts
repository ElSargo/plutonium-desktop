// A small D-Bus client: method calls over a bus connection, for AT-SPI
// (a11y.ts). Authenticates as the user (EXTERNAL), marshals the basic and
// container types, and matches replies to calls. It can also serve method
// calls and send signals, for the portal backend (portal.ts), and hand the
// signals it gets (after an AddMatch) to onSignal. No fds.
import { createConnection, type Socket } from "node:net";
import { userInfo } from "node:os";

/** A variant's value with its signature (as sent: `["d", 0.5]`). */
export type Variant = readonly [signature: string, value: unknown];

export const METHOD_CALL = 1;
export const METHOD_RETURN = 2;
export const ERROR = 3;
export const SIGNAL = 4;

const FIELD = {
  path: 1,
  interface: 2,
  member: 3,
  errorName: 4,
  replySerial: 5,
  destination: 6,
  sender: 7,
  signature: 8,
} as const;

/** One message, as encodeMessage takes it and decodeMessage gives it. */
export interface Message {
  readonly type: number;
  readonly serial: number;
  readonly path?: string;
  readonly interface?: string;
  readonly member?: string;
  readonly errorName?: string;
  readonly replySerial?: number;
  readonly destination?: string;
  readonly sender?: string;
  readonly signature?: string;
  readonly body?: readonly unknown[];
}

const FIELD_TYPES: Record<keyof typeof FIELD, string> = {
  path: "o",
  interface: "s",
  member: "s",
  errorName: "s",
  replySerial: "u",
  destination: "s",
  sender: "s",
  signature: "g",
};

const ALIGN: Record<string, number> = {
  y: 1, b: 4, n: 2, q: 2, i: 4, u: 4, x: 8, t: 8, d: 8, s: 4, o: 4, g: 1, a: 4, "(": 8, "{": 8, v: 1, h: 4,
};

/** The complete types in `signature`. */
export function splitSignature(signature: string): string[] {
  const types: string[] = [];
  let i = 0;
  while (i < signature.length) {
    const end = completeTypeEnd(signature, i);
    types.push(signature.slice(i, end));
    i = end;
  }
  return types;
}

function completeTypeEnd(signature: string, start: number): number {
  const char = signature[start];
  if (char === "a") return completeTypeEnd(signature, start + 1);
  if (char === "(" || char === "{") {
    const close = char === "(" ? ")" : "}";
    let i = start + 1;
    while (signature[i] !== close) {
      if (i >= signature.length) throw new Error(`Bad signature ${signature}`);
      i = completeTypeEnd(signature, i);
    }
    return i + 1;
  }
  if (!char || !(char in ALIGN)) throw new Error(`Bad signature ${signature}`);
  return start + 1;
}

class Writer {
  private chunks: Buffer[] = [];
  length = 0;

  private push(buffer: Buffer): void {
    this.chunks.push(buffer);
    this.length += buffer.length;
  }

  align(n: number): void {
    const pad = (n - (this.length % n)) % n;
    if (pad) this.push(Buffer.alloc(pad));
  }

  private number(size: number, write: (buffer: Buffer) => void, align = size): void {
    this.align(align);
    const buffer = Buffer.alloc(size);
    write(buffer);
    this.push(buffer);
  }

  write(type: string, value: unknown): void {
    switch (type[0]) {
      case "y":
        return this.number(1, (b) => b.writeUInt8(Number(value)));
      case "b":
        return this.number(4, (b) => b.writeUInt32LE(value ? 1 : 0));
      case "n":
        return this.number(2, (b) => b.writeInt16LE(Number(value)));
      case "q":
        return this.number(2, (b) => b.writeUInt16LE(Number(value)));
      case "i":
      case "h":
        return this.number(4, (b) => b.writeInt32LE(Number(value)));
      case "u":
        return this.number(4, (b) => b.writeUInt32LE(Number(value)));
      case "x":
        return this.number(8, (b) => b.writeBigInt64LE(BigInt(value as number)));
      case "t":
        return this.number(8, (b) => b.writeBigUInt64LE(BigInt(value as number)));
      case "d":
        return this.number(8, (b) => b.writeDoubleLE(Number(value)));
      case "s":
      case "o": {
        const text = Buffer.from(String(value), "utf8");
        this.number(4, (b) => b.writeUInt32LE(text.length));
        this.push(Buffer.concat([text, Buffer.alloc(1)]));
        return;
      }
      case "g": {
        const text = Buffer.from(String(value), "utf8");
        this.push(Buffer.concat([Buffer.from([text.length]), text, Buffer.alloc(1)]));
        return;
      }
      case "v": {
        const [signature, inner] = value as Variant;
        this.write("g", signature);
        this.write(signature, inner);
        return;
      }
      case "(": {
        this.align(8);
        const fields = splitSignature(type.slice(1, -1));
        const values = value as readonly unknown[];
        fields.forEach((field, index) => this.write(field, values[index]));
        return;
      }
      case "a": {
        const element = type.slice(1);
        this.align(4);
        const lengthAt = this.chunks.length;
        this.push(Buffer.alloc(4));
        this.align(ALIGN[element[0]!]!);
        const start = this.length;
        if (element[0] === "{") {
          const [keyType, valueType] = splitSignature(element.slice(1, -1));
          const entries = value instanceof Map ? [...value] : Object.entries(value as object);
          for (const [key, entry] of entries) {
            this.align(8);
            this.write(keyType!, key);
            this.write(valueType!, entry);
          }
        } else {
          for (const item of value as readonly unknown[]) this.write(element, item);
        }
        this.chunks[lengthAt]!.writeUInt32LE(this.length - start);
        return;
      }
      default:
        throw new Error(`Can't write ${type}`);
    }
  }

  buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

class Reader {
  offset: number;
  private readonly buffer: Buffer;
  private readonly little: boolean;
  /** Where alignment counts from (the message start). */
  private readonly base: number;
  constructor(buffer: Buffer, little: boolean, offset = 0, base = 0) {
    this.buffer = buffer;
    this.little = little;
    this.offset = offset;
    this.base = base;
  }

  align(n: number): void {
    const relative = this.offset - this.base;
    this.offset += (n - (relative % n)) % n;
  }

  private u32(): number {
    this.align(4);
    const value = this.little ? this.buffer.readUInt32LE(this.offset) : this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  read(type: string): unknown {
    const b = this.buffer;
    const le = this.little;
    switch (type[0]) {
      case "y":
        return b.readUInt8(this.offset++);
      case "b":
        return this.u32() !== 0;
      case "n": {
        this.align(2);
        const value = le ? b.readInt16LE(this.offset) : b.readInt16BE(this.offset);
        this.offset += 2;
        return value;
      }
      case "q": {
        this.align(2);
        const value = le ? b.readUInt16LE(this.offset) : b.readUInt16BE(this.offset);
        this.offset += 2;
        return value;
      }
      case "i":
      case "h": {
        this.align(4);
        const value = le ? b.readInt32LE(this.offset) : b.readInt32BE(this.offset);
        this.offset += 4;
        return value;
      }
      case "u":
        return this.u32();
      case "x":
      case "t": {
        this.align(8);
        const value =
          type[0] === "x"
            ? le ? b.readBigInt64LE(this.offset) : b.readBigInt64BE(this.offset)
            : le ? b.readBigUInt64LE(this.offset) : b.readBigUInt64BE(this.offset);
        this.offset += 8;
        return Number(value);
      }
      case "d": {
        this.align(8);
        const value = le ? b.readDoubleLE(this.offset) : b.readDoubleBE(this.offset);
        this.offset += 8;
        return value;
      }
      case "s":
      case "o": {
        const length = this.u32();
        const value = b.toString("utf8", this.offset, this.offset + length);
        this.offset += length + 1;
        return value;
      }
      case "g": {
        const length = b.readUInt8(this.offset++);
        const value = b.toString("utf8", this.offset, this.offset + length);
        this.offset += length + 1;
        return value;
      }
      case "v": {
        const signature = this.read("g") as string;
        return this.read(signature);
      }
      case "(": {
        this.align(8);
        return splitSignature(type.slice(1, -1)).map((field) => this.read(field));
      }
      case "a": {
        const element = type.slice(1);
        const length = this.u32();
        this.align(ALIGN[element[0]!]!);
        const end = this.offset + length;
        if (element[0] === "{") {
          const [keyType, valueType] = splitSignature(element.slice(1, -1));
          const map = new Map<unknown, unknown>();
          while (this.offset < end) {
            this.align(8);
            const key = this.read(keyType!);
            map.set(key, this.read(valueType!));
          }
          return map;
        }
        const items: unknown[] = [];
        while (this.offset < end) items.push(this.read(element));
        return items;
      }
      default:
        throw new Error(`Can't read ${type}`);
    }
  }
}

export class DBusError extends Error {
  readonly errorName: string;
  constructor(errorName: string, message: string) {
    super(message || errorName);
    this.errorName = errorName;
  }
}

interface Pending {
  readonly resolve: (values: unknown[]) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** What a served method call returns: its reply's signature and values. */
export interface Reply {
  readonly signature?: string;
  readonly body?: readonly unknown[];
}

/** Serves an incoming method call; throw a DBusError to answer with that error. */
export type CallHandler = (message: Message) => Reply | Promise<Reply>;

export interface Call {
  readonly destination: string;
  readonly path: string;
  readonly interface: string;
  readonly member: string;
  readonly signature?: string;
  readonly body?: readonly unknown[];
  /** Default 5 s. */
  readonly timeoutMs?: number;
}

/** The socket path of a D-Bus address ("unix:path=…", "unix:abstract=…"). */
function socketPathOf(address: string): string {
  for (const transport of address.split(";")) {
    const [kind, rest = ""] = transport.split(/:(.*)/s);
    if (kind !== "unix") continue;
    const options = new Map(rest.split(",").map((pair) => pair.split("=") as [string, string]));
    const unescape = (value: string) => decodeURIComponent(value);
    if (options.has("path")) return unescape(options.get("path")!);
    if (options.has("abstract")) return `\0${unescape(options.get("abstract")!)}`;
  }
  throw new Error(`No unix transport in D-Bus address ${address}`);
}

/** One connection to a bus. */
export class DBusConnection {
  private serial = 1;
  private readonly pending = new Map<number, Pending>();
  private input: Buffer = Buffer.alloc(0);
  private closed: Error | null = null;
  /** Our unique name on the bus. */
  name = "";
  /** Serves the method calls that come in; without one, they get UnknownMethod. */
  onCall: CallHandler | null = null;
  /** Signals that come in (the bus sends only those matched with AddMatch). */
  onSignal: ((message: Message) => void) | null = null;

  private readonly socket: Socket;

  private constructor(socket: Socket) {
    this.socket = socket;
  }

  /** Connects to `address`, authenticates and says Hello. */
  static async connect(address: string): Promise<DBusConnection> {
    const socket = createConnection(socketPathOf(address));
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    // SASL: EXTERNAL, as our uid.
    const uid = Buffer.from(String(userInfo().uid)).toString("hex");
    socket.write(`\0AUTH EXTERNAL ${uid}\r\n`);
    const answer = await new Promise<string>((resolve, reject) => {
      let text = "";
      const onData = (data: Buffer) => {
        text += data.toString("latin1");
        if (text.includes("\r\n")) {
          socket.off("data", onData);
          resolve(text);
        }
      };
      socket.on("data", onData);
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("The bus closed the connection.")));
    });
    if (!answer.startsWith("OK ")) {
      socket.destroy();
      throw new Error(`The bus refused us: ${answer.trim()}`);
    }
    socket.write("BEGIN\r\n");
    const connection = new DBusConnection(socket);
    socket.on("data", (data: Buffer) => connection.onData(data));
    const fail = (error: Error) => connection.fail(error);
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("The bus connection closed.")));
    [connection.name] = (await connection.call({
      destination: "org.freedesktop.DBus",
      path: "/org/freedesktop/DBus",
      interface: "org.freedesktop.DBus",
      member: "Hello",
    })) as [string];
    return connection;
  }

  get isOpen(): boolean {
    return this.closed === null;
  }

  close(): void {
    this.socket.destroy();
  }

  /** Calls a method; resolves to its return values. */
  call(call: Call): Promise<unknown[]> {
    if (this.closed) return Promise.reject(this.closed);
    const serial = this.serial++;
    this.socket.write(
      encodeMessage({
        type: METHOD_CALL,
        serial,
        path: call.path,
        interface: call.interface,
        member: call.member,
        destination: call.destination,
        signature: call.signature ?? "",
        body: call.body ?? [],
      }),
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(serial);
        reject(new Error(`${call.interface}.${call.member} timed out.`));
      }, call.timeoutMs ?? 5_000);
      this.pending.set(serial, { resolve, reject, timer });
    });
  }

  /** Sends a signal. */
  emit(path: string, iface: string, member: string, signature = "", body: readonly unknown[] = []): void {
    if (this.closed) return;
    this.socket.write(
      encodeMessage({ type: SIGNAL, serial: this.serial++, path, interface: iface, member, signature, body }),
    );
  }

  private send(message: Omit<Message, "serial">): void {
    if (this.closed) return;
    this.socket.write(encodeMessage({ ...message, serial: this.serial++ }));
  }

  private async serve(message: Message): Promise<void> {
    const answer = (reply: Reply) =>
      this.send({
        type: METHOD_RETURN,
        replySerial: message.serial,
        destination: message.sender,
        signature: reply.signature ?? "",
        body: reply.body ?? [],
      });
    const refuse = (errorName: string, text: string) =>
      this.send({
        type: ERROR,
        replySerial: message.serial,
        destination: message.sender,
        errorName,
        signature: "s",
        body: [text],
      });
    if (!this.onCall) {
      refuse("org.freedesktop.DBus.Error.UnknownMethod", `No such method ${message.interface}.${message.member}`);
      return;
    }
    try {
      answer(await this.onCall(message));
    } catch (error) {
      if (error instanceof DBusError) refuse(error.errorName, error.message);
      else refuse("org.freedesktop.DBus.Error.Failed", String((error as Error)?.message ?? error));
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private onData(data: Buffer): void {
    this.input = this.input.length ? Buffer.concat([this.input, data]) : data;
    for (;;) {
      const total = messageLength(this.input);
      if (total === undefined || this.input.length < total) return;
      const message = this.input.subarray(0, total);
      this.input = this.input.subarray(total);
      try {
        this.onMessage(decodeMessage(message));
      } catch (error) {
        console.warn(`dbus: a message we couldn't read: ${(error as Error).message}`);
      }
    }
  }

  private onMessage(message: Message): void {
    if (message.type === METHOD_CALL) {
      void this.serve(message);
      return;
    }
    if (message.type === SIGNAL) {
      this.onSignal?.(message);
      return;
    }
    if (message.type !== METHOD_RETURN && message.type !== ERROR) return;
    const serial = message.replySerial;
    const pending = serial === undefined ? undefined : this.pending.get(serial);
    if (!pending) return;
    this.pending.delete(serial!);
    clearTimeout(pending.timer);
    const values = message.body ?? [];
    if (message.type === ERROR) {
      pending.reject(new DBusError(String(message.errorName), typeof values[0] === "string" ? values[0] : ""));
    } else {
      pending.resolve([...values]);
    }
  }
}

/** A whole message (little-endian), header and body. */
export function encodeMessage(message: Message): Buffer {
  const body = new Writer();
  const signature = message.signature ?? "";
  splitSignature(signature).forEach((type, index) => body.write(type, message.body?.[index]));
  const bodyBuffer = body.buffer();
  const fields: [number, Variant][] = [];
  for (const [name, code] of Object.entries(FIELD) as [keyof typeof FIELD, number][]) {
    const value = name === "signature" ? signature || undefined : message[name];
    if (value !== undefined) fields.push([code, [FIELD_TYPES[name], value]]);
  }
  const header = new Writer();
  header.write("y", "l".charCodeAt(0));
  header.write("y", message.type);
  header.write("y", 0);
  header.write("y", 1);
  header.write("u", bodyBuffer.length);
  header.write("u", message.serial);
  header.write("a(yv)", fields);
  header.align(8);
  return Buffer.concat([header.buffer(), bodyBuffer]);
}

/** The length of the message `input` starts with, once its fixed header is in. */
export function messageLength(input: Buffer): number | undefined {
  if (input.length < 16) return undefined;
  const little = input[0] === "l".charCodeAt(0);
  const u32 = (at: number) => (little ? input.readUInt32LE(at) : input.readUInt32BE(at));
  const fieldsLength = u32(12);
  return 16 + fieldsLength + ((8 - ((16 + fieldsLength) % 8)) % 8) + u32(4);
}

/** A whole message, as encodeMessage made it (either byte order). */
export function decodeMessage(buffer: Buffer): Message {
  const little = buffer[0] === "l".charCodeAt(0);
  const u32 = (at: number) => (little ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at));
  const fieldsLength = u32(12);
  const headerLength = 16 + fieldsLength + ((8 - ((16 + fieldsLength) % 8)) % 8);
  const fields = new Reader(buffer, little, 12).read("a(yv)") as [number, unknown][];
  const field = (code: number) => fields.find(([key]) => key === code)?.[1];
  const signature = (field(FIELD.signature) as string | undefined) ?? "";
  const reader = new Reader(buffer, little, headerLength, headerLength);
  const message: Record<string, unknown> = {
    type: buffer[1],
    serial: u32(8),
    body: splitSignature(signature).map((part) => reader.read(part)),
  };
  for (const [name, code] of Object.entries(FIELD)) {
    const value = field(code);
    if (value !== undefined) message[name] = value;
  }
  return message as unknown as Message;
}

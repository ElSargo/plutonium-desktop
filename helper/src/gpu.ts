// Whether Exo lets apps render on the GPU. Mesa finds the GPU through
// zwp_linux_dmabuf_v1 feedback (v4+): its main_device names the render node.
// Without it (dmabuf v3 or none, as with Ash on X11 without native GPU memory
// buffers and Vulkan), GL apps silently fall back to llvmpipe and wl_shm.
//
// A minimal Wayland client (wire protocol over the Unix socket, no libwayland):
// registry → bind zwp_linux_dmabuf_v1 → get_default_feedback → main_device.
import { readdirSync, statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";

export interface GpuReport {
  /** zwp_linux_dmabuf_v1 version Exo offers (0: none). */
  readonly dmabufVersion: number;
  /** The render node Exo's feedback names, e.g. /dev/dri/renderD128. */
  readonly renderNode: string | null;
  /** Whether GL/Vulkan apps can find the GPU. */
  readonly accelerated: boolean;
}

const TIMEOUT_MS = 3000;

class Wire {
  private buffer = Buffer.alloc(0);
  private waiting: (() => void) | null = null;
  private closed: Error | null = null;
  private readonly socket: Socket;
  constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (data) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      this.waiting?.();
    });
    socket.on("error", (error) => {
      this.closed = error;
      this.waiting?.();
    });
    socket.on("close", () => {
      this.closed ??= new Error("Exo closed the connection");
      this.waiting?.();
    });
  }

  send(objectId: number, opcode: number, args: Buffer[]): void {
    const body = Buffer.concat(args);
    const header = Buffer.alloc(8);
    header.writeUInt32LE(objectId, 0);
    header.writeUInt32LE(((8 + body.length) << 16) | opcode, 4);
    this.socket.write(Buffer.concat([header, body]));
  }

  /** The next event: [object id, opcode, payload]. */
  async next(): Promise<[number, number, Buffer]> {
    for (;;) {
      if (this.buffer.length >= 8) {
        const size = this.buffer.readUInt32LE(4) >>> 16;
        if (this.buffer.length >= size) {
          const event: [number, number, Buffer] = [
            this.buffer.readUInt32LE(0),
            this.buffer.readUInt32LE(4) & 0xffff,
            this.buffer.subarray(8, size),
          ];
          this.buffer = this.buffer.subarray(size);
          return event;
        }
      }
      if (this.closed) throw this.closed;
      await new Promise<void>((resolve) => (this.waiting = resolve));
      this.waiting = null;
    }
  }
}

const uint = (value: number) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
};

const string = (value: string) => {
  const bytes = Buffer.from(`${value}\0`);
  return Buffer.concat([uint(bytes.length), bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)]);
};

function readString(payload: Buffer, offset: number): [string, number] {
  const length = payload.readUInt32LE(offset);
  const text = payload.toString("utf8", offset + 4, offset + 4 + Math.max(0, length - 1));
  return [text, offset + 4 + Math.ceil(length / 4) * 4];
}

/** The /dev/dri node whose st_rdev is `rdev` (Linux dev_t, as stat reports it). */
function driNode(rdev: bigint): string | null {
  try {
    for (const name of readdirSync("/dev/dri")) {
      const path = join("/dev/dri", name);
      if (BigInt(statSync(path).rdev) === rdev) return path;
    }
  } catch {
    // No /dev/dri.
  }
  return null;
}

/** Asks Exo at `socketPath` what a GPU client would be told. */
export async function probeGpu(socketPath: string): Promise<GpuReport> {
  const socket = connect(socketPath);
  await new Promise<void>((resolve, reject) => socket.once("connect", resolve).once("error", reject));
  const wire = new Wire(socket);
  const timer = setTimeout(() => socket.destroy(new Error("Exo didn't answer")), TIMEOUT_MS);
  try {
    const DISPLAY = 1, REGISTRY = 2, SYNC = 3, DMABUF = 4, FEEDBACK = 5, SYNC2 = 6;
    wire.send(DISPLAY, 1, [uint(REGISTRY)]); // wl_display.get_registry
    wire.send(DISPLAY, 0, [uint(SYNC)]); // wl_display.sync
    let dmabuf: { name: number; version: number } | null = null;
    for (;;) {
      const [id, opcode, payload] = await wire.next();
      if (id === DISPLAY && opcode === 0) throw new Error("Wayland protocol error");
      if (id === REGISTRY && opcode === 0) {
        const name = payload.readUInt32LE(0);
        const [iface, at] = readString(payload, 4);
        if (iface === "zwp_linux_dmabuf_v1") dmabuf = { name, version: payload.readUInt32LE(at) };
      }
      if (id === SYNC) break;
    }
    if (!dmabuf) return { dmabufVersion: 0, renderNode: null, accelerated: false };
    if (dmabuf.version < 4) return { dmabufVersion: dmabuf.version, renderNode: null, accelerated: false };

    // wl_registry.bind(name, interface, version, new_id), then get_default_feedback.
    wire.send(REGISTRY, 0, [uint(dmabuf.name), string("zwp_linux_dmabuf_v1"), uint(4), uint(DMABUF)]);
    wire.send(DMABUF, 2, [uint(FEEDBACK)]);
    wire.send(DISPLAY, 0, [uint(SYNC2)]);
    let renderNode: string | null = null;
    for (;;) {
      const [id, opcode, payload] = await wire.next();
      if (id === DISPLAY && opcode === 0) throw new Error("Wayland protocol error");
      // zwp_linux_dmabuf_feedback_v1.main_device(array of dev_t)
      if (id === FEEDBACK && opcode === 2 && payload.readUInt32LE(0) >= 8) {
        renderNode = driNode(payload.readBigUInt64LE(4));
      }
      if ((id === FEEDBACK && opcode === 0) || id === SYNC2) break; // done
    }
    return { dmabufVersion: dmabuf.version, renderNode, accelerated: renderNode !== null };
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}

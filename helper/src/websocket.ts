// A WebSocket endpoint on loopback with an unguessable path, for one client:
// Playwright's connectOverCDP() only takes a ws:// URL, and the pages it
// drives are behind the helper's relay (pages.ts). Text frames only, which is
// all the DevTools protocol uses. No dependencies.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE = 1 << 28;

export interface WebSocketConnection {
  send(text: string): void;
  close(): void;
}

export interface WebSocketEndpoint {
  /** ws://127.0.0.1:<port>/<secret> */
  readonly url: string;
  /** Stops listening and closes the connection. */
  close(): void;
}

/**
 * Listens for one connection at a time (a new one replaces the last).
 * `onMessage` gets each text message; `onClose` when the connection ends.
 */
export async function listenWebSocket(handlers: {
  onConnection: (connection: WebSocketConnection) => void;
  onMessage: (text: string) => void;
  onClose: () => void;
}): Promise<WebSocketEndpoint> {
  const path = `/${randomBytes(18).toString("base64url")}`;
  let current: Socket | null = null;
  const server: Server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  server.on("upgrade", (request, socket: Socket, head: Buffer) => {
    const key = request.headers["sec-websocket-key"];
    if (request.url !== path || typeof key !== "string" || request.headers.upgrade?.toLowerCase() !== "websocket") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    if (current) current.destroy();
    current = socket;
    let buffer: Buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
    let fragments: Buffer[] = [];
    const write = (opcode: number, payload: Buffer) => {
      if (socket.destroyed) return;
      const length = payload.length;
      const header =
        length < 126
          ? Buffer.from([0x80 | opcode, length])
          : length < 65536
            ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
            : (() => {
                const value = Buffer.alloc(10);
                value[0] = 0x80 | opcode;
                value[1] = 127;
                value.writeBigUInt64BE(BigInt(length), 2);
                return value;
              })();
      socket.write(Buffer.concat([header, payload]));
    };
    const connection: WebSocketConnection = {
      send: (text) => write(0x1, Buffer.from(text, "utf8")),
      close: () => {
        write(0x8, Buffer.alloc(0));
        socket.end();
      },
    };
    const parse = () => {
      while (buffer.length >= 2) {
        const first = buffer[0]!;
        const second = buffer[1]!;
        const fin = (first & 0x80) !== 0;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          const big = buffer.readBigUInt64BE(2);
          if (big > BigInt(MAX_MESSAGE)) {
            socket.destroy();
            return;
          }
          length = Number(big);
          offset = 10;
        }
        const maskOffset = offset;
        if (masked) offset += 4;
        if (buffer.length < offset + length) return;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        if (masked) {
          for (let i = 0; i < payload.length; i++) payload[i]! ^= buffer[maskOffset + (i & 3)]!;
        }
        buffer = buffer.subarray(offset + length);
        switch (opcode) {
          case 0x0: // continuation
          case 0x1: // text
          case 0x2: // binary
            fragments.push(payload);
            if (fin) {
              const message = Buffer.concat(fragments).toString("utf8");
              fragments = [];
              handlers.onMessage(message);
            }
            break;
          case 0x8: // close
            connection.close();
            return;
          case 0x9: // ping
            write(0xa, payload);
            break;
          default: // pong
            break;
        }
      }
    };
    socket.on("data", (chunk: Buffer) => {
      buffer = buffer.length > 0 ? Buffer.concat([buffer, chunk]) : chunk;
      parse();
    });
    const end = () => {
      if (current !== socket) return;
      current = null;
      handlers.onClose();
    };
    socket.once("close", end);
    socket.once("error", end);
    handlers.onConnection(connection);
    if (buffer.length > 0) parse();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject).listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}${path}`,
    close: () => {
      current?.destroy();
      server.close();
    },
  };
}

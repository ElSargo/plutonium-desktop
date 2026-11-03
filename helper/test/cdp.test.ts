// BrowserCdp over a Unix socket (--plutonium-remote-debugging-socket): a fake
// browser's DevTools on a socket, answering /json/version and the browser
// target's WebSocket the way Chromium's DevToolsHttpHandler does.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { BrowserCdp, CdpError } from "../src/cdp.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const dir = mkdtempSync(join(tmpdir(), "plutonium-cdp-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// Unmasked server frames; reads the client's masked text frames.
function fakeBrowser(socketPath: string, handle: (message: { id: number; method: string }) => object | null): Promise<{ server: Server; sockets: Socket[] }> {
  const sockets: Socket[] = [];
  const server = createServer((request, response) => {
    assert.equal(request.url, "/json/version");
    response.end(JSON.stringify({ Browser: "Fake/1", webSocketDebuggerUrl: "ws://localhost/devtools/browser/abc" }));
  });
  server.on("upgrade", (request, socket: Socket) => {
    assert.equal(request.url, "/devtools/browser/abc");
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}${GUID}`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.push(socket);
    const send = (text: string) => {
      const payload = Buffer.from(text);
      const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
      socket.write(Buffer.concat([header, payload]));
    };
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        assert.ok(buffer[1]! & 0x80, "a client's frames are masked");
        let length = buffer[1]! & 0x7f;
        let offset = 2;
        if (length === 126) {
          length = buffer.readUInt16BE(2);
          offset = 4;
        }
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
        for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!;
        buffer = buffer.subarray(offset + 4 + length);
        const message = JSON.parse(payload.toString()) as { id: number; method: string };
        const result = handle(message);
        if (result) send(JSON.stringify({ id: message.id, result }));
        else send(JSON.stringify({ id: message.id, error: { message: `${message.method} wasn't found` } }));
      }
    });
  });
  return new Promise((resolve) => server.listen(socketPath, () => resolve({ server, sockets })));
}

test("BrowserCdp talks to DevTools on a Unix socket", async () => {
  const socketPath = join(dir, "devtools.sock");
  const events: string[] = [];
  const { server, sockets } = await fakeBrowser(socketPath, (message) => {
    if (message.method === "Browser.getVersion") return { product: "Fake/1", padding: "x".repeat(300) };
    return null;
  });
  const cdp = new BrowserCdp({ socketPath });
  assert.equal(cdp.where, socketPath);
  cdp.addEventListener((event) => events.push(event.method));
  let closed = false;
  cdp.addCloseListener(() => (closed = true));

  const version = (await cdp.send("Browser.getVersion")) as { product: string; padding: string };
  assert.equal(version.product, "Fake/1");
  assert.equal(version.padding.length, 300, "16-bit lengths both ways");
  assert.equal(cdp.connected, true);
  await assert.rejects(cdp.send("Nope.nothing"), CdpError);

  // An event the browser sends unasked.
  const event = Buffer.from(JSON.stringify({ method: "Target.targetCreated", params: {} }));
  sockets[0]!.write(Buffer.concat([Buffer.from([0x81, event.length]), event]));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(events, ["Target.targetCreated"]);

  // The browser goes away; the next send reconnects.
  sockets[0]!.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(closed, true);
  assert.equal(cdp.connected, false);
  assert.equal(((await cdp.send("Browser.getVersion")) as { product: string }).product, "Fake/1");
  assert.equal(sockets.length, 2);

  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
});

test("BrowserCdp rejects when nothing listens on the socket", async () => {
  const cdp = new BrowserCdp({ socketPath: join(dir, "missing.sock") });
  await assert.rejects(cdp.send("Browser.getVersion"), CdpError);
});

// The browser's DevTools protocol: one WebSocket to the browser target, with
// flat sessions for the pages the helper drives (serverTabs.ts, pages.ts), and
// the browser's Plutonium domain (desktop.ts). No dependencies. The browser
// serves it on one of:
// - a Unix socket (--plutonium-remote-debugging-socket, the default): only
//   this user's processes may connect (websocket.ts's client);
// - a TCP port on 127.0.0.1 (--remote-debugging-port, DEVTOOLS=port, or a
//   browser from before the socket): any local process may (Node's own
//   WebSocket).
import { request } from "node:http";

import { connectWebSocket } from "./websocket.ts";

/** Where the browser's DevTools are: a port on 127.0.0.1, or a Unix socket. */
export type CdpEndpoint = { readonly port: number } | { readonly socketPath: string };

interface Connection {
  send(text: string): void;
  close(): void;
}

export interface CdpEvent {
  readonly method: string;
  readonly params: unknown;
  readonly sessionId: string | undefined;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export class CdpError extends Error {}

const CONNECT_TIMEOUT_MS = 5_000;

export class BrowserCdp {
  private readonly endpoint: CdpEndpoint;
  private socket: Connection | null = null;
  private opening: Promise<Connection> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private readonly eventListeners = new Set<(event: CdpEvent) => void>();
  private readonly closeListeners = new Set<() => void>();

  constructor(endpoint: CdpEndpoint | number) {
    this.endpoint = typeof endpoint === "number" ? { port: endpoint } : endpoint;
  }

  /** The endpoint, for logs: "port 9224" or the socket's path. */
  get where(): string {
    return "port" in this.endpoint ? `port ${this.endpoint.port}` : this.endpoint.socketPath;
  }

  private closed(socket: Connection): void {
    if (this.socket !== socket) return;
    this.socket = null;
    for (const pending of this.pending.values()) pending.reject(new CdpError("The browser went away."));
    this.pending.clear();
    for (const listener of this.closeListeners) listener();
  }

  private async open(): Promise<Connection> {
    if ("socketPath" in this.endpoint) return this.openUnix(this.endpoint.socketPath);
    const response = await fetch(`http://127.0.0.1:${this.endpoint.port}/json/version`, {
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
    const { webSocketDebuggerUrl } = (await response.json()) as { webSocketDebuggerUrl?: string };
    if (!webSocketDebuggerUrl) throw new CdpError("The browser named no DevTools endpoint.");
    const socket = new WebSocket(webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new CdpError("Could not reach the browser's DevTools.")), {
        once: true,
      });
    });
    socket.addEventListener("message", (message) => this.receive(String(message.data)));
    socket.addEventListener("close", () => this.closed(socket));
    return socket;
  }

  private async openUnix(socketPath: string): Promise<Connection> {
    const version = await new Promise<string>((resolve, reject) => {
      const req = request({ socketPath, path: "/json/version", headers: { Host: "localhost" } }, (response) => {
        let body = "";
        response.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
        response.on("end", () => resolve(body));
      });
      req.setTimeout(CONNECT_TIMEOUT_MS, () => req.destroy(new CdpError("The browser's DevTools didn't answer.")));
      req.once("error", () => reject(new CdpError(`Could not reach the browser's DevTools (${socketPath}).`)));
      req.end();
    });
    let url: string | undefined;
    try {
      url = (JSON.parse(version) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl;
    } catch {}
    if (!url) throw new CdpError("The browser named no DevTools endpoint.");
    let socket: Connection | null = null;
    socket = await connectWebSocket(
      socketPath,
      new URL(url).pathname,
      {
        onMessage: (text) => this.receive(text),
        onClose: () => socket && this.closed(socket),
      },
      CONNECT_TIMEOUT_MS,
    ).catch((error: unknown) => {
      throw new CdpError(`Could not reach the browser's DevTools: ${(error as Error).message}`);
    });
    return socket;
  }

  private connection(): Promise<Connection> {
    if (this.socket) return Promise.resolve(this.socket);
    this.opening ??= this.open().then(
      (socket) => {
        this.socket = socket;
        this.opening = null;
        return socket;
      },
      (error: unknown) => {
        this.opening = null;
        throw error;
      },
    );
    return this.opening;
  }

  private receive(raw: string): void {
    let message: { id?: number; method?: string; params?: unknown; sessionId?: string; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new CdpError(message.error.message ?? "DevTools error."));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method === "string") {
      const event = { method: message.method, params: message.params, sessionId: message.sessionId };
      for (const listener of this.eventListeners) listener(event);
    }
  }

  /** Every event from the browser, whatever session it is for. */
  addEventListener(listener: (event: CdpEvent) => void): void {
    this.eventListeners.add(listener);
  }

  removeEventListener(listener: (event: CdpEvent) => void): void {
    this.eventListeners.delete(listener);
  }

  /** The connection to the browser closed (it restarted, or quit). */
  addCloseListener(listener: () => void): void {
    this.closeListeners.add(listener);
  }

  /** Whether the connection is open (it opens on the first send()). */
  get connected(): boolean {
    return this.socket !== null;
  }

  /** Sends `method` to the browser, or to `sessionId`'s target. */
  async send(method: string, params: object = {}, sessionId?: string): Promise<unknown> {
    const socket = await this.connection();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

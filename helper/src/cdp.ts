// The browser's DevTools protocol, from its --remote-debugging-port: one
// WebSocket to the browser target, with flat sessions for the pages the
// helper drives (serverTabs.ts, pages.ts), and the browser's Plutonium domain
// (desktop.ts). Node's own WebSocket client; no dependencies.

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
  private readonly port: number;
  private socket: WebSocket | null = null;
  private opening: Promise<WebSocket> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private readonly eventListeners = new Set<(event: CdpEvent) => void>();
  private readonly closeListeners = new Set<() => void>();

  constructor(port: number) {
    this.port = port;
  }

  private async open(): Promise<WebSocket> {
    const response = await fetch(`http://127.0.0.1:${this.port}/json/version`, {
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
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const pending of this.pending.values()) pending.reject(new CdpError("The browser went away."));
      this.pending.clear();
      for (const listener of this.closeListeners) listener();
    });
    return socket;
  }

  private connection(): Promise<WebSocket> {
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

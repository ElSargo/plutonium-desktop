// The shell relay: the window broker lives in the shell page (only the shell
// document gets navigator.windowBroker), so the helper asks the page to act on
// windows. The page keeps an EventSource open for requests and posts each
// reply back (web/plutonium-shell.js does both).
import type { ServerResponse } from "node:http";

export interface NativeWindowEntry {
  readonly id: number;
  readonly appId: string;
  readonly title: string;
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
  readonly embedded: boolean;
  readonly focused: boolean;
  readonly pid: number;
  /** The thread that started its client, or "" (older browsers: missing). */
  readonly tag?: string;
  /** `tag` (if any) first, then the tags shells added. */
  readonly tags?: readonly string[];
}

export interface BrowserTabEntry {
  readonly id: number;
  readonly contentId: string;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly embedded: boolean;
  readonly focused: boolean;
  /** The tag it was created with: the thread that opened it ("" if none). */
  readonly tag: string;
  /** `tag` (if any) first, then the tags shells added (older browsers: missing). */
  readonly tags?: readonly string[];
  readonly openerId: number;
  readonly openedBy: string;
  readonly dialogType: string;
  readonly dialogMessage: string;
  readonly dialogDefaultPrompt: string;
  /** What the tab's features report, a JSON object (older browsers: missing). */
  readonly stateJson?: string;
}

/** A tag a shell has described: its label and owning shell. */
export interface ItemGroup {
  readonly tag: string;
  readonly label: string;
  readonly shellId: string;
}

export type RelayReply =
  | { readonly kind: "json"; readonly value: unknown }
  | { readonly kind: "png"; readonly data: Buffer };

interface Pending {
  readonly resolve: (reply: RelayReply) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly connection: Connection;
}

/** One shell page's request stream. */
interface Connection {
  /** The page's own id for itself (it reconnects with the same one). */
  readonly key: string;
  readonly origin: string;
  /** The browser's id for the page's shell ("" outside shell mode or unknown). */
  readonly shellId: string;
  readonly response: ServerResponse;
  readonly heartbeat: ReturnType<typeof setInterval>;
  visible: boolean;
  /** EXO-DISPLAYS: the browser's id for the display the page is on ("" if unknown). */
  readonly display: string;
  /** When it was last visible (or connected), for picking one. */
  lastVisible: number;
}

export class RelayError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const HEARTBEAT_MS = 15_000;

/**
 * Several shells can be connected at once (the browser keeps every shell's
 * page running and shows one). A request about a group goes to the shell
 * that owns the group, if it is connected; anything else (or a group whose
 * shell isn't) goes to the visible one, else to the one visible most
 * recently.
 */
export class ShellRelay {
  private readonly connections = new Map<string, Connection>();
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  /** A shell page's request stream ended (it closed, reloaded or went away). */
  onDisconnect: (key: string) => void = () => {};
  /** A shell page's request stream started (it may have missed notices). */
  onAttach: (key: string) => void = () => {};

  get connected(): boolean {
    return this.connections.size > 0;
  }

  /** The connected shells. */
  shells(): { origin: string; shellId: string; visible: boolean; display: string }[] {
    return [...this.connections.values()].map(({ origin, shellId, visible, display }) => ({
      origin,
      shellId,
      visible,
      display,
    }));
  }

  /** Makes `response` (an EventSource request from a shell page) `key`'s request stream. */
  attach(response: ServerResponse, key: string, origin: string, shellId: string, visible: boolean, display = ""): void {
    // A reconnect replaces the page's stream; the page itself is still there.
    this.detach(key, true);
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
    });
    response.write(": plutonium\n\n");
    const connection: Connection = {
      key,
      origin,
      shellId,
      response,
      heartbeat: setInterval(() => response.write(": ping\n\n"), HEARTBEAT_MS),
      visible,
      display,
      lastVisible: Date.now(),
    };
    this.connections.set(key, connection);
    response.once("close", () => {
      if (this.connections.get(key) === connection) this.detach(key);
    });
    this.onAttach(key);
  }

  /** A shell page was shown or hidden. False if `key` isn't connected. */
  setVisible(key: string, visible: boolean): boolean {
    const connection = this.connections.get(key);
    if (!connection) return false;
    connection.visible = visible;
    connection.lastVisible = Date.now();
    return true;
  }

  private detach(key: string, replaced = false): void {
    const connection = this.connections.get(key);
    if (!connection) return;
    this.connections.delete(key);
    clearInterval(connection.heartbeat);
    connection.response.end();
    for (const [id, pending] of this.pending) {
      if (pending.connection !== connection) continue;
      clearTimeout(pending.timer);
      pending.reject(new RelayError(503, "The shell disconnected."));
      this.pending.delete(id);
    }
    if (!replaced) this.onDisconnect(key);
  }

  /** The origin of page `key`, if it is connected. */
  originOf(key: string): string | undefined {
    return this.connections.get(key)?.origin;
  }

  /** Whether page `key` is connected. */
  has(key: string): boolean {
    return this.connections.has(key);
  }

  /** Tells every connected page something it doesn't answer. */
  notifyAll(op: string, args: Record<string, unknown>): void {
    for (const key of this.connections.keys()) this.notify(key, op, args);
  }

  /** Tells the pages of the origins `wanted` accepts something they don't answer. */
  notifyWhere(wanted: (origin: string) => boolean, op: string, args: Record<string, unknown>): void {
    for (const [key, connection] of this.connections) if (wanted(connection.origin)) this.notify(key, op, args);
  }

  /** Tells page `key` something it doesn't answer (no id). */
  notify(key: string, op: string, args: Record<string, unknown>): void {
    this.connections.get(key)?.response.write(`data: ${JSON.stringify({ op, args })}\n\n`);
  }

  private pick(shellId?: string): Connection | undefined {
    let best: Connection | undefined;
    const candidates = [...this.connections.values()];
    const owners = shellId ? candidates.filter((connection) => connection.shellId === shellId) : [];
    for (const connection of owners.length > 0 ? owners : candidates) {
      if (
        !best ||
        (connection.visible && !best.visible) ||
        (connection.visible === best.visible && connection.lastVisible > best.lastVisible)
      ) {
        best = connection;
      }
    }
    return best;
  }

  /** Sends `op` to `shellId`'s page if it is connected, else as `pick()` says. */
  request(
    op: string,
    args: Record<string, unknown> = {},
    timeoutMs = 5_000,
    shellId?: string,
  ): Promise<RelayReply> {
    const connection = this.pick(shellId);
    if (!connection) {
      return Promise.reject(new RelayError(503, "No Plutonium shell is connected to the helper."));
    }
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RelayError(504, `The shell did not answer "${op}" in time.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, connection });
      connection.response.write(`data: ${JSON.stringify({ id, op, args })}\n\n`);
    });
  }

  async json<T>(op: string, args?: Record<string, unknown>, shellId?: string): Promise<T> {
    const reply = await this.request(op, args, 5_000, shellId);
    if (reply.kind !== "json") throw new RelayError(502, `Unexpected reply to "${op}".`);
    return reply.value as T;
  }

  windows(): Promise<NativeWindowEntry[]> {
    return this.json<NativeWindowEntry[]>("windows");
  }

  tabs(): Promise<BrowserTabEntry[]> {
    return this.json<BrowserTabEntry[]>("tabs");
  }

  /** Every shell's groups (older shells: none). */
  async groups(): Promise<ItemGroup[]> {
    try {
      return await this.json<ItemGroup[]>("groups");
    } catch (error) {
      if (error instanceof RelayError && error.status === 409) return [];
      throw error;
    }
  }

  /** A reply from the shell to request `id`. False if nothing waits for it. */
  reply(id: string, contentType: string, body: Buffer): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (contentType.startsWith("image/png")) {
      pending.resolve({ kind: "png", data: body });
      return true;
    }
    try {
      const message = JSON.parse(body.toString("utf8")) as { ok: boolean; value?: unknown; error?: string };
      if (message.ok) pending.resolve({ kind: "json", value: message.value });
      else pending.reject(new RelayError(409, message.error ?? "The shell refused."));
    } catch {
      pending.reject(new RelayError(502, "Malformed reply from the shell."));
    }
    return true;
  }
}

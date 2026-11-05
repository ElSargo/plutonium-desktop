// The fuzzy finder's front (docs/features/FILE_MANAGER.md, "The fuzzy finder"): a child
// process does the work, the page gets only the best results. Typing outruns a search on a big
// folder, so a query waits for the one running, and a newer one replaces it. An index holds
// memory (about 1 GB for a home folder of millions of files): it goes when nobody's used it.
import { type ChildProcess, fork } from "node:child_process";
import { isAbsolute, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { FilesError } from "./files.ts";
import type { FindRequest, FindResult } from "./fileFinderWorker.ts";

const IDLE_MS = 3 * 60_000;

export interface FindOptions {
  readonly query: string;
  readonly hidden: boolean;
  readonly limit?: number;
}

type Superseded = { readonly superseded: true };

interface Waiting {
  readonly request: Omit<FindRequest, "id">;
  readonly resolve: (value: FindResult | Superseded) => void;
  readonly reject: (error: Error) => void;
}

export class FileFinders {
  private worker: ChildProcess | null = null;
  private nextId = 1;
  private readonly calls = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly busy = new Set<string>();
  private readonly waiting = new Map<string, Waiting>();
  private readonly idle = new Map<string, NodeJS.Timeout>();
  private readonly workerUrl: URL;
  private readonly idleMs: number;

  constructor({ workerUrl = new URL("./fileFinderWorker.ts", import.meta.url), idleMs = IDLE_MS } = {}) {
    this.workerUrl = workerUrl;
    this.idleMs = idleMs;
  }

  private call(request: Omit<FindRequest, "id">): Promise<unknown> {
    if (!this.worker?.connected) {
      const worker = fork(fileURLToPath(this.workerUrl), { stdio: ["ignore", "ignore", "inherit", "ipc"] });
      worker.unref();
      worker.channel?.unref();
      worker.on("message", (message) => {
        const { id, value, error } = message as { id: number; value?: unknown; error?: string };
        const call = this.calls.get(id);
        this.calls.delete(id);
        if (error) call?.reject(new FilesError(500, error));
        else call?.resolve(value);
      });
      // Native code that dies takes only this: the next search starts another.
      const gone = (error: Error) => {
        if (this.worker === worker) this.worker = null;
        for (const call of this.calls.values()) call.reject(new FilesError(500, error.message));
        this.calls.clear();
      };
      worker.on("error", gone);
      worker.on("exit", () => gone(new Error("The search stopped.")));
      this.worker = worker;
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      // A process that died just now fails this through its "exit".
      this.worker?.send({ ...request, id }, () => {});
    });
  }

  private touch(root: string): void {
    clearTimeout(this.idle.get(root));
    const timer = setTimeout(() => {
      // A search that's still running isn't idle.
      if (this.busy.has(root)) return this.touch(root);
      this.idle.delete(root);
      // With no index left in use, ending the process gives everything back.
      if (this.idle.size === 0) this.stop();
      else void this.call({ op: "close", root }).catch(() => {});
    }, this.idleMs);
    timer.unref();
    this.idle.set(root, timer);
  }

  private stop(): void {
    this.worker?.kill();
    this.worker = null;
  }

  private async run(root: string, waiting: Waiting): Promise<void> {
    this.busy.add(root);
    try {
      waiting.resolve((await this.call(waiting.request)) as FindResult);
    } catch (error) {
      waiting.reject(error as Error);
    }
    this.busy.delete(root);
    const next = this.waiting.get(root);
    if (next) {
      this.waiting.delete(root);
      void this.run(root, next);
    }
  }

  /** The best matches under `dir`, or `superseded` if a newer query took this one's place. */
  find(dir: unknown, { query, hidden, limit }: FindOptions): Promise<FindResult | Superseded> {
    if (typeof dir !== "string" || !isAbsolute(dir)) throw new FilesError(400, "The path must be absolute.");
    const root = normalize(dir).replace(/(.)\/+$/, "$1");
    this.touch(root);
    return new Promise((resolve, reject) => {
      const waiting: Waiting = {
        request: { op: "find", root, query, hidden, ...(limit ? { limit } : {}) },
        resolve,
        reject,
      };
      if (!this.busy.has(root)) {
        void this.run(root, waiting);
        return;
      }
      this.waiting.get(root)?.resolve({ superseded: true });
      this.waiting.set(root, waiting);
    });
  }

  /** `path` was chosen for `query`: it ranks higher from now on. */
  async opened(dir: string, query: string, path: string): Promise<void> {
    await this.call({ op: "opened", root: dir, query, path });
  }

  close(): void {
    for (const timer of this.idle.values()) clearTimeout(timer);
    this.idle.clear();
    this.stop();
  }
}

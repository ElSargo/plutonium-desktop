// The fuzzy finder's front (docs/features/FILE_MANAGER.md, "The fuzzy finder"): a child
// process does the work, the page gets only the best results. Typing outruns a search on a big
// folder, so a query waits for the one running, and a newer one replaces it. A home folder
// of millions of files takes seconds to index and fff keeps nothing on disk, so an index
// stays between uses, and the folders searched lately are indexed again as a session
// starts. That's about 1 GB for such a folder: the memory goes back if the computer runs short.
import { type ChildProcess, fork } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { FilesError } from "./files.ts";
import type { FindRequest, FindResult } from "./fileFinderWorker.ts";

const IDLE_MS = 24 * 3_600_000;
/** An index this old is rebuilt the next time it's searched. */
const REFRESH_MS = 5 * 60_000;
const MAX_INDEXES = 4;
const MEMORY_CHECK_MS = 30_000;
/** Below this much available memory, the indexes go; twice this and they can be rebuilt. */
const memoryFloor = () => Math.max(1.5 * 2 ** 30, totalmem() * 0.05);
const WARM_ROOTS = 2;
const WARM_WITHIN_MS = 14 * 24 * 3_600_000;
const RECENT_WRITE_MS = 3_600_000;

function availableMemory(): number {
  try {
    const found = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync("/proc/meminfo", "utf8"));
    return found ? Number(found[1]) * 1024 : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

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
  private memoryCheck: NodeJS.Timeout | null = null;
  private readonly recentWrites = new Map<string, number>();
  private readonly workerUrl: URL;
  private readonly idleMs: number;
  private readonly refreshMs: number;
  private readonly memory: () => number;
  private readonly memoryCheckMs: number;
  /** Whose list of folders this is: a dev slot's helper warms only what was searched in it. */
  private readonly scope: string;

  constructor({
    workerUrl = new URL("./fileFinderWorker.ts", import.meta.url),
    idleMs = IDLE_MS,
    refreshMs = REFRESH_MS,
    memory = availableMemory,
    memoryCheckMs = MEMORY_CHECK_MS,
    scope = "default",
  } = {}) {
    this.workerUrl = workerUrl;
    this.idleMs = idleMs;
    this.refreshMs = refreshMs;
    this.memory = memory;
    this.memoryCheckMs = memoryCheckMs;
    this.scope = scope;
  }

  private get recentFile(): string {
    const data = process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
    return join(data, "plutonium/fff", `recent-${this.scope}.json`);
  }

  private recent(): Record<string, number> {
    try {
      return JSON.parse(readFileSync(this.recentFile, "utf8")) as Record<string, number>;
    } catch {
      return {};
    }
  }

  private remember(root: string): void {
    const now = Date.now();
    if (now - (this.recentWrites.get(root) ?? 0) < RECENT_WRITE_MS) return;
    this.recentWrites.set(root, now);
    try {
      const file = this.recentFile;
      mkdirSync(dirname(file), { recursive: true });
      const kept = Object.entries({ ...this.recent(), [root]: now })
        .sort(([, left], [, right]) => right - left)
        .slice(0, 16);
      writeFileSync(file, JSON.stringify(Object.fromEntries(kept)));
    } catch {
      // Only a head start is lost.
    }
  }

  /** Indexes the folders searched lately, so the first search of a session has no wait. */
  async warm(): Promise<void> {
    if (this.memory() < memoryFloor() * 2) return;
    const oldest = Date.now() - WARM_WITHIN_MS;
    const roots = Object.entries(this.recent())
      .filter(([root, used]) => used >= oldest && existsSync(root))
      .sort(([, left], [, right]) => right - left)
      .slice(0, WARM_ROOTS);
    for (const [root] of roots) {
      this.touch(root);
      await this.call({ op: "warm", root }).catch(() => {});
    }
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
      this.memoryCheck ??= setInterval(() => {
        if (this.memory() < memoryFloor()) this.drop();
      }, this.memoryCheckMs);
      this.memoryCheck.unref();
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
    // Oldest first: a Map keeps the order things went in.
    this.idle.delete(root);
    const timer = setTimeout(() => {
      // A search that's still running isn't idle.
      if (this.busy.has(root)) return this.touch(root);
      this.closeIndex(root);
    }, this.idleMs);
    timer.unref();
    this.idle.set(root, timer);
    for (const oldest of this.idle.keys()) {
      if (this.idle.size <= MAX_INDEXES) break;
      if (!this.busy.has(oldest)) this.closeIndex(oldest);
    }
  }

  private closeIndex(root: string): void {
    clearTimeout(this.idle.get(root));
    this.idle.delete(root);
    // With no index left in use, ending the process gives everything back.
    if (this.idle.size === 0) this.stop();
    else void this.call({ op: "close", root }).catch(() => {});
  }

  private stop(): void {
    if (this.memoryCheck) clearInterval(this.memoryCheck);
    this.memoryCheck = null;
    this.worker?.kill();
    this.worker = null;
  }

  /** Gives every index's memory back. The next search there starts again. */
  private drop(): void {
    for (const timer of this.idle.values()) clearTimeout(timer);
    this.idle.clear();
    this.stop();
  }

  private async run(root: string, waiting: Waiting): Promise<void> {
    this.busy.add(root);
    try {
      const found = (await this.call(waiting.request)) as FindResult;
      if (found.engine === "fff") this.remember(root);
      waiting.resolve(found);
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
        request: {
          op: "find",
          root,
          query,
          hidden,
          ...(limit ? { limit } : {}),
          // A rebuild has two indexes in memory for a few seconds.
          refreshAfter: this.memory() < memoryFloor() * 2 ? 0 : this.refreshMs,
        },
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
    this.drop();
  }
}

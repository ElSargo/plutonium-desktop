// What an installed shell has besides its page (DESKTOP_SERVICES.md, "A
// native side and storage"):
//
// - storage: JSON values by key in $PLUTO_HOME/data/<name>/storage/, outside
//   the shell's git repository (an edit's rollback doesn't touch it) and the
//   same in every slot (unlike localStorage on a slot's origin);
// - a native side: the module "native" in its shell.json names, run by the
//   helper in its own Node process (nativeHost.ts) as the user, started on
//   the page's first call and again after an edit or a crash. Its functions
//   are the page's shell.native.call(name, args); its emit() events reach the
//   shell's pages.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, closeSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { logPath, type InstalledShell } from "./shells.ts";

const HOST = join(dirname(fileURLToPath(import.meta.url)), "nativeHost.ts");
/** How long a call may take. */
const CALL_TIMEOUT_MS = 60_000;
const STORAGE_LIMIT = 4 * 1024 * 1024;

export class NativeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A storage key: a file name, without surprises. */
const isKey = (key: string) => /^[\w][\w.-]{0,127}$/.test(key) && !key.endsWith(".tmp");

interface Running {
  readonly child: ChildProcess;
  readonly ready: Promise<void>;
  readonly calls: Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>;
}

export class ShellNative {
  private readonly home: string;
  private readonly onEvent: (shell: string, event: string, detail: unknown) => void;
  private readonly running = new Map<string, Running>();
  private nextId = 1;

  /** `onEvent` gets what a native side emits, for its shell's pages. */
  constructor(home: string, onEvent: (shell: string, event: string, detail: unknown) => void) {
    this.home = home;
    this.onEvent = onEvent;
  }

  dataDir(name: string): string {
    return join(this.home, "data", name);
  }

  // --- Storage -----------------------------------------------------------------

  private storageFile(name: string, key: string): string {
    if (!isKey(key)) throw new NativeError(400, `"${key}" can't be a key (letters, digits, _ . -; up to 128).`);
    return join(this.dataDir(name), "storage", `${key}.json`);
  }

  keys(name: string): string[] {
    try {
      return readdirSync(join(this.dataDir(name), "storage"))
        .filter((file) => file.endsWith(".json"))
        .map((file) => file.slice(0, -5))
        .sort();
    } catch {
      return [];
    }
  }

  /** The value at `key` (undefined: none). */
  get(name: string, key: string): unknown {
    try {
      return JSON.parse(readFileSync(this.storageFile(name, key), "utf8"));
    } catch (error) {
      if (error instanceof NativeError) throw error;
      return undefined;
    }
  }

  set(name: string, key: string, value: unknown): void {
    const file = this.storageFile(name, key);
    const text = JSON.stringify(value ?? null);
    if (text.length > STORAGE_LIMIT) throw new NativeError(413, `A value can be up to ${STORAGE_LIMIT / 1024 / 1024} MB.`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, text);
    renameSync(`${file}.tmp`, file);
  }

  delete(name: string, key: string): void {
    rmSync(this.storageFile(name, key), { force: true });
  }

  // --- The native side ---------------------------------------------------------

  async call(shell: InstalledShell, method: string, args: unknown): Promise<unknown> {
    const native = shell.manifest?.native;
    if (!native) throw new NativeError(404, `The shell "${shell.name}" has no native side ("native" in its shell.json).`);
    if (!/^[A-Za-z_$][\w$]*$/.test(method)) throw new NativeError(400, `"${method}" isn't a function's name.`);
    const running = this.running.get(shell.name) ?? this.launch(shell.name, join(shell.dir, native));
    await running.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        running.calls.delete(id);
        reject(new NativeError(504, `${method} took longer than ${CALL_TIMEOUT_MS / 1000} s.`));
      }, CALL_TIMEOUT_MS);
      running.calls.set(id, { resolve, reject, timer });
      running.child.send({ id, method, args: args ?? {} });
    });
  }

  /** Stops a shell's native side (after an edit: the next call starts the new one). */
  stop(name: string): void {
    const running = this.running.get(name);
    if (!running) return;
    this.running.delete(name);
    running.child.kill();
  }

  stopAll(): void {
    for (const name of [...this.running.keys()]) this.stop(name);
  }

  private launch(name: string, module: string): Running {
    mkdirSync(join(this.home, "logs"), { recursive: true });
    const log = openSync(logPath(this.home, name), "a");
    const child = spawn(process.execPath, [HOST, module, name, this.dataDir(name)], {
      cwd: dirname(module),
      stdio: ["ignore", log, log, "ipc"],
      env: { ...process.env, PLUTONIUM_SHELL: name },
    });
    closeSync(log);
    const calls: Running["calls"] = new Map();
    let settle!: { resolve(): void; reject(error: Error): void };
    const ready = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
    ready.catch(() => {});
    const running: Running = { child, ready, calls };
    this.running.set(name, running);
    child.on("message", (message: Record<string, unknown>) => {
      if (message.ready) settle.resolve();
      else if (message.failed) {
        // The next call tries again (after the shell's folder is fixed).
        if (this.running.get(name) === running) this.running.delete(name);
        settle.reject(new NativeError(502, `The native side didn't start: ${String(message.failed).split("\n")[0]} (its log has more).`));
      } else if (typeof message.event === "string") this.onEvent(name, message.event, message.detail);
      else if (typeof message.id === "number") {
        const call = calls.get(message.id);
        if (!call) return;
        calls.delete(message.id);
        clearTimeout(call.timer);
        if (typeof message.error === "string") call.reject(new NativeError(message.missing ? 404 : 500, message.error));
        else call.resolve(message.value);
      }
    });
    child.on("exit", (code, signal) => {
      if (this.running.get(name) === running) this.running.delete(name);
      settle.reject(new NativeError(502, `The native side exited (${signal ?? code}) as it started: see its log.`));
      for (const call of calls.values()) {
        clearTimeout(call.timer);
        call.reject(new NativeError(502, `The native side exited (${signal ?? code}): see the shell's log.`));
      }
      calls.clear();
    });
    return running;
  }
}

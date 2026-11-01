// The servers of shells whose manifest says "run": "plutonium" (shells.ts).
//
// The helper starts each one detached (its own session and process group),
// with its output in $PLUTO_HOME/logs/<name>.log, and a pid file in the
// runtime dir. A server outlives the helper: the next helper of the same
// session (same Wayland display) adopts it if it's still running, so a
// session restart doesn't cut T3 Code's agents off. It's healthy once its
// health URL answers; one that exits unasked is started again as its restart
// policy says, with a growing delay, until it fails too often.
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { expand, logPath, serverPort, shellDir, shellEnv, type ShellContext, type ShellManifest } from "./shells.ts";

export type ServerState = "stopped" | "starting" | "running" | "restarting" | "failed";

// How long a server has to answer its health URL after starting.
const START_TIMEOUT_MS = 90_000;
const HEALTH_INTERVAL_MS = 1_000;
// Restarts: the delay doubles from 1 s up to 30 s; more than MAX_FAILURES
// exits within FAILURE_WINDOW_MS and it stays failed.
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 120_000;
// How long a stop waits before SIGKILL.
const STOP_TIMEOUT_MS = 10_000;
// A thread's variables, which a server started from one mustn't inherit.
const THREAD_VARIABLES = ["PLUTONIUM_THREAD_ID", "PLUTONIUM_OPENERS", "PLUTONIUM_SHOW"];

export const MARKER_VARIABLE = "PLUTONIUM_SHELL_SERVER";

const runtimeDir = () => process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function environOf(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/environ`, "latin1").split("\0");
  } catch {
    return [];
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface ServerStatus {
  readonly state: ServerState;
  readonly detail: string;
  readonly command: string;
  readonly log: string;
  readonly pid?: number;
  readonly port?: number;
  readonly restarts: number;
  readonly lastExit?: string;
}

export class ShellServer {
  readonly name: string;
  private manifest: ShellManifest;
  private readonly context: ShellContext;
  private readonly onChange: () => void;
  state: ServerState = "stopped";
  pid: number | undefined;
  /** Its server was running already: a previous helper started it. */
  adopted = false;
  private child: ChildProcess | undefined;
  private wanted = false;
  private startedAt = 0;
  private healthyAt = 0;
  private restarts = 0;
  private failures: number[] = [];
  private lastExit: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private healthWaiters: ((healthy: boolean) => void)[] = [];

  constructor(manifest: ShellManifest, context: ShellContext, onChange: () => void = () => {}) {
    this.name = manifest.name;
    this.manifest = manifest;
    this.context = context;
    this.onChange = onChange;
  }

  /** Takes a new manifest (an edit); used from the next start. */
  setManifest(manifest: ShellManifest): void {
    this.manifest = manifest;
  }

  get pidFile(): string {
    return join(runtimeDir(), "plutonium", `shell-${this.name}-${this.context.waylandDisplay ?? "none"}.pid`);
  }

  get marker(): string {
    return `${this.name}@${this.context.waylandDisplay ?? ""}@${this.context.home}`;
  }

  get argv(): string[] {
    return (this.manifest.server?.argv ?? []).map((arg) => expand(arg, this.manifest, this.context));
  }

  get healthUrl(): string {
    const server = this.manifest.server!;
    return expand(server.health ?? server.url ?? "http://127.0.0.1:{port}/", this.manifest, this.context);
  }

  status(): ServerStatus {
    const port = serverPort(this.manifest, this.context);
    const up = this.healthyAt ? `, up ${minutes(Date.now() - this.healthyAt)}` : "";
    const restarted = this.restarts ? `, restarted ${this.restarts} time${this.restarts === 1 ? "" : "s"}` : "";
    const exit = this.lastExit ? ` (last exit: ${this.lastExit})` : "";
    const where = [this.pid ? `pid ${this.pid}` : "", port ? `port ${port}` : ""].filter(Boolean).join(", ");
    const detail =
      this.state === "running"
        ? `Running (${where})${up}${restarted}`
        : this.state === "starting"
          ? `Starting (${where}), waiting for ${this.healthUrl}`
          : this.state === "restarting"
            ? `Exited${exit}; starting again${restarted}`
            : this.state === "failed"
              ? `Failed${exit}: ${this.failures.length > MAX_FAILURES ? "it kept exiting" : "see its log"}`
              : `Stopped${exit}`;
    return {
      state: this.state,
      detail,
      command: this.argv.join(" "),
      log: logPath(this.context.home, this.name),
      ...(this.pid ? { pid: this.pid } : {}),
      ...(port ? { port } : {}),
      restarts: this.restarts,
      ...(this.lastExit ? { lastExit: this.lastExit } : {}),
    };
  }

  private set(state: ServerState): void {
    if (this.state === state) return;
    this.state = state;
    console.log(`plutoniumd: shell ${this.name}'s server: ${this.status().detail}`);
    this.onChange();
  }

  /** Adopts a server a previous helper of this session started, if it's still running. */
  adopt(): boolean {
    let pid: number;
    try {
      pid = Number(readFileSync(this.pidFile, "utf8"));
    } catch {
      return false;
    }
    if (!pid || !alive(pid) || !environOf(pid).includes(`${MARKER_VARIABLE}=${this.marker}`)) return false;
    this.wanted = true;
    this.pid = pid;
    this.adopted = true;
    this.startedAt = Date.now();
    this.set("starting");
    this.watch();
    return true;
  }

  /** Starts it (or adopts it); resolves once it's healthy, or isn't going to be. */
  start(): Promise<boolean> {
    this.wanted = true;
    this.failures = [];
    if (this.pid && alive(this.pid)) return this.whenHealthy();
    if (!this.adopt()) this.spawn();
    return this.whenHealthy();
  }

  whenHealthy(): Promise<boolean> {
    if (this.state === "running") return Promise.resolve(true);
    if (this.state === "stopped" || this.state === "failed") return Promise.resolve(false);
    return new Promise((resolve) => this.healthWaiters.push(resolve));
  }

  private settle(healthy: boolean): void {
    for (const waiter of this.healthWaiters.splice(0)) waiter(healthy);
  }

  private spawn(): void {
    const argv = this.argv;
    const server = this.manifest.server!;
    const log = logPath(this.context.home, this.name);
    mkdirSync(dirname(log), { recursive: true });
    mkdirSync(dirname(this.pidFile), { recursive: true });
    const fd = openSync(log, "a");
    const env = shellEnv(this.context);
    for (const name of THREAD_VARIABLES) delete env[name];
    for (const [name, value] of Object.entries(server.env ?? {})) env[name] = expand(value, this.manifest, this.context);
    env[MARKER_VARIABLE] = this.marker;
    const port = serverPort(this.manifest, this.context);
    if (port) env.PORT = String(port);
    writeFileSync(fd, `\n--- ${new Date().toISOString()} plutonium: starting ${argv.join(" ")}\n`);
    const cwd = server.cwd ? expand(server.cwd, this.manifest, this.context) : shellDir(this.context.home, this.name);
    let child: ChildProcess;
    try {
      child = spawn(argv[0]!, argv.slice(1), { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
    } finally {
      closeSync(fd);
    }
    child.unref();
    this.child = child;
    this.adopted = false;
    this.startedAt = Date.now();
    this.healthyAt = 0;
    this.pid = child.pid;
    child.once("error", (error) => this.exited(child, `couldn't start: ${error.message}`, true));
    child.once("exit", (code, signal) =>
      this.exited(child, signal ? `signal ${signal}` : `status ${code}`, code !== 0 || signal !== null),
    );
    if (child.pid) writeFileSync(this.pidFile, String(child.pid));
    this.set("starting");
    this.watch();
  }

  // Health while starting, liveness of an adopted server (no exit event).
  private watch(): void {
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.check(), HEALTH_INTERVAL_MS);
    this.timer.unref();
    void this.check();
  }

  private async check(): Promise<void> {
    if (!this.pid) return;
    if (!this.child && !alive(this.pid)) {
      this.exited(undefined, this.wanted ? "it went away" : "stopped", this.wanted);
      return;
    }
    if (this.state !== "starting") return;
    if (await answers(this.healthUrl)) {
      if (this.state !== "starting") return;
      this.healthyAt = Date.now();
      this.set("running");
      this.settle(true);
    } else if (Date.now() - this.startedAt > START_TIMEOUT_MS) {
      this.lastExit = `no answer from ${this.healthUrl} in ${START_TIMEOUT_MS / 1000} s`;
      void this.kill().then(() => this.failed());
    }
  }

  private exited(child: ChildProcess | undefined, how: string, failure: boolean): void {
    if (child && child !== this.child) return;
    this.child = undefined;
    this.pid = undefined;
    clearInterval(this.timer);
    rmSync(this.pidFile, { force: true });
    this.lastExit = how;
    this.healthyAt = 0;
    if (!this.wanted) {
      this.set("stopped");
      this.settle(false);
      return;
    }
    const policy = this.manifest.server?.restart ?? "on-failure";
    if (policy === "never" || (policy === "on-failure" && !failure)) {
      this.set(failure ? "failed" : "stopped");
      this.settle(false);
      return;
    }
    const now = Date.now();
    this.failures = [...this.failures.filter((at) => now - at < FAILURE_WINDOW_MS), now];
    if (this.failures.length > MAX_FAILURES) {
      this.failed();
      return;
    }
    this.restarts++;
    this.set("restarting");
    const delay = Math.min(30_000, 1000 * 2 ** (this.failures.length - 1));
    setTimeout(() => {
      if (this.wanted && this.state === "restarting") this.spawn();
    }, delay).unref();
  }

  private failed(): void {
    this.wanted = false;
    this.set("failed");
    this.settle(false);
  }

  private async kill(): Promise<void> {
    const pid = this.pid;
    if (!pid) return;
    const signal = (name: NodeJS.Signals) => {
      try {
        process.kill(-pid, name);
      } catch {
        try {
          process.kill(pid, name);
        } catch {
          // Gone.
        }
      }
    };
    signal("SIGTERM");
    for (let waited = 0; waited < STOP_TIMEOUT_MS && alive(pid); waited += 100) await sleep(100);
    if (alive(pid)) signal("SIGKILL");
    // An adopted server has no exit event.
    if (!this.child && this.pid === pid) this.exited(undefined, "stopped", false);
  }

  async stop(): Promise<void> {
    this.wanted = false;
    if (this.state === "restarting") this.set("stopped");
    await this.kill();
    if (!this.pid) this.set("stopped");
  }

  async restart(): Promise<boolean> {
    await this.stop();
    // The stop's exit event comes on the next turns.
    for (let waited = 0; waited < 2_000 && this.state !== "stopped"; waited += 50) await sleep(50);
    this.restarts++;
    return this.start();
  }
}

async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000), redirect: "manual" });
    return true;
  } catch {
    return false;
  }
}

function minutes(ms: number): string {
  const total = Math.round(ms / 60_000);
  return total < 1 ? "less than a minute" : total < 60 ? `${total} min` : `${Math.floor(total / 60)} h ${total % 60} min`;
}

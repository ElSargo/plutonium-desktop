// The backup terminal: login shells on this machine for the helper's terminal
// page (web/terminal/), which Ash's shells overlay opens when no shell works.
//
// Each session is the user's $SHELL on a pty (ptybridge.py), in the thread
// plutonium:terminal, so the apps it starts open as windows like any other.
// The page streams a session's output over an EventSource (the scrollback
// first, so a reload or a second page picks up where it was) and posts its
// keys and size. A session nobody watches for IDLE_MS is hung up.
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";

export const TERMINAL_THREAD = "plutonium:terminal";

const PTY = join(dirname(fileURLToPath(import.meta.url)), "ptybridge.py");
// Enough to redraw a screen or two of a busy program after a reload.
const SCROLLBACK_CHARS = 512 * 1024;
const IDLE_MS = 30_000;
const MAX_SESSIONS = 32;

export interface TerminalEvent {
  readonly type: "data" | "exit";
  /** Output (data), or the exit status (exit). */
  readonly data: string | number;
}

type Listener = (event: TerminalEvent) => void;

export class TerminalSession {
  readonly id = randomUUID();
  readonly createdAt = Date.now();
  exitStatus: number | null = null;
  private readonly child: ChildProcess;
  private readonly control: Writable;
  private chunks: string[] = [];
  private size = 0;
  private readonly listeners = new Set<Listener>();
  private idleTimer: NodeJS.Timeout | undefined;
  private readonly onGone: () => void;

  constructor(environment: NodeJS.ProcessEnv, rows: number, cols: number, onGone: () => void) {
    this.onGone = onGone;
    const shell = environment.SHELL || "/bin/sh";
    this.child = spawn("python3", ["-I", PTY, String(rows), String(cols), shell], {
      cwd: environment.HOME || "/",
      env: environment,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    this.control = this.child.stdio[3] as Writable;
    const decoder = new StringDecoder("utf8");
    this.child.stdout!.on("data", (data: Buffer) => this.output(decoder.write(data)));
    this.child.stderr!.on("data", (data: Buffer) => this.output(data.toString("utf8")));
    this.child.once("error", (error) => {
      this.output(`\r\nCouldn't start the terminal (python3 ${PTY}): ${error.message}\r\n`);
      this.exit(127);
    });
    this.child.once("exit", (code, signal) => this.exit(code ?? (signal ? 128 : 0)));
    for (const stream of [this.child.stdin, this.control]) stream?.on("error", () => {});
    this.armIdle();
  }

  get alive(): boolean {
    return this.exitStatus === null;
  }

  /** Sends the scrollback, then everything new, until the returned function is called. */
  listen(listener: Listener): () => void {
    clearTimeout(this.idleTimer);
    listener({ type: "data", data: this.chunks.join("") });
    if (this.exitStatus !== null) listener({ type: "exit", data: this.exitStatus });
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      this.armIdle();
    };
  }

  input(data: string): void {
    if (this.alive) this.child.stdin?.write(data);
  }

  resize(rows: number, cols: number): void {
    if (this.alive) this.control.write(`${rows} ${cols}\n`);
  }

  /** Hangs up: the shell gets SIGHUP when its pty closes. */
  close(): void {
    clearTimeout(this.idleTimer);
    if (this.alive) this.child.kill("SIGTERM");
    this.onGone();
  }

  private output(text: string): void {
    if (!text) return;
    this.chunks.push(text);
    this.size += text.length;
    while (this.size > SCROLLBACK_CHARS && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
    }
    for (const listener of this.listeners) listener({ type: "data", data: text });
  }

  private exit(status: number): void {
    if (this.exitStatus !== null) return;
    this.exitStatus = status;
    for (const listener of this.listeners) listener({ type: "exit", data: status });
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    if (this.listeners.size > 0) return;
    this.idleTimer = setTimeout(() => this.close(), IDLE_MS);
    this.idleTimer.unref();
  }
}

export class Terminals {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly environment: () => NodeJS.ProcessEnv;

  constructor(environment: () => NodeJS.ProcessEnv) {
    this.environment = environment;
  }

  create(rows: number, cols: number): TerminalSession {
    if (this.sessions.size >= MAX_SESSIONS) throw new Error(`At most ${MAX_SESSIONS} terminals.`);
    const clamp = (value: number, fallback: number) =>
      Number.isInteger(value) && value > 0 ? Math.min(value, 1000) : fallback;
    const session = new TerminalSession(this.environment(), clamp(rows, 24), clamp(cols, 80), () =>
      this.sessions.delete(session.id),
    );
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }

  list(): { id: string; alive: boolean; createdAt: number }[] {
    return [...this.sessions.values()].map(({ id, alive, createdAt }) => ({ id, alive, createdAt }));
  }

  closeAll(): void {
    for (const session of [...this.sessions.values()]) session.close();
  }
}

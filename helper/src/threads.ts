// Threads: the environment that binds a thread's processes (and the windows
// they open) to the thread, the thread's own X display, and the reverse
// lookup from a window's client pid to its thread.
//
// Moved here from the T3 Code fork (apps/server/src/plutonium.ts) so any
// frontend gets it.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

export const THREAD_ID_VARIABLE = "PLUTONIUM_THREAD_ID";
/** Where a thread's processes find the helper (its Unix socket). */
export const HELPER_VARIABLE = "PLUTONIUM_HELPER";
/**
 * Set ("1") on processes the user started (a terminal, a launcher): their
 * windows and links are brought to the front. An agent's processes go without
 * it, so what they open waits in the thread until someone asks for it.
 */
export const SHOW_VARIABLE = "PLUTONIUM_SHOW";

/** Whether an environment asks for its windows and links to be shown. */
export function wantsShow(environment: NodeJS.ProcessEnv): boolean {
  const value = environment[SHOW_VARIABLE];
  return value !== undefined && value !== "" && value !== "0";
}
// Enough to get from a GUI app through shells and wrappers to the agent.
const MAX_PARENT_DEPTH = 16;

export function findExecutable(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory && existsSync(join(directory, name))) return join(directory, name);
  }
  return undefined;
}

// X11 apps: one rootless Xwayland per thread, through xwayland-satellite,
// which shows X windows as Wayland toplevels on Exo. Exo sees the satellite as
// the client, so its windows resolve to the thread through the satellite's
// own PLUTONIUM_THREAD_ID. systemd-socket-activate holds the X socket and only
// starts the satellite (in its own process) when an X client first connects.
const X_DISPLAY_FIRST = 200;
const X_DISPLAY_LAST = 299;

const xSocketPath = (display: number) => `/tmp/.X11-unix/X${display}`;
const xLockPath = (display: number) => `/tmp/.X${display}-lock`;

function releaseXDisplay(display: number): void {
  for (const path of [xSocketPath(display), xLockPath(display)]) {
    try {
      unlinkSync(path);
    } catch {
      // Already gone.
    }
  }
}

export class Threads {
  readonly waylandDisplay: string;
  readonly helperSocket: string;
  /** The link openers' variables (opener.ts), for every thread. */
  openerVariables: Record<string, string> = {};
  private readonly xDisplays = new Map<string, { display: number; process: ChildProcess }>();

  constructor(waylandDisplay: string, helperSocket: string) {
    this.waylandDisplay = waylandDisplay;
    this.helperSocket = helperSocket;
  }

  /**
   * Variables that send a thread's GUI apps to Exo and tag them with the
   * thread. With `show`, the user started them: their windows are shown.
   */
  environment(threadId: string, { show = false } = {}): Record<string, string> {
    const xDisplay = this.xDisplay(threadId);
    return {
      ...this.openerVariables,
      [THREAD_ID_VARIABLE]: threadId,
      ...(show ? { [SHOW_VARIABLE]: "1" } : {}),
      [HELPER_VARIABLE]: this.helperSocket,
      WAYLAND_DISPLAY: this.waylandDisplay,
      GDK_BACKEND: "wayland",
      QT_QPA_PLATFORM: "wayland",
      MOZ_ENABLE_WAYLAND: "1",
      // SDL 3 otherwise picks X because Exo lacks wp_fifo_v1, and Minecraft's
      // GL setup fails there; SDL 2 prefers X. Both fall back to X in order.
      SDL_VIDEO_DRIVER: "wayland,x11",
      SDL_VIDEODRIVER: "wayland,x11",
      // X11-only apps (e.g. games on GLFW) get the thread's own X server
      // rather than the host desktop's.
      ...(xDisplay ? { DISPLAY: xDisplay } : {}),
    };
  }

  private xDisplay(threadId: string): string | undefined {
    const existing = this.xDisplays.get(threadId);
    if (existing) return `:${existing.display}`;
    if (process.platform !== "linux") return undefined;
    const satellite =
      process.env.PLUTONIUM_XWAYLAND_SATELLITE || findExecutable("xwayland-satellite");
    const activate = findExecutable("systemd-socket-activate");
    if (!satellite || !activate) return undefined;
    for (let display = X_DISPLAY_FIRST; display <= X_DISPLAY_LAST; display++) {
      if (existsSync(xSocketPath(display)) || existsSync(xLockPath(display))) continue;
      try {
        // Reserves the number; the format is what X servers write.
        writeFileSync(xLockPath(display), `${String(process.pid).padStart(10)}\n`, { flag: "wx" });
      } catch {
        continue;
      }
      const child = spawn(
        activate,
        [
          ...["XDG_RUNTIME_DIR", "PATH", "WAYLAND_DISPLAY", THREAD_ID_VARIABLE].flatMap((name) => [
            "-E",
            name,
          ]),
          "-l",
          xSocketPath(display),
          satellite,
          `:${display}`,
          "-listenfd",
          "3",
        ],
        {
          env: {
            ...process.env,
            WAYLAND_DISPLAY: this.waylandDisplay,
            [THREAD_ID_VARIABLE]: threadId,
          },
          stdio: "ignore",
        },
      );
      this.xDisplays.set(threadId, { display, process: child });
      child.once("exit", () => {
        if (this.xDisplays.get(threadId)?.process === child) this.xDisplays.delete(threadId);
        releaseXDisplay(display);
      });
      return `:${display}`;
    }
    return undefined;
  }

  /** Stops every thread's X server. */
  shutdown(): void {
    for (const { display, process: child } of this.xDisplays.values()) {
      child.kill();
      releaseXDisplay(display);
    }
    this.xDisplays.clear();
  }
}

/** A process's own thread tag and show flag (as at its exec). */
function readOrigin(pid: number): { threadId: string | undefined; show: boolean } | undefined {
  try {
    const environment: NodeJS.ProcessEnv = {};
    for (const line of readFileSync(`/proc/${pid}/environ`, "latin1").split("\0")) {
      const equals = line.indexOf("=");
      const name = line.slice(0, equals);
      if (name === THREAD_ID_VARIABLE || name === SHOW_VARIABLE) environment[name] = line.slice(equals + 1);
    }
    return { threadId: environment[THREAD_ID_VARIABLE] || undefined, show: wantsShow(environment) };
  } catch {
    // Gone, or not ours.
    return undefined;
  }
}

function readParentPid(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "latin1");
    // The command name is in parentheses and may contain spaces.
    const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    return parent > 1 ? parent : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The thread that started `pid` and whether that start asked to show its
 * windows: from the process's own environment, or the nearest ancestor with a
 * thread tag (for apps that clear their environment).
 */
function originForPid(pid: number): { threadId: string; show: boolean } | undefined {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 1) return undefined;
  let current: number | undefined = pid;
  for (let depth = 0; current !== undefined && depth < MAX_PARENT_DEPTH; depth++) {
    const origin = readOrigin(current);
    if (origin?.threadId) return { threadId: origin.threadId, show: origin.show };
    current = readParentPid(current);
  }
  return undefined;
}

/** The thread that started `pid`. */
export function threadForPid(pid: number): string | undefined {
  return originForPid(pid)?.threadId;
}

/** pids → thread ids. Pids that no thread started are left out. */
export function threadsForPids(pids: readonly number[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pid of pids.slice(0, 256)) {
    const threadId = threadForPid(pid);
    if (threadId) result[String(pid)] = threadId;
  }
  return result;
}

/** The pids whose start asked to show their windows (PLUTONIUM_SHOW), as `{"<pid>": true}`. */
export function showsForPids(pids: readonly number[]): Record<string, true> {
  const result: Record<string, true> = {};
  for (const pid of pids.slice(0, 256)) {
    if (originForPid(pid)?.show) result[String(pid)] = true;
  }
  return result;
}

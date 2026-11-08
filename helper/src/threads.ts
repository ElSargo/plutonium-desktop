// Threads: the environment that binds a thread's processes (and the windows
// they open) to the thread, the thread's own X display, and the reverse
// lookup from a window's client pid to its thread.
//
// Moved here from the T3 Code fork (apps/server/src/plutonium.ts) so any
// frontend gets it.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { ThreadBuses } from "./threadBus.ts";

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
// starts the satellite (in its own process, the same pid) when an X client
// first connects.
//
// The satellites outlive the helper, and the thread → display map is kept in
// a file, so a restarted helper takes them over: processes started before it
// keep a working DISPLAY. A satellite that is gone (Exo restarted, `plutonium
// stop`) is started again on the same display if a process still uses it.
const X_DISPLAY_FIRST = 200;
const X_DISPLAY_LAST = 299;
// How often a satellite another helper started is checked on.
const ADOPTED_CHECK_MS = 5_000;
const RESPAWN_DELAY_MS = 1_000;

export interface XDisplayOptions {
  /** The thread → display map (default: next to the helper's socket). */
  readonly statePath?: string;
  readonly satellite?: string;
  readonly activate?: string;
  /** Default /tmp/.X11-unix and /tmp (other values are for tests). */
  readonly socketDir?: string;
  readonly lockDir?: string;
  readonly first?: number;
  readonly last?: number;
  /** How often a satellite an earlier helper started is checked on (ms). */
  readonly adoptedCheckMs?: number;
}

interface XDisplay {
  readonly display: number;
  readonly pid: number;
  /** Absent for a satellite an earlier helper started. */
  readonly process?: ChildProcess;
}

interface XDisplayState {
  readonly waylandDisplay: string;
  readonly displays: Record<string, { display: number; pid: number }>;
}

/** Where a helper keeps its threads' X displays. */
export function xDisplayStatePath(waylandDisplay: string, helperSocket: string): string {
  return join(dirname(helperSocket), `${waylandDisplay}.x-displays.json`);
}

function readXDisplayState(path: string): XDisplayState | undefined {
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as XDisplayState;
    return typeof state.waylandDisplay === "string" && state.displays && typeof state.displays === "object"
      ? state
      : undefined;
  } catch {
    return undefined;
  }
}

class XFiles {
  readonly socketDir: string;
  readonly lockDir: string;
  constructor(options: XDisplayOptions) {
    this.socketDir = options.socketDir ?? "/tmp/.X11-unix";
    this.lockDir = options.lockDir ?? "/tmp";
  }
  socket(display: number): string {
    return join(this.socketDir, `X${display}`);
  }
  lock(display: number): string {
    return join(this.lockDir, `.X${display}-lock`);
  }
  inUse(display: number): boolean {
    return existsSync(this.socket(display)) || existsSync(this.lock(display));
  }
  /** Reserves `display` for `pid`; the format is what X servers write. */
  reserve(display: number, pid: number, exclusive = true): boolean {
    try {
      writeFileSync(this.lock(display), `${String(pid).padStart(10)}\n`, { flag: exclusive ? "wx" : "w" });
      return true;
    } catch {
      return false;
    }
  }
  /** Releases `display` if its server `pid` is gone, unless another server took the number. */
  releaseStale(display: number, pid: number): void {
    let lock = 0;
    try {
      lock = Number(readFileSync(this.lock(display), "latin1").trim());
    } catch {
      // No lock.
    }
    if (lock === pid || lock === 0 || !isAlive(lock)) this.release(display);
  }
  release(display: number): void {
    for (const path of [this.socket(display), this.lock(display)]) {
      try {
        unlinkSync(path);
      } catch {
        // Already gone.
      }
    }
  }
}

function readEnviron(pid: number): Map<string, string> | undefined {
  try {
    const environment = new Map<string, string>();
    for (const line of readFileSync(`/proc/${pid}/environ`, "latin1").split("\0")) {
      const equals = line.indexOf("=");
      if (equals > 0) environment.set(line.slice(0, equals), line.slice(equals + 1));
    }
    return environment;
  } catch {
    return undefined;
  }
}

/** Whether `pid` is the satellite (or its socket activator) for `threadId` on `display`. */
function isSatellite(pid: number, threadId: string, display: number, waylandDisplay: string, files: XFiles): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || !existsSync(files.socket(display))) return false;
  const environment = readEnviron(pid);
  if (environment?.get(THREAD_ID_VARIABLE) !== threadId) return false;
  if (environment.get("WAYLAND_DISPLAY") !== waylandDisplay) return false;
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "latin1").split("\0").includes(`:${display}`);
  } catch {
    return false;
  }
}

/** Whether a process of `threadId` other than `except` has DISPLAY=:`display`. */
function displayInUse(threadId: string, display: number, except: number): boolean {
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return false;
  }
  for (const name of pids) {
    const pid = Number(name);
    if (pid === except || pid === process.pid) continue;
    const environment = readEnviron(pid);
    if (environment?.get("DISPLAY") === `:${display}` && environment.get(THREAD_ID_VARIABLE) === threadId) return true;
  }
  return false;
}

/**
 * Stops the satellites a helper (no longer running) left, as `plutonium stop`
 * does. The map stays: the next helper starts them again for processes that
 * still use them.
 */
export function stopXDisplays(statePath: string, options: XDisplayOptions = {}): number {
  const state = readXDisplayState(statePath);
  if (!state) return 0;
  const files = new XFiles(options);
  let stopped = 0;
  for (const [threadId, { display, pid }] of Object.entries(state.displays)) {
    if (isSatellite(pid, threadId, display, state.waylandDisplay, files)) {
      try {
        process.kill(pid);
        stopped++;
      } catch {
        // Gone meanwhile.
      }
      files.release(display);
    } else {
      // Ended already (Exo going away ends them) with nobody to clean up.
      files.releaseStale(display, pid);
    }
  }
  return stopped;
}

export class Threads {
  readonly waylandDisplay: string;
  readonly helperSocket: string;
  /** The link openers' variables (opener.ts), for every thread. */
  openerVariables: Record<string, string> = {};
  private readonly xDisplays = new Map<string, XDisplay>();
  /** Satellites that ended, until they are started again or dropped. */
  private readonly departed = new Map<string, XDisplay>();
  private readonly xOptions: XDisplayOptions;
  private readonly xFiles: XFiles;
  private readonly statePath: string;
  private adoptedCheck: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  /** The threads' own session buses (threadBus.ts), if they get them. */
  private readonly buses: ThreadBuses | undefined;

  constructor(waylandDisplay: string, helperSocket: string, xOptions: XDisplayOptions = {}, buses?: ThreadBuses) {
    this.waylandDisplay = waylandDisplay;
    this.buses = buses;
    this.helperSocket = helperSocket;
    this.xOptions = xOptions;
    this.xFiles = new XFiles(xOptions);
    this.statePath = xOptions.statePath ?? xDisplayStatePath(waylandDisplay, helperSocket);
    if (process.platform === "linux") this.restore();
  }

  /**
   * Variables that send a thread's GUI apps to Exo and tag them with the
   * thread. With `show`, the user started them: their windows are shown.
   */
  environment(threadId: string, { show = false } = {}): Record<string, string> {
    const xDisplay = this.xDisplay(threadId);
    const bus = this.buses?.environment(threadId, THREAD_ID_VARIABLE) ?? {};
    return {
      ...this.openerVariables,
      [THREAD_ID_VARIABLE]: threadId,
      ...(show ? { [SHOW_VARIABLE]: "1" } : {}),
      [HELPER_VARIABLE]: this.helperSocket,
      WAYLAND_DISPLAY: this.waylandDisplay,
      GDK_BACKEND: "wayland",
      QT_QPA_PLATFORM: "wayland",
      // GTK 4 speaks text-input-v3 (IME.md, and Pluto Vim's native fields) only with its
      // Wayland input method; without it, it binds no text input at all. An IM the user
      // chose (ibus, fcitx) stays.
      ...(process.env.GTK_IM_MODULE ? {} : { GTK_IM_MODULE: "wayland" }),
      // Qt 6 follows the settings portal's light or dark (APPEARANCE.md) only
      // with this platform theme; its generic one never does. Its file dialogs
      // go through the portal too, like GTK's below. A theme the user chose
      // (qt6ct, kde) stays.
      ...(process.env.QT_QPA_PLATFORMTHEME ? {} : { QT_QPA_PLATFORMTHEME: "xdgdesktopportal" }),
      MOZ_ENABLE_WAYLAND: "1",
      // Apps' file dialogs through the portal, so the desktop's picker: GTK 3 and
      // Firefox, GTK 4. An app that draws its own GtkFileChooserDialog keeps it.
      GTK_USE_PORTAL: "1",
      GDK_DEBUG: "portals",
      // Electron apps run on Wayland too: on the thread's own X server, an
      // app's screen capture (Discord's) would only see that server's windows.
      // Electron 38 and later ignore the hint and go by the session type.
      ELECTRON_OZONE_PLATFORM_HINT: "wayland",
      XDG_SESSION_TYPE: "wayland",
      // SDL 3 otherwise picks X because Exo lacks wp_fifo_v1, and Minecraft's
      // GL setup fails there; SDL 2 prefers X. Both fall back to X in order.
      SDL_VIDEO_DRIVER: "wayland,x11",
      SDL_VIDEODRIVER: "wayland,x11",
      // X11-only apps (e.g. games on GLFW) get the thread's own X server
      // rather than the host desktop's.
      ...(xDisplay ? { DISPLAY: xDisplay } : {}),
      // Single-instance apps (LibreOffice, GApplications) get an instance per
      // thread rather than handing their arguments to another thread's.
      ...bus,
    };
  }

  /** Each thread's X display number. */
  displays(): Record<string, number> {
    return Object.fromEntries([...this.xDisplays].map(([threadId, { display }]) => [threadId, display]));
  }

  private tools(): { satellite: string; activate: string } | undefined {
    const satellite =
      this.xOptions.satellite ?? (process.env.PLUTONIUM_XWAYLAND_SATELLITE || findExecutable("xwayland-satellite"));
    const activate = this.xOptions.activate ?? findExecutable("systemd-socket-activate");
    return satellite && activate ? { satellite, activate } : undefined;
  }

  private xDisplay(threadId: string): string | undefined {
    const existing = this.xDisplays.get(threadId);
    if (existing) return `:${existing.display}`;
    if (process.platform !== "linux" || !this.tools()) return undefined;
    // The display its processes already have, if its satellite just ended.
    const previous = this.departed.get(threadId);
    if (previous && !this.xFiles.inUse(previous.display) && this.startSatellite(threadId, previous.display)) {
      return `:${previous.display}`;
    }
    for (let display = this.xOptions.first ?? X_DISPLAY_FIRST; display <= (this.xOptions.last ?? X_DISPLAY_LAST); display++) {
      if (this.xFiles.inUse(display)) continue;
      if (this.startSatellite(threadId, display)) return `:${display}`;
    }
    return undefined;
  }

  /** Starts `threadId`'s satellite on `display`, if it's free. */
  private startSatellite(threadId: string, display: number): boolean {
    const tools = this.tools();
    if (!tools || !this.xFiles.reserve(display, process.pid)) return false;
    const child = spawn(
      tools.activate,
      [
        ...["XDG_RUNTIME_DIR", "PATH", "WAYLAND_DISPLAY", THREAD_ID_VARIABLE].flatMap((name) => ["-E", name]),
        "-l",
        this.xFiles.socket(display),
        tools.satellite,
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
        // Not in the helper's process group: it outlives the helper.
        detached: true,
      },
    );
    if (child.pid === undefined) {
      this.xFiles.release(display);
      return false;
    }
    // The lock names the server, as X servers' own do.
    this.xFiles.reserve(display, child.pid, false);
    const entry: XDisplay = { display, pid: child.pid, process: child };
    this.xDisplays.set(threadId, entry);
    this.departed.delete(threadId);
    child.once("exit", () => this.satelliteExited(threadId, entry));
    this.save();
    return true;
  }

  private satelliteExited(threadId: string, entry: XDisplay): void {
    if (this.stopped || this.xDisplays.get(threadId) !== entry) return;
    this.xDisplays.delete(threadId);
    this.xFiles.release(entry.display);
    // Kept in the map until it's clear nobody uses it: Exo going away ends the
    // satellite, and the helper may be stopped next (the next one restores it).
    this.departed.set(threadId, entry);
    // Its thread's processes keep the display: give them a new satellite there.
    setTimeout(() => {
      if (this.stopped || this.departed.get(threadId) !== entry) return;
      this.departed.delete(threadId);
      if (this.xDisplays.has(threadId) || !displayInUse(threadId, entry.display, entry.pid)) this.save();
      else if (!this.startSatellite(threadId, entry.display)) this.save();
    }, RESPAWN_DELAY_MS).unref();
  }

  /** Takes over the satellites of the helper before this one, or starts them again. */
  private restore(): void {
    const state = readXDisplayState(this.statePath);
    if (!state || state.waylandDisplay !== this.waylandDisplay) return;
    for (const [threadId, { display, pid }] of Object.entries(state.displays)) {
      if (isSatellite(pid, threadId, display, this.waylandDisplay, this.xFiles)) {
        this.xDisplays.set(threadId, { display, pid });
        continue;
      }
      // Gone: its files are stale.
      this.xFiles.releaseStale(display, pid);
      if (displayInUse(threadId, display, pid)) this.startSatellite(threadId, display);
    }
    this.save();
    if ([...this.xDisplays.values()].some((entry) => !entry.process)) {
      this.adoptedCheck = setInterval(() => this.checkAdopted(), this.xOptions.adoptedCheckMs ?? ADOPTED_CHECK_MS);
      this.adoptedCheck.unref();
    }
  }

  private checkAdopted(): void {
    let adopted = 0;
    for (const [threadId, entry] of this.xDisplays) {
      if (entry.process) continue;
      if (isSatellite(entry.pid, threadId, entry.display, this.waylandDisplay, this.xFiles)) adopted++;
      else this.satelliteExited(threadId, entry);
    }
    if (adopted === 0) clearInterval(this.adoptedCheck);
  }

  private save(): void {
    const state: XDisplayState = {
      waylandDisplay: this.waylandDisplay,
      displays: Object.fromEntries(
        [...this.departed, ...this.xDisplays].map(([threadId, { display, pid }]) => [threadId, { display, pid }]),
      ),
    };
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      const temporary = `${this.statePath}.${process.pid}`;
      writeFileSync(temporary, `${JSON.stringify(state)}\n`);
      renameSync(temporary, this.statePath);
    } catch (error) {
      console.error(`plutoniumd: could not save the threads' X displays: ${(error as Error).message}`);
    }
  }

  /**
   * The helper is stopping: its threads' X servers keep running for the next
   * helper (`stopXDisplays` stops them).
   */
  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.adoptedCheck);
    this.save();
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
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
 * The processes the helper started, while they run. Some apps blank their
 * environment in /proc (Electron 43 does, for its process title), and those
 * the helper starts have no tagged parent to fall back on.
 */
const launched = new Map<number, { threadId: string; show: boolean }>();

/** `child`, which the helper started for `threadId`, until it exits. */
export function rememberLaunch(child: ChildProcess, threadId: string, show: boolean): void {
  const pid = child.pid;
  if (pid === undefined) return;
  launched.set(pid, { threadId, show });
  child.once("exit", () => {
    if (launched.get(pid)?.threadId === threadId) launched.delete(pid);
  });
}

/**
 * The thread that started `pid` and whether that start asked to show its
 * windows: from the process's own environment, or the nearest ancestor with a
 * thread tag (for apps that clear their environment).
 */
function originForPid(pid: number): { threadId: string; show: boolean } | undefined {
  return traceOrigin(pid).origin;
}

/** originForPid, and how it was found (or why not), for the logs. */
function traceOrigin(pid: number): { origin?: { threadId: string; show: boolean }; how: string } {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 1) {
    return { how: "the client's pid is unknown" };
  }
  let current: number | undefined = pid;
  let unreadable = 0;
  for (let depth = 0; current !== undefined && depth < MAX_PARENT_DEPTH; depth++) {
    const origin = readOrigin(current);
    if (!origin) unreadable++;
    if (origin?.threadId) {
      return { origin: { threadId: origin.threadId, show: origin.show }, how: `from pid ${current}'s environment` };
    }
    const started = launched.get(current);
    if (started) return { origin: { ...started }, how: `pid ${current} is one the helper started` };
    current = readParentPid(current);
  }
  if (unreadable > 0 && !existsSync(`/proc/${pid}`)) return { how: `pid ${pid} is gone` };
  return {
    how:
      unreadable > 0
        ? `no thread tag in pid ${pid} or its parents (${unreadable} environment(s) unreadable)`
        : `no thread tag in pid ${pid} or its parents`,
  };
}

/** The thread that started `pid`, and how that was found or why none was, for the logs. */
export function explainPid(pid: number): { threadId: string | undefined; how: string } {
  const { origin, how } = traceOrigin(pid);
  return { threadId: origin?.threadId, how };
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

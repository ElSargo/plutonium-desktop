// Pluto Vim's register store (PLUTO_VIM.md, Registers): every page's engine
// shares it through vimInject.ts's binding, so a yank in one tab puts in
// another. It lives in the helper's memory only and never touches the disk:
// registers hold whatever you yanked, passwords included. They go when the
// helper does.
//
// A register's scope (vim.registers.scope) picks which copy a call reads and
// writes: global, the field's thread (its tab's thread tag), or the thread's
// project. A field with no thread, or a thread with no project, uses global.
//
// "+ is the system clipboard and "* the primary selection (what's selected,
// what middle-click pastes): Exo's, through wl-clipboard (Exo has
// ext_data_control_v1 and zwp_primary_selection_v1, WAYLAND_PROTOCOLS.md).
// Without wl-clipboard they're ordinary global registers.
import { spawn } from "node:child_process";

export interface RegisterValue {
  readonly text: string;
  readonly linewise: boolean;
}

export type RegisterScope = "global" | "project" | "thread";

/** Where a field is: its thread and the thread's project, if it has them. */
export interface RegisterPlace {
  readonly thread?: string | null;
  readonly project?: string | null;
}

export interface Clipboard {
  /** `primary`: the primary selection ("*), not the clipboard ("+). */
  read(primary?: boolean): Promise<string | null>;
  write(text: string, primary?: boolean): Promise<void>;
}

/** The registers the engine keeps in the store (lowercase: capitals append, in the engine). */
const NAMES = /^[a-z0-9"\-.:/+*]$/;
/** The most text one register holds (a yank of more is cut). */
export const MAX_TEXT = 8 * 1024 * 1024;

export class RegisterStore {
  private readonly values = new Map<string, RegisterValue>();
  private readonly clipboard: Clipboard | null;

  constructor(options: { clipboard?: Clipboard | null } = {}) {
    this.clipboard = options.clipboard ?? null;
  }

  /** The copy a call means: "global", "thread:<id>" or "project:<id>". */
  static key(scope: string, place: RegisterPlace): string {
    if (scope === "thread" && place.thread) return `thread:${place.thread}`;
    if (scope === "project" && place.project) return `project:${place.project}`;
    return "global";
  }

  async get(name: string, scope: string, place: RegisterPlace = {}): Promise<RegisterValue | null> {
    if (!NAMES.test(name)) throw new Error(`not a register: ${JSON.stringify(name)}`);
    const system = name === "+" || name === "*";
    if (system && this.clipboard) {
      const text = await this.clipboard.read(name === "*").catch(() => null);
      if (text != null) return fromClipboard(text);
    }
    return this.values.get(`${RegisterStore.key(system ? "global" : scope, place)}\0${name}`) ?? null;
  }

  async set(name: string, value: unknown, scope: string, place: RegisterPlace = {}): Promise<void> {
    if (!NAMES.test(name)) throw new Error(`not a register: ${JSON.stringify(name)}`);
    const checked = checkValue(value);
    const system = name === "+" || name === "*";
    const key = `${RegisterStore.key(system ? "global" : scope, place)}\0${name}`;
    this.values.set(key, checked);
    if (system && this.clipboard) await this.clipboard.write(checked.linewise ? `${checked.text}\n` : checked.text, name === "*");
  }

  /** How many registers are held, for tests. */
  get size(): number {
    return this.values.size;
  }
}

function checkValue(value: unknown): RegisterValue {
  const v = value as { text?: unknown; linewise?: unknown } | null;
  if (!v || typeof v.text !== "string") throw new Error("a register's value is { text, linewise }");
  return { text: v.text.length > MAX_TEXT ? v.text.slice(0, MAX_TEXT) : v.text, linewise: Boolean(v.linewise) };
}

/** Clipboard text as a register: a trailing newline makes it linewise, as in vim. */
export function fromClipboard(text: string): RegisterValue {
  if (text.endsWith("\n")) return { text: text.slice(0, -1), linewise: true };
  return { text, linewise: false };
}

const CLIPBOARD_TIMEOUT_MS = 1000;

/** The system clipboard through wl-paste and wl-copy, on `waylandDisplay`; null without them. */
export function wlClipboard(waylandDisplay: string, find: (name: string) => string | undefined): Clipboard | null {
  const paste = find("wl-paste");
  const copy = find("wl-copy");
  if (!paste || !copy) return null;
  const env = { ...process.env, WAYLAND_DISPLAY: waylandDisplay };
  return {
    read: (primary = false) =>
      new Promise((resolve) => {
        const child = spawn(paste, [...(primary ? ["--primary"] : []), "--type", "text"], { env, stdio: ["ignore", "pipe", "ignore"] });
        const chunks: Buffer[] = [];
        const timer = setTimeout(() => child.kill(), CLIPBOARD_TIMEOUT_MS);
        child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
        child.on("error", () => resolve(null));
        child.on("close", (code) => {
          clearTimeout(timer);
          // 1: nothing is copied, or no text in it.
          resolve(code === 0 ? Buffer.concat(chunks).toString("utf8") : null);
        });
      }),
    write: (text, primary = false) =>
      new Promise((resolve) => {
        // wl-copy serves the selection from a child of its own; this one exits once it's offered.
        const child = spawn(copy, [...(primary ? ["--primary"] : []), "--type", "text/plain;charset=utf-8"], { env, stdio: ["pipe", "ignore", "ignore"] });
        const timer = setTimeout(() => child.kill(), CLIPBOARD_TIMEOUT_MS);
        child.on("error", () => resolve());
        child.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.stdin.end(text);
      }),
  };
}

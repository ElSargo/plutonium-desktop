// Light and dark (docs/features/APPEARANCE.md). The setting itself is the
// appearance service's (services/appearance.ts); this file has what it works
// with:
//
// - HostAppearance: another desktop's color scheme, for a session in a
//   window on it: the settings portal's org.freedesktop.appearance
//   color-scheme, which GNOME, KDE and the other desktops set (or, without a
//   working portal, GNOME's dconf key). It reads it and watches it.
// - GTK's themes: a theme's light or dark variant, and GTK's settings.ini.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import { DBusConnection, type Message } from "./dbus.ts";

const PORTAL = "org.freedesktop.portal.Desktop";
const PORTAL_PATH = "/org/freedesktop/portal/desktop";
const SETTINGS = "org.freedesktop.portal.Settings";
const NAMESPACE = "org.freedesktop.appearance";
const KEY = "color-scheme";
export const DCONF_INTERFACE = "/org/gnome/desktop/interface/";
const DCONF_KEY = `${DCONF_INTERFACE}color-scheme`;
const run = promisify(execFile);

export type ColorScheme = "light" | "dark";

/** The portal's color-scheme for a scheme: 1 prefers dark, 2 prefers light. */
export function portalColorScheme(scheme: ColorScheme): number {
  return scheme === "dark" ? 1 : 2;
}

/** GNOME's color-scheme for a scheme ('default' is light, as GNOME's Settings writes it). */
export function dconfColorScheme(scheme: ColorScheme): string {
  return scheme === "dark" ? "prefer-dark" : "default";
}

/** dconf's quoted string ('Adwaita', as `dconf read` prints it) unquoted; undefined for nothing or not a string. */
export function dconfString(value: string): string | undefined {
  const match = /^'(.*)'$/s.exec(value.trim());
  return match ? match[1]!.replace(/\\(.)/g, "$1") : undefined;
}

/** A string as dconf takes it ('…', quoted). */
export function dconfQuote(value: string): string {
  return `'${value.replace(/[\\']/g, (char) => `\\${char}`)}'`;
}

/** The portal's color-scheme: 1 is dark; 0 (no preference) and 2 are light. */
export function isDark(value: unknown): boolean {
  return Number(value) === 1;
}

/** GNOME's dconf value ('prefer-dark', 'default', 'prefer-light'; quoted as dconf prints it). */
export function isDarkDconf(value: string): boolean {
  return value.trim().replace(/^'|'$/g, "") === "prefer-dark";
}

/** Another desktop's color scheme: its settings portal, else GNOME's dconf key. */
export class HostAppearance {
  private bus: DBusConnection | null = null;
  private watcher: ChildProcess | null = null;
  /** The host's scheme, once read: null until then, or without a portal. */
  private dark: boolean | null = null;
  private readonly listeners = new Set<(dark: boolean) => void>();

  /**
   * `address`: the bus the portal is on (default $PLUTONIUM_APPEARANCE_BUS, a
   * test's fake portal, then $DBUS_SESSION_BUS_ADDRESS).
   */
  private readonly address: string | undefined;

  constructor(address?: string) {
    this.address = address;
  }

  /** Reads the setting and watches it. Without a session bus or portal, nothing changes. */
  async start(): Promise<void> {
    const address = this.address ?? process.env.PLUTONIUM_APPEARANCE_BUS ?? process.env.DBUS_SESSION_BUS_ADDRESS;
    if (!address) return;
    try {
      const bus = await DBusConnection.connect(address);
      this.bus = bus;
      bus.onSignal = (message) => this.onSignal(message);
      await bus.call({
        destination: "org.freedesktop.DBus",
        path: "/org/freedesktop/DBus",
        interface: "org.freedesktop.DBus",
        member: "AddMatch",
        signature: "s",
        body: [`type='signal',interface='${SETTINGS}',member='SettingChanged',arg0='${NAMESPACE}'`],
      });
      this.set(isDark(await this.read(bus)));
    } catch (error) {
      this.bus?.close();
      this.bus = null;
      if (!(await this.startDconf())) {
        console.warn(`plutoniumd: no host color scheme (the settings portal): ${(error as Error).message}`);
      }
    }
  }

  stop(): void {
    this.bus?.close();
    this.bus = null;
    this.watcher?.kill();
    this.watcher = null;
  }

  /** GNOME's key through dconf ($PLUTONIUM_DCONF, a test's, else dconf on PATH); false without it. */
  private async startDconf(): Promise<boolean> {
    const dconf = process.env.PLUTONIUM_DCONF ?? "dconf";
    let value: string;
    try {
      value = (await run(dconf, ["read", DCONF_KEY])).stdout;
    } catch {
      return false;
    }
    if (!value.trim()) return false;
    this.set(isDarkDconf(value));
    // `dconf watch` prints the key, then its new value, on each change.
    const watcher = spawn(dconf, ["watch", DCONF_KEY], { stdio: ["ignore", "pipe", "ignore"] });
    watcher.on("error", () => {});
    createInterface({ input: watcher.stdout! }).on("line", (line) => {
      if (line.trim() && !line.startsWith("/")) this.set(isDarkDconf(line));
    });
    this.watcher = watcher;
    console.log(`plutoniumd: the host's color scheme from dconf (${value.trim()})`);
    return true;
  }

  /** The host's scheme, if known. */
  get current(): boolean | null {
    return this.dark;
  }

  /** Calls `listener` with each change. */
  onChange(listener: (dark: boolean) => void): void {
    this.listeners.add(listener);
  }

  private async read(bus: DBusConnection): Promise<unknown> {
    const call = (member: string) =>
      bus.call({ destination: PORTAL, path: PORTAL_PATH, interface: SETTINGS, member, signature: "ss", body: [NAMESPACE, KEY] });
    // ReadOne is version 2's; Read (the value in one more variant) is older.
    const [value] = await call("ReadOne").catch(() => call("Read"));
    return value;
  }

  private onSignal(message: Message): void {
    const [namespace, key, value] = message.body ?? [];
    if (message.member === "SettingChanged" && namespace === NAMESPACE && key === KEY) this.set(isDark(value));
  }

  private set(dark: boolean): void {
    if (this.dark === dark) return;
    this.dark = dark;
    for (const listener of this.listeners) listener(dark);
  }
}

// ---------------------------------------------------------------- GTK's themes

/** Themes GTK 3 has built in. */
const BUILTIN_GTK_THEMES = new Set(["Adwaita", "Adwaita-dark", "HighContrast", "HighContrastInverse"]);

/** The XDG data dirs, the user's first. */
export function dataDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    ...(env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(Boolean),
  ];
}

/** Whether a GTK theme (a gtk-3.0 folder) or an icon theme (an index.theme) of that name is installed. */
export function themeInstalled(kind: "gtk" | "icons", name: string, dirs: readonly string[] = dataDirs()): boolean {
  if (!name || name.includes("/") || name.startsWith(".")) return false;
  if (kind === "gtk" && BUILTIN_GTK_THEMES.has(name)) return true;
  const roots = [join(homedir(), kind === "gtk" ? ".themes" : ".icons"), ...dirs.map((dir) => join(dir, kind === "gtk" ? "themes" : "icons"))];
  return roots.some((root) => existsSync(join(root, name, kind === "gtk" ? "gtk-3.0" : "index.theme")));
}

const DARK_SUFFIX = /[-_]?dark$/i;

/**
 * A theme's variant for the scheme: `name` if it is one already
 * (adw-gtk3-dark for dark), else its counterpart if `installed` says there is
 * one (adw-gtk3 and adw-gtk3-dark, Breeze and Breeze-Dark, breeze and
 * breeze-dark), else null: a theme without a variant is left as it is.
 */
export function themeVariant(name: string, scheme: ColorScheme, installed: (name: string) => boolean): string | null {
  const dark = scheme === "dark";
  if (DARK_SUFFIX.test(name) === dark) return name;
  if (!dark) {
    const base = name.replace(DARK_SUFFIX, "");
    return base && installed(base) ? base : null;
  }
  return [`${name}-dark`, `${name}-Dark`, `${name}Dark`].find(installed) ?? null;
}

/** A key's value in a GTK settings.ini's [Settings], if it has it. */
export function iniValue(text: string, key: string): string | undefined {
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header) section = header[1]!;
    else if (section === "Settings" && line.includes("=") && line.slice(0, line.indexOf("=")).trim() === key) {
      return line.slice(line.indexOf("=") + 1).trim();
    }
  }
  return undefined;
}

/** A GTK settings.ini with `key` in [Settings] set to `value` (added if it isn't there). */
export function setIniValue(text: string, key: string, value: string): string {
  const lines = text.split("\n");
  let section = "";
  let settings = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1]!;
      if (section === "Settings" && settings < 0) settings = i;
    } else if (section === "Settings" && line.includes("=") && line.slice(0, line.indexOf("=")).trim() === key) {
      lines[i] = `${key}=${value}`;
      return lines.join("\n");
    }
  }
  if (settings >= 0) {
    lines.splice(settings + 1, 0, `${key}=${value}`);
    return lines.join("\n");
  }
  return `${text}${text && !text.endsWith("\n") ? "\n" : ""}[Settings]\n${key}=${value}\n`;
}

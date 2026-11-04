// The host's files, for the shell's file picker (TAB_FEATURES.md, "File
// pickers"). The helper runs as the user, so it lists what the user can see,
// and the paths it gives are the ones Ash opens: Ash on the host, or a
// container that mounts the user's home at the same path.
import { existsSync, readFileSync, statSync } from "node:fs";
import { lstat, mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

export interface FileEntry {
  readonly name: string;
  readonly path: string;
  /** "dir" for a folder (or a link to one), else "file". */
  readonly kind: "dir" | "file";
  readonly size: number;
  /** Last modified, ms since the epoch. */
  readonly modified: number;
  /** A dot file. */
  readonly hidden: boolean;
  /** A symbolic link (`kind` is what it points at). */
  readonly link?: boolean;
}

export interface DirectoryListing {
  readonly dir: string;
  /** The folder above, or null at the root. */
  readonly parent: string | null;
  readonly entries: readonly FileEntry[];
}

export interface Place {
  readonly name: string;
  readonly path: string;
  /** "home", "desktop", "documents", "downloads", "music", "pictures", "videos", "root". */
  readonly kind: string;
}

/** Why a listing failed, with the HTTP status that says so. */
export class FilesError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function checkedPath(path: string): string {
  if (!path || !isAbsolute(path)) throw new FilesError(400, "The path must be absolute.");
  return normalize(path);
}

function failure(error: unknown, path: string): FilesError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return new FilesError(404, `${path} doesn't exist.`);
  if (code === "ENOTDIR") return new FilesError(400, `${path} isn't a folder.`);
  if (code === "EACCES" || code === "EPERM") return new FilesError(403, `${path} can't be read.`);
  if (code === "EEXIST") return new FilesError(409, `${path} already exists.`);
  return new FilesError(500, (error as Error).message);
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Folder `dir`'s entries: folders first, then by name. Dot files only with `hidden`. */
export async function listDirectory(dir: string, { hidden = false } = {}): Promise<DirectoryListing> {
  dir = checkedPath(dir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    throw failure(error, dir);
  }
  const entries = await Promise.all(
    names
      .filter((name) => hidden || !name.startsWith("."))
      .map(async (name): Promise<FileEntry | null> => {
        const path = join(dir, name);
        try {
          // Follows links: a link to a folder opens like a folder.
          const [info, own] = await Promise.all([stat(path), lstat(path)]);
          return {
            name,
            path,
            kind: info.isDirectory() ? "dir" : "file",
            size: info.isDirectory() ? 0 : info.size,
            modified: info.mtimeMs,
            hidden: name.startsWith("."),
            ...(own.isSymbolicLink() ? { link: true } : {}),
          };
        } catch {
          // A dangling link, or gone meanwhile.
          return null;
        }
      }),
  );
  return {
    dir,
    parent: dir === "/" ? null : dirname(dir),
    entries: entries
      .filter((entry): entry is FileEntry => entry !== null)
      .sort((a, b) => (a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === "dir" ? -1 : 1)),
  };
}

/**
 * How many files a folder upload of `dir` sends, as Chrome counts them: every file under
 * it, dot files too, without following links to folders. Stops at `limit` (`more` is then
 * true).
 */
export async function countFiles(dir: string, limit = 100_000): Promise<{ dir: string; files: number; more: boolean }> {
  dir = checkedPath(dir);
  let files = 0;
  const pending = [dir];
  try {
    await readdir(dir);
  } catch (error) {
    throw failure(error, dir);
  }
  while (pending.length && files < limit) {
    const folder = pending.pop()!;
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      continue; // Unreadable: Chrome skips it too.
    }
    for (const entry of entries) {
      if (entry.isDirectory()) pending.push(join(folder, entry.name));
      else files++;
    }
  }
  return { dir, files: Math.min(files, limit), more: files >= limit && pending.length > 0 };
}

/** Makes folder `path` (its parent must exist). */
export async function makeFolder(path: string): Promise<{ path: string }> {
  path = checkedPath(path);
  try {
    await mkdir(path);
  } catch (error) {
    throw failure(error, path);
  }
  return { path };
}

// $XDG_CONFIG_HOME/user-dirs.dirs: XDG_DOWNLOAD_DIR="$HOME/Downloads".
function userDirs(home: string): Map<string, string> {
  const dirs = new Map<string, string>();
  const config = process.env.XDG_CONFIG_HOME || join(home, ".config");
  let text = "";
  try {
    text = readFileSync(join(config, "user-dirs.dirs"), "utf8");
  } catch {
    // None: the usual names.
  }
  for (const match of text.matchAll(/^XDG_(\w+)_DIR="([^"]*)"/gm)) {
    const value = normalize(match[2]!.replace(/^\$HOME/, home)).replace(/(.)\/$/, "$1");
    if (isAbsolute(value) && value !== home) dirs.set(match[1]!.toLowerCase(), value);
  }
  return dirs;
}

const USER_DIRS: readonly [kind: string, name: string][] = [
  ["desktop", "Desktop"],
  ["documents", "Documents"],
  ["download", "Downloads"],
  ["music", "Music"],
  ["pictures", "Pictures"],
  ["videos", "Videos"],
];

/** Home, the XDG user folders that exist, and the root. */
export function places(home = homedir()): Place[] {
  const dirs = userDirs(home);
  const found: Place[] = [{ name: "Home", path: home, kind: "home" }];
  for (const [kind, name] of USER_DIRS) {
    const path = dirs.get(kind) ?? join(home, name);
    if (existsSync(path)) {
      found.push({ name: path.split("/").pop() || name, path, kind: kind === "download" ? "downloads" : kind });
    }
  }
  found.push({ name: "Computer", path: "/", kind: "root" });
  return found;
}

/**
 * The files GTK apps (and others) recently opened, newest first, from
 * recently-used.xbel: those that still exist.
 */
export function recentFiles(limit = 30, home = homedir()): FileEntry[] {
  const data = process.env.XDG_DATA_HOME || join(home, ".local/share");
  let text = "";
  try {
    text = readFileSync(join(data, "recently-used.xbel"), "utf8");
  } catch {
    return [];
  }
  const recent: { path: string; modified: number }[] = [];
  for (const match of text.matchAll(/<bookmark\b([^>]*)>/g)) {
    const attributes = match[1]!;
    const href = /\bhref="([^"]*)"/.exec(attributes)?.[1];
    if (!href?.startsWith("file://")) continue;
    let path: string;
    try {
      path = fileURLToPath(href.replaceAll("&amp;", "&"));
    } catch {
      continue;
    }
    const when = ["visited", "modified", "added"]
      .map((name) => new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1])
      .find(Boolean);
    recent.push({ path, modified: when ? Date.parse(when) || 0 : 0 });
  }
  recent.sort((a, b) => b.modified - a.modified);
  const entries: FileEntry[] = [];
  const seen = new Set<string>();
  for (const { path } of recent) {
    if (entries.length >= limit) break;
    if (seen.has(path)) continue;
    seen.add(path);
    const info = statSync(path, { throwIfNoEntry: false });
    if (!info || info.isDirectory()) continue;
    const name = path.split("/").pop()!;
    entries.push({ name, path, kind: "file", size: info.size, modified: info.mtimeMs, hidden: name.startsWith(".") });
  }
  return entries;
}

// What the file manager does to the host's files (docs/features/FILE_MANAGER.md):
// copying, moving, linking, the freedesktop trash and deleting as jobs a shell can
// watch and cancel, renaming and new files, an index of a folder for the fuzzy
// finder, and a text preview. The helper runs as the user, so this is what the user
// could do in a terminal, and only a shell page reaches it (daemon.ts).
import { spawn } from "node:child_process";
import { constants, createReadStream, watch, type FSWatcher } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { FilesError } from "./files.ts";

export type FileOp = "copy" | "move" | "link" | "trash" | "delete" | "restore";
/** What a name already taken in the target does: a new name, replace it, leave it, or stop. */
export type Conflict = "rename" | "overwrite" | "skip" | "fail";

export interface FileJobRequest {
  readonly op: FileOp;
  readonly paths: readonly string[];
  /** The folder copies, moves and links go to. */
  readonly target?: string;
  readonly conflict?: Conflict;
}

export interface FileJob {
  readonly id: number;
  readonly op: FileOp;
  state: "running" | "done" | "failed" | "cancelled";
  /** Bytes (or, for a trash or delete, items) in all, and so far. */
  total: number;
  done: number;
  /** The item being worked on. */
  current: string;
  /** Each top-level item and where it went ("" if it's gone): what an undo needs. */
  results: { from: string; to: string }[];
  error?: string;
}

function absolute(path: unknown): string {
  if (typeof path !== "string" || !path || !isAbsolute(path)) throw new FilesError(400, "The path must be absolute.");
  return normalize(path).replace(/(.)\/+$/, "$1");
}

/** A path no job may remove or move: the root, the home folder and what holds it. */
function protectedPath(path: string, home = homedir()): boolean {
  return path === "/" || path === home || home.startsWith(`${path}${sep}`);
}

function failure(error: unknown, path: string): FilesError {
  if (error instanceof FilesError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return new FilesError(404, `${path} doesn't exist.`);
  if (code === "EACCES" || code === "EPERM") return new FilesError(403, `${path}: not allowed.`);
  if (code === "EEXIST" || code === "ENOTEMPTY") return new FilesError(409, `${path} already exists.`);
  if (code === "ENOSPC") return new FilesError(507, "There is no space left on that disk.");
  return new FilesError(500, (error as Error).message);
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

/** `name` in `dir`, or "name (2).ext" and so on if it's taken. */
export async function freeName(dir: string, name: string): Promise<string> {
  const extension = extname(name);
  const stem = extension && extension !== name ? name.slice(0, -extension.length) : name;
  const suffix = stem === name ? "" : extension;
  let candidate = join(dir, name);
  for (let n = 2; await exists(candidate); n++) candidate = join(dir, `${stem} (${n})${suffix}`);
  return candidate;
}

async function sizeOf(path: string): Promise<number> {
  const info = await lstat(path);
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const name of await readdir(path)) total += await sizeOf(join(path, name));
  return total;
}

class Cancelled extends Error {}

/** Copies `from` to `to`, keeping links as links and modes and times. */
async function copyTree(from: string, to: string, job: FileJob, cancelled: () => boolean): Promise<void> {
  if (cancelled()) throw new Cancelled();
  job.current = from;
  const info = await lstat(from);
  if (info.isSymbolicLink()) {
    await symlink(await readlink(from), to);
    job.done += info.size;
  } else if (info.isDirectory()) {
    await mkdir(to, { recursive: true });
    for (const name of await readdir(from)) await copyTree(join(from, name), join(to, name), job, cancelled);
    await chmod(to, info.mode & 0o7777);
    await utimes(to, info.atime, info.mtime);
  } else if (info.isFile()) {
    // A reflink where the disk can, so a big copy on btrfs costs nothing.
    await copyFile(from, to, constants.COPYFILE_FICLONE);
    await utimes(to, info.atime, info.mtime);
    job.done += info.size;
  }
  // Sockets, fifos and devices aren't copied.
}

function trashHome(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "Trash");
}

function trashDate(date = new Date()): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}` +
    `T${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
  );
}

/** Moves `path` to the home trash (the freedesktop spec); gives where it is in the trash. */
export async function trashItem(path: string, trash = trashHome()): Promise<string> {
  const files = join(trash, "files");
  const info = join(trash, "info");
  await mkdir(files, { recursive: true, mode: 0o700 });
  await mkdir(info, { recursive: true, mode: 0o700 });
  // The name is claimed by creating its info file, as the spec says.
  const name = basename(path);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${name}.${n}`;
    const record = join(info, `${candidate}.trashinfo`);
    const body = `[Trash Info]\nPath=${encodeURI(path).replace(/[?#]/g, encodeURIComponent)}\nDeletionDate=${trashDate()}\n`;
    try {
      await writeFile(record, body, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    const target = join(files, candidate);
    try {
      await moveItem(path, target);
    } catch (error) {
      await rm(record, { force: true });
      throw error;
    }
    return target;
  }
}

/** Puts a trashed file back where its info file says; gives where that is. */
export async function restoreItem(trashed: string, trash = trashHome()): Promise<string> {
  const record = join(trash, "info", `${basename(trashed)}.trashinfo`);
  const body = await readFile(record, "utf8");
  const line = body.split("\n").find((entry) => entry.startsWith("Path="));
  if (!line) throw new FilesError(400, `${trashed} has no original path.`);
  const original = decodeURI(line.slice(5)).replace(/%3F/g, "?").replace(/%23/g, "#");
  await mkdir(dirname(original), { recursive: true });
  const target = await freeName(dirname(original), basename(original));
  await moveItem(trashed, target);
  await rm(record, { force: true });
  return target;
}

async function moveItem(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    // Another disk: a copy, and only then the original goes.
    const job = { done: 0, current: "" } as FileJob;
    await copyTree(from, to, job, () => false);
    await rm(from, { recursive: true, force: true });
  }
}

export class FileJobs {
  private readonly jobs = new Map<number, FileJob>();
  private readonly cancelled = new Set<number>();
  private nextId = 1;

  private readonly home: string;

  constructor(home = homedir()) {
    this.home = home;
  }

  /** Starts a job; it runs on, and get(id) says how it's going. */
  start(request: FileJobRequest): FileJob {
    const paths = (Array.isArray(request.paths) ? request.paths : []).map(absolute);
    if (paths.length === 0) throw new FilesError(400, "There is nothing to do that to.");
    const { op } = request;
    if (!["copy", "move", "link", "trash", "delete", "restore"].includes(op)) {
      throw new FilesError(400, `Unknown operation ${String(op)}.`);
    }
    const needsTarget = op === "copy" || op === "move" || op === "link";
    const target = needsTarget ? absolute(request.target) : "";
    if (op === "move" || op === "trash" || op === "delete") {
      const guarded = paths.find((path) => protectedPath(path, this.home));
      if (guarded) throw new FilesError(403, `${guarded} can't be ${op === "move" ? "moved" : "removed"}.`);
    }
    if (op === "copy" || op === "move") {
      const inside = paths.find((path) => target === path || target.startsWith(`${path}${sep}`));
      if (inside) throw new FilesError(400, `${inside} can't go inside itself.`);
    }
    const job: FileJob = { id: this.nextId++, op, state: "running", total: 0, done: 0, current: "", results: [] };
    this.jobs.set(job.id, job);
    // Keep the finished jobs of late, not all of them.
    for (const id of this.jobs.keys()) {
      if (this.jobs.size <= 50) break;
      if (this.jobs.get(id)?.state !== "running") this.jobs.delete(id);
    }
    void this.run(job, paths, target, request.conflict ?? "rename");
    return job;
  }

  get(id: number): FileJob | undefined {
    return this.jobs.get(id);
  }

  list(): FileJob[] {
    return [...this.jobs.values()];
  }

  cancel(id: number): boolean {
    if (this.jobs.get(id)?.state !== "running") return false;
    this.cancelled.add(id);
    return true;
  }

  private async destination(path: string, target: string, conflict: Conflict, op: FileOp): Promise<string | null> {
    const wanted = join(target, basename(path));
    if (wanted === path) {
      // Moving a thing to where it is does nothing; copying it makes a second.
      return op === "copy" || op === "link" ? freeName(target, basename(path)) : null;
    }
    if (!(await exists(wanted))) return wanted;
    if (conflict === "skip") return null;
    if (conflict === "fail") throw new FilesError(409, `${wanted} already exists.`);
    if (conflict === "rename") return freeName(target, basename(path));
    await rm(wanted, { recursive: true, force: true });
    return wanted;
  }

  private async run(job: FileJob, paths: string[], target: string, conflict: Conflict): Promise<void> {
    const cancelled = () => this.cancelled.has(job.id);
    let path = paths[0]!;
    try {
      if (job.op === "copy") {
        for (const item of paths) job.total += await sizeOf(item);
      } else {
        job.total = paths.length;
      }
      if (target) await mkdir(target, { recursive: true });
      for (path of paths) {
        if (cancelled()) throw new Cancelled();
        job.current = path;
        switch (job.op) {
          case "copy":
          case "move":
          case "link": {
            const to = await this.destination(path, target, conflict, job.op);
            if (to === null) {
              if (job.op !== "copy") job.done++;
              else job.done += await sizeOf(path);
              break;
            }
            if (job.op === "copy") {
              try {
                await copyTree(path, to, job, cancelled);
              } catch (error) {
                // No half a copy left behind.
                await rm(to, { recursive: true, force: true });
                throw error;
              }
            } else if (job.op === "move") {
              await moveItem(path, to);
              job.done++;
            } else {
              await symlink(path, to);
              job.done++;
            }
            job.results.push({ from: path, to });
            break;
          }
          case "trash":
            job.results.push({ from: path, to: await trashItem(path) });
            job.done++;
            break;
          case "restore":
            job.results.push({ from: path, to: await restoreItem(path) });
            job.done++;
            break;
          case "delete":
            await rm(path, { recursive: true, force: true });
            job.results.push({ from: path, to: "" });
            job.done++;
            break;
        }
      }
      job.state = "done";
    } catch (error) {
      if (error instanceof Cancelled) {
        job.state = "cancelled";
      } else {
        job.state = "failed";
        job.error = failure(error, path).message;
      }
    } finally {
      job.current = "";
      this.cancelled.delete(job.id);
    }
  }
}

/** Renames `path` to `name`, in the same folder. */
export async function renamePath(path: unknown, name: unknown): Promise<{ path: string }> {
  const from = absolute(path);
  if (typeof name !== "string" || !name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new FilesError(400, "That isn't a name.");
  }
  if (protectedPath(from)) throw new FilesError(403, `${from} can't be renamed.`);
  const to = join(dirname(from), name);
  if (to === from) return { path: to };
  // Case-only renames on the same inode aside, a taken name isn't replaced.
  if (await exists(to)) throw new FilesError(409, `${name} already exists.`);
  try {
    await rename(from, to);
  } catch (error) {
    throw failure(error, from);
  }
  return { path: to };
}

/** A new empty file; a name ending in / would be a folder, which makeFolder does. */
export async function makeFile(path: unknown): Promise<{ path: string }> {
  const file = absolute(path);
  try {
    await writeFile(file, "", { flag: "wx" });
  } catch (error) {
    throw failure(error, file);
  }
  return { path: file };
}

const SKIPPED_FOLDERS = new Set([".git", "node_modules", ".cache", "target", "dist", "build", ".direnv"]);

async function walk(root: string, hidden: boolean, limit: number, paths: string[]): Promise<void> {
  const pending = [root];
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    let entries;
    try {
      entries = await readdir(next, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!hidden && entry.name.startsWith(".")) continue;
      const path = join(next, entry.name);
      const folder = entry.isDirectory();
      if (folder && SKIPPED_FOLDERS.has(entry.name)) continue;
      paths.push(relative(root, path) + (folder ? "/" : ""));
      if (paths.length >= limit) return;
      if (folder) pending.push(path);
    }
  }
}

/** What's under `root`, as paths relative to it, folders ending in /: fd's list if it's there (it honours .gitignore), else a walk. */
export async function fileIndex(
  root: unknown,
  { hidden = false, limit = 200_000, fd = "fd" } = {},
): Promise<{ root: string; paths: string[]; truncated: boolean }> {
  const dir = absolute(root);
  const info = await stat(dir).catch((error) => {
    throw failure(error, dir);
  });
  if (!info.isDirectory()) throw new FilesError(400, `${dir} isn't a folder.`);
  const paths = await new Promise<string[] | null>((resolve) => {
    const args = ["--color=never", "--max-results", String(limit), ...(hidden ? ["--hidden", "--exclude", ".git"] : [])];
    const child = spawn(fd, args, { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0 && chunks.length === 0) return resolve(null);
      const lines = Buffer.concat(chunks).toString("utf8").split("\n").filter(Boolean);
      resolve(lines.map((line) => line.replace(/^\.\//, "")));
    });
  });
  if (paths) return { root: dir, paths, truncated: paths.length >= limit };
  const walked: string[] = [];
  await walk(dir, hidden, limit, walked);
  return { root: dir, paths: walked, truncated: walked.length >= limit };
}

/** The start of `path`, for the preview pane: its text, or that it's binary. */
export async function previewText(
  path: unknown,
  limit = 64 * 1024,
): Promise<{ path: string; size: number; binary: boolean; text: string; truncated: boolean }> {
  const file = absolute(path);
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new FilesError(400, `${file} isn't a file.`);
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(Math.min(limit, info.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const bytes = buffer.subarray(0, bytesRead);
      const binary = bytes.includes(0);
      return {
        path: file,
        size: info.size,
        binary,
        text: binary ? "" : bytes.toString("utf8"),
        truncated: bytesRead < info.size,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw failure(error, file);
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".flac": "audio/flac",
  ".wav": "audio/wav",
};

/**
 * What `path` serves as to a preview, with its byte range: only the media above, as SVG and
 * HTML could run in the page that opens them.
 */
export async function rawFile(
  path: unknown,
  range: string | undefined,
): Promise<{ stream: NodeJS.ReadableStream; contentType: string; size: number; start: number; end: number; partial: boolean }> {
  const file = absolute(path);
  const contentType = CONTENT_TYPES[extname(file).toLowerCase()];
  if (!contentType) throw new FilesError(415, `${basename(file)} has no preview.`);
  const info = await stat(file).catch((error) => {
    throw failure(error, file);
  });
  if (!info.isFile()) throw new FilesError(400, `${file} isn't a file.`);
  const match = range?.match(/^bytes=(\d*)-(\d*)$/);
  let start = 0;
  let end = info.size - 1;
  if (match && (match[1] || match[2])) {
    if (match[1]) {
      start = Number(match[1]);
      if (match[2]) end = Math.min(Number(match[2]), end);
    } else {
      start = Math.max(0, info.size - Number(match[2]));
    }
    if (start > end) throw new FilesError(416, "That range isn't in the file.");
  }
  return {
    stream: createReadStream(file, info.size ? { start, end } : {}),
    contentType,
    size: info.size,
    start,
    end,
    partial: Boolean(match),
  };
}

/** Where a dropped file with no path of its own goes: `name` in `dir`, numbered if it's taken. */
export async function uploadTarget(dir: unknown, name: unknown): Promise<string> {
  const folder = absolute(dir);
  if (typeof name !== "string" || !name || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new FilesError(400, "That isn't a name.");
  }
  return freeName(folder, name);
}

/** Calls `changed` soon after folder `dir` changes; the result stops it. */
export function watchFolder(dir: unknown, changed: () => void): () => void {
  const folder = absolute(dir);
  let timer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher;
  try {
    watcher = watch(folder, () => {
      clearTimeout(timer);
      timer = setTimeout(changed, 150);
    });
  } catch (error) {
    throw failure(error, folder);
  }
  // A folder deleted while watched is the next listing's error.
  watcher.on("error", () => watcher.close());
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}

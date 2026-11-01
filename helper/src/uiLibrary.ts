// The shells' UI library (web/ui, UI_LIBRARY.md): the dock, keys, settings,
// dragging and widgets every shell shares, served as ES modules at
// /v1/ui/<path>. Public like the shell library: any page may load it, only a
// shell can use what it drives. It sits beside the shell library, so a session
// serving its live copy (`plutonium live`) serves that copy's UI library too.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

export interface UiFile {
  readonly body: Buffer;
  readonly contentType: string;
}

/**
 * The library's file at `path` (what follows /v1/ui/), or null: only files
 * inside `root`, of the types above, no dot files.
 */
export function uiLibraryFile(root: string, path: string): UiFile | null {
  let relative: string;
  try {
    relative = decodeURIComponent(path);
  } catch {
    return null;
  }
  const parts = relative.split("/");
  if (parts.some((part) => part === "" || part.startsWith(".") || part.includes("\\"))) return null;
  const contentType = TYPES[extname(relative)];
  if (!contentType) return null;
  const file = join(root, ...parts);
  if (!existsSync(file)) return null;
  try {
    const real = realpathSync(file);
    const base = realpathSync(root);
    if (!real.startsWith(base + sep) || !statSync(real).isFile()) return null;
    return { body: readFileSync(real), contentType };
  } catch {
    return null;
  }
}

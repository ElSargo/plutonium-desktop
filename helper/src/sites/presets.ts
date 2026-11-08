// Presets for site extension requests (SITE_EXTENSIONS.md, "Presets"): a
// Markdown file each in $PLUTO_HOME/sites/presets/, with front matter (title,
// description, order) and the prompt an agent gets on top of the request.
// The shipped ones (./presets/) are copied there; a copy the user edited is
// theirs, and a later shipped version doesn't replace it.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Preset {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly order: number;
  /** What the agent is asked, after the request. */
  readonly prompt: string;
}

const SHIPPED = new URL("./presets/", import.meta.url);
const PRESET_ID = /^[a-z0-9][a-z0-9_-]*$/;

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** Parses a preset file: `---` front matter (`key: value` lines), then the prompt. */
export function parsePreset(text: string, id: string): Preset {
  let body = text;
  const fields: Record<string, string> = {};
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (match) {
    body = text.slice(match[0].length);
    for (const line of match[1]!.split("\n")) {
      const field = /^(\w+):\s*(.*)$/.exec(line.trim());
      if (field) fields[field[1]!] = field[2]!.trim();
    }
  }
  const order = Number(fields.order);
  return {
    id,
    title: fields.title || id,
    description: fields.description ?? "",
    order: Number.isFinite(order) ? order : 100,
    prompt: body.trim(),
  };
}

/**
 * Copies the shipped presets into `dir` (the sites folder's presets/): a
 * missing one, or one whose copy is still what was shipped before. `state` is
 * where the shipped versions' hashes are kept (outside git).
 */
export function installPresets(dir: string, state: string, shipped: URL = SHIPPED): string[] {
  const installed: Record<string, string> = (() => {
    try {
      return JSON.parse(readFileSync(state, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  })();
  const written: string[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(shipped).filter((file) => file.endsWith(".md"));
  } catch {
    return written;
  }
  mkdirSync(dir, { recursive: true });
  for (const file of files) {
    const id = file.slice(0, -3);
    if (!PRESET_ID.test(id)) continue;
    const text = readFileSync(new URL(file, shipped), "utf8");
    const target = join(dir, file);
    const current = existsSync(target) ? readFileSync(target, "utf8") : null;
    if (current === text) {
      installed[id] = hash(text);
      continue;
    }
    // The user's own edit stays; a copy of an earlier shipped version is updated.
    if (current !== null && installed[id] !== hash(current)) continue;
    writeFileSync(target, text);
    installed[id] = hash(text);
    written.push(id);
  }
  mkdirSync(join(state, ".."), { recursive: true });
  writeFileSync(state, JSON.stringify(installed));
  return written;
}

/** The presets in `dir`, in their order. */
export function listPresets(dir: string): Preset[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".md") && PRESET_ID.test(file.slice(0, -3)));
  } catch {
    return [];
  }
  return files
    .map((file) => parsePreset(readFileSync(join(dir, file), "utf8"), file.slice(0, -3)))
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

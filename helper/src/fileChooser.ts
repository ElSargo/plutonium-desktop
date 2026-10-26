// The FileChooser portal's requests as the shells' file picker sees them
// (docs/features/TAB_FEATURES.md, "One picker with the FileChooser portal"):
// OpenFile, SaveFile and SaveFiles become the same request detail a tab's
// <input type=file> sends ({mode, title, filters, currentFilter, currentName,
// currentFolder}, plus acceptLabel and choices), and the picker's answer
// ({paths, filter?, choices?}) becomes the portal's results (file:// URIs).
// xdg-desktop-portal's frontend exports them through the document portal for
// sandboxed apps itself.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Variant } from "./dbus.ts";

/** A filter as the portal sends it, (sa(us)): a name and rules, 0 a glob, 1 a MIME type. */
export type PortalFilter = [string, [number, string][]];

/** A filter as the picker takes it (patterns such as "*.png"). */
export interface PickerFilter {
  readonly name: string;
  readonly patterns: string[];
  readonly mimeTypes?: string[];
}

/** A choice, as the picker takes it: options empty for a checkbox ("true"/"false"). */
export interface PickerChoice {
  readonly id: string;
  readonly label: string;
  readonly options: { id: string; label: string }[];
  readonly value: string;
}

export interface PickerAnswer {
  readonly paths?: string[];
  readonly filter?: number;
  readonly choices?: Record<string, string>;
}

let globsByType: Map<string, string[]> | null = null;

/** shared-mime-info's globs, by MIME type (globs2 in each XDG data dir). */
function loadGlobs(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const home = process.env.XDG_DATA_HOME || join(process.env.HOME ?? "", ".local/share");
  const dirs = [home, ...(process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":")];
  for (const dir of dirs) {
    const file = join(dir, "mime/globs2");
    if (!dir || !existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const [, type, glob] = line.split(":");
      if (!type || !glob) continue;
      const globs = map.get(type) ?? [];
      if (!globs.includes(glob)) globs.push(glob);
      map.set(type, globs);
    }
  }
  return map;
}

/** The globs for a MIME type ("image/*" for all of a kind); none if unknown. */
export function mimeGlobs(type: string): string[] {
  globsByType ??= loadGlobs();
  if (type.endsWith("/*")) {
    const prefix = type.slice(0, -1);
    return [...globsByType].filter(([name]) => name.startsWith(prefix)).flatMap(([, globs]) => globs);
  }
  return globsByType.get(type) ?? [];
}

/** GTK's case-blind spelling ("*.[pP][nN][gG]") as a plain pattern ("*.png"); the picker ignores case. */
export function plainGlob(glob: string): string {
  return glob.replace(/\[(.)(.)\]/g, (whole, a: string, b: string) =>
    a.toLowerCase() === b.toLowerCase() ? a.toLowerCase() : whole,
  );
}

export function pickerFilter([name, rules]: PortalFilter, globsOf = mimeGlobs): PickerFilter {
  const patterns: string[] = [];
  const mimeTypes: string[] = [];
  for (const [kind, rule] of rules ?? []) {
    if (kind === 1) {
      mimeTypes.push(rule);
      patterns.push(...globsOf(rule).map(plainGlob));
    } else {
      patterns.push(plainGlob(rule));
    }
  }
  // MIME types the system doesn't know: show everything rather than nothing.
  if (patterns.length === 0) patterns.push("*");
  return { name, patterns: [...new Set(patterns)], ...(mimeTypes.length ? { mimeTypes } : {}) };
}

/** A path sent as bytes (ay, NUL-terminated); "" if none. */
export function bytePath(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const bytes = Buffer.from(value as number[]);
  const end = bytes.indexOf(0);
  return bytes.toString("utf8", 0, end < 0 ? bytes.length : end);
}

/** The portal's choices, a(ssa(ss)s). */
export function pickerChoices(value: unknown): PickerChoice[] {
  if (!Array.isArray(value)) return [];
  return (value as [string, string, [string, string][], string][]).map(([id, label, options, value]) => ({
    id,
    label,
    options: (options ?? []).map(([optionId, optionLabel]) => ({ id: optionId, label: optionLabel })),
    value: value || (options?.length ? options[0]![0] : "false"),
  }));
}

/** "_Open" (a mnemonic) → "Open". */
function plainLabel(label: unknown): string | undefined {
  return typeof label === "string" && label ? label.replace(/_(.)/g, "$1") : undefined;
}

export type FileChooserMethod = "OpenFile" | "SaveFile" | "SaveFiles";

/** The picker's request detail for a portal call. */
export function fileChooserDetail(
  method: FileChooserMethod,
  title: string,
  options: Map<string, unknown>,
  globsOf = mimeGlobs,
): Record<string, unknown> {
  const portalFilters = (options.get("filters") as PortalFilter[] | undefined) ?? [];
  const filters = portalFilters.map((filter) => pickerFilter(filter, globsOf));
  const current = options.get("current_filter") as PortalFilter | undefined;
  let currentFilter = 0;
  if (current) {
    const index = portalFilters.findIndex((filter) => JSON.stringify(filter) === JSON.stringify(current));
    // A current filter that isn't in the list is added to it, as GTK does.
    if (index >= 0) currentFilter = index;
    else currentFilter = filters.push(pickerFilter(current, globsOf)) - 1;
  }
  let mode = "open";
  let currentName: string | undefined;
  let currentFolder = bytePath(options.get("current_folder")) || undefined;
  if (method === "OpenFile") {
    if (options.get("directory") === true) mode = "folder";
    else if (options.get("multiple") === true) mode = "open-multiple";
  } else if (method === "SaveFile") {
    mode = "save";
    const file = bytePath(options.get("current_file"));
    if (file) {
      currentFolder ??= dirname(file);
      currentName = basename(file);
    }
    if (typeof options.get("current_name") === "string") currentName = options.get("current_name") as string;
  } else {
    // SaveFiles: a folder, which the files are saved into.
    mode = "folder";
  }
  const detail: Record<string, unknown> = { mode, title, filters: mode === "folder" ? [] : filters };
  if (mode !== "folder" && filters.length) detail.currentFilter = currentFilter;
  if (currentName !== undefined) detail.currentName = currentName;
  if (currentFolder) detail.currentFolder = currentFolder;
  const acceptLabel = plainLabel(options.get("accept_label")) ?? (method === "SaveFiles" ? "Save" : undefined);
  if (acceptLabel) detail.acceptLabel = acceptLabel;
  const choices = pickerChoices(options.get("choices"));
  if (choices.length) detail.choices = choices;
  if (method === "SaveFiles") {
    detail.files = ((options.get("files") as unknown[] | undefined) ?? []).map(bytePath).filter(Boolean);
  }
  return detail;
}

/** The portal's results for the picker's answer; null if the user cancelled. */
export function fileChooserResults(
  method: FileChooserMethod,
  options: Map<string, unknown>,
  detail: Record<string, unknown>,
  answer: PickerAnswer | null,
): [string, Variant][] | null {
  const paths = answer?.paths?.filter((path) => typeof path === "string" && path.startsWith("/")) ?? [];
  if (paths.length === 0) return null;
  let uris: string[];
  if (method === "SaveFiles") {
    const folder = paths[0]!;
    uris = ((detail.files as string[] | undefined) ?? []).map((name) => pathToFileURL(join(folder, basename(name))).href);
  } else {
    uris = paths.map((path) => pathToFileURL(path).href);
  }
  const results: [string, Variant][] = [["uris", ["as", uris]]];
  const choices = (detail.choices as PickerChoice[] | undefined) ?? [];
  if (choices.length) {
    const chosen = answer?.choices ?? {};
    results.push(["choices", ["a(ss)", choices.map(({ id, value }) => [id, String(chosen[id] ?? value)])]]);
  }
  const portalFilters = (options.get("filters") as PortalFilter[] | undefined) ?? [];
  const current = options.get("current_filter") as PortalFilter | undefined;
  const all = current && !portalFilters.some((f) => JSON.stringify(f) === JSON.stringify(current))
    ? [...portalFilters, current]
    : portalFilters;
  if (typeof answer?.filter === "number" && all[answer.filter]) {
    results.push(["current_filter", ["(sa(us))", all[answer.filter]]]);
  }
  if (method === "OpenFile") results.push(["writable", ["b", true]]);
  return results;
}

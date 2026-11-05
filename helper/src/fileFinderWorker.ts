// The file manager's fuzzy finder (docs/features/FILE_MANAGER.md, "The fuzzy finder"): fff
// indexes a folder and searches it in native code. Its calls block, and tearing it down in
// a worker thread takes the whole process with it, so it's a process of its own: if it
// dies the helper starts another, and killing it gives its memory back. One index per
// folder, while anything is searching it.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileIndex } from "./fileOps.ts";

export interface FindRequest {
  readonly id: number;
  readonly op: "find" | "opened" | "close";
  readonly root: string;
  readonly query?: string;
  readonly hidden?: boolean;
  readonly limit?: number;
  readonly path?: string;
}

export interface FindResult {
  /** Paths relative to the folder, folders ending in /, best first. */
  readonly paths: readonly string[];
  readonly matched: number;
  readonly total: number;
  /** Still indexing: asking again may find more. */
  readonly scanning: boolean;
  readonly engine: "fff" | "walk";
}

interface Finder {
  mixedSearch(
    query: string,
    options: { pageSize: number },
  ): { ok: boolean; error?: string; value?: FffResult };
  trackQuery(query: string, path: string): unknown;
  isScanning(): boolean;
  waitForScan(timeoutMs: number): Promise<unknown>;
  destroy(): void;
}

interface FffResult {
  readonly items: readonly (
    | { readonly type: "file"; readonly item: { readonly relativePath: string } }
    | { readonly type: "directory"; readonly item: { readonly relativePath: string } }
  )[];
  readonly totalMatched: number;
  readonly totalFiles: number;
  readonly totalDirs: number;
}

const finders = new Map<string, Finder>();
const walks = new Map<string, Map<boolean, readonly string[]>>();

const hiddenPath = (path: string) => path.startsWith(".") || path.includes("/.");

async function fff(): Promise<{ FileFinder: { create(options: object): { ok: boolean; error?: string; value?: Finder } } } | null> {
  return import("@ff-labs/fff-node").catch(() => null) as never;
}

async function finderFor(root: string): Promise<Finder | null> {
  const open = finders.get(root);
  if (open) return open;
  const library = await fff();
  if (!library) return null;
  const dir = join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "plutonium/fff");
  mkdirSync(dir, { recursive: true });
  const name = createHash("sha1").update(root).digest("hex").slice(0, 16);
  const created = library.FileFinder.create({
    basePath: root,
    frecencyDbPath: join(dir, `${name}.frecency`),
    historyDbPath: join(dir, `${name}.history`),
    aiMode: false,
    // Only names are searched, and a home folder is too many files to watch.
    disableContentIndexing: true,
    disableMmapCache: true,
    disableWatch: true,
    enableHomeDirScanning: true,
    enableFsRootScanning: true,
  });
  if (!created.ok || !created.value) return null;
  finders.set(root, created.value);
  // A scan starts a moment later: until then "not scanning" would mean an empty folder.
  await created.value.waitForScan(150);
  return created.value;
}

/** Without fff: a capped walk, matched in JS, here off the helper's thread. */
async function walkFind(request: FindRequest): Promise<FindResult> {
  const { root, query = "", hidden = false, limit = 300 } = request;
  const byHidden = walks.get(root) ?? new Map<boolean, readonly string[]>();
  walks.set(root, byHidden);
  let paths = byHidden.get(hidden);
  if (!paths) {
    paths = (await fileIndex(root, { hidden })).paths;
    byHidden.set(hidden, paths);
  }
  const core = (await import("../web/ui/files.js")) as unknown as {
    fuzzyFilter(query: string, paths: readonly string[], limit: number): { path: string }[];
  };
  const found = core.fuzzyFilter(query, paths, limit);
  return { paths: found.map(({ path }) => path), matched: found.length, total: paths.length, scanning: false, engine: "walk" };
}

async function find(request: FindRequest): Promise<FindResult> {
  const { root, query = "", hidden = false, limit = 300 } = request;
  // fff never indexes dot files, so showing them is the walk's job.
  const finder = hidden ? null : await finderFor(root);
  if (!finder) return walkFind(request);
  // What's left out below still fills a page.
  const result = finder.mixedSearch(query, { pageSize: limit * 4 });
  if (!result.ok || !result.value) throw new Error(result.error ?? "The search failed.");
  const { items, totalMatched, totalFiles, totalDirs } = result.value;
  const paths = items
    .map(({ type, item }) => (type === "directory" ? item.relativePath.replace(/\/?$/, "/") : item.relativePath))
    .filter((path) => path !== "/" && !hiddenPath(path))
    .slice(0, limit);
  return { paths, matched: totalMatched, total: totalFiles + totalDirs, scanning: finder.isScanning(), engine: "fff" };
}

process.on("disconnect", () => process.exit(0));
process.on("message", (request: FindRequest) => {
  void (async () => {
    try {
      if (request.op === "close") {
        finders.get(request.root)?.destroy();
        finders.delete(request.root);
        walks.delete(request.root);
        process.send?.({ id: request.id, value: null });
      } else if (request.op === "opened") {
        finders.get(request.root)?.trackQuery(request.query ?? "", request.path ?? "");
        process.send?.({ id: request.id, value: null });
      } else {
        process.send?.({ id: request.id, value: await find(request) });
      }
    } catch (error) {
      process.send?.({ id: request.id, error: (error as Error).message });
    }
  })();
});

// The file manager's fuzzy finder (docs/features/FILE_MANAGER.md, "The fuzzy finder"): fff
// indexes a folder and searches it in native code. Its calls block, and tearing it down in
// a worker thread takes the whole process with it, so it's a process of its own: if it
// dies the helper starts another, and killing it gives its memory back. One index per
// folder. An index doesn't see new files, and fff's own rescan does nothing with watching
// off, so an old one is rebuilt beside itself: searches keep using it until the new one
// is done, and the two swap.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileIndex } from "./fileOps.ts";

export interface FindRequest {
  readonly id: number;
  readonly op: "find" | "opened" | "close" | "warm";
  readonly root: string;
  readonly query?: string;
  readonly hidden?: boolean;
  readonly limit?: number;
  readonly path?: string;
  /** Rebuild an index this old (ms) when it's searched. 0: leave it. */
  readonly refreshAfter?: number;
}

export interface FindResult {
  /** Paths relative to the folder, folders ending in /, best first. */
  readonly paths: readonly string[];
  readonly matched: number;
  readonly total: number;
  /** Still indexing, or rebuilding: asking again may find more. */
  readonly scanning: boolean;
  /** How far a first scan has got: it searches nothing until it's done. */
  readonly indexed: number;
  readonly engine: "fff" | "walk";
}

interface Finder {
  mixedSearch(
    query: string,
    options: { pageSize: number },
  ): { ok: boolean; error?: string; value?: FffResult };
  trackQuery(query: string, path: string): unknown;
  isScanning(): boolean;
  getScanProgress(): { value?: { scannedFilesCount: number } };
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

interface Index {
  finder: Finder;
  builtAt: number;
  rebuilding: boolean;
}

const REBUILD_TIMEOUT_MS = 10 * 60_000;

const indexes = new Map<string, Index>();
const walks = new Map<string, Map<boolean, readonly string[]>>();

const hiddenPath = (path: string) => path.startsWith(".") || path.includes("/.");

async function fff(): Promise<{ FileFinder: { create(options: object): { ok: boolean; error?: string; value?: Finder } } } | null> {
  return import("@ff-labs/fff-node").catch(() => null) as never;
}

async function createFinder(root: string): Promise<Finder | null> {
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
  // A scan starts a moment later: until then "not scanning" would mean an empty folder.
  await created.value.waitForScan(150);
  return created.value;
}

async function indexFor(root: string): Promise<Index | null> {
  const open = indexes.get(root);
  if (open) return open;
  const finder = await createFinder(root);
  if (!finder) return null;
  // Two searches can get here together: the first keeps its index.
  const raced = indexes.get(root);
  if (raced) {
    finder.destroy();
    return raced;
  }
  const index = { finder, builtAt: Date.now(), rebuilding: false };
  indexes.set(root, index);
  return index;
}

async function rebuild(root: string, index: Index): Promise<void> {
  index.rebuilding = true;
  const next = await createFinder(root).catch(() => null);
  await next?.waitForScan(REBUILD_TIMEOUT_MS);
  index.rebuilding = false;
  index.builtAt = Date.now();
  if (!next) return;
  // It was closed while this ran, or the scan never ended: the old one stays as it is.
  if (indexes.get(root) !== index || next.isScanning()) return next.destroy();
  index.finder.destroy();
  index.finder = next;
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
  return { paths: found.map(({ path }) => path), matched: found.length, total: paths.length, scanning: false, indexed: paths.length, engine: "walk" };
}

async function find(request: FindRequest): Promise<FindResult> {
  const { root, query = "", hidden = false, limit = 300, refreshAfter = 0 } = request;
  // fff never indexes dot files, so showing them is the walk's job.
  const index = hidden ? null : await indexFor(root);
  if (!index) return walkFind(request);
  const { finder } = index;
  const firstScan = finder.isScanning();
  if (refreshAfter > 0 && !firstScan && !index.rebuilding && Date.now() - index.builtAt > refreshAfter) {
    void rebuild(root, index);
  }
  // What's left out below still fills a page.
  const result = finder.mixedSearch(query, { pageSize: limit * 4 });
  if (!result.ok || !result.value) throw new Error(result.error ?? "The search failed.");
  const { items, totalMatched, totalFiles, totalDirs } = result.value;
  const paths = items
    .map(({ type, item }) => (type === "directory" ? item.relativePath.replace(/\/?$/, "/") : item.relativePath))
    .filter((path) => path !== "/" && !hiddenPath(path))
    .slice(0, limit);
  return {
    paths,
    matched: totalMatched,
    total: totalFiles + totalDirs,
    scanning: firstScan || index.rebuilding,
    indexed: finder.getScanProgress().value?.scannedFilesCount ?? 0,
    engine: "fff",
  };
}

process.on("disconnect", () => process.exit(0));
process.on("message", (request: FindRequest) => {
  void (async () => {
    try {
      if (request.op === "close") {
        indexes.get(request.root)?.finder.destroy();
        indexes.delete(request.root);
        walks.delete(request.root);
        process.send?.({ id: request.id, value: null });
      } else if (request.op === "opened") {
        indexes.get(request.root)?.finder.trackQuery(request.query ?? "", request.path ?? "");
        process.send?.({ id: request.id, value: null });
      } else if (request.op === "warm") {
        await indexFor(request.root);
        process.send?.({ id: request.id, value: null });
      } else {
        process.send?.({ id: request.id, value: await find(request) });
      }
    } catch (error) {
      process.send?.({ id: request.id, error: (error as Error).message });
    }
  })();
});

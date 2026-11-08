// A tab's context for site extensions (SITE_EXTENSIONS.md, "The tab's
// context"): its thread and project, from its tags, and each site's settings
// in that project.
//
// A tab's thread is a tag with no prefix (Hydra's thread ids, the plain
// shell's own); a tab kept per project carries `t3:project/<id>`. Until the
// helper keeps projects itself (PROJECTS.md, step 1), threads' titles and
// projects come from Hydra's (T3 Code's) state database, read only. Settings
// come from the user's own file for the project, ~/.pluto/projects/<id>.json
// ("sites": { "<site>": { ... } }); the folder's .pluto/project.json waits for
// PROJECTS.md's trust.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TabContext {
  readonly thread: { readonly id: string; readonly title: string | null } | null;
  readonly project: { readonly id: string; readonly title: string | null; readonly folder: string | null } | null;
  /** Each site's settings in the project, by site name. */
  readonly sites: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly shell: string | null;
}

export const NO_CONTEXT: TabContext = { thread: null, project: null, sites: {}, shell: null };

interface ThreadRow {
  readonly title: string | null;
  readonly projectId: string | null;
}
interface ProjectRow {
  readonly title: string | null;
  readonly folder: string | null;
}

/** Where threads and projects are looked up (tests give their own). */
export interface ThreadDirectory {
  thread(id: string): ThreadRow | null;
  project(id: string): ProjectRow | null;
}

const CACHE_MS = 5_000;

/** Hydra's threads and projects, from T3 Code's state database (read only). */
export class T3Directory implements ThreadDirectory {
  private readonly file: string | null;
  private db: { prepare(sql: string): { get(...args: unknown[]): unknown } } | null = null;
  private opened = 0;
  private readonly threads = new Map<string, { row: ThreadRow | null; at: number }>();
  private readonly projects = new Map<string, { row: ProjectRow | null; at: number }>();

  constructor(t3Home = process.env.T3_HOME || process.env.T3CODE_HOME || join(homedir(), ".t3")) {
    const candidates = [join(t3Home, "userdata", "statev2.sqlite"), join(t3Home, "userdata", "state.sqlite")];
    this.file = candidates.find((file) => existsSync(file)) ?? null;
  }

  private database(): T3Directory["db"] {
    if (!this.file) return null;
    // Opened again now and then: T3 Code may have replaced the file (a migration).
    if (this.db && Date.now() - this.opened < 60_000) return this.db;
    try {
      // node:sqlite is built in (Node 24); loaded lazily, so a helper that never needs it doesn't warn.
      const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
      this.db = new DatabaseSync(this.file, { readOnly: true }) as unknown as T3Directory["db"];
      this.opened = Date.now();
    } catch (error) {
      console.warn(`plutoniumd: sites: can't read ${this.file}: ${(error as Error).message}`);
      this.db = null;
    }
    return this.db;
  }

  thread(id: string): ThreadRow | null {
    const cached = this.threads.get(id);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.row;
    let row: ThreadRow | null = null;
    try {
      // T3 Code 0.1 keeps threads in its v2 projection; older databases, in projection_threads.
      const db = this.database();
      let found: { title?: string; project_id?: string } | undefined;
      for (const table of ["orchestration_v2_projection_threads", "projection_threads"]) {
        try {
          found = db
            ?.prepare(`SELECT title, project_id FROM ${table} WHERE thread_id = ? AND deleted_at IS NULL`)
            .get(id) as typeof found;
        } catch {
          continue;
        }
        if (found) break;
      }
      if (found) row = { title: found.title ?? null, projectId: found.project_id ?? null };
    } catch {}
    this.threads.set(id, { row, at: Date.now() });
    return row;
  }

  project(id: string): ProjectRow | null {
    const cached = this.projects.get(id);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.row;
    let row: ProjectRow | null = null;
    try {
      const found = this.database()
        ?.prepare("SELECT title, workspace_root FROM projection_projects WHERE project_id = ? AND deleted_at IS NULL")
        .get(id) as { title?: string; workspace_root?: string } | undefined;
      if (found) row = { title: found.title ?? null, folder: found.workspace_root ?? null };
    } catch {}
    this.projects.set(id, { row, at: Date.now() });
    return row;
  }
}

const PROJECT_TAG = "t3:project/";

/** Reads a project's site settings from ~/.pluto/projects/<id>.json. */
export function projectSiteSettings(plutoHome: string, projectId: string): Record<string, Record<string, unknown>> {
  try {
    const raw = JSON.parse(readFileSync(join(plutoHome, "projects", `${projectId}.json`), "utf8")) as { sites?: unknown };
    const sites = raw.sites;
    if (!sites || typeof sites !== "object" || Array.isArray(sites)) return {};
    const out: Record<string, Record<string, unknown>> = {};
    for (const [site, settings] of Object.entries(sites as Record<string, unknown>)) {
      if (settings && typeof settings === "object" && !Array.isArray(settings)) out[site] = settings as Record<string, unknown>;
    }
    return out;
  } catch {
    return {};
  }
}

export class ContextSource {
  private readonly directory: ThreadDirectory;
  private readonly plutoHome: string;

  constructor(plutoHome: string, directory: ThreadDirectory = new T3Directory()) {
    this.plutoHome = plutoHome;
    this.directory = directory;
  }

  /** The context of a tab with these tags. */
  contextFor(tags: readonly string[]): TabContext {
    let thread: TabContext["thread"] = null;
    let projectId: string | null = null;
    let fromHydra = false;
    for (const tag of tags) {
      if (tag.startsWith(PROJECT_TAG)) {
        projectId ??= tag.slice(PROJECT_TAG.length) || null;
        fromHydra = true;
      } else if (tag.startsWith("t3:")) {
        fromHydra = true;
      } else if (!tag.includes(":") && !thread) {
        const row = this.directory.thread(tag);
        thread = { id: tag, title: row?.title ?? null };
        if (row) {
          fromHydra = true;
          projectId ??= row.projectId;
        }
      }
    }
    let project: TabContext["project"] = null;
    if (projectId) {
      const row = this.directory.project(projectId);
      project = { id: projectId, title: row?.title ?? null, folder: row?.folder ?? null };
    }
    return {
      thread,
      project,
      sites: project ? projectSiteSettings(this.plutoHome, project.id) : {},
      shell: fromHydra ? "hydra" : null,
    };
  }
}

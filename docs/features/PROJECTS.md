# Projects: threads grouped by what you're doing, with config and scope

**Status: design, nothing built yet** (2026-11-08). The goals:
- a project is a desktop object, the level above a thread: it groups threads, and each thread inherits its project's context (environment, apps, agent defaults, keys);
- every shell can show projects and threads, not only Hydra: the helper owns them, and the T3 Code server becomes a core service behind a small agent API;
- per-project config, part committed with the project's folder and part your own;
- scope: by default, an agent sees and drives only its own thread's windows. Seeing its project's windows is something a project opts into.

## Today

- **Threads are in the helper.** Their environment (`PLUTONIUM_THREAD_ID`), X display, session bus (`threads.ts`, `threadBus.ts`), agent windows (`agentWindows.ts`) and the agents' tools (`mcp.ts`, which only reach the caller's thread) moved out of the T3 fork so any frontend gets them. Charon already shows workspaces as threads ([CHARON_SHELL.md](CHARON_SHELL.md)).
- **Projects are only in T3.** A T3 project is a `workspaceRoot`, a default model, scripts and an icon, kept in T3's database (`~/.t3`). T3 allows one active project per folder. The helper doesn't know about projects at all.
- **The agent engine is Hydra's.** The T3 server is a shell package's `server` (`shells/hydra/shell.json`), and only Hydra's page talks to it.

## Principles

1. **Project → thread → windows.** Each level inherits from the one above, and a thread can override what it needs to.
2. **Plutonium owns projects; T3 owns its own fields.** The helper keeps the project record and which thread belongs to which project. T3 keeps the fields it already has (its workspace root, model, scripts). The adapter reads T3's record and creates it when missing. It never syncs both ways. The T3 app outside Plutonium uses the same `~/.t3`.
3. **A project doesn't need a folder of its own.** One with no folder runs in `~/`. That's for research, writing, and anything else that isn't a repo.
4. **Nothing from a folder applies until you trust it.** A committed config can set environments and start apps, so cloning a repo must not run anything.
5. **Narrow scope by default.** An agent sees its own thread. Project scope is opt-in, per project. An agent never sees another project.
6. **The agent engine is optional.** Without it, projects and threads are still desktop contexts, and the agent API isn't there.
7. **Shells don't speak T3's contracts.** They use the helper's API. One adapter maps it onto T3's contracts, so T3's churn stops there. Hydra's frame is the exception: it mounts T3's chat components and uses T3's contracts directly.

## The model

```
desktop defaults           ~/.pluto/projects/defaults.json
 └─ project                its folder's .pluto/project.json (if trusted), then ~/.pluto/projects/<id>.json
     └─ thread             its overrides, and its worktree's .pluto/project.json
         └─ windows, terminals, tabs
```

A project has:
- an id, Plutonium's (`p_…`), not its folder: several folderless projects share `~/`;
- a title, an icon, and an optional folder (the default is `~/`);
- the T3 project it maps to, if the agent engine is installed;
- its config, merged from the layers above. Objects merge by key, and arrays replace.

A thread has its project, its environment, and optionally a worktree, which is where it reads its config from (below). Windows belong to a thread as now. A window can also belong to a project directly (Project windows, below).

**Folderless projects and T3.** T3 allows one active project per folder, so every project in `~/` maps to the same T3 project, "Home". Which Plutonium project a Home thread belongs to is the helper's record, not T3's. In Hydra, the sidebar groups by Plutonium's projects, so this doesn't show. In the T3 app outside Plutonium, those threads appear under one Home project.

## Config

### In the folder: `.pluto/project.json`

Committed, so it travels with clones and worktrees. Only for projects that have a folder: a project in `~/` never reads `~/.pluto/project.json`, because `~/.pluto` is the desktop's own config directory.

```json
{
  "title": "Plutonium",
  "env": { "from": "nix develop", "vars": { "RUST_LOG": "info" } },
  "apps": [
    { "id": "dev-server", "command": "pnpm dev", "scope": "project", "start": "manual" },
    { "id": "org.gnome.TextEditor", "scope": "thread" }
  ],
  "browser": { "profile": "project" },
  "agents": {
    "model": "claude-opus-5-5",
    "instructions": ["CLAUDE.md", "AGENTS.md"],
    "scope": "thread",
    "tools": { "deny": ["close_window"] }
  },
  "scripts": [{ "name": "test", "command": "pnpm test" }]
}
```

- **`env`**: variables, and optionally where to get the rest. `from` is `direnv` or a command such as `nix develop`, whose environment the helper captures once per change of its inputs. Every process in the project's threads gets it, on top of the thread's own variables.
- **`apps`**: what the project uses. `scope: "project"` means one instance shared by the project's threads. `scope: "thread"` means each thread gets its own. `start` is `manual` (on the dock, or a launcher entry) or `open` (with the first thread).
- **`browser.profile`**: `project` gives the project its own browser profile, so cookies and logins don't leak between projects. The default is the desktop's profile.
- **`agents.instructions`** points to the files agents already read. Plutonium doesn't replace them. What it adds is the desktop's part: which apps the project has, and what the agent may drive.
- **`agents.model`** and **`scripts`** map to T3's fields when the project is created in T3. After that, T3's record is the one that's edited.

### Yours: `~/.pluto/projects/<id>.json`

What's personal, or for a project with no folder: layouts, which display a project opens on, key overrides, trust, and anything from the folder's file you want to override. `defaults.json` beside it applies to every project.

### Worktrees

A thread in a worktree reads that worktree's `.pluto/project.json`, not the main checkout's, so a branch can change the config and the change can be tried on that branch. Trust is by content (below), so a branch with a changed config asks again.

## Trust

- A folder's `.pluto/project.json` doesn't apply until you approve it, as direnv's `allow` or VS Code's workspace trust. Until then, the project runs on your file and the defaults only, and the shell says there's a config waiting.
- Approval is recorded in your per-user file as the content's hash. When the file changes (a pull, a branch, an agent's edit), it's ignored again until you approve the new version. The prompt shows what changed.
- `plutonium projects trust <id>` approves from a terminal. `plutonium projects check` lists projects with configs waiting.
- An agent can edit the file like any other. Its changes wait for your approval, like anyone else's.

## Scope

### Windows

- A window belongs to a thread, found from its client pid (`threads.ts`), as now.
- **Project windows.** An app with `scope: "project"`, or a window you move to the project, belongs to the project and not to a thread. Every thread of the project can show it. A shell shows it with the project, for example pinned in Hydra's panel for every thread of the project.
- Moving a window to another project or thread is the user's action, and the config script's (`windows.moveToThread`, `moveToProject`).

### Agents

| `agents.scope` | What an agent's tools reach |
|---|---|
| `thread` (default) | Its thread's windows and tabs, as now |
| `project` (opt-in) | Also its project's windows and tabs, and its other threads'. For the shared dev server's tab, or an editor every thread uses |

- An agent never reaches another project's windows, or windows that belong to no project.
- `agents.tools` can deny tools, or allow only some. A thread can narrow its project's scope but not widen it.
- Enforcement stays where it is: the helper checks the caller's thread (`PLUTONIUM_THREAD_ID` → its project) on every call. That's as strong as thread tagging itself ([AGENT_CONTROL.md](AGENT_CONTROL.md)). It keeps honest agents to their scope. It is not a sandbox against a hostile one.

### Keys

Projects and threads become contexts in [KEYS.md](KEYS.md): `project == "p_…"`, `projectTitle == "Plutonium"`, `thread == …`. A project's `keys` in your file are bindings with that `when`.

## The agent engine and its API

The helper runs the T3 server as a core service, the way it runs its other services, instead of as Hydra's `server`. What moves from Hydra into the helper:
- starting and supervising it (`bin/supervise`), and Network access;
- the one-at-a-time check on `~/.t3`, and the database version check;
- access: the helper hands shells a session, instead of each shell pairing with the server.

Shells use the helper's API. It's sized from what shells other than Hydra do with agents, not from what T3 offers:

| | |
|---|---|
| `projects` | `list`, `watch`, `create({ title, folder? })`, `config(id)`, `trust(id)` |
| `threads` | `list({ project })`, `watch`, `new({ project, prompt?, worktree? })`, `send(id, text)`, `stop(id)` |
| status | a thread's state (idle, working, waiting for approval, failed), as events |
| approvals | `list`, `answer(id, decision)`, so a shell can show them as notifications |
| `windows` | a window's thread and project; project windows |

Routes are `GET /v1/projects`, `/v1/threads` and their events, and the config script gets the same API (KEYS.md's `threads`, plus `projects`). The full chat UI stays Hydra's: other shells start threads, show their state, answer approvals, and open the thread in Hydra.

## The work, in order

1. **Projects in the helper:** the record, `~/.pluto/projects/`, the thread → project mapping, and reading T3's projects (one Plutonium project per T3 project, plus Home). Hydra's sidebar groups by them.
2. **Inheritance:** a project's `env` in its threads' environments (`threads.ts`), and `defaults.json`.
3. **The folder's config and trust:** `.pluto/project.json`, hashes, the prompt, `plutonium projects check` and `trust`. Worktrees.
4. **Project windows** and `apps` with `scope` and `start`.
5. **Agent scope:** `agents.scope` and `agents.tools` in `mcp.ts`'s checks.
6. **The agent engine as a core service**, and the agent API. Styx and Charon start threads, show status and answer approvals.
7. **Per-project browser profiles.** Needs a look at what the browser supports for profiles side by side.
8. **Keys:** project and thread contexts, once KEYS.md's contexts exist.

## Open questions

- Can a thread move between projects? Probably yes, as a user action, since a thread often starts in Home before you know what it's for. But its agent session has a working folder that would stay behind.
- Is there an agent with desktop scope, outside every project (a desktop assistant)? Leave it out until there's a use for one.
- `env.from`: when to recapture it (the inputs' mtimes, or a manual reload), and what a thread does while it's being captured.

## Decisions

- 2026-11-08: threads map to the desktop's workspaces, with projects above them; a project can exist without a folder, and then runs in `~/`; an agent's project scope is opt-in, per project; Plutonium owns projects and T3 keeps its own fields; shells use the helper's agent API, not T3's contracts.

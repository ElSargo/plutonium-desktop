# Fixing a problem an agent tool test found

The brief for a fixer thread in the agent tool testing loop (`README.md`, `.claude/skills/agent-tool-testing/`). The orchestrator gives you the problem, the reports, and its thread id. You fix; the orchestrator tests your fix with a real run and has it reviewed, then sends you the result if another round is needed.

## Your checkouts

- **This repository:** your thread's worktree and branch. Run `bin/plutonium worktree setup` first. If you run a session of your own (below), add `CONTAINER=plutonium` to its `plutonium.local.env`.
- **T3 Code** (server, MCP tools and their descriptions, web app): never edit `~/projects/t3code` itself. Make a worktree from its `plutonium` branch: `git -C ~/projects/t3code worktree add ~/.t3/worktrees/t3code/fix-<name> -b fix/<name> plutonium`. Build it with `T3CODE_DIR=<it> bin/plutonium hydra build`, test with `node_modules/.bin/vp test run <file>` in `apps/server` and typecheck with `npx tsc-rs --noEmit`. Commit there, then export into your branch: `T3CODE_DIR=<it> bin/plutonium hydra export`.
- **Chromium** (Exo, Ash, the browser): follow `~/chromium-wt/BRIEF.md` exactly. Edit only in a sparse worktree; the orchestrator runs every build (`BUILD REQUEST`).
- **The helper** (`helper/src`): test with `cd helper && npm test`.

## Rules

- When an agent misused a tool or couldn't find one, the fix is the tool or its description. Never a hint in a scenario's prompt.
- Descriptions are the agents' only guide. Say what a tool does, what it needs and what it returns. Don't describe the implementation.
- Real runs are the orchestrator's: don't run `tools/agent-tests/run.sh` or `session.sh`, and don't switch VTs. Never touch slot 0, the release in `/opt/plutonium`, or the T3 server on port 3773: that's the user's live desktop. For a quick check of your own, use your slot's X11 session (`docs/DEVELOPING.md`; the pitfalls are in the x11 notes there).
- Keep changes to shared files (`helper/src/daemon.ts`, `mcp.ts`, the shell library, `chrome/browser/plutonium_*`) small and additive: other fixers work on the same base in parallel.
- Update the feature doc (`docs/features/AGENT_CONTROL.md` and any other it touches) and `docs/BACKLOG.md`. Commit on your branch, in both repos where you changed both. Don't merge into main and don't push.
- A Flatpak started on a private D-Bus session bus (to keep its instance apart) starts a second document portal, and stopping it unmounts the user's `/run/user/<uid>/doc`: after that no Flatpak starts, on the live desktop too. When you clean up, check `mountpoint /run/user/$(id -u)/doc`, and if it's gone, `systemctl --user restart xdg-document-portal`.
- If something needs the user (a decision, a reboot, a permission), say so in your report instead of working around it.

## Reporting

Send one message with `t3_thread_send` to the orchestrator's thread, mode `"queue"`, then end your turn:

- `BUILD REQUEST <name>`: as in `BRIEF.md`.
- `DONE <name>`:
  - your branch and its commits;
  - the T3 worktree and commit, and the Chromium branch, if any;
  - what changed and why, in a few lines;
  - the tests you ran;
  - which test target applies: *live* (only T3's web app or the shells changed) or *session* (the helper, T3's server, or Chromium);
  - what the next run should show if the fix works.
- `QUESTION <name>`: when you're blocked.

If the orchestrator sends you a review that shows the fix didn't work, carry on from it in the same thread.

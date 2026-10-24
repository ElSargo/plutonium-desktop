---
name: agent-tool-testing
description: The workflow for changing or testing the tools agents use to drive native apps and browser tabs ("computer use" and "browser use" in Plutonium; list/launch/snapshot/click/type/read_window/act_window on windows, preview_* on tabs, recording, and how T3 Code's panel shows them). Use it whenever asked to add to, fix, or test these tools, or to run the agent tool tests.
---

# Agent tool testing

Start by telling the user: "This is a computer use task; I'll use the agent tool testing workflow." Then read `docs/agent-tests/README.md` (how tests run) and `docs/features/AGENT_CONTROL.md` (how the tools work).

Your role is the orchestrator. You run the loop and talk to the user. Fixing is done by a fixer subagent, testing by a fresh standalone tester thread, and judging by a reviewer subagent.

## 1. Pick the scenarios

- Choose the scenarios in `docs/agent-tests/scenarios/` that exercise the change. If none does, write one (README, "Writing a scenario"), as a task a user would ask for, with no tool hints.
- If no recent report in `docs/agent-tests/runs/` shows the current behaviour, run a baseline first (step 3) so the fix has something to be measured against.

## 2. Fix (a fixer thread per problem)

`t3_thread_launch` with `workspaceStrategy: {type: "worktree", baseRef: "main", branch: "t3/fix-<name>"}` and `modelSelection.instanceId` `claudeAgent` or `claudeAgent_claude_2`. Launch one per independent problem; they run in parallel. The message gives:
- its name, this thread's id (fixers report back with `t3_thread_send`), and "read `docs/agent-tests/FIXER.md` first" (absolute path in the main checkout);
- the problem, the review reports and run directories, and every earlier round's outcome and unresolved objections;
- which other fixers own neighbouring problems, so they don't overlap.

Fixers send `BUILD REQUEST` (you run the Chromium build: `~/chromium-wt/BRIEF.md`), `QUESTION` or `DONE`. Next rounds go to the same thread with `t3_thread_send`, so it keeps its context.

## 3. Test (a real run, in a new standalone thread)

Pick the target from what changed:

- **Live** (T3 Code's web app, the shells, the helper's `shell.js`: what `plutonium live apply` swaps). Apply it from the fixer's checkout (`plutonium live apply t3 --from <t3 worktree>`, or `niri`, `plain`, `shell-lib`), then `tools/agent-tests/run.sh <scenario>`. No need to ask. Afterwards `plutonium live revert …` unless the change is landing.
- **Session** (the helper and its MCP tools, T3 Code's server and its preview tools, Chromium and Exo, or anything that needs a restart). This takes over the screen, so:
  1. Ask, and fail open: tell the user in one short message what you're about to do (the test session on tty5, which switches the screen for the run, then back), and that replying "no" or `touch logs/agent-tests/veto` stops it. Send a `PushNotification` too. Then start `tools/agent-tests/grace.sh 150` with `run_in_background`, and end your turn.
  2. If the user answers no before the timer ends, don't run it. Kill the timer and ask how they want it tested. If the timer ends with no answer (or "vetoed" doesn't show), go ahead.
  3. `tools/agent-tests/session.sh --name at-<fixer> up --ref <fixer branch> [--t3 <T3 worktree>] --vt N` (in the background; building Chromium can take a while), then `tools/agent-tests/run.sh --checkout .worktrees/at-<fixer> --show <scenario>`, then `session.sh --name at-<fixer> down`. Always run `down`, even when something failed.

  Several sessions can be up at once, one per VT, but only the one on screen works, so `run.sh` takes turns (it waits for the screen and brings its session to the front). Chromium builds are serialized too.

`run.sh` takes up to the scenario's timeout, so run it in the background. It prints the run directory. If the thread ends early with "You've hit your session limit" as its last message, that Claude account is spent; the run isn't a result. Run it again with `--instance claudeAgent_claude_2` (or another instance from `orchestrator_capabilities`), and use the same instance for the fixer and reviewer tasks.

## 4. Review (subagent)

`delegate_task` with `role: "review"`, a new thread, and no isolation. The task: follow `docs/agent-tests/REVIEW.md` for the run directory and scenario. Include what the fix was meant to change, and name the earlier reports. It writes `docs/agent-tests/runs/<run>.md`. Read the report yourself, then check its verdict against `timeline.txt` and a frame or two.

## 5. Loop

A round passes when the problems it targeted are gone and the review shows no new ones. A problem that came and went needs two clean runs. If the round fails, go back to step 2 with the new report. Stop after 3 rounds without a pass, and bring the reports to the user.

## 6. Land, then the final test

When the fixes are merged into main (and the T3 checkout's `plutonium` branch, with `plutonium t3 export`):
1. Ask with the grace timer, as in step 3.
2. Run `session.sh up` with no `--ref` or `--t3`. That gives main's patches, a Chromium build of exactly them, T3 Code built from `plutonium`, and a fresh T3 server.
3. Run every scenario, have each run reviewed, then `session.sh down`.

Report to the user:
- per scenario, what passed and what failed;
- what was fixed, and the reports' paths;
- what's still open, added to `docs/BACKLOG.md`;
- new findings added to each scenario's "Known issues".

## Rules

- The tester gets the scenario's prompt and nothing else. Never message the tester thread during a run.
- Don't test on the live desktop what needs a restart. Never restart the live T3 server (`plutonium t3 server` on slot 0): it cuts the user's running agents, this one included.
- The test session's worktree is `.worktrees/agent-tests`. Leave it to `session.sh`.

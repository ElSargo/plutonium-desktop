# Agent tool tests

Tests of the tools agents use to drive their thread's native apps and browser tabs (`features/AGENT_CONTROL.md`), by an agent doing a real task with them. Unit and end-to-end tests (`DEVELOPING.md`) check that the tools work; these check that an agent can do the job with them, given only their descriptions, and that what the user sees stays right meanwhile.

## How a test runs

1. **A scenario** (`scenarios/<name>.md`) has the prompt, word for word, as a user would write it: no hints about which tools to use. It also has checks on the tool path (a task done through a workaround fails), things only the user would see, and the issues found so far.
2. **The tester** is a new top-level T3 Code thread, in a scratch folder, with no other instructions: `tools/agent-tests/run.sh <scenario>` launches it and waits. It talks to the session's T3 Code server over its MCP endpoint, with an `mcp-client` token it issues (`t3 auth session issue --runtime-mode-ceiling full-access`, T3 patch 0019).
3. **The record** goes to `logs/agent-tests/<run>/` in the main checkout: the tester's Claude transcript and a timeline made from it (every call, its input, time and result, and the images the agent saw), the thread as T3 shows it, a recording of the screen from KMS, the helper's, Ash's and T3's logs from the run, and any core dumps.
4. **The review** is done by another agent, following `REVIEW.md`: it checks the transcript against the screen and the logs, sorts each problem (tool bug, description gap, missing capability, agent mistake, app or environment, user-visible glitch), and writes `runs/<run>.md`.

## Where it runs

- **The live desktop** (`run.sh <scenario>` from the main checkout): the tester's thread is in the user's T3 Code, and its apps and tabs are in the live session. Good for changes that apply live (T3 Code's web app, the shells: `plutonium live apply`). The screen isn't recorded unless `--capture` is given, since it's the user's screen.
- **The test session** (`session.sh up`, then `run.sh --checkout .worktrees/agent-tests <scenario>`): a DRM session on a spare VT (tty5), in the worktree `.worktrees/agent-tests` (slot 1), at a given commit (`--ref`). It runs a dev build of that commit's Chromium patches (`chromium ensure`), its helper, and its own T3 Code server, with its own data (`~/.local/share/plutonium/agent-tests/t3-home`) and its own T3 checkout built from the `plutonium` branch, or a fixer's (`--t3-ref`, `--t3`). `--show` opens the tester's thread in the shell, so the panel shows what it does. `session.sh down` stops it and switches back. It takes over the screen while it runs.

Runs in one test session share its browser profile, so a site keeps what an earlier run stored there (an Excalidraw canvas, say). Reviewers should allow for it; `session.sh up` again for a clean profile.

## Files

| | |
|---|---|
| `tools/agent-tests/run.sh` | run one scenario and record it |
| `tools/agent-tests/session.sh` | the test session: `up`, `down`, `status` |
| `tools/agent-tests/timeline.ts` | a transcript as a timeline |
| `tools/agent-tests/frame.sh` | a frame of a run's screen recording at a timeline time |
| `tools/agent-tests/grace.sh` | wait for a veto before taking over the screen; fails open |
| `tools/agent-tests/t3mcp.ts` | call a T3 Code server's MCP tools from outside |
| `docs/agent-tests/scenarios/` | the scenarios |
| `docs/agent-tests/REVIEW.md` | the reviewer's brief and the report's form |
| `docs/agent-tests/runs/` | the reports |
| `.claude/skills/agent-tool-testing/` | the workflow agents follow to fix or add to these tools |

## Writing a scenario

Front matter: `name`, `model` (default `claude-opus-5-5`), `timeout` in minutes (default 20). Then `## Prompt` with the prompt in a fenced block, sent as it is; `## Checks`, numbered, on how the job was done; `## Watch for`, what only the screen shows; `## Known issues`, dated, with the thread or run they came from.

The prompt ends with the line every scenario uses, so the tester reports failures instead of spending the run on workarounds, and one failure doesn't end the run (asked only to report, a tester stopped at the first one):

> This is a test of the tools in this build. If a tool fails or behaves strangely, tell me exactly what happened. Don't build a workaround for it; carry on with the rest of the task as best you can.

Don't add hints to a prompt to get past a failure: a hint the tester needs is a description gap, fixed in the tool's description.

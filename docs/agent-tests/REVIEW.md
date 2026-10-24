# Reviewing an agent tool test run

The brief for the agent that reviews a run of `tools/agent-tests/run.sh`. The reviewer reads and judges; it doesn't fix anything or contact the tester thread.

## Inputs

- The scenario (`docs/agent-tests/scenarios/<name>.md`): its prompt, checks, things to watch for, and known issues.
- The run directory (`logs/agent-tests/<run>/`, listed at the top of `run.sh`).
- When the run tests a fix: what the fix was meant to change.
- Earlier reports for the scenario (`docs/agent-tests/runs/*-<name>.md`).

## Steps

1. **What was asked and claimed.** Read `meta.json`, `prompt.txt` and the tester's last `assistant_message` in `thread.jsonl`.
2. **What happened.** Read `timeline.txt` whole, and `tools.json`. For every `FAIL`, every retry, and every workaround (scripts, `preview_evaluate` or Bash used in place of a tool that should have done the job), note the time, the call and the outcome.
3. **Silent failures.** A tool that answered `ok` may still have done the wrong thing. Look at what the agent saw (`seen/`) after its actions, and check that each action had the effect the agent believed.
4. **What the user saw.** If there's a `screen.mkv`, take frames with `tools/agent-tests/frame.sh <run> <HH:MM:SS>` at the moments that matter: launches, resizes, dialogs and menus, clicks the scenario cares about, failures, the end. Look at them. Check every "Watch for" item, and note anything else odd: windows or menus where they shouldn't be, a panel out of step with the agent's actions, flicker, a crash.
5. **Logs.** Search `logs/` (helper, Ash, T3's server) around the failure times for errors, and read `coredumps.txt`. Name the component where you can.
6. **Classify each problem** as one of:
   - **tool bug**: the tool failed or did the wrong thing.
   - **description gap**: the agent misused a tool, or didn't find it, because its description misled it or was silent. Quote the description.
   - **missing capability**: there was no tool for what the task needed.
   - **agent mistake**: the tools were fine and the descriptions clear; the agent erred.
   - **app or environment**: the app or the machine (not on PATH, the app's own bug).
   - **user-visible glitch**: wrong in what the user sees, whatever the agent saw.
7. **Check the tester's report** against the evidence: failures it didn't mention, successes it claimed that didn't happen, causes it guessed.
8. **Compare** with the scenario's known issues and earlier reports: fixed, still failing, new.

Where you can find the cause in the code (`helper/src/`, the T3 checkout's `apps/server/src/mcp/` and `apps/web/src/plutonium/`, the Chromium patches), say where. Don't guess at causes you haven't checked; say what would tell.

## The report

Write it to `docs/agent-tests/runs/<run>.md` (the run directory's name), in this form:

```markdown
# <scenario>: <date> (<live desktop | test session at REF>, <model>)

Run `logs/agent-tests/<run>`, thread `<id>`: <status> after <min> min; <n> tool calls, <m> failed.
<When it tests a fix: the fix and what it was meant to change.>

## Verdict

| Check | Result | Evidence |
|---|---|---|
| 1. … | pass / fail / not reached | timeline time, frame, log line |

## Problems

### 1. <what went wrong> (<class>)

What happened, with timeline times. Evidence (frames, log lines, `seen/` images). Likely cause, and where. Suggested fix.

## The tester's report

What it got wrong or left out.

## Compared with earlier runs

Fixed / still failing / new.
```

Keep it short: one entry per distinct problem, most serious first. The report is what the fixer gets, so make each problem actionable on its own.

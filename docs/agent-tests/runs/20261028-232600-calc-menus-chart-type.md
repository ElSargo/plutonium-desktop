# calc-menus-chart-type: 2026-10-28 (X11 session, slot 26, main a927a6e + the helper fixes, claude-opus-5-5)

Run `logs/agent-tests/20261028-232600-calc-menus-chart-type`: completed after 2.9 min; 32 tool calls, 0 errors. Meant as the window-shown run, but `--show` failed (`run.sh --x11` used the DRM DevTools port; fixed), so hidden again. Written by the backlog worker that ran it (agent-scenarios), not a separate reviewer: checked against `timeline.txt` and the screen frames.

## Verdict

| Check | Result | Evidence |
|---|---|---|
| Fix: dialogs keep their size | pass | `read_window` on "Chart Type" at +103.6: frame @473,230 (946×460), not 1280×800. |
| Fix: `close_window` names the box | pass | +155.8: 0.4 s, `{"closed":false,"newWindows":["new window #4 (\"Save Document?\", 506×198)"]}`; answered by `act_window` at +160.2. |
| 1, 4, 6 | pass | As run 231956; no core dump. |
| 2. Wizard in `newWindows` | partial | As before: named by the next call. |
| 3. `select`, stale ref | not reached | Clicks again. |

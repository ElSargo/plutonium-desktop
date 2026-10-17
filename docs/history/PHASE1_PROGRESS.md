# Phase 1 progress: solid embedding core

Tracks the Phase 1 roadmap in [OPTION2_PLAN.md](OPTION2_PLAN.md). Chromium
changes live in `~/chromium/src` (branch `exo-viability`, build `out/Cros`);
test page `spike/phase1.html`, launcher `tools/launch-phase1.sh`. Screenshots
are `shots/phase1-*.png`.

Status: ✅ done and verified · 🟡 built, partly verified · ⬜ not started · ❌ failing

| # | Item | Status | Evidence / notes |
|---|------|--------|------------------|
| 1 | Pointer focus churn (explicit leave, no re-enter hack) | ✅ | One enter/leave per crossing; drag-out release delivered to app |
| 2 | Keyboard focus + IME | ✅ | Click app → app keyboard (kcalc `12*3=` → 36, GTK search "button", Firefox URL bar, foot); click page field → page keyboard; focus moves between apps. `weston-editor` text-input-v1: activate/enter/leave + handoff to the page (`ime2.png`). Composition untestable here (no IME engine) |
| 3 | Cursor shapes | ✅ | App cursor over app, page cursor elsewhere (`tools/xcursor_probe.c`). GTK: I-beam over entry, arrow over list, every time. Firefox cursor sometimes lags one move — same when Firefox is a plain Ash window, so not an embedding bug |
| 4 | Resize feedback (incl. fractional scale) | ✅ | CSS-resizing the GTK element to 543×372 → GTK 543×372 (`resize.png`), live during drags. At 1.25×: 420×330 element → 420×330 DIP window, sharp, clicks exact (`frac*.png`) |
| 5 | Detach from Ash windows | ✅ | Parked windows invisible/unclickable; removing the element returns the window to the desktop at its embedded size (`detached5.png`); re-adding re-parks it |
| 6 | Popups/menus relative to element | ✅ | kcalc menus; GTK hamburger popover (`gtk-menu.png`); Firefox tab list + URL dropdown (`ff-menu.png`) |
| 7 | Async hit-test correctness | ✅ | DOM overlay above window gets clicks, app does not; header button above scrolled-under kcalc gets the click |
| 8 | Multiple windows; `<native-window>` element | ✅ | kcalc + GTK Demo + Firefox side by side (`multi3.png`); GTK dialog appears as its own window (#4) and goes away on close |
| — | Exit: Firefox + GTK + Qt side by side; typing, menus, resize, scroll, no flicker | ✅ | All pass. Flicker: `tools/flicker_check.py` at ~30 ms/frame shows ≤0.2% backdrop (resize edge sliver) and no black/empty frames during resize and page scroll |
| — | Remove EXO-DBG logging; report; save patch | ✅ | `docs/PHASE1_REPORT.md`, `patches/exo-phase1.patch` (reverse-applies cleanly), README updated |

## Fixed along the way

- **Cursor overwritten by Chrome's arrow.** Mouse events injected into an
  embedded window also went through Ash's `CompoundEventFilter`, which set the
  cursor from the parked window (`kNull` → arrow). Injected events now carry
  `wm::kSkipCursorUpdateEventKey`. Also: a second `wl_pointer` of the same
  client that never set a cursor no longer overrides the real one.
- **Detached window came back 120px tall.** Unparking read the window size
  after moving it back to the normal container, which clamps it to the app's
  minimum; it now reads the size first and restores the pre-park position.
- **Page typing dead after an embedded text-input client.** Exo's
  `TextInput` took the browser window's input method and left it without a
  client; `ExoEmbedder` now hands it back to the page view on blur/close.
- **Launcher killed its caller** when the caller's command line mentioned a
  client name; it now skips shells and itself.

## Known issues / notes

- **GTK4 with the Vulkan renderer stalls the whole display on Xvfb**: dmabuf
  buffers can't be imported (no native pixmaps), the GPU process logs ~80k
  shared-image failures and stops presenting. Not embedding-specific (seen in
  the viability work). Tests run GTK with `GSK_RENDERER=cairo`. Worth a guard
  later: a client whose buffers fail to import should not stall everyone.
- **Modal dialogs**: GTK's About dialog becomes a separate embeddable window.
  While it is open GTK ignores input to the main window and keyboard goes to
  the dialog, but the page still shows the main window as keyboard-focused.
  Dialog placement is a Phase 2+ policy question.
- **Firefox does not get TILED states** (binds an older xdg-shell); it keeps
  its client-side shadow geometry, handled via window geometry offset.
- **Firefox minimum width is 500px**, so in a 420px element it is clipped.

## Log

- 2026-10-15: Tracker created. kcalc (Qt) fully exercised: render, resize,
  keyboard, menus, DOM occlusion.
- 2026-10-15: "Only one card" turned out to be the GTK Vulkan stall (DOM had
  all three). With cairo GTK: three apps side by side; typing, menus, resize,
  scroll verified. Fixed cursor overwrite and detach sizing. Removed debug
  logging.
- 2026-10-15: Fractional scale (1.25×), IME plumbing (weston-editor), foot,
  flicker measurement, detach/re-attach all verified; fixed page text input
  after text-input clients. Final regression pass on the last build (kcalc
  typing/menus/dismiss, overlay blocking, GTK popover) clean. Report + patch
  written. Phase 1 complete on Xvfb; DRM/dmabuf path not re-run.

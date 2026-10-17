# Option 2: a web-shell desktop with native windows and tabs as real elements

Date: 2026-10-15, revised 2026-10-16. Status:
- **Viability:** proven (`EMBED_SPIKE_V0.md`, `TTY_REPORT.md`, `VIABILITY_REPORT.md`).
- **Phases 1 and 2:** done on Xvfb (`PHASE1_REPORT.md`, `PHASE2_REPORT.md`), branch `exo-viability`.
- **First frontend:** T3 Code runs as the shell on the user's desktop (`T3_SHELL_TEST.md`), branch `t3-shell-test`.
- **Phase 3:** done (`PHASE3_REPORT.md`). The frontend-neutral helper and agent bridge work, and a second, plain frontend runs on the same substrate.
- **Phase 4:** done apart from autostart (`PHASE4_PROGRESS.md`). The shell boots on the panel from a VT; apps launch into it and take evdev input; fullscreen embedded apps and NV12 video go on display planes.
- **Phase 5, tabs:** first version working (`TABS_PROGRESS.md`). Real pages are `<embed>`s via Chromium's SurfaceEmbed rather than guest views; tabs are bound to threads and agents can drive them. Tested on Xvfb in the plain shell.

**Plutonium is the substrate, not a particular shell.** It provides the Chromium/Exo desktop, the `<native-window>` element and the window broker API. Any web app given the shell origin can be the frontend. T3 Code is the first one, used to prove the design end to end. It is one possible frontend, not a dependency: the substrate's Chromium changes know nothing about T3.

## 1. Goal

One userland program that is the whole desktop:

- **The shell is a web app.** We can build it with web tools or port an existing web app to it.
- **Native Wayland apps and real browser tabs are first-class elements in that page.** They can be laid out, scrolled, clipped, transformed and stacked like any other element, and they receive input properly.
- **Everything belongs to a chat thread.** Every native window and tab is bound to the agent thread that created it. An agent server (T3 Code's server, or any other) drives work through the shell and sees the windows and tabs of its own thread.

## 2. What is already proven

| Capability | Status | Evidence |
|---|---|---|
| Ash runs standalone on KMS/DRM (own VT) with Exo hosting Wayland clients | Works | `TTY_REPORT.md` |
| The shell page as the whole desktop on DRM, apps embedded with evdev input, fullscreen embedded apps and video on display planes | Works (started from a VT) | `PHASE4_PROGRESS.md` |
| Zero-copy dmabuf from client to display plane (fullscreen) | Works (91% of frames on a plane) | `TTY_REPORT.md` |
| Native windows as page elements (`<native-window>`): scroll, clip, z-order, transforms, resize, popups, keyboard and pointer focus, cursors | Works | `PHASE1_REPORT.md` |
| Only the shell origin can list, embed or drive native windows (broker, grants) | Works | `PHASE2_REPORT.md` |
| Real browser tabs as page elements, bound to threads, driven by the shell and agents | Works on Xvfb (plain shell) | `TABS_PROGRESS.md` |
| Windows off the Ash desktop unless a page shows them or the shell pops them out | Works | `T3_SHELL_TEST.md` |
| A real web app as the shell, with windows bound to agent threads, shown as panel tabs | Works with T3 Code, hand-tested on the user's desktop | `T3_SHELL_TEST.md` |
| Apps from agents, terminals and child processes (incl. Flatpak, Qt) | Works | `T3_SHELL_TEST.md` |
| X11 apps via a per-thread rootless Xwayland (xwayland-satellite) | Works (xterm tested; Minecraft via Prism not yet) | `T3_SHELL_TEST.md` |
| Frontend-neutral helper: thread environment, pid → thread, launching apps | Works for T3 and the plain shell | `PHASE3_REPORT.md` |
| Agent bridge: an agent lists, launches, snapshots (even hidden windows), focuses and closes its thread's windows over MCP | Works in both frontends with real Claude agents | `PHASE3_REPORT.md` |

## 3. Target architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│ Shell page (privileged WebUI / isolated web app, fullscreen)         │
│   <native-window grant=…>   <tab-frame src=…>   ordinary DOM UI      │
└─────────────┬───────────────────────┬────────────────────────────────┘
              │ embed + input routing │ (Controlled Frame / guest view)
┌─────────────▼───────────────────────▼────────────────────────────────┐
│ Browser process (Ash on DRM, Ash UI hidden)                          │
│  • Window broker: registry of native windows + tabs, thread ids,     │
│    grants (which page may embed which surface), lifecycle            │
│  • Exo: one Wayland server/socket per chat thread (SecurityDelegate) │
│  • Input router hook → Exo seat; keyboard focus arbitration          │
│  • Agent bridge ⇄ agent server (t3 server or similar)                │
└─────────────┬────────────────────────────────────────────────────────┘
              │ SurfaceDrawQuads, hit-test regions
┌─────────────▼────────────────────────────────────────────────────────┐
│ Viz (GPU): composites shell + embedded surfaces, promotes to         │
│ overlays/planes where possible (KMS via Ozone DRM)                   │
└──────────────────────────────────────────────────────────────────────┘
```

Key components:

1. **Substrate:** Ash on Ozone DRM, owning the display and input directly. Ash's own UI (shelf, tray, desks, window frames) is hidden or disabled. Its window manager survives only as the internal parent for Exo surfaces.
2. **Embedding element:** a proper element (working name `<native-window>`), replacing the spike's `canvas.embedSurface()`. Responsibilities:
   - show the surface as a `cc::SurfaceLayer`;
   - send its size to the app (`xdg_toplevel.configure`);
   - expose focus, title, app id and state to script;
   - host the app's popups and menus inside or around the element.
3. **Window broker** (browser-side service, new): the single source of truth for native windows and tabs.
   - Issues **grants**: opaque tokens that let a specific page embed a specific surface. They replace v0's "any renderer can link any sink".
   - Reports each window's client pid. The chat-thread binding is built on that by the frontend (item 4), so the broker stays frontend-neutral.
   - Exposes an API to the shell page (Mojo-backed JS API on a privileged origin).
4. **Thread binding.**
   - *Today:* the frontend's server puts the thread id in the environment of the processes it starts (agents, terminals) and gives them the Exo display and a per-thread X display. The broker reports each window's client pid. The frontend's server maps that pid to a thread by reading `/proc/<pid>/environ` up the parent chain. This works, but any process can copy the variable, and Ash has to share the host's pid namespace.
   - *Hardening option:* one Exo server per thread. Exo already supports several servers, each with its own `SecurityDelegate` and socket; that's how ChromeOS separates Crostini, ARC and Borealis. Windows would then be bound to the thread by construction (see roadmap Phase 5).
5. **Tabs:** real browser contents embedded in the shell, tagged with the thread id. *Built* with Chromium's SurfaceEmbed (`<embed type="application/x-chromium-surface-embed">`), not guest views: the tab is a browser-owned `WebContents` composited as a separate layer with child-frame input routing, and there's no scripting channel between shell and tab (`TABS_PROGRESS.md`).
6. **Frontend integration contract.** What a frontend needs from Plutonium, and what it supplies:
   - From Plutonium: the shell origin flag, `navigator.windowBroker` (windows, pids, grants, `showOnDesktop`), and `<native-window>`.
   - From the frontend: a server that starts thread processes with the thread environment and resolves pids to threads, and UI that shows each thread's windows.

   The frontend-agnostic parts (thread environment, per-thread X display, pid → thread, launching, the bridge) are in Plutonium's helper, `plutoniumd` (`helper/`). A frontend loads the helper's shell library, gives its server's thread processes the helper's `thread-setup`, and supplies the UI. In T3 Code that's about 620 lines across 14 files on the fork's `plutonium` branch, mostly panel UI. The plain shell (`shell/index.html`) is about 300 lines.
7. **Agent bridge:** list, launch, snapshot, focus and close the windows of the agent's own thread, as MCP tools (`plutonium.ts mcp`). The helper relays calls through the shell page, which holds the window broker (`PHASE3_REPORT.md`). Tabs too: open, navigate, snapshot, answer dialogs, focus and close (`TABS_PROGRESS.md`). Still missing: driving windows and pages (input).

## 4. Roadmap

Estimates are in **focused agent-days at the pace of this session**. They're guesses, not commitments, and exclude waiting on human verification. Each phase ends with a demo and a short report like the existing ones.

### Phase 0: Viability (done)
Exo on a desktop, zero-copy to display, embed spike v0.

### Phase 1: Solid embedding core (done, see `PHASE1_REPORT.md`)
`<native-window>` with pointer and keyboard focus, IME, cursors, resize, popups, async hit-testing and multiple windows per page. Embedded toplevels are parked off the Ash desktop.

### Phase 2: Security model and broker (done, see `PHASE2_REPORT.md`)
Window broker in the browser process; grant-checked embedding and input; broker API only for the `--plutonium-shell-origin` document; push events instead of the registry file.

### Phase 2b: First frontend, T3 Code (done, see `T3_SHELL_TEST.md`)
A test of the substrate with a real web app, done ahead of the original Phases 4 and 5. T3 Code is one possible frontend; the broker API is the same for any other.
- **Shell:** T3 Code (web build) is the shell page.
- **Thread binding:** windows from agents, terminals and their children are bound to threads through the pid and environment scheme (section 3, item 4).
- **Panel UI:** an Apps surface in T3's right panel lists a thread's windows and opens each as a tab. Apps pop out to the desktop on request and stay hidden otherwise.
- **X11 apps:** a per-thread rootless Xwayland through xwayland-satellite.
- **Substrate changes it needed:** client pid in the broker, `showOnDesktop`, `--plutonium-hide-windows`, `wl_output` v4.

### Phase 3: Frontend-agnostic integration and agent bridge (done, see `PHASE3_REPORT.md`)
1. **Extract the frontend-agnostic pieces** out of the T3 fork into a small Plutonium helper (library or sidecar): the pid-to-thread resolver, the per-thread X display, and the launch environment. A frontend then only adds UI.
2. **Agent bridge:** let a thread's agent list, focus, close and snapshot its own windows (snapshots via viz `CopyOutputRequest`, no screen capture). Expose it in a frontend-neutral form, e.g. an MCP server, so any agent server can use it.
3. **A second, minimal frontend** (e.g. `spike/phase1.html` grown into a plain shell) built only on the broker API and the helper, to prove nothing depends on T3.
4. **Panel mouse issue** reported on `:0` (BACKLOG): diagnose from the `EXO-EMBED` logs.

Exit: an agent in either frontend opens an app, sees a snapshot of it and closes it, with no frontend-specific Chromium code. **Met** with Claude agents in T3 Code and the plain shell. Item 4 is diagnosed but not fixed: the renderer sometimes answers "page" for a press over a window. It now logs which element took the press; the next `:0` session will tell.

### Phase 4: Shell substrate on DRM (≈ 3–5 days)
1. **Boot straight into the shell:** Ash on DRM with the frontend's page fullscreen and Ash's shelf, tray, desks and frames hidden. Builds on `TTY_REPORT.md`'s launcher, flags and the `--exo-viability-real-displays` patch. *Built:* `--plutonium-shell-url` (the page as the only, fullscreen window; Ash in kiosk app mode) and `tools/launch-drm-shell.sh`. *Done:* verified on the panel (from a logged-in VT; no autostart yet).
2. **Validate embedding on the GPU path:**
   - dmabuf surfaces embedded in the page (v0 was software/shm only);
   - check whether a fullscreen embedded window still gets promoted to a display plane;
   - fix the TTY report's open items: the empty primary plane blocking direct scanout, and NV12 overlays.

   *Done:* dmabuf apps render in the page. A fullscreen embedded window goes on a plane (underlay at scale 1.78; no Ash composite at all at scale 2). NV12 goes on a plane. The "empty primary plane" was AMD's topmost-plane rule meeting buffers 4 px short of the panel (fractional scale 1.775).
3. **Real input on the TTY** (keyboard and mouse via evdev), verified by hand. Keep the kill switch. *Done* with virtual uinput devices (not by hand). Found and fixed the hit-test bug behind the `:0` mouse issue.

Exit: power on → shell page on the panel; launch apps into it; zero-copy where possible.

### Phase 5: Tabs, hardening and polish (ongoing)
1. **Tabs per thread:** real browser contents, created through the broker and tagged with a thread. *First version done* (SurfaceEmbed; `TABS_PROGRESS.md`); still to do: DRM and T3, the browser features a tab lacks without a `Browser`, session restore.
2. **Per-thread Exo servers** (section 3, item 4) if pid and environment binding proves too weak. This also removes the need for a host pid namespace.
3. **Clipboard and drag-and-drop** between web content and native apps (Exo has `wl_data_device`; bridge it to the shell).
4. **Accessibility, multi-monitor and HiDPI polish.**
5. **Missing Wayland protocols** noted in `VIABILITY_REPORT.md` (`xdg_activation`, cursor-shape, text-input-v3, explicit sync, …), as apps demand them.
6. **Packaging:** move from the dev container to a reproducible build and run on NixOS, including xwayland-satellite.

## 5. Risks and open questions

| Risk | Why it matters | Mitigation |
|---|---|---|
| **Upstream churn** | Ash/Exo/viz/Blink move fast; the patch set touches ~90 files | Keep changes additive (new element, new service, flags, small hooks); rebase regularly; group patches by subsystem |
| **Running Ash outside ChromeOS** | linux-chromeos on DRM is not a supported configuration; ChromeOS-only assumptions keep surfacing (displays, keyboard layouts, sign-in), and DCHECK builds crash on them (BACKLOG: shadow DCHECK) | Gate fixes behind our own switches; keep a list of every such assumption |
| **Coupling to one frontend** | Integration logic living only in the T3 fork would make T3 a de facto dependency, and the fork must track upstream T3 | Done in Phase 3: the generic parts are in the helper, and the plain shell proves them. Keep the T3 changes UI-only |
| **Thread binding strength** | Environment tagging can be copied or lost (sandboxes, daemons, apps re-parented to init) | Parent-chain fallback today; per-thread Exo servers if needed (Phase 5) |
| **Focus and input semantics** | Keyboard, IME, popups and drag-and-drop between DOM and native apps is the hardest UX surface; one mouse issue is still open on `:0` | Input logs in the launcher; test with GTK, Qt, Firefox, X11 and a terminal |
| **Performance when embedded** | Embedding adds a composite step unless viz can still use display planes | Measure in Phase 4; fullscreen and opaque cases should still be promotable (viz flattens surfaces before overlay selection) |
| **Exo protocol gaps** | Some apps or bridges need protocols or versions Exo lacks | Add on demand (each was small so far: `wl_compositor` v4, `xdg_output.name`, `wl_output` v4) |

## 6. Immediate next steps

1. **Commit** the Phase 3 and 4 work (Chromium, T3 fork, this repo); the Chromium diffs are `patches/exo-phase3.patch` and `patches/exo-phase4.patch`.
2. **Bridge follow-ups:** MCP for Codex and other providers in T3; driving windows (input) for agents; the helper URL handed to the page automatically.
3. **Phase 4 leftovers:** autostart at power-on; T3 Code as the frontend on DRM; the input hotplug fix in `cros-drm`; a shell scale that makes fullscreen buffers exact (`PHASE4_PROGRESS.md`, "Next").
4. **Check the hit-test fix on `:0`** with T3 (the right-panel mouse issue).
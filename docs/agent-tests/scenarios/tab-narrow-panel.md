---
name: tab-narrow-panel
model: claude-opus-5-5
timeout: 15
---

# A phone-sized tab in the side panel

Browser tab tools on a narrow viewport the agent sets, with the tab in T3 Code's side panel (backlog "Agent tool paths no run has reached yet", 2026-10-28): `preview_resize` to a phone's size, a responsive page's own mobile menu, clicks read off narrow snapshots, and the panel's agent cursor on the resized tab. `excalidraw-spiral-sized` reached only the floating preview.

How to run: `--show`, and once the tab is open, open the side panel on it as the user would (the thread's browser button in the header), so the panel, not the floating preview, shows it.

## Prompt

```text
I want to see how python.org works on a phone. Open it in a browser tab, set the page to 390 by 844, open the site's own navigation menu (the one it shows on small screens), and go to the Downloads section from there. Tell me what the latest Python release is, and show me the page at the end.

This is a test of the tools in this build. If a tool fails or behaves strangely, tell me exactly what happened. Don't build a workaround for it; carry on with the rest of the task as best you can. Don't stop to ask me anything (nobody is watching); make a sensible choice and say what you chose.
```

## Checks

1. The page is set to 390×844 with `preview_resize`, whose reply gives that size; snapshots after report a 390×844 viewport and image.
2. The page is in its narrow layout (the menu button shown, the wide navigation hidden).
3. The menu button and the Downloads link are clicked by points read off the snapshots (or refs), and the clicks land: the menu opens, then the Downloads page loads.
4. The release named matches what the Downloads page says.

## Watch for

On the screen frames:

- The side panel shows the tab at 390×844, scaled to fit and centred.
- The panel's agent cursor sits where each click lands on the narrow page, not offset as if the tab were the panel's width.

## Known issues

- 2026-10-28 (run `20261028-232928-tab-narrow-panel`, X11 slot 26, `--show`, the side panel opened by hand): the panel showed python.org at 390×844, but every `preview_snapshot` and `preview_click` after `preview_resize` timed out at 15 s, so nothing else was reached. Probes on example.com (same session): a shown tab (side panel or floating preview) times out on the first snapshot after a resize, at 390×844 and at 1024×768 (5 of 5), and a click after works; a snapshot before the resize works. On a tab no page shows, the snapshot works but the page stays 1280×800 (the resize doesn't reach it). The same resize-then-snapshot passed on 2026-10-24 (`excalidraw-spiral-sized`). Raw `Page.captureScreenshot` and `requestAnimationFrame` on the tab answered at once meanwhile, so it's in T3's snapshot path or in how the shown tab takes its fixed size; not found yet. The panel's cursor and the menu clicks are still unseen.
- 2026-10-29 (run `20261029-004552-tab-narrow-panel`, X11 slot 28, `--show`, the side panel opened by hand; Chromium patch 0092): the snapshots after `preview_resize` take 0.2 s, and Downloads is reached. python.org's "≡ Menu" link is `display: none` without touch input, so a click on it waits out its 15 s for visibility; the tester went through the footer site map that link points to. The panel's cursor is on the point hovered on the scaled 390×844 page (a probe, `cursor-probe`); it hides a few seconds after the last move, so the 2 s frames rarely catch it after a click.

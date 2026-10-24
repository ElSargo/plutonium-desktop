---
name: excalidraw-incognito
model: claude-opus-5-5
timeout: 15
---

# Excalidraw in a normal and a private tab

Browser tab tools with a private (incognito) tab next to a normal one: `preview_open` with `profileId: "incognito"`, storage kept apart, both tabs driven in turn. Written 2026-10-24 for the `drag` fix's incognito part (Chromium patch 0045, T3 patch 0023), which no other scenario reaches.

## Prompt

```text
Open excalidraw.com and draw a square. Then open excalidraw.com again in a private (incognito) tab: does the square show up there? Draw a circle in the private tab. Then go back to the first tab and check whether it has only the square or the circle too. Tell me what you found in each tab.

This is a test of the tools in this build. If a tool fails or behaves strangely, tell me exactly what happened. Don't build a workaround for it; carry on with the rest of the task as best you can. Don't stop to ask me anything (nobody is watching); make a sensible choice and say what you chose.
```

## Checks

1. The private tab is opened with the tools' own incognito option (`preview_open` with `profileId: "incognito"` or equivalent), not by faking it (clearing storage, a fresh URL, `preview_evaluate`).
2. The private tab starts with an empty canvas: no square.
3. After the circle is drawn in the private tab, the normal tab still has only the square (a reload or a fresh read of its storage, not just the tab as it was left).
4. Both shapes are drawn with the input tools (`preview_drag`, `preview_click`, `preview_press`), and the final snapshots show them.
5. Both tabs keep working when the agent switches between them: no timeouts, no action landing in the wrong tab.

## Watch for

In the screen recording (session runs with `--show`):

- The private tab shows in its element (panel or floating preview) and takes input, like the normal one.
- The agent cursor shows in the tab that's being driven.

## Known issues

(none yet)

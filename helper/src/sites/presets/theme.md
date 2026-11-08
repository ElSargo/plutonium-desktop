---
title: Theme
description: Restyle the site to match the desktop, in light and dark
order: 1
---
Restyle this site so it looks at home on the user's desktop, in the "theme" part.

- Follow the desktop's light or dark (`prefers-color-scheme`, and `site.on("appearance")`), not the site's own theme switch. Both schemes must look right: check the tab in each if you can.
- Prefer the site's own design tokens: most sites define CSS custom properties (`--color-…`, `--bg`, Tailwind's, Material's, GitHub's Primer). Override those on `:root` (or the element that defines them) before overriding selectors; it's smaller and survives redesigns better.
- Use neutral surfaces close to the desktop's: a near-black or near-white background, slightly raised panels, text with good contrast, one accent colour (`AccentColor` is the system accent where the page supports it).
- Check every state the page shows: hover, focus rings (never remove them), selected rows, disabled controls, menus, dialogs, code blocks, inputs.
- Don't change layout or sizes in this part; that's another request.

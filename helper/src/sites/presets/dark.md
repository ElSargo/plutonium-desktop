---
title: Dark
description: A dark version for a site that has none
order: 5
---
Give this site a dark version, in the "dark" part, for when the desktop is dark (`@media (prefers-color-scheme: dark)`; leave it unchanged in light).

- Keep the site's own look: its accent colours, typography and layout. Swap backgrounds to dark greys (not pure black), text to light greys, borders to subtle lighter lines.
- Don't invert images, videos, logos or charts; dim large bright images slightly if they glare.
- Check contrast (text 4.5:1 or better), focus rings, hover and selected states, inputs and code blocks.
- If the site has its own dark mode, turn that on instead (its toggle, a class on `<html>`, or a `data-theme`), and only fix what it misses.

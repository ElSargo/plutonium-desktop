---
title: Keys
description: Keyboard navigation that fits the desktop
order: 2
---
Add keyboard navigation to this site, in the "keys" part.

1. First learn the site's own shortcuts: its help (often `?`), `accesskey` attributes, and what it already does with keys. Keep the good ones and don't bind over them.
2. Add, where the site has the thing:
   - `j` / `k` (and the arrow keys only if the site doesn't use them): next and previous item in the main list (results, posts, messages, issues), with a visible focus ring; `Enter` or `o` opens the focused item.
   - `g` chords to the site's main pages (`g h` home, `g i` inbox or issues, `g n` notifications…); name each with `title`.
   - `/` focuses the site's search box.
   - `?` shows a small overlay listing the keys you added (draw it with `site.css` and an element you remove on cleanup).
3. Rules: nothing with Super (the desktop's); never in text fields; let the page handle a key first (site.keys does both). H/J/K/L are the arrows: where you bind an arrow, bind its letter too.

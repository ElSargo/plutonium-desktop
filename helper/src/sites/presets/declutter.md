---
title: Declutter
description: Hide what isn't the content
order: 3
---
Hide what isn't the content on this site, in the "declutter" part.

- Hide promoted and sponsored items, recommendations and "you might also like", cookie and newsletter banners (once dismissed is better than hidden, where a button does it), sign-up nags, floating chat bubbles, and sticky headers or footers that take more than a sliver of the screen (make them static instead of hiding them if they hold navigation).
- **Hide, don't remove** (`display: none`, or `hidden`): removing nodes breaks the page's own scripts.
- Ads: hide their containers by stable attributes (`[data-ad]`, `[aria-label="Advertisement"]`, ids), not by guessing class names. Blocking ad requests is a content blocker's job, not this part's.
- Keep everything the user came for, and the site's navigation. When in doubt, leave it.

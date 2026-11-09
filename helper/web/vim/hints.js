// Labels inside a page for a shell's jumps (HYDRA_KEYBOARD.md, "Jumps"): a
// shell that labels what's on screen (Hydra's S and gw) asks each tab it
// shows, through the helper, for what can be labelled there; the shell draws
// the labels, and when one is typed the tab goes to its target. The labels
// are the shell's, so a tab's never clash with the shell's own.

const SIGNIFICANT = [
  "a[href]", "button:not([disabled])", '[role="button"]', '[role="tab"]', '[role="link"]',
  '[role="menuitem"]', '[role="option"]', '[role="checkbox"]', '[role="switch"]', "summary",
  "input:not([type=hidden]):not([disabled])", "textarea:not([disabled])", "select",
  '[contenteditable=""]', '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])',
].join(",");

const WORD = /[\p{L}\p{N}_][\p{L}\p{N}_'’-]{2,}/gu;
const MAX_WORDS = 500;

function onScreen(view, r) {
  return r.width >= 2 && r.height >= 2 && r.bottom > 0 && r.right > 0 && r.top < view.innerHeight && r.left < view.innerWidth;
}

/** Whether `el` is what's drawn at its own centre: not covered by a dialog or a banner. */
function onTop(doc, el, r) {
  const x = Math.max(0, Math.min(doc.defaultView.innerWidth - 1, r.left + Math.min(r.width / 2, 12)));
  const y = Math.max(0, Math.min(doc.defaultView.innerHeight - 1, r.top + r.height / 2));
  const hit = doc.elementFromPoint(x, y);
  return Boolean(hit) && (hit === el || el.contains(hit) || hit.contains(el));
}

/**
 * The page's targets: what can be clicked or typed into ("significant"), or
 * every word ("word"), each with its rect in the page's viewport. The page
 * keeps them for go(), until the next call.
 */
export function collect(doc, kind) {
  const view = doc.defaultView;
  const kept = [];
  const items = [];
  const add = (target, r) => {
    items.push({ id: kept.length, x: r.left, y: r.top, w: r.width, h: r.height });
    kept.push(target);
  };
  if (kind === "word") {
    const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, view.NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (node.parentElement?.closest("script, style, noscript, textarea, [aria-hidden='true']")
        ? view.NodeFilter.FILTER_REJECT : view.NodeFilter.FILTER_ACCEPT),
    });
    for (let node = walker.nextNode(); node && kept.length < MAX_WORDS; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !onScreen(view, parent.getBoundingClientRect())) continue;
      for (const m of node.data.matchAll(WORD)) {
        const range = doc.createRange();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        const r = range.getClientRects()[0];
        if (r && onScreen(view, r) && onTop(doc, parent, r)) add({ el: parent, range }, r);
        if (kept.length >= MAX_WORDS) break;
      }
    }
  } else {
    const seen = [];
    for (const el of doc.querySelectorAll(SIGNIFICANT)) {
      if (el.closest('[aria-hidden="true"], [inert]')) continue;
      const r = el.getBoundingClientRect();
      if (!onScreen(view, r) || !onTop(doc, el, r)) continue;
      // A control inside another at the same place (a link wrapping a button): one label.
      if (seen.some((s) => s.el.contains(el) && Math.abs(s.r.left - r.left) < 8 && Math.abs(s.r.top - r.top) < 8)) continue;
      seen.push({ el, r });
      add({ el }, r);
    }
  }
  return { kept, items, viewport: { width: view.innerWidth, height: view.innerHeight } };
}

/** Goes to a collected target: a field takes the keyboard (a word in it, the cursor), a word in plain text is selected, anything else is clicked. */
export function go(doc, target) {
  if (!target) return false;
  const { el, range } = target;
  if (!el?.isConnected) return false;
  const view = doc.defaultView;
  const editable = el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
  if (range) {
    const sel = doc.getSelection();
    if (editable) {
      editable.focus();
      sel?.collapse(range.startContainer, range.startOffset);
      return true;
    }
    const clickable = el.closest("a[href], button, [role='button'], [role='link'], [role='tab']");
    if (clickable) {
      clickable.focus({ preventScroll: true });
      clickable.click();
      return true;
    }
    sel?.removeAllRanges();
    sel?.addRange(range);
    return true;
  }
  if (editable === el) {
    el.focus();
    return true;
  }
  el.focus?.({ preventScroll: true });
  if (el instanceof view.HTMLElement) el.click();
  return true;
}

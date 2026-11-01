// The bar's minimap (on the left): the workspaces as numbered dots, and the
// focused one's strip of columns at the screen's proportions, each window as
// its app's icon (a tab as its site's), with the part on screen outlined.
// Click a window to go to it, a dot to go to its workspace; the wheel over
// the strip moves between columns. A window dragged onto a dot (Super+drag,
// or a drag in the overview) moves to that workspace: the dots carry
// data-niri-ws, which index.html's drop targets look for.
//
// It moves with the layout, 1:1: the current-workspace pill slides along the
// dots and the strips (one per workspace, stacked like the workspaces) slide
// up and down as a vertical swipe goes, and the strip's view scrolls with a
// sideways one. The DOM is built only when the layout's structure changes;
// a frame of a swipe (move()) only sets transforms (and a width when it
// changes), and between swipes the same values go through CSS transitions
// with the layout's own --anim, so they keep pace with the windows.

const CSS = `
.niri-minimap { display: flex; align-items: center; gap: 6px; height: 100%; padding: 0 4px; min-width: 0; }
.niri-minimap .ws { position: relative; flex: none; contain: layout style; }
.niri-minimap .dots { display: flex; gap: 3px; }
.niri-minimap .dot {
  min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; display: grid; place-items: center;
  font: 10px/1 system-ui, sans-serif; color: var(--muted); background: #ffffff10; cursor: pointer;
}
.niri-minimap .dot:hover { background: #ffffff22; }
.niri-minimap .dot.empty { opacity: .45; }
.niri-minimap .dot.drop { outline: 2px solid var(--focus); opacity: 1; }
/* The current workspace's pill, its labels inked: the labels inside move back
   as far as the pill moves, so they stay over the dots. */
.niri-minimap .pill {
  position: absolute; left: 0; top: 0; height: 16px; border-radius: 8px; overflow: hidden;
  background: var(--focus); pointer-events: none; will-change: transform;
}
.niri-minimap .pill .dots { will-change: transform; }
.niri-minimap .pill .dot { color: #101012; background: none; }
.niri-minimap .reelview { position: relative; height: 22px; overflow: hidden; flex: none; contain: strict; }
.niri-minimap .reel { position: absolute; left: 0; top: 0; right: 0; will-change: transform; }
.niri-minimap .row { position: absolute; left: 0; height: 22px; display: flex; gap: 6px; align-items: center; }
.niri-minimap .strip { position: relative; height: 22px; border-radius: 5px; background: #ffffff08; overflow: hidden; flex: none; contain: strict; }
.niri-minimap .track { position: absolute; inset: 0; }
.niri-minimap .col { position: absolute; top: 2px; bottom: 2px; display: flex; flex-direction: column; gap: 1px; }
.niri-minimap .win {
  position: relative; flex: 1; min-height: 0; display: grid; place-items: center; border-radius: 3px;
  background: #ffffff14; cursor: pointer; overflow: hidden;
}
.niri-minimap .win:hover { background: #ffffff2a; }
.niri-minimap .win.focused { background: color-mix(in srgb, var(--focus) 45%, transparent); box-shadow: inset 0 0 0 1.5px var(--focus); }
.niri-minimap .win img, .niri-minimap .win .letter { height: min(14px, 100%); aspect-ratio: 1; object-fit: contain; }
.niri-minimap .letter { border-radius: 3px; font: 600 9px/14px system-ui, sans-serif; text-align: center; color: #fff; }
.niri-minimap .count {
  position: absolute; right: 1px; bottom: 0; font: 600 8px/1 system-ui, sans-serif; color: var(--text);
  text-shadow: 0 0 2px #000;
}
.niri-minimap .view {
  position: absolute; left: 0; top: 0; bottom: 0; border: 1.5px solid #ffffff99; border-radius: 5px; pointer-events: none;
}
.niri-minimap .floats { display: flex; gap: 2px; flex: none; }
.niri-minimap .floats .win { width: 18px; height: 18px; flex: none; }
.niri-minimap :is(.pill, .pill .dots, .reelview, .reel, .strip, .track, .view) {
  transition: transform var(--anim), width var(--anim);
}
body.noanim .niri-minimap *, .niri-minimap.jump * { transition: none !important; }
`;

const INNER = 18; // a column's height in the strip
const ROW = 22; // a strip's height
const PITCH = ROW + 6; // from one workspace's strip to the next
const MAX_W = 240;
const MIN_COL = 20;
const FLOAT = 18, FLOAT_GAP = 2, ROW_GAP = 6;

/**
 * Mounts the minimap in `container`. `niri` is the layout's side (index.html):
 * workspaces(), focused(), screen() ({ width, height, gap }), position()
 * ({ ws: the workspace on screen, fractional mid-swipe; views: each
 * workspace's viewX }), focus(key), focusWorkspace(index), focusColumn(delta).
 * Returns { update, move }: the layout calls update() after a render, move()
 * after a frame of a swipe (only the position changed).
 */
export function mountMinimap(shell, container, niri) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  const root = document.createElement("div");
  root.className = "niri-minimap";
  // The parts that stay: the transitions run on these across rebuilds.
  const wsBox = Object.assign(document.createElement("div"), { className: "ws" });
  const pill = Object.assign(document.createElement("div"), { className: "pill" });
  const reelView = Object.assign(document.createElement("div"), { className: "reelview" });
  const reel = Object.assign(document.createElement("div"), { className: "reel" });
  reelView.append(reel);
  reelView.addEventListener("wheel", onWheel, { passive: false });
  root.append(wsBox, reelView);
  container.append(root);

  // Icons by app id (or a tab's origin): an object URL, or null for none.
  const icons = new Map();
  const iconFor = (key) => {
    const [kind, raw] = key.split(":");
    if (kind === "w") {
      const window = shell.windows.get(Number(raw));
      const name = window?.appId || window?.title || "?";
      const id = window?.appId ? `app:${window.appId}` : window?.iconName || window?.icon ? `window:${window.id}` : "";
      return { id, label: name, title: window?.title || name,
        load: () => shell.windowIcon(window).catch(() => null) };
    }
    const tab = shell.tabs?.get(Number(raw));
    let origin = "";
    try { origin = /^https?:$/.test(new URL(tab?.url).protocol) ? new URL(tab.url).origin : ""; } catch {}
    const host = origin ? new URL(origin).hostname.replace(/^www\./, "") : "";
    return { id: origin ? `site:${origin}` : "", label: host || tab?.title || "?", title: tab?.title || tab?.url || "tab",
      // The helper's (some sites forbid this page their /favicon.ico), else the page's own try.
      load: () => (origin ? Promise.resolve(shell.siteIcon?.(origin) ?? null).then((url) => url ?? probe(`${origin}/favicon.ico`)) : Promise.resolve(null)) };
  };
  const probe = (src) => new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image.naturalWidth ? src : null);
    image.onerror = () => resolve(null);
    image.src = src;
  });
  const letter = (label) => {
    const span = document.createElement("span");
    span.className = "letter";
    span.textContent = label.replace(/^.*\./, "").charAt(0).toUpperCase() || "?";
    let hue = 0;
    for (const c of label) hue = (hue * 31 + c.charCodeAt(0)) % 360;
    span.style.background = `hsl(${hue} 40% 38%)`;
    return span;
  };
  const iconElement = (key) => {
    const info = iconFor(key);
    const fallback = letter(info.label);
    if (!info.id) return { element: fallback, info };
    const known = icons.get(info.id);
    if (typeof known === "string") return { element: Object.assign(new Image(), { src: known, alt: "" }), info };
    if (known === undefined) {
      const loading = info.load().then((url) => { icons.set(info.id, url ?? null); return url; });
      icons.set(info.id, loading);
    }
    const pending = icons.get(info.id);
    if (pending instanceof Promise) {
      pending.then((url) => {
        if (url && fallback.isConnected) fallback.replaceWith(Object.assign(new Image(), { src: url, alt: "" }));
      });
    }
    return { element: fallback, info };
  };

  // Cells by item, for the focus to move without a rebuild: [cell, keys it stands for].
  let cells = [];
  const win = (key, keys = [key]) => {
    const cell = document.createElement("div");
    cell.className = "win";
    const { element, info } = iconElement(key);
    cell.title = info.title;
    cell.append(element);
    if (keys.length > 1) cell.append(Object.assign(document.createElement("span"), { className: "count", textContent: String(keys.length) }));
    cell.addEventListener("click", (e) => { e.stopPropagation(); niri.focus(key); });
    cells.push([cell, keys]);
    return cell;
  };

  // What's built: the workspace ids, the dots' places, and per workspace its
  // strip's parts and how to place its view.
  let signature = "";
  let ids = [];
  let dotX = [], dotW = [];
  let inkDots = null;
  let rows = [];
  let focusedNow;

  function build(workspaces, screen) {
    cells = [];
    const dots = Object.assign(document.createElement("div"), { className: "dots" });
    inkDots = Object.assign(document.createElement("div"), { className: "dots" });
    inkDots.setAttribute("aria-hidden", "true");
    for (const ws of workspaces) {
      const dot = document.createElement("span");
      dot.className = `dot${ws.empty ? " empty" : ""}`;
      dot.textContent = String(ws.index + 1);
      dot.dataset.niriWs = ws.id;
      dot.title = `Workspace ${ws.index + 1}`;
      dot.addEventListener("click", () => niri.focusWorkspace(ws.index));
      dots.append(dot);
      inkDots.append(Object.assign(document.createElement("span"), { className: "dot", textContent: String(ws.index + 1) }));
    }
    pill.replaceChildren(inkDots);
    wsBox.replaceChildren(dots, pill);

    rows = workspaces.map((ws, wi) => buildRow(ws, wi, screen));
    reel.replaceChildren(...rows.map((r) => r.row));
    ids = workspaces.map((ws) => ws.id);
    // One layout, to know where the dots are.
    dotX = [...dots.children].map((d) => d.offsetLeft);
    dotW = [...dots.children].map((d) => d.offsetWidth);
    focusedNow = undefined;
  }

  function buildRow(ws, wi, screen) {
    const { width: W, height: H, gap: g } = screen;
    // World x to strip x: each column gets at least MIN_COL, so stretch per column.
    let scale = INNER / H;
    const segments = () => ws.columns.map((c) => Math.max(MIN_COL, (c.w + g) * scale));
    let segs = segments();
    const sum = (list) => list.reduce((s, v) => s + v, 0);
    if (sum(segs) + 2 * g * scale > MAX_W) { scale *= MAX_W / (sum(segs) + 2 * g * scale); segs = segments(); }
    const starts = [];
    segs.reduce((x, s, i) => { starts[i] = x; return x + s; }, 0);
    const end = sum(segs);
    const worldEnd = ws.columns.length ? ws.columns.at(-1).x + ws.columns.at(-1).w + g : 0;
    const pad = g * scale;
    const mapX = (x) => {
      if (x <= 0) return pad + x * scale;
      const ci = ws.columns.findIndex((c) => x < c.x + c.w + g);
      if (ci < 0) return pad + end + (x - worldEnd) * scale;
      const c = ws.columns[ci];
      return pad + starts[ci] + ((x - c.x) / (c.w + g)) * segs[ci];
    };

    const row = Object.assign(document.createElement("div"), { className: "row" });
    row.style.top = `${wi * PITCH}px`;
    const strip = Object.assign(document.createElement("div"), { className: "strip" });
    const track = Object.assign(document.createElement("div"), { className: "track" });
    ws.columns.forEach((col, ci) => {
      const box = document.createElement("div");
      box.className = "col";
      box.style.left = `${starts[ci] + pad}px`;
      box.style.width = `${Math.max(4, segs[ci] - 2)}px`;
      if (col.tabbed) box.append(win(col.items[col.active], col.items));
      else for (const key of col.items) box.append(win(key));
      track.append(box);
    });
    const view = Object.assign(document.createElement("div"), { className: "view" });
    track.append(view);
    strip.append(track);
    row.append(strip);
    let floatsW = 0;
    if (ws.floating.length) {
      const floats = Object.assign(document.createElement("div"), { className: "floats" });
      for (const key of ws.floating) floats.append(win(key));
      row.append(floats);
      floatsW = ROW_GAP + ws.floating.length * (FLOAT + FLOAT_GAP) - FLOAT_GAP;
    }

    // The strip is as wide as its columns and the view (up to MAX_W); too long to
    // fit, it keeps the part on screen in the middle.
    const r = { id: ws.id, row, strip, track, view, viewX: NaN, width: 0, set: {} };
    r.place = (viewX) => {
      if (viewX === r.viewX) return;
      r.viewX = viewX;
      const viewLeft = mapX(viewX);
      const viewRight = mapX(viewX + W);
      const from = Math.min(0, viewLeft);
      const content = Math.max(end + 2 * pad, viewRight + 1) - from;
      const width = Math.round(Math.min(MAX_W, content));
      const shift = clamp((viewLeft + viewRight) / 2 - width / 2, from, from + content - width);
      put(r, strip, "width", `${width}px`);
      put(r, track, "transform", `translate3d(${px(-shift)}px, 0, 0)`);
      put(r, view, "transform", `translate3d(${px(viewLeft)}px, 0, 0)`);
      put(r, view, "width", `${Math.max(4, Math.round(viewRight - viewLeft))}px`);
      r.width = width + floatsW;
    };
    return r;
  }

  // Sets a style only when it changes: a frame of a swipe touches only what moved.
  const put = (owner, element, prop, value) => {
    const k = `${element.className}.${prop}`;
    if (owner.set[k] === value) return;
    owner.set[k] = value;
    element.style[prop] = value;
  };
  const state = { set: {} };

  // Where the pill is at workspace `pos` (fractional, maybe past the ends).
  function dotAt(pos) {
    const n = dotX.length;
    if (!n) return { x: 0, w: 16 };
    const step = n > 1 ? dotX[1] - dotX[0] : dotW[0] + 3;
    if (pos <= 0) return { x: dotX[0] + pos * step, w: dotW[0] };
    if (pos >= n - 1) return { x: dotX[n - 1] + (pos - n + 1) * step, w: dotW[n - 1] };
    const i = Math.floor(pos), f = pos - i;
    return { x: lerp(dotX[i], dotX[i + 1], f), w: lerp(dotW[i], dotW[i + 1], f) };
  }

  // Puts everything where the layout is now.
  function apply(position) {
    const pos = position.ws;
    const n = rows.length;
    position.views.forEach((viewX, i) => rows[i]?.place(viewX));
    put(state, reel, "transform", `translate3d(0, ${px(-pos * PITCH)}px, 0)`);
    const { x, w } = dotAt(pos);
    put(state, pill, "transform", `translate3d(${px(x)}px, 0, 0)`);
    put(state, pill, "width", `${Math.round(w)}px`);
    put(state, inkDots, "transform", `translate3d(${-px(x)}px, 0, 0)`);
    // Between two workspaces, as wide as the strips between them.
    const p = clamp(pos, 0, Math.max(0, n - 1));
    const i = Math.floor(p);
    const width = n ? lerp(rows[i].width, rows[Math.min(i + 1, n - 1)].width, p - i) : 0;
    put(state, reelView, "width", `${Math.round(width)}px`);
  }

  function markFocused() {
    const focused = niri.focused();
    if (focused === focusedNow) return;
    focusedNow = focused;
    for (const [cell, keys] of cells) cell.classList.toggle("focused", keys.includes(focused));
  }

  function update() {
    const workspaces = niri.workspaces();
    const screen = niri.screen();
    // A window's app (its icon) changes the cells too.
    const names = workspaces.flatMap((ws) => [...ws.columns.flatMap((c) => c.items), ...ws.floating])
      .map((key) => iconFor(key).id);
    const next = JSON.stringify([
      workspaces.map(({ id, empty, columns, floating }) => ({ id, empty, columns, floating })), screen, names,
    ]);
    const position = niri.position();
    if (next !== signature) {
      signature = next;
      rebuild(workspaces, screen, position);
    } else apply(position);
    markFocused();
  }

  // A rebuild in the middle of a transition starts the new parts where the old
  // ones were seen: the reel and pill from the same workspace (by id, as the
  // layout's workspaces move), each strip from its old scroll.
  function rebuild(workspaces, screen, position) {
    const animating = !document.body.classList.contains("noanim") && ids.length > 0;
    let seenPos = null;
    const seen = new Map();
    if (animating) {
      const m42 = new DOMMatrixReadOnly(getComputedStyle(reel).transform).m42;
      seenPos = -m42 / PITCH;
      for (const r of rows) {
        seen.set(r.id, {
          strip: getComputedStyle(r.strip).width, track: getComputedStyle(r.track).transform,
          view: getComputedStyle(r.view).transform, viewW: getComputedStyle(r.view).width,
        });
      }
    }
    const oldIds = ids;
    build(workspaces, screen);
    state.set = {};
    if (!animating) return apply(position);

    // The workspace seen then, in the new list: the nearest one that's in both.
    let start = position.ws;
    let best = Infinity;
    oldIds.forEach((id, oi) => {
      const ni = ids.indexOf(id);
      if (ni >= 0 && Math.abs(oi - seenPos) < best) { best = Math.abs(oi - seenPos); start = ni + (seenPos - oi); }
    });
    root.classList.add("jump");
    apply({ ...position, ws: start });
    for (const r of rows) {
      const was = seen.get(r.id);
      if (!was) continue;
      Object.assign(r.strip.style, { width: was.strip });
      Object.assign(r.track.style, { transform: was.track });
      Object.assign(r.view.style, { transform: was.view, width: was.viewW });
      r.set = {};
      r.viewX = NaN;
    }
    root.offsetWidth; // the start, drawn without transitions
    root.classList.remove("jump");
    apply(position);
  }

  // A frame of a swipe: only the positions changed.
  function move() {
    if (!signature) return update();
    apply(niri.position());
  }

  let wheelAt = 0;
  function onWheel(e) {
    e.preventDefault();
    const now = performance.now();
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (now - wheelAt < 150 || Math.abs(delta) < 1) return;
    wheelAt = now;
    niri.focusColumn(Math.sign(delta));
  }

  return { update, move };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, f) => a + (b - a) * f;
// Whole device pixels, as the layout's tiles: no blur mid-swipe.
const px = (v) => Math.round(v * devicePixelRatio) / devicePixelRatio;

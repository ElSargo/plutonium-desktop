// The bar's minimap (on the left): the workspaces as numbered dots, and the
// focused one's strip of columns at the screen's proportions, each window as
// its app's icon (a tab as its site's), with the part on screen outlined.
// Click a window to go to it, a dot to go to its workspace; the wheel over
// the strip moves between columns. A window dragged onto a dot (Super+drag,
// or a drag in the overview) moves to that workspace: the dots carry
// data-niri-ws, which index.html's drop targets look for.

const CSS = `
.niri-minimap { display: flex; align-items: center; gap: 6px; height: 100%; padding: 0 4px; min-width: 0; }
.niri-minimap .dots { display: flex; gap: 3px; flex: none; }
.niri-minimap .dot {
  min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; display: grid; place-items: center;
  font: 10px/1 system-ui, sans-serif; color: var(--muted); background: #ffffff10; cursor: pointer;
}
.niri-minimap .dot:hover { background: #ffffff22; }
.niri-minimap .dot.current { background: var(--focus); color: #101012; }
.niri-minimap .dot.empty:not(.current) { opacity: .45; }
.niri-minimap .dot.drop { outline: 2px solid var(--focus); }
.niri-minimap .strip { position: relative; height: 22px; border-radius: 5px; background: #ffffff08; overflow: hidden; flex: none; }
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
  position: absolute; top: 0; bottom: 0; border: 1.5px solid #ffffff99; border-radius: 5px; pointer-events: none;
  transition: left 200ms, width 200ms;
}
.niri-minimap .floats { display: flex; gap: 2px; flex: none; }
.niri-minimap .floats .win { width: 18px; height: 18px; flex: none; }
`;

const INNER = 18; // a column's height in the strip
const MAX_W = 240;
const MIN_COL = 20;

/**
 * Mounts the minimap in `container`. `niri` is the layout's side (index.html):
 * workspaces(), focused(), screen() ({ width, height, gap }), focus(key),
 * focusWorkspace(index), focusColumn(delta). Returns { update }, which the
 * layout calls after each render.
 */
export function mountMinimap(shell, container, niri) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  const root = document.createElement("div");
  root.className = "niri-minimap";
  container.append(root);

  // Icons by app id (or a tab's origin): an object URL, or null for none.
  const icons = new Map();
  const iconFor = (key) => {
    const [kind, raw] = key.split(":");
    if (kind === "w") {
      const window = shell.windows.get(Number(raw));
      const name = window?.appId || window?.title || "?";
      return { id: window?.appId ? `app:${window.appId}` : "", label: name, title: window?.title || name,
        load: () => shell.appIcon(window.appId).catch(() => null) };
    }
    const tab = shell.tabs?.get(Number(raw));
    let origin = "";
    try { origin = /^https?:$/.test(new URL(tab?.url).protocol) ? new URL(tab.url).origin : ""; } catch {}
    const host = origin ? new URL(origin).hostname.replace(/^www\./, "") : "";
    return { id: origin ? `site:${origin}` : "", label: host || tab?.title || "?", title: tab?.title || tab?.url || "tab",
      load: () => probe(`${origin}/favicon.ico`) };
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

  const win = (key, focused, count = 0) => {
    const cell = document.createElement("div");
    cell.className = focused ? "win focused" : "win";
    const { element, info } = iconElement(key);
    cell.title = info.title;
    cell.append(element);
    if (count > 1) cell.append(Object.assign(document.createElement("span"), { className: "count", textContent: String(count) }));
    cell.addEventListener("click", (e) => { e.stopPropagation(); niri.focus(key); });
    return cell;
  };

  let signature = "";
  // The strip's view outline, moved without a rebuild when only the view scrolls.
  let placeView = null;
  function update() {
    const workspaces = niri.workspaces();
    const focused = niri.focused();
    const screen = niri.screen();
    // A window's app (its icon) changes the cells too.
    const names = workspaces.flatMap((ws) => ws.current ? [...ws.columns.flatMap((c) => c.items), ...ws.floating] : [])
      .map((key) => iconFor(key).id);
    const current = workspaces.find((w) => w.current);
    const next = JSON.stringify([workspaces.map((w) => ({ ...w, viewX: 0 })), focused, screen, names]);
    if (next === signature) { placeView?.(current?.viewX ?? 0); return; }
    signature = next;
    placeView = null;

    const dots = document.createElement("div");
    dots.className = "dots";
    for (const ws of workspaces) {
      const dot = document.createElement("span");
      dot.className = `dot${ws.current ? " current" : ""}${ws.empty ? " empty" : ""}`;
      dot.textContent = String(ws.index + 1);
      dot.dataset.niriWs = ws.id;
      dot.title = `Workspace ${ws.index + 1}`;
      dot.addEventListener("click", () => niri.focusWorkspace(ws.index));
      dots.append(dot);
    }

    const ws = workspaces.find((w) => w.current);
    const parts = [dots];
    if (ws && ws.columns.length) {
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
      const strip = document.createElement("div");
      strip.className = "strip";
      const boxes = ws.columns.map((col, ci) => {
        const box = document.createElement("div");
        box.className = "col";
        box.style.width = `${Math.max(4, segs[ci] - 2)}px`;
        if (col.tabbed) box.append(win(col.items[col.active], col.items.includes(focused), col.items.length));
        else for (const key of col.items) box.append(win(key, key === focused));
        strip.append(box);
        return box;
      });
      const view = document.createElement("div");
      view.className = "view";
      strip.append(view);
      // The strip is as wide as its columns and the view (up to MAX_W); too long to
      // fit, it keeps the part on screen in the middle.
      placeView = (viewX) => {
        const viewLeft = mapX(viewX);
        const viewRight = mapX(viewX + W);
        const from = Math.min(0, viewLeft);
        const content = Math.max(end + 2 * pad, viewRight + 1) - from;
        const width = Math.min(MAX_W, content);
        const shift = clamp((viewLeft + viewRight) / 2 - width / 2, from, from + content - width);
        strip.style.width = `${Math.round(width)}px`;
        boxes.forEach((box, ci) => { box.style.left = `${starts[ci] + pad - shift}px`; });
        view.style.left = `${viewLeft - shift}px`;
        view.style.width = `${Math.max(4, viewRight - viewLeft)}px`;
      };
      placeView(ws.viewX);
      strip.addEventListener("wheel", onWheel, { passive: false });
      parts.push(strip);
    }
    if (ws?.floating.length) {
      const floats = document.createElement("div");
      floats.className = "floats";
      for (const key of ws.floating) floats.append(win(key, key === focused));
      parts.push(floats);
    }
    root.replaceChildren(...parts);
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

  return { update };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

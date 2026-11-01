// Dragging and resizing: what every shell's pointer handling has in common
// (UI_LIBRARY.md). The geometry is plain functions; trackDrag() follows one
// drag with the pointer, whether it began with a press on the page or with
// an app's own move or resize request (the page gets the rest of the drag
// without a pointerdown).

/** Edges: "top", "bottom", "left", "right", "top-left", … "bottom-right". */
export const EDGES = ["top", "bottom", "left", "right", "top-left", "top-right", "bottom-left", "bottom-right"];

/** An edge's compass code ("n", "se", …), as GNOME's and CSS's resize cursors name them. */
export function edgeCode(edge) {
  return { top: "n", bottom: "s", left: "w", right: "e", "top-left": "nw", "top-right": "ne", "bottom-left": "sw", "bottom-right": "se" }[edge] ?? "se";
}

/**
 * The edge or corner of `rect` nearest (x, y), as niri resizes from: the
 * outer thirds are edges, their crossings corners; the middle goes to the
 * nearer side.
 * @param {{ left: number, top: number, width: number, height: number }} rect
 */
export function nearestEdge(rect, x, y) {
  const fx = (x - rect.left) / rect.width;
  const fy = (y - rect.top) / rect.height;
  const edge = [fy < 1 / 3 ? "top" : fy > 2 / 3 ? "bottom" : "", fx < 1 / 3 ? "left" : fx > 2 / 3 ? "right" : ""]
    .filter(Boolean)
    .join("-");
  return edge || (fx < 0.5 ? "left" : "right");
}

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

/**
 * `start` resized from `edge` by (dx, dy): the opposite edge stays put.
 * Sizes stay within min and max ({ w, h }).
 * @param {{ x: number, y: number, w: number, h: number }} start
 */
export function resizeRect(start, edge, dx, dy, { min = { w: 60, h: 60 }, max = { w: Infinity, h: Infinity } } = {}) {
  const rect = { ...start };
  // An edge's name ("top-left"), or its compass code ("nw").
  const code = EDGES.includes(edge) ? edgeCode(edge) : edge;
  if (code.includes("e")) rect.w = clamp(start.w + dx, min.w, max.w);
  if (code.includes("s")) rect.h = clamp(start.h + dy, min.h, max.h);
  if (code.includes("w")) {
    rect.w = clamp(start.w - dx, min.w, max.w);
    rect.x = start.x + start.w - rect.w;
  }
  if (code.includes("n")) {
    rect.h = clamp(start.h - dy, min.h, max.h);
    rect.y = start.y + start.h - rect.h;
  }
  return rect;
}

/**
 * How fast to scroll near an edge, from -1 (at the start edge) to 1 (at the
 * end), 0 farther than `trigger` from both (niri's dnd-edge-view-scroll).
 */
export function edgeVelocity(position, size, trigger) {
  if (position < trigger) return -(1 - Math.max(0, position) / trigger);
  if (position > size - trigger) return 1 - Math.max(0, size - position) / trigger;
  return 0;
}

/**
 * Where among `rects` (the items of a row or column, in order) a drop at
 * `position` goes: the index of the item it goes before (rects.length: last).
 * @param {{ left: number, top: number, width: number, height: number }[]} rects
 * @param {"x" | "y"} axis
 */
export function insertIndex(rects, position, axis = "x") {
  for (let index = 0; index < rects.length; index++) {
    const rect = rects[index];
    const middle = axis === "x" ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
    if (position < middle) return index;
  }
  return rects.length;
}

/** A double-click detector: `hit()` is true on a second hit within `ms` (and resets). */
export function doubleClick(ms = 400) {
  let last = 0;
  return {
    hit(now = performance.now()) {
      if (now - last <= ms) {
        last = 0;
        return true;
      }
      last = now;
      return false;
    },
  };
}

/**
 * Follows one drag with the pointer, on the whole page.
 *
 * `event`: the pointerdown it began with, or null when an app asked for it
 * (its start is the first move then). Moves under `threshold` pixels are a
 * click: onMove isn't called, onEnd gets moved false. A move with no button
 * held ends it (a release the page missed), and Escape cancels it.
 *
 * @param {PointerEvent | null} event
 * @param {{
 *   threshold?: number,
 *   button?: number,
 *   onStart?: (info: { x: number, y: number }) => void,
 *   onMove?: (info: { x: number, y: number, dx: number, dy: number, event: PointerEvent }) => void,
 *   onEnd?: (info: { x: number, y: number, dx: number, dy: number, moved: boolean, event: PointerEvent | null }) => void,
 *   onCancel?: () => void,
 * }} handlers
 * @returns {{ cancel(): void, readonly moved: boolean }}
 */
export function trackDrag(event, { threshold = 4, button = event?.button ?? 0, onStart, onMove, onEnd, onCancel } = {}) {
  let sx = event ? event.clientX : null;
  let sy = event ? event.clientY : null;
  let last = { x: sx ?? 0, y: sy ?? 0 };
  let moved = false;
  let done = false;
  const mask = [1, 4, 2][button] ?? 1;
  const finish = () => {
    done = true;
    removeEventListener("pointermove", move, true);
    removeEventListener("pointerup", up, true);
    removeEventListener("pointercancel", up, true);
    removeEventListener("keydown", key, true);
  };
  const move = (e) => {
    if (!(e.buttons & mask)) {
      up(e);
      return;
    }
    if (sx === null) {
      sx = e.clientX;
      sy = e.clientY;
      onStart?.({ x: sx, y: sy });
    }
    last = { x: e.clientX, y: e.clientY };
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    if (!moved && Math.hypot(dx, dy) < threshold) return;
    moved = true;
    onMove?.({ x: e.clientX, y: e.clientY, dx, dy, event: e });
  };
  const up = (e) => {
    if (done) return;
    finish();
    const x = e?.clientX ?? last.x;
    const y = e?.clientY ?? last.y;
    onEnd?.({ x, y, dx: x - (sx ?? x), dy: y - (sy ?? y), moved, event: e ?? null });
  };
  const key = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };
  const cancel = () => {
    if (done) return;
    finish();
    onCancel?.();
  };
  addEventListener("pointermove", move, true);
  addEventListener("pointerup", up, true);
  addEventListener("pointercancel", up, true);
  addEventListener("keydown", key, true);
  if (event) onStart?.({ x: sx, y: sy });
  return {
    cancel,
    get moved() {
      return moved;
    },
  };
}

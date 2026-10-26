// The status indicators' common parts (audio.js, brightness.js, battery.js,
// power.js, media.js, osd.js): icons, a popover, a confirm and their CSS.
// Each indicator is its own module, `export default (shell, container)`,
// over a desktop service (shell.system.<name>, DESKTOP_SERVICES.md); the
// shell themes them with the --tray-* variables.

const CSS = `
.tray-button {
  display: inline-flex; align-items: center; gap: 5px; height: 100%; padding: 0 7px; border: 0; border-radius: 6px;
  background: none; color: var(--tray-fg, inherit); font: inherit; cursor: default; white-space: nowrap;
}
.tray-button:hover, .tray-button.open { background: var(--tray-hover, #ffffff1a); }
.tray-button svg { width: 16px; height: 16px; flex: none; }
.tray-button[hidden] { display: none; }
.tray-popover {
  position: fixed; z-index: 1000; min-width: 240px; max-width: 360px; padding: 10px; display: grid; gap: 8px;
  background: var(--tray-bg, #1e1e1eee); color: var(--tray-fg, #e6e6e6); border: var(--tray-border, 1px solid #ffffff1a);
  border-radius: var(--tray-radius, 10px); box-shadow: 0 10px 40px #0008; backdrop-filter: blur(12px); font: 13px/1.4 system-ui, sans-serif;
}
.tray-popover h3 { margin: 4px 0 0; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--tray-muted, #9a9a9a); }
.tray-popover .row { display: flex; align-items: center; gap: 8px; }
.tray-popover .row > :first-child { flex: none; }
.tray-popover input[type=range] { flex: 1; min-width: 0; accent-color: var(--tray-accent, #7fc8ff); }
.tray-popover button {
  display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; border: 0; border-radius: 6px;
  background: none; color: inherit; font: inherit; text-align: left;
}
.tray-popover button:hover:not(:disabled) { background: var(--tray-hover, #ffffff1a); }
.tray-popover button:disabled { opacity: .5; }
.tray-popover button.icon { width: auto; padding: 4px; }
.tray-popover button svg { width: 16px; height: 16px; flex: none; }
.tray-popover button.current { font-weight: 600; }
.tray-popover button.current::after { content: "✓"; margin-left: auto; }
.tray-popover .value { width: 3.2em; text-align: right; font-variant-numeric: tabular-nums; color: var(--tray-muted, #9a9a9a); }
.tray-popover .error { color: var(--tray-danger, #ff8a80); font-size: 12px; }
.tray-popover .muted { color: var(--tray-muted, #9a9a9a); }
.tray-confirm {
  position: fixed; inset: 0; z-index: 1001; display: grid; place-items: center; background: #0006;
}
.tray-confirm > div {
  min-width: 300px; padding: 16px; display: grid; gap: 14px;
  background: var(--tray-bg, #1e1e1eee); color: var(--tray-fg, #e6e6e6); border: var(--tray-border, 1px solid #ffffff1a);
  border-radius: var(--tray-radius, 10px); box-shadow: 0 10px 40px #0008; font: 13px/1.4 system-ui, sans-serif;
}
.tray-confirm p { margin: 0; font-size: 14px; }
.tray-confirm .buttons { display: flex; gap: 8px; justify-content: end; }
.tray-confirm button {
  padding: 6px 14px; border: var(--tray-border, 1px solid #ffffff1a); border-radius: 6px; background: none; color: inherit; font: inherit;
}
.tray-confirm button.danger { background: var(--tray-danger-bg, #c62828); border-color: transparent; color: #fff; }
`;

let styled = false;
/** Adds the indicators' CSS to the page, once. */
export function style() {
  if (styled) return;
  styled = true;
  const element = document.createElement("style");
  element.textContent = CSS;
  document.head.append(element);
}

const PATHS = {
  volume: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/>',
  "volume-low": '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 8.5a5 5 0 0 1 0 7"/>',
  "volume-muted": '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 9.5l5 5m0-5l-5 5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  "mic-muted": '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M4 4l16 16"/>',
  brightness: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/>',
  power: '<path d="M12 3v8"/><path d="M6.3 6.5a8 8 0 1 0 11.4 0"/>',
  suspend: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  reboot: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v5h-5"/>',
  "log-out": '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M10 8l-4 4 4 4M6 12h9"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>',
  pause: '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/>',
  next: '<path d="M5 5l10 7-10 7z" fill="currentColor"/><path d="M18 5v14"/>',
  previous: '<path d="M19 5L9 12l10 7z" fill="currentColor"/><path d="M6 5v14"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
};

/** An icon as SVG markup ("volume", "brightness", "play", …). */
export function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] ?? ""}</svg>`;
}

/** A battery icon filled to `fraction`, with a bolt when charging. */
export function batteryIcon(fraction, charging) {
  const width = Math.max(0, Math.min(1, fraction)) * 14;
  const low = fraction <= 0.15 && !charging;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
    <rect x="2.5" y="7" width="17" height="10" rx="2"/><path d="M21.5 10.5v3"/>
    <rect x="4" y="8.5" width="${width.toFixed(1)}" height="7" rx="1" fill="${low ? "var(--tray-danger, #ff8a80)" : "currentColor"}" stroke="none"/>
    ${charging ? '<path d="M12 6.5l-3 6h3.5l-1.5 5 4.5-7h-3.5l1.5-4z" fill="var(--tray-bg-solid, #1e1e1e)" stroke="currentColor" stroke-width="1"/>' : ""}
  </svg>`;
}

/** A bar button. */
export function button(title) {
  const element = document.createElement("button");
  element.className = "tray-button";
  element.title = title;
  element.hidden = true;
  // Clicks don't take the keyboard from the app that has it.
  element.addEventListener("mousedown", (event) => event.preventDefault());
  return element;
}

let open = null;

/**
 * Opens a popover by `anchor` (above it if it's low on the screen), filled by
 * `build(element)`. Returns { element, close }; clicking outside or Escape
 * closes it, as does opening another. Toggles: the same anchor again closes it.
 */
export function popover(anchor, build) {
  if (open?.anchor === anchor) {
    open.close();
    return null;
  }
  open?.close();
  const element = document.createElement("div");
  element.className = "tray-popover";
  element.addEventListener("mousedown", (event) => {
    if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
  });
  document.body.append(element);
  build(element);
  const place = () => {
    const box = anchor.getBoundingClientRect();
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const left = Math.max(6, Math.min(box.right - width, innerWidth - width - 6, box.left));
    const below = box.bottom + height + 6 < innerHeight;
    element.style.left = `${Math.max(6, left)}px`;
    element.style.top = `${below ? box.bottom + 4 : Math.max(6, box.top - height - 4)}px`;
  };
  place();
  const outside = (event) => {
    if (!element.contains(event.target) && !anchor.contains(event.target)) close();
  };
  const escape = (event) => {
    if (event.key === "Escape") close();
  };
  addEventListener("pointerdown", outside, true);
  addEventListener("keydown", escape, true);
  anchor.classList.add("open");
  const close = () => {
    if (open?.element !== element) return;
    open = null;
    element.remove();
    anchor.classList.remove("open");
    removeEventListener("pointerdown", outside, true);
    removeEventListener("keydown", escape, true);
  };
  open = { anchor, element, close, place };
  return open;
}

/** Closes the open popover, if any. */
export function closePopover() {
  open?.close();
}

/** Re-fills the open popover if it's `anchor`'s. */
export function refill(anchor, build) {
  if (open?.anchor !== anchor) return;
  // Not while a slider in it is held: the next change will do.
  if (open.element.querySelector("input[type=range]:active")) return;
  open.element.replaceChildren();
  build(open.element);
  open.place();
}

/** A range input 0–`max` that calls `set(value)` as it moves, at most one call at a time. */
export function slider(value, max, set) {
  const input = document.createElement("input");
  input.type = "range";
  input.min = "0";
  input.max = String(max);
  input.step = "0.01";
  input.value = String(value);
  let busy = false;
  let next = null;
  const send = async (target) => {
    if (busy) {
      next = target;
      return;
    }
    busy = true;
    try {
      await set(target);
    } catch (error) {
      console.warn(error);
    }
    busy = false;
    if (next !== null) {
      const again = next;
      next = null;
      void send(again);
    }
  };
  input.addEventListener("input", () => void send(Number(input.value)));
  return input;
}

/** A popover button with an icon and a label. */
export function item(iconName, label, onClick) {
  const element = document.createElement("button");
  element.innerHTML = `${iconName ? icon(iconName) : ""}<span></span>`;
  element.querySelector("span").textContent = label;
  element.addEventListener("click", onClick);
  return element;
}

/** Asks before `action` ("Power off"); resolves true if the user agreed. */
export function confirm(question, action) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "tray-confirm";
    backdrop.innerHTML = `<div role="alertdialog"><p></p><div class="buttons"><button class="cancel">Cancel</button><button class="danger"></button></div></div>`;
    backdrop.querySelector("p").textContent = question;
    const yes = backdrop.querySelector(".danger");
    yes.textContent = action;
    const done = (answer) => {
      backdrop.remove();
      removeEventListener("keydown", key, true);
      resolve(answer);
    };
    const key = (event) => {
      if (event.key === "Escape") done(false);
      if (event.key === "Enter") done(true);
      event.stopPropagation();
    };
    addEventListener("keydown", key, true);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) done(false);
    });
    backdrop.querySelector(".cancel").addEventListener("click", () => done(false));
    yes.addEventListener("click", () => done(true));
    document.body.append(backdrop);
    yes.focus();
  });
}

/** "2 h 05 min" for a number of seconds. */
export function duration(seconds) {
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min` : `${minutes} min`;
}

/** Calls `render(state)` with a service's state now and on each change; null when it can't be used. */
export function watch(service, render) {
  service.addEventListener("change", (event) => render(event.detail));
  service.ready.then(render, () => render(null));
}

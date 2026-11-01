// Widgets every shell's chrome shares (UI_LIBRARY.md): icons, popovers,
// menus, sliders, a confirm, toasts, the settings form's and the key
// editor's look. The status indicators (indicators/*.js) are built of them:
// each is its own module, `export default (shell, container)`, over a desktop
// service (shell.system.<name>, DESKTOP_SERVICES.md). A shell themes all of
// it with the --tray-* variables.

import { prettyCombo, recordCombo } from "./keys.js";

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
.pl-menu {
  position: fixed; z-index: 1002; min-width: 180px; max-width: 360px; padding: 5px; display: grid;
  background: var(--tray-bg, #1e1e1eee); color: var(--tray-fg, #e6e6e6); border: var(--tray-border, 1px solid #ffffff1a);
  border-radius: var(--tray-radius, 10px); box-shadow: 0 10px 40px #0008; backdrop-filter: blur(12px); font: 13px/1.4 system-ui, sans-serif;
}
.pl-menu button {
  display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 10px; border: 0; border-radius: 6px;
  background: none; color: inherit; font: inherit; text-align: left; outline: none;
}
.pl-menu button:hover:not(:disabled), .pl-menu button:focus-visible { background: var(--tray-hover, #ffffff1a); }
.pl-menu button:disabled { opacity: .5; }
.pl-menu button.danger { color: var(--tray-danger, #ff8a80); }
.pl-menu .pl-menu-icon { width: 16px; height: 16px; flex: none; display: grid; place-items: center; }
.pl-menu .pl-menu-icon > * { width: 16px; height: 16px; object-fit: contain; }
.pl-menu .pl-menu-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-menu .pl-menu-accel { color: var(--tray-muted, #9a9a9a); font-size: 12px; }
.pl-menu .pl-menu-sep { height: 1px; margin: 4px 6px; background: var(--tray-hover, #ffffff1a); }
.pl-menu .pl-menu-heading { padding: 6px 10px 2px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--tray-muted, #9a9a9a); }
.pl-toast {
  position: fixed; z-index: 1003; left: 50%; bottom: 24px; transform: translate(-50%, 20px); opacity: 0; pointer-events: none;
  display: flex; align-items: center; gap: 12px; padding: 8px 14px; max-width: min(560px, 90vw);
  background: var(--tray-bg, #1e1e1eee); color: var(--tray-fg, #e6e6e6); border: var(--tray-border, 1px solid #ffffff1a);
  border-radius: var(--tray-radius, 10px); box-shadow: 0 10px 40px #0008; font: 13px/1.4 system-ui, sans-serif;
  transition: opacity .15s, transform .15s;
}
.pl-toast.shown { opacity: 1; transform: translate(-50%, 0); pointer-events: auto; }
.pl-toast small { display: block; color: var(--tray-muted, #9a9a9a); }
.pl-toast button { padding: 4px 10px; border: var(--tray-border, 1px solid #ffffff1a); border-radius: 6px; background: none; color: inherit; font: inherit; }
.pl-form { display: grid; gap: 2px; }
.pl-row { display: flex; align-items: center; gap: 10px; min-height: 32px; padding: 4px 6px; border-radius: 6px; }
.pl-row:hover { background: var(--tray-hover, #ffffff10); }
.pl-row .pl-label { flex: 1; min-width: 0; display: grid; }
.pl-row .pl-label small, .pl-hint { color: var(--tray-muted, #9a9a9a); font-size: 12px; }
.pl-row input[type=checkbox] { accent-color: var(--tray-accent, #7fc8ff); width: 16px; height: 16px; }
.pl-row input[type=range] { width: 120px; accent-color: var(--tray-accent, #7fc8ff); }
.pl-row .pl-value { width: 3.5em; text-align: right; font-variant-numeric: tabular-nums; color: var(--tray-muted, #9a9a9a); }
.pl-row select, .pl-input, .pl-row input[type=text] {
  min-width: 0; max-width: 220px; height: 28px; padding: 0 8px; border: var(--tray-border, 1px solid #ffffff1a); border-radius: 6px;
  background: var(--tray-field, #ffffff10); color: inherit; font: inherit;
}
.pl-row select option { background: var(--tray-bg-solid, #1e1e1e); }
.pl-segmented { display: flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--tray-field, #ffffff10); }
.pl-segmented button { flex: 1; justify-content: center; padding: 4px 8px; }
.pl-segmented button.on { background: var(--tray-hover, #ffffff22); font-weight: 600; }
.pl-keys { display: flex; gap: 4px; flex-wrap: wrap; justify-content: end; }
.pl-kbd {
  padding: 2px 7px; border-radius: 5px; background: var(--tray-field, #ffffff14); box-shadow: inset 0 -2px 0 #00000050;
  font-size: 12px; font-weight: 600; white-space: nowrap;
}
.pl-kbd.none { background: none; box-shadow: none; color: var(--tray-muted, #9a9a9a); font-weight: 400; }
.pl-kbd.rec { background: var(--tray-accent, #7fc8ff); color: var(--tray-bg-solid, #1e1e1e); }
.pl-kbd.changed { box-shadow: inset 0 -2px 0 var(--tray-accent, #7fc8ff); }
.pl-key-group { margin: 8px 6px 2px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--tray-muted, #9a9a9a); }
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
  display: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
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
 * `build(element)`. Returns { element, close, place }; clicking outside or
 * Escape closes it, as does opening another. Toggles: the same anchor again
 * closes it. `onClose` is called when it closes, however it does.
 */
export function popover(anchor, build, { className = "", onClose = null } = {}) {
  if (open?.anchor === anchor) {
    open.close();
    return null;
  }
  open?.close();
  style();
  const element = document.createElement("div");
  element.className = `tray-popover ${className}`.trim();
  element.addEventListener("mousedown", (event) => {
    // Fields take the keyboard; nothing else does (the app keeps it).
    if (!event.target.closest?.("input, select, textarea")) event.preventDefault();
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
    onClose?.();
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

/** An element with a class and text. */
export function el(tag, className = "", text = undefined) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

// ---------------------------------------------------------------- menus
let openMenu = null;

/**
 * A popup menu at (x, y), or by `anchor` (below it, or above when it's low
 * on the screen; `side: "top"` prefers above). Items: { label, icon?, accel?,
 * checked?, disabled?, danger?, action } (icon: an element, an image URL or
 * SVG markup), "-" for a separator, { heading }. The arrow keys move, Enter
 * picks, Escape or a click outside closes it. Returns { root, close }.
 */
export function menu(items, { x = 0, y = 0, anchor = null, side = "bottom", align = "start", className = "", onClose } = {}) {
  closeMenu();
  style();
  const root = el("div", `pl-menu ${className}`.trim());
  root.setAttribute("role", "menu");
  const buttons = [];
  for (const item of items) {
    if (!item) continue;
    if (item === "-") { root.append(el("div", "pl-menu-sep")); continue; }
    if (item.heading) { root.append(el("div", "pl-menu-heading", item.heading)); continue; }
    const button = el("button");
    button.setAttribute("role", item.checked === undefined ? "menuitem" : "menuitemcheckbox");
    if (item.checked !== undefined) button.setAttribute("aria-checked", String(!!item.checked));
    const iconBox = el("span", "pl-menu-icon");
    if (item.icon instanceof Element) iconBox.append(item.icon);
    else if (typeof item.icon === "string" && /^(blob:|data:|https?:)/.test(item.icon)) iconBox.append(Object.assign(el("img"), { src: item.icon, alt: "" }));
    else if (typeof item.icon === "string") iconBox.innerHTML = item.icon;
    else if (item.checked) iconBox.textContent = "✓";
    button.append(iconBox, el("span", "pl-menu-label", item.label));
    if (item.accel) button.append(el("span", "pl-menu-accel", item.accel));
    button.disabled = !!item.disabled;
    if (item.danger) button.classList.add("danger");
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => { closeMenu(); item.action?.(); });
    root.append(button);
    buttons.push(button);
  }
  document.body.append(root);
  const width = root.offsetWidth, height = root.offsetHeight;
  if (anchor) {
    const box = anchor.getBoundingClientRect();
    x = align === "center" ? box.left + box.width / 2 - width / 2 : align === "end" ? box.right - width : box.left;
    const above = box.top - height - 6;
    const below = box.bottom + 6;
    y = side === "top" ? (above >= 6 ? above : below) : below + height <= innerHeight - 6 ? below : above;
  }
  root.style.left = `${Math.max(6, Math.min(x, innerWidth - width - 6))}px`;
  root.style.top = `${Math.max(6, Math.min(y, innerHeight - height - 6))}px`;
  let index = -1;
  const outside = (event) => { if (!root.contains(event.target)) closeMenu(); };
  const keys = (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); event.stopPropagation();
      const usable = buttons.filter((button) => !button.disabled);
      if (!usable.length) return;
      index = (index + (event.key === "ArrowDown" ? 1 : -1) + usable.length) % usable.length;
      usable[index].focus();
    }
  };
  setTimeout(() => addEventListener("pointerdown", outside, true));
  addEventListener("keydown", keys, true);
  openMenu = {
    root,
    close() {
      root.remove();
      removeEventListener("pointerdown", outside, true);
      removeEventListener("keydown", keys, true);
      openMenu = null;
      onClose?.();
    },
  };
  return openMenu;
}

export function closeMenu() {
  openMenu?.close();
}

export const menuOpen = () => openMenu !== null;

// ---------------------------------------------------------------- toasts
let toastElement = null;
let toastTimer = 0;

/**
 * A short message at the bottom of the screen, with a button if `action` is
 * given ({ label, run }). A new one replaces it.
 */
export function toast(text, { detail = "", action = null, ms = 3500 } = {}) {
  style();
  if (!toastElement) {
    toastElement = el("div", "pl-toast");
    toastElement.setAttribute("role", "status");
    document.body.append(toastElement);
  }
  const body = el("div", "", text);
  if (detail) body.append(el("small", "", detail));
  toastElement.replaceChildren(body);
  if (action) {
    const button = el("button", "", action.label);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => { toastElement.classList.remove("shown"); action.run(); });
    toastElement.append(button);
  }
  toastElement.classList.add("shown");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastElement.classList.remove("shown"), ms);
}

// ---------------------------------------------------------------- controls
/** Buttons of which one is on: `choices` [[value, label]]; calls onChange(value). */
export function segmented(value, choices, onChange, { disabled = () => false } = {}) {
  style();
  const box = el("div", "pl-segmented");
  for (const [choice, label] of choices) {
    const button = el("button", Object.is(choice, value) ? "on" : "", label);
    button.disabled = disabled(choice);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      for (const other of box.children) other.classList.toggle("on", other === button);
      onChange(choice);
    });
    box.append(button);
  }
  return box;
}

// ---------------------------------------------------------------- the key editor
/**
 * Every action of `keymap` that can be rebound, by group: a click records new
 * keys (Escape cancels, Backspace leaves it none), a changed one can be reset.
 * The page must have the keyboard while recording (`takeKeyboard()`).
 * `onClash(action, combo)`: an action lost `combo` to the one recorded.
 * @param {import("./keys.js").Keymap} keymap
 */
export function keyEditor(keymap, { filter = "", takeKeyboard = () => {}, onClash = () => {} } = {}) {
  style();
  const root = el("div", "pl-form pl-key-editor");
  let recording = null;
  let stopRecording = () => {};
  const keycaps = (combos, className = "") => {
    const box = el("span", "pl-keys");
    if (!combos.length) box.append(el("span", "pl-kbd none", "None"));
    for (const combo of combos) box.append(el("span", `pl-kbd ${className}`.trim(), prettyCombo(combo)));
    return box;
  };
  const draw = () => {
    root.replaceChildren();
    const query = filter.toLowerCase();
    const groups = new Map();
    for (const action of keymap.list()) {
      if (!action.editable) continue;
      const keys = keymap.keysOf(action.id);
      if (query && !action.label.toLowerCase().includes(query) && !keys.join(" ").toLowerCase().includes(query)) continue;
      if (!groups.has(action.group)) groups.set(action.group, []);
      groups.get(action.group).push(action);
    }
    for (const [name, actions] of groups) {
      if (name) root.append(el("div", "pl-key-group", name));
      for (const action of actions) {
        const row = el("div", "pl-row");
        row.tabIndex = 0;
        const label = el("span", "pl-label", action.label);
        const changed = keymap.changed(action.id);
        if (changed) label.append(el("small", "", `Default: ${action.defaults.map(prettyCombo).join(", ") || "none"}`));
        row.append(label);
        if (recording === action.id) {
          const box = el("span", "pl-keys");
          box.append(el("span", "pl-kbd rec", "Press keys…"));
          row.append(box);
        } else row.append(keycaps(keymap.keysOf(action.id), changed ? "changed" : ""));
        if (changed && recording !== action.id) {
          const reset = el("button", "", "↺");
          reset.title = "Back to the default";
          reset.addEventListener("click", (event) => { event.stopPropagation(); keymap.setKeys(action.id, null); });
          row.append(reset);
        }
        row.addEventListener("click", () => record(action));
        root.append(row);
      }
    }
    if (!root.childElementCount) root.append(el("div", "pl-hint", "No shortcut matches."));
  };
  const record = (action) => {
    stopRecording();
    recording = action.id;
    draw();
    takeKeyboard();
    stopRecording = recordCombo((combo) => {
      recording = null;
      stopRecording = () => {};
      if (combo === "") keymap.setKeys(action.id, []);
      else if (combo) {
        const clash = keymap.assign(action.id, combo);
        if (clash) onClash(clash, combo);
      }
      draw();
    });
  };
  keymap.addEventListener("change", () => { if (root.isConnected && !recording) draw(); });
  draw();
  root.setFilter = (text) => { filter = text; draw(); };
  root.stop = () => { stopRecording(); recording = null; };
  return root;
}

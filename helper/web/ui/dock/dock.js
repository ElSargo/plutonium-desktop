// The dock's view (UI_LIBRARY.md, "The dock"): a row (or column) of slot
// buttons over a Dock (core.js), as Dash to Dock draws GNOME's dash. Each
// shows its icon, its number (Super+N) while Super is held, a dot per window
// it has; faint when empty, dim when nothing of it runs, lit when it shows,
// ringed when it has the keyboard. Running apps nothing pins follow a
// separator.
//
// Click: the slot's key (Dash to Dock's focus, minimize or list). Middle and
// Shift+click: as the settings say (a new window). The wheel cycles an
// app's windows. Right click: its windows, a new window, where it's kept,
// its layout, edit, remove. Drag to reorder; off the dock to remove it (with
// Undo); a running app onto the dock to pin it. An empty slot's click opens
// the editor.

import { insertIndex, trackDrag } from "../drag.js";
import { el, menu, popover, closePopover, segmented, style as widgetStyle, toast } from "../widgets.js";
import { normalizeSiteUrl, hostOf, slotLabel, DOCK_KEY_COUNT } from "./core.js";

const CSS = `
.pl-dock { display: flex; align-items: center; gap: var(--pl-dock-gap, 2px); --pl-dock-icon: 24px; user-select: none; }
.pl-dock.vertical { flex-direction: column; }
.pl-dock-item {
  position: relative; flex: none; display: grid; place-items: center; padding: var(--pl-dock-pad, 3px);
  width: calc(var(--pl-dock-icon) + 2 * var(--pl-dock-pad, 3px)); height: calc(var(--pl-dock-icon) + 2 * var(--pl-dock-pad, 3px));
  border: 0; border-radius: var(--pl-dock-radius, 6px); background: none; color: var(--tray-fg, inherit); font: inherit; cursor: default;
  transition: background .12s, opacity .12s, transform .12s;
}
.pl-dock-item:hover { background: var(--tray-hover, #ffffff1a); }
.pl-dock-item.empty { opacity: .35; }
.pl-dock-item.idle .pl-dock-icon { opacity: .6; }
.pl-dock-item.shown { background: var(--pl-dock-shown, #ffffff12); }
.pl-dock-item.focused { background: var(--pl-dock-focused, #ffffff22); box-shadow: inset 0 0 0 1px var(--pl-dock-ring, #ffffff40); }
.pl-dock-item.dragging { opacity: .35; }
.pl-dock-item.drop-before::before {
  content: ""; position: absolute; left: -2px; top: 15%; bottom: 15%; width: 2px; border-radius: 2px; background: var(--tray-accent, #7fc8ff);
}
.pl-dock.vertical .pl-dock-item.drop-before::before { left: 15%; right: 15%; top: -2px; bottom: auto; width: auto; height: 2px; }
.pl-dock-icon { width: var(--pl-dock-icon); height: var(--pl-dock-icon); display: grid; place-items: center; overflow: hidden; pointer-events: none; }
.pl-dock-icon img { width: 100%; height: 100%; object-fit: contain; }
.pl-dock-icon svg { width: 80%; height: 80%; }
.pl-dock-letter {
  width: 100%; height: 100%; display: grid; place-items: center; border-radius: 22%;
  background: var(--pl-dock-letter-bg, #ffffff26); font-weight: 700; font-size: calc(var(--pl-dock-icon) * .5);
}
.pl-dock-empty-dot { width: 4px; height: 4px; border-radius: 50%; background: currentColor; }
.pl-dock-num {
  position: absolute; top: 0; right: 1px; min-width: 10px; padding: 0 2px; border-radius: 4px;
  font-size: 9px; line-height: 11px; font-weight: 700; font-variant-numeric: tabular-nums; text-align: center;
  background: var(--tray-bg-solid, #1e1e1e); color: var(--tray-fg, #e6e6e6); opacity: 0; transition: opacity .12s; pointer-events: none;
}
.pl-dock.numbers .pl-dock-num, body.pl-super .pl-dock.numbers-super .pl-dock-num { opacity: .9; }
.pl-dock-dots { position: absolute; left: 0; right: 0; bottom: 0; display: flex; justify-content: center; gap: 2px; pointer-events: none; }
.pl-dock.vertical .pl-dock-dots { left: 0; top: 0; bottom: 0; right: auto; flex-direction: column; }
.pl-dock-dots i { width: 3px; height: 3px; border-radius: 50%; background: currentColor; opacity: .75; }
.pl-dock-item.focused .pl-dock-dots i, .pl-dock-item.shown .pl-dock-dots i { background: var(--tray-accent, #7fc8ff); opacity: 1; }
.pl-dock-end { width: 0; padding: 0; overflow: visible; }
.pl-dock-add .pl-dock-icon { opacity: .8; }
.pl-dock-sep { flex: none; width: 1px; height: calc(var(--pl-dock-icon) * .8); margin: 0 3px; background: var(--tray-hover, #ffffff26); }
.pl-dock.vertical .pl-dock-sep { width: calc(var(--pl-dock-icon) * .8); height: 1px; margin: 3px 0; }
.pl-dock-label {
  position: fixed; z-index: 1004; padding: 5px 9px; border-radius: 7px; pointer-events: none; max-width: 320px;
  background: var(--tray-bg, #1e1e1eee); color: var(--tray-fg, #e6e6e6); border: var(--tray-border, 1px solid #ffffff1a);
  box-shadow: 0 6px 24px #0007; font: 12px/1.35 system-ui, sans-serif;
}
.pl-dock-label b { font-weight: 600; }
.pl-dock-label small { display: block; color: var(--tray-muted, #9a9a9a); }
.pl-dock-ghost { position: fixed; z-index: 1005; pointer-events: none; opacity: .85; }
.pl-dock-ghost.removing { opacity: .4; filter: grayscale(1); }
.pl-dock-editor { width: 320px; max-width: 320px; }
.pl-dock-editor .pl-editor-head { display: flex; align-items: center; gap: 10px; }
.pl-dock-editor .pl-editor-head .pl-dock-icon { --pl-dock-icon: 32px; }
.pl-dock-editor .pl-editor-head b { display: block; font-size: 14px; }
.pl-dock-editor label.pl-field { display: grid; gap: 4px; }
.pl-dock-editor input { width: 100%; box-sizing: border-box; }
.pl-dock-editor .pl-apps { max-height: 190px; overflow: auto; display: grid; gap: 1px; border-radius: 6px; }
.pl-dock-editor .pl-apps button { padding: 4px 6px; }
.pl-dock-editor .pl-apps img { width: 18px; height: 18px; object-fit: contain; }
.pl-dock-editor .pl-editor-foot { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
.pl-dock-editor .pl-editor-foot button { width: auto; }
`;

let styled = false;
function style() {
  widgetStyle();
  if (styled) return;
  styled = true;
  document.head.append(Object.assign(document.createElement("style"), { textContent: CSS }));
}

// Super held: numbers on the docks that show them then (one listener for every dock).
let superWatched = false;
function watchSuper() {
  if (superWatched) return;
  superWatched = true;
  const set = (on) => document.body.classList.toggle("pl-super", on);
  addEventListener("keydown", (event) => { if (event.key === "Meta" || event.code.startsWith("Meta")) set(true); }, true);
  addEventListener("keyup", (event) => { if (event.key === "Meta" || event.code.startsWith("Meta")) set(false); }, true);
  addEventListener("pointermove", (event) => { if (!event.metaKey) set(false); }, true);
  addEventListener("blur", () => set(false));
}

const TERMINAL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 9l3 3-3 3M12.5 15H17"/></svg>';
const GLOBE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/></svg>';

/**
 * An icon from the first of `sources` (URLs, or promises of one) that loads;
 * else `fallback` (markup) or the name's first letter.
 */
function iconBox(sources, { name = "", fallback = "" } = {}) {
  const box = el("span", "pl-dock-icon");
  const rest = [...sources];
  const showFallback = () => {
    if (fallback) box.innerHTML = fallback;
    else box.replaceChildren(el("span", "pl-dock-letter", (name.trim()[0] ?? "?").toUpperCase()));
  };
  const next = async () => {
    while (rest.length) {
      const source = await Promise.resolve(rest.shift()).catch(() => null);
      if (!source) continue;
      const img = el("img");
      img.alt = "";
      img.decoding = "async";
      img.onerror = () => { if (img.isConnected || !box.contains(img)) next(); };
      img.src = source;
      box.replaceChildren(img);
      return;
    }
    showFallback();
  };
  showFallback();
  next();
  return box;
}

/**
 * Mounts a dock in `container`.
 * @param {HTMLElement} container
 * @param {import("./core.js").Dock} dock
 * @param {{
 *   orientation?: "horizontal" | "vertical",
 *   side?: "top" | "bottom" | "left" | "right",   where the dock sits: its menus and labels open away from it
 *   icons: { app(desktopId: string): Promise<string | null>, site(url: string): Promise<string | null>,
 *            window?(entry: object): Promise<string | null>, tab?(tab: object): string | null,
 *            target?(target: object): string | Element | null, group?(group: object): string | Element | null },
 *   scopeLabels?: Record<string, string>, layoutLabels?: Record<string, string>,
 *   kinds?: ("terminal" | "app" | "site")[],
 *   takeKeyboard?: () => (() => void) | void,   gives the page the keyboard (for the editor's fields); returns what gives it back
 *   onSettings?: () => void,
 *   extras?: HTMLElement[],
 *   addButton?: boolean,     a "+" after the pins: the editor, for a new slot
 *   removeEmpty?: boolean,   dragging a slot off (or Remove) takes it out, later ones moving up (Dash to Dock); else it leaves a gap (Hydra)
 *   apps?: () => Promise<{ id: string, name: string, genericName?: string, keywords?: string[] }[]>,
 * }} options
 */
export function mountDock(container, dock, options) {
  style();
  watchSuper();
  const {
    orientation = "horizontal",
    side = orientation === "horizontal" ? "bottom" : "left",
    icons,
    scopeLabels = { thread: "This workspace", project: "This project", global: "Everywhere" },
    layoutLabels = { split: "Normal", fold: "Maximized" },
    kinds = ["terminal", "app", "site"],
    takeKeyboard = () => {},
    onSettings = null,
    extras = [],
    addButton = true,
    removeEmpty = true,
  } = options;
  const root = el("div", `pl-dock ${orientation}`);
  root.setAttribute("role", "toolbar");
  root.setAttribute("aria-label", "Dock");
  container.append(root);
  const away = side === "bottom" ? "top" : side === "top" ? "bottom" : side;
  let label = null;
  let drag = null;
  let signature = "";
  const iconCache = new Map();

  const things = (entry) => entry.things;
  const thingKey = (thing) => (thing.kind === "window" ? `w${thing.entry.id}` : `t${thing.tab.id}`);
  const thingTitle = (thing) => (thing.kind === "window" ? thing.entry.title || thing.entry.appId || "Window" : thing.tab.title || thing.tab.url || "Tab");
  const cached = (key, make) => {
    if (!iconCache.has(key)) iconCache.set(key, make());
    return iconCache.get(key);
  };

  /** A slot's icon: the terminal, the app's own, a site's (its tab's, its own, the helper's). */
  function slotIcon(slot, entry) {
    const target = slot.target;
    const special = icons.target?.(target);
    if (special instanceof Element) return wrapIcon(special);
    if (special) return iconBox([special], { name: slotLabel(slot) });
    if (target.kind === "terminal") {
      return iconBox(target.windowAppId ? [cached(`app:${target.windowAppId}`, () => icons.app(target.windowAppId))] : [], { fallback: TERMINAL_SVG });
    }
    if (target.kind === "app") {
      const window = entry?.things.find((thing) => thing.kind === "window");
      return iconBox([
        target.desktopId ? cached(`app:${target.desktopId}`, () => icons.app(target.desktopId)) : null,
        window && icons.window ? cached(`win:${window.entry.id}`, () => icons.window(window.entry)) : null,
      ], { name: target.name });
    }
    const tab = entry?.things.find((thing) => thing.kind === "tab");
    return iconBox([
      tab && icons.tab ? icons.tab(tab.tab) : null,
      target.icon ?? null,
      cached(`site:${hostOf(target.url)}`, () => icons.site(target.url)),
    ], { name: target.name, fallback: "" });
  }

  function groupIcon(group) {
    const first = group.things[0];
    const own = icons.group?.(group);
    if (own instanceof Element) return wrapIcon(own);
    if (own) return iconBox([own], { name: group.name });
    return iconBox([
      group.desktopId ? cached(`app:${group.desktopId}`, () => icons.app(group.desktopId)) : null,
      first?.kind === "window" && icons.window ? cached(`win:${first.entry.id}`, () => icons.window(first.entry)) : null,
      first?.kind === "tab" && icons.tab ? icons.tab(first.tab) : null,
      group.url ? cached(`site:${hostOf(group.url)}`, () => icons.site(group.url)) : null,
    ], { name: group.name, fallback: first?.kind === "tab" ? GLOBE_SVG : "" });
  }

  function wrapIcon(element) {
    const box = el("span", "pl-dock-icon");
    box.append(element);
    return box;
  }

  function dots(count) {
    const box = el("span", "pl-dock-dots");
    for (let i = 0; i < Math.min(count, 4); i++) box.append(el("i"));
    return box;
  }

  // ------------------------------------------------------------ drawing
  function draw() {
    const view = dock.view();
    const numbers = dock.setting("showNumbers");
    const size = Number(dock.setting("iconSize")) || 24;
    const sig = JSON.stringify([
      view.pinned.map((p) => [p.slot, p.state, p.things.map(thingKey)]),
      view.running.map((g) => [g.key, g.state, g.things.map(thingKey)]),
      numbers, size, drag?.over ?? null, drag?.index ?? null,
    ]);
    if (sig === signature) return;
    signature = sig;
    root.style.setProperty("--pl-dock-icon", `${size}px`);
    root.classList.toggle("numbers", numbers === "always");
    root.classList.toggle("numbers-super", numbers === "super");
    const buttons = view.pinned.map((entry) => slotButton(entry));
    const running = view.running.map((group) => groupButton(group));
    if (drag?.over !== undefined && drag.over !== null) {
      const at = buttons[drag.over];
      if (at) at.classList.add("drop-before");
    }
    if (addButton) buttons.push(addSlotButton(view.pinned.length));
    root.replaceChildren(
      ...buttons,
      ...(running.length ? [el("span", "pl-dock-sep"), ...running] : []),
      ...(extras.length ? [el("span", "pl-dock-sep"), ...extras] : []),
    );
    // A drop at the end of the pins: the separator marks it.
    if (drag?.over === view.pinned.length && view.pinned.length) buttons[view.pinned.length - 1].after(el("span", "pl-dock-item drop-before pl-dock-end"));
  }

  function slotButton(entry) {
    const { index, slot, state } = entry;
    const button = el("button", `pl-dock-item ${state}`);
    button.dataset.dockSlot = String(index + 1);
    button.dataset.dockState = state;
    if (drag?.index === index && drag.moved) button.classList.add("dragging");
    if (slot) button.append(slotIcon(slot, entry));
    else button.append(el("span", "pl-dock-empty-dot"));
    if (index < DOCK_KEY_COUNT) button.append(el("span", "pl-dock-num", String(index + 1)));
    if (entry.things.length) button.append(dots(entry.things.length));
    button.setAttribute("aria-label", `${index < DOCK_KEY_COUNT ? `Super+${index + 1}: ` : ""}${slot ? slotLabel(slot) : "empty"}`);
    // A click mustn't take the keyboard from what has it.
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("pointerdown", (event) => {
      if (event.button === 0 && slot) startDrag(event, { index, button });
    });
    button.addEventListener("click", (event) => {
      if (drag?.moved) return;
      if (!slot) { openEditor(index, button); return; }
      if (event.shiftKey) { clickAs(dock.setting("shiftClick"), index); return; }
      void dock.activate(index, { click: true });
    });
    button.addEventListener("auxclick", (event) => {
      if (event.button === 1 && slot) { event.preventDefault(); clickAs(dock.setting("middleClick"), index); }
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      hideLabel();
      slotMenu(index, button);
    });
    button.addEventListener("wheel", (event) => {
      if (!slot || dock.setting("scrollAction") !== "cycle" || entry.things.length < 2) return;
      event.preventDefault();
      wheelStep(event, (dir) => dock.cycle(index, dir));
    }, { passive: false });
    hover(button, () => slotLabelText(entry));
    return button;
  }

  function addSlotButton(index) {
    const button = el("button", "pl-dock-item empty pl-dock-add");
    button.innerHTML = '<span class="pl-dock-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 6v12M6 12h12"/></svg></span>';
    button.setAttribute("aria-label", "Add to the dock");
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => openEditor(index, button));
    hover(button, () => ({ title: "Add to the dock", hint: "An app, a site or a terminal; or Super+Shift+N puts what has the keyboard in slot N" }));
    return button;
  }

  function groupButton(group) {
    const button = el("button", `pl-dock-item ${group.state}`);
    button.dataset.dockRunning = group.key;
    button.append(groupIcon(group), dots(group.things.length));
    button.setAttribute("aria-label", group.name);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("pointerdown", (event) => {
      if (event.button === 0) startDrag(event, { group, button });
    });
    button.addEventListener("click", () => {
      if (drag?.moved) return;
      const focused = group.things.some((thing) => dock.host.presence(thing) === "focused");
      if (focused && group.things.length === 1) dock.host.hide(group.things[0]);
      else if (focused && dock.setting("clickAction") === "focus-minimize-previews") windowList(group.things, button, null);
      else void dock.cycleGroup(group, focused ? 1 : 0);
    });
    button.addEventListener("auxclick", (event) => {
      if (event.button !== 1) return;
      event.preventDefault();
      const what = dock.setting("middleClick");
      if (what === "close") group.things.forEach((thing) => dock.host.close?.(thing));
      else if (what === "minimize") group.things.forEach((thing) => dock.host.hide(thing));
      else if (what === "new-window" && group.desktopId) {
        const thread = dock.host.launchThread("thread");
        if (thread) void dock.host.launchApp(group.desktopId, thread).catch((error) => toast(`Could not start ${group.name}`, { detail: String(error?.message ?? error) }));
      }
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      hideLabel();
      groupMenu(group, button);
    });
    button.addEventListener("wheel", (event) => {
      if (dock.setting("scrollAction") !== "cycle" || group.things.length < 2) return;
      event.preventDefault();
      wheelStep(event, (dir) => dock.cycleGroup(group, dir));
    }, { passive: false });
    hover(button, () => ({ title: group.name, detail: group.things.length > 1 ? `${group.things.length} windows` : "", hint: "Click to show; right-click to pin it" }));
    return button;
  }

  let wheelSum = 0;
  let wheelAt = 0;
  function wheelStep(event, step) {
    const now = performance.now();
    if (now - wheelAt > 300) wheelSum = 0;
    wheelSum += Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (Math.abs(wheelSum) < 40 || now - wheelAt < 120) return;
    wheelAt = now;
    step(Math.sign(wheelSum));
    wheelSum = 0;
  }

  function clickAs(what, index) {
    if (what === "new-window") void dock.newWindow(index);
    else if (what === "minimize") dock.minimizeAll(index);
    else if (what === "close") dock.closeAll(index);
  }

  const STATE_HINT = { empty: "Click to set it up", idle: "Click to start", running: "Click to show", shown: "Click to focus", focused: "Click to minimize" };
  function slotLabelText(entry) {
    const { index, slot, state } = entry;
    const keys = index < DOCK_KEY_COUNT ? `Super+${index + 1}` : "";
    if (!slot) return { title: keys ? `${keys}: empty` : "Empty", hint: STATE_HINT.empty };
    const where = slot.target.kind === "terminal" && !dock.host.launchTerminal ? "" : (scopeLabels[slot.scope] ?? slot.scope);
    const count = entry.things.length > 1 ? `${entry.things.length} windows` : "";
    const hint = state === "focused" && dock.setting("clickAction") === "focus-back" ? "Click to go back" : STATE_HINT[state];
    return { title: `${keys ? `${keys}: ` : ""}${slotLabel(slot)}`, detail: [where && `Kept: ${where.toLowerCase()}`, count].filter(Boolean).join(" · "), hint: `${hint}; right-click for more` };
  }

  // ------------------------------------------------------------ the hover label
  function hover(button, text) {
    let timer = 0;
    button.addEventListener("pointerenter", () => {
      clearTimeout(timer);
      timer = setTimeout(() => { if (!drag && button.isConnected) showLabel(button, text()); }, label ? 0 : 350);
    });
    button.addEventListener("pointerleave", () => { clearTimeout(timer); hideLabel(); });
  }
  function showLabel(anchor, { title, detail = "", hint = "" }) {
    hideLabel();
    label = el("div", "pl-dock-label");
    label.append(el("b", "", title));
    if (detail) label.append(el("small", "", detail));
    if (hint) label.append(el("small", "", hint));
    document.body.append(label);
    const box = anchor.getBoundingClientRect();
    const w = label.offsetWidth, h = label.offsetHeight;
    let x = box.left + box.width / 2 - w / 2;
    let y = away === "top" ? box.top - h - 8 : box.bottom + 8;
    if (away === "left" || away === "right") {
      x = away === "left" ? box.left - w - 8 : box.right + 8;
      y = box.top + box.height / 2 - h / 2;
    }
    label.style.left = `${Math.max(6, Math.min(x, innerWidth - w - 6))}px`;
    label.style.top = `${Math.max(6, Math.min(y, innerHeight - h - 6))}px`;
  }
  function hideLabel() {
    label?.remove();
    label = null;
  }

  // ------------------------------------------------------------ menus
  const menuSide = away === "top" ? "top" : "bottom";
  function windowItems(list, index) {
    return list.map((thing) => ({
      label: thingTitle(thing),
      checked: dock.host.presence(thing) === "focused" ? true : undefined,
      action: () => void dock.raise(thing, index),
    }));
  }

  function windowList(list, anchor, index) {
    menu([{ heading: "Windows" }, ...windowItems(list, index)], { anchor, side: menuSide, align: "center" });
  }
  dock.addEventListener("previews", (event) => {
    const index = event.detail.index;
    const button = root.querySelector(`[data-dock-slot="${index + 1}"]`);
    if (button) windowList(dock.things(index), button, index);
  });

  function slotMenu(index, anchor) {
    const slot = dock.slot(index);
    if (!slot) { openEditor(index, anchor); return; }
    const list = dock.things(index);
    const n = index + 1;
    const scoped = !(slot.target.kind === "terminal" && !dock.host.launchTerminal);
    const contextLayout = dock.contextLayout(index);
    menu([
      { heading: slotLabel(slot) },
      ...windowItems(list, index),
      list.length ? "-" : null,
      { label: slot.target.kind === "site" ? "New Tab" : "New Window", accel: n <= DOCK_KEY_COUNT ? `Super+Ctrl+Shift+${n}` : "", action: () => void dock.newWindow(index) },
      { label: "Put the Focused Window Here", accel: n <= DOCK_KEY_COUNT ? `Super+Shift+${n}` : "", action: () => void dock.assign(index) },
      "-",
      ...(scoped ? dock.host.scopes.map((scope) => ({ label: `Kept: ${scopeLabels[scope] ?? scope}`, checked: slot.scope === scope, action: () => void dock.setScope(index, scope) })) : []),
      ...["split", "fold"].map((layout) => ({ label: layoutLabels[layout], checked: (contextLayout ?? slot.layout) === layout, action: () => dock.save(index, { ...slot, layout }) })),
      "-",
      { label: "Edit…", action: () => openEditor(index, anchor) },
      list.length ? { label: list.length > 1 ? `Close ${list.length} Windows` : "Close", danger: true, action: () => dock.closeAll(index) } : null,
      { label: "Remove From Dock", danger: true, action: () => remove(index) },
      onSettings ? "-" : null,
      onSettings ? { label: "Dock Settings…", action: onSettings } : null,
    ], { anchor, side: menuSide, align: "center" });
  }

  function groupMenu(group, anchor) {
    const first = group.things[0];
    menu([
      { heading: group.name },
      ...windowItems(group.things, null),
      "-",
      group.desktopId ? { label: "New Window", action: () => { const thread = dock.host.launchThread("thread"); if (thread) void dock.host.launchApp(group.desktopId, thread); } } : null,
      { label: "Pin to Dock", action: () => void pinGroup(group, dock.slots.length) },
      { label: group.things.length > 1 ? `Close ${group.things.length} Windows` : "Close", danger: true, action: () => group.things.forEach((thing) => dock.host.close?.(thing)) },
      onSettings ? "-" : null,
      onSettings ? { label: "Dock Settings…", action: onSettings } : null,
    ].filter((item) => item !== null && (item !== "-" || first)), { anchor, side: menuSide, align: "center" });
  }

  /** Pins a running app at `index`: its newest window is the slot's. */
  async function pinGroup(group, index) {
    const newest = group.things.at(-1);
    if (!newest) return;
    const item = newest.kind === "window" ? { kind: "window", id: newest.entry.id } : { kind: "tab", id: newest.tab.id };
    // Room for it: the pins from `index` on move along.
    dock.openGap(index);
    await dock.assign(index, item);
  }

  function remove(index) {
    const slot = dock.slot(index);
    if (!slot) return;
    if (removeEmpty) {
      const removed = dock.unpin(index);
      toast(`${slotLabel(removed)} removed from the dock`, { action: { label: "Undo", run: () => dock.insert(index, removed) } });
    } else {
      dock.clear(index);
      toast(`Super+${index + 1} is empty now`);
    }
  }

  // ------------------------------------------------------------ dragging
  function slotRects() {
    return [...root.querySelectorAll(".pl-dock-item[data-dock-slot]")].map((button) => button.getBoundingClientRect());
  }
  /** Where a drop at (x, y) goes among the pins, or null when it's off the dock. */
  function dropIndexAt(x, y) {
    const box = root.getBoundingClientRect();
    const reach = 40;
    if (x < box.left - reach || x > box.right + reach || y < box.top - reach || y > box.bottom + reach) return null;
    return insertIndex(slotRects(), orientation === "horizontal" ? x : y, orientation === "horizontal" ? "x" : "y");
  }

  function startDrag(event, { index = null, group = null, button }) {
    const ghostOf = () => {
      const ghost = button.cloneNode(true);
      ghost.classList.add("pl-dock-ghost");
      const box = button.getBoundingClientRect();
      Object.assign(ghost.style, { width: `${box.width}px`, height: `${box.height}px` });
      document.body.append(ghost);
      return ghost;
    };
    drag = { index, group, moved: false, over: null, ghost: null };
    trackDrag(event, {
      threshold: 8,
      onMove: ({ x, y }) => {
        if (!drag) return;
        if (!drag.moved) { drag.moved = true; hideLabel(); drag.ghost = ghostOf(); }
        const box = button.getBoundingClientRect();
        drag.ghost.style.left = `${x - box.width / 2}px`;
        drag.ghost.style.top = `${y - box.height / 2}px`;
        drag.over = dropIndexAt(x, y);
        drag.ghost.classList.toggle("removing", index !== null && drag.over === null);
        signature = "";
        draw();
      },
      onEnd: ({ moved }) => {
        const done = drag;
        drag = null;
        done?.ghost?.remove();
        signature = "";
        if (!moved || !done) { draw(); return; }
        // The click that follows the release isn't one.
        const swallow = (e) => { e.stopPropagation(); e.preventDefault(); };
        addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => removeEventListener("click", swallow, { capture: true }), 0);
        if (done.index !== null) {
          if (done.over === null) remove(done.index);
          else dock.move(done.index, done.over > done.index ? done.over - 1 : done.over);
        } else if (done.group && done.over !== null) void pinGroup(done.group, done.over);
        draw();
      },
      onCancel: () => {
        drag?.ghost?.remove();
        drag = null;
        signature = "";
        draw();
      },
    });
  }

  // ------------------------------------------------------------ the editor
  let appsList = null;
  const appsOf = () => (appsList ??= (options.apps ?? dock.host.apps)().then((list) => [...list].sort((a, b) => a.name.localeCompare(b.name))).catch(() => { appsList = null; return []; }));

  function openEditor(index, anchor) {
    hideLabel();
    const giveBack = takeKeyboard();
    let kind = dock.slot(index)?.target.kind ?? null;
    let picking = !dock.slot(index);
    const build = (box) => {
      box.classList.add("pl-dock-editor");
      const slot = dock.slot(index);
      const n = index + 1;
      const head = el("div", "pl-editor-head");
      head.append(slot ? slotIcon(slot, null) : el("span", "pl-dock-icon"));
      const title = el("div");
      title.append(el("b", "", slot ? slotLabel(slot) : "Empty slot"));
      if (n <= DOCK_KEY_COUNT) title.append(el("span", "pl-hint", `Super+${n} · other layout Super+Ctrl+${n}`));
      head.append(title);
      box.append(head);

      box.append(el("h3", "", "Opens"));
      box.append(segmented(kind, kinds.map((k) => [k, { terminal: "Terminal", app: "App", site: "Site" }[k]]), (next) => {
        kind = next;
        if (next === "terminal") dock.save(index, { target: { kind: "terminal" }, scope: slot?.scope ?? "thread", layout: slot?.layout ?? "split" });
        picking = next !== "terminal" && slot?.target.kind !== next;
        refill();
      }));
      const focused = dock.host.focusedItem();
      const use = el("button", "", "Use the Focused Window or Tab");
      use.disabled = !focused;
      use.addEventListener("click", async () => { await dock.assign(index, focused); kind = dock.slot(index)?.target.kind ?? kind; picking = false; refill(); });
      box.append(use);

      if (kind === "app") {
        box.append(el("h3", "", "App"));
        if (slot?.target.kind === "app" && !picking) {
          const row = el("div", "row");
          row.append(el("span", "", slot.target.desktopId ?? slot.target.windowAppId ?? slot.target.name));
          const change = el("button", "icon", "Change");
          change.addEventListener("click", () => { picking = true; refill(); });
          row.append(change);
          box.append(row);
        } else box.append(appPicker((app) => {
          dock.save(index, { target: { kind: "app", desktopId: app.id, windowAppId: null, name: app.name }, scope: slot?.scope ?? "thread", layout: slot?.layout ?? "split" });
          picking = false;
          refill();
        }));
      }
      if (kind === "site") {
        const target = slot?.target.kind === "site" ? slot.target : null;
        const field = el("label", "pl-field");
        field.append(el("span", "", "Address"));
        const input = el("input", "pl-input");
        input.placeholder = "github.com/org/repo";
        input.value = target?.url ?? "";
        input.spellcheck = false;
        const error = el("span", "error");
        const commit = () => {
          const url = normalizeSiteUrl(input.value);
          if (!url) { error.textContent = input.value.trim() ? "Not a web address" : ""; return; }
          error.textContent = "";
          if (url === target?.url) return;
          const sameSite = target ? hostOf(target.url) === hostOf(url) : false;
          dock.save(index, {
            target: { kind: "site", url, name: sameSite && target ? target.name : hostOf(url), ...(sameSite && target?.icon ? { icon: target.icon } : {}) },
            scope: slot?.scope ?? "thread", layout: slot?.layout ?? "split",
          });
          refill();
        };
        input.addEventListener("change", commit);
        input.addEventListener("keydown", (event) => { if (event.key === "Enter") commit(); event.stopPropagation(); });
        field.append(input, error, el("span", "pl-hint", "Where a new tab for it opens. The slot keeps that tab, wherever you browse in it."));
        box.append(field);
        if (!target) setTimeout(() => input.focus());
      }
      if (slot && slot.target.kind !== "terminal" && slot.target.kind === kind) {
        const field = el("label", "pl-field");
        field.append(el("span", "", "Name"));
        const input = el("input", "pl-input");
        input.value = slot.target.name;
        input.addEventListener("change", () => { const name = input.value.trim(); if (name) dock.save(index, { ...slot, target: { ...slot.target, name } }); });
        input.addEventListener("keydown", (event) => { if (event.key === "Enter") input.blur(); event.stopPropagation(); });
        field.append(input);
        box.append(field);
      }
      if (slot && !(slot.target.kind === "terminal" && !dock.host.launchTerminal)) {
        box.append(el("h3", "", "Kept"));
        box.append(segmented(slot.scope, dock.host.scopes.map((scope) => [scope, scopeLabels[scope] ?? scope]), (scope) => void dock.setScope(index, scope).then(refill)));
      }
      if (slot) {
        const contextLayout = dock.contextLayout(index);
        box.append(el("h3", "", "Layout"));
        box.append(segmented(slot.layout, [["split", layoutLabels.split], ["fold", layoutLabels.fold]], (layout) => { dock.save(index, { ...slot, layout }); refill(); }));
        if (contextLayout && contextLayout !== slot.layout) {
          const reset = el("button", "", `Here it's ${layoutLabels[contextLayout].toLowerCase()}: use the slot's layout here too`);
          reset.addEventListener("click", () => { dock.clearContextLayout(index); refill(); });
          box.append(reset);
        }
      }
      const foot = el("div", "pl-editor-foot");
      foot.append(el("span", "pl-hint", n <= DOCK_KEY_COUNT ? `Super+Shift+${n} puts what has the keyboard here` : ""));
      const clear = el("button", "", removeEmpty ? "Remove" : "Clear");
      clear.disabled = !slot;
      clear.addEventListener("click", () => { closePopover(); remove(index); });
      foot.append(clear);
      box.append(foot);
    };
    const refill = () => {
      const open = current;
      if (!open?.element.isConnected) return;
      open.element.replaceChildren();
      build(open.element);
      open.place();
    };
    const current = popover(anchor, build, { className: "pl-dock-editor-box", onClose: () => { if (typeof giveBack === "function") giveBack(); } });
  }

  function appPicker(onPick) {
    const box = el("div");
    const input = el("input", "pl-input");
    input.type = "search";
    input.placeholder = "Find an app";
    const list = el("div", "pl-apps");
    list.append(el("span", "pl-hint", "Loading apps…"));
    let apps = [];
    const show = () => {
      const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
      const shown = apps.filter((app) => {
        const text = [app.name, app.genericName ?? "", app.id, ...(app.keywords ?? [])].join(" ").toLowerCase();
        return words.every((word) => text.includes(word));
      });
      list.replaceChildren(...(shown.length ? shown.slice(0, 80).map((app) => {
        const button = el("button");
        button.dataset.dockApp = app.id;
        const img = el("img");
        img.alt = "";
        cached(`app:${app.id}`, () => icons.app(app.id)).then((url) => { if (url) img.src = url; else img.style.visibility = "hidden"; });
        button.append(img, el("span", "", app.name));
        button.addEventListener("click", () => onPick(app));
        return button;
      }) : [el("span", "pl-hint", apps.length ? "No app matches" : "No apps")]));
      return shown;
    };
    input.addEventListener("input", show);
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") { const first = show()[0]; if (first) onPick(first); }
      if (event.key === "Escape") closePopover();
    });
    appsOf().then((list) => { apps = list; show(); });
    box.append(input, list);
    setTimeout(() => input.focus());
    return box;
  }

  // ------------------------------------------------------------ live
  dock.addEventListener("change", () => draw());
  draw();
  return {
    root,
    draw: () => { signature = ""; draw(); },
    /** Where a drop at (x, y) would go among the pins (an app dragged from elsewhere), or null. */
    dropIndexAt,
    /** Shows where a drop goes (null: nowhere). */
    showDrop(index) {
      if ((drag?.over ?? null) === index && drag?.external) return;
      drag = index === null ? null : { external: true, index: null, over: index, moved: false };
      signature = "";
      draw();
    },
    openEditor: (index) => {
      const button = root.querySelector(`[data-dock-slot="${index + 1}"]`) ?? root;
      openEditor(index, button);
    },
    destroy() {
      hideLabel();
      root.remove();
    },
  };
}

// Small widgets the shell's parts share: elements, popup menus, dialogs,
// sliders and switches, styled as GNOME Shell's (index.html's CSS).

import { icon } from "./icons.js";

/** An element with a class and text. */
export function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A button with an icon and/or a label. */
export function button(className, { icon: name, label, title, onClick } = {}) {
  const b = el("button", className);
  b.innerHTML = `${name ? icon(name) : ""}${label !== undefined ? "<span></span>" : ""}`;
  if (label !== undefined) b.querySelector("span").textContent = label;
  if (title) b.title = title;
  if (onClick) b.addEventListener("click", onClick);
  // Clicks in the shell's chrome don't take the keyboard from the app that has it.
  b.addEventListener("mousedown", (e) => e.preventDefault());
  return b;
}

/** A range input 0–max calling set(value) as it moves, at most one call in flight. */
export function slider(value, max, set, { step = 0.01 } = {}) {
  const input = el("input", "slider");
  input.type = "range";
  input.min = "0";
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const paint = () => input.style.setProperty("--fill", `${(Number(input.value) / max) * 100}%`);
  paint();
  let busy = false;
  let next = null;
  const send = async (target) => {
    if (busy) { next = target; return; }
    busy = true;
    try { await set(target); } catch (error) { console.warn(error); }
    busy = false;
    if (next !== null) { const again = next; next = null; void send(again); }
  };
  input.addEventListener("input", () => { paint(); void send(Number(input.value)); });
  input.setValue = (v) => { if (!input.matches(":active")) { input.value = String(v); paint(); } };
  return input;
}

/** An Adwaita switch. */
export function toggle(checked, onChange) {
  const b = el("button", "switch");
  b.setAttribute("role", "switch");
  const set = (on) => { b.classList.toggle("on", on); b.setAttribute("aria-checked", String(on)); };
  set(checked);
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", () => { const on = !b.classList.contains("on"); set(on); onChange(on); });
  b.set = set;
  return b;
}

// ---------------------------------------------------------------- popup menus
let openMenu = null;

/**
 * A popup menu at (x, y) (page pixels), or under `anchor`. Items: { label,
 * icon?, checked?, disabled?, danger?, action } or "-" for a separator, or
 * { heading }. Escape or a click outside closes it.
 */
export function menu(items, { x, y, anchor, align = "start", onClose } = {}) {
  closeMenu();
  const root = el("div", "menu");
  root.setAttribute("role", "menu");
  const buttons = [];
  for (const item of items) {
    if (!item) continue;
    if (item === "-") { root.append(el("div", "menu-sep")); continue; }
    if (item.heading) { root.append(el("div", "menu-heading", item.heading)); continue; }
    const b = el("button", "menu-item");
    b.innerHTML = `<span class="menu-icon">${item.icon ? icon(item.icon) : ""}</span><span class="menu-label"></span><span class="menu-check">${item.checked ? icon("check") : ""}</span>`;
    b.querySelector(".menu-label").textContent = item.label;
    if (item.accel) b.querySelector(".menu-check").textContent = item.accel;
    b.disabled = !!item.disabled;
    if (item.danger) b.classList.add("danger");
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => { closeMenu(); item.action?.(); });
    root.append(b);
    buttons.push(b);
  }
  document.body.append(root);
  const w = root.offsetWidth, h = root.offsetHeight;
  if (anchor) {
    const box = anchor.getBoundingClientRect();
    x = align === "center" ? box.left + box.width / 2 - w / 2 : align === "end" ? box.right - w : box.left;
    y = box.bottom + 6;
    if (y + h > innerHeight - 6) y = box.top - h - 6;
  }
  root.style.left = `${Math.max(6, Math.min(x, innerWidth - w - 6))}px`;
  root.style.top = `${Math.max(6, Math.min(y, innerHeight - h - 6))}px`;
  let index = -1;
  const outside = (e) => { if (!root.contains(e.target)) closeMenu(); };
  const keys = (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); e.stopPropagation();
      const usable = buttons.filter((b) => !b.disabled);
      if (!usable.length) return;
      index = (index + (e.key === "ArrowDown" ? 1 : -1) + usable.length) % usable.length;
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

export function closeMenu() { openMenu?.close(); }
export const menuOpen = () => openMenu !== null;

// ---------------------------------------------------------------- dialogs
/**
 * A GNOME modal dialog: title, body (text or element), buttons. Resolves with
 * the chosen button's value (null on Escape / Cancel).
 */
export function dialog({ title, body, buttons = [{ label: "OK", value: true, default: true }], onOpen }) {
  return new Promise((resolve) => {
    const back = el("div", "modal-back");
    const box = el("div", "modal");
    box.setAttribute("role", "alertdialog");
    box.append(el("h2", "", title));
    if (typeof body === "string") box.append(el("p", "", body));
    else if (body) box.append(body);
    const row = el("div", "modal-buttons");
    const done = (value) => {
      back.remove();
      removeEventListener("keydown", keys, true);
      resolve(value);
    };
    for (const spec of buttons) {
      const b = el("button", `modal-button ${spec.danger ? "danger" : spec.default ? "suggested" : ""}`, spec.label);
      b.addEventListener("click", () => done(typeof spec.value === "function" ? spec.value() : spec.value));
      row.append(b);
    }
    box.append(row);
    back.append(box);
    const keys = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(null); }
      else if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) {
        const spec = buttons.find((b) => b.default) ?? buttons.at(-1);
        e.preventDefault(); e.stopPropagation();
        done(typeof spec.value === "function" ? spec.value() : spec.value);
      } else e.stopPropagation();
    };
    addEventListener("keydown", keys, true);
    back.addEventListener("pointerdown", (e) => { if (e.target === back) done(null); });
    document.body.append(back);
    onOpen?.(box);
    (box.querySelector("input") ?? row.querySelector(".suggested, .danger") ?? row.lastChild)?.focus();
  });
}

/** Asks before something that can't be undone. */
export function confirm(title, message, action, { danger = true } = {}) {
  return dialog({
    title,
    body: message,
    buttons: [{ label: "Cancel", value: false }, { label: action, value: true, danger, default: !danger }],
  }).then((v) => v === true);
}

/** Asks for a line of text. Resolves with it, or null. */
export function ask(title, { message, value = "", placeholder = "", action = "OK", password = false } = {}) {
  const body = el("div", "modal-body");
  if (message) body.append(el("p", "", message));
  const input = el("input", "entry");
  input.type = password ? "password" : "text";
  input.value = value;
  input.placeholder = placeholder;
  input.spellcheck = false;
  body.append(input);
  return dialog({
    title,
    body,
    buttons: [{ label: "Cancel", value: null }, { label: action, value: () => input.value, default: true }],
    onOpen: () => setTimeout(() => { input.focus(); input.select(); }),
  });
}

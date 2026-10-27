// The clock in the middle of the top bar and its menu, as GNOME's: the
// notification list (with Do Not Disturb and Clear) and what's playing on
// the left, the calendar on the right. Also the notification banners that
// drop from the top of the screen.

import { icon } from "./icons.js";
import { el, button } from "./ui.js";

/**
 * ctx: { shell, prefs, toast, onOpen, onClose }
 * Returns { clock (the bar's button), toggle(), close(), isOpen(), banner(n), tick() }.
 */
export function mountDateMenu(ctx) {
  const { shell } = ctx;
  const notifications = shell?.system.notifications;
  const media = shell?.system.media;
  let list = [];
  let dnd = false;
  let players = [];

  // ---------------------------------------------------------------- the clock
  const clock = el("button", "pill-btn");
  clock.id = "clock";
  clock.addEventListener("mousedown", (e) => e.preventDefault());
  const dot = el("span", "clock-dot");
  function tick() {
    const now = new Date();
    const p = ctx.prefs;
    const time = now.toLocaleTimeString(undefined, {
      hour: "numeric", minute: "2-digit", ...(p.clockSeconds ? { second: "2-digit" } : {}),
      ...(p.clock24 === true ? { hourCycle: "h23" } : p.clock24 === false ? { hourCycle: "h12" } : {}),
    });
    const day = p.clockDate === false ? "" : now.toLocaleDateString(undefined, { weekday: p.clockWeekday === false ? undefined : "short", month: "short", day: "numeric" });
    clock.textContent = day ? `${day}  ${time}` : time;
    clock.append(dot);
    dot.hidden = !list.length || dnd;
  }
  let timer = null;
  const schedule = () => {
    clearTimeout(timer);
    const now = new Date();
    timer = setTimeout(() => { tick(); schedule(); }, ctx.prefs.clockSeconds ? 1000 - now.getMilliseconds() + 5 : 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);
  };
  tick();
  schedule();

  // ---------------------------------------------------------------- the menu
  const panel = el("div", "popover datemenu");
  panel.hidden = true;
  document.body.append(panel);
  let month = null; // the month the calendar shows (a Date on its 1st)

  function render() {
    if (panel.hidden) return;
    const left = el("div", "dm-left");
    // What's playing.
    for (const p of players.slice(0, 2)) left.append(mediaCard(p));
    // Notifications.
    const scroller = el("div", "dm-list");
    if (!list.length) {
      const empty = el("div", "dm-empty");
      empty.innerHTML = `${icon("bell")}<span>No Notifications</span>`;
      scroller.append(empty);
    } else {
      for (const n of list) scroller.append(notificationCard(n, { inList: true }));
    }
    left.append(scroller);
    const foot = el("div", "dm-foot");
    const dndRow = el("label", "dm-dnd");
    dndRow.append(el("span", "", "Do Not Disturb"));
    const sw = el("button", `switch ${dnd ? "on" : ""}`);
    sw.addEventListener("mousedown", (e) => e.preventDefault());
    sw.addEventListener("click", () => notifications?.call("set-do-not-disturb", { on: !dnd }).catch((e) => ctx.toast(e.message)));
    dndRow.append(sw);
    const clear = button("dm-clear", { label: "Clear", onClick: () => notifications?.call("clear").catch((e) => ctx.toast(e.message)) });
    clear.disabled = !list.length;
    foot.append(dndRow, clear);
    left.append(foot);
    panel.replaceChildren(left, el("div", "dm-sep"), calendar());
  }

  function calendar() {
    const now = new Date();
    month ??= new Date(now.getFullYear(), now.getMonth(), 1);
    const box = el("div", "dm-right");
    const today = button("dm-today", { onClick: () => { month = new Date(now.getFullYear(), now.getMonth(), 1); render(); } });
    today.innerHTML = "<small></small><b></b>";
    today.querySelector("small").textContent = now.toLocaleDateString(undefined, { weekday: "long" });
    today.querySelector("b").textContent = now.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
    const nav = el("div", "dm-nav");
    nav.append(
      button("round", { icon: "back", title: "Previous month", onClick: () => { month = new Date(month.getFullYear(), month.getMonth() - 1, 1); render(); } }),
      el("b", "", month.toLocaleDateString(undefined, { month: "long", ...(month.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) })),
      button("round", { icon: "forward", title: "Next month", onClick: () => { month = new Date(month.getFullYear(), month.getMonth() + 1, 1); render(); } }),
    );
    const table = el("table", "dm-cal");
    const first = new Date(month);
    const weekStart = ctx.prefs.weekStartsSunday ? 0 : 1;
    const start = new Date(first);
    start.setDate(1 - ((first.getDay() - weekStart + 7) % 7));
    const head = el("tr");
    for (let i = 0; i < 7; i++) {
      const d = new Date(2024, 0, 7 + weekStart + i); // 2024-01-07 was a Sunday
      head.append(el("th", "", d.toLocaleDateString(undefined, { weekday: "narrow" })));
    }
    table.append(head);
    for (let w = 0; w < 6; w++) {
      const tr = el("tr");
      for (let i = 0; i < 7; i++) {
        const date = new Date(start);
        date.setDate(start.getDate() + w * 7 + i);
        const cls = [
          date.toDateString() === now.toDateString() ? "today" : "",
          date.getMonth() !== month.getMonth() ? "other" : "",
          date.getDay() === 0 || date.getDay() === 6 ? "weekend" : "",
        ].join(" ");
        tr.append(el("td", cls, String(date.getDate())));
      }
      table.append(tr);
    }
    // The wheel moves between months.
    table.addEventListener("wheel", (e) => {
      e.preventDefault();
      month = new Date(month.getFullYear(), month.getMonth() + (e.deltaY > 0 ? 1 : -1), 1);
      render();
    }, { passive: false });
    box.append(today, nav, table);
    return box;
  }

  function mediaCard(p) {
    const card = el("div", "dm-media");
    const art = el("div", "dm-art");
    if (p.artUrl && /^(https?|data):/.test(p.artUrl)) art.style.backgroundImage = `url("${p.artUrl}")`;
    else art.innerHTML = icon("music");
    const text = el("div", "dm-media-text");
    text.append(el("b", "", p.title || p.name), el("small", "", [p.artist, p.album].filter(Boolean).join(" — ") || p.name));
    const controls = el("div", "dm-media-controls");
    const act = (action) => () => media.call(action, { player: p.id }).catch((e) => ctx.toast(e.message));
    const prev = button("round", { icon: "previous", title: "Previous", onClick: act("previous") });
    prev.disabled = !p.canGoPrevious;
    const play = button("round", { icon: p.status === "playing" ? "pause" : "play", title: p.status === "playing" ? "Pause" : "Play", onClick: act("play-pause") });
    const next = button("round", { icon: "next", title: "Next", onClick: act("next") });
    next.disabled = !p.canGoNext;
    controls.append(prev, play, next);
    card.append(art, text, controls);
    return card;
  }

  // An app's icon for a notification: its own (a data URL, a site's), else
  // its desktop entry's or its icon name's through the helper.
  function notificationIcon(n) {
    const box = el("span", "n-icon");
    const img = document.createElement("img");
    img.alt = "";
    const fallback = () => { box.innerHTML = icon("bell"); };
    if (n.icon && /^(data:|https?:)/.test(n.icon)) { img.src = n.icon; box.append(img); return box; }
    const name = n.desktopEntry || (n.icon && !n.icon.startsWith("/") && !n.icon.startsWith("file:") ? n.icon : "") || n.app;
    if (shell && name) {
      shell.appIcon(name).then((url) => { if (url) { img.src = url; box.replaceChildren(img); } else fallback(); });
      fallback();
    } else fallback();
    return box;
  }

  const plain = (html) => { const d = document.createElement("div"); d.innerHTML = String(html ?? "").replace(/<br\s*\/?>/gi, "\n"); return d.textContent; };
  function ago(time) {
    const s = Math.round((Date.now() - time) / 1000);
    if (s < 60) return "Just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return new Date(time).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return new Date(time).toLocaleDateString(undefined, { weekday: "short" });
  }

  function notificationCard(n, { inList = false, onDone } = {}) {
    const card = el("div", `n-card ${n.urgency === "critical" ? "critical" : ""}`);
    const head = el("div", "n-head");
    head.append(notificationIcon(n), el("span", "n-app", n.app || "Notification"), el("span", "n-time", ago(n.time)));
    const x = button("n-close round", { icon: "close", title: "Close", onClick: (e) => { e.stopPropagation(); notifications?.call("dismiss", { id: n.id }).catch(() => {}); onDone?.(); } });
    head.append(x);
    const body = el("div", "n-body");
    body.append(el("b", "", plain(n.summary)));
    if (n.body) body.append(el("p", "", plain(n.body)));
    card.append(head, body);
    const actions = (n.actions ?? []).filter((a) => a.key !== "default");
    if (actions.length) {
      const row = el("div", "n-actions");
      for (const a of actions) {
        row.append(button("n-action", { label: a.label, onClick: (e) => { e.stopPropagation(); notifications.call("invoke", { id: n.id, action: a.key }).catch(() => {}); onDone?.(); close(); } }));
      }
      card.append(row);
    }
    card.addEventListener("click", () => {
      notifications?.call("invoke", { id: n.id, action: "default" }).catch(() => {});
      if (inList) notifications?.call("dismiss", { id: n.id }).catch(() => {});
      onDone?.();
      close();
    });
    return card;
  }

  // ---------------------------------------------------------------- banners
  const banners = el("div", "banners");
  document.body.append(banners);
  function banner(n) {
    if (ctx.prefs.banners === false && n.urgency !== "critical") return;
    // An update of one already shown replaces it.
    banners.querySelector(`[data-id="${n.id}"]`)?.remove();
    const wrap = el("div", "banner");
    wrap.dataset.id = String(n.id);
    let timer = null;
    const done = () => { clearTimeout(timer); wrap.classList.add("out"); setTimeout(() => wrap.remove(), 250); };
    wrap.append(notificationCard(n, { onDone: done }));
    banners.prepend(wrap);
    while (banners.children.length > 3) banners.lastChild.remove();
    const arm = () => { if (n.urgency !== "critical") timer = setTimeout(done, n.urgency === "low" ? 3000 : 5000); };
    wrap.addEventListener("pointerenter", () => clearTimeout(timer));
    wrap.addEventListener("pointerleave", arm);
    arm();
  }

  // ---------------------------------------------------------------- open, close
  function open() {
    ctx.onOpen?.();
    panel.hidden = false;
    clock.classList.add("open");
    month = null;
    render();
    addEventListener("pointerdown", outside, true);
    addEventListener("keydown", escape, true);
  }
  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    clock.classList.remove("open");
    removeEventListener("pointerdown", outside, true);
    removeEventListener("keydown", escape, true);
    ctx.onClose?.();
  }
  const outside = (e) => { if (!panel.contains(e.target) && !clock.contains(e.target)) close(); };
  const escape = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
  const toggle = () => (panel.hidden ? open() : close());
  clock.addEventListener("click", toggle);

  notifications?.addEventListener("change", (e) => { list = e.detail?.notifications ?? []; dnd = !!e.detail?.doNotDisturb; tick(); render(); });
  notifications?.ready.then((s) => { list = s?.notifications ?? []; dnd = !!s?.doNotDisturb; tick(); render(); }, () => {});
  media?.addEventListener("change", (e) => { players = e.detail?.players ?? []; render(); });
  media?.ready.then((s) => { players = s?.players ?? []; render(); }, () => {});

  return { clock, toggle, open, close, isOpen: () => !panel.hidden, banner, tick: () => { tick(); schedule(); } };
}

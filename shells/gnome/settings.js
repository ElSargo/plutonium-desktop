// Settings, as GNOME's Settings app: a window drawn by the shell with a
// sidebar of pages. Network, Bluetooth, sound, power and the screen lock are
// over the desktop services; appearance, multitasking, keyboard shortcuts,
// apps, notifications and the clock are the shell's own (shell.storage).

import { icon, wifiIcon, batteryIcon, duration } from "./icons.js";
import { el, button, slider, toggle, confirm, ask, dialog } from "./ui.js";

const CSS = `
.settings {
  position: fixed; z-index: 990; width: min(980px, calc(100vw - 40px)); height: min(680px, calc(100vh - 80px));
  display: grid; grid-template-columns: 250px 1fr; border-radius: 14px; overflow: hidden;
  background: #1e1e1e; color: #fff; box-shadow: 0 10px 50px #000c, 0 0 0 1px #ffffff14; font-weight: 400;
  transition: opacity .2s;
}
body.overview .settings { opacity: 0; pointer-events: none; }
.settings[hidden] { display: none; }
.st-side { background: #2a2a2d; display: flex; flex-direction: column; min-height: 0; }
.st-head { height: 46px; flex: none; display: flex; align-items: center; gap: 6px; padding: 0 8px; font-weight: 700; }
.st-head .st-title { flex: 1; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-search { margin: 0 10px 8px; }
.st-nav { flex: 1; overflow: auto; padding: 0 8px 8px; display: grid; gap: 2px; align-content: start; scrollbar-width: thin; }
.st-nav button { display: flex; align-items: center; gap: 12px; padding: 9px 12px; border-radius: 8px; text-align: left; }
.st-nav button:hover { background: #ffffff12; }
.st-nav button.cur { background: #ffffff1f; font-weight: 700; }
.st-nav .sep { height: 1px; margin: 6px 8px; background: #ffffff14; }
.st-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.st-main .st-head { border-bottom: 1px solid #00000040; }
.st-body { flex: 1; overflow: auto; padding: 24px max(24px, calc((100% - 640px) / 2)) 40px; display: grid; gap: 22px; align-content: start; scrollbar-width: thin; }
.st-group { display: grid; gap: 8px; }
.st-group > h3 { margin: 0 0 2px 4px; font-size: 14px; }
.st-group > .st-desc { margin: -4px 0 4px 4px; color: #ffffff90; font-size: 13px; }
.st-box { border-radius: 12px; background: #ffffff0d; box-shadow: 0 0 0 1px #00000040; overflow: hidden; }
.st-row { display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 8px 14px; }
.st-row + .st-row { border-top: 1px solid #00000040; }
.st-row .st-label { flex: 1; min-width: 0; display: grid; }
.st-row .st-label small { color: #ffffff90; font-size: 12.5px; }
.st-row.click:hover { background: #ffffff0a; }
.st-row .entry { width: 260px; }
.st-row select { height: 34px; border-radius: 8px; border: 0; padding: 0 8px; font: inherit; color: #fff; background: #ffffff1a; }
.st-row select option { background: #2a2a2d; }
.st-row .slider { max-width: 300px; }
.st-pill { padding: 6px 14px; border-radius: 8px; background: #ffffff1a; font-weight: 700; }
.st-pill:hover:not(:disabled) { background: #ffffff26; }
.st-pill.danger { color: #ff7b7b; }
.st-pill.suggested { background: var(--accent); color: var(--accent-fg); }
.st-arrange { position: relative; height: 180px; margin: 4px; border-radius: 10px; background: #00000030; touch-action: none; }
.st-monitor { position: absolute; display: grid; place-content: center; justify-items: center; gap: 2px; border-radius: 6px; background: #ffffff1f; box-shadow: inset 0 0 0 1px #00000060; font-size: 12px; cursor: grab; user-select: none; overflow: hidden; }
.st-monitor b { font-size: 20px; }
.st-monitor.cur { background: var(--accent); color: var(--accent-fg); }
.st-monitor.drag { cursor: grabbing; opacity: .85; z-index: 1; }
.st-keys { display: flex; gap: 4px; flex-wrap: wrap; justify-content: end; }
.kbd { padding: 3px 8px; border-radius: 6px; background: #ffffff1a; box-shadow: inset 0 -2px 0 #00000050; font-size: 12.5px; font-weight: 700; white-space: nowrap; }
.kbd.none { background: none; box-shadow: none; color: #ffffff70; font-weight: 400; }
.kbd.rec { background: var(--accent); color: var(--accent-fg); }
.kbd.changed { box-shadow: inset 0 -2px 0 var(--accent); }
.st-walls { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; padding: 14px; }
.st-wall { aspect-ratio: 16 / 10; border-radius: 10px; background-size: cover; background-position: center; outline: 3px solid transparent; outline-offset: 2px; }
.st-wall.cur { outline-color: var(--accent); }
.st-accents { display: flex; gap: 10px; flex-wrap: wrap; }
.st-accent { width: 30px; height: 30px; border-radius: 99px; outline: 2px solid transparent; outline-offset: 3px; }
.st-accent.cur { outline-color: #fff; }
.st-choice { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; padding: 14px; }
.st-choice button { display: grid; gap: 8px; justify-items: center; padding: 10px; border-radius: 10px; }
.st-choice button:hover { background: #ffffff0d; }
.st-choice button.cur { background: #ffffff14; box-shadow: inset 0 0 0 2px var(--accent); }
.st-choice .pic { width: 100%; aspect-ratio: 16 / 10; border-radius: 6px; background: #ffffff14; position: relative; overflow: hidden; }
.st-choice .pic i { position: absolute; background: #ffffff60; border-radius: 3px; }
.st-empty { padding: 18px; text-align: center; color: #ffffff90; }
.st-big { display: grid; justify-items: center; gap: 6px; padding: 18px; text-align: center; }
.st-big .ic { width: 64px; height: 64px; }
.st-big h2 { margin: 0; }
.st-row .app-ic { width: 32px; height: 32px; display: grid; place-items: center; }
.st-row .app-ic > * { width: 32px; height: 32px; font-size: 14px; }
.st-check { color: var(--accent); }
`;

/**
 * ctx: { shell, helper, prefs, setPref, toast, quick, ACTIONS, keysOf, normalizeCombo, record(fn), stopRecording(),
 *        favorites(), setFavorites(list), appById(id), appIconEl(app), apps(), workspaces(), renameWorkspace(id, name),
 *        WALLPAPERS, ACCENTS }
 */
export function mountSettings(ctx) {
  const { shell } = ctx;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  const sys = shell?.system;

  const PAGES = [
    { id: "wifi", title: "Network", icon: "wifi", keywords: "wi-fi wifi wireless internet vpn wired ethernet password" },
    { id: "bluetooth", title: "Bluetooth", icon: "bluetooth", keywords: "devices pair headphones mouse keyboard" },
    "-",
    { id: "displays", title: "Displays", icon: "display", keywords: "monitors screens resolution refresh rate scale size orientation rotation primary mirror arrange" },
    { id: "sound", title: "Sound", icon: "volume", keywords: "audio volume speakers microphone output input" },
    { id: "power", title: "Power", icon: "power", keywords: "battery brightness suspend restart" },
    { id: "privacy", title: "Screen Lock", icon: "lock", keywords: "privacy lock idle blank screen keep awake" },
    "-",
    { id: "appearance", title: "Appearance", icon: "appearance", keywords: "wallpaper background accent color dock title bar" },
    { id: "multitasking", title: "Multitasking", icon: "multitasking", keywords: "workspaces threads hot corner edge tiling super key switcher" },
    { id: "keyboard", title: "Keyboard Shortcuts", icon: "keyboard", keywords: "keys hotkeys shortcuts accelerators bindings custom" },
    { id: "apps", title: "Apps", icon: "apps", keywords: "dash dock pinned favorites terminal default browser homepage" },
    { id: "notifications", title: "Notifications", icon: "bell", keywords: "do not disturb banners" },
    { id: "datetime", title: "Date & Time", icon: "info", keywords: "clock 24-hour seconds weekday calendar week" },
    "-",
    { id: "about", title: "About", icon: "info", keywords: "system plutonium version helper displays" },
  ];
  const pageById = (id) => PAGES.find((p) => p.id === id);

  const states = {};
  for (const name of ["audio", "power", "network", "bluetooth", "notifications", "session", "display"]) {
    if (!sys) break;
    states[name] = sys[name].state;
    sys[name].addEventListener("change", (e) => { states[name] = e.detail; if (page === pageFor(name)) render(); });
    sys[name].ready.then((s) => { states[name] = s; if (page === pageFor(name)) render(); }, () => {});
  }
  const pageFor = (service) => ({ audio: "sound", power: "power", network: "wifi", bluetooth: "bluetooth", notifications: "notifications", session: "privacy", display: "displays" })[service];
  const call = async (service, action, args) => {
    try { return await sys[service].call(action, args); }
    catch (error) { ctx.toast(`${service}: ${error.message}`); return null; }
  };

  // ---------------------------------------------------------------- the window
  const win = el("div", "settings");
  win.hidden = true;
  win.tabIndex = -1;
  win.style.outline = "none";
  // A click in it gives it the keyboard (from the app that had it).
  win.addEventListener("pointerdown", (e) => { if (!e.target.closest("input, select")) setTimeout(() => win.focus()); });
  const side = el("div", "st-side");
  const sideHead = el("div", "st-head");
  sideHead.append(el("span", "st-title", "Settings"));
  const search = el("input", "entry st-search");
  search.placeholder = "Search";
  search.spellcheck = false;
  const nav = el("div", "st-nav");
  side.append(sideHead, search, nav);
  const main = el("div", "st-main");
  const head = el("div", "st-head");
  const title = el("span", "st-title");
  const closeBtn = button("round", { icon: "close", title: "Close", onClick: () => close() });
  head.append(el("span", "", ""), title, closeBtn);
  head.firstChild.style.width = "34px";
  const body = el("div", "st-body");
  main.append(head, body);
  win.append(side, main);
  document.body.append(win);

  // Moved by its header bars.
  for (const h of [head, sideHead]) {
    h.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button")) return;
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      const r = win.getBoundingClientRect();
      const ox = e.clientX - r.left, oy = e.clientY - r.top;
      const move = (ev) => {
        win.style.left = `${Math.max(-r.width + 80, Math.min(innerWidth - 80, ev.clientX - ox))}px`;
        win.style.top = `${Math.max(32, Math.min(innerHeight - 40, ev.clientY - oy))}px`;
      };
      const up = () => { h.removeEventListener("pointermove", move); h.removeEventListener("pointerup", up); };
      h.addEventListener("pointermove", move);
      h.addEventListener("pointerup", up);
    });
  }
  win.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !recording && !e.target.closest(".modal-back")) {
      e.stopPropagation();
      if (search.value) { search.value = ""; renderNav(); } else close();
    }
  });
  search.addEventListener("input", () => renderNav());
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { const first = nav.querySelector("button"); first?.click(); }
  });

  let page = "wifi";
  function renderNav() {
    const q = search.value.trim().toLowerCase();
    nav.replaceChildren(...PAGES.filter((p) => p === "-" ? !q : !q || `${p.title} ${p.keywords}`.toLowerCase().includes(q)).map((p) => {
      if (p === "-") return el("div", "sep");
      const b = button(p.id === page ? "cur" : "", { icon: p.icon, label: p.title, onClick: () => { page = p.id; renderNav(); render(); } });
      return b;
    }));
  }

  function open(id) {
    if (id && pageById(id)) page = id;
    if (win.hidden) {
      win.hidden = false;
      const w = win.offsetWidth, h = win.offsetHeight;
      win.style.left = `${Math.round((innerWidth - w) / 2)}px`;
      win.style.top = `${Math.round(32 + (innerHeight - 32 - h) / 2)}px`;
    }
    search.value = "";
    renderNav();
    render();
  }
  function close() {
    stopRecording();
    win.hidden = true;
  }

  // ---------------------------------------------------------------- building blocks
  const group = (heading, rows, { desc, box = true } = {}) => {
    const g = el("div", "st-group");
    if (heading) g.append(el("h3", "", heading));
    if (desc) g.append(el("div", "st-desc", desc));
    if (box) { const b = el("div", "st-box"); b.append(...rows.filter(Boolean)); g.append(b); }
    else g.append(...rows.filter(Boolean));
    return g;
  };
  const row = (label, control, { sub, onClick, iconHtml } = {}) => {
    const r = el("div", `st-row ${onClick ? "click" : ""}`);
    if (iconHtml) { const i = el("span", "app-ic"); i.innerHTML = iconHtml; r.append(i); }
    const l = el("div", "st-label");
    l.append(el("span", "", label));
    if (sub) l.append(el("small", "", sub));
    r.append(l);
    if (control) r.append(...[control].flat().filter(Boolean));
    if (onClick) r.addEventListener("click", (e) => { if (!e.target.closest("button, input, select")) onClick(); });
    return r;
  };
  const switchRow = (label, on, set, sub) => row(label, toggle(on, set), { sub });
  const select = (value, options, set) => {
    const s = el("select");
    for (const [v, label] of options) {
      const o = el("option", "", label);
      o.value = String(v);
      if (String(v) === String(value)) o.selected = true;
      s.append(o);
    }
    s.addEventListener("change", () => set(s.value));
    return s;
  };
  const pill = (label, onClick, cls = "") => button(`st-pill ${cls}`, { label, onClick });
  const textRow = (label, value, set, { placeholder = "", sub } = {}) => {
    const input = el("input", "entry");
    input.value = value ?? "";
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.addEventListener("change", () => set(input.value.trim()));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
    return row(label, input, { sub });
  };
  const unavailable = (what) => group(null, [el("div", "st-empty", what)]);

  // Displays: the display chosen on the page, and GNOME's "Keep Changes?"
  // for a change Ash puts back by itself unless it's kept.
  const displayPage = { selected: null, asking: false };
  async function keepOrRevert(pending) {
    if (displayPage.asking) return;
    displayPage.asking = true;
    const deadline = Date.now() + pending.secondsLeft * 1000;
    const left = () => Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const text = el("p", "");
    const tick = () => { text.textContent = `Settings changes will revert in ${left()} seconds.`; };
    tick();
    let timer = null;
    const answer = await dialog({
      title: "Keep Display Changes?",
      body: text,
      buttons: [{ label: "Revert Settings", value: "revert" }, { label: "Keep Changes", value: "keep", default: true }],
      onOpen: (box) => {
        timer = setInterval(() => {
          tick();
          // Ash puts it back by itself then.
          if (!left()) box.closest(".modal-back")?.dispatchEvent(new PointerEvent("pointerdown"));
        }, 250);
      },
    });
    clearInterval(timer);
    displayPage.asking = false;
    if (left() > 0) await call("display", answer === "keep" ? "keep" : "revert");
  }


  // ---------------------------------------------------------------- pages
  function render(force = false) {
    if (win.hidden) return;
    // Not while the user types in it: the next change will do.
    if (!force && body.contains(document.activeElement) && document.activeElement.matches("input:not([type=range]), select")) return;
    const p = pageById(page);
    title.textContent = p.title;
    const scroll = body.scrollTop;
    body.replaceChildren(...(BUILD[page]?.() ?? []));
    body.scrollTop = scroll;
  }

  const BUILD = {
    wifi() {
      const n = states.network;
      if (!n?.available) return [unavailable("NetworkManager isn't running.")];
      const out = [];
      if (n.wifi?.available) {
        const rows = [switchRow("Wi-Fi", n.wifi.enabled, (on) => call("network", "set-wifi", { enabled: on }), n.wifi.hardwareEnabled ? undefined : "Turned off by a hardware switch")];
        out.push(group("Wi-Fi", rows));
        if (n.wifi.enabled) {
          const list = (n.accessPoints ?? []).map((ap) => {
            const actions = [];
            if (ap.active) {
              const c = n.connections.find((c) => c.ssid === ap.ssid && c.active);
              actions.push(pill("Disconnect", () => c && call("network", "disconnect", { id: c.id })));
            } else {
              actions.push(pill("Connect", async () => {
                if (ap.known || !ap.secured) return call("network", "connect", { ssid: ap.ssid });
                const password = await ask(`Connect to ${ap.ssid}`, { message: "Wi-Fi password", password: true, action: "Connect" });
                if (password !== null) call("network", "connect", { ssid: ap.ssid, password });
              }, ap.known ? "" : "suggested"));
            }
            if (ap.known) actions.push(pill("Forget", async () => { if (await confirm(`Forget ${ap.ssid}?`, "Its saved password goes too.", "Forget")) call("network", "forget", { ssid: ap.ssid }); }, "danger"));
            return row(ap.ssid, actions, {
              iconHtml: wifiIcon(ap.strength),
              sub: [ap.active ? "Connected" : ap.known ? "Saved" : "", ap.secured ? ap.security.toUpperCase() : "Open", `${ap.strength}%`, ap.frequency > 4000 ? "5 GHz" : ap.frequency ? "2.4 GHz" : ""].filter(Boolean).join(" · "),
            });
          });
          const g = group("Visible Networks", list.length ? list : [el("div", "st-empty", n.wifi.scanning ? "Scanning…" : "No networks")]);
          g.querySelector("h3").append(" ", button("st-pill", { label: n.wifi.scanning ? "Scanning…" : "Scan", onClick: () => call("network", "scan") }));
          out.push(g);
        }
      }
      const others = (n.connections ?? []).filter((c) => c.type !== "wifi");
      if (others.length) {
        out.push(group("Wired and VPN", others.map((c) => row(c.name, pill(c.active ? "Disconnect" : "Connect", () => call("network", c.active ? "disconnect" : "connect", { id: c.id })), {
          iconHtml: icon(c.type === "vpn" ? "vpn" : c.type === "ethernet" ? "wired" : "web"),
          sub: [c.type, c.active ? "connected" : c.state].filter(Boolean).join(" · "),
        }))));
      }
      const saved = (n.connections ?? []).filter((c) => c.type === "wifi" && !(n.accessPoints ?? []).some((a) => a.ssid === c.ssid));
      if (saved.length) {
        out.push(group("Saved Networks Out of Range", saved.map((c) => row(c.ssid ?? c.name, pill("Forget", () => call("network", "forget", { id: c.id }), "danger"), { iconHtml: icon("wifi") }))));
      }
      out.push(group("Status", [row("Connectivity", el("span", "", n.connectivity ?? "unknown"), { sub: n.primary ? `Through ${n.primary.name}` : "Offline" })]));
      return out;
    },
    bluetooth() {
      const bt = states.bluetooth;
      if (!bt?.available || !bt.adapter) return [unavailable("No Bluetooth adapter.")];
      const out = [group(null, [switchRow("Bluetooth", bt.adapter.powered, (on) => call("bluetooth", "set-powered", { powered: on }), `${bt.adapter.name} · ${bt.adapter.address}`)])];
      if (bt.adapter.powered) {
        const devices = (bt.devices ?? []).map((d) => {
          const actions = [];
          if (d.paired) actions.push(pill(d.connected ? "Disconnect" : "Connect", () => call("bluetooth", d.connected ? "disconnect" : "connect", { device: d.id })));
          else actions.push(pill(d.pairing ? "Pairing…" : "Pair", () => call("bluetooth", "pair", { device: d.id }), "suggested"));
          if (d.paired) actions.push(pill("Forget", async () => { if (await confirm(`Forget ${d.name}?`, "It will need pairing again.", "Forget")) call("bluetooth", "forget", { device: d.id }); }, "danger"));
          return row(d.name, actions, {
            iconHtml: icon("bluetooth"),
            sub: [d.connected ? "Connected" : d.paired ? "Paired" : "Not set up", d.battery != null ? `Battery ${d.battery}%` : ""].filter(Boolean).join(" · "),
          });
        });
        const g = group("Devices", devices.length ? devices : [el("div", "st-empty", "No devices")]);
        g.querySelector("h3").append(" ", button("st-pill", { label: bt.adapter.discovering ? "Searching…" : "Find Devices", onClick: () => call("bluetooth", "discover", { on: !bt.adapter.discovering }) }));
        out.push(g);
      }
      return out;
    },
    displays() {
      const d = states.display;
      if (!d?.available) return [unavailable("The display service isn't available.")];
      const all = d.displays ?? [];
      const shown = all.filter((x) => x.enabled && !x.mirrorOf);
      const current = all.find((x) => x.id === displayPage.selected) ?? all.find((x) => x.primary) ?? all[0];
      if (!current) return [unavailable("No displays.")];
      displayPage.selected = current.id;
      const out = [];
      // A change Ash puts back unless kept: GNOME's "Keep Changes?".
      const change = async (args) => {
        const result = await call("display", args.action ?? "configure", { ...args, action: undefined, confirm: true });
        if (result?.pending) keepOrRevert(result.pending);
      };
      if (all.length > 1) {
        // The arrangement: drag a display; click one to choose it below.
        const box = el("div", "st-arrange");
        const place = () => {
          const minX = Math.min(...shown.map((x) => x.bounds.x)), minY = Math.min(...shown.map((x) => x.bounds.y));
          const maxX = Math.max(...shown.map((x) => x.bounds.x + x.bounds.width)), maxY = Math.max(...shown.map((x) => x.bounds.y + x.bounds.height));
          const w = box.clientWidth || 600, h = box.clientHeight || 180;
          const scale = Math.min((w - 40) / (maxX - minX), (h - 30) / (maxY - minY));
          return { scale, ox: (w - (maxX - minX) * scale) / 2 - minX * scale, oy: (h - (maxY - minY) * scale) / 2 - minY * scale };
        };
        const draw = () => {
          const { scale, ox, oy } = place();
          box.replaceChildren(...shown.map((x) => {
            const m = el("div", `st-monitor ${x.id === current.id ? "cur" : ""}`);
            m.style.cssText = `left:${ox + x.bounds.x * scale + 1}px;top:${oy + x.bounds.y * scale + 1}px;width:${x.bounds.width * scale - 2}px;height:${x.bounds.height * scale - 2}px`;
            m.append(el("b", "", String(x.index || "")), el("span", "", x.name));
            m.addEventListener("pointerdown", (e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              m.setPointerCapture(e.pointerId);
              const start = { x: e.clientX, y: e.clientY, left: m.offsetLeft, top: m.offsetTop };
              let moved = false;
              const move = (ev) => {
                const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
                if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
                moved = true;
                m.classList.add("drag");
                m.style.left = `${start.left + dx}px`;
                m.style.top = `${start.top + dy}px`;
              };
              const up = (ev) => {
                m.removeEventListener("pointermove", move);
                m.removeEventListener("pointerup", up);
                if (!moved) { displayPage.selected = x.id; render(); return; }
                const dx = (ev.clientX - start.x) / scale, dy = (ev.clientY - start.y) / scale;
                displayPage.selected = x.id;
                // Ash puts it against the nearest edge of another display.
                void call("display", "arrange", { layout: [{ display: x.id, x: Math.round(x.bounds.x + dx), y: Math.round(x.bounds.y + dy) }] });
              };
              m.addEventListener("pointermove", move);
              m.addEventListener("pointerup", up);
            });
            return m;
          }));
        };
        requestAnimationFrame(draw);
        draw();
        out.push(group(null, [
          ...(d.mirror ? [] : [box]),
          row("Display Mode", select(d.mirror ? "mirror" : "join", [["join", "Join Displays"], ["mirror", "Mirror"]], (v) => change({ action: "set-mirror", on: v === "mirror" })), { sub: d.mirror ? "Every display shows the same picture" : "Drag the displays to match your setup" }),
          d.mirror ? null : row("Primary Display", select(all.find((x) => x.primary)?.id, shown.map((x) => [x.id, `${x.index}  ${x.name}`]), (id) => call("display", "configure", { display: id, primary: true }))),
          row("More Arrangement Options", pill("Open the Display Tool", () => { close(); call("display", "open-settings", { page: "displays" }); }), { sub: "The switcher's Displays page, with the keyboard too" }),
        ]));
        if (!d.mirror) {
          out.push(group(null, [el("div", "st-choice")], { box: false }));
          const tabs = out.at(-1).firstChild;
          tabs.style.cssText = "display:flex;gap:8px;padding:0;flex-wrap:wrap";
          for (const x of all) tabs.append(pill(`${x.index || ""}  ${x.name}${x.enabled ? "" : " (off)"}`, () => { displayPage.selected = x.id; render(); }, x.id === current.id ? "suggested" : ""));
        }
      }
      const rows = [];
      if (current.internal && (d.canTurnOffPanel || !current.enabled) && all.length > 1) {
        rows.push(switchRow("Use This Display", current.enabled, (on) => (on ? call("display", "configure", { display: current.id, enabled: true }) : change({ display: current.id, enabled: false })), "Turning it off is like closing the lid"));
      }
      if (current.enabled && !current.mirrorOf) {
        rows.push(row("Orientation", select(current.rotation, [[0, "Landscape"], [90, "Portrait Right"], [270, "Portrait Left"], [180, "Landscape (Flipped)"]], (v) => change({ display: current.id, rotation: Number(v) }))));
        const sizes = [];
        for (const m of current.modes ?? []) if (!sizes.some((s) => s.width === m.width && s.height === m.height)) sizes.push(m);
        sizes.sort((a, b) => b.width * b.height - a.width * a.height);
        const ratio = (w, h) => { const g = (a, b) => (b ? g(b, a % b) : a); const k = g(w, h); const r = `${w / k}:${h / k}`; return { "8:5": "16:10", "64:27": "21:9", "43:18": "21:9" }[r] ?? r; };
        const mode = current.mode ?? sizes[0];
        if (sizes.length) {
          rows.push(row("Resolution", select(`${mode.width}x${mode.height}`, sizes.map((m) => [`${m.width}x${m.height}`, `${m.width} × ${m.height} (${ratio(m.width, m.height)})`]), (v) => {
            const [width, height] = v.split("x").map(Number);
            return change({ display: current.id, mode: { width, height, refreshRate: mode.refreshRate } });
          })));
          const rates = [...new Set((current.modes ?? []).filter((m) => m.width === mode.width && m.height === mode.height).map((m) => m.refreshRate))].sort((a, b) => b - a);
          if (rates.length > 1) {
            rows.push(row("Refresh Rate", select(mode.refreshRate, rates.map((r) => [r, `${r.toFixed(2)} Hz`]), (v) => change({ display: current.id, mode: { width: mode.width, height: mode.height, refreshRate: Number(v) } }))));
          }
        }
        if ((current.zooms ?? []).length > 1) {
          const near = current.zooms.reduce((a, b) => (Math.abs(b - current.zoom) < Math.abs(a - current.zoom) ? b : a));
          rows.push(row("Scale", select(near, current.zooms.map((z) => [z, `${Math.round(z * 100)} %`]), (v) => change({ display: current.id, zoom: Number(v) })), { sub: `Effective scale ${current.scale}` }));
        }
      }
      out.push(group(`${current.index ? `${current.index}  ` : ""}${current.name}`, rows.length ? rows : [el("div", "st-empty", current.mirrorOf ? "It mirrors another display." : "This display is off.")]));
      return out;
    },
    sound() {
      const a = states.audio;
      if (!a?.available) return [unavailable("PipeWire isn't running.")];
      const devices = (list, kind) => (list ?? []).map((d) => row(d.name, [
        button("round", { icon: d.muted ? (kind === "output" ? "volume-muted" : "mic-muted") : kind === "output" ? "volume" : "mic", title: d.muted ? "Unmute" : "Mute", onClick: () => call("audio", "set-mute", { device: d.id }) }),
        slider(Math.min(1.5, d.volume), 1.5, (v) => sys.audio.call("set-volume", { device: d.id, volume: v })),
        d.default ? el("span", "st-check", "") : pill("Use", () => call("audio", "set-default", { device: d.id })),
      ].map((x) => { if (x.classList?.contains("st-check")) x.innerHTML = icon("check"); return x; }), { sub: `${Math.round(d.volume * 100)}%${d.default ? " · default" : ""}` }));
      return [
        group("Output", devices(a.outputs, "output").length ? devices(a.outputs, "output") : [el("div", "st-empty", "No outputs")], { desc: "Above 100% the sound is amplified and may distort." }),
        group("Input", devices(a.inputs, "input").length ? devices(a.inputs, "input") : [el("div", "st-empty", "No inputs")]),
      ];
    },
    power() {
      const p = states.power;
      if (!p) return [unavailable("The power service isn't available.")];
      const out = [];
      const b = p.battery;
      if (b) {
        const big = el("div", "st-big");
        big.innerHTML = batteryIcon(b.percent / 100, b.charging);
        big.append(el("h2", "", `${Math.round(b.percent)}%`), el("span", "", [b.state, b.timeLeft ? `${duration(b.timeLeft)} ${b.charging ? "until full" : "left"}` : ""].filter(Boolean).join(" · ")));
        out.push(group("Battery", [big, switchRow("Show Battery Percentage", !!ctx.prefs.batteryPercent, (on) => ctx.setPref("batteryPercent", on))]));
      } else out.push(group("Power", [row("Power source", el("span", "", p.ac ? "AC" : "Unknown"))]));
      if (p.brightness?.available) out.push(group("Screen", [row("Brightness", slider(p.brightness.value, 1, (v) => sys.power.call("set-brightness", { brightness: Math.max(0.02, v) })))]));
      const can = p.can ?? {};
      const ok = (v) => v === undefined || v === "yes" || v === "challenge";
      out.push(group("Power Buttons", [
        row("Suspend", pill("Suspend", () => call("power", "suspend")), { sub: can.suspend && !ok(can.suspend) ? "Not allowed" : undefined }),
        row("Restart", pill("Restart…", async () => { if (await confirm("Restart", "Restart the computer? Apps that are open will close.", "Restart")) call("power", "reboot"); })),
        row("Power Off", pill("Power Off…", async () => { if (await confirm("Power Off", "Power off the computer? Apps that are open will close.", "Power Off")) call("power", "power-off"); }, "danger")),
        row("Log Out", pill("Log Out…", async () => { if (await confirm("Log Out", "End the Plutonium session? Apps that are open will close.", "Log Out")) call("power", "log-out"); }), { sub: "Ends this Plutonium session" }),
      ]));
      return out;
    },
    privacy() {
      const s = states.session;
      if (!s) return [unavailable("The session service isn't available.")];
      const times = [[0, "Never"], [60, "1 minute"], [120, "2 minutes"], [180, "3 minutes"], [300, "5 minutes"], [600, "10 minutes"], [900, "15 minutes"], [1800, "30 minutes"], [3600, "1 hour"]];
      const set = (key) => (v) => call("session", "set-idle", { lockAfter: s.lockAfter, screenOffAfter: s.screenOffAfter, [key]: Number(v) });
      const out = [
        group("Screen Lock", [
          row("Blank Screen Delay", select(s.screenOffAfter, times, set("screenOffAfter")), { sub: "Turn the screen off after this long idle" }),
          row("Automatic Screen Lock", select(s.lockAfter, times, set("lockAfter")), { sub: "Lock after this long idle" }),
          row("Lock Now", pill("Lock", () => call("session", "lock")), { sub: s.canLock === false ? s.problem ?? "Locking isn't available" : undefined }),
        ]),
      ];
      const inh = s.inhibitors ?? [];
      out.push(group("Keeping the Screen On", inh.length ? inh.map((i) => row(i.who || "An app", null, { sub: i.why })) : [el("div", "st-empty", "Nothing is keeping the screen on.")], { desc: "Apps playing video, calls, and Keep Awake in the quick settings." }));
      return out;
    },
    appearance() {
      const P = ctx.prefs;
      const walls = el("div", "st-walls");
      for (const [name, css] of Object.entries(ctx.WALLPAPERS)) {
        const w = button(`st-wall ${P.wallpaper === name ? "cur" : ""}`, { title: name, onClick: () => { ctx.setPref("wallpaper", name); render(); } });
        w.style.background = css;
        w.style.backgroundSize = "cover";
        walls.append(w);
      }
      if (P.wallpaperUrl) {
        const w = button(`st-wall ${P.wallpaper === "custom" ? "cur" : ""}`, { title: "Your picture", onClick: () => { ctx.setPref("wallpaper", "custom"); render(); } });
        w.style.backgroundImage = `url("${P.wallpaperUrl}")`;
        walls.append(w);
      }
      const accents = el("div", "st-accents");
      for (const [name, color] of Object.entries(ctx.ACCENTS)) {
        const a = button(`st-accent ${P.accent === name ? "cur" : ""}`, { title: name, onClick: () => { ctx.setPref("accent", name); render(); } });
        a.style.background = color;
        accents.append(a);
      }
      const dock = el("div", "st-choice");
      const pic = (bars) => { const p = el("div", "pic"); for (const [l, t, w, h] of bars) { const i = el("i"); Object.assign(i.style, { left: `${l}%`, top: `${t}%`, width: `${w}%`, height: `${h}%` }); p.append(i); } return p; };
      for (const [v, label, bars] of [
        ["overview", "In the Overview", [[10, 10, 80, 60]]],
        ["always", "Always Shown", [[10, 8, 80, 62], [30, 80, 40, 12]]],
        ["auto", "Shown at the Bottom Edge", [[10, 8, 80, 80], [30, 92, 40, 6]]],
      ]) {
        const b = button(P.dock === v ? "cur" : "", { onClick: () => { ctx.setPref("dock", v); render(); } });
        b.append(pic(bars), el("span", "", label));
        dock.append(b);
      }
      return [
        group("Background", [walls, textRow("Picture Address", P.wallpaperUrl, (v) => { ctx.setPref("wallpaperUrl", v); if (v) ctx.setPref("wallpaper", "custom"); render(); }, { placeholder: "https://… or data:", sub: "An image on the web for the background" })]),
        group("Accent Color", [row("Color", accents)]),
        group("Dash", [dock, row("Icon Size", slider(P.dockIconSize, 64, (v) => ctx.setPref("dockIconSize", Math.max(32, Math.round(v))), { step: 4 }), { sub: `${P.dockIconSize} px` })], { desc: "The dash holds your pinned apps and the running ones." }),
        group("Windows", [
          row("Title Bar Buttons", select(P.titlebarButtons, [["close", "Close"], ["all", "Minimize, Maximize, Close"]], (v) => ctx.setPref("titlebarButtons", v))),
          row("Apps Without Title Bars", el("span", "", String(Object.keys(P.noTitle ?? {}).length || "None")), { sub: "Turn a window's title bar off in its menu (right-click the title bar)" }),
        ]),
      ];
    },
    multitasking() {
      const P = ctx.prefs;
      const wsRows = ctx.workspaces().map((w) => row(w.label, [
        el("span", "", `${w.count} window${w.count === 1 ? "" : "s"}`),
        pill("Rename…", async () => {
          const name = await ask("Rename Workspace", { value: w.name, placeholder: w.label, message: "Its thread takes the same name.", action: "Rename" });
          if (name !== null) { ctx.renameWorkspace(w.id, name.trim()); render(); }
        }),
      ], { sub: `Thread gnome:workspace/${w.id}` }));
      return [
        group("General", [
          switchRow("Hot Corner", P.hotCorner, (on) => ctx.setPref("hotCorner", on), "Touch the top-left corner to open the overview"),
          switchRow("Active Screen Edges", P.edgeTiling, (on) => ctx.setPref("edgeTiling", on), "Drag windows to the top, sides or corners to maximize or tile them"),
          switchRow("Super Opens the Overview", P.overlayKey, (on) => ctx.setPref("overlayKey", on), "Tap Super alone. Off: apps get Super combinations the shell doesn't use"),
        ]),
        group("Workspaces", [
          row("Workspaces", select(P.dynamicWorkspaces ? "dynamic" : "fixed", [["dynamic", "Dynamic"], ["fixed", "Fixed Number"]], (v) => { ctx.setPref("dynamicWorkspaces", v === "dynamic"); render(); }), { sub: "Dynamic: empty workspaces go away, and there's always one free" }),
          P.dynamicWorkspaces ? null : row("Number of Workspaces", select(P.fixedWorkspaces, [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [n, String(n)]), (v) => ctx.setPref("fixedWorkspaces", Number(v)))),
        ], { desc: "Each workspace is a thread: apps, tabs and agents started in it belong to it, and an agent there sees its windows." }),
        group("Your Workspaces", wsRows),
        group("App Switching", [
          row("Alt+Tab Includes", select(P.switcherCurrentWorkspace ? "current" : "all", [["all", "Apps From All Workspaces"], ["current", "Apps From the Current Workspace"]], (v) => ctx.setPref("switcherCurrentWorkspace", v === "current"))),
        ]),
      ];
    },
    keyboard() {
      const out = [];
      const groups = new Map();
      for (const a of ctx.ACTIONS) {
        if (!groups.has(a.group)) groups.set(a.group, []);
        groups.get(a.group).push(a);
      }
      const q = kbFilter.toLowerCase();
      const filter = el("input", "entry");
      filter.placeholder = "Search shortcuts";
      filter.value = kbFilter;
      filter.addEventListener("input", () => { kbFilter = filter.value; const pos = filter.selectionStart; render(true); const f = body.querySelector(".entry"); f?.focus(); f?.setSelectionRange(pos, pos); });
      out.push(group(null, [filter], { box: false, desc: "Click a shortcut to set new keys. Backspace removes it, Escape cancels." }));
      out.push(group("Overview", [switchRow("Super Opens the Overview", ctx.prefs.overlayKey, (on) => ctx.setPref("overlayKey", on), "Tap Super on its own")]));
      for (const [name, list] of groups) {
        const rows = list.filter((a) => !q || a.label.toLowerCase().includes(q) || ctx.keysOf(a).join(" ").toLowerCase().includes(q)).map((a) => shortcutRow(a));
        if (rows.length) out.push(group(name, rows));
      }
      // Custom shortcuts: a command for a key.
      const custom = (ctx.prefs.custom ?? []).map((c, i) => row(c.name, [
        keycaps([c.combo].filter(Boolean)),
        pill("Edit", () => editCustom(i)),
        pill("Remove", () => { const list = [...ctx.prefs.custom]; list.splice(i, 1); ctx.setPref("custom", list); render(); }, "danger"),
      ], { sub: c.command }));
      const g = group("Custom Shortcuts", custom.length ? custom : [el("div", "st-empty", "None yet")], { desc: "Run a command with a key. It starts in the current workspace's thread." });
      g.querySelector("h3").append(" ", button("st-pill", { label: "Add…", onClick: () => editCustom(-1) }));
      out.push(g);
      out.push(group(null, [row("Reset All Shortcuts", pill("Reset All", async () => { if (await confirm("Reset All Shortcuts?", "Every shortcut goes back to its default.", "Reset")) { ctx.setPref("keys", {}); render(); } }, "danger"))]));
      out.push(group("Taken by Plutonium", [
        row("Switch shells, windows and tabs", keycaps(["Super+Tab"])),
        row("Lock the screen", keycaps(["Super+KeyL"])),
        row("Fullscreen", keycaps(["Super+KeyF"])),
        row("Release the pointer", keycaps(["Super+Escape"])),
        row("Focus or move to another display", keycaps(["Super+Shift+ArrowLeft", "Super+Ctrl+Shift+ArrowLeft"])),
      ], { desc: "These are the browser's, whatever shell runs." }));
      return out;
    },
    apps() {
      const P = ctx.prefs;
      const fav = ctx.favorites();
      const rows = fav.map((id, i) => {
        const app = ctx.appById(id);
        const ic = el("span", "app-ic");
        ic.append(ctx.appIconEl(app ?? { name: id }));
        const r = row(app?.name ?? id, [
          button("round", { icon: "back", title: "Move up", onClick: () => { if (i) { const l = [...fav]; [l[i - 1], l[i]] = [l[i], l[i - 1]]; ctx.setFavorites(l); render(); } } }),
          button("round", { icon: "forward", title: "Move down", onClick: () => { if (i < fav.length - 1) { const l = [...fav]; [l[i + 1], l[i]] = [l[i], l[i + 1]]; ctx.setFavorites(l); render(); } } }),
          pill("Unpin", () => { ctx.setFavorites(fav.filter((f) => f !== id)); render(); }, "danger"),
        ], { sub: `Super+${i + 1}` });
        r.prepend(ic);
        return r;
      });
      const add = el("select");
      add.append(el("option", "", "Pin an app…"));
      for (const app of [ctx.appById("plutonium:web"), ctx.appById("plutonium:agent"), ...ctx.apps()].filter((a) => a && !fav.includes(a.id))) {
        const o = el("option", "", app.name);
        o.value = app.id;
        add.append(o);
      }
      add.addEventListener("change", () => { if (add.value) { ctx.setFavorites([...fav, add.value]); render(); } });
      return [
        group("Pinned Apps", [...(rows.length ? rows : [el("div", "st-empty", "Nothing pinned")]), row("Add", add)], { desc: "Pin apps from the app grid or the dash with a right-click, or drag them onto the dash." }),
        group("Default Apps", [
          textRow("Terminal", P.terminal, (v) => ctx.setPref("terminal", v || "foot"), { placeholder: "foot", sub: "The command for Super+Enter (it must take -T and -e for Claude Code)" }),
          textRow("Home Page", P.homepage, (v) => ctx.setPref("homepage", v), { placeholder: "https://duckduckgo.com/", sub: "What a new browser tab opens" }),
        ]),
      ];
    },
    notifications() {
      const n = states.notifications;
      if (!n) return [unavailable("The notification service isn't available.")];
      const P = ctx.prefs;
      const apps = new Map();
      for (const x of n.notifications ?? []) apps.set(x.app, (apps.get(x.app) ?? 0) + 1);
      return [
        group(null, [
          switchRow("Do Not Disturb", n.doNotDisturb, (on) => call("notifications", "set-do-not-disturb", { on }), "Only critical notifications pop up"),
          switchRow("Banners", P.banners !== false, (on) => ctx.setPref("banners", on), "Show new notifications at the top of the screen"),
        ]),
        group("Notifications Now", [...[...apps].map(([app, count]) => row(app || "Unknown", el("span", "", String(count)))), row("Clear All", pill("Clear", () => call("notifications", "clear"), "danger"))]),
      ];
    },
    datetime() {
      const P = ctx.prefs;
      return [
        group("Clock", [
          row("Time Format", select(P.clock24 === null ? "auto" : P.clock24 ? "24" : "12", [["auto", "Automatic"], ["24", "24-hour"], ["12", "AM / PM"]], (v) => ctx.setPref("clock24", v === "auto" ? null : v === "24"))),
          switchRow("Weekday", P.clockWeekday !== false, (on) => ctx.setPref("clockWeekday", on)),
          switchRow("Date", P.clockDate !== false, (on) => ctx.setPref("clockDate", on)),
          switchRow("Seconds", !!P.clockSeconds, (on) => ctx.setPref("clockSeconds", on)),
        ]),
        group("Calendar", [switchRow("Week Starts on Sunday", !!P.weekStartsSunday, (on) => ctx.setPref("weekStartsSunday", on))]),
        group(null, [row("Time Zone", el("span", "", Intl.DateTimeFormat().resolvedOptions().timeZone), { sub: "The computer's" })]),
      ];
    },
    about() {
      const big = el("div", "st-big");
      big.innerHTML = icon("display");
      big.append(el("h2", "", "Plutonium"), el("span", "", "Charon, a Plutonium shell · version 4"));
      const rows = [
        row("Helper", el("span", "", ctx.helper)),
        row("Shell", el("span", "", location.origin)),
        row("Displays", el("span", "", String(shell?.displays?.length || 1)), { sub: (shell?.displays ?? []).map((d) => `${d.label || `Display ${d.index}`}: ${d.width}×${d.height} @${d.scaleFactor}`).join(" · ") }),
        row("Browser Tabs", el("span", "", shell?.tabsAvailable ? "Yes" : "No")),
        row("Screen Capture", el("span", "", shell?.captureAvailable ? "Yes" : "No")),
      ];
      const services = row("Desktop Services", el("span", "", "…"));
      sys?.available().then((list) => { services.lastChild.textContent = list.filter((s) => s.allowed).map((s) => s.name).join(", "); }).catch(() => {});
      return [group(null, [big], { box: false }), group("System", [...rows, services])];
    },
  };

  // ---------------------------------------------------------------- shortcuts
  let kbFilter = "";
  let recording = null; // { id }
  const KEYNAMES = { Super: "Super", Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Semicolon: ";", Quote: "'", PrintScreen: "Print", PageUp: "Page Up", PageDown: "Page Down", Escape: "Esc" };
  const pretty = (combo) => combo.split("+").map((p) => KEYNAMES[p] ?? p.replace(/^Key/, "").replace(/^Digit/, "")).join(" + ");
  function keycaps(combos, cls = "") {
    const box = el("span", "st-keys");
    if (!combos.length) box.append(el("span", "kbd none", "Disabled"));
    for (const c of combos) box.append(el("span", `kbd ${cls}`, pretty(c)));
    return box;
  }
  function shortcutRow(a) {
    const keys = ctx.keysOf(a);
    const changed = ctx.prefs.keys?.[a.id] !== undefined;
    const isRec = recording?.id === a.id;
    const caps = isRec ? (() => { const b = el("span", "st-keys"); b.append(el("span", "kbd rec", "Press keys…")); return b; })() : keycaps(keys, changed ? "changed" : "");
    const controls = [caps];
    if (changed && !isRec) controls.push(button("round", { icon: "reload", title: "Reset to default", onClick: () => { const k = { ...ctx.prefs.keys }; delete k[a.id]; ctx.setPref("keys", k); render(); } }));
    return row(a.label, controls, { onClick: () => startRecording(a), sub: changed ? `Default: ${a.defaults.map(pretty).join(", ") || "none"}` : undefined });
  }
  function startRecording(a) {
    recording = { id: a.id };
    render(true);
    // The keys come to the page while it has the keyboard.
    win.focus();
    ctx.record((combo) => {
      stopRecording();
      if (combo === null) { render(); return; }
      if (combo === "") { ctx.setPref("keys", { ...ctx.prefs.keys, [a.id]: [] }); render(); return; }
      const norm = ctx.normalizeCombo(combo);
      // A combo another action had moves here.
      const keys = { ...ctx.prefs.keys };
      const clash = ctx.ACTIONS.find((b) => b.id !== a.id && ctx.keysOf(b).includes(norm));
      if (clash) keys[clash.id] = ctx.keysOf(clash).filter((k) => k !== norm);
      keys[a.id] = [norm];
      ctx.setPref("keys", keys);
      if (clash) ctx.toast(`${pretty(norm)} was “${clash.label}”: that one has no key now`);
      render();
    });
  }
  function stopRecording() {
    if (!recording) return;
    recording = null;
    ctx.stopRecording();
  }
  async function editCustom(i) {
    const c = i >= 0 ? ctx.prefs.custom[i] : { name: "", command: "", combo: "" };
    const form = el("div", "modal-body");
    const name = el("input", "entry"); name.placeholder = "Name"; name.value = c.name;
    const command = el("input", "entry"); command.placeholder = "Command (run with sh -c)"; command.value = c.command; command.spellcheck = false;
    let combo = c.combo;
    const keyBtn = button("st-pill", { label: combo ? pretty(combo) : "Set Shortcut…" });
    keyBtn.addEventListener("click", () => {
      keyBtn.querySelector("span").textContent = "Press keys…";
      ctx.record((k) => {
        ctx.stopRecording();
        if (k) combo = ctx.normalizeCombo(k);
        keyBtn.querySelector("span").textContent = combo ? pretty(combo) : "Set Shortcut…";
      });
    });
    form.append(name, command, keyBtn);
    const ok = await dialog({ title: i >= 0 ? "Edit Custom Shortcut" : "Add Custom Shortcut", body: form, buttons: [{ label: "Cancel", value: false }, { label: i >= 0 ? "Save" : "Add", value: true, default: true }] });
    ctx.stopRecording();
    if (!ok || !name.value.trim() || !command.value.trim()) return;
    const list = [...(ctx.prefs.custom ?? [])];
    const entry = { name: name.value.trim(), command: command.value.trim(), combo };
    if (i >= 0) list[i] = entry; else list.push(entry);
    ctx.setPref("custom", list);
    render();
  }

  // ---------------------------------------------------------------- search (the overview's)
  function searchSettings(q) {
    const out = [];
    for (const p of PAGES) if (p !== "-" && `${p.title} ${p.keywords} settings`.toLowerCase().includes(q)) out.push({ page: p.id, title: p.title, icon: p.icon, detail: "Settings" });
    for (const a of ctx.ACTIONS) if (a.label.toLowerCase().includes(q)) out.push({ page: "keyboard", title: a.label, icon: "keyboard", detail: ctx.keysOf(a).map(pretty).join(", ") || "Keyboard Shortcuts" });
    return out;
  }

  return { open, close, isOpen: () => !win.hidden, search: searchSettings };
}

// GNOME's quick settings: the status icons at the right of the top bar and
// the menu they open: volume, microphone and brightness sliders, Wi-Fi,
// Bluetooth, Do Not Disturb, Keep Awake, Dark Style and Airplane Mode toggles, each with
// its submenu, and the battery, screenshot, display settings, settings, lock
// and power buttons.
// Everything is over the desktop services (shell.system.<name>).

import { icon, batteryIcon, wifiIcon, volumeIcon, duration } from "./icons.js";
import { el, button, slider, confirm } from "./ui.js";

/**
 * ctx: { shell, prefs, actions: { screenshot, settings(page), lock, logOutHint }, toast }
 * Returns { indicators (the bar's button), toggle(), close(), isOpen(), openSub(name) }.
 */
export function mountQuick(ctx) {
  const { shell } = ctx;
  const sys = shell?.system;
  const state = { audio: null, power: null, network: null, bluetooth: null, notifications: null, session: null, appearance: null };
  const services = ["audio", "power", "network", "bluetooth", "notifications", "session", "appearance"];

  // ---------------------------------------------------------------- the bar's icons
  const indicators = el("button", "pill-btn", undefined);
  indicators.id = "tray";
  indicators.title = "System";
  indicators.addEventListener("mousedown", (e) => e.preventDefault());

  function renderIndicators() {
    const parts = [];
    const n = state.network;
    if (n?.available) {
      const p = n.primary;
      if (p?.type === "wifi") parts.push(wifiIcon(p.strength ?? 100));
      else if (p?.type === "ethernet") parts.push(icon("wired"));
      else if (p) parts.push(icon("web"));
      else if (n.wifi?.available && !n.wifi.enabled) parts.push(icon("wifi-off"));
      else parts.push(icon("offline"));
      if (n.connections?.some((c) => c.type === "vpn" && c.active)) parts.push(icon("vpn"));
    }
    if (state.bluetooth?.adapter?.powered && state.bluetooth.devices?.some((d) => d.connected)) parts.push(icon("bluetooth"));
    if (state.notifications?.doNotDisturb) parts.push(icon("bell-off"));
    if (keepAwake()) parts.push(icon("coffee"));
    if (state.audio?.available) parts.push(volumeIcon(state.audio.volume, state.audio.muted));
    if (state.audio?.input && !state.audio.input.muted && micInUse()) parts.push(icon("mic"));
    const b = state.power?.battery;
    if (b) {
      parts.push(batteryIcon(b.percent / 100, b.charging));
      if (ctx.prefs.batteryPercent) parts.push(`<span class="pct">${Math.round(b.percent)}%</span>`);
    } else parts.push(icon("power"));
    indicators.innerHTML = parts.join("");
    const tips = [];
    if (state.network?.primary) tips.push(state.network.primary.name);
    if (b) tips.push(`Battery ${Math.round(b.percent)}%${b.timeLeft ? `, ${duration(b.timeLeft)} ${b.charging ? "until full" : "left"}` : ""}`);
    indicators.title = tips.join(" · ") || "System";
  }
  // The microphone indicator: GNOME shows it while an app records. (The
  // service doesn't say who records; a capture or call app is the hint.)
  const micInUse = () => false;
  const keepAwake = () => (state.session?.inhibitors ?? []).some((i) => i.why === KEEP_AWAKE && i.mine !== false) || awake;
  const KEEP_AWAKE = "Keep Awake (quick settings)";
  let awake = false;

  // ---------------------------------------------------------------- the menu
  const panel = el("div", "popover qs");
  panel.hidden = true;
  panel.id = "quick";
  document.body.append(panel);
  let sub = null; // the open submenu's name

  const call = async (service, action, args) => {
    try { return await sys[service].call(action, args); }
    catch (error) { ctx.toast(`${service}: ${error.message}`); return null; }
  };

  function sliderRow(iconName, value, max, set, { onIcon, arrow, label }) {
    const row = el("div", "qs-slider");
    const ib = button("qs-icon", { icon: null, title: label });
    ib.innerHTML = iconName;
    if (onIcon) ib.addEventListener("click", onIcon);
    const s = slider(value, max, set);
    row.append(ib, s);
    if (arrow) row.append(button("qs-arrow round", { icon: "chevron", title: "More", onClick: arrow }));
    return { row, slider: s };
  }

  function togglePill({ iconName, title, subtitle, active, onToggle, onMore, disabled }) {
    const pill = el("div", `qs-toggle ${active ? "active" : ""} ${onMore ? "has-more" : ""}`);
    const main = button("qs-main", { onClick: onToggle });
    main.innerHTML = `${iconName}<span class="qs-text"><b></b><small></small></span>`;
    main.querySelector("b").textContent = title;
    main.querySelector("small").textContent = subtitle ?? "";
    main.disabled = !!disabled;
    pill.append(main);
    if (onMore) pill.append(button("qs-more", { icon: "chevron", title: `${title} options`, onClick: onMore }));
    return pill;
  }

  function header(title, iconName, extra) {
    const h = el("div", "qs-sub-head");
    const back = button("qs-back round", { icon: "back", title: "Back", onClick: () => openSub(null) });
    const t = el("div", "qs-sub-title");
    t.innerHTML = `${iconName ?? ""}<span></span>`;
    t.querySelector("span").textContent = title;
    h.append(back, t);
    if (extra) h.append(extra);
    return h;
  }

  function row(iconHtml, label, { checked, detail, onClick, actions = [], disabled } = {}) {
    const r = el("div", "qs-row");
    const b = button("qs-row-main", { onClick });
    b.innerHTML = `${iconHtml ?? ""}<span class="qs-row-label"></span><small></small>${checked ? icon("check", "qs-check") : ""}`;
    b.querySelector(".qs-row-label").textContent = label;
    b.querySelector("small").textContent = detail ?? "";
    b.disabled = !!disabled;
    r.append(b, ...actions);
    return r;
  }

  function render() {
    if (panel.hidden) return;
    // Not while the user is using something in it: the next change will do.
    if (panel.querySelector("input:focus, input:active")) return;
    panel.replaceChildren(...(sub ? renderSub(sub) : renderMain()));
  }

  function renderMain() {
    const out = [];
    // The top row.
    const top = el("div", "qs-top");
    const b = state.power?.battery;
    if (b) {
      const pill = button("qs-battery", { onClick: () => { close(); ctx.actions.settings("power"); } });
      pill.innerHTML = `${batteryIcon(b.percent / 100, b.charging)}<span>${Math.round(b.percent)}%</span>`;
      if (b.timeLeft) pill.title = `${duration(b.timeLeft)} ${b.charging ? "until full" : "left"}`;
      top.append(pill);
    }
    top.append(el("span", "qs-spacer"));
    top.append(
      button("qs-round", { icon: "screenshot", title: "Take a Screenshot", onClick: () => { close(); setTimeout(() => ctx.actions.screenshot(), 200); } }),
      button("qs-round", { icon: "display", title: "Display Settings", onClick: () => { close(); ctx.actions.settings("displays"); } }),
      button("qs-round", { icon: "settings", title: "Settings", onClick: () => { close(); ctx.actions.settings(); } }),
      button("qs-round", { icon: "lock", title: "Lock", onClick: () => { close(); ctx.actions.lock(); } }),
      button("qs-round", { icon: "power", title: "Power Off / Log Out", onClick: () => openSub("power") }),
    );
    out.push(top);

    // Sliders.
    const a = state.audio;
    if (a?.available && a.output) {
      out.push(sliderRow(volumeIcon(a.volume, a.muted), a.muted ? 0 : Math.min(1, a.volume), 1,
        (v) => sys.audio.call("set-volume", { device: "output", volume: v }).then(() => (a.muted && v > 0 ? sys.audio.call("set-mute", { device: "output", muted: false }) : null)),
        { label: a.muted ? "Unmute" : "Mute", onIcon: () => call("audio", "set-mute", { device: "output" }), arrow: a.outputs?.length ? () => openSub("output") : null }).row);
    }
    if (a?.available && a.input) {
      out.push(sliderRow(icon(a.input.muted ? "mic-muted" : "mic"), a.input.muted ? 0 : Math.min(1, a.input.volume), 1,
        (v) => sys.audio.call("set-volume", { device: "input", volume: v }),
        { label: a.input.muted ? "Unmute the microphone" : "Mute the microphone", onIcon: () => call("audio", "set-mute", { device: "input" }), arrow: a.inputs?.length > 1 ? () => openSub("input") : null }).row);
    }
    const br = state.power?.brightness;
    if (br?.available) {
      out.push(sliderRow(icon("brightness"), br.value, 1, (v) => sys.power.call("set-brightness", { brightness: Math.max(0.02, v) }), { label: "Brightness" }).row);
    }

    // Toggles.
    const grid = el("div", "qs-grid");
    const n = state.network;
    if (n?.available && n.wifi?.available) {
      const ap = n.accessPoints?.find((p) => p.active);
      grid.append(togglePill({
        iconName: n.wifi.enabled ? wifiIcon(ap?.strength ?? 100) : icon("wifi-off"),
        title: "Wi-Fi",
        subtitle: !n.wifi.enabled ? "Off" : ap?.ssid ?? (n.state === "connecting" ? "Connecting…" : "Not connected"),
        active: n.wifi.enabled,
        disabled: !n.wifi.hardwareEnabled,
        onToggle: () => call("network", "set-wifi", { enabled: !n.wifi.enabled }),
        onMore: () => openSub("wifi"),
      }));
    }
    const wired = n?.connections?.filter((c) => c.type === "ethernet") ?? [];
    if (n?.available && wired.length) {
      const on = wired.find((c) => c.active);
      grid.append(togglePill({
        iconName: icon("wired"), title: "Wired", subtitle: on ? on.name : "Disconnected", active: !!on,
        onToggle: () => (on ? call("network", "disconnect", { id: on.id }) : call("network", "connect", { id: wired[0].id })),
        onMore: wired.length > 1 || n.connections.some((c) => c.type === "vpn") ? () => openSub("wired") : null,
      }));
    }
    const vpns = n?.connections?.filter((c) => c.type === "vpn") ?? [];
    if (vpns.length) {
      const on = vpns.find((c) => c.active);
      grid.append(togglePill({
        iconName: icon("vpn"), title: "VPN", subtitle: on ? on.name : vpns.length === 1 ? vpns[0].name : "Off", active: !!on,
        onToggle: () => (on ? call("network", "disconnect", { id: on.id }) : call("network", "connect", { id: vpns[0].id })),
        onMore: vpns.length > 1 ? () => openSub("wired") : null,
      }));
    }
    const bt = state.bluetooth;
    if (bt?.available && bt.adapter) {
      const connected = bt.devices?.filter((d) => d.connected) ?? [];
      grid.append(togglePill({
        iconName: icon(bt.adapter.powered ? "bluetooth" : "bluetooth-off"),
        title: "Bluetooth",
        subtitle: !bt.adapter.powered ? "Off" : connected.length === 1 ? connected[0].name : connected.length ? `${connected.length} Connected` : "On",
        active: bt.adapter.powered,
        onToggle: () => call("bluetooth", "set-powered", { powered: !bt.adapter.powered }),
        onMore: () => openSub("bluetooth"),
      }));
    }
    if (state.notifications) {
      const dnd = state.notifications.doNotDisturb;
      grid.append(togglePill({
        iconName: icon(dnd ? "bell-off" : "bell"), title: "Do Not Disturb", subtitle: dnd ? "On" : "Off", active: dnd,
        onToggle: () => call("notifications", "set-do-not-disturb", { on: !dnd }),
      }));
    }
    if (state.session) {
      const on = keepAwake();
      grid.append(togglePill({
        iconName: icon("coffee"), title: "Keep Awake", subtitle: on ? "Screen stays on" : "Off", active: on,
        onToggle: async () => {
          awake = !on;
          renderAll();
          await call("session", on ? "uninhibit" : "inhibit", on ? {} : { why: KEEP_AWAKE });
        },
      }));
    }
    if (state.appearance) {
      const dark = state.appearance.colorScheme === "dark";
      grid.append(togglePill({
        iconName: icon("appearance"), title: "Dark Style", subtitle: dark ? "On" : "Off", active: dark,
        onToggle: () => call("appearance", "set", { colorScheme: dark ? "light" : "dark" }),
      }));
    }
    const radios = (n?.wifi?.available ? 1 : 0) + (bt?.adapter ? 1 : 0);
    if (radios) {
      const airplane = (!n?.wifi?.available || !n.wifi.enabled) && (!bt?.adapter || !bt.adapter.powered);
      grid.append(togglePill({
        iconName: icon("airplane"), title: "Airplane Mode", subtitle: airplane ? "On" : "Off", active: airplane,
        onToggle: async () => {
          if (n?.wifi?.available) await call("network", "set-wifi", { enabled: airplane });
          if (bt?.adapter) await call("bluetooth", "set-powered", { powered: airplane });
        },
      }));
    }
    if (grid.children.length) out.push(grid);
    if (!shell) out.push(el("small", "qs-note", "Not connected to the helper."));
    return out;
  }

  function renderSub(name) {
    const out = [];
    const list = el("div", "qs-list");
    if (name === "output" || name === "input") {
      const a = state.audio;
      out.push(header(name === "output" ? "Sound Output" : "Sound Input", icon(name === "output" ? "volume" : "mic")));
      for (const d of (name === "output" ? a?.outputs : a?.inputs) ?? []) {
        list.append(row(null, d.name, { checked: d.default, detail: d.muted ? "muted" : `${Math.round(d.volume * 100)}%`, onClick: () => call("audio", "set-default", { device: d.id }) }));
      }
      out.push(list);
      out.push(footer("Sound Settings", "sound"));
    } else if (name === "wifi") {
      const n = state.network;
      const sw = toggleIn(n?.wifi?.enabled, (on) => call("network", "set-wifi", { enabled: on }));
      out.push(header("Wi-Fi", wifiIcon(100), sw));
      if (!n?.wifi?.enabled) list.append(el("div", "qs-empty", "Wi-Fi is off"));
      else {
        if (n.wifi.scanning) list.append(el("div", "qs-empty small", "Scanning…"));
        for (const ap of n.accessPoints ?? []) list.append(wifiRow(ap));
        if (!n.accessPoints?.length && !n.wifi.scanning) list.append(el("div", "qs-empty", "No networks"));
      }
      out.push(list);
      out.push(footer("All Networks", "wifi"));
    } else if (name === "wired") {
      const n = state.network;
      out.push(header("Connections", icon("wired")));
      for (const c of (n?.connections ?? []).filter((c) => c.type !== "wifi")) {
        list.append(row(icon(c.type === "vpn" ? "vpn" : "wired"), c.name, {
          checked: c.active, detail: c.type === "vpn" ? "VPN" : c.state ?? "",
          onClick: () => call("network", c.active ? "disconnect" : "connect", { id: c.id }),
        }));
      }
      out.push(list);
      out.push(footer("Network Settings", "wifi"));
    } else if (name === "bluetooth") {
      const bt = state.bluetooth;
      const sw = toggleIn(bt?.adapter?.powered, (on) => call("bluetooth", "set-powered", { powered: on }));
      out.push(header("Bluetooth", icon("bluetooth"), sw));
      if (!bt?.adapter?.powered) list.append(el("div", "qs-empty", "Bluetooth is off"));
      else {
        for (const d of bt.devices ?? []) {
          const detail = d.pairing ? "Pairing…" : d.connected ? (d.battery != null ? `Connected · ${d.battery}%` : "Connected") : d.paired ? "" : "Not set up";
          list.append(row(icon("bluetooth"), d.name, {
            checked: d.connected, detail,
            onClick: () => call("bluetooth", d.connected ? "disconnect" : d.paired ? "connect" : "pair", { device: d.id }),
          }));
        }
        if (!bt.devices?.length) list.append(el("div", "qs-empty", "No devices"));
        const find = button("qs-row-main wide", {
          icon: "search",
          label: bt.adapter.discovering ? "Searching for devices…" : "Find Devices",
          onClick: () => call("bluetooth", "discover", { on: !bt.adapter.discovering }),
        });
        list.append(find);
      }
      out.push(list);
      out.push(footer("Bluetooth Settings", "bluetooth"));
    } else if (name === "power") {
      const can = state.power?.can ?? {};
      const ok = (v) => v === undefined || v === "yes" || v === "challenge";
      out.push(header("Power Off", icon("power")));
      list.append(
        row(icon("suspend"), "Suspend", { disabled: !ok(can.suspend), onClick: async () => { close(); await call("power", "suspend"); } }),
        row(icon("reboot"), "Restart…", { disabled: !ok(can.reboot), onClick: async () => { close(); if (await confirm("Restart", "Restart the computer? Apps that are open will close.", "Restart")) call("power", "reboot"); } }),
        row(icon("power"), "Power Off…", { disabled: !ok(can.powerOff), onClick: async () => { close(); if (await confirm("Power Off", "Power off the computer? Apps that are open will close.", "Power Off")) call("power", "power-off"); } }),
        el("div", "menu-sep"),
        row(icon("lock"), "Lock", { onClick: () => { close(); ctx.actions.lock(); } }),
        row(icon("log-out"), "Log Out…", { onClick: async () => { close(); if (await confirm("Log Out", "End the Plutonium session? Apps that are open will close.", "Log Out")) call("power", "log-out"); } }),
      );
      out.push(list);
    }
    return out;
  }

  let passwordFor = null;
  function wifiRow(ap) {
    const wrap = el("div", "qs-wifi");
    const actions = [];
    if (ap.known && !ap.active) actions.push(button("qs-row-act round", { icon: "trash", title: `Forget ${ap.ssid}`, onClick: () => call("network", "forget", { ssid: ap.ssid }) }));
    const r = row(wifiIcon(ap.strength), ap.ssid, {
      checked: ap.active,
      detail: ap.secured ? "🔒" : "",
      actions,
      onClick: () => {
        if (ap.active) { const c = state.network.connections.find((c) => c.ssid === ap.ssid && c.active); if (c) call("network", "disconnect", { id: c.id }); return; }
        if (ap.known || !ap.secured) { call("network", "connect", { ssid: ap.ssid }); return; }
        passwordFor = passwordFor === ap.ssid ? null : ap.ssid;
        render();
        panel.querySelector(".qs-password input")?.focus();
      },
    });
    wrap.append(r);
    if (passwordFor === ap.ssid) {
      const form = el("form", "qs-password");
      const input = el("input", "entry");
      input.type = "password";
      input.placeholder = `Password for ${ap.ssid}`;
      const go = button("suggested", { label: "Connect" });
      go.type = "submit";
      form.append(input, go);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        passwordFor = null;
        call("network", "connect", { ssid: ap.ssid, password: input.value });
        input.blur();
        render();
      });
      input.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); passwordFor = null; input.blur(); render(); } });
      wrap.append(form);
    }
    return wrap;
  }

  function toggleIn(on, set) {
    const b = el("button", `switch ${on ? "on" : ""}`);
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => set(!on));
    return b;
  }

  function footer(label, page) {
    return button("qs-footer", { label, onClick: () => { close(); ctx.actions.settings(page); } });
  }

  function openSub(name) {
    sub = name;
    passwordFor = null;
    if (name === "wifi") call("network", "scan");
    if (panel.hidden) open(); else render();
  }

  function open() {
    ctx.onOpen?.();
    panel.hidden = false;
    indicators.classList.add("open");
    render();
    addEventListener("pointerdown", outside, true);
    addEventListener("keydown", escape, true);
  }
  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    sub = null;
    passwordFor = null;
    indicators.classList.remove("open");
    removeEventListener("pointerdown", outside, true);
    removeEventListener("keydown", escape, true);
    ctx.onClose?.();
  }
  const outside = (e) => {
    if (!panel.contains(e.target) && !indicators.contains(e.target) && !e.target.closest?.(".modal-back")) close();
  };
  const escape = (e) => {
    if (e.key !== "Escape" || e.target.closest?.(".modal-back")) return;
    e.preventDefault();
    e.stopPropagation();
    if (sub) openSub(null); else close();
  };
  const toggle = () => (panel.hidden ? open() : close());
  indicators.addEventListener("click", () => { sub = null; toggle(); });
  // Scrolling over the icons changes the volume, as on GNOME.
  indicators.addEventListener("wheel", (e) => {
    if (!state.audio?.available) return;
    e.preventDefault();
    call("audio", "step", { by: e.deltaY < 0 ? 0.05 : -0.05 });
  }, { passive: false });

  function renderAll() { renderIndicators(); render(); ctx.onState?.(state); }

  if (sys) {
    for (const name of services) {
      const service = sys[name];
      service.addEventListener("change", (event) => { state[name] = event.detail; renderAll(); });
      service.ready.then((s) => { state[name] = s; renderAll(); }, () => { state[name] = null; renderAll(); });
    }
  }
  renderIndicators();

  return { indicators, toggle, open, close, openSub, isOpen: () => !panel.hidden, state, refresh: renderAll };
}

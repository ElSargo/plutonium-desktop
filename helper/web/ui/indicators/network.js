// The network indicator (shell.system.network): Wi-Fi's signal, wired, or
// offline; click for Wi-Fi on/off, the networks in range (a password asked
// here for a new one), and the wired and VPN connections. A known network's
// changed password is asked by the library's prompt (the "systemrequest").
import { button, popover, refill, style, watch } from "../widgets.js";

const svg = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/** Wi-Fi's arcs, as many lit as the strength (0–100) says. */
export function wifiIcon(strength, off = false) {
  const lit = off ? 0 : strength >= 70 ? 3 : strength >= 45 ? 2 : strength >= 20 ? 1 : 0;
  const arc = (d, n) => `<path d="${d}" opacity="${n <= lit ? 1 : 0.3}"/>`;
  return svg(
    arc("M2.5 9a14 14 0 0 1 19 0", 3) +
      arc("M5.5 12.3a9.5 9.5 0 0 1 13 0", 2) +
      arc("M8.6 15.6a5 5 0 0 1 6.8 0", 1) +
      '<circle cx="12" cy="19" r="1.2" fill="currentColor" stroke="none"/>' +
      (off ? '<path d="M4 4l16 16"/>' : ""),
  );
}

const ICONS = {
  ethernet: svg('<rect x="4" y="4" width="16" height="12" rx="2"/><path d="M8 16v4h8v-4M8 8v3M12 8v3M16 8v3"/>'),
  vpn: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  offline: svg('<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.3a9.5 9.5 0 0 1 13 0M8.6 15.6a5 5 0 0 1 6.8 0" opacity=".3"/><path d="M4 4l16 16"/>'),
  lock: svg('<rect x="6" y="11" width="12" height="8" rx="1.5"/><path d="M9 11V8.5a3 3 0 0 1 6 0V11"/>'),
};

export default function network(shell, container) {
  style();
  const service = shell.system.network;
  const element = button("Network");
  container.append(element);
  let state = null;
  /** The network a password is being typed for, and the last error. */
  let asking = null;
  let typed = "";
  /** The saved network whose actions are shown. */
  let open = null;
  let error = "";

  const act = async (action, args) => {
    error = "";
    try {
      await service.call(action, args);
    } catch (e) {
      error = String(e?.message ?? e);
    }
    refill(element, fill);
  };

  const heading = (text, extra) => {
    const row = document.createElement("div");
    row.className = "row";
    const title = document.createElement("h3");
    title.textContent = text;
    title.style.flex = "1";
    row.append(title);
    if (extra) row.append(extra);
    return row;
  };

  const fill = (pop) => {
    if (!state?.available) {
      pop.append(Object.assign(document.createElement("div"), { className: "muted", textContent: "No NetworkManager." }));
      return;
    }
    const { wifi, accessPoints, connections } = state;
    if (wifi.available) {
      const toggle = document.createElement("button");
      toggle.className = "icon";
      toggle.textContent = wifi.enabled ? "On" : "Off";
      toggle.title = wifi.enabled ? "Turn Wi-Fi off" : "Turn Wi-Fi on";
      toggle.disabled = !wifi.hardwareEnabled;
      toggle.onclick = () => act("set-wifi", { enabled: !wifi.enabled });
      pop.append(heading(wifi.scanning ? "Wi-Fi · looking…" : "Wi-Fi", toggle));
      if (!wifi.hardwareEnabled) pop.append(Object.assign(document.createElement("div"), { className: "muted", textContent: "Turned off by a switch." }));
      if (wifi.enabled) {
        const list = document.createElement("div");
        list.style.cssText = "display: grid; max-height: 50vh; overflow-y: auto;";
        for (const ap of accessPoints) {
          const entry = document.createElement("button");
          entry.innerHTML = `${wifiIcon(ap.strength)}<span style="flex: 1; overflow: hidden; text-overflow: ellipsis"></span>${ap.secured ? ICONS.lock : ""}`;
          entry.querySelector("span").textContent = ap.ssid;
          entry.title = `${ap.ssid}: ${ap.strength}%${ap.known ? ", saved" : ""}${ap.active ? ", connected" : ""}`;
          if (ap.active) entry.classList.add("current");
          entry.onclick = () => {
            if (ap.known) {
              open = open === ap.ssid ? null : ap.ssid;
              refill(element, fill);
              return;
            }
            if (ap.secured && ap.security !== "enterprise") {
              asking = ap.ssid;
              typed = "";
              refill(element, fill);
              return;
            }
            void act("connect", { ssid: ap.ssid });
          };
          list.append(entry);
          if (asking === ap.ssid) list.append(passwordForm(ap));
          if (open === ap.ssid) {
            const row = document.createElement("div");
            row.className = "row";
            row.style.cssText = "justify-content: end; gap: 4px; margin: -2px 0 4px;";
            row.append(
              ap.active
                ? small("Disconnect", () => act("disconnect", { id: ap.id }))
                : small("Connect", () => act("connect", { ssid: ap.ssid })),
            );
            row.append(small("Forget", () => act("forget", { ssid: ap.ssid })));
            list.append(row);
          }
        }
        if (accessPoints.length === 0) list.append(Object.assign(document.createElement("div"), { className: "muted", textContent: "No networks found." }));
        pop.append(list);
      }
    }
    const others = connections.filter((connection) => connection.type === "ethernet" || connection.type === "vpn");
    if (others.length) {
      pop.append(heading("Connections"));
      for (const connection of others) {
        const entry = document.createElement("button");
        entry.innerHTML = `${ICONS[connection.type]}<span></span>`;
        entry.querySelector("span").textContent =
          connection.name + (connection.state === "activating" ? " · connecting…" : "");
        if (connection.active) entry.classList.add("current");
        entry.title = connection.active ? "Disconnect" : "Connect";
        entry.onclick = () => act(connection.active ? "disconnect" : "connect", { id: connection.id });
        pop.append(entry);
      }
    }
    if (error) pop.append(Object.assign(document.createElement("div"), { className: "error", textContent: error }));
  };

  const small = (label, onClick) => {
    const element = document.createElement("button");
    element.className = "icon";
    element.style.cssText = "font-size: 11px; padding: 2px 6px;";
    element.textContent = label;
    element.onclick = onClick;
    return element;
  };

  const passwordForm = (ap) => {
    const form = document.createElement("form");
    form.className = "row";
    const input = document.createElement("input");
    input.type = "password";
    input.placeholder = "Password";
    input.autocomplete = "off";
    input.style.cssText = "flex: 1; min-width: 0; font: inherit; padding: 4px 6px;";
    // The popover is filled again on every change (a scan's): what was typed stays.
    input.value = typed;
    input.oninput = () => (typed = input.value);
    const go = document.createElement("button");
    go.className = "icon";
    go.textContent = "Connect";
    form.append(input, go);
    form.onsubmit = (event) => {
      event.preventDefault();
      asking = null;
      typed = "";
      void act("connect", { ssid: ap.ssid, password: input.value });
    };
    queueMicrotask(() => input.focus());
    return form;
  };

  const render = (next) => {
    state = next;
    element.hidden = !state?.available;
    if (!state?.available) return;
    const primary = state.primary;
    const wifiActive = state.accessPoints.find((ap) => ap.active);
    if (primary?.type === "wifi" || (!primary && wifiActive)) {
      element.innerHTML = wifiIcon(primary?.strength ?? wifiActive?.strength ?? 0);
    } else if (primary?.type === "ethernet" || primary?.type === "vpn") {
      element.innerHTML = ICONS[primary.type];
    } else {
      element.innerHTML = state.wifi.available && !state.wifi.enabled ? wifiIcon(0, true) : ICONS.offline;
    }
    element.title =
      state.state === "connected" && primary
        ? `${primary.name}${primary.strength !== undefined ? ` (${primary.strength}%)` : ""}${state.connectivity !== "full" ? `, ${state.connectivity} connectivity` : ""}`
        : state.state === "connecting"
          ? "Connecting…"
          : "Offline";
    refill(element, fill);
  };

  element.addEventListener("click", () => {
    asking = null;
    open = null;
    error = "";
    if (popover(element, fill) && state?.wifi.enabled) service.call("scan").catch(() => {});
  });
  watch(service, render);
}

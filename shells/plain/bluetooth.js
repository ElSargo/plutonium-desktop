// The Bluetooth indicator (shell.system.bluetooth): on, off, or connected;
// click for on/off, the paired devices (connect, disconnect, forget) and,
// after "Find devices", the ones nearby to pair. A PIN or a code to confirm
// is asked by the library's prompt (the "systemrequest").
import { button, popover, refill, style, watch } from "./tray.js";

const svg = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const RUNE = "M7 7l10 10-5 4V3l5 4L7 17";
const ICONS = {
  on: svg(`<path d="${RUNE}"/>`),
  off: svg(`<path d="${RUNE}" opacity=".35"/><path d="M4 4l16 16"/>`),
  connected: svg(`<path d="${RUNE}"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="20" cy="12" r="1" fill="currentColor"/>`),
};

export default function bluetooth(shell, container) {
  style();
  const service = shell.system.bluetooth;
  const element = button("Bluetooth");
  container.append(element);
  let state = null;
  let error = "";
  /** The device whose actions are shown. */
  let open = null;

  const act = async (action, args) => {
    error = "";
    refill(element, fill);
    try {
      await service.call(action, args);
    } catch (e) {
      error = String(e?.message ?? e);
    }
    refill(element, fill);
  };

  const small = (label, onClick) => {
    const element = document.createElement("button");
    element.className = "icon";
    element.style.cssText = "font-size: 11px; padding: 2px 6px;";
    element.textContent = label;
    element.onclick = onClick;
    return element;
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
    const adapter = state?.adapter;
    if (!adapter) {
      pop.append(Object.assign(document.createElement("div"), { className: "muted", textContent: "No Bluetooth adapter." }));
      return;
    }
    const toggle = small(adapter.powered ? "On" : "Off", () => act("set-powered", { powered: !adapter.powered }));
    toggle.title = adapter.powered ? "Turn Bluetooth off" : "Turn Bluetooth on";
    pop.append(heading("Bluetooth", toggle));
    if (adapter.powered) {
      const paired = state.devices.filter((device) => device.paired);
      const nearby = state.devices.filter((device) => !device.paired);
      for (const device of paired) {
        const entry = document.createElement("button");
        entry.innerHTML = `<span style="flex: 1; overflow: hidden; text-overflow: ellipsis"></span><small class="muted"></small>`;
        entry.querySelector("span").textContent = device.name;
        entry.querySelector("small").textContent =
          device.battery !== null ? `${device.battery}%` : device.connected ? "Connected" : "";
        if (device.connected) entry.classList.add("current");
        entry.onclick = () => {
          open = open === device.id ? null : device.id;
          refill(element, fill);
        };
        pop.append(entry);
        if (open === device.id) {
          const row = document.createElement("div");
          row.className = "row";
          row.style.cssText = "justify-content: end; gap: 4px; margin: -2px 0 4px;";
          row.append(
            small(device.connected ? "Disconnect" : "Connect", () =>
              act(device.connected ? "disconnect" : "connect", { device: device.id }),
            ),
            small("Forget", () => act("forget", { device: device.id })),
          );
          pop.append(row);
        }
      }
      if (paired.length === 0) pop.append(Object.assign(document.createElement("div"), { className: "muted", textContent: "No paired devices." }));
      const find = small(adapter.discovering ? "Looking…" : "Find devices", () => act("discover", { on: !adapter.discovering, seconds: 30 }));
      pop.append(heading("Nearby", find));
      for (const device of nearby) {
        const entry = document.createElement("button");
        entry.innerHTML = "<span></span>";
        entry.querySelector("span").textContent = device.pairing ? `${device.name} · pairing…` : device.name;
        entry.title = "Pair";
        entry.disabled = device.pairing;
        entry.onclick = () => act("pair", { device: device.id });
        pop.append(entry);
      }
    }
    if (error) pop.append(Object.assign(document.createElement("div"), { className: "error", textContent: error }));
  };

  const render = (next) => {
    state = next;
    element.hidden = !state?.adapter;
    if (!state?.adapter) return;
    const connected = state.devices.filter((device) => device.connected);
    element.innerHTML = !state.adapter.powered ? ICONS.off : connected.length ? ICONS.connected : ICONS.on;
    element.title = !state.adapter.powered
      ? "Bluetooth is off"
      : connected.length
        ? `Bluetooth: ${connected.map((device) => device.name).join(", ")}`
        : "Bluetooth";
    refill(element, fill);
  };

  element.addEventListener("click", () => {
    error = "";
    open = null;
    popover(element, fill);
  });
  watch(service, render);
}

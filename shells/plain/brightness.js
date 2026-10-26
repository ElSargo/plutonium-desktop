// The brightness indicator (shell.system.power's backlight): scroll to change
// it, click for a slider. Hidden without a backlight (a desktop monitor).
import { button, icon, popover, refill, slider, style, watch } from "./tray.js";

export default function brightness(shell, container) {
  style();
  const service = shell.system.power;
  const element = button("Brightness");
  container.append(element);
  let state = null;

  const fill = (pop) => {
    if (!state?.brightness.available) return;
    const row = document.createElement("div");
    row.className = "row";
    const value = document.createElement("span");
    value.className = "value";
    value.textContent = `${Math.round(state.brightness.value * 100)}%`;
    const symbol = document.createElement("span");
    symbol.innerHTML = icon("brightness");
    symbol.style.display = "flex";
    const range = slider(state.brightness.value, 1, (brightness) => {
      value.textContent = `${Math.round(brightness * 100)}%`;
      return service.call("set-brightness", { brightness });
    });
    range.min = "0.01";
    row.append(symbol, range, value);
    pop.append(row);
  };

  watch(service, (next) => {
    state = next;
    element.hidden = !state?.brightness?.available;
    if (element.hidden) return;
    const level = Math.round(state.brightness.value * 100);
    element.innerHTML = `${icon("brightness")}<span>${level}%</span>`;
    element.title = `Brightness: ${level}%`;
    refill(element, fill);
  });

  element.addEventListener("click", () => popover(element, fill));
  element.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      if (event.deltaY) void service.call("step", { by: event.deltaY < 0 ? 0.05 : -0.05 });
    },
    { passive: false },
  );
}

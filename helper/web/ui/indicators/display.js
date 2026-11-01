// The displays indicator (shell.system.display): a monitor icon, with how
// many displays there are. Its popover lists them (resolution, size,
// rotation, primary), turns mirroring on and off, and opens the display
// configuration tool: the switcher's Displays page (arrange, resolution,
// refresh rate, size, rotation, primary, the built-in panel on or off). Also
// "All settings…", the switcher's quick settings. Hidden without the service.
import { button, closePopover, icon, item, popover, refill, style, watch } from "../widgets.js";

export default function display(shell, container) {
  style();
  const service = shell.system.display;
  const element = button("Displays");
  container.append(element);
  let state = null;

  const open = async (page) => {
    closePopover();
    try {
      await service.call("open-settings", { page });
    } catch (error) {
      console.warn("display settings:", error);
    }
  };

  const fill = (pop) => {
    const heading = document.createElement("h3");
    heading.textContent = state?.displays?.length === 1 ? "Display" : "Displays";
    pop.append(heading);
    for (const entry of state?.displays ?? []) {
      const row = document.createElement("div");
      row.className = "row";
      const name = document.createElement("span");
      name.textContent = `${entry.index ? `${entry.index}  ` : ""}${entry.name}${entry.primary ? " (primary)" : ""}`;
      name.style.flex = "1";
      const detail = document.createElement("span");
      detail.className = "muted";
      detail.textContent = !entry.enabled
        ? "off"
        : entry.mirrorOf
          ? "mirror"
          : `${entry.mode ? `${entry.mode.width}×${entry.mode.height}` : `${entry.bounds.width}×${entry.bounds.height}`}${entry.zoom !== 1 ? ` · ${Math.round(entry.zoom * 100)}%` : ""}${entry.rotation ? ` · ${entry.rotation}°` : ""}`;
      row.append(name, detail);
      pop.append(row);
    }
    if (state?.pending) {
      const pending = document.createElement("div");
      pending.className = "error";
      pending.textContent = `${state.pending.what} goes back in ${state.pending.secondsLeft} s unless kept.`;
      pop.append(pending, item("", "Keep it", () => void service.call("keep").catch(console.warn)));
    }
    if (state?.canMirror) {
      const mirror = item("display", state.mirror ? "Stop mirroring" : "Mirror displays", () => {
        closePopover();
        void service.call("set-mirror", { on: !state.mirror, confirm: true }).catch(console.warn);
      });
      pop.append(mirror);
    }
    pop.append(item("display", "Display settings…", () => open("displays")), item("settings", "All settings…", () => open("settings")));
  };

  watch(service, (next) => {
    state = next;
    element.hidden = !state?.available;
    if (element.hidden) return;
    const count = state.displays.length;
    element.innerHTML = `${icon("display")}${count > 1 ? `<span>${count}</span>` : ""}`;
    element.title = state.displays
      .map((entry) => `${entry.name}${entry.mode ? `: ${entry.mode.width}×${entry.mode.height}` : ""}`)
      .join("\n");
    refill(element, fill);
  });

  element.addEventListener("click", () => popover(element, fill));
}

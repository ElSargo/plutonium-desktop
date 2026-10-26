// The volume indicator (shell.system.audio): the default output's level;
// scroll to change it, middle-click to mute, click for a slider, the outputs
// and the microphone.
import { button, icon, item, popover, refill, slider, style, watch } from "./tray.js";

export default function audio(shell, container) {
  style();
  const service = shell.system.audio;
  const element = button("Volume");
  container.append(element);
  let state = null;

  const fill = (pop) => {
    if (!state?.available) return;
    const { output, input, outputs } = state;
    if (output) {
      const row = document.createElement("div");
      row.className = "row";
      const mute = item(output.muted ? "volume-muted" : "volume", "", () => service.call("set-mute", { device: output.id }));
      mute.className = "icon";
      mute.title = output.muted ? "Unmute" : "Mute";
      const value = document.createElement("span");
      value.className = "value";
      value.textContent = `${Math.round(output.volume * 100)}%`;
      const range = slider(output.volume, Math.max(1, output.volume), (volume) => {
        value.textContent = `${Math.round(volume * 100)}%`;
        return service.call("set-volume", { device: output.id, volume });
      });
      row.append(mute, range, value);
      pop.append(row);
    }
    if (outputs.length > 1) {
      const heading = document.createElement("h3");
      heading.textContent = "Output";
      pop.append(heading);
      for (const device of outputs) {
        const choice = item("", device.name, () => service.call("set-default", { device: device.id }));
        if (device.default) choice.classList.add("current");
        pop.append(choice);
      }
    }
    if (input) {
      const heading = document.createElement("h3");
      heading.textContent = "Microphone";
      const row = document.createElement("div");
      row.className = "row";
      const mute = item(input.muted ? "mic-muted" : "mic", "", () => service.call("set-mute", { device: input.id }));
      mute.className = "icon";
      mute.title = input.muted ? "Unmute the microphone" : "Mute the microphone";
      const range = slider(input.volume, Math.max(1, input.volume), (volume) =>
        service.call("set-volume", { device: input.id, volume }),
      );
      row.append(mute, range);
      pop.append(heading, row);
    }
    if (!output && !input) {
      const none = document.createElement("div");
      none.className = "muted";
      none.textContent = "No sound devices.";
      pop.append(none);
    }
  };

  watch(service, (next) => {
    state = next;
    element.hidden = !state?.available;
    if (!state?.available) return;
    const level = state.output ? Math.round(state.volume * 100) : 0;
    const name = !state.output || state.muted ? "volume-muted" : state.volume < 0.5 ? "volume-low" : "volume";
    element.innerHTML = `${icon(name)}<span>${state.output ? `${level}%` : ""}</span>`;
    element.title = state.output ? `${state.output.name}: ${state.muted ? "muted" : `${level}%`}` : "No output";
    refill(element, fill);
  });

  element.addEventListener("click", () => popover(element, fill));
  element.addEventListener("auxclick", (event) => {
    if (event.button === 1) void service.call("set-mute", {});
  });
  element.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      if (event.deltaY) void service.call("step", { by: event.deltaY < 0 ? 0.05 : -0.05 });
    },
    { passive: false },
  );
}

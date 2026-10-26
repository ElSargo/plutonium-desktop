// The on-screen level for the hardware keys (the shell's systemkey event):
// volume, the microphone, brightness, or what's playing, for a moment.
import { icon, style } from "./tray.js";

const CSS = `
.tray-osd {
  position: fixed; left: 50%; bottom: 12%; z-index: 1002; transform: translateX(-50%);
  display: flex; align-items: center; gap: 12px; min-width: 240px; max-width: 420px; padding: 12px 16px;
  background: var(--tray-bg, #1e1e1eee); color: var(--tray-fg, #e6e6e6); border: var(--tray-border, 1px solid #ffffff1a);
  border-radius: 999px; box-shadow: 0 10px 40px #0008; backdrop-filter: blur(12px); font: 13px/1.4 system-ui, sans-serif;
  pointer-events: none; transition: opacity 200ms;
}
.tray-osd.hide { opacity: 0; }
.tray-osd svg { width: 20px; height: 20px; flex: none; }
.tray-osd .bar { flex: 1; height: 6px; border-radius: 3px; background: #ffffff26; overflow: hidden; }
.tray-osd .bar > div { height: 100%; background: var(--tray-accent, #7fc8ff); }
.tray-osd .text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tray-osd .value { width: 3em; text-align: right; font-variant-numeric: tabular-nums; }
`;

export default function osd(shell) {
  style();
  const sheet = document.createElement("style");
  sheet.textContent = CSS;
  document.head.append(sheet);
  const element = document.createElement("div");
  element.className = "tray-osd hide";
  document.body.append(element);
  let timer = 0;

  const show = (iconName, level, text) => {
    element.innerHTML = icon(iconName);
    if (level !== null) {
      element.insertAdjacentHTML("beforeend", `<div class="bar"><div></div></div><span class="value"></span>`);
      element.querySelector(".bar > div").style.width = `${Math.min(100, level * 100)}%`;
      element.querySelector(".value").textContent = `${Math.round(level * 100)}%`;
    } else {
      element.insertAdjacentHTML("beforeend", `<span class="text"></span>`);
      element.querySelector(".text").textContent = text;
    }
    element.classList.remove("hide");
    clearTimeout(timer);
    timer = setTimeout(() => element.classList.add("hide"), 1500);
  };

  shell.addEventListener("systemkey", ({ detail: { key, state } }) => {
    if (!state) return;
    if (key === "mic-mute") {
      const muted = state.input?.muted;
      show(muted ? "mic-muted" : "mic", null, muted ? "Microphone off" : "Microphone on");
    } else if (key.startsWith("volume")) {
      show(state.muted ? "volume-muted" : "volume", state.muted ? 0 : state.volume, "");
    } else if (key.startsWith("brightness")) {
      show("brightness", state.brightness?.value ?? 0, "");
    } else {
      const player = state.players?.[0];
      if (player) show(player.status === "playing" ? "play" : "pause", null, [player.title || player.name, player.artist].filter(Boolean).join(" — "));
    }
  });
}

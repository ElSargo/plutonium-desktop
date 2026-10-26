// Now playing (shell.system.media): the active player's title and a
// play/pause button; click for every player with previous, play/pause and
// next. Hidden when nothing plays. The media keys control the same player.
import { button, icon, item, popover, refill, style, watch } from "./tray.js";

const MAX_LABEL = 40;

function label(player) {
  const text = [player.title || player.name, player.artist].filter(Boolean).join(" — ");
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL - 1)}…` : text;
}

export default function media(shell, container) {
  style();
  const service = shell.system.media;
  const element = button("Now playing");
  container.append(element);
  let state = null;

  const control = (player, action, iconName, title, enabled) => {
    const choice = item(iconName, "", () => service.call(action, { player: player.id }));
    choice.className = "icon";
    choice.title = title;
    choice.disabled = !enabled;
    return choice;
  };

  const fill = (pop) => {
    for (const player of state?.players ?? []) {
      const block = document.createElement("div");
      block.className = "row";
      block.style.alignItems = "start";
      const art = document.createElement("div");
      art.style.cssText = "width:48px;height:48px;border-radius:6px;flex:none;display:grid;place-items:center;background:#ffffff14;overflow:hidden";
      // Only art the page can load (not file:// from a player on this computer).
      if (player.artUrl && /^(https?|data):/.test(player.artUrl)) {
        const image = document.createElement("img");
        image.src = player.artUrl;
        image.style.cssText = "width:100%;height:100%;object-fit:cover";
        art.append(image);
      } else {
        art.innerHTML = icon("music");
      }
      const text = document.createElement("div");
      text.style.cssText = "min-width:0;flex:1;display:grid;gap:2px";
      const title = document.createElement("div");
      title.style.cssText = "font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      title.textContent = player.title || "Unknown";
      const artist = document.createElement("div");
      artist.className = "muted";
      artist.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      artist.textContent = [player.artist, player.name].filter(Boolean).join(" · ");
      const controls = document.createElement("div");
      controls.className = "row";
      controls.style.gap = "2px";
      const playing = player.status === "playing";
      controls.append(
        control(player, "previous", "previous", "Previous", player.canGoPrevious),
        control(player, "play-pause", playing ? "pause" : "play", playing ? "Pause" : "Play", playing ? player.canPause : player.canPlay),
        control(player, "next", "next", "Next", player.canGoNext),
      );
      text.append(title, artist, controls);
      block.append(art, text);
      pop.append(block);
    }
  };

  watch(service, (next) => {
    state = next;
    const player = state?.players?.[0];
    element.hidden = !player;
    if (!player) return;
    const playing = player.status === "playing";
    element.innerHTML = `${icon(playing ? "pause" : "play")}<span></span>`;
    element.querySelector("span").textContent = label(player);
    element.title = `${player.name}: ${player.title || "nothing"} (click for controls)`;
    refill(element, fill);
  });

  // The icon plays or pauses; the rest opens the controls.
  element.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("svg")) void service.call("play-pause", {});
    else popover(element, fill);
  });
}

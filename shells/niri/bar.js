// niri's bar (as waybar is for niri): the workspace minimap (minimap.js) and
// now playing on the left, the clock in
// the middle, the status indicators on the right. Each indicator is its own
// module (audio.js, brightness.js, battery.js, power.js, media.js…) put in
// one of the bar's sections; the layout leaves the bar's height free.

const CSS = `
#bar {
  position: fixed; left: 0; right: 0; top: 0; height: var(--bar-h); z-index: 40;
  display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; padding: 3px 8px;
  background: #101012; color: var(--text); font: 13px/1 system-ui, sans-serif;
  --tray-fg: var(--text); --tray-muted: var(--muted); --tray-accent: var(--focus);
}
#world { top: var(--bar-h); }
#bar > section { display: flex; align-items: center; gap: 2px; height: 100%; min-width: 0; }
#bar > .right { justify-content: end; }
#bar .clock { padding: 0 8px; font-variant-numeric: tabular-nums; }
body.overview #bar { opacity: .9; }
`;

/** Puts the bar at the top; returns its sections and its height in pixels. */
export function mountBar(height = 30) {
  document.documentElement.style.setProperty("--bar-h", `${height}px`);
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  const bar = document.createElement("div");
  bar.id = "bar";
  bar.innerHTML = `<section class="left"></section><section class="center"><span class="clock"></span></section><section class="right"></section>`;
  document.body.append(bar);
  const clock = bar.querySelector(".clock");
  const tick = () => {
    const now = new Date();
    clock.textContent = now.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    setTimeout(tick, 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);
  };
  tick();
  return { height, left: bar.querySelector(".left"), center: bar.querySelector(".center"), right: bar.querySelector(".right") };
}

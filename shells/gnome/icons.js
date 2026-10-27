// Symbolic icons for the shell (stroked, 24×24, currentColor), in the
// spirit of Adwaita's symbolic set.

const PATHS = {
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
  grid: '<path d="M4 4h4v4H4zM10 4h4v4h-4zM16 4h4v4h-4zM4 10h4v4H4zM10 10h4v4h-4zM16 10h4v4h-4zM4 16h4v4H4zM10 16h4v4h-4zM16 16h4v4h-4z" fill="currentColor" stroke="none"/>',
  close: '<path d="M7 7l10 10M17 7L7 17"/>',
  back: '<path d="M14.5 6l-6 6 6 6"/>',
  forward: '<path d="M9.5 6l6 6-6 6"/>',
  reload: '<path d="M19 12a7 7 0 1 1-2-4.9"/><path d="M19 5v4h-4"/>',
  stop: '<path d="M7 7l10 10M17 7L7 17"/>',
  chevron: '<path d="M9.5 6l6 6-6 6"/>',
  "chevron-down": '<path d="M6 9.5l6 6 6-6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  minimize: '<path d="M7 16h10"/>',
  maximize: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/>',
  restore: '<rect x="6.5" y="9" width="8.5" height="8.5" rx="1.5"/><path d="M9.5 6.5h7.5a1 1 0 0 1 1 1V15"/>',
  volume: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/>',
  "volume-low": '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16 8.5a5 5 0 0 1 0 7"/>',
  "volume-muted": '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 9.5l5 5m0-5l-5 5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  "mic-muted": '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M4 4l16 16"/>',
  brightness: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/>',
  power: '<path d="M12 3v8"/><path d="M6.3 6.5a8 8 0 1 0 11.4 0"/>',
  suspend: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  reboot: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v5h-5"/>',
  "log-out": '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M10 8l-4 4 4 4M6 12h9"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5l1.6 2.6 3-.6.6 3 2.6 1.6-1.4 2.9 1.4 2.9-2.6 1.6-.6 3-3-.6L12 21.5l-1.6-2.6-3 .6-.6-3-2.6-1.6 1.4-2.9-1.4-2.9 2.6-1.6.6-3 3 .6z"/>',
  screenshot: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><circle cx="12" cy="12" r="3"/>',
  wifi: '<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.2a9.5 9.5 0 0 1 13 0M8.6 15.4a5 5 0 0 1 6.8 0"/><circle cx="12" cy="18.5" r="1.2" fill="currentColor"/>',
  "wifi-off": '<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.2a9.5 9.5 0 0 1 13 0M8.6 15.4a5 5 0 0 1 6.8 0" opacity=".35"/><path d="M4 4l16 16"/>',
  wired: '<rect x="8" y="3" width="8" height="6" rx="1"/><path d="M12 9v4M5 13h14M5 13v4M19 13v4M12 13v4"/><rect x="3" y="17" width="4" height="4" rx="1"/><rect x="10" y="17" width="4" height="4" rx="1"/><rect x="17" y="17" width="4" height="4" rx="1"/>',
  vpn: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.5" r="1.2" fill="currentColor"/>',
  offline: '<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.2a9.5 9.5 0 0 1 13 0M8.6 15.4a5 5 0 0 1 6.8 0" opacity=".35"/><circle cx="12" cy="18.5" r="1.2" fill="currentColor"/>',
  bluetooth: '<path d="M7 7l10 10-5 4V3l5 4L7 17"/>',
  "bluetooth-off": '<path d="M7 7l10 10-5 4V3l5 4L7 17" opacity=".35"/><path d="M4 4l16 16"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
  "bell-off": '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" opacity=".35"/><path d="M4 4l16 16"/>',
  coffee: '<path d="M5 9h11v5a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5z"/><path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16M8 3.5c0 1.5 1 1.5 1 3M11.5 3.5c0 1.5 1 1.5 1 3"/>',
  airplane: '<path d="M10.5 3.5a1.5 1.5 0 0 1 3 0V9l7 4v2l-7-2v4.5l2.5 2V21L12 20l-4 1v-1.5l2.5-2V13l-7 2v-2l7-4z"/>',
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>',
  pause: '<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/>',
  next: '<path d="M5 5l10 7-10 7z" fill="currentColor"/><path d="M18 5v14"/>',
  previous: '<path d="M19 5L9 12l10 7z" fill="currentColor"/><path d="M6 5v14"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7 9.5l3 2.5-3 2.5M12 15h5"/>',
  web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z"/>',
  agent: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
  pin: '<path d="M9 4h6l-1 5 3 3v2H7v-2l3-3z"/><path d="M12 14v6"/>',
  unpin: '<path d="M9 4h6l-1 5 3 3v2H7v-2l3-3z"/><path d="M12 14v6M4 4l16 16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  window: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 9h17"/>',
  "tile-left": '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M12 5v14"/><path d="M4 6h7.5v12.5H4z" fill="currentColor" stroke="none" opacity=".5"/>',
  "tile-right": '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M12 5v14"/><path d="M12.5 6H20v12.5h-7.5z" fill="currentColor" stroke="none" opacity=".5"/>',
  above: '<rect x="3.5" y="9" width="11" height="11" rx="1.5"/><rect x="9.5" y="4" width="11" height="11" rx="1.5" fill="currentColor" fill-opacity=".35"/>',
  title: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 9h17"/><path d="M4 5.5h16v3H4z" fill="currentColor" stroke="none" opacity=".5"/>',
  workspace: '<rect x="2.5" y="6" width="8" height="12" rx="1.5"/><rect x="13.5" y="6" width="8" height="12" rx="1.5"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9 10h.01M12 10h.01M15 10h.01M18 10h.01M7.5 14h9"/>',
  appearance: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/>',
  multitasking: '<rect x="3" y="4" width="11" height="8" rx="1.5"/><rect x="10" y="12" width="11" height="8" rx="1.5"/>',
  apps: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  battery: '<rect x="2.5" y="7" width="17" height="10" rx="2"/><path d="M21.5 10.5v3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>',
  privacy: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/>',
  display: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6M12 16v4"/>',
  trash: '<path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13"/>',
  edit: '<path d="M5 19l1-4L16 5l3 3L9 18z"/>',
  more: '<circle cx="6" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18" cy="12" r="1.3" fill="currentColor"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  "go-to": '<path d="M14 5h5v5M19 5l-8 8M17 14v5H5V7h5"/>',
};

/** An icon as SVG markup. */
export function icon(name, className = "") {
  return `<svg class="ic ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] ?? ""}</svg>`;
}

/** A battery icon filled to `fraction`, with a bolt when charging. */
export function batteryIcon(fraction, charging) {
  const width = Math.max(0, Math.min(1, fraction)) * 14;
  const low = fraction <= 0.15 && !charging;
  return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
    <rect x="2.5" y="7" width="17" height="10" rx="2"/><path d="M21.5 10.5v3"/>
    <rect x="4" y="8.5" width="${width.toFixed(1)}" height="7" rx="1" fill="${low ? "#ff7b63" : "currentColor"}" stroke="none"/>
    ${charging ? '<path d="M12 6.5l-3 6h3.5l-1.5 5 4.5-7h-3.5l1.5-4z" fill="#000" stroke="currentColor" stroke-width="1"/>' : ""}
  </svg>`;
}

/** The Wi-Fi icon for a signal strength (0–100). */
export function wifiIcon(strength) {
  const bars = strength >= 70 ? 3 : strength >= 45 ? 2 : strength >= 20 ? 1 : 0;
  const arcs = ["M8.6 15.4a5 5 0 0 1 6.8 0", "M5.5 12.2a9.5 9.5 0 0 1 13 0", "M2.5 9a14 14 0 0 1 19 0"];
  return `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
    ${arcs.map((d, i) => `<path d="${d}" opacity="${i < bars ? 1 : 0.3}"/>`).join("")}
    <circle cx="12" cy="18.5" r="1.2" fill="currentColor" stroke="none"/></svg>`;
}

/** The volume icon for a level. */
export function volumeIcon(volume, muted) {
  return icon(muted || volume <= 0 ? "volume-muted" : volume < 0.5 ? "volume-low" : "volume");
}

/** "2 h 05 min" for a number of seconds. */
export function duration(seconds) {
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min` : `${minutes} min`;
}

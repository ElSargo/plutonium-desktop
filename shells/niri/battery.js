// The battery indicator (shell.system.power): its level, charging, and the
// time left in its tooltip. Hidden without a battery.
import { batteryIcon, button, duration, style, watch } from "./tray.js";

export default function battery(shell, container) {
  style();
  const element = button("Battery");
  container.append(element);

  watch(shell.system.power, (state) => {
    const battery = state?.battery;
    element.hidden = !battery;
    if (!battery) return;
    element.innerHTML = `${batteryIcon(battery.percent / 100, battery.charging)}<span>${battery.percent}%</span>`;
    const what =
      battery.state === "full" ? "Full"
      : battery.charging ? "Charging"
      : state.ac ? "Plugged in, not charging"
      : "On battery";
    const left = battery.timeLeft ? `, ${duration(battery.timeLeft)} ${battery.charging ? "to full" : "left"}` : "";
    element.title = `${battery.percent}%: ${what}${left}`;
  });
}

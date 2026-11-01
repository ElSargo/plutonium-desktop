// The power menu (shell.system.power): lock (shell.system.session), then
// suspend, restart, power off and log out, each after a confirm. Log out ends
// this Plutonium session.
import { button, closePopover, confirm, icon, item, popover, style, watch } from "../widgets.js";

const ACTIONS = [
  { action: "suspend", can: "suspend", icon: "suspend", label: "Suspend", question: "Suspend the computer?" },
  { action: "reboot", can: "reboot", icon: "reboot", label: "Restart", question: "Restart the computer? Unsaved work in open apps is lost." },
  { action: "power-off", can: "powerOff", icon: "power", label: "Power off", question: "Power off the computer? Unsaved work in open apps is lost." },
  { action: "log-out", can: "logOut", icon: "log-out", label: "Log out", question: "Log out? This ends the Plutonium session and closes its apps." },
];

export default function power(shell, container) {
  style();
  const service = shell.system.power;
  const session = shell.system.session;
  const element = button("Power");
  element.innerHTML = icon("power");
  container.append(element);
  let state = null;
  let sessionState = null;

  const failed = (label, error) =>
    popover(element, (again) => {
      fill(again);
      const message = document.createElement("div");
      message.className = "error";
      message.textContent = `${label}: ${error.message ?? error}`;
      again.append(message);
    });

  const fill = (pop) => {
    if (sessionState) {
      // No confirm: the password brings it back. Disabled (with why) when there's no way to check one.
      const lock = item("lock", "Lock", async () => {
        closePopover();
        try {
          await session.call("lock");
        } catch (error) {
          failed("Lock", error);
        }
      });
      lock.disabled = !sessionState.canLock;
      if (sessionState.problem) lock.title = sessionState.problem;
      pop.append(lock);
    }
    for (const entry of ACTIONS) {
      const can = state?.can?.[entry.can] ?? "na";
      if (can === "na") continue;
      const choice = item(entry.icon, entry.label, async () => {
        closePopover();
        if (!(await confirm(entry.question, entry.label))) return;
        try {
          await service.call(entry.action);
        } catch (error) {
          failed(entry.label, error);
        }
      });
      // "challenge" would ask for a password, which needs a polkit agent.
      choice.disabled = can === "no";
      pop.append(choice);
    }
  };

  const show = () => {
    element.hidden = !sessionState && (!state || !Object.values(state.can ?? {}).some((can) => can !== "na"));
  };
  watch(service, (next) => {
    state = next;
    show();
  });
  watch(session, (next) => {
    sessionState = next;
    show();
  });
  element.addEventListener("click", () => popover(element, fill));
}

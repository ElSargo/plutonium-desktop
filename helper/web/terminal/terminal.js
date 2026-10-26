// The backup terminal's page: one xterm.js per tab, each attached to a login
// shell the helper runs on a pty (helper/src/terminal.ts). Sessions outlive a
// reload for a while, so the page picks its tabs back up.
"use strict";

const API = "sessions";
const THEME = {
  background: "#171819",
  foreground: "#e8eaed",
  cursor: "#8ab4f8",
  selectionBackground: "#3c4043",
  black: "#202124",
  red: "#f28b82",
  green: "#81c995",
  yellow: "#fdd663",
  blue: "#8ab4f8",
  magenta: "#d7aefb",
  cyan: "#78d9ec",
  white: "#e8eaed",
  brightBlack: "#5f6368",
  brightRed: "#f6aea9",
  brightGreen: "#a8dab5",
  brightYellow: "#fde293",
  brightBlue: "#aecbfa",
  brightMagenta: "#e9d2fd",
  brightCyan: "#a1e4f2",
  brightWhite: "#ffffff",
};

const tabBar = document.getElementById("tabs");
const panes = document.getElementById("terminals");
const empty = document.getElementById("empty");
/** @type {Tab[]} */
const tabs = [];
let active = null;
let counter = 0;

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: typeof body === "string" ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || response.statusText);
  return response.status === 204 ? null : response.json();
}

class Tab {
  constructor() {
    this.number = ++counter;
    this.title = `Terminal ${this.number}`;
    this.id = null;
    this.exited = false;
    this.pending = "";
    this.sending = false;
    this.pane = document.createElement("div");
    this.pane.className = "terminal-pane";
    panes.append(this.pane);
    this.term = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      fontFamily: '"DejaVu Sans Mono", "Noto Sans Mono", "Liberation Mono", monospace',
      fontSize: 14,
      scrollback: 10000,
      theme: THEME,
    });
    this.fit = new FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(this.pane);
    this.term.attachCustomKeyEventHandler((event) => handleKey(event, this));
    this.term.onData((data) => this.send(data));
    this.term.onResize(({ rows, cols }) => {
      if (this.id && !this.exited) api(`${API}/${this.id}/resize`, { rows, cols }).catch(() => {});
    });
    this.term.onTitleChange((title) => {
      this.title = title || `Terminal ${this.number}`;
      render();
    });
    this.button = document.createElement("div");
    this.button.className = "tab";
    this.button.setAttribute("role", "tab");
    const title = document.createElement("span");
    title.className = "title";
    const close = document.createElement("button");
    close.className = "close";
    close.textContent = "×";
    close.title = "Close (Ctrl+Shift+W)";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      this.close();
    });
    this.button.append(title, close);
    this.button.addEventListener("mousedown", (event) => {
      if (event.button === 1) this.close();
    });
    this.button.addEventListener("click", () => activate(this));
    tabBar.append(this.button);
  }

  /** Starts a new session (no id) or attaches to a running one. */
  async connect(id) {
    try {
      this.fit.fit();
      this.id = id || (await api(API, { rows: this.term.rows, cols: this.term.cols })).id;
      // One started elsewhere has a default size.
      if (id) api(`${API}/${id}/resize`, { rows: this.term.rows, cols: this.term.cols }).catch(() => {});
    } catch (error) {
      this.term.write(`\r\nCouldn't start a terminal: ${error.message}\r\n`);
      this.exited = true;
      render();
      return;
    }
    if (id) api(`${API}/${id}/resize`, { rows: this.term.rows, cols: this.term.cols }).catch(() => {});
    this.source = new EventSource(`${API}/${this.id}/stream`);
    this.source.addEventListener("data", (event) => this.term.write(JSON.parse(event.data)));
    this.source.addEventListener("exit", () => {
      this.exited = true;
      this.source.close();
      // As terminals do: the tab goes with its shell.
      this.close();
    });
    this.source.onerror = () => {
      // The helper restarted (the session is gone) or is restarting.
      if (this.source.readyState === EventSource.CLOSED && !this.exited) {
        this.exited = true;
        this.term.write("\r\n\x1b[2m[the helper went away]\x1b[0m\r\n");
        render();
      }
    };
  }

  // Keys go one request at a time, so they arrive in order.
  send(data) {
    if (!this.id || this.exited) return;
    this.pending += data;
    if (this.sending) return;
    this.sending = true;
    const flush = () => {
      const chunk = this.pending;
      this.pending = "";
      api(`${API}/${this.id}/input`, chunk)
        .catch(() => {})
        .finally(() => {
          if (this.pending) flush();
          else this.sending = false;
        });
    };
    flush();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.source?.close();
    if (this.id && !this.exited) api(`${API}/${this.id}/close`, {}).catch(() => {});
    this.term.dispose();
    this.pane.remove();
    this.button.remove();
    const index = tabs.indexOf(this);
    tabs.splice(index, 1);
    if (active === this) activate(tabs[Math.min(index, tabs.length - 1)] ?? null);
    render();
  }
}

function activate(tab) {
  active = tab;
  render();
  if (tab) {
    tab.fit.fit();
    tab.term.focus();
  }
}

function render() {
  for (const tab of tabs) {
    const selected = tab === active;
    tab.pane.hidden = !selected;
    tab.button.setAttribute("aria-selected", String(selected));
    tab.button.classList.toggle("exited", tab.exited);
    tab.button.querySelector(".title").textContent = tab.title;
    tab.button.title = tab.title;
  }
  empty.hidden = tabs.length > 0;
  document.title = active ? `${active.title} — Backup terminal` : "Backup terminal";
}

function newTab(id, title) {
  const tab = new Tab();
  if (title) tab.title = title;
  tabs.push(tab);
  activate(tab);
  tab.connect(id);
  return tab;
}

function step(delta) {
  if (tabs.length < 2 || !active) return;
  activate(tabs[(tabs.indexOf(active) + delta + tabs.length) % tabs.length]);
}

// The page's own keys; the rest go to the shell. Returns whether xterm should
// handle the event.
function handleKey(event, tab) {
  if (event.type !== "keydown") return true;
  const ctrlShift = event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
  const ctrl = event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
  if (ctrlShift && event.code === "KeyT") {
    event.preventDefault();
    newTab();
    return false;
  }
  if (ctrlShift && event.code === "KeyW") {
    event.preventDefault();
    tab.close();
    return false;
  }
  if ((ctrl || ctrlShift) && (event.code === "PageDown" || event.code === "PageUp")) {
    event.preventDefault();
    step(event.code === "PageDown" ? 1 : -1);
    return false;
  }
  if (ctrlShift && event.code === "KeyC") {
    // Not DevTools' inspector: copy.
    event.preventDefault();
    const selection = tab.term.getSelection();
    if (selection) navigator.clipboard.writeText(selection).catch(() => {});
    return false;
  }
  if (ctrlShift && event.code === "KeyV") {
    // The browser pastes into xterm's textarea, which sends it on.
    return false;
  }
  return true;
}

document.getElementById("new").addEventListener("click", () => newTab());
document.getElementById("new-empty").addEventListener("click", () => newTab());
document.addEventListener("keydown", (event) => {
  // With no terminal focused (no tabs, or the tab bar).
  if (!event.defaultPrevented && event.ctrlKey && event.shiftKey && event.code === "KeyT") {
    event.preventDefault();
    newTab();
  }
});
new ResizeObserver(() => active?.fit.fit()).observe(panes);

const liveSessions = () =>
  api(API)
    .then((sessions) => sessions.filter((session) => session.alive).sort((a, b) => a.createdAt - b.createdAt))
    .catch(() => []);
// A session started from elsewhere in the last few seconds (the switcher's
// "Open a terminal" or "Ask an agent" for a shell) is the one to show.
const fresh = (session) => Date.now() - session.createdAt < 15_000;

// Pick up the sessions from before a reload, else start one.
liveSessions().then((sessions) => {
  if (sessions.length === 0) newTab();
  for (const session of sessions) newTab(session.id, session.title);
  const newest = sessions.at(-1);
  if (tabs.length > 0) activate(newest && fresh(newest) ? tabs.at(-1) : tabs[0]);
});
// Sessions started elsewhere while the page was open.
async function adoptSessions() {
  // Not while a new tab waits for its session, which would be adopted too.
  if (tabs.some((tab) => !tab.id && !tab.exited)) return;
  for (const session of await liveSessions()) {
    if (!tabs.some((tab) => tab.id === session.id)) newTab(session.id, session.title);
  }
}
window.addEventListener("focus", () => void adoptSessions());
// Being brought to the front doesn't always focus the page: look now and then.
setInterval(() => document.visibilityState === "visible" && void adoptSessions(), 2000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void adoptSessions();
});

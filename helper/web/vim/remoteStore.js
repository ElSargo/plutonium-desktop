// The register store, from a page's world (PLUTO_VIM.md, Registers): the
// helper keeps every register in its memory (vimRegisters.ts), shared by all
// pages, and the engine reaches it through a DevTools binding the helper adds
// to the engine's world only (vimInject.ts), so the page can't call it.
//
// A call is plutoVimStore(JSON) and the helper answers by calling
// plutoVimStoreReply(id, value) in the same world. Where there's no binding
// (a browser without the helper, a test), or the helper doesn't answer in
// time, the registers stay in this world (MemoryStore).
import { MemoryStore } from "./registers.js";

export const BINDING = "plutoVimStore";
export const REPLY = "plutoVimStoreReply";
/** How long a call waits for the helper before this world's own registers answer. */
const TIMEOUT_MS = 2000;

export class RemoteStore {
  #local = new MemoryStore();
  #pending = new Map();
  #next = 1;
  #global;
  #timeoutMs;

  constructor({ global = globalThis, timeoutMs = TIMEOUT_MS } = {}) {
    this.#global = global;
    this.#timeoutMs = timeoutMs;
    global[REPLY] = (id, value) => {
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.resolve(value);
    };
  }

  /** Whether the helper's store is there. */
  get remote() {
    return typeof this.#global[BINDING] === "function";
  }

  /** Anything else the helper does for this world: { op, ... }; resolves to its answer, or null. */
  call(op, data = {}) {
    if (!this.remote) return Promise.resolve(null);
    return this.#call({ op, ...data, name: data.name ?? op }, () => null);
  }

  get(name, scope = "global") {
    if (!this.remote) return this.#local.get(name, scope);
    return this.#call({ op: "get", name, scope }, () => this.#local.get(name, scope));
  }

  set(name, value, scope = "global") {
    this.#local.set(name, value, scope);
    if (!this.remote) return undefined;
    return this.#call({ op: "set", name, scope, value }, () => undefined);
  }

  #call(message, fallback) {
    const id = this.#next++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        console.warn(`pluto vim: the register store didn't answer (${message.op} "${message.name})`);
        resolve(fallback());
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, timer });
      try {
        this.#global[BINDING](JSON.stringify({ id, ...message }));
      } catch {
        clearTimeout(timer);
        this.#pending.delete(id);
        resolve(fallback());
      }
    });
  }
}

/**
 * Uppercase marks name a field anywhere on the desktop, so with the helper
 * they're its (vimMarks.ts): a mark set here is told to it, and a jump to one
 * asks it to go there, this page included (page.jumpToMark).
 */
export function connectHost(vim, store, doc = globalThis.document) {
  if (!store.remote) return;
  // A shell's labels (HYDRA_KEYBOARD.md): the shell's page asks for the targets in the tabs it shows
  // (pvim:hint-request { id, kind } → pvim:hint-targets { id, tabs }), and sends one there (pvim:hint-go).
  doc?.addEventListener("pvim:hint-request", (event) => {
    const { id, kind } = event.detail ?? {};
    void store.call("hints.collect", { kind }).then((tabs) => {
      doc.dispatchEvent(new doc.defaultView.CustomEvent("pvim:hint-targets", { detail: { id, tabs: tabs ?? [] } }));
    });
  });
  doc?.addEventListener("pvim:hint-go", (event) => {
    const { targetId, id } = event.detail ?? {};
    void store.call("hints.go", { targetId, id });
  });
  vim.remoteMarks = true;
  vim.on("MarkSet", ({ name, offset }) => void store.call("mark.set", { name, offset }));
  vim.on("MarkJump", ({ name }) => void store.call("mark.jump", { name }));
  // A page key this page doesn't have (a place, a show, a jump): the shell's (HYDRA_KEYBOARD.md).
  vim.on("PageKey", ({ name, detail }) => void store.call("page.key", { name, detail }));
  // One mode for the desktop (HYDRA_KEYBOARD.md, "One input model"): a change here goes to the helper,
  // which tells every other page and app (page.setDesktopMode).
  void store.call("mode.get").then((mode) => {
    if (mode === "normal" || mode === "insert") vim.setMode(mode, { remote: true });
  });
  vim.on("DesktopMode", ({ mode, remote }) => {
    if (!remote) void store.call("mode.set", { mode });
  });
  // What the shells show of the keyboard (the mode pill), from the page that has it.
  doc?.addEventListener("pvim:state", (event) => {
    if (event.detail?.focused) void store.call("state", { state: event.detail });
  });
}

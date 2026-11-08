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

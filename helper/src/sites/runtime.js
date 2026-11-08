// The site extensions' runtime (docs/features/SITE_EXTENSIONS.md): the `site`
// API, run in the page's "plutonium-sites" isolated world by the helper
// (injector.ts). The page can't see it. It keeps the parts that apply to this
// frame running, and takes them down cleanly (styles, observers, listeners,
// keys, timers), so a part can be changed or switched off in place.
//
// The helper hands it { context, theme, parts } at document start
// (boot) and again whenever something changes (update). Each part's code is
// a function in the injected source, not a string, so a page's CSP has
// nothing to say about it. It talks back through a binding that exists in
// this world only (__plutoniumSitesSend), and the helper answers with reply().
(() => {
  if (globalThis.__plutoniumSites) return;

  const MAX_ERRORS = 20;
  const MAX_LOGS = 50;
  const CHORD_MS = 1500;
  const isTop = window.top === window;

  let nextCall = 1;
  const waiting = new Map();
  // The helper adds the binding to this world's context once it has found it
  // (after each new document), then calls connected(); until then messages wait.
  const MAX_QUEUED = 200;
  const queued = [];
  function deliver(text) {
    if (typeof globalThis.__plutoniumSitesSend !== "function") return false;
    try {
      globalThis.__plutoniumSitesSend(text);
      return true;
    } catch {
      return false;
    }
  }
  function send(message) {
    const text = JSON.stringify(message);
    if (queued.length === 0 && deliver(text)) return;
    queued.push(text);
    if (queued.length > MAX_QUEUED) queued.shift();
  }
  function flush() {
    while (queued.length && deliver(queued[0])) queued.shift();
  }
  function call(type, data) {
    return new Promise((resolve, reject) => {
      const id = nextCall++;
      waiting.set(id, { resolve, reject });
      send({ id, type, ...data });
    });
  }

  const state = {
    context: { thread: null, project: null, sites: {}, shell: null },
    theme: { scheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light", tokens: {} },
    /** Every part the helper sent, by id: { spec, run, hash, site } */
    defs: new Map(),
    /** Parts running, by id. */
    running: new Map(),
    /** Errors and logs, by part id (kept after a part stops, until it changes). */
    errors: new Map(),
    logs: new Map(),
  };

  function record(map, id, entry, max) {
    const list = map.get(id) ?? [];
    list.push(entry);
    if (list.length > max) list.shift();
    map.set(id, list);
  }

  function reportError(id, error, where) {
    const entry = {
      message: String(error && error.message ? error.message : error),
      stack: error && error.stack ? String(error.stack).split("\n").slice(0, 6).join("\n") : "",
      where,
      url: location.href,
      at: Date.now(),
    };
    record(state.errors, id, entry, MAX_ERRORS);
    send({ type: "error", part: id, ...entry });
  }

  function whenRoot(fn) {
    if (document.documentElement) return fn(document.documentElement);
    const observer = new MutationObserver(() => {
      if (!document.documentElement) return;
      observer.disconnect();
      fn(document.documentElement);
    });
    observer.observe(document, { childList: true });
    return undefined;
  }

  function isEditable(target) {
    if (!(target instanceof Element)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag === "INPUT") {
      const type = (target.getAttribute("type") || "text").toLowerCase();
      return !["button", "checkbox", "radio", "submit", "reset", "image", "range", "color", "file"].includes(type);
    }
    return false;
  }

  // ---- Keys -------------------------------------------------------------------
  // KEYS.md's spelling: "Ctrl+Shift+KeyK" (a physical key), or a character
  // ("j", "?", "/"), and chords as combos separated by spaces ("g i").
  function parseCombo(text) {
    const parts = text.split("+");
    const key = parts.pop();
    const mods = new Set(parts.map((mod) => mod.toLowerCase()));
    if (mods.has("super") || mods.has("meta")) throw new Error(`Super is the desktop's: ${text}`);
    const physical = /^(Key[A-Z]|Digit\d|F\d{1,2}|Arrow(Up|Down|Left|Right)|Enter|Escape|Space|Tab|Backspace|Delete|Home|End|PageUp|PageDown|Slash|Period|Comma|Minus|Equal|BracketLeft|BracketRight|Semicolon|Quote|Backquote|Backslash)$/.test(key);
    return {
      key,
      physical,
      ctrl: mods.has("ctrl"),
      alt: mods.has("alt"),
      shift: mods.has("shift"),
    };
  }
  function comboMatches(combo, event) {
    if (event.metaKey) return false;
    if (combo.physical) {
      return event.code === combo.key && event.ctrlKey === combo.ctrl && event.altKey === combo.alt && event.shiftKey === combo.shift;
    }
    // A character: Shift is part of the character ("?", "G").
    return event.key === combo.key && event.ctrlKey === combo.ctrl && event.altKey === combo.alt;
  }

  const bindings = new Set();
  let chord = null; // { matches: [binding], step, timer }
  function resetChord() {
    if (chord) clearTimeout(chord.timer);
    chord = null;
  }
  addEventListener(
    "keydown",
    (event) => {
      // The page's own handlers come first (Principle 5).
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      if (["Shift", "Control", "Alt", "Meta", "OS"].includes(event.key)) return;
      const step = chord ? chord.step : 0;
      const candidates = (chord ? chord.matches : [...bindings]).filter(
        (binding) => binding.combos.length > step && (binding.inText || !isEditable(event.composedPath()[0] || event.target)) && comboMatches(binding.combos[step], event),
      );
      if (candidates.length === 0) {
        resetChord();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const done = candidates.find((binding) => binding.combos.length === step + 1);
      if (done) {
        resetChord();
        done.guarded(event);
        return;
      }
      resetChord();
      chord = { matches: candidates, step: step + 1, timer: setTimeout(resetChord, CHORD_MS) };
    },
    false,
  );

  // ---- Navigation -----------------------------------------------------------------
  const navigateListeners = new Set();
  let lastUrl = location.href;
  function checkUrl() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (typeof sync === "function") sync();
    for (const listener of navigateListeners) listener({ url: lastUrl });
  }
  if (globalThis.navigation) navigation.addEventListener("currententrychange", () => setTimeout(checkUrl, 0));
  addEventListener("popstate", checkUrl);
  addEventListener("hashchange", checkUrl);
  setInterval(checkUrl, 1000);

  // ---- A part's `site` ---------------------------------------------------------------
  function makeSite(id, def) {
    const cleanups = [];
    const observers = [];
    const guard = (fn, where) =>
      function (...args) {
        try {
          return fn.apply(this, args);
        } catch (error) {
          reportError(id, error, where);
          return undefined;
        }
      };
    const onCleanup = (fn) => cleanups.push(fn);
    const listen = (target, type, fn, options) => {
      target.addEventListener(type, fn, options);
      onCleanup(() => target.removeEventListener(type, fn, options));
    };

    const site = {
      get context() {
        return contextFor(def.site);
      },
      get theme() {
        return state.theme;
      },
      get url() {
        return location.href;
      },
      part: { id, site: def.site, name: def.name },

      css(text) {
        let element = document.createElement("style");
        element.dataset.plutoniumSite = id;
        element.textContent = String(text);
        whenRoot((root) => element && (document.head || root).appendChild(element));
        const handle = {
          set(next) {
            if (element) element.textContent = String(next);
          },
          remove() {
            element?.remove();
            element = null;
          },
        };
        onCleanup(() => handle.remove());
        return handle;
      },

      observe(selector, fn, options = {}) {
        const seen = new WeakSet();
        const stats = { selector, matched: 0 };
        observers.push(stats);
        const run = guard(fn, `observe ${selector}`);
        let observer = null;
        const visit = (element) => {
          if (seen.has(element)) return;
          seen.add(element);
          stats.matched += 1;
          run(element);
          if (options.once) stop();
        };
        const scan = (root) => {
          if (!(root instanceof Element)) return;
          if (root.matches(selector)) visit(root);
          for (const element of root.querySelectorAll(selector)) {
            visit(element);
            if (options.once && !observer) return;
          }
        };
        const stop = () => {
          observer?.disconnect();
          observer = null;
        };
        whenRoot((root) => {
          scan(root);
          if (options.once && stats.matched > 0) return;
          observer = new MutationObserver((records) => {
            for (const record of records) for (const node of record.addedNodes) scan(node);
          });
          observer.observe(root, { childList: true, subtree: true });
        });
        onCleanup(stop);
        return stop;
      },

      on(event, fn) {
        const listener = guard(fn, `on ${event}`);
        let off;
        if (event === "navigate") {
          navigateListeners.add(listener);
          off = () => navigateListeners.delete(listener);
        } else if (event === "visible" || event === "hidden") {
          const change = () => {
            if ((document.visibilityState === "visible") === (event === "visible")) listener();
          };
          document.addEventListener("visibilitychange", change);
          off = () => document.removeEventListener("visibilitychange", change);
        } else if (event === "appearance") {
          const query = matchMedia("(prefers-color-scheme: dark)");
          const change = () => listener(query.matches ? "dark" : "light");
          query.addEventListener("change", change);
          off = () => query.removeEventListener("change", change);
        } else if (event === "context") {
          const forPart = () => listener(contextFor(def.site));
          contextListeners.add(forPart);
          off = () => contextListeners.delete(forPart);
        } else {
          throw new Error(`No event ${event}: navigate, visible, hidden, appearance or context.`);
        }
        onCleanup(off);
        return off;
      },

      keys: {
        bind(keys, fn, options = {}) {
          const binding = {
            combos: String(keys).trim().split(/\s+/).map(parseCombo),
            keys: String(keys),
            title: options.title ?? "",
            inText: options.inText === true,
            guarded: guard(fn, `key ${keys}`),
            part: id,
          };
          bindings.add(binding);
          const unbind = () => bindings.delete(binding);
          onCleanup(unbind);
          return unbind;
        },
        list() {
          return [...bindings].filter((binding) => binding.part === id).map(({ keys, title }) => ({ keys, title }));
        },
      },

      focusNext(selector) {
        return moveFocus(selector, 1);
      },
      focusPrev(selector) {
        return moveFocus(selector, -1);
      },
      go(path) {
        location.assign(new URL(path, location.href).href);
      },
      click(selector) {
        const element = document.querySelector(selector);
        element?.click();
        return Boolean(element);
      },

      setTimeout(fn, ms) {
        const handle = setTimeout(guard(fn, "setTimeout"), ms);
        onCleanup(() => clearTimeout(handle));
        return handle;
      },
      setInterval(fn, ms) {
        const handle = setInterval(guard(fn, "setInterval"), ms);
        onCleanup(() => clearInterval(handle));
        return handle;
      },
      listen(target, type, fn, options) {
        listen(target, type, guard(fn, `listen ${type}`), options);
      },
      onCleanup,

      storage: {
        get: (key) => call("storage.get", { site: def.site, key }),
        set: (key, value) => call("storage.set", { site: def.site, key, value }),
        all: () => call("storage.get", { site: def.site }),
      },

      async fetch(url, init = {}) {
        const result = await call("fetch", {
          site: def.site,
          url: new URL(url, location.href).href,
          init: { method: init.method, headers: init.headers, body: typeof init.body === "string" ? init.body : undefined },
        });
        return new Response(result.body, { status: result.status, headers: result.headers });
      },

      desktop: {
        call: () => Promise.reject(new Error("There's no config.js yet (KEYS.md).")),
      },

      log: (...args) => {
        const message = args.map((arg) => (typeof arg === "string" ? arg : safeJson(arg))).join(" ");
        record(state.logs, id, { level: "log", message, at: Date.now() }, MAX_LOGS);
        send({ type: "log", part: id, level: "log", message });
      },
      warn: (...args) => {
        const message = args.map((arg) => (typeof arg === "string" ? arg : safeJson(arg))).join(" ");
        record(state.logs, id, { level: "warn", message, at: Date.now() }, MAX_LOGS);
        send({ type: "log", part: id, level: "warn", message });
      },
    };
    return { site, cleanups, observers };
  }

  function safeJson(value) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  function moveFocus(selector, direction) {
    const elements = [...document.querySelectorAll(selector)].filter((element) => element.getClientRects().length > 0);
    if (elements.length === 0) return null;
    const active = document.activeElement;
    let index = elements.findIndex((element) => element === active || element.contains(active));
    index = index < 0 ? (direction > 0 ? 0 : elements.length - 1) : Math.min(elements.length - 1, Math.max(0, index + direction));
    const element = elements[index];
    if (!element.matches("a[href], button, input, select, textarea, [tabindex]")) element.tabIndex = -1;
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "nearest" });
    return element;
  }

  const contextListeners = new Set();

  /** The context as a part of `siteName` sees it: its own site's settings, not every site's. */
  function contextFor(siteName) {
    const { thread, project, shell, sites } = state.context;
    return { thread, project, shell, settings: (sites && sites[siteName]) || {} };
  }

  function inScope(scope, context) {
    if (!scope || scope === "global") return true;
    if (scope.project) return context.project?.id === scope.project;
    if (scope.thread) return context.thread?.id === scope.thread;
    return true;
  }

  // Chrome's match patterns, as store.ts reads them: a part goes with its site's
  // patterns, so a tab that navigates to another site gets that site's parts.
  const patternCache = new Map();
  function patternRegex(pattern) {
    if (patternCache.has(pattern)) return patternCache.get(pattern);
    let regex = null;
    if (pattern === "<all_urls>") regex = /^(https?|file):/;
    else {
      const match = /^(\*|https?|file|wss?):\/\/([^/]*)(\/.*)$/.exec(pattern);
      if (match) {
        const [, scheme, host, path] = match;
        const escape = (text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
        const schemes = scheme === "*" ? "https?" : escape(scheme);
        const hosts = host === "*" ? "[^/]*" : host.startsWith("*.") ? `(?:[^/]*\\.)?${escape(host.slice(2))}` : escape(host);
        const paths = path.split("*").map(escape).join(".*");
        regex = new RegExp(`^${schemes}://${hosts}(?::\\d+)?${paths}$`, "i");
      }
    }
    patternCache.set(pattern, regex);
    return regex;
  }
  function urlMatches(patterns, url) {
    return patterns.some((pattern) => patternRegex(pattern)?.test(url));
  }
  function siteApplies(def) {
    const url = location.href.replace(/#.*$/, "");
    return urlMatches(def.matches, url) && !urlMatches(def.excludes, url);
  }

  function applies(def) {
    if (!def.spec.enabled) return false;
    if (!siteApplies(def)) return false;
    if (!isTop && !def.spec.allFrames) return false;
    return inScope(def.siteScope, state.context) && inScope(def.spec.scope, state.context);
  }

  function start(id, def) {
    const instance = { def, cleanups: [], observers: [], started: false };
    state.running.set(id, instance);
    const go = () => {
      if (state.running.get(id) !== instance) return;
      instance.started = true;
      const { site, cleanups, observers } = makeSite(id, def);
      instance.cleanups = cleanups;
      instance.observers = observers;
      try {
        if (def.css) site.css(def.css);
        if (def.run) {
          const exports = {};
          def.run(site, exports);
          if (typeof exports.default === "function") {
            const result = exports.default(site);
            if (typeof result === "function") cleanups.push(result);
            else if (result && typeof result.then === "function") {
              result.then(
                (cleanup) => typeof cleanup === "function" && (state.running.get(id) === instance ? cleanups.push(cleanup) : cleanup()),
                (error) => reportError(id, error, "start"),
              );
            }
          }
        }
      } catch (error) {
        reportError(id, error, "start");
      }
    };
    // Stylesheets always go in at document start, so the page never shows unstyled.
    const runAt = def.run ? def.spec.runAt : "start";
    if (runAt === "start" || document.readyState === "complete" || (runAt === "ready" && document.readyState === "interactive")) go();
    else if (runAt === "ready") document.addEventListener("DOMContentLoaded", go, { once: true });
    else addEventListener("load", () => (globalThis.requestIdleCallback ? requestIdleCallback(go) : setTimeout(go, 0)), { once: true });
  }

  function stopPart(id) {
    const instance = state.running.get(id);
    if (!instance) return;
    state.running.delete(id);
    for (const cleanup of instance.cleanups.reverse()) {
      try {
        cleanup();
      } catch (error) {
        reportError(id, error, "cleanup");
      }
    }
  }

  function sync() {
    for (const [id, instance] of state.running) {
      const def = state.defs.get(id);
      if (!def || def.hash !== instance.def.hash || !applies(def)) stopPart(id);
    }
    for (const [id, def] of state.defs) {
      if (!state.running.has(id) && applies(def)) start(id, def);
    }
  }

  function setParts(parts) {
    const next = new Map(parts.map((def) => [def.id, def]));
    for (const [id, def] of next) {
      const previous = state.defs.get(id);
      if (!previous || previous.hash !== def.hash) {
        state.errors.delete(id);
        state.logs.delete(id);
      }
    }
    state.defs = next;
  }

  const api = {
    boot(data) {
      if (data.context) state.context = data.context;
      if (data.theme) state.theme = data.theme;
      setParts(data.parts || []);
      sync();
    },
    update(data) {
      const contextChanged = data.context && JSON.stringify(data.context) !== JSON.stringify(state.context);
      if (data.context) state.context = data.context;
      if (data.theme) state.theme = data.theme;
      if (data.parts) setParts(data.parts);
      sync();
      if (contextChanged) {
        for (const listener of contextListeners) listener();
      }
      return api.report();
    },
    connected() {
      flush();
      return queued.length;
    },
    reply(id, ok, value) {
      const entry = waiting.get(id);
      if (!entry) return;
      waiting.delete(id);
      if (ok) entry.resolve(value);
      else entry.reject(new Error(String(value)));
    },
    report() {
      const parts = [];
      for (const [id, def] of state.defs) {
        const instance = state.running.get(id);
        parts.push({
          id,
          hash: def.hash,
          applies: applies(def),
          running: Boolean(instance && instance.started),
          errors: state.errors.get(id) ?? [],
          logs: state.logs.get(id) ?? [],
          observers: instance ? instance.observers.map(({ selector, matched }) => ({ selector, matched })) : [],
          keys: [...bindings].filter((binding) => binding.part === id).map(({ keys, title }) => ({ keys, title })),
        });
      }
      return { url: location.href, top: isTop, context: state.context, parts };
    },
  };
  Object.defineProperty(globalThis, "__plutoniumSites", { value: api });
})();

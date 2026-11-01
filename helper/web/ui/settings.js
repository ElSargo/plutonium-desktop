// Settings: what every shell's preferences have in common (UI_LIBRARY.md).
// A store keeps JSON values with the shell (shell.storage: outside its
// folder, so an update of the shell doesn't touch them), mirrored in the
// page's localStorage for when there's no helper. Settings are a set of
// values with defaults over a store, with a "change" event. A schema
// describes them (label, kind, choices) once, so any shell can draw them: the
// generic form below, or its own rows (Charon's Settings app).

/**
 * A store of JSON values: the shell's storage, else localStorage under `prefix`.
 * @param {{ storage?: { get(key: string): Promise<any>, set(key: string, value: any): Promise<void> }, available?: boolean } | null} shell
 * @param {string} prefix localStorage's key prefix ("gnome.")
 * @param {Storage | null} [local]
 */
export function shellStore(shell, prefix, local = globalThis.localStorage ?? null) {
  const timers = new Map();
  return {
    async get(key) {
      try {
        if (shell?.available && shell.storage) {
          const value = await shell.storage.get(key);
          if (value !== undefined) return value;
        }
      } catch {}
      try {
        return JSON.parse(local?.getItem(`${prefix}${key}`) ?? "null") ?? undefined;
      } catch {
        return undefined;
      }
    },
    set(key, value) {
      try {
        local?.setItem(`${prefix}${key}`, JSON.stringify(value));
      } catch {}
      if (!shell?.available || !shell.storage) return;
      clearTimeout(timers.get(key));
      timers.set(key, setTimeout(() => shell.storage.set(key, value).catch(() => {}), 300));
    },
  };
}

/**
 * Values with defaults, kept in a store under one key.
 * Events: "change" ({ detail: { key, value } }; key null after load()).
 */
export class Settings extends EventTarget {
  /**
   * @param {{ store: { get(key: string): Promise<any>, set(key: string, value: any): void }, key?: string, defaults: Record<string, any> }} options
   */
  constructor({ store, key = "prefs", defaults }) {
    super();
    this._store = store;
    this._key = key;
    this.defaults = { ...defaults };
    this._values = { ...defaults };
  }

  /** Reads what's kept. */
  async load() {
    const saved = await this._store.get(this._key);
    this._values = { ...this.defaults, ...(saved && typeof saved === "object" ? saved : {}) };
    this.dispatchEvent(new CustomEvent("change", { detail: { key: null, value: null } }));
    return this;
  }

  get(key) {
    return this._values[key];
  }

  /** Every value (a copy). */
  all() {
    return { ...this._values };
  }

  set(key, value) {
    if (Object.is(this._values[key], value)) return;
    this._values[key] = value;
    this._save();
    this.dispatchEvent(new CustomEvent("change", { detail: { key, value } }));
  }

  /** Several at once (one save, a "change" each). */
  patch(values) {
    for (const [key, value] of Object.entries(values)) {
      this._values[key] = value;
      this.dispatchEvent(new CustomEvent("change", { detail: { key, value } }));
    }
    this._save();
  }

  reset(key) {
    this.set(key, this.defaults[key]);
  }

  /** Calls `fn(key, value)` on each change; returns a function that stops it. */
  subscribe(fn) {
    const listener = (event) => fn(event.detail.key, event.detail.value);
    this.addEventListener("change", listener);
    return () => this.removeEventListener("change", listener);
  }

  _save() {
    // Only what differs from the defaults, so a new default reaches those who never changed it.
    const changed = {};
    for (const [key, value] of Object.entries(this._values)) {
      if (JSON.stringify(value) !== JSON.stringify(this.defaults[key])) changed[key] = value;
    }
    this._store.set(this._key, changed);
  }
}

/**
 * @typedef {object} SettingSpec
 * @property {string} key
 * @property {string} label
 * @property {"switch" | "choice" | "range" | "text"} kind
 * @property {string} [help]
 * @property {[any, string][]} [choices]       a choice's values and labels
 * @property {number} [min] @property {number} [max] @property {number} [step] @property {string} [unit]
 * @property {string} [placeholder]
 * @property {(values: Record<string, any>) => boolean} [shown]  whether it applies now
 */

/**
 * A generic form for `schema`'s settings: a row each, changed as you go.
 * Themed with the --tray-* variables (widgets.js).
 * @param {Settings} settings
 * @param {SettingSpec[]} schema
 */
export function settingsForm(settings, schema) {
  const form = document.createElement("div");
  form.className = "pl-form";
  const draw = () => {
    const values = settings.all();
    form.replaceChildren();
    for (const spec of schema) {
      if (spec.shown && !spec.shown(values)) continue;
      form.append(settingRow(settings, spec, values[spec.key]));
    }
  };
  draw();
  const stop = settings.subscribe((key) => {
    if (!form.isConnected) return stop();
    // Not while a field in it is being edited: its own change brought us here.
    if (key !== null && form.contains(document.activeElement) && document.activeElement?.matches("input[type=text]")) return;
    draw();
  });
  return form;
}

function settingRow(settings, spec, value) {
  const row = document.createElement("label");
  row.className = `pl-row pl-${spec.kind}`;
  const text = document.createElement("span");
  text.className = "pl-label";
  text.textContent = spec.label;
  if (spec.help) {
    const help = document.createElement("small");
    help.textContent = spec.help;
    text.append(help);
  }
  row.append(text);
  if (spec.kind === "switch") {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!value;
    input.addEventListener("change", () => settings.set(spec.key, input.checked));
    row.append(input);
  } else if (spec.kind === "choice") {
    const select = document.createElement("select");
    for (const [choice, label] of spec.choices ?? []) {
      const option = document.createElement("option");
      option.value = JSON.stringify(choice);
      option.textContent = label;
      option.selected = Object.is(choice, value);
      select.append(option);
    }
    select.addEventListener("change", () => settings.set(spec.key, JSON.parse(select.value)));
    row.append(select);
  } else if (spec.kind === "range") {
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(spec.min ?? 0);
    input.max = String(spec.max ?? 100);
    input.step = String(spec.step ?? 1);
    input.value = String(value);
    const shown = document.createElement("span");
    shown.className = "pl-value";
    shown.textContent = `${value}${spec.unit ?? ""}`;
    input.addEventListener("input", () => {
      shown.textContent = `${input.value}${spec.unit ?? ""}`;
      settings.set(spec.key, Number(input.value));
    });
    row.append(input, shown);
  } else {
    const input = document.createElement("input");
    input.type = "text";
    input.value = value ?? "";
    input.placeholder = spec.placeholder ?? "";
    input.spellcheck = false;
    input.addEventListener("change", () => settings.set(spec.key, input.value.trim()));
    row.append(input);
  }
  return row;
}

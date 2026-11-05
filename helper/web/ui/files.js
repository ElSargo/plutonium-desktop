// The file manager's core (docs/features/FILE_MANAGER.md), with no UI, so any shell can
// draw its own on it: the helper's file API, the Yazi-style keymap, the fuzzy matcher and
// what a list of entries is sorted and filtered by. Served at /v1/ui/files.js.

/** @typedef {{ name: string, path: string, kind: "dir" | "file", size: number, modified: number, hidden: boolean, link?: boolean }} FileEntry */
/** @typedef {{ key: string, ctrl?: boolean, alt?: boolean, shift?: boolean, meta?: boolean }} KeyPress */

// --- Keys ---------------------------------------------------------------------------

/**
 * The default keys, Yazi's where it has one: [keys, command, what it does]. Keys are a
 * sequence: "gg", ",m", "<C-d>", "<Space>". A view reads left/right/up/down in its own way
 * (the grid moves through its cells; the tree folds).
 */
export const DEFAULT_KEYMAP = [
  ["j", "down", "Next item"],
  ["<Down>", "down", "Next item"],
  ["k", "up", "Previous item"],
  ["<Up>", "up", "Previous item"],
  ["h", "left", "Parent folder, or fold"],
  ["<Left>", "left", "Parent folder, or fold"],
  ["l", "right", "Open a folder, or unfold"],
  ["<Right>", "right", "Open a folder, or unfold"],
  ["<Backspace>", "parent", "Parent folder"],
  ["<Enter>", "activate", "Open, or choose in a picker"],
  ["o", "open", "Open with its app"],
  ["gg", "top", "First item"],
  ["G", "bottom", "Last item"],
  ["<C-u>", "halfPageUp", "Half a page up"],
  ["<C-d>", "halfPageDown", "Half a page down"],
  ["<C-b>", "pageUp", "A page up"],
  ["<C-f>", "pageDown", "A page down"],
  ["<PageUp>", "pageUp", "A page up"],
  ["<PageDown>", "pageDown", "A page down"],
  ["gh", "goHome", "Go home"],
  ["gd", "goDownloads", "Go to Downloads"],
  ["gp", "goProject", "Go to the project"],
  ["g/", "goRoot", "Go to the root"],
  ["gl", "goPath", "Go to a path"],
  ["H", "back", "Back"],
  ["L", "forward", "Forward"],
  ["<Space>", "toggleSelect", "Select, and next"],
  ["v", "visual", "Select a range"],
  ["<C-a>", "selectAll", "Select all"],
  ["<C-r>", "invertSelection", "Invert the selection"],
  ["<Esc>", "escape", "Clear, or close"],
  ["y", "yank", "Copy"],
  ["x", "cut", "Cut"],
  ["p", "paste", "Paste"],
  ["P", "pasteOverwrite", "Paste, replacing"],
  ["-", "pasteLink", "Paste as a link"],
  ["Y", "clearYank", "Forget what's copied"],
  ["X", "clearYank", "Forget what's copied"],
  ["c", "copyPath", "Copy the path"],
  ["d", "trash", "Move to the trash"],
  ["D", "delete", "Delete for good"],
  ["a", "create", "New file, or folder with a trailing /"],
  ["r", "rename", "Rename"],
  ["u", "undo", "Undo"],
  [".", "toggleHidden", "Show or hide dot files"],
  ["f", "filter", "Filter this folder"],
  ["/", "find", "Find in this folder"],
  ["n", "findNext", "Next match"],
  ["N", "findPrevious", "Previous match"],
  ["z", "fuzzy", "Fuzzy find under this folder"],
  [",n", "sortName", "Sort by name"],
  [",m", "sortModified", "Sort by date"],
  [",s", "sortSize", "Sort by size"],
  [",e", "sortExtension", "Sort by type"],
  [",r", "sortReverse", "Reverse the sort"],
  ["1", "viewTree", "Tree view"],
  ["2", "viewColumns", "Three columns"],
  ["3", "viewGrid", "Grid view"],
  ["i", "togglePreview", "Show or hide the preview"],
  ["b", "carry", "Pick up and carry: a drag with no mouse"],
  ["~", "help", "These keys"],
  ["?", "help", "These keys"],
];

const NAMED_KEYS = {
  " ": "Space",
  Enter: "Enter",
  Escape: "Esc",
  Backspace: "Backspace",
  Tab: "Tab",
  Delete: "Delete",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Home: "Home",
  End: "End",
};

/** A key press in the keymap's spelling ("j", "G", "<C-d>"), or "" for a bare modifier. */
export function keyName({ key, ctrl, alt, shift, meta }) {
  if (["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Dead"].includes(key)) return "";
  const named = NAMED_KEYS[key] ?? (key.length > 1 ? key : "");
  const modifiers = `${ctrl ? "C-" : ""}${alt ? "A-" : ""}${meta ? "D-" : ""}`;
  if (named) return `<${modifiers}${shift ? "S-" : ""}${named}>`;
  // A letter carries its own case and a symbol its own shift.
  const letter = ctrl || alt || meta ? key.toLowerCase() : key;
  return modifiers ? `<${modifiers}${shift ? "S-" : ""}${letter}>` : letter;
}

/** "g" "g", "<C-d>": a sequence's keys. */
export function splitKeys(sequence) {
  return sequence.match(/<[^>]+>|./gu) ?? [];
}

/**
 * Turns key presses into commands. `overrides` are [keys, command] pairs on top of the
 * defaults (a null command unbinds).
 */
export class Keymap {
  constructor(overrides = []) {
    /** @type {Map<string, string>} */
    this.bindings = new Map(DEFAULT_KEYMAP.map(([keys, command]) => [keys, command]));
    for (const [keys, command] of overrides) {
      if (command) this.bindings.set(keys, command);
      else this.bindings.delete(keys);
    }
    this.pending = "";
  }

  /**
   * Takes a key press. `command` when a binding is complete; `pending` is what's waiting for
   * more keys ("g"); `handled` is false for a key that means nothing here, which should go on
   * to the page.
   * @param {KeyPress} press
   * @returns {{ command: string | null, pending: string, handled: boolean }}
   */
  feed(press) {
    const name = keyName(press);
    if (!name) return { command: null, pending: this.pending, handled: false };
    const sequence = this.pending + name;
    const command = this.bindings.get(sequence);
    if (command) {
      this.pending = "";
      return { command, pending: "", handled: true };
    }
    if ([...this.bindings.keys()].some((keys) => keys.startsWith(sequence))) {
      this.pending = sequence;
      return { command: null, pending: sequence, handled: true };
    }
    // A wrong second key ends the sequence, and is used up by it.
    const hadPending = this.pending !== "";
    this.pending = "";
    return { command: null, pending: "", handled: hadPending };
  }

  reset() {
    this.pending = "";
  }

  /** [keys, command, description] for a help list, with this map's keys. */
  help() {
    const described = new Map(DEFAULT_KEYMAP.map(([, command, description]) => [command, description]));
    return [...this.bindings].map(([keys, command]) => [keys, command, described.get(command) ?? command]);
  }
}

// --- The fuzzy matcher --------------------------------------------------------------

const BOUNDARY = /[/\\\-_. ]/;

/**
 * Scores `text` against `query` as fzf does: every query character in order, more for
 * consecutive ones, for the start of a word or the file's name, and for a short path. Null
 * if it doesn't match. Case is ignored unless the query has a capital.
 * @returns {{ score: number, positions: number[] } | null}
 */
export function fuzzyMatch(query, text) {
  if (!query) return { score: 0, positions: [] };
  const smart = query !== query.toLowerCase();
  const needle = smart ? query : query.toLowerCase();
  const haystack = smart ? text : text.toLowerCase();
  if (needle.length > haystack.length) return null;
  // Quickly out: the characters must come in order at all.
  for (let i = 0, from = 0; i < needle.length; i++, from++) {
    from = haystack.indexOf(needle[i], from);
    if (from < 0) return null;
  }
  const nameStart = text.replace(/\/$/, "").lastIndexOf("/") + 1;
  const bonus = (index) => {
    let value = 0;
    if (index === 0 || BOUNDARY.test(text[index - 1])) value += 8;
    else if (text[index] !== text[index].toLowerCase() && text[index - 1] === text[index - 1].toLowerCase()) value += 6;
    if (index >= nameStart) value += 2;
    if (index === nameStart) value += 6;
    return value;
  };
  // best[i][j]: the best score with needle[0..i] matched, needle[i] at haystack[j].
  const width = haystack.length;
  let previous = new Float64Array(width).fill(-Infinity);
  const from = [];
  for (let i = 0; i < needle.length; i++) {
    const current = new Float64Array(width).fill(-Infinity);
    const back = new Int32Array(width).fill(-1);
    let bestBefore = -Infinity;
    let bestIndex = -1;
    for (let j = i; j < width; j++) {
      if (i > 0 && j > 0 && previous[j - 1] > bestBefore) {
        bestBefore = previous[j - 1];
        bestIndex = j - 1;
      }
      if (haystack[j] !== needle[i]) continue;
      if (i === 0) {
        current[j] = 16 + bonus(j) - Math.min(j, 8) * 0.25;
        continue;
      }
      const gapped = bestBefore === -Infinity ? -Infinity : bestBefore + 16 + bonus(j) - Math.min(j - bestIndex - 1, 12);
      const consecutive = previous[j - 1] === -Infinity || j === 0 ? -Infinity : previous[j - 1] + 16 + bonus(j) + 8;
      if (consecutive >= gapped && consecutive !== -Infinity) {
        current[j] = consecutive;
        back[j] = j - 1;
      } else if (gapped !== -Infinity) {
        current[j] = gapped;
        back[j] = bestIndex;
      }
    }
    from.push(back);
    previous = current;
  }
  let end = -1;
  let score = -Infinity;
  for (let j = 0; j < width; j++) {
    if (previous[j] > score) {
      score = previous[j];
      end = j;
    }
  }
  if (end < 0) return null;
  const positions = [];
  for (let i = needle.length - 1, j = end; i >= 0; i--) {
    positions.unshift(j);
    j = from[i][j];
  }
  return { score: score - text.length * 0.05, positions };
}

/**
 * The best `limit` of `paths` for `query`, best first; with an empty query, the first ones.
 * Words in the query are separate terms, each of which has to match.
 * @returns {{ path: string, score: number, positions: number[] }[]}
 */
export function fuzzyFilter(query, paths, limit = 200) {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return paths.slice(0, limit).map((path) => ({ path, score: 0, positions: [] }));
  const found = [];
  for (const path of paths) {
    let score = 0;
    const positions = [];
    for (const term of terms) {
      const match = fuzzyMatch(term, path);
      if (!match) {
        score = -Infinity;
        break;
      }
      score += match.score;
      positions.push(...match.positions);
    }
    if (score !== -Infinity) found.push({ path, score, positions: [...new Set(positions)].sort((a, b) => a - b) });
  }
  return found.sort((a, b) => b.score - a.score || a.path.length - b.path.length).slice(0, limit);
}

/** Where `query`'s terms match `path`, for highlighting a result found elsewhere. */
export function fuzzyPositions(query, path) {
  const positions = new Set();
  for (const term of query.trim().split(/\s+/).filter(Boolean)) {
    for (const position of fuzzyMatch(term, path)?.positions ?? []) positions.add(position);
  }
  return positions;
}

// --- Lists --------------------------------------------------------------------------

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function extensionOf(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Entries in an order: folders first, then by `sort`.
 * @param {readonly FileEntry[]} entries
 * @param {"name" | "modified" | "size" | "extension"} sort
 */
export function sortEntries(entries, sort = "name", reverse = false) {
  const compare = {
    name: (a, b) => collator.compare(a.name, b.name),
    modified: (a, b) => b.modified - a.modified,
    size: (a, b) => b.size - a.size,
    extension: (a, b) => collator.compare(extensionOf(a.name), extensionOf(b.name)),
  }[sort];
  const sign = reverse ? -1 : 1;
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return sign * compare(a, b) || collator.compare(a.name, b.name);
  });
}

/** Whether `name` matches a picker's pattern ("*.png"), ignoring case. */
export function globMatch(pattern, name) {
  const source = pattern.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${source}$`, "i").test(name);
}

const KINDS = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"],
  video: ["mp4", "webm", "mkv", "mov", "avi"],
  audio: ["mp3", "ogg", "opus", "flac", "wav", "m4a"],
  archive: ["zip", "tar", "gz", "xz", "zst", "bz2", "7z", "rar"],
  document: ["pdf", "doc", "docx", "odt", "xls", "xlsx", "ods", "ppt", "pptx", "odp"],
};

/** "image", "video", "audio", "archive", "document", or "file". */
export function fileKind(name) {
  const extension = extensionOf(name);
  for (const [kind, extensions] of Object.entries(KINDS)) if (extensions.includes(extension)) return kind;
  return "file";
}

/** Whether the helper serves `name` raw for a preview (svg can run, so it doesn't). */
export function hasRawPreview(name) {
  const extension = extensionOf(name);
  return extension !== "svg" && extension !== "avi" && extension !== "m4a" && ["image", "video", "audio"].includes(fileKind(name)) || extension === "pdf";
}

export function formatSize(size) {
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function parentOf(path) {
  if (path === "/") return null;
  const slash = path.replace(/\/+$/, "").lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

export function joinPath(dir, name) {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

// --- The helper's API ---------------------------------------------------------------

/** How to undo a finished job, as a job request or a rename; null if it can't be undone. */
export function undoOf(job) {
  const results = job.results.filter((result) => result.to);
  if (job.state !== "done" || results.length === 0) return null;
  if (job.op === "copy" || job.op === "link") return { op: "trash", paths: results.map((result) => result.to) };
  if (job.op === "trash") return { op: "restore", paths: results.map((result) => result.to) };
  if (job.op === "move") {
    // Everything back to where it came from, folder by folder.
    const byFolder = new Map();
    for (const { from, to } of results) {
      const folder = parentOf(from);
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), to]);
    }
    return [...byFolder].map(([target, paths]) => ({ op: "move", paths, target, conflict: "fail" }));
  }
  return null;
}

/** The helper's file API, from a shell page at `origin` (the helper's). */
export class FilesClient {
  constructor(origin) {
    this.origin = origin;
  }

  async _json(path, init) {
    const response = await fetch(`${this.origin}${path}`, init);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `The helper said ${response.status}.`);
    return body;
  }

  _post(path, body) {
    return this._json(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  list(dir, { hidden = false } = {}) {
    return this._json(`/v1/files?dir=${encodeURIComponent(dir)}${hidden ? "&hidden=1" : ""}`);
  }

  places() {
    return this._json("/v1/files/places");
  }

  /** The best matches under `dir`, from the helper's index: `{paths, matched, total, scanning}`. */
  find(dir, query, { hidden = false } = {}) {
    return this._json(`/v1/files/find?dir=${encodeURIComponent(dir)}&q=${encodeURIComponent(query)}${hidden ? "&hidden=1" : ""}`);
  }

  /** `path` (relative to `dir`) was chosen for `query`: it ranks higher next time. */
  findOpened(dir, query, path) {
    return this._post("/v1/files/find/opened", { dir, query, path });
  }

  preview(path) {
    return this._json(`/v1/files/preview?path=${encodeURIComponent(path)}`);
  }

  /** The URL of a media file; load it with crossorigin="anonymous", so the helper sees the origin. */
  rawUrl(path) {
    return `${this.origin}/v1/files/raw?path=${encodeURIComponent(path)}`;
  }

  makeFolder(path) {
    return this._post("/v1/files/folder", { path });
  }

  makeFile(path) {
    return this._post("/v1/files/file", { path });
  }

  rename(path, name) {
    return this._post("/v1/files/rename", { path, name });
  }

  open(path, { thread = "", show = false } = {}) {
    return this._post("/v1/files/open", { path, thread, show });
  }

  /** Saves a dropped file that has no path of its own (a page's) into `dir`. */
  upload(dir, file) {
    const query = `dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`;
    return this._json(`/v1/files/upload?${query}`, { method: "POST", body: file });
  }

  startJob(request) {
    return this._post("/v1/files/jobs", request);
  }

  job(id) {
    return this._json(`/v1/files/jobs/${id}`);
  }

  cancelJob(id) {
    return this._post(`/v1/files/jobs/${id}/cancel`, {});
  }

  /** Runs a job to its end, calling `progress` as it goes. Resolves with the finished job. */
  async runJob(request, progress = () => {}) {
    let job = await this.startJob(request);
    for (;;) {
      progress(job);
      if (job.state !== "running") return job;
      await new Promise((resolve) => setTimeout(resolve, 120));
      job = await this.job(job.id);
    }
  }

  /** Calls `changed` when folder `dir` changes; the result stops watching. */
  watch(dir, changed) {
    const source = new EventSource(`${this.origin}/v1/files/watch?dir=${encodeURIComponent(dir)}`);
    source.onmessage = () => changed();
    return () => source.close();
  }
}

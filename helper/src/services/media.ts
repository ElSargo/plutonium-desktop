// The media service (DESKTOP_SERVICES.md, "media"): what's playing, and
// play/pause, next and previous. The players are the MPRIS ones on the
// session bus (mpv, Spotify, Firefox…), watched through NameOwnerChanged and
// PropertiesChanged, and the browser's own: its active media session (a tab,
// a shell page) comes through the Plutonium DevTools domain (`BrowserMedia`),
// which knows the tab. The browser is on MPRIS too (LINUX_COMPAT.md), as
// chromium.instance<pid>; that's the same session, so it's left out. The
// most recently active player comes first; it's the one the media keys
// control.
import { DBusConnection, type Message } from "../dbus.ts";
import { ServiceError, type DesktopService } from "../services.ts";

const MPRIS = "org.mpris.MediaPlayer2";
const MPRIS_PATH = "/org/mpris/MediaPlayer2";
const PLAYER = `${MPRIS}.Player`;
const PROPERTIES = "org.freedesktop.DBus.Properties";
const BUS = "org.freedesktop.DBus";
/** playerctld mirrors another player: it would show it twice. */
const PROXIES = new Set([`${MPRIS}.playerctld`]);

export interface MediaPlayer {
  /** Its bus name ("org.mpris.MediaPlayer2.mpv"), or "browser". */
  readonly id: string;
  /** What it calls itself ("mpv"), or for the browser, the site's. */
  readonly name: string;
  readonly status: "playing" | "paused" | "stopped";
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  readonly artUrl: string | null;
  /** Seconds, or null. */
  readonly length: number | null;
  readonly canPlay: boolean;
  readonly canPause: boolean;
  readonly canGoNext: boolean;
  readonly canGoPrevious: boolean;
  /** The browser tab playing, for "browser" (when it's one of the shells' tabs). */
  readonly tab?: number;
}

export interface MediaState {
  readonly available: boolean;
  /** Most recently active first. */
  readonly players: MediaPlayer[];
  /** players[0]'s id: what play-pause and the keys control. */
  readonly active: string | null;
}

/** The browser's active media session, as the Plutonium DevTools domain gives it. */
export interface BrowserSession {
  readonly playing: boolean;
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  readonly source: string;
  /** Media Session actions it handles: "play", "pause", "nexttrack", "previoustrack", … */
  readonly actions: string[];
  readonly tab?: number;
}

/** The browser's side (desktop.ts): its session now, its changes, and actions on it. */
export interface BrowserMedia {
  session(): Promise<BrowserSession | null>;
  /** "play", "pause", "play-pause", "next", "previous", "stop". */
  action(action: string): Promise<void>;
  /** Calls `listener` with each new session (null when it's gone). */
  onChange(listener: (session: BrowserSession | null) => void): void;
  /** The browser process's pid: its own MPRIS player (chromium.instance<pid>) is this one again. */
  pid?(): Promise<number | null>;
}

export interface MediaOptions {
  /** The session bus (default $DBUS_SESSION_BUS_ADDRESS). */
  readonly address?: string;
  readonly browser?: BrowserMedia;
}

const ACTIONS: Record<string, string> = {
  "play-pause": "PlayPause",
  play: "Play",
  pause: "Pause",
  stop: "Stop",
  next: "Next",
  previous: "Previous",
};

/** A player from its MPRIS properties (Player's and the root's). */
export function mprisPlayer(id: string, player: Map<string, unknown>, root: Map<string, unknown>): MediaPlayer {
  const metadata = (player.get("Metadata") as Map<string, unknown> | undefined) ?? new Map();
  const text = (key: string) => (typeof metadata.get(key) === "string" ? (metadata.get(key) as string) : "");
  const artists = metadata.get("xesam:artist");
  const length = Number(metadata.get("mpris:length"));
  const status = String(player.get("PlaybackStatus") ?? "Stopped").toLowerCase();
  const control = player.get("CanControl") !== false;
  return {
    id,
    name: String(root.get("Identity") ?? id.slice(MPRIS.length + 1).split(".")[0]),
    status: status === "playing" || status === "paused" ? status : "stopped",
    title: text("xesam:title"),
    artist: Array.isArray(artists) ? artists.join(", ") : typeof artists === "string" ? artists : "",
    album: text("xesam:album"),
    artUrl: text("mpris:artUrl") || null,
    length: length > 0 ? Math.round(length / 1e6) : null,
    canPlay: control && player.get("CanPlay") === true,
    canPause: control && player.get("CanPause") === true,
    canGoNext: control && player.get("CanGoNext") === true,
    canGoPrevious: control && player.get("CanGoPrevious") === true,
  };
}

function browserPlayer(session: BrowserSession): MediaPlayer {
  const can = (action: string) => session.actions.includes(action);
  return {
    id: "browser",
    name: session.source || "Browser",
    status: session.playing ? "playing" : "paused",
    title: session.title,
    artist: session.artist,
    album: session.album,
    artUrl: null,
    length: null,
    canPlay: can("play"),
    canPause: can("pause"),
    canGoNext: can("nexttrack"),
    canGoPrevious: can("previoustrack"),
    ...(session.tab !== undefined ? { tab: session.tab } : {}),
  };
}

export class MediaService implements DesktopService {
  readonly name = "media";
  private readonly options: MediaOptions;
  private bus: DBusConnection | null = null;
  private changed: (state: unknown) => void = () => {};
  private readonly players = new Map<string, MediaPlayer>();
  /** Bus name → its unique name, which its signals come from. */
  private readonly owners = new Map<string, string>();
  /** When each player last started playing (or was told to): the order. */
  private readonly lastActive = new Map<string, number>();
  private text = "";
  private tick = 0;

  constructor(options: MediaOptions = {}) {
    this.options = options;
  }

  async start(changed: (state: unknown) => void): Promise<void> {
    this.changed = changed;
    const browser = this.options.browser;
    if (browser) {
      browser.onChange((session) => {
        this.setPlayer("browser", session && browserPlayer(session));
        this.emit();
      });
      const session = await browser.session().catch(() => null);
      this.setPlayer("browser", session && browserPlayer(session));
    }
    const address = this.options.address ?? process.env.DBUS_SESSION_BUS_ADDRESS;
    try {
      if (!address) throw new Error("no DBUS_SESSION_BUS_ADDRESS");
      const bus = await DBusConnection.connect(address);
      this.bus = bus;
      bus.onSignal = (message) => this.onSignal(message);
      for (const rule of [
        `type='signal',sender='${BUS}',interface='${BUS}',member='NameOwnerChanged',arg0namespace='${MPRIS}'`,
        `type='signal',interface='${PROPERTIES}',member='PropertiesChanged',path='${MPRIS_PATH}'`,
      ]) {
        await this.dbus(BUS, "/org/freedesktop/DBus", BUS, "AddMatch", "s", [rule]);
      }
      const [names] = (await this.dbus(BUS, "/org/freedesktop/DBus", BUS, "ListNames")) as [string[]];
      await Promise.all(names.filter((name) => this.isPlayer(name)).map((name) => this.addPlayer(name)));
    } catch (error) {
      // Without a session bus, only the browser's player.
      console.warn(`media: no session bus: ${(error as Error).message}`);
    }
    this.emit();
  }

  async state(): Promise<MediaState> {
    const players = [...this.players.values()].sort(
      (a, b) => (this.lastActive.get(b.id) ?? 0) - (this.lastActive.get(a.id) ?? 0) || a.id.localeCompare(b.id),
    );
    return { available: this.bus !== null || this.options.browser !== undefined, players, active: players[0]?.id ?? null };
  }

  async call(action: string, args: Record<string, unknown>): Promise<MediaState> {
    const member = ACTIONS[action];
    if (!member) throw new ServiceError(404, `media has no action "${action}".`);
    const id = args.player === undefined ? (await this.state()).active : String(args.player);
    if (!id || !this.players.has(id)) throw new ServiceError(id ? 400 : 404, id ? `player: no player ${JSON.stringify(id)}.` : "Nothing is playing.");
    try {
      if (id === "browser") await this.options.browser!.action(action);
      else await this.dbus(id, MPRIS_PATH, PLAYER, member);
    } catch (error) {
      throw new ServiceError(502, `${id}: ${(error as Error).message}`);
    }
    // The one told to play is the one the keys go to next.
    this.lastActive.set(id, ++this.tick);
    if (id !== "browser") await this.readPlayer(id);
    this.emit();
    return this.state();
  }

  stop(): void {
    this.bus?.close();
    this.bus = null;
  }

  private isPlayer(name: string): boolean {
    return name.startsWith(`${MPRIS}.`) && !PROXIES.has(name);
  }

  /** The browser's own MPRIS player, which "browser" already is (with its tab). */
  private async isBrowsers(name: string): Promise<boolean> {
    const instance = /\.chromium\.instance(\d+)$/.exec(name);
    if (!instance || !this.options.browser?.pid) return false;
    return Number(instance[1]) === (await this.options.browser.pid().catch(() => null));
  }

  private dbus(destination: string, path: string, iface: string, member: string, signature = "", body: unknown[] = []) {
    if (!this.bus?.isOpen) return Promise.reject(new ServiceError(503, "No session bus."));
    return this.bus.call({ destination, path, interface: iface, member, signature, body });
  }

  private async addPlayer(name: string): Promise<void> {
    try {
      if (await this.isBrowsers(name)) return;
      const [owner] = (await this.dbus(BUS, "/org/freedesktop/DBus", BUS, "GetNameOwner", "s", [name])) as [string];
      this.owners.set(name, owner);
      await this.readPlayer(name);
    } catch {}
  }

  private async readPlayer(name: string): Promise<void> {
    const all = async (iface: string) =>
      ((await this.dbus(name, MPRIS_PATH, PROPERTIES, "GetAll", "s", [iface]))[0] as Map<string, unknown>);
    try {
      const [player, root] = await Promise.all([all(PLAYER), all(MPRIS).catch(() => new Map<string, unknown>())]);
      this.setPlayer(name, mprisPlayer(name, player, root));
    } catch {
      // Gone between the signal and the read.
    }
  }

  /** Adds, changes or (null) removes a player; one that starts playing goes first. */
  private setPlayer(id: string, player: MediaPlayer | null): void {
    const previous = this.players.get(id);
    if (!player) {
      this.players.delete(id);
      this.lastActive.delete(id);
      return;
    }
    this.players.set(id, player);
    if (player.status === "playing" && previous?.status !== "playing") this.lastActive.set(id, ++this.tick);
  }

  private onSignal(message: Message): void {
    if (message.interface === BUS && message.member === "NameOwnerChanged") {
      const [name, , owner] = (message.body ?? []) as [string, string, string];
      if (!this.isPlayer(name)) return;
      if (owner) {
        void this.addPlayer(name).then(() => this.emit());
      } else {
        this.owners.delete(name);
        this.setPlayer(name, null);
        this.emit();
      }
      return;
    }
    if (message.interface === PROPERTIES && message.member === "PropertiesChanged" && message.path === MPRIS_PATH) {
      for (const [name, owner] of this.owners) {
        if (owner === message.sender) void this.readPlayer(name).then(() => this.emit());
      }
    }
  }

  private emit(): void {
    void this.state().then((state) => {
      const text = JSON.stringify(state);
      if (text === this.text) return;
      this.text = text;
      this.changed(state);
    });
  }
}

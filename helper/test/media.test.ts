import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Variant } from "../src/dbus.ts";
import { type BrowserSession, MediaService, type MediaState } from "../src/services/media.ts";
import { FakeBus } from "./fixtures/fakeBus.ts";

const PROPERTIES = "org.freedesktop.DBus.Properties";
const PLAYER = "org.mpris.MediaPlayer2.Player";

/** An MPRIS player on the fake bus: PlayPause, Next and Previous change it and say so. */
function addPlayer(bus: FakeBus, name: string, identity: string, status: string, title: string, log: string[]) {
  const player: Record<string, Variant> = {
    PlaybackStatus: ["s", status],
    Metadata: ["a{sv}", new Map<string, Variant>([
      ["xesam:title", ["s", title]],
      ["xesam:artist", ["as", ["Artist A", "Artist B"]]],
      ["mpris:artUrl", ["s", "file:///tmp/art.png"]],
      ["mpris:length", ["x", 185_000_000]],
    ])],
    CanPlay: ["b", true],
    CanPause: ["b", true],
    CanGoNext: ["b", true],
    CanGoPrevious: ["b", false],
    CanControl: ["b", true],
  };
  const changed = () =>
    bus.signal(name, "/org/mpris/MediaPlayer2", PROPERTIES, "PropertiesChanged", "sa{sv}as", [PLAYER, new Map([["PlaybackStatus", player.PlaybackStatus]]), []]);
  bus.serveObject(name, "/org/mpris/MediaPlayer2", (method, body) => {
    if (method === `${PROPERTIES}.GetAll`) {
      const props = body[0] === PLAYER ? player : { Identity: ["s", identity] as Variant };
      return { signature: "a{sv}", body: [new Map(Object.entries(props))] };
    }
    if (method.startsWith(`${PLAYER}.`)) {
      const member = method.slice(PLAYER.length + 1);
      log.push(`${name} ${member}`);
      if (member === "PlayPause") player.PlaybackStatus = ["s", player.PlaybackStatus[1] === "Playing" ? "Paused" : "Playing"];
      changed();
      return { signature: "", body: [] };
    }
    return { error: "org.freedesktop.DBus.Error.UnknownMethod" };
  });
  return { player, changed };
}

async function until(states: MediaState[], match: (state: MediaState) => boolean): Promise<MediaState> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const found = states.findLast(match);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no such state; last ${JSON.stringify(states.at(-1))}`);
}

describe("media service", () => {
  let bus: FakeBus;
  let media: MediaService;
  const log: string[] = [];
  const states: MediaState[] = [];
  let browserListener: (session: BrowserSession | null) => void = () => {};

  before(async () => {
    bus = await FakeBus.start();
    addPlayer(bus, "org.mpris.MediaPlayer2.mpv", "mpv", "Paused", "Song One", log);
    addPlayer(bus, "org.mpris.MediaPlayer2.spotify", "Spotify", "Playing", "Song Two", log);
    // A proxy for another player: not shown.
    addPlayer(bus, "org.mpris.MediaPlayer2.playerctld", "playerctld", "Playing", "Song Two", log);
    media = new MediaService({
      address: bus.address,
      browser: {
        session: async () => null,
        action: async (action) => void log.push(`browser ${action}`),
        onChange: (listener) => (browserListener = listener),
      },
    });
    await media.start((state) => states.push(state as MediaState));
  });

  after(async () => {
    media.stop();
    await bus.stop();
  });

  test("lists the players, the playing one first", async () => {
    const state = await media.state();
    assert.deepEqual(state.players.map((player) => player.id), ["org.mpris.MediaPlayer2.spotify", "org.mpris.MediaPlayer2.mpv"]);
    assert.equal(state.active, "org.mpris.MediaPlayer2.spotify");
    assert.deepEqual(state.players[1], {
      id: "org.mpris.MediaPlayer2.mpv",
      name: "mpv",
      status: "paused",
      title: "Song One",
      artist: "Artist A, Artist B",
      album: "",
      artUrl: "file:///tmp/art.png",
      length: 185,
      canPlay: true,
      canPause: true,
      canGoNext: true,
      canGoPrevious: false,
    });
  });

  test("play-pause goes to the active player; one told to play goes first", async () => {
    await media.call("play-pause", {});
    assert.equal(log.at(-1), "org.mpris.MediaPlayer2.spotify PlayPause");
    const state = await media.call("play-pause", { player: "org.mpris.MediaPlayer2.mpv" });
    assert.equal(state.active, "org.mpris.MediaPlayer2.mpv");
    assert.equal(state.players[0]!.status, "playing");
    await media.call("next", {});
    assert.equal(log.at(-1), "org.mpris.MediaPlayer2.mpv Next");
    await assert.rejects(media.call("play-pause", { player: "nope" }), { status: 400 });
    await assert.rejects(media.call("shuffle", {}), { status: 404 });
  });

  test("a player that comes and goes", async () => {
    addPlayer(bus, "org.mpris.MediaPlayer2.vlc", "VLC", "Playing", "Film", log);
    bus.signal("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "NameOwnerChanged", "sss", [
      "org.mpris.MediaPlayer2.vlc", "", ":1.299",
    ]);
    await until(states, (state) => state.active === "org.mpris.MediaPlayer2.vlc");
    bus.dropService("org.mpris.MediaPlayer2.vlc");
    const state = await until(states, (state) => !state.players.some((player) => player.id === "org.mpris.MediaPlayer2.vlc"));
    assert.equal(state.active, "org.mpris.MediaPlayer2.mpv");
  });

  test("the browser's media session is a player too", async () => {
    browserListener({ playing: true, title: "A video", artist: "", album: "", source: "youtube.com", actions: ["play", "pause"], tab: 7 });
    const state = await until(states, (state) => state.active === "browser");
    assert.equal(state.players[0]!.name, "youtube.com");
    assert.equal(state.players[0]!.tab, 7);
    assert.equal(state.players[0]!.canGoNext, false);
    await media.call("play-pause", {});
    assert.equal(log.at(-1), "browser play-pause");
    browserListener(null);
    await until(states, (state) => !state.players.some((player) => player.id === "browser"));
  });
});

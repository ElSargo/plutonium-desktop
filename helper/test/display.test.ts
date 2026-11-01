import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ServiceError } from "../src/services.ts";
import { type BrowserDisplays, DisplayService, type DisplayState } from "../src/services/display.ts";

const MODE = { width: 1920, height: 1080, refreshRate: 60, scale: 1, native: true };
const rect = (x: number, width = 1280) => ({ x, y: 0, width, height: 800 });

/** A browser with two displays that records what it's asked. */
function fakeBrowser() {
  const log: unknown[] = [];
  let listener = () => {};
  const config = {
    displays: [
      {
        id: "21527264497198849",
        index: 1,
        name: "Built-in display",
        internal: true,
        primary: true,
        enabled: true,
        bounds: rect(0),
        workArea: rect(0),
        rotation: 0,
        scale: 2,
        zoom: 1,
        zooms: [0.8, 1, 1.25],
        mode: { ...MODE, width: 2560, height: 1600, scale: 2 },
        modes: [{ ...MODE, width: 2560, height: 1600, scale: 2 }],
      },
      {
        id: "7",
        index: 2,
        name: "LF24T370F",
        internal: false,
        primary: false,
        enabled: true,
        bounds: rect(1280, 1920),
        workArea: rect(1280, 1920),
        rotation: 0,
        scale: 1,
        zoom: 1,
        zooms: [1],
        mode: MODE,
        modes: [MODE, { ...MODE, width: 1280, height: 720, native: false }],
      },
    ],
    mirror: false,
    canMirror: true,
    pending: null,
  };
  const browser: BrowserDisplays = {
    config: async () => config as never,
    configure: async (change) => {
      log.push(change);
      if (change.mirror === true) throw new Error("Mirroring needs two displays");
      if (change.rotation === 90) {
        (config.displays[1] as { rotation: number }).rotation = 90;
        listener();
      }
    },
    openSwitcher: async (page) => void log.push({ open: page }),
    onChange: (next) => {
      listener = next;
    },
  };
  return { browser, log, config };
}

describe("display service", () => {
  test("the state is the browser's, available", async () => {
    const { browser } = fakeBrowser();
    const service = new DisplayService(browser);
    await service.start(() => {});
    const state = await service.state();
    assert.equal(state.available, true);
    assert.equal(state.displays.length, 2);
    assert.equal(state.displays[0]!.id, "21527264497198849");
  });

  test("without a browser: nothing, and actions refused", async () => {
    const service = new DisplayService(null);
    await service.start(() => {});
    assert.deepEqual(await service.state(), { available: false, displays: [], mirror: false, canMirror: false, pending: null });
    await assert.rejects(service.call("open-settings", {}), (error: ServiceError) => error.status === 409);
  });

  test("an older browser (no getDisplayConfig): not available", async () => {
    const service = new DisplayService({ ...fakeBrowser().browser, config: async () => null });
    assert.equal((await service.state()).available, false);
  });

  test("configure takes a display by number or id, and sends what it was given", async () => {
    const { browser, log } = fakeBrowser();
    const changes: DisplayState[] = [];
    const service = new DisplayService(browser);
    await service.start((state) => changes.push(state as DisplayState));
    const state = (await service.call("configure", { display: 2, rotation: 90 })) as DisplayState;
    assert.deepEqual(log.at(-1), { display: "7", rotation: 90 });
    assert.equal(state.displays[1]!.rotation, 90);
    assert.equal(changes.at(-1)!.displays[1]!.rotation, 90);
    await service.call("configure", {
      display: "21527264497198849",
      mode: { width: 2560, height: 1600, refreshRate: 60, extra: 1 },
      zoom: 1.25,
      primary: true,
      position: { x: 10.4, y: -3 },
      enabled: true,
      confirm: true,
    });
    assert.deepEqual(log.at(-1), {
      display: "21527264497198849",
      confirm: true,
      mode: { width: 2560, height: 1600, refreshRate: 60 },
      zoom: 1.25,
      primary: true,
      enabled: true,
      position: { x: 10, y: -3 },
    });
  });

  test("bad arguments are refused before the browser sees them", async () => {
    const { browser, log } = fakeBrowser();
    const service = new DisplayService(browser);
    const bad = async (action: string, args: Record<string, unknown>, status = 400) =>
      assert.rejects(service.call(action, args), (error: ServiceError) => error.status === status);
    await bad("configure", { display: 3, zoom: 1 });
    await bad("configure", { display: 1 });
    await bad("configure", { display: 1, rotation: 45 });
    await bad("configure", { display: 1, mode: { width: 0, height: 1 } });
    await bad("configure", { display: 1, primary: false });
    await bad("configure", { display: 1, position: { x: "a", y: 0 } });
    await bad("arrange", { layout: [] });
    await bad("set-mirror", {});
    await bad("open-settings", { page: "nope" });
    await bad("explode", {}, 404);
    assert.deepEqual(log, []);
  });

  test("arrange, mirror, keep and revert; the browser's refusal is a 400 with its reason", async () => {
    const { browser, log } = fakeBrowser();
    const service = new DisplayService(browser);
    await service.call("arrange", { layout: [{ display: 2, x: -1920.2, y: 0 }] });
    assert.deepEqual(log.at(-1), { layout: [{ display: "7", x: -1920, y: 0 }] });
    await assert.rejects(
      service.call("set-mirror", { on: true }),
      (error: ServiceError) => error.status === 400 && /two displays/.test(error.message),
    );
    await service.call("keep", {});
    assert.deepEqual(log.at(-1), { keep: true });
    await service.call("revert", {});
    assert.deepEqual(log.at(-1), { revert: true });
  });

  test("open-settings opens the switcher's page (Displays by default)", async () => {
    const { browser, log } = fakeBrowser();
    const service = new DisplayService(browser);
    assert.equal(await service.call("open-settings", {}), null);
    await service.call("open-settings", { page: "network" });
    assert.deepEqual(log, [{ open: "displays" }, { open: "network" }]);
  });
});

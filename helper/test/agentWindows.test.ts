import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AgentWindows, type AgentWindow } from "../src/agentWindows.ts";

function tracked(): { windows: AgentWindows; changes: AgentWindow[][] } {
  const windows = new AgentWindows();
  const changes: AgentWindow[][] = [];
  windows.onChange = (list) => changes.push(list);
  return { windows, changes };
}

describe("AgentWindows", () => {
  test("holds a size until the user takes control", () => {
    const { windows, changes } = tracked();
    assert.equal(windows.hold(1, 800, 600), true);
    assert.deepEqual(windows.get(1), { id: 1, width: 800, height: 600, userControl: false, busy: false });
    // The same size again isn't a change.
    windows.hold(1, 800, 600);
    assert.equal(changes.length, 1);

    windows.release(1);
    assert.deepEqual(windows.get(1), { id: 1, userControl: true, busy: false });
    // The user has it now: agents' sizes no longer hold.
    assert.equal(windows.hold(1, 640, 480), false);
    assert.equal(windows.get(1)?.width, undefined);
    // Releasing again changes nothing.
    const count = changes.length;
    windows.release(1);
    assert.equal(changes.length, count);
  });

  test("a size that follows the app takes the app's next size", () => {
    const { windows } = tracked();
    windows.hold(1, 300, 200, true);
    windows.follow(1, 320, 240);
    assert.equal(windows.get(1)?.width, 320);
    // A fixed hold doesn't follow.
    windows.hold(2, 300, 200);
    windows.follow(2, 320, 240);
    assert.equal(windows.get(2)?.width, 300);
    // Nor do sizes that aren't.
    windows.follow(1, 0, 240);
    assert.equal(windows.get(1)?.width, 320);
  });

  test("input makes a window busy for a while", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { windows, changes } = tracked();
    windows.touch(3);
    assert.equal(windows.get(3)?.busy, true);
    t.mock.timers.tick(3_000);
    windows.touch(3);
    t.mock.timers.tick(3_000);
    // Still busy: the second touch started the time again.
    assert.equal(windows.get(3)?.busy, true);
    t.mock.timers.tick(1_500);
    assert.equal(windows.get(3)?.busy, false);
    // Busy and not busy: two changes, not one per touch.
    assert.deepEqual(
      changes.map((list) => list.find((window) => window.id === 3)?.busy),
      [true, false],
    );
  });

  test("forgets windows that are gone", () => {
    const { windows, changes } = tracked();
    windows.hold(1, 10, 10);
    windows.hold(2, 10, 10);
    windows.prune(new Set([2]));
    assert.deepEqual(
      windows.list().map((window) => window.id),
      [2],
    );
    const count = changes.length;
    windows.prune(new Set([2]));
    assert.equal(changes.length, count);
  });
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { Appearance, isDark, isDarkDconf } from "../src/appearance.ts";
import { DBusConnection } from "../src/dbus.ts";

describe("appearance", () => {
  test("the portal's color-scheme values", () => {
    assert.equal(isDark(1), true);
    assert.equal(isDark(0), false);
    assert.equal(isDark(2), false);
    assert.equal(isDark(undefined), false);
  });

  test("without a portal, GNOME's dconf key (a fake dconf)", async () => {
    assert.equal(isDarkDconf("'prefer-dark'\n"), true);
    assert.equal(isDarkDconf("'default'"), false);
    const dir = mkdtempSync(join(tmpdir(), "appearance-"));
    const dconf = join(dir, "dconf");
    writeFileSync(dconf, `#!/bin/sh
if [ "$1" = read ]; then echo "'prefer-light'"; exit 0; fi
echo /org/gnome/desktop/interface/color-scheme; echo "  'prefer-dark'"; echo; sleep 5
`);
    chmodSync(dconf, 0o755);
    const saved = process.env.PLUTONIUM_DCONF;
    process.env.PLUTONIUM_DCONF = dconf;
    // A bus with no portal on it.
    const appearance = new Appearance("unix:path=/nonexistent");
    const seen: boolean[] = [];
    appearance.onChange((dark) => seen.push(dark));
    try {
      await appearance.start();
      for (let i = 0; i < 50 && seen.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(seen, [false, true]);
    } finally {
      appearance.stop();
      if (saved === undefined) delete process.env.PLUTONIUM_DCONF;
      else process.env.PLUTONIUM_DCONF = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("follows a settings portal (a fake one on a private bus)", async (t) => {
    let daemon;
    try {
      daemon = spawn("dbus-daemon", ["--session", "--nofork", "--print-address=1"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return t.skip("no dbus-daemon");
    }
    const address = await new Promise<string>((resolve, reject) => {
      daemon.once("error", reject);
      daemon.stdout!.once("data", (data: Buffer) => resolve(data.toString().trim()));
    }).catch(() => "");
    if (!address) return t.skip("no dbus-daemon");
    const portal = await DBusConnection.connect(address);
    let scheme = 1;
    // An older portal: Read only, the value in one more variant.
    portal.onCall = (message) => {
      if (message.member !== "Read") throw new Error("no such method");
      return { signature: "v", body: [["v", ["u", scheme]]] };
    };
    await portal.call({
      destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus",
      member: "RequestName", signature: "su", body: ["org.freedesktop.portal.Desktop", 0],
    });
    const appearance = new Appearance(address);
    const seen: boolean[] = [];
    appearance.onChange((dark) => seen.push(dark));
    try {
      await appearance.start();
      assert.equal(appearance.current, true);
      scheme = 2;
      portal.emit("/org/freedesktop/portal/desktop", "org.freedesktop.portal.Settings", "SettingChanged", "ssv", [
        "org.freedesktop.appearance", "color-scheme", ["u", scheme],
      ]);
      for (let i = 0; i < 50 && seen.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(seen, [true, false]);
    } finally {
      appearance.stop();
      portal.close();
      daemon.kill();
    }
  });
});

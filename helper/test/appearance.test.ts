import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  dconfQuote,
  dconfString,
  HostAppearance,
  iniValue,
  isDark,
  isDarkDconf,
  setIniValue,
  themeVariant,
} from "../src/appearance.ts";
import { DBusConnection } from "../src/dbus.ts";
import { AppearanceService, type AppearanceState } from "../src/services/appearance.ts";

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
    const appearance = new HostAppearance("unix:path=/nonexistent");
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
    const appearance = new HostAppearance(address);
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

const wait = async (done: () => boolean) => {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
};

describe("GTK's themes and settings", () => {
  test("a theme's light or dark variant, when it has one", () => {
    const installed = new Set(["adw-gtk3", "adw-gtk3-dark", "Breeze", "Breeze-Dark", "breeze", "breeze-dark", "Adwaita"]);
    const has = (name: string) => installed.has(name);
    assert.equal(themeVariant("adw-gtk3-dark", "light", has), "adw-gtk3");
    assert.equal(themeVariant("adw-gtk3", "dark", has), "adw-gtk3-dark");
    assert.equal(themeVariant("adw-gtk3-dark", "dark", has), "adw-gtk3-dark");
    assert.equal(themeVariant("Breeze", "dark", has), "Breeze-Dark");
    assert.equal(themeVariant("breeze-dark", "light", has), "breeze");
    // No variant: left as it is.
    assert.equal(themeVariant("Adwaita", "dark", has), null);
    assert.equal(themeVariant("Nordic-dark", "light", has), null);
  });

  test("settings.ini keys are read and set in [Settings]", () => {
    const ini = "[Settings]\ngtk-application-prefer-dark-theme=true\ngtk-icon-theme-name = breeze-dark\n";
    assert.equal(iniValue(ini, "gtk-icon-theme-name"), "breeze-dark");
    assert.equal(iniValue(ini, "gtk-theme-name"), undefined);
    assert.equal(
      setIniValue(ini, "gtk-application-prefer-dark-theme", "false"),
      "[Settings]\ngtk-application-prefer-dark-theme=false\ngtk-icon-theme-name = breeze-dark\n",
    );
    assert.equal(setIniValue(ini, "gtk-theme-name", "x"), "[Settings]\ngtk-theme-name=x\ngtk-application-prefer-dark-theme=true\ngtk-icon-theme-name = breeze-dark\n");
    assert.equal(setIniValue("", "a", "b"), "[Settings]\na=b\n");
    assert.equal(setIniValue("[Other]\nx=1", "a", "b"), "[Other]\nx=1\n[Settings]\na=b\n");
  });

  test("dconf's strings", () => {
    assert.equal(dconfString("'adw-gtk3-dark'\n"), "adw-gtk3-dark");
    assert.equal(dconfString(""), undefined);
    assert.equal(dconfString("uint32 1"), undefined);
    assert.equal(dconfQuote("it's"), "'it\\'s'");
    assert.equal(dconfString(dconfQuote("it's")), "it's");
  });
});

describe("the appearance service", () => {
  test("a session in a window follows its host until the user chooses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "appearance-"));
    const hostListeners: ((dark: boolean) => void)[] = [];
    const host = {
      current: false as boolean | null,
      start: async () => {},
      stop: () => {},
      onChange: (listener: (dark: boolean) => void) => hostListeners.push(listener),
    };
    const file = join(dir, "appearance.json");
    const service = new AppearanceService({ file, system: false, host, dconf: join(dir, "no-dconf"), gtkConfigDirs: [], dataDirs: [] });
    const states: AppearanceState[] = [];
    const schemes: string[] = [];
    service.onChange((scheme) => schemes.push(scheme));
    try {
      await service.start((state) => states.push(state as AppearanceState));
      assert.equal(service.colorScheme, "light");
      assert.deepEqual(await service.state(), {
        available: true, colorScheme: "light", chosen: false, system: false, gtkTheme: null, iconTheme: null,
      });
      host.current = true;
      for (const listener of hostListeners) listener(true);
      await wait(() => schemes.length > 0);
      assert.deepEqual(schemes, ["dark"]);
      await service.call("set", { colorScheme: "light" });
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { colorScheme: "light" });
      // The host's changes no longer count.
      for (const listener of hostListeners) listener(false);
      for (const listener of hostListeners) listener(true);
      assert.equal(service.colorScheme, "light");
      await service.call("toggle", {});
      assert.equal(service.colorScheme, "dark");
      assert.deepEqual(schemes, ["dark", "light", "dark"]);
      // No choice: the host's again.
      await service.call("set", { colorScheme: null });
      assert.equal((await service.state()).chosen, false);
      await assert.rejects(service.call("set", { colorScheme: "blue" }), /colorScheme/);
      assert.equal(states.at(-1)?.colorScheme, "dark");
      // The choice outlives the helper.
      await service.call("set", { colorScheme: "light" });
      const again = new AppearanceService({ file, system: false, host: null, gtkConfigDirs: [], dataDirs: [] });
      assert.equal(again.colorScheme, "light");
      assert.deepEqual(service.portalSettings().get("org.freedesktop.appearance")?.get("color-scheme"), ["u", 2]);
    } finally {
      service.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the desktop session sets GTK's dconf keys and settings.ini, and takes dconf's changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "appearance-"));
    const db = join(dir, "db");
    mkdirSync(db);
    const key = (name: string) => join(db, name);
    writeFileSync(key("color-scheme"), "'prefer-dark'\n");
    writeFileSync(key("gtk-theme"), "'adw-gtk3-dark'\n");
    writeFileSync(key("icon-theme"), "'breeze-dark'\n");
    // A dconf with its keys in files; `watch` reports "external" once it's there.
    const dconf = join(dir, "dconf");
    writeFileSync(dconf, `#!/bin/sh
f="${db}/$(basename "$2")"
case "$1" in
  read) [ -f "$f" ] && cat "$f"; exit 0 ;;
  write) printf '%s\\n' "$3" > "$f"; echo "$(basename "$2") $3" >> "${dir}/writes"; exit 0 ;;
  watch) while [ ! -f "${dir}/external" ]; do sleep 0.05; done
    echo /org/gnome/desktop/interface/color-scheme; echo "  $(cat "${dir}/external")"; echo; sleep 5 ;;
esac
`);
    chmodSync(dconf, 0o755);
    const data = join(dir, "share");
    for (const theme of ["adw-gtk3", "adw-gtk3-dark"]) mkdirSync(join(data, "themes", theme, "gtk-3.0"), { recursive: true });
    for (const theme of ["breeze", "breeze-dark"]) {
      mkdirSync(join(data, "icons", theme), { recursive: true });
      writeFileSync(join(data, "icons", theme, "index.theme"), "");
    }
    const gtk3 = join(dir, "gtk-3.0");
    mkdirSync(gtk3);
    writeFileSync(join(gtk3, "settings.ini"), "[Settings]\ngtk-application-prefer-dark-theme=true\ngtk-icon-theme-name=breeze-dark\ngtk-font-name=Noto Sans,  10\n");
    const file = join(dir, "appearance.json");
    const options = { file, system: true, dconf, gtkConfigDirs: [gtk3, join(dir, "gtk-4.0")], dataDirs: [data], ownWriteMs: 0 };
    const service = new AppearanceService(options);
    const writes = () => (existsSync(join(dir, "writes")) ? readFileSync(join(dir, "writes"), "utf8").trim().split("\n") : []);
    try {
      await service.start(() => {});
      // dconf's key is where it starts; everything already agrees.
      assert.equal(service.colorScheme, "dark");
      assert.deepEqual(writes(), []);
      assert.equal((await service.state()).gtkTheme, "adw-gtk3-dark");
      await service.call("set", { colorScheme: "light" });
      assert.deepEqual(writes(), ["color-scheme 'default'", "gtk-theme 'adw-gtk3'", "icon-theme 'breeze'"]);
      assert.equal(
        readFileSync(join(gtk3, "settings.ini"), "utf8"),
        "[Settings]\ngtk-application-prefer-dark-theme=false\ngtk-icon-theme-name=breeze\ngtk-font-name=Noto Sans,  10\n",
      );
      // A settings.ini that isn't there isn't made.
      assert.ok(!existsSync(join(dir, "gtk-4.0")));
      assert.deepEqual(await service.state(), {
        available: true, colorScheme: "light", chosen: true, system: true, gtkTheme: "adw-gtk3", iconTheme: "breeze",
      });
      // gsettings set org.gnome.desktop.interface color-scheme prefer-dark
      writeFileSync(key("color-scheme"), "'prefer-dark'\n");
      writeFileSync(join(dir, "external"), "'prefer-dark'");
      await wait(() => service.colorScheme === "dark" && writes().length >= 5);
      assert.equal(service.colorScheme, "dark");
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { colorScheme: "dark" });
      assert.deepEqual(writes().slice(3), ["gtk-theme 'adw-gtk3-dark'", "icon-theme 'breeze-dark'"]);
    } finally {
      service.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

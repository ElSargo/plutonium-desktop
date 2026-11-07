# Light and dark

One setting for the whole desktop: light or dark. Shells, browser tabs, GTK
apps and Qt apps follow it, and running apps change when it changes (with the
exceptions under "Not covered").

## Setting it

- **Charon:** Settings → Appearance → Style (Default or Dark), or the Dark Style
  toggle in the quick settings.
- **Command line:** `plutonium appearance [--drm|--x11] [light|dark|toggle|default]`
  prints the scheme, after changing it if you give one. `default` drops your
  choice (see "Without a choice"). It talks to the running session's helper:
  the thread's own, else the DRM session's, else the X11 one's.
- **Any shell:** `shell.system.appearance` (DESKTOP_SERVICES.md,
  "appearance"); the shell's `shell.json` names `"appearance"` in `"uses"`.
- **GNOME's key:** in the desktop session, `gsettings set
  org.gnome.desktop.interface color-scheme prefer-dark` (or any app that writes
  it) counts as a choice too.

The choice is kept in `$PLUTO_HOME/appearance.json` (`~/.pluto`; a test slot
has its own).

## Where it goes

The helper's appearance service (`helper/src/services/appearance.ts`) hands
the scheme to:

| What | How | Live |
|---|---|---|
| Shells and tabs (`prefers-color-scheme`) | Ash's dark mode (`Plutonium.setColorScheme`, the user's `ash.dark_mode.enabled`), which Ash gives the web's native theme; again whenever the browser (re)connects | yes |
| libadwaita and GTK 4 apps, Firefox, Chromium and Electron apps, Flatpaks | The settings portal: the helper's backend serves `org.freedesktop.impl.portal.Settings`, `org.freedesktop.appearance` `color-scheme` (1 dark, 2 light) and `contrast` (0), with `SettingChanged` on each change (`helper/src/portal.ts`; `plutonium-portals.conf` picks it for Settings) | yes |
| Qt 6 apps | The same portal, through Qt's `xdgdesktopportal` platform theme: threads get `QT_QPA_PLATFORMTHEME=xdgdesktopportal` unless the session already sets a theme (qt6ct, kde). Qt's generic theme, which apps get otherwise with `XDG_CURRENT_DESKTOP=Plutonium`, never reads the portal | at start; see below |
| GTK 3 apps | GNOME's dconf keys in `/org/gnome/desktop/interface/`: `color-scheme` (`'prefer-dark'` or `'default'`), and `gtk-theme` and `icon-theme` switched to their other variant when one is installed (`adw-gtk3` and `adw-gtk3-dark`, `Breeze` and `Breeze-Dark`, `breeze` and `breeze-dark`; GTK's built-in `Adwaita-dark`). A theme without one is left alone | yes |
| GTK 3 apps that read `settings.ini` | `gtk-application-prefer-dark-theme` in `~/.config/gtk-3.0/settings.ini` and `gtk-4.0/settings.ini`, and their `gtk-theme-name`/`gtk-icon-theme-name` if they set one. Only files that exist, and not ones linked from elsewhere (home-manager's) | at start |

The dconf keys and `settings.ini` are changed only by the desktop session
itself: the user's own slot on DRM (`PLUTONIUM_LOGIND_SESSION`, slot 0). A
test session, or one in a window on another desktop, would otherwise change the
user's GTK apps everywhere. `PLUTONIUM_APPEARANCE_SYSTEM=1` or `0` says
otherwise. The service's state says which (`system`).

### Without a choice

- **The desktop session** starts from GNOME's dconf key, if it is set, else dark.
- **A session in a window** on GNOME or KDE follows that desktop: its settings
  portal's `color-scheme` (`SettingChanged`), or without one GNOME's dconf key
  (`dconf watch`). `PLUTONIUM_APPEARANCE_BUS` and `PLUTONIUM_DCONF` point it at
  a test's fake portal or dconf.

## Not covered

- **A running Qt Widgets app's palette.** Qt 6.11 updates its color scheme
  (`QStyleHints::colorScheme`, which Qt Quick apps follow) when the portal's
  changes, but a Widgets app keeps the palette it started with. Started again,
  it has the new one.
- **Qt 5** has no color scheme; its apps follow neither.
- **KDE's own colors** (`kdeglobals`, which KDE apps' color schemes read) are
  not changed.
- **GTK 3 in a Flatpak** reads `org.gnome.desktop.interface` through the
  portal; the helper's backend serves only `org.freedesktop.appearance`, and
  the GTK backend (which would serve GNOME's keys) is not chosen for Settings.
  libadwaita and GTK 4 Flatpaks follow.
- **X11 apps** on a thread's Xwayland get the same environment (Qt is fine), but
  GTK 3 on X11 reads XSETTINGS, and there is no XSETTINGS manager.
- **Accent colors** (`org.freedesktop.appearance` `accent-color`) are each
  shell's own.
- **Charon's own panels** (its Settings window, quick settings) are drawn dark
  in both, as GNOME Shell's are; its windows' frames and the pages follow.

## Tested

- `helper/test/appearance.test.ts`: theme variants, `settings.ini` editing,
  dconf quoting; the service following a fake host until a choice, keeping the
  choice, `toggle` and `set null`; in the desktop session, a fake dconf's
  writes (only what differs), `settings.ini` rewritten, and a change made with
  "gsettings" taken as the choice.
- `helper/test/portal.test.ts`: `Read`, `ReadAll` with namespace patterns,
  `NotFound`, and `SettingChanged` for the keys that changed, on a private bus.
- End to end (2026-11-07) on a private bus with the real xdg-desktop-portal
  1.22 (`tools/portal-bus.sh`): it chose the helper for Settings, and
  `org.freedesktop.portal.Settings.ReadOne` gave `color-scheme` 2, then 1. A
  Qt 6.11 app on the session's Wayland display with `xdgdesktopportal` started
  with the scheme and palette to match (window `#efefef` light, `#323232`
  dark), and its color scheme followed a change; with Qt's generic theme it
  stayed Unknown and light.
- In a test session (2026-11-07, X11 on Xvfb, slot 45, Charon, the helper's
  portal on `tools/portal-bus.sh`'s bus): `plutonium appearance toggle`,
  Charon's Dark Style quick toggle and Settings → Appearance → Style each
  flipped the service, the shell page's and an example.com tab's
  `prefers-color-scheme`, and the portal's `color-scheme` together; the toggle
  and the Style cards showed the new state. A libadwaita app (zenity 4.2,
  `GSETTINGS_BACKEND=memory`, on the portal's bus) went from light to dark
  while open. The session wasn't the desktop (`system: false`): GNOME's dconf
  keys and `settings.ini` were the same before and after, and the choice went
  to the slot's own `pluto-s45/appearance.json`.

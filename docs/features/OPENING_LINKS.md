# Opening links

Links open as Plutonium tabs in the thread they came from, not in Chromium or another browser. Apps that a link or file opens belong to that thread too. Tested on DRM (tty2) on 2026-10-17, with the niri shell in front and T3 and the plain shell running behind it.

## Where links come from

| From | How | Where it goes |
|---|---|---|
| A native app in a thread: a terminal's link, a GTK, Qt or Electron app, a CLI tool | `xdg-open`, `$BROWSER`, GIO or KIO | a tab tagged with the app's `PLUTONIUM_THREAD_ID`, in the shell that owns that thread (else the visible one), shown there |
| A file or other non-web target from such an app | the real `xdg-open` | the app that handles it, started with the thread's environment, so its window is the thread's |
| A shell page: Ctrl+click, middle click, `target=_blank`, `window.open` (T3's "open in system browser") | Chrome's `Navigate()` | a tab the shell puts in its current thread (`onOpenTab`) and shows |
| A tab: the same | the tab's `WebContentsDelegate` (already, since the tabs work) | a tab with the opener's tags |

## Native apps (helper, `helper/src/opener.ts`)

The helper writes the openers to `$XDG_RUNTIME_DIR/plutonium/open/` at startup, and every thread's environment points at them:

- **`PATH`** starts with `open/bin`. It holds `xdg-open`, `x-www-browser`, `sensible-browser`, `www-browser` and `plutonium-open`, which all run `plutonium.ts open`. Terminals (foot's URL mode, kitty's Ctrl+click), Electron's `shell.openExternal`, Qt without KDE's platform plugin and scripts all use `xdg-open`.
- **`BROWSER`** is `plutonium-open`: Python's `webbrowser`, git, gh and most CLI tools.
- **`XDG_DATA_DIRS`** starts with `open/share`. It holds a desktop file with the same id as the user's default browser, as named in `mimeapps.list` (`[Default Applications]`, http/https/html) and in kdeglobals' `BrowserApplication`. Here that's `chromium-browser.desktop`, and its `Exec` is `plutonium-open`. GIO (GTK, Firefox's link handling) and KIO (Qt/KDE apps, which ask kdeglobals first) look the browser up by id, and this copy is found before the system's. Nothing in `~/.config` changes.

`plutonium.ts open` then works as follows:
- **Web links** (http, https) go to `POST /v1/threads/<thread>/tabs` on the helper's socket. The helper asks the shell owning the thread to open the tab and show it (`focus_tab`).
- **As the browser** (`plutonium-open`, `$BROWSER`, the desktop file), local pages and `file://` URLs also become tabs. That is what happens when the user's default HTML viewer is the browser.
- **Anything else** goes to the real `xdg-open`, with the thread's environment.
- **With no helper or shell,** web links go to the real `xdg-open` with the openers taken out of the environment, so the user's browser opens as before.

## Shell pages (Chromium, `chromium/patches/0016-*.patch`)

- **`chrome::Navigate()`** asks `PlutoniumTabs::MaybeOpenFromShell()` first. In shell mode, a new-tab, new-window or popup navigation from one of the shells' own pages becomes a Plutonium tab instead of a Chrome window. A `window.open` keeps its opener. The tab starts untagged, with `openedBy` set to `"shell:<shell id>"`.
- **The shell library** (`connect({ onOpenTab })`) gives such a tab to the shell that opened it. `onOpenTab` returns a thread, and the library tags the tab with it and shows it with `onFocusTab`.
  - **niri:** `niri:desktop`, a new column next to the focused one.
  - **Plain shell:** the current thread.
  - **T3:** imports the tab into the open thread's browser panel itself (`importBrowserTab`). T3 also got an `onFocusTab`, so a thread's tab that someone asks to show (an agent, the overlay, `xdg-open` in its terminals) opens in its thread's panel.
- **niri** used to tag every untagged tab with `niri:desktop`. It now leaves alone tabs another shell's page has just opened.
- **Library fix:** `focus_tab` right after `open_tab` found no tab yet (the `tabadded` event comes later), so nothing was shown. It now asks the browser.

## Verified on DRM

| | |
|---|---|
| `xdg-open https://…` typed in a foot terminal started with Super+T: `which xdg-open` is the wrapper; a tab opens as a niri column next to the terminal, tagged `niri:desktop` | ✓ |
| `python3 -c 'webbrowser.open(…)'` ($BROWSER), `kioclient exec …` (KIO, via kdeglobals' `chromium-browser.desktop`), `gio open …` (GIO, via mimeapps): each a tab in the thread | ✓ |
| `xdg-open note.txt` with the thread's environment: Kate opens, and its window is tagged `niri:desktop` | ✓ |
| niri page: `window.open(url, "_blank", "noopener")` and an `<a target=_blank>` click with a user gesture: tabs opened by `shell:<niri>`, tagged `niri:desktop`; no Chrome window | ✓ |
| T3 page: `window.open` (what Ctrl+click and "system browser" do in its web build): a tab tagged with the open thread (`t3:thread/…`) and shown in its browser panel; niri leaves it alone | ✓ |
| `xdg-open` with a T3 thread's environment: a tab in that thread, shown in its panel; then a T3 link and another `xdg-open`, giving three panel tabs | ✓ |

## Limits

- **Processes started before this change keep their old environment.** That includes T3 terminals already open, and apps those terminals start.
- **An app that is already running elsewhere** (single instance, D-Bus activated) opens its window in the process that has it, which may belong to another thread or the host desktop. Firefox and Dolphin are examples.
- **A user-level copy of the browser's desktop file** in `~/.local/share/applications` wins over the helper's copy, so GIO and KIO would still find the real browser there. `xdg-open` and `$BROWSER` still work.
- **Other schemes from tabs** (`mailto:`, app links) aren't routed to the thread's apps yet.
- **The XDG Desktop Portal (`org.freedesktop.portal.OpenURI`)** isn't covered. Flatpaks and sandboxed apps use it.

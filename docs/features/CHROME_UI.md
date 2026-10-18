# Chrome's own UI in the shell

In shell mode the page is the desktop, so Chrome's browser-window UI shouldn't show through it. `chromium/patches/0022-*.patch` (EXO-CHROME in the code) covers DevTools, the context menu, Chrome's and Ash's keys, and the link status bubble.

## DevTools

- **The shell page's DevTools** docks in the shell's window, at the side, as in a browser window (`DevtoolsUIController`: shell windows dock like normal ones; Chrome docks only in `TYPE_NORMAL` windows). The page gets narrower and lays out again, and the windows and tabs it shows follow it. Its dock menu can still undock it into a window.
- **A tab's DevTools** has no browser window to dock in. It becomes a tab of its own instead: same tags as the tab it inspects, `openedBy: "devtools"`, `openerId` the inspected tab. The shell shows it where it shows new tabs: niri as a new column right of the focused one, the plain shell as the thread's front tab. DevTools stays owned by its `DevToolsWindow` (as when docked); the tab registry only borrows its page.
  - F12 or Ctrl+Shift+I in the tab again asks the shell to show it (`tabfocusrequest`), as Chrome activates an undocked DevTools window. In the DevTools tab they close it.
  - Closing the tab (`tabCommand(id, "close")`) closes DevTools, and DevTools closing (its page crashed, the inspected tab closed) removes the tab.
  - It can't be navigated, and `sendTabDevToolsCommand` refuses it: DevTools' own page has privileged bindings (file system access, among others). Reload works.
  - Shell tabs are now DevTools targets of type `page`, not `other`: the DevTools frontend shows nothing for an `other` target.

Before, both opened a floating DevTools window over the shell.

## Context menus

A shell page's own menu and a tab's are Chrome's `RenderViewContextMenu`, filtered to what makes sense on a desktop (`plutonium_context_menu.cc`, `Keeps()`):

| Kept | Gone |
|---|---|
| Undo, Redo, Cut, Copy, Paste, Paste as plain text, Delete, Select all, writing direction | Back, Forward, Reload and Reload frame on a shell page (they stay on tabs) |
| Open link in new tab, Copy link address and text; images and media: open, copy, load, play, mute, loop, controls, rotate | Open link in new window, incognito or another profile; Save link, image, video or page as |
| Search for the selection, go to a URL, links to highlighted text | Print, Cast, Translate, Lens, QR code, Send to your devices, Reading mode |
| Spelling suggestions, add to or remove from the dictionary, spell check on and off | Inspect, View page source, Exit full screen, Emoji, autofill and passwords, language settings |
| The page's own custom items | Everything else |

Separators left at either end or doubled go too, and a menu with nothing left isn't shown (right-clicking an empty part of a shell page shows nothing).

**The shell draws it.** The visible shell page gets a cancelable `contextmenurequest` event on `navigator.windowBroker`: `menuId`, `tabId` (0 for its own page), `x` and `y` in its CSS pixels, `items` (`{id, parentId, type, label, enabled, checked}`, a submenu's items after it), and `linkUrl`, `selectionText`, `editable`, `mediaType`. Calling `preventDefault()` takes it. The page then answers with `closeContextMenu(menuId, itemId)` (0 to dismiss), and Chrome runs the item. A page that doesn't take it gets Chrome's own menu, with the same items. While the shell shows a tab's menu, the shell page has the keyboard.

**The shell library draws it for niri and the plain shell**, as a popover (so it is above fullscreen elements too), with arrow keys, Enter, Escape, submenus and press-drag-release. Its look comes from custom properties each shell sets: `--plutonium-menu-bg`, `-fg`, `-border`, `-radius`, `-shadow`, `-backdrop`, `-font`, `-hover-bg`, `-hover-fg`, `-separator`. It closes on a click elsewhere, a key that isn't the menu's, an app or tab taking the keyboard, or the shell being hidden. `connect({ contextMenu: false })` leaves the menus to Chrome; `contextMenu: (request) => true` draws them yourself.

T3 Code doesn't use the shell library for this, so it gets Chrome's menu, filtered.

## Keys

**Chrome's commands** in a shell's window: only DevTools (F12, Ctrl+Shift+I, J, C) and the clipboard commands run (`IsCommandAllowedInShell`, checked in `BrowserCommandController::IsCommandEnabled`). An app window gives the page every key first, and then ran Chrome's command for any key the page let through: F1 opened Chrome's help in a browser window, and Ctrl+N, Ctrl+Shift+N, Ctrl+W, Ctrl+P, Ctrl+S, Ctrl+F, Ctrl+R, F5, Ctrl+plus and minus, Shift+Esc (task manager) and the like ran their browser commands on the shell's window. The keys are now the page's alone.

**Tabs** have no browser window, so they had no keys at all. Once the page has let a key through, a tab now has DevTools' keys (above), Alt+Left and Alt+Right (back, forward), and F5 and Ctrl+R (reload; with Shift, bypassing the cache), and the keyboard's back, forward and refresh keys. A DevTools tab passes the shell's shortcuts on like any tab.

**Ash's accelerators.** Shell mode already ran Ash as in kiosk mode, which left its kiosk set on. Of those, only hardware keys stay: brightness, keyboard backlight, volume, media, microphone mute, power, privacy screen, and the Caps Lock key (Ash's debug and developer keys too, when their flags are on). These now reach the app or page instead:

| Key | Was |
|---|---|
| Ctrl+Shift+plus, minus, 0 | scale the whole UI (also foot's and kitty's font size) |
| Ctrl+Space, Ctrl+Shift+Space | switch the input method |
| Search+V | ChromeOS clipboard history (niri's Super+V) |
| Ctrl+Alt+Z, Ctrl+Search+H, M, D | ChromeVox, high contrast, magnifiers, with ChromeOS dialogs |
| Alt+Search | Caps Lock |
| Shift (on its own) | turning Caps Lock off |
| Ctrl+Shift+Refresh, display keys | rotate the screen, mirror displays |

Plutonium's own keys (Super+Tab, Super+F, Super+Escape, Ctrl+Alt+F1…F12, Ctrl+Alt+Backspace) are handled before Ash's and are unchanged.

## The status bubble

The URL Chrome shows at the bottom left when the pointer is over a link is off in shell mode, as in kiosk mode.

## Verified

On Xvfb (slot 6 of a worktree, niri at startup and the plain shell behind it), with real X input through Ash (xdotool), 2026-10-19:

| | |
|---|---|
| F1, Ctrl+N and Ctrl+W on niri: no window opens, the shell stays | ✓ |
| Right-click on niri's empty desktop: no menu | ✓ |
| Right-click on a link in a tab: niri's menu at the pointer, "Open link in new tab", "Copy link address", "Copy" | ✓ |
| Arrow keys and Enter in it (the shell has the keyboard), focus back in the tab after; "Copy link address" then Ctrl+V in the tab's input pastes the URL; "Open link in new tab" opens a tab | ✓ |
| A tab's text field: Cut, Copy, Paste, Paste as plain text, Select all, Spell check ›, Writing Direction › | ✓ |
| A tab's empty area: Back, Forward, Reload | ✓ |
| The plain shell's own text field: its menu in its colours, disabled items skipped, a submenu with ArrowRight, check marks | ✓ |
| A page that doesn't take the event gets Chrome's menu, filtered (Back, Forward, Reload) | ✓ |
| F12 on niri: DevTools docked at the right, niri laid out in what's left, foot drawn right beside it | ✓ |
| F12 in a tab: a DevTools tab as a new niri column beside it, showing the tab's elements; F12 in it closes it; Ctrl+Shift+J opens it on the console; closing the tab from the shell closes DevTools | ✓ |
| Alt+Left and Alt+Right in a tab | ✓ |
| Ctrl+Shift+= and Ctrl+Space reach the tab's page; the UI scale stays | ✓ |

Not tested: DRM, T3 Code, the status bubble, a real game with the keys, a shell page's own text field in a docked-DevTools layout.

## Not done

- Tooltips (`title`) are still Ash's.
- A shell page's own `alert()` and permission prompts are still Chrome's dialogs and bubbles.
- Find in page, zoom and printing in tabs (`BACKLOG.md`, "Browser features tabs lack").
- T3 Code doesn't draw the menus itself yet.
- On an X11 session, a context menu can wait for the next input event: Chrome reads the clipboard's formats before building the menu, and with `--use-system-clipboard` that read waits on X (seen once in four right-clicks). Not seen to matter on DRM, where there's no X clipboard (not tested).

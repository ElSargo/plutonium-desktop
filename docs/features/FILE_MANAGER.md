# The file manager

Hydra is a desktop, so there may be no other file manager to fall back on. Its own does both jobs: it is the desktop's file picker, for tabs, native apps and Hydra's own page, and a full file manager, in a bottom drawer and in the right panel's Files tab.

**Status:** built in Hydra (2026-11-05). The other shells keep the library's simpler picker, and can build on the same core ("The parts").

## What it does

- **Three views**, switched with `1`, `2`, `3` or the toolbar: a tree, Yazi's three columns (parent, folder, preview) and a grid with image thumbnails. Each file manager keeps its own view, sort, dot files and preview, so a tree and three columns can sit side by side.
- **Several at once:** `s` opens another beside this one in the drawer (up to four), `q` closes it. The Files panel and the picker are separate again.
- **Previews** are Hydra's: its syntax-highlighted source viewer, its markdown and table rendering, images, video and audio.
- **Keys:** Yazi's defaults, as real rules in Hydra's keybindings (`when: filesFocus`): Settings, Keybindings, under File manager, where they can be changed like any other. A sequence such as `gg` is written `g g` in `keybindings.json`; the settings' recorder takes single keys, so a new sequence goes in that file. `~` or `?` lists the current keys. The core's `DEFAULT_KEYMAP` (`helper/web/ui/files.js`) is the same set, for other shells. `hjkl`, `gg`, `G`, `<C-d>`, `<C-u>`, `space`, `v`, `y`, `x`, `p`, `P`, `d` (trash), `D` (delete, asks first), `a` (a trailing `/` makes a folder), `r`, `u` (undo), `.`, `f`, `/`, `n`, `N`, `,n`, `,m`, `,s`, `,e`, `,r`, `gh`, `gd`, `gp`, `g/`, `gl`, `H`, `L`, `o`, `c`, `i`. `b` picks the selection up (below). The grid reads `hjkl` as moves through its cells, so `Enter` opens a folder there and `Backspace` goes up.
- **The mouse:** click, Ctrl-click and Shift-click select, a double click opens, a right click gives the menu, and everything in the keymap has a toolbar button or a menu item where it makes sense.
- **The fuzzy finder** (`z`): Telescope's layout, the list and query on the left, a preview on the right. It searches everything under the folder: `fd`'s list if `fd` is installed (it honours `.gitignore`), else a walk that skips `.git`, `node_modules` and the like. Words are separate terms. `Ctrl+J`/`Ctrl+K` move, `Tab` marks several, `Enter` opens or chooses, `Ctrl+Enter` goes to the file instead. A result can be dragged anywhere, or picked up with `Ctrl+B`; marked results go together.
- **File operations** run as jobs in the helper, shown in the status bar with a cancel button. Copies use reflinks where the disk can. A taken name gets a number (`note (2).txt`); `P` replaces it. `d` is the freedesktop trash (`$XDG_DATA_HOME/Trash`), so Dolphin and others see it too. `u` undoes a copy (to the trash), a move, a rename or a trash. A delete, or a paste that replaced something, can't be undone.

## Where it opens

| | |
|---|---|
| `Ctrl+E` (`Super+E` from a tab or app) | The drawer at the bottom of the thread, beside the terminals if they are open, so whatever is on the side is a drop away. `Esc` with nothing left to clear closes it. It is `files.toggle`; `files.toggleRight` (`Super+Shift+E`) opens the panel's Files tab instead, so which one you use is a matter of keys. Ctrl+E is only bound outside terminals, and doesn't reach past a tab or an app, where it means something else. |
| The right panel's Files tab | The same file manager, for a project on this computer (the helper can list it). A remote environment's project keeps T3's own tree: only that server can reach its files. |
| A picker | A floating dialog over whatever asked. |

Views live in the page's `localStorage` (`plutonium:file-manager-views`), per browser profile.

## Pickers

Every file picker on the desktop reaches `connect({ fileChooser })`: a tab's `<input type=file>`, File System Access pickers, a download's Save As, a native app's through the FileChooser portal, and, new here, **the shell page's own**, which is what Hydra's composer attach button is. The browser used to send those to the Files app's picker, because `PlutoniumSelectFileDialogFactory` only asked about tabs. A shell page now asks itself, as a request with tab id 0 and no pending state; every shell's picker gets this. If that shell goes away (a reload), the page that asked is gone too, so the request is cancelled rather than falling back.

With a shell on each display several pages are visible, and an app's dialog has to reach the one in front of the user: the helper asks the visible pages (`page_state`) and takes the one showing the app's window, else the one with the keyboard, else the one on the focused display. Before that it took the page shown last, so a picker could open on the other monitor while the app sat waiting for it.

Apps get `GTK_USE_PORTAL=1` and `GDK_DEBUG=portals` from their thread's environment, so GTK's portal-aware chooser and Firefox come here, and Chromium does by itself. **An app that draws its own `GtkFileChooserDialog` keeps it, whatever the environment says:** LibreOffice's GTK 3 plugin and GIMP do.

A picker keeps filters, choices, the save name and the overwrite and folder-upload confirmations. Only one is open at a time; a second asker is cancelled. A name typed in a save dialog may be a whole path.

## Drag and drop

- **Out:** a drag from a row carries the real file. The library's `fileForPath(path)` gives a `File` backed by that path (the browser grants this renderer read access); added to `dataTransfer.items`, Blink turns it into the drag's filenames, as any file drag. So tabs get a `File` and native apps a `text/uri-list`. It also carries `application/x-plutonium-paths`, for other file managers here, and a composer mention.
- **In:** rows of folders, the view and Places take drops. `pathForFile(file)` gives a dropped file's host path. A `File` with none (a page's) is saved through `POST /v1/files/upload`.
- **The default:** within the file manager a drop moves; from outside it copies. Ctrl copies, Shift moves, Alt links.

### With no mouse

`b` picks up the selection. `Super+O` (`files.carry`), from anywhere, including a tab or an app, opens the picker first, and what's chosen is picked up. It then rides on the pointer with no button held: a real drag, so anything that takes a drop takes it. `hjkl` or the arrows move the pointer (Shift for bigger steps), `Enter`, `Space` or a click drop it, and `Esc` cancels. A hint shows the keys while it lasts. So: see a drop area in a tab, `Super+O`, find the file, `Enter`, steer it there, `Enter`.

A picker an app or a page opened never starts a drag: it hands the file to what asked.

How: `startFileDrag(paths, {imagePng})` asks the broker, which runs Ash's `DragDropController` with `SetNextDragSticky()`. In a sticky drag plain mouse moves update it, a press drops it, and the controller takes the keyboard. Pointer moves are synthesized through the root's event sink, so they follow the same path as the mouse, native windows included. It drops on the press, not the release, so nothing has to follow it.

## Taking the keyboard from a tab

`element.focus()` in a shell page doesn't move the keyboard away from a tab or app it shows: the page's own frame was focused all along, so the browser hears nothing and keys keep going to the tab, while `document.activeElement` says otherwise. `focusPage()` tells the browser (`LocalFrame::DidFocus()`). Anything in a page that wants the keyboard while a tab may have it needs it first: the file manager does, and so does the library's picker. Other dialogs over a tab may have the same problem.

## The parts

- **Helper** (`helper/src/fileOps.ts`, `files.ts`): `/v1/files/{jobs,rename,file,index,preview,raw,open,upload,watch}`, beside the picker's listing, with the same rule: only a shell page gets there (its origin, and the socket's peer uid). The root, the home folder and what holds it can't be moved or removed. `raw` serves only media types: no SVG or HTML, which could run in the page that opens them.
- **The core** (`helper/web/ui/files.js`, served at `/v1/ui/files.js`): no UI. The API client, the keymap, the fuzzy matcher, sorting, filters and undo. Another shell draws on this.
- **The shell library:** `fileForPath`, `pathForFile`, `startFileDrag`, `focusPage`.
- **Hydra** (`apps/web/src/plutonium/files/`): `useFileManager.ts` is the state and commands; `FileManager.tsx` the views; `FilePicker.tsx`, `PlutoniumFilesDrawer.tsx` and `HydraFilesPanel.tsx` the three places it appears.
- **Chromium:** the broker's `GrantFileAccess` and `StartFileDrag`, Blink's `fileForPath`, `pathForFile`, `startFileDrag` and `focusPage`, Ash's sticky drags, and shell pages in the picker's factory and `PlutoniumTabRequests`.

## Verified

On X11 in a worktree's slot, with `xdotool`'s real input through Ash (2026-11-05):

| | |
|---|---|
| The composer's kind of input: a file input in Hydra's page opens Hydra's picker, no Files app; a chosen file reaches the input | ✓ |
| Reloading with that picker open cancels it; the next one works | ✓ |
| `showSaveFilePicker` in the page: the name has the keyboard, a typed path saves, an existing file asks first | ✓ |
| The views, `gl`, `hjkl`, unfolding, the fuzzy finder, `y`, `p`, `r`, `a`, `d`, `D`, `u`, `.`, on disk | ✓ |
| `Ctrl+E`, `Super+E` from a terminal, `Esc`, `Ctrl+D` staying the file manager's, the right-panel setting, the Files panel opening a file, the drawer beside a terminal | ✓ |
| A real browser tab with the keyboard: `Super+O`, `gl`, `z`, `Enter`, `Shift+L`/`J`, `Enter`: the tab's page gets the file | ✓ |
| Carrying: dropped by key or click (a click six times in a row), `Esc` cancels, onto a folder row, onto the composer (attaches) | ✓ |
| A row dragged to a page target, to a folder (moves), to Dolphin; a carry to Dolphin; a file from Dolphin to a folder row (`WAYLAND_DEBUG` shows the offer, `finish()` and Dolphin's menu) | ✓ |

Through a real portal (`tools/portal-bus.sh`, two displays, 2026-11-05): `OpenFile` opens the picker on the display with the keyboard, four times of four, alternating; Chromium 147's Ctrl+O and zenity (GTK 4) reach it; LibreOffice opens its own dialog.

**Not tried:** a carry across displays; these portal checks on DRM.

**On Xvfb a queued release:** xdotool's last button event can sit undispatched in Ash's nested drag loop until the next X event arrives, so a test's drag can seem to hang; nudge the pointer. Plain Chromium drags do the same. It's why a sticky drag drops on the press.

## Not done

- A rubber-band selection with the mouse.
- Thumbnails are the images themselves, decoded by the page: fine for a folder of photos, heavy for thousands. No video or PDF thumbnails.
- `trash` is the home trash only, whatever disk a file is on: a file on another disk is copied there.
- Reading `~/.config/yazi/keymap.toml`.

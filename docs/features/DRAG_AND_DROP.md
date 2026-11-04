# Drag and drop

Drag and drop between native Wayland apps, browser tabs and shell pages, in any frontend. Tested on DRM (tty2) in Styx on 2026-10-17. The Chromium changes are in Chromium's Exo patch.

## How a drag works here

Every drag runs through Ash's `DragDropController`, whoever starts it: a Wayland app (`wl_data_device.start_drag`, via Exo's `DragDropOperation`) or a page or tab (`WebContentsViewAura`). The controller follows the real pointer, picks the window under it with aura's hit test, and calls that window's `aura::client::DragDropDelegate`.

- **Exo surfaces** are delegates through `DataDevice`, which turns the drag into a `wl_data_offer`.
- **Web contents** are delegates through `WebContentsViewAura`, which finds the frame under the point through the input router. That router includes SurfaceEmbed tabs, which are routed like out-of-process iframes.

In a shell, native windows are drawn inside the page (`<native-window>`), and their real aura windows are parked out of sight. Aura's hit test therefore always found the page, so a drop on a native window went to the page.

## Chromium changes

- **Drops find the native window under the pointer.** `ash::DragDropController::SetTargetOverride()` lets Exo's `EmbeddedWindows` retarget a drag (`FindDropTarget()`).
  - It asks viz what is drawn at the point, using the hit-test data that routes the pointer into embedded windows.
  - The query starts from the page's own frame sink. A query from the display root can hit a window's parked copy instead, with a stale offset.
  - When the point is over an attached native window, the drag goes to its deepest sub-surface there, with the point mapped into it.
- **App-specific MIME types survive.** Exo turned a Wayland drag into `ui::OSExchangeData`, which only keeps text, HTML, RTF, images and files. Types such as `application/x-moz-tabbrowser-tab`, GTK and Qt internal formats, or `weston-dnd`'s flower were lost. While a Wayland client drives the drag, `DataOffer::AddSourceMimeTypes()` now also offers every MIME type of the source to a Wayland target. Each one is read from the source as is (`DragDropOperation::GetActiveSource()`, `DataSource::ReadRawData()`), as a real compositor would pass it.
- **Links.** A link dragged from a page or tab only reached apps as text. It is now offered as `text/uri-list` (file managers, terminals) and as Firefox's `text/x-moz-url` too.
- **Files from and to host apps.** ChromeOS treats Wayland apps that aren't in a VM as an "unknown VM" and drops their file paths both ways. In Plutonium they are the user's own programs on the same filesystem, so `ChromeSecurityDelegate` passes their paths through as host paths.
- **A refused drop is a cancel.** `DataOffer::Accept()` did nothing, so a target that accepted no type still got the drop, and the source was told the data had moved. A page that sees "move" deletes the original, for example text dragged out of an editor. Exo now remembers the accept: until one arrives the drag shows no-drop, and at release the target gets `leave` and the source a cancel.

## Verified on DRM (tty2, uinput mouse, Styx)

Pointer positions were read from the clients' `WAYLAND_DEBUG` logs. `tools/uinput.py` got `down` and `up` commands for this.

| | |
|---|---|
| `weston-dnd` → `weston-dnd`: the item leaves the source and appears in the target where it was dropped; the target gets `application/x-wayland-dnd-flower` from the source | ✓ |
| `weston-dnd` → a browser tab: the tab gets `dragenter`, `dragover` and `drop` with the text | ✓ |
| Browser tab → `weston-dnd`: offered `text/uri-list`, `text/x-moz-url` and text. `weston-dnd` takes none of these, so it gets `leave` and the tab sees `dragend none` | ✓ |
| Dolphin → browser tab: a file (`Files`, `files=1`) | ✓ |

**Not tried yet:** a link from a tab to Firefox or a file manager, files from a tab or page to an app, drag images and cursors during a drag, touch drags, drops onto the shell page itself (it gets them as before, from the same path), and Exo's unit tests (`exo_unittests` may expect the old drop-without-accept behaviour).

## Files from pages, and drags with no mouse

A shell page can drag real host files, and start a drag with no button held (`FILE_MANAGER.md`, "Drag and drop"): `File`s from `fileForPath()` in a drag's `dataTransfer`, and Ash's sticky drags (`DragDropController::SetNextDragSticky()`). Files from a page to an app are verified there, with Dolphin.

## Not done

- **Clipboard.** It is a separate path (`wl_data_device.set_selection`) and is untested between apps and pages.
- **Drags into a hidden window.** A window has to be drawn in the page to be a target. niri's overview and workspace switching during a drag are not handled.

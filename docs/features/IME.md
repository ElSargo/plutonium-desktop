# Input methods for native apps

Apps get Ash's input method (IME) through Exo's text-input protocols: what the IME composes shows up as the app's pre-edit text, and what it commits is typed into the app. Pages use the same IME the way Chrome does.

## What works

**Protocols.**
- **`zwp_text_input_v3`** (patch 0061): GTK 4, Qt 6 and foot speak only this one.
  - It sits on the same `exo::TextInput` as v1, with its own delegate.
  - **Focus:** `enter` and `leave` follow the seat's keyboard focus on the client's surfaces.
  - **State:** `enable`, `disable`, surrounding text, content type and cursor rectangle are held until `commit`. Enabling attaches the IME to the entered surface; disabling, or losing focus, detaches it.
  - **What the IME sends:** composition becomes `preedit_string`, its commits `commit_string`, and its deletions `delete_surrounding_text` (bytes before and after the selection). Each is followed by `done`, whose serial is the number of commits the client has sent.
  - **Keys:** v3 has no key events, so a key the IME takes and passes on as a character is committed text.
  - **Version:** 1. Version 2's actions, language and pre-edit hints aren't offered.
- **`zwp_text_input_v1`** (upstream, with Chrome's `zcr_extended_text_input`) is unchanged: `weston-editor` and Chrome-style clients.

**Embedded windows.** Two Exo fixes make the IME reach apps at all:
- **Compositions and commits weren't delivered** (0062). For an embedded window, EXO-EMBED stops every key at the window, so the page doesn't get it too. That included the IME's own `VKEY_PROCESSKEY`, which it sends before composing or committing. `InputMethodAsh` reads a stopped key as taken and drops the composition, so no IME text ever reached a native window, over v1 or v3. A key the IME handled is now only marked handled, which keeps it from the page all the same.
- **Keys the IME passes on were dropped** (0065). An IME engine (an extension IME, for example) answers asynchronously. The keys it doesn't take, such as Enter and Backspace outside a composition, arrows, and every shortcut, then reach Exo's `Keyboard` with no physical key code. Upstream drops those except for ARC and Crostini apps. In a Plutonium session (`--plutonium-hide-windows`), every surface now counts.

## How it was tested

**On X11 (Xvfb, slot 3), with a test IME.** No IME engine ships with a Chromium build: ChromeOS's are Google's extensions. `tools/ime-test-extension` is a tiny one, built on `chrome.input.ime`:
- letters compose;
- Space or Enter commits (`nihao` gives 你好, `nihon` 日本);
- Backspace edits the composition and Escape cancels it;
- `-` with nothing composed deletes the character before the cursor.

`tools/ime-test.sh` sets it up:

```
tools/ime-test.sh prefs ~/.local/share/plutonium/profile-x11-s3   # session stopped
plutonium run --x11 --flags "$(tools/ime-test.sh flags)" plain
CDP=localhost:9523 tools/ime-test.sh        # make it current; "off" for the US keyboard
```

Why each step is needed:
- **`prefs`:** an extension IME is only enabled if the profile lists it. The profile is the stub user's `test-user`.
- **`--load-extension`:** this loads the extension after Ash has picked the current IME at startup, so it doesn't become current by itself.
- **Making it current:** with `--allowlisted-extension-id`, the extension may use `chrome.inputMethodPrivate.setCurrentInputMethod`. A page of its own does that. Ash shows an "unsupported command-line flag" bar for that flag.

**Results**, with clients run under `WAYLAND_DEBUG=1`:
- **gtk4-demo** (`--run=entry_undo`), typing `nihao␣hello⏎-`:
  - `preedit_string("n", 1, 1)` … `("nihao", 5, 5)`, then `commit_string("你好")`, then `hello`, then `delete_surrounding_text(1, 0)`, each followed by `done`.
  - The entry then reported `set_surrounding_text("你好hell", 10, 10)`.
  - On screen, the pre-edit `nihon` was underlined in the entry and became 日本.
- **foot:** `preedit_string`/`commit_string` the same way; `echo你好` appeared at the prompt.
- **Without an engine** (the US keyboard), both bind v3, get `enter`/`leave`, `enable`/`disable` and their state, and typing goes through `wl_keyboard` as before.
- **Keys the IME passes on:** with the test IME current on build 0061–0064, gtk4-demo and foot got no `wl_keyboard.key` at all. With 0065 (build 3744b45d0cd4) they arrive:
  - **gtk4-demo**, after committing 你好: BackSpace deleted 好, Left and Right moved the cursor, and Ctrl+A and Return reached it.
  - **foot:** `echo␣␣nihao␣⏎` ran `echo 你好` and printed 你好.
  - **With the US keyboard** (no engine): foot's `echo abc`, Left Left BackSpace ⏎ printed `bc`, and gtk4-demo took arrows, BackSpace, Ctrl+A and Return as before.
- **Unit test:** `TextInputV3Test` (`components/exo/wayland/zwp_text_input_manager_unittest.cc`) plays the IME through the `TextInputClient`: enter, enable with content type and surrounding text, delete, compose, commit, clear, leave. It isn't run: `exo_unittests` doesn't build in this configuration (upstream `client_base.cc` needs minigbm).

## What's missing

- **Choosing an IME.** Shell mode has no settings UI or IME menu, and Ctrl+Space didn't switch IMEs in the test session. A user can't pick an input method yet. That needs a shell UI over `inputMethodPrivate`, or the language settings page, plus a way to install IMEs.
- **Real CJK IMEs** (Google's Japanese, Pinyin, Hangul) aren't in Chromium builds. A third-party extension IME from the Chrome Web Store should work like the test one, but that's untested.
- **The candidate window.** Ash draws it for IMEs that don't compose inline. Its placement over an embedded window, from the cursor rectangle, is unchecked.
- **Not tested:** Qt 6 apps; text-input-v3 version 2; a DRM session with a real keyboard.

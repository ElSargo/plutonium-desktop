# Passwords

**Status: design. Nothing here is built yet.**

One adapter connects the user's password manager (Bitwarden, 1Password, KeePassXC, `pass`, …) to every surface on the desktop: native apps, tabs and agents. Filling a login means typing it into the window or tab, or as a fallback copying it to the clipboard. Nothing hooks into a page's or app's own autofill.

## Why not Chrome's password manager

Plutonium builds Chromium, not Chrome (`chromium/args.gn`), and has no Google API keys. In March 2021 Google cut off Chrome Sync, and so the synced Google Password Manager, for every third-party Chromium build. Google enforces this on its servers, and keys a user brings don't get sync back either. Google Password Manager also has no public API. So the only Google option is a one-time CSV export, which isn't sync.

The people who already use a cross-platform password manager have the same problem on every other Linux desktop: it works in their browser extension and nowhere else. "Your password manager, in your apps, tabs and agents" is the stronger pitch anyway.

## Rules

1. **The secret never reaches a shell page.** Shells are web pages and anyone can write one. They get an entry's details (name, username, sites, apps), never its password or TOTP code. The helper fetches the secret and types it itself.
2. **A login only goes where it belongs.** For a tab, the helper checks the page's origin against the entry's sites before typing. For a native window, it checks the window's app id against the apps the user has linked to the entry. If neither matches, nothing is typed.
3. **An agent can ask for a fill but never sees the secret.** The user approves in a prompt that Ash draws and that only real input can answer.
4. **Fills leave a trail.** Each fill is logged in its thread: which entry, into which window or tab, and who asked (the user or an agent).

## The adapter (helper)

A provider is a small module in the helper (`helper/src/passwords/<provider>.ts`). They all have the same shape:

```ts
interface PasswordProvider {
  readonly id: string;                       // "bitwarden", "1password", …
  status(): Promise<"locked" | "unlocked" | "unavailable">;
  unlock(masterPassword?: string): Promise<void>;
  search(query: { text?: string; site?: string; appId?: string }): Promise<Entry[]>;
  secret(entryId: string, field: "password" | "totp" | "username"): Promise<string>;
  lock(): Promise<void>;
}

interface Entry {
  id: string;
  name: string;
  username: string | null;
  sites: string[];        // origins or registrable domains, from the manager
  appIds: string[];       // Plutonium's own links (see below)
  hasTotp: boolean;
}
```

`secret()` is only called inside the helper, right before typing, and its result isn't stored.

| Provider | Through | Unlock |
|---|---|---|
| Bitwarden / Vaultwarden | `bw` CLI (`bw serve` keeps one process and its session key) | master password, in the Ash prompt |
| 1Password | `op` CLI | the 1Password desktop app's own unlock (system auth) |
| KeePassXC | its browser protocol (`keepassxc-proxy`), as the browser extension uses it | KeePassXC's own window |
| `pass` | `pass` and `gpg` | gpg-agent's pinentry |

Bitwarden comes first: it's open source, can be self-hosted, and syncs on every platform.

**App links.** Password managers keep sites, not Linux app ids. Plutonium stores its own links (entry id → app ids) in `~/.config/plutonium/password-links.json`. Where the manager allows custom fields, a link can be stored with the entry and synced. The user makes a link the first time they fill an entry into an app ("Remember for Steam?").

## Filling

The user picks an entry in the shell (a picker the shell library provides; the shell sees only entries). Or an agent asks for one. Then the helper:

1. resolves the target: the tab or window the request names, else the one with keyboard focus;
2. checks the match (rule 2);
3. fetches the secret and types it;
4. logs the fill in the thread.

**Tabs.** The helper already holds a DevTools connection to the browser (`helper/src/cdp.ts`). It attaches to the tab's target and:
- checks the origin of the **focused frame**, not just the tab's URL, so a login can't be typed into a cross-origin iframe the page embeds;
- types with `Input.insertText`, which doesn't depend on the keyboard layout;
- types the username, Tab, the password, the way auto-type in KeePass does, or a single field when that's all that was asked for.

**Native windows.** Typing goes through Exo as key events to the window's surface. Wayland sends key codes and a keymap, not text, so characters missing from the user's layout can't be sent as they are. Exo can send a temporary keymap that has them for the duration of the fill, then restore the user's. This needs a browser call that only the helper can use (the shell must not be able to type arbitrary text into windows as the helper), which means a Chromium patch. X11 apps get the same key events through xwayland-satellite.

**Clipboard.** This is the fallback for anything auto-type can't reach. It's offered to the user, never to agents. The helper clears the clipboard after 20 seconds if it still holds the secret, and marks the copy as sensitive (`x-kde-passwordManagerHint`) so clipboard managers skip it. It depends on clipboard support between apps and pages, which isn't tested yet (`BACKLOG.md`).

**TOTP.** This works the same way, with `field: "totp"`. It's often the second thing typed at a login, so it can follow the password as a separate fill.

## Agents

A new MCP tool, `fill_login(target, entry?, fields?)`, goes from `plutonium.ts mcp` straight to the helper's socket. It doesn't go through the shell the way other agent calls do, so the helper knows an agent asked and can't mistake the request for the user's.

- **What the agent sees:** entry details only, from `list_logins(site | app)`. It never gets the password or the TOTP code.
- **Approval:** Ash draws the prompt as a native view, like the Super+Tab overlay, not in a shell page. It only takes real device input: a shell or an agent that can click and type into pages and windows can't answer it. The prompt names the thread, the entry, and the tab's origin or the app's name. "Allow for this thread and site" stops repeat prompts for the rest of the thread.
- **Reading it back:** once a login is typed into a tab, a shell with page scripting (T3's `preview_evaluate`, through `sendTabDevToolsCommand`) could read `input.value`. So after a fill, the browser refuses `Runtime` and `DOM` reads through the shell's DevTools passthrough for that tab until it navigates. `Input`, `Page` and screenshots keep working, and password fields are drawn masked.

## Trust, honestly

- An agent's reach is its thread's tag, which comes from an environment variable (`ARCHITECTURE.md`). A process that copies the variable can ask for fills in that thread. It still needs the user's approval, and it still only gets a login typed into a matching site or linked app.
- A native app's identity is its app id, and an app chooses its own id. A malicious app that claims to be Steam gets Steam's login once the user has linked Steam. Per-thread Exo sockets (`BACKLOG.md`) don't fix this. The rule that only the user, not an agent, can link an app limits it.
- The shell is trusted to say what the user picked, so a malicious shell can fill a login into a matching target without asking. That's no more than it could do by drawing a fake login form, which shells can already do.

## Order

1. **Adapter and Bitwarden.** Unlock in the Ash prompt, search, picker in the shell library, clipboard fill.
2. **Auto-type into tabs.** Focused-frame origin check, `Input.insertText`, the read-back block.
3. **Auto-type into native windows.** The Exo key-event patch with a temporary keymap, and app links.
4. **Agent fills.** `list_logins`, `fill_login`, the Ash approval prompt, per-thread allowances, the fill log.
5. **More providers.** 1Password, KeePassXC, `pass`.

## Open questions

- **Where the picker key lives.** Should there be one global key that every shell gets from the library, or should each shell bind its own? A global key in Ash would work the same in every shell.
- **Matching sites.** Exact origin, or registrable domain (`accounts.example.com` for `example.com`)? Bitwarden's per-entry match setting could decide this.
- **Saving new logins.** Out of scope for now. Users save logins in their manager's own app.
- **Passkeys.** These are WebAuthn, not typing, so this design doesn't cover them. They need the browser's WebAuthn path, with the manager as the authenticator.

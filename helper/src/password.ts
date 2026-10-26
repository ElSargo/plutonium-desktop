// Checking the user's own password, for the lock screen (DESKTOP_SERVICES.md,
// "session"). With PAM's own helper, unix_chkpwd, which every Linux with PAM
// has: setuid root, it checks the calling user's password (from /etc/shadow)
// against what it reads on stdin, and answers with its exit status. No PAM
// library, no new dependency. It can't check accounts PAM keeps elsewhere
// (LDAP, SSSD, systemd-homed): for those there's no checker, and the session
// service won't lock.
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { userInfo } from "node:os";

/** Where unix_chkpwd is: NixOS's setuid wrappers, then the usual places. */
export const CHECKER_PATHS = [
  "/run/wrappers/bin/unix_chkpwd",
  "/usr/sbin/unix_chkpwd",
  "/sbin/unix_chkpwd",
  "/usr/bin/unix_chkpwd",
  "/usr/libexec/unix_chkpwd",
];

/** PAM's return codes, as unix_chkpwd exits with them. */
const PAM_SUCCESS = 0;
const PAM_AUTH_ERR = 7;

/** Checks a password: true if it's the user's. Throws when it can't tell. */
export type PasswordChecker = (password: string) => Promise<boolean>;

/** The first unix_chkpwd there is that we may run, or null. */
export function findChecker(paths: readonly string[] = CHECKER_PATHS): string | null {
  for (const path of paths) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {}
  }
  return null;
}

/**
 * A checker with `program` (unix_chkpwd) for `user` (default: ours, the only
 * one it checks for us). The password goes on its stdin, ended with a NUL as
 * pam_unix sends it; "nullok" lets an account without a password in.
 */
export function unixChecker(program: string, user = userInfo().username): PasswordChecker {
  return (password) =>
    new Promise((resolve, reject) => {
      const child = spawn(program, [user, "nullok"], { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (code === PAM_SUCCESS) resolve(true);
        else if (code === PAM_AUTH_ERR) resolve(false);
        else reject(new Error(`${program} exited with ${signal ?? code}`));
      });
      child.stdin.on("error", () => {});
      child.stdin.end(Buffer.concat([Buffer.from(password, "utf8"), Buffer.from([0])]));
    });
}

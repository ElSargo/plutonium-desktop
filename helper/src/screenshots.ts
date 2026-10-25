// Screenshots on disk (docs/features/CAPTURE.md): where the shells' Print key
// and the portal's Screenshot put them, as GNOME and niri do:
// ~/Pictures/Screenshots/Screenshot from 2026-10-24 14-03-12.png.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Whether `data` starts like a PNG. */
export function isPng(data: Buffer): boolean {
  return data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

/** The folder screenshots go to: $PLUTONIUM_SCREENSHOTS_DIR, else ~/Pictures/Screenshots. */
export function screenshotsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PLUTONIUM_SCREENSHOTS_DIR || join(homedir(), "Pictures", "Screenshots");
}

/** "Screenshot from 2026-10-24 14-03-12.png", in local time. */
export function screenshotName(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return `Screenshot from ${day} ${time}.png`;
}

/**
 * Writes `png` into `dir` under `screenshotName(date)`, making the folder. Two
 * in the same second get " (1)", " (2)", ...
 */
export function saveScreenshot(png: Buffer, { dir = screenshotsDir(), date = new Date() } = {}): { path: string } {
  if (!isPng(png)) throw new Error("Expected a PNG.");
  let target = join(dir, screenshotName(date));
  const stem = target.slice(0, -".png".length);
  for (let i = 1; existsSync(target); i++) target = `${stem} (${i}).png`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, png);
  return { path: target };
}

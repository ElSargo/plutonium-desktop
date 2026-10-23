// EXO-TAB-FEATURES (docs/features/TAB_FEATURES.md, "Printing"): the host's
// printers, for the shell's print dialog and agents. Jobs go to the host's
// CUPS through its own client tools (`lpstat`, `lp`), which already know the
// user's default printer and server (`~/.cups/client.conf`, `$CUPS_SERVER`).
// "Save as PDF" writes the file here, since the browser may run in a
// container that doesn't see the user's home.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

export type Printer = {
  name: string;
  description: string;
  /** "idle", "printing", "disabled", or what lpstat says. */
  state: string;
  isDefault: boolean;
};

export type PrintOptions = {
  printer?: string;
  copies?: number;
  /** One- or two-sided. */
  duplex?: "none" | "long-edge" | "short-edge";
  color?: boolean;
  title?: string;
};

/** The paper sizes the dialog and agents name, in inches (as Page.printToPDF takes them). */
export const PAPER_SIZES: Record<string, [number, number]> = {
  letter: [8.5, 11],
  legal: [8.5, 14],
  tabloid: [11, 17],
  a3: [11.69, 16.54],
  a4: [8.27, 11.69],
  a5: [5.83, 8.27],
};

/** Margins by name, in inches; "default" leaves Chrome's (1 cm). */
export const MARGINS: Record<string, number | undefined> = { default: undefined, none: 0, minimum: 0.25 };

/** What the "print-to-pdf" tab command takes, from friendlier names (the library's too). */
export function pdfArguments(options: {
  paper?: string;
  landscape?: boolean;
  scale?: number;
  margins?: string;
  background?: boolean;
  headerFooter?: boolean;
  pageRanges?: string;
}): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (options.paper) {
    const size = PAPER_SIZES[options.paper.toLowerCase()];
    if (!size) throw new Error(`Unknown paper ${options.paper} (${Object.keys(PAPER_SIZES).join(", ")}).`);
    [args.paperWidth, args.paperHeight] = size;
  }
  if (options.landscape !== undefined) args.landscape = options.landscape;
  if (options.scale !== undefined) args.scale = options.scale;
  if (options.margins !== undefined) {
    if (!(options.margins in MARGINS)) throw new Error(`Unknown margins ${options.margins} (default, none, minimum).`);
    const margin = MARGINS[options.margins];
    if (margin !== undefined) {
      args.marginTop = args.marginBottom = args.marginLeft = args.marginRight = margin;
    }
  }
  if (options.background !== undefined) args.printBackground = options.background;
  if (options.headerFooter !== undefined) args.displayHeaderFooter = options.headerFooter;
  if (options.pageRanges) args.pageRanges = options.pageRanges;
  return args;
}

function run(
  command: string,
  args: string[],
  input?: Buffer,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C" } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/**
 * The host's printers (`lpstat -l -p -d`). `available` is false if there is no
 * CUPS client here, or no server answers.
 */
export async function listPrinters(): Promise<{ available: boolean; printers: Printer[]; error?: string }> {
  let result;
  try {
    result = await run("lpstat", ["-l", "-p", "-d"]);
  } catch {
    return { available: false, printers: [], error: "No CUPS client (lpstat) on this machine." };
  }
  const printers: Printer[] = [];
  let defaultName = "";
  for (const line of result.stdout.split("\n")) {
    const printer = line.match(/^printer (\S+) (?:is (\w+)|(disabled))/);
    if (printer) {
      printers.push({ name: printer[1]!, description: "", state: printer[2] ?? printer[3]!, isDefault: false });
      continue;
    }
    const description = line.match(/^\s+Description: (.*)$/);
    if (description && printers.length) printers.at(-1)!.description = description[1]!.trim();
    const fallback = line.match(/^system default destination: (\S+)/);
    if (fallback) defaultName = fallback[1]!;
  }
  for (const printer of printers) printer.isDefault = printer.name === defaultName;
  if (result.code !== 0 && !printers.length) {
    // No printers is exit 0 with "No destinations added" on stderr; a missing server isn't.
    if (!/no destinations/i.test(result.stderr)) {
      return { available: false, printers, error: result.stderr.trim() || `lpstat exited ${result.code}` };
    }
  }
  return { available: true, printers };
}

/** Sends `pdf` to the host's CUPS (`lp`); resolves with the job id. */
export async function printPdf(pdf: Buffer, options: PrintOptions = {}): Promise<{ job: string }> {
  const args: string[] = [];
  if (options.printer) args.push("-d", options.printer);
  if (options.copies !== undefined) {
    const copies = Math.floor(options.copies);
    if (!(copies >= 1 && copies <= 999)) throw new Error("copies must be between 1 and 999.");
    args.push("-n", String(copies));
  }
  if (options.duplex) {
    const sides = { none: "one-sided", "long-edge": "two-sided-long-edge", "short-edge": "two-sided-short-edge" }[
      options.duplex
    ];
    if (!sides) throw new Error("duplex must be none, long-edge or short-edge.");
    args.push("-o", `sides=${sides}`);
  }
  if (options.color !== undefined) args.push("-o", `print-color-mode=${options.color ? "color" : "monochrome"}`);
  if (options.title) args.push("-t", options.title.slice(0, 255));
  args.push("--", "-");
  let result;
  try {
    result = await run("lp", args, pdf);
  } catch {
    throw new Error("No CUPS client (lp) on this machine.");
  }
  if (result.code !== 0) throw new Error(result.stderr.trim() || `lp exited ${result.code}`);
  const job = result.stdout.match(/request id is (\S+)/)?.[1] ?? result.stdout.trim();
  return { job };
}

/** A file name from a page title ("My page.pdf"). */
export function pdfFileName(title: string): string {
  const name = title.replace(/[/\\\0:*?"<>|\n\r\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return `${name || "page"}.pdf`;
}

/**
 * Writes `pdf` to `path` (absolute, or starting with "~/"), making its folder.
 * An existing file isn't overwritten unless `overwrite`: the name gets " (1)", " (2)", ...
 */
export function savePdf(pdf: Buffer, path: string, { overwrite = false } = {}): { path: string } {
  let target = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  if (!isAbsolute(target)) throw new Error("path must be absolute (or start with ~/).");
  target = resolve(target);
  if (!overwrite && existsSync(target)) {
    const extension = extname(target);
    const stem = target.slice(0, target.length - extension.length);
    for (let i = 1; existsSync(target); i++) target = `${stem} (${i})${extension}`;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, pdf);
  return { path: target };
}

/** Where "Save as PDF" puts a page by default: `~/Downloads/<title>.pdf`. */
export function defaultPdfPath(title: string): string {
  return join(homedir(), "Downloads", pdfFileName(title));
}

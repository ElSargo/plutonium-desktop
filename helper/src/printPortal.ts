// The Print portal (docs/features/TAB_FEATURES.md, "The Print portal"): apps'
// print dialogs are the shells' print dialog, without a preview, and their
// jobs go to the host's CUPS as tabs' do (printing.ts).
//
// - PreparePrint asks the focused shell ("print_prepare" over the shell
//   relay); the answer becomes GTK's print settings and page setup, and a
//   token for Print.
// - Print gets the document (a PDF, as GTK and Qt make it) and the token's
//   choice: `lp` to a printer, or the file "Save as PDF" named. Without a
//   token, it asks first.
//
// The document comes as a Unix fd, which Node can't receive, so the D-Bus
// side is printportal.py, under a name of its own (plutonium-print.portal);
// it sends each call here as a JSON line and takes the answer back.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Variant } from "./dbus.ts";
import { defaultPdfPath, printPdf, savePdf } from "./printing.ts";

export const PRINT_NAME = "org.freedesktop.impl.portal.desktop.plutonium.print";
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "printportal.py");

const SUCCESS = 0;
const CANCELLED = 1;
const OTHER = 2;

/** What the shell's dialog answers. `printer` "" is "Save as PDF", to `path`. */
export interface PrintChoice {
  readonly printer: string;
  readonly path?: string;
  readonly copies?: number;
  readonly duplex?: "none" | "long-edge" | "short-edge";
  readonly color?: boolean;
  readonly paper?: string;
  readonly landscape?: boolean;
  /** "1-3, 5", one-based; "" for all. */
  readonly pageRanges?: string;
}

/** The dialog's paper sizes as GTK names them (PWG), with their size in mm. */
const PAPERS: Record<string, [name: string, display: string, width: number, height: number]> = {
  letter: ["na_letter", "US Letter", 215.9, 279.4],
  legal: ["na_legal", "US Legal", 215.9, 355.6],
  tabloid: ["na_ledger", "Tabloid", 279.4, 431.8],
  a3: ["iso_a3", "A3", 297, 420],
  a4: ["iso_a4", "A4", 210, 297],
  a5: ["iso_a5", "A5", 148, 210],
};
/** GTK's default margins, a quarter inch. */
const MARGIN_MM = 6.35;

/** The dialog's starting values from the app's settings and page setup. */
export function printDetail(
  title: string,
  settings: Record<string, unknown>,
  pageSetup: Record<string, unknown>,
): Record<string, unknown> {
  const detail: Record<string, unknown> = { title };
  if (typeof settings.printer === "string" && settings.printer !== "Print to File") detail.printer = settings.printer;
  const copies = Number(settings["n-copies"]);
  if (copies >= 1) detail.copies = copies;
  const orientation = String(settings.orientation ?? pageSetup.Orientation ?? "");
  if (orientation) detail.landscape = orientation.includes("landscape");
  const paperName = String(settings["paper-format"] ?? pageSetup.Name ?? pageSetup.PPDName ?? "");
  const paper = Object.entries(PAPERS).find(([, [name]]) => paperName === name || paperName.startsWith(`${name}_`));
  if (paper) detail.paper = paper[0];
  return detail;
}

/** "1-3, 5" (one-based) as GTK keeps ranges: "0-2,4". Throws on anything else. */
export function gtkPageRanges(text: string): string {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
      const start = Number(match?.[1]);
      const end = match?.[2] !== undefined ? Number(match[2]) : start;
      if (!match || start < 1 || end < start) throw new Error(`Not a page range: ${part}`);
      return start === end ? String(start - 1) : `${start - 1}-${end - 1}`;
    })
    .join(",");
}

/** GTK's print settings (all strings) for a choice. */
export function gtkSettings(choice: PrintChoice, title: string): Record<string, Variant> {
  const [name, , width, height] = PAPERS[choice.paper ?? "a4"] ?? PAPERS.a4!;
  const settings: Record<string, string> = {
    printer: choice.printer || "Print to File",
    "n-copies": String(choice.copies ?? 1),
    duplex: { none: "simplex", "long-edge": "horizontal", "short-edge": "vertical" }[choice.duplex ?? "none"],
    "use-color": String(choice.color !== false),
    orientation: choice.landscape ? "landscape" : "portrait",
    "paper-format": name,
    "paper-width": String(width),
    "paper-height": String(height),
    "print-pages": choice.pageRanges ? "ranges" : "all",
  };
  if (choice.pageRanges) settings["page-ranges"] = gtkPageRanges(choice.pageRanges);
  if (!choice.printer) {
    settings["output-file-format"] = "pdf";
    settings["output-uri"] = pathToFileURL(choice.path || defaultPdfPath(title)).href;
  }
  return Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, ["s", value]]));
}

/** GTK's page setup for a choice. */
export function gtkPageSetup(choice: PrintChoice): Record<string, Variant> {
  const [name, display, width, height] = PAPERS[choice.paper ?? "a4"] ?? PAPERS.a4!;
  return {
    PPDName: ["s", ""],
    Name: ["s", name],
    DisplayName: ["s", display],
    Width: ["d", width],
    Height: ["d", height],
    MarginTop: ["d", MARGIN_MM],
    MarginBottom: ["d", MARGIN_MM],
    MarginLeft: ["d", MARGIN_MM],
    MarginRight: ["d", MARGIN_MM],
    Orientation: ["s", choice.landscape ? "landscape" : "portrait"],
  };
}

interface PrintCall {
  readonly id: number;
  readonly method: "PreparePrint" | "Print";
  readonly handle: string;
  readonly appId: string;
  readonly parent: string;
  readonly title: string;
  readonly settings?: Record<string, unknown>;
  readonly pageSetup?: Record<string, unknown>;
  readonly options?: Record<string, unknown>;
  readonly document?: string;
}

type Results = Record<string, [string, unknown]>;

export interface PrintBackendOptions {
  readonly address: string;
  /** Asks the focused shell (the shell relay); rejects if none answers. */
  readonly askShell: (op: string, args: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
  readonly notifyShells?: (op: string, args: Record<string, unknown>) => void;
  /** Who asks, and the window to show the dialog over (portal.ts). */
  readonly source: (handle: string, appId: string) => Promise<{ source: Record<string, unknown>; thread: string | null }>;
  /** For tests: what sends jobs and saves files. */
  readonly printPdf?: typeof printPdf;
  readonly savePdf?: typeof savePdf;
}

export class PrintBackend {
  private readonly options: PrintBackendOptions;
  private child: ChildProcess | null = null;
  private readonly tokens = new Map<number, PrintChoice>();
  private nextToken = 1;
  /** Calls waiting on the user, by handle: how to cancel each. */
  private readonly asking = new Map<string, () => void>();

  constructor(options: PrintBackendOptions) {
    this.options = options;
  }

  start(): void {
    const child = spawn("python3", ["-I", SCRIPT, this.options.address, PRINT_NAME], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.child = child;
    child.on("error", (error) => console.warn(`plutoniumd: no Print portal (python3: ${error.message})`));
    child.on("exit", (code) => {
      if (this.child === child && code) console.warn(`plutoniumd: the Print portal ended (${code})`);
    });
    createInterface({ input: child.stdout! }).on("line", (line) => {
      let message: PrintCall | { ready: boolean; name: string } | { method: "Close"; handle: string };
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if ("ready" in message) {
        console.log(`plutoniumd: Print portal ${message.ready ? "serving" : "not serving (taken)"} as ${message.name}`);
      } else if (message.method === "Close") {
        this.asking.get(message.handle)?.();
      } else {
        void this.call(message).then(([response, results]) => {
          child.stdin?.write(`${JSON.stringify({ id: message.id, response, results })}\n`);
        });
      }
    });
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }

  /** One call, answered as [response, results]. */
  async call(call: PrintCall): Promise<[number, Results]> {
    try {
      if (call.method === "PreparePrint") {
        const detail = printDetail(call.title, call.settings ?? {}, call.pageSetup ?? {});
        const choice = await this.ask(call, detail);
        if (!choice) return [CANCELLED, {}];
        const token = this.nextToken++;
        this.tokens.set(token, choice);
        return [SUCCESS, {
          settings: ["a{sv}", gtkSettings(choice, call.title)],
          "page-setup": ["a{sv}", gtkPageSetup(choice)],
          token: ["u", token],
        }];
      }
      let document: Buffer;
      try {
        document = readFileSync(call.document!);
      } finally {
        if (call.document) unlinkSync(call.document);
      }
      const token = Number(call.options?.token);
      let choice = this.tokens.get(token);
      this.tokens.delete(token);
      choice ??= (await this.ask(call, { title: call.title })) ?? undefined;
      if (!choice) return [CANCELLED, {}];
      if (choice.printer) {
        const { job } = await (this.options.printPdf ?? printPdf)(document, {
          printer: choice.printer,
          // GTK lays out the copies in the document itself (two copies of one page: two pages).
          duplex: choice.duplex,
          color: choice.color,
          title: call.title,
        });
        console.log(`plutoniumd: portal: printed "${call.title}" on ${choice.printer} (job ${job})`);
      } else {
        const { path } = (this.options.savePdf ?? savePdf)(document, choice.path || defaultPdfPath(call.title));
        console.log(`plutoniumd: portal: saved "${call.title}" as ${path}`);
      }
      return [SUCCESS, {}];
    } catch (error) {
      console.warn(`plutoniumd: portal: ${call.method}: ${(error as Error).message}`);
      return [OTHER, {}];
    }
  }

  /** The shell's print dialog; null if the user cancelled or the app gave up. */
  private async ask(call: PrintCall, detail: Record<string, unknown>): Promise<PrintChoice | null> {
    const { source, thread } = await this.options.source(call.handle, call.appId);
    let cancelled = false;
    this.asking.set(call.handle, () => {
      cancelled = true;
      this.options.notifyShells?.("print_cancel", { handle: call.handle });
    });
    try {
      const answer = (await this.options.askShell(
        "print_prepare",
        { handle: call.handle, detail, source: { ...source, parent: call.parent }, thread },
        3_600_000,
      )) as PrintChoice | null;
      if (cancelled || !answer || typeof answer.printer !== "string") return null;
      // "~/Downloads/x.pdf", as the dialog shows it.
      return answer.path?.startsWith("~/") ? { ...answer, path: join(homedir(), answer.path.slice(2)) } : answer;
    } catch (error) {
      this.options.notifyShells?.("print_cancel", { handle: call.handle });
      throw error;
    } finally {
      this.asking.delete(call.handle);
    }
  }
}

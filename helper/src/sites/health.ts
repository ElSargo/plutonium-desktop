// Whether site extensions still work (SITE_EXTENSIONS.md, "Keeping them
// working"). After a page loads, the helper reads what ran (injector.ts's
// report) and keeps, per part, which site.observe() selectors have ever
// matched. A part is stale on a site when it threw, or when a selector that
// used to match finds nothing: the site changed under it. A fix starts from
// the stale reasons.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { TabReport } from "./injector.ts";

export interface StaleReason {
  readonly part: string;
  readonly kind: "error" | "selector";
  /** The error, or the selector that matched nothing. */
  readonly detail: string;
  readonly url: string;
  readonly at: number;
}

interface PartHealth {
  /** Selectors that have matched something, and when they last did. */
  selectors: Record<string, number>;
}

export class SiteHealth {
  private readonly file: string;
  private parts: Record<string, PartHealth>;
  /** Stale reasons, by part id. */
  private readonly stale = new Map<string, StaleReason[]>();
  /** Called when a part becomes stale, or stops being. */
  onChange: ((part: string, reasons: readonly StaleReason[]) => void) | null = null;

  constructor(file: string) {
    this.file = file;
    try {
      this.parts = JSON.parse(readFileSync(file, "utf8")) as Record<string, PartHealth>;
    } catch {
      this.parts = {};
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.parts));
    } catch {}
  }

  /** Takes a tab's report after its page loaded. */
  update(report: TabReport, now = Date.now()): void {
    let changed = false;
    for (const part of report.parts) {
      if (!part.applies || !part.running) continue;
      const health = (this.parts[part.id] ??= { selectors: {} });
      const reasons: StaleReason[] = [];
      for (const error of part.errors) {
        reasons.push({ part: part.id, kind: "error", detail: error.message, url: report.url, at: now });
      }
      for (const { selector, matched } of part.observers) {
        if (matched > 0) {
          if (health.selectors[selector] === undefined) changed = true;
          health.selectors[selector] = now;
        } else if (health.selectors[selector] !== undefined) {
          reasons.push({ part: part.id, kind: "selector", detail: selector, url: report.url, at: now });
        }
      }
      const before = JSON.stringify((this.stale.get(part.id) ?? []).map(({ kind, detail }) => [kind, detail]));
      const after = JSON.stringify(reasons.map(({ kind, detail }) => [kind, detail]));
      if (reasons.length) this.stale.set(part.id, reasons);
      else this.stale.delete(part.id);
      if (before !== after) this.onChange?.(part.id, reasons);
    }
    if (changed) this.save();
  }

  /** A part changed (a new hash): its old reasons no longer apply. */
  forget(part: string): void {
    if (this.stale.delete(part)) this.onChange?.(part, []);
  }

  /** Stale reasons, of one site or of every site. */
  reasons(site?: string): StaleReason[] {
    return [...this.stale.values()].flat().filter((reason) => !site || reason.part.startsWith(`${site}/`));
  }
}

/** The request a Fix starts with: what broke, for the agent. */
export function fixRequest(reasons: readonly StaleReason[]): string {
  const lines = reasons.map((reason) =>
    reason.kind === "error"
      ? `- ${reason.part} throws: ${reason.detail} (on ${reason.url})`
      : `- ${reason.part}: site.observe("${reason.detail}") matches nothing on ${reason.url}, where it used to match`,
  );
  return [
    "This site's extension stopped working; the site probably changed its markup. Fix it so it does what its requests.md asked, on the page as it is now:",
    ...lines,
    "Read the page first, and prefer selectors less likely to change (data-testid, aria-*, roles, ids).",
  ].join("\n");
}

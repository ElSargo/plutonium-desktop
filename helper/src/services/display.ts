// The display service (DESKTOP_SERVICES.md, "display"): the monitors and how
// they're set up (where each one is, its resolution and refresh rate, its
// size, rotation, which is primary, mirroring, the built-in panel on or off),
// and the switcher's Displays page, which a shell's bar opens. The displays
// are Ash's (its CrosDisplayConfig, as ChromeOS's Settings uses), through the
// Plutonium DevTools domain: `Plutonium.getDisplayConfig`,
// `configureDisplays`, `openSwitcher` and the `displayConfigChanged` event.
import { ServiceError, type DesktopService } from "../services.ts";

export interface DisplayMode {
  /** Physical pixels. */
  readonly width: number;
  readonly height: number;
  /** Hz. */
  readonly refreshRate: number;
  /** The mode's own device scale factor (Ash's default for the panel). */
  readonly scale: number;
  readonly native: boolean;
  readonly interlaced?: boolean;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DisplayInfo {
  /** Ash's display id, as a string (they don't fit in a double). */
  readonly id: string;
  /** 1-based, left to right then top to bottom: "display 2". */
  readonly index: number;
  readonly name: string;
  readonly internal: boolean;
  readonly primary: boolean;
  /** False only for the built-in panel turned off while a monitor is on. */
  readonly enabled: boolean;
  /** DIPs, in the desktop's coordinates. */
  readonly bounds: Rect;
  readonly workArea: Rect;
  /** Degrees, clockwise. */
  readonly rotation: 0 | 90 | 180 | 270;
  /** The effective device scale factor (the mode's scale times the zoom). */
  readonly scale: number;
  /** The display's size setting: 1 is the mode's own, more is bigger. */
  readonly zoom: number;
  readonly zooms: readonly number[];
  readonly mode: DisplayMode | null;
  readonly modes: readonly DisplayMode[];
}

export interface DisplayState {
  readonly available: boolean;
  readonly displays: readonly DisplayInfo[];
  /** Every display shows the same thing. */
  readonly mirror: boolean;
  readonly canMirror: boolean;
  /** A change waiting for "Keep" (the switcher's), with the seconds before it goes back. */
  readonly pending: { readonly what: string; readonly secondsLeft: number } | null;
}

/** The browser's side, through the Plutonium domain (null: an older browser, or none). */
export interface BrowserDisplays {
  config(): Promise<Omit<DisplayState, "available"> | null>;
  /** Applies a change (the domain's JSON); throws with the browser's reason. */
  configure(change: Record<string, unknown>): Promise<void>;
  /** Opens the switcher on one of its pages ("displays", "settings", …). */
  openSwitcher(page: string): Promise<void>;
  onChange(listener: () => void): void;
}

const NONE: DisplayState = { available: false, displays: [], mirror: false, canMirror: false, pending: null };
const ROTATIONS = new Set([0, 90, 180, 270]);
/** The switcher's pages a shell may open. */
export const SWITCHER_PAGES = [
  "settings",
  "displays",
  "network",
  "bluetooth",
  "sound",
  "power",
  "notifications",
] as const;

export class DisplayService implements DesktopService {
  readonly name = "display";
  private readonly browser: BrowserDisplays | null;
  private changed: (state: unknown) => void = () => {};
  private last = "";

  constructor(browser: BrowserDisplays | null) {
    this.browser = browser;
  }

  async start(changed: (state: unknown) => void): Promise<void> {
    this.changed = changed;
    this.browser?.onChange(() => void this.refresh());
    this.last = JSON.stringify(await this.state());
  }

  async state(): Promise<DisplayState> {
    if (!this.browser) return NONE;
    let config: Omit<DisplayState, "available"> | null = null;
    try {
      config = await this.browser.config();
    } catch {
      config = null;
    }
    return config ? { ...NONE, ...config, available: true } : NONE;
  }

  async call(action: string, args: Record<string, unknown>): Promise<unknown> {
    if (action === "open-settings") {
      const page = args.page ?? "displays";
      if (typeof page !== "string" || !(SWITCHER_PAGES as readonly string[]).includes(page)) {
        throw new ServiceError(400, `page is one of ${SWITCHER_PAGES.join(", ")}.`);
      }
      await this.need().openSwitcher(page);
      return null;
    }
    const change = await this.changeFor(action, args);
    try {
      await this.need().configure(change);
    } catch (error) {
      throw new ServiceError(400, (error as Error).message);
    }
    return this.refresh();
  }

  /** The browser's change for an action, with displays named by id. */
  private async changeFor(action: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const confirm = args.confirm === true ? { confirm: true } : {};
    switch (action) {
      case "configure": {
        const change: Record<string, unknown> = { display: await this.idOf(args.display), ...confirm };
        if (args.mode !== undefined) {
          const mode = args.mode as Record<string, unknown> | null;
          if (!mode || !positive(mode.width) || !positive(mode.height)) {
            throw new ServiceError(400, "mode is {width, height, refreshRate?}.");
          }
          change.mode = {
            width: mode.width,
            height: mode.height,
            ...(positive(mode.refreshRate) ? { refreshRate: mode.refreshRate } : {}),
          };
        }
        if (args.zoom !== undefined) {
          if (!positive(args.zoom)) throw new ServiceError(400, "zoom is a number above 0.");
          change.zoom = args.zoom;
        }
        if (args.rotation !== undefined) {
          if (!ROTATIONS.has(args.rotation as number)) throw new ServiceError(400, "rotation is 0, 90, 180 or 270.");
          change.rotation = args.rotation;
        }
        if (args.primary !== undefined) {
          if (args.primary !== true) throw new ServiceError(400, "primary can only be true: make another display primary instead.");
          change.primary = true;
        }
        if (args.enabled !== undefined) {
          if (typeof args.enabled !== "boolean") throw new ServiceError(400, "enabled is a boolean.");
          change.enabled = args.enabled;
        }
        if (args.position !== undefined) {
          const position = args.position as Record<string, unknown> | null;
          if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
            throw new ServiceError(400, "position is {x, y}, in DIPs.");
          }
          change.position = { x: Math.round(position.x as number), y: Math.round(position.y as number) };
        }
        if (Object.keys(change).length === 1 + Object.keys(confirm).length) {
          throw new ServiceError(400, "Nothing to change: give mode, zoom, rotation, primary, enabled or position.");
        }
        return change;
      }
      case "arrange": {
        if (!Array.isArray(args.layout) || args.layout.length === 0) {
          throw new ServiceError(400, "layout is [{display, x, y}, …].");
        }
        const layout = [];
        for (const entry of args.layout as Record<string, unknown>[]) {
          if (!entry || !Number.isFinite(entry.x) || !Number.isFinite(entry.y)) {
            throw new ServiceError(400, "layout is [{display, x, y}, …].");
          }
          layout.push({ display: await this.idOf(entry.display), x: Math.round(entry.x as number), y: Math.round(entry.y as number) });
        }
        return { layout };
      }
      case "set-mirror":
        if (typeof args.on !== "boolean") throw new ServiceError(400, "on is a boolean.");
        return { mirror: args.on, ...confirm };
      case "keep":
        return { keep: true };
      case "revert":
        return { revert: true };
      default:
        throw new ServiceError(404, `The display service has no action "${action}".`);
    }
  }

  /** A display's id from its id or its number (1-based, as "display 2"). */
  private async idOf(display: unknown): Promise<string> {
    const { displays } = await this.state();
    const found =
      typeof display === "number"
        ? displays.find((entry) => entry.index === display)
        : typeof display === "string"
          ? displays.find((entry) => entry.id === display)
          : undefined;
    if (!found) throw new ServiceError(400, `No display ${JSON.stringify(display ?? null)}: give its id or number.`);
    return found.id;
  }

  private need(): BrowserDisplays {
    if (!this.browser) throw new ServiceError(409, "The browser can't configure displays (no DevTools port).");
    return this.browser;
  }

  /** Reads the state again; sends it if it changed. */
  private async refresh(): Promise<DisplayState> {
    const state = await this.state();
    const json = JSON.stringify(state);
    if (json !== this.last) {
      this.last = json;
      this.changed(state);
    }
    return state;
  }
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

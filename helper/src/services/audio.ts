// The audio service (DESKTOP_SERVICES.md, "audio"): PipeWire's outputs and
// inputs, their volume and mute, and the default ones. The state comes from
// `pw-dump`, read again whenever `pw-dump --monitor` reports a node, device or
// metadata change; actions go through `wpctl`, WirePlumber's own tool, which
// sets a device's route volume as pavucontrol does.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { ServiceError, type DesktopService } from "../services.ts";

const run = promisify(execFile);

/** One output (sink) or input (source). */
export interface AudioDevice {
  /** PipeWire's object id: what the actions take. It changes when PipeWire restarts. */
  readonly id: number;
  /** Its node name, which doesn't change. */
  readonly node: string;
  readonly name: string;
  readonly default: boolean;
  /** 0–1 as in pavucontrol and wpctl (cubic), above 1 when boosted. */
  readonly volume: number;
  readonly muted: boolean;
}

export interface AudioState {
  readonly available: boolean;
  /** The default output's volume and mute (0 and false without one). */
  readonly volume: number;
  readonly muted: boolean;
  readonly output: AudioDevice | null;
  readonly input: AudioDevice | null;
  readonly outputs: AudioDevice[];
  readonly inputs: AudioDevice[];
}

const NONE: AudioState = { available: false, volume: 0, muted: false, output: null, input: null, outputs: [], inputs: [] };

/** set-volume's ceiling; `step` stops at 1. */
const MAX_VOLUME = 1.5;

interface PwObject {
  id: number;
  type?: string;
  info?: { props?: Record<string, unknown>; params?: Record<string, Record<string, unknown>[]> } | null;
  props?: Record<string, unknown>;
  metadata?: { key: string; value: unknown }[];
}

/** The state in a `pw-dump`. */
export function audioState(objects: readonly PwObject[]): AudioState {
  const defaults = new Map<string, string>();
  for (const object of objects) {
    if (!object.type?.endsWith(":Metadata") || object.props?.["metadata.name"] !== "default") continue;
    for (const entry of object.metadata ?? []) {
      const name = (entry.value as { name?: unknown } | null)?.name;
      if (typeof name === "string") defaults.set(entry.key, name);
    }
  }
  const devices = (kind: "Sink" | "Source"): AudioDevice[] => {
    const defaultNode = defaults.get(kind === "Sink" ? "default.audio.sink" : "default.audio.source");
    return objects.flatMap((object) => {
      const props = object.info?.props ?? {};
      if (!object.type?.endsWith(":Node") || props["media.class"] !== `Audio/${kind}`) return [];
      const params = (object.info?.params?.Props ?? []).find((entry) => Array.isArray(entry.channelVolumes));
      const channels = (params?.channelVolumes as number[] | undefined) ?? [];
      const linear = channels.length ? channels.reduce((sum, value) => sum + value, 0) / channels.length : 0;
      const node = String(props["node.name"] ?? object.id);
      return [
        {
          id: object.id,
          node,
          name: String(props["node.description"] ?? props["node.nick"] ?? node),
          default: node === defaultNode,
          volume: Math.round(Math.cbrt(linear) * 1000) / 1000,
          muted: params?.mute === true,
        },
      ];
    });
  };
  const outputs = devices("Sink");
  const inputs = devices("Source");
  const output = outputs.find((device) => device.default) ?? null;
  return {
    available: true,
    volume: output?.volume ?? 0,
    muted: output?.muted ?? false,
    output,
    input: inputs.find((device) => device.default) ?? null,
    outputs,
    inputs,
  };
}

/** Whether a monitor update (one array of `pw-dump --monitor`) can change the state. */
function touchesState(objects: readonly PwObject[], known: ReadonlySet<number>): boolean {
  return objects.some(
    (object) =>
      known.has(object.id) || /:(Node|Device|Metadata)$/.test(object.type ?? ""),
  );
}

export interface AudioOptions {
  /** The commands' environment (tests put a fake `wpctl` and `pw-dump` on its PATH). */
  readonly env?: NodeJS.ProcessEnv;
}

export class AudioService implements DesktopService {
  readonly name = "audio";
  private readonly env: NodeJS.ProcessEnv;
  private current: AudioState = NONE;
  private text = JSON.stringify(NONE);
  private changed: (state: unknown) => void = () => {};
  private monitor: ChildProcess | null = null;
  private refreshing: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  /** The ids of the nodes, devices and metadata in the last dump: their removal counts. */
  private known = new Set<number>();

  constructor(options: AudioOptions = {}) {
    this.env = options.env ?? process.env;
  }

  async start(changed: (state: unknown) => void): Promise<void> {
    this.changed = changed;
    this.stopped = false;
    await this.refresh();
    if (this.current.available) this.watch();
  }

  async state(): Promise<AudioState> {
    return this.current;
  }

  async call(action: string, args: Record<string, unknown>): Promise<AudioState> {
    if (!this.current.available) throw new ServiceError(404, "There is no PipeWire here.");
    switch (action) {
      case "set-volume": {
        const volume = Number(args.volume);
        if (!Number.isFinite(volume) || volume < 0) throw new ServiceError(400, "volume: a number from 0.");
        await this.wpctl("set-volume", this.target(args.device), String(Math.min(volume, MAX_VOLUME)));
        break;
      }
      case "set-mute": {
        const muted = args.muted === undefined ? "toggle" : args.muted ? "1" : "0";
        await this.wpctl("set-mute", this.target(args.device), muted);
        break;
      }
      case "set-default": {
        if (args.device === undefined) throw new ServiceError(400, "device: an output or input id.");
        await this.wpctl("set-default", this.target(args.device));
        break;
      }
      case "step": {
        const by = Number(args.by ?? 0.05);
        if (!Number.isFinite(by)) throw new ServiceError(400, "by: a number, + or −.");
        const target = this.target(args.device);
        // The volume keys: up unmutes, and stops at 100%.
        if (by > 0) await this.wpctl("set-mute", target, "0");
        const percent = `${Math.round(Math.abs(by) * 100)}%${by < 0 ? "-" : "+"}`;
        await this.wpctl("set-volume", target, percent, "--limit", "1");
        break;
      }
      default:
        throw new ServiceError(404, `audio has no action "${action}".`);
    }
    await this.refresh();
    return this.current;
  }

  stop(): void {
    this.stopped = true;
    this.monitor?.kill();
    this.monitor = null;
  }

  /** A wpctl target: an id from the state, or "output"/"input" (the defaults, the default when left out). */
  private target(device: unknown): string {
    if (device === undefined || device === null || device === "output") return "@DEFAULT_AUDIO_SINK@";
    if (device === "input") return "@DEFAULT_AUDIO_SOURCE@";
    const id = Number(device);
    if (![...this.current.outputs, ...this.current.inputs].some((known) => known.id === id)) {
      throw new ServiceError(400, `device: no output or input ${JSON.stringify(device)}.`);
    }
    return String(id);
  }

  private async wpctl(...args: string[]): Promise<void> {
    try {
      await run("wpctl", args, { env: this.env, timeout: 5_000 });
    } catch (error) {
      throw new ServiceError(500, `wpctl ${args.join(" ")}: ${(error as { stderr?: string }).stderr?.trim() || (error as Error).message}`);
    }
  }

  /** Reads the state again, once at a time (a change during a read reads again after it). */
  private refresh(): Promise<void> {
    if (this.refreshing) {
      this.again = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.again = false;
        let next: AudioState;
        try {
          const { stdout } = await run("pw-dump", ["--no-colors"], { env: this.env, timeout: 5_000, maxBuffer: 64 << 20 });
          const objects = JSON.parse(stdout) as PwObject[];
          this.known = new Set(objects.filter((object) => touchesState([object], new Set())).map((object) => object.id));
          next = audioState(objects);
        } catch {
          next = NONE;
        }
        this.set(next);
      } while (this.again);
    })().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private set(state: AudioState): void {
    const text = JSON.stringify(state);
    this.current = state;
    if (text === this.text) return;
    this.text = text;
    this.changed(state);
  }

  /** `pw-dump --monitor`: each top-level array it prints is an update. Restarted if it exits (PipeWire restarting). */
  private watch(): void {
    if (this.stopped || this.monitor) return;
    const monitor = spawn("pw-dump", ["--monitor", "--no-colors"], { env: this.env, stdio: ["ignore", "pipe", "ignore"] });
    this.monitor = monitor;
    let lines: string[] = [];
    let partial = "";
    let first = true;
    monitor.stdout!.setEncoding("utf8");
    monitor.stdout!.on("data", (data: string) => {
      const parts = (partial + data).split("\n");
      partial = parts.pop()!;
      for (const line of parts) {
        lines.push(line);
        if (line !== "]") continue;
        const update = lines.join("\n");
        lines = [];
        // The first one is the whole graph, which start() has read already.
        if (first) {
          first = false;
          continue;
        }
        try {
          if (touchesState(JSON.parse(update) as PwObject[], this.known)) void this.refresh();
        } catch {
          void this.refresh();
        }
      }
    });
    monitor.on("error", () => {});
    monitor.on("exit", () => {
      if (this.monitor !== monitor) return;
      this.monitor = null;
      if (this.stopped) return;
      void this.refresh();
      setTimeout(() => this.watch(), 2_000).unref();
    });
  }
}

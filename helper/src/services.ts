// Desktop services for shells (docs/features/DESKTOP_SERVICES.md): audio,
// brightness and power, network, Bluetooth… The helper talks to the host's
// services (D-Bus, PipeWire); a shell only draws them. Each service has a
// state (JSON), sends its new state when it changes, and has actions. An
// installed shell gets the ones its shell.json names in "uses".

/** One service, as registered with DesktopServices. */
export interface DesktopService {
  readonly name: string;
  /**
   * Starts watching the host's service, once, on a shell's first use;
   * `changed` gets every new state.
   */
  start(changed: (state: unknown) => void): Promise<void>;
  /** The state now. */
  state(): Promise<unknown>;
  /**
   * Runs `action`; throw ServiceError(404) for one it doesn't have. `caller`:
   * the shell asking (its name, or its origin if it isn't installed).
   */
  call(action: string, args: Record<string, unknown>, caller?: string): Promise<unknown>;
  stop?(): void;
}

export class ServiceError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Every known service's name, registered or not (the `uses` a shell may name). */
export const SERVICE_NAMES = [
  "audio",
  "power",
  "network",
  "bluetooth",
  "media",
  "notifications",
  "session",
] as const;

export class DesktopServices {
  private readonly services = new Map<string, DesktopService>();
  private readonly started = new Map<string, Promise<void>>();
  private readonly notify: (service: string, state: unknown) => void;

  /** `notify` sends a service's new state to the shells that may use it. */
  constructor(notify: (service: string, state: unknown) => void) {
    this.notify = notify;
  }

  register(service: DesktopService): void {
    this.services.set(service.name, service);
  }

  /** The registered services' names. */
  names(): string[] {
    return [...this.services.keys()];
  }

  async state(name: string): Promise<unknown> {
    return (await this.use(name)).state();
  }

  async call(name: string, action: string, args: Record<string, unknown>, caller?: string): Promise<unknown> {
    return (await this.use(name)).call(action, args, caller);
  }

  stop(): void {
    for (const name of this.started.keys()) this.services.get(name)?.stop?.();
    this.started.clear();
  }

  private async use(name: string): Promise<DesktopService> {
    const service = this.services.get(name);
    if (!service) throw new ServiceError(404, `There is no service "${name}".`);
    let started = this.started.get(name);
    if (!started) {
      started = service.start((state) => this.notify(name, state));
      this.started.set(name, started);
      // A service that couldn't start (no PipeWire, no NetworkManager) tries again next time.
      started.catch(() => this.started.delete(name));
    }
    await started;
    return service;
  }
}

/**
 * Whether a shell may use `service`: an installed shell (`uses` from its
 * manifest) only the ones it names; a page that isn't an installed shell
 * (a URL given to `plutonium run`) is the user's own choice, so all of them.
 */
export function mayUse(uses: readonly string[] | undefined, installed: boolean, service: string): boolean {
  return !installed || (uses ?? []).includes(service);
}

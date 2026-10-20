// Windows agents work in, as the shells show them: the size an agent gave a
// window (launch_app's width and height, resize_window), which a shell keeps
// while it shows the window, scaling it into its own box, until the user takes
// control; and whether an agent is working in it right now.

/** How long after an agent's last input a window counts as being worked in. */
const BUSY_MS = 4_000;

export interface AgentWindow {
  readonly id: number;
  /** The size the agent holds it at (DIPs); absent once the user took control. */
  readonly width?: number;
  readonly height?: number;
  /** The user took control (of its size): the shell sizes it again. */
  readonly userControl: boolean;
  /** An agent gave it input in the last few seconds. */
  readonly busy: boolean;
}

interface State {
  size: { width: number; height: number } | null;
  /** The size is the app's own, followed while no page shows the window (see follow()). */
  follows: boolean;
  userControl: boolean;
  busy: ReturnType<typeof setTimeout> | null;
}

export class AgentWindows {
  private readonly states = new Map<number, State>();
  /** Something changed: what the shells are told. */
  onChange: (windows: AgentWindow[]) => void = () => {};

  list(): AgentWindow[] {
    return [...this.states].map(([id, state]) => ({
      id,
      ...(state.size ?? {}),
      userControl: state.userControl,
      busy: state.busy !== null,
    }));
  }

  get(id: number): AgentWindow | undefined {
    return this.list().find((window) => window.id === id);
  }

  private state(id: number): State {
    let state = this.states.get(id);
    if (!state) {
      state = { size: null, follows: false, userControl: false, busy: null };
      this.states.set(id, state);
    }
    return state;
  }

  /**
   * Holds `id` at a size, unless the user took control of it. False if they
   * did (the shell decides its size then). With `follows`, the size is the
   * app's own, and follow() keeps it current.
   */
  hold(id: number, width: number, height: number, follows = false): boolean {
    const state = this.state(id);
    if (state.userControl) return false;
    state.follows = follows;
    if (state.size?.width !== width || state.size?.height !== height) {
      state.size = { width, height };
      this.changed();
    }
    return true;
  }

  /**
   * Window `id` has this size now, and no page shows it: a window held at
   * its app's own size holds the new one (an app settles its size after it
   * maps its window).
   */
  follow(id: number, width: number, height: number): void {
    const state = this.states.get(id);
    if (!state?.follows || !state.size || width < 1 || height < 1) return;
    if (state.size.width === width && state.size.height === height) return;
    state.size = { width, height };
    this.changed();
  }

  /** The user took control: the agent's size no longer holds. */
  release(id: number): void {
    const state = this.state(id);
    if (state.userControl && !state.size) return;
    state.userControl = true;
    state.size = null;
    this.changed();
  }

  /** An agent gave `id` input. */
  touch(id: number): void {
    const state = this.state(id);
    const wasBusy = state.busy !== null;
    if (state.busy) clearTimeout(state.busy);
    state.busy = setTimeout(() => {
      state.busy = null;
      this.changed();
    }, BUSY_MS);
    state.busy.unref();
    if (!wasBusy) this.changed();
  }

  /** Forgets windows that are gone. */
  prune(existing: ReadonlySet<number>): void {
    let changed = false;
    for (const [id, state] of this.states) {
      if (existing.has(id)) continue;
      if (state.busy) clearTimeout(state.busy);
      this.states.delete(id);
      changed = true;
    }
    if (changed) this.changed();
  }

  private changed(): void {
    this.onChange(this.list());
  }
}

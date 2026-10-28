// EXO-CAPTURE: agents' recordings (start_recording, stop_recording;
// docs/features/CAPTURE.md, "Agents").
//
// A recording is a capture as the portal's are: the "start" capture command
// gives a PipeWire node of the source (a window or a tab of the agent's
// thread), with the agent as its consumer, so it goes to every shell as
// "capturestart", any shell can stop it, and the recording switch refuses it.
// GStreamer on the host writes the node to a WebM file (gst-launch-1.0:
// pipewiresrc, VP8). No dialogs: an agent reaches only its own thread's items.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import type { DesktopCapture } from "./desktop.ts";

export interface RecordingSource {
  readonly type: "window" | "tab";
  readonly id: number;
}

export interface RecordingsOptions {
  /** Plutonium.captureCommand. */
  readonly captureCommand: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  /** The encoder's command (default gst-launch-1.0 on PATH). */
  readonly gstLaunch?: string;
  /** Where recordings go without a path (default $TMPDIR/plutonium-recordings). */
  readonly directory?: string;
  /** How long the encoder gets to come up before start answers. */
  readonly settleMs?: number;
}

export interface RecordingInfo {
  readonly recording_id: number;
  readonly source: RecordingSource;
  readonly path: string;
  readonly started: string;
  /** Why it ended before stop_recording, if it did (a shell stopped it, the window went). */
  readonly ended?: string;
}

export interface StoppedRecording extends RecordingInfo {
  readonly seconds: number;
  readonly bytes: number;
}

interface Recording {
  readonly id: number;
  readonly threadId: string;
  readonly source: RecordingSource;
  readonly path: string;
  readonly startedAt: number;
  readonly captureId: number;
  readonly encoder: ChildProcess;
  readonly exited: Promise<number | null>;
  stderr: string;
  ended?: string;
  endedAt?: number;
  stopping?: boolean;
}

const ENCODER_EXIT_MS = 10_000;

export class Recordings {
  private readonly options: RecordingsOptions;
  private readonly recordings = new Map<number, Recording>();
  private nextId = 1;

  constructor(options: RecordingsOptions) {
    this.options = options;
  }

  /** Desktop.captureListeners: a shell's Stop, the switch or the source going ends the recording. */
  onCapture(type: "start" | "change" | "stop", capture: DesktopCapture): void {
    if (type !== "stop") return;
    for (const recording of this.recordings.values()) {
      if (recording.captureId !== capture.id || recording.stopping) continue;
      // Its node may have gone first, and the encoder with it: this is why.
      recording.ended = "The capture was stopped (by the user, the recording switch, or its source closing).";
      recording.endedAt ??= Date.now();
      // EOS: the file is finished as it is.
      recording.encoder.kill("SIGINT");
    }
  }

  /** The thread's recordings, running or ended but not yet collected by stop. */
  list(threadId: string): RecordingInfo[] {
    return [...this.recordings.values()].filter((entry) => entry.threadId === threadId).map(info);
  }

  async start(threadId: string, source: RecordingSource, path?: string): Promise<RecordingInfo> {
    const id = this.nextId++;
    const file = path ?? join(this.options.directory ?? join(tmpdir(), "plutonium-recordings"), fileName(source, id));
    if (!isAbsolute(file)) throw new Error("path must be absolute.");
    mkdirSync(dirname(file), { recursive: true });
    const started = (await this.options.captureCommand("start", {
      source,
      cursor: "hidden",
      consumer: { kind: "agent", thread: threadId, name: "An agent" },
    })) as { captureId: number; nodeId: number };
    const encoder = spawn(
      this.options.gstLaunch ?? "gst-launch-1.0",
      [
        "-e",
        "pipewiresrc",
        `path=${started.nodeId}`,
        "do-timestamp=true",
        // A still source sends no frames: repeat the last one.
        "keepalive-time=500",
        "!",
        "videoconvert",
        "!",
        "queue",
        "!",
        "vp8enc",
        "deadline=1",
        "cpu-used=8",
        "!",
        "webmmux",
        "!",
        "filesink",
        `location=${file}`,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const recording: Recording = {
      id,
      threadId,
      source,
      path: file,
      startedAt: Date.now(),
      captureId: started.captureId,
      encoder,
      stderr: "",
      exited: new Promise((resolve) => {
        encoder.once("error", (error: NodeJS.ErrnoException) => {
          recording.stderr =
            error.code === "ENOENT"
              ? "Recording needs GStreamer on this machine: gst-launch-1.0 with its base and good plugins and PipeWire's (gstreamer1.0-pipewire)."
              : error.message;
          resolve(null);
        });
        encoder.once("exit", (code) => resolve(code));
      }),
    };
    encoder.stderr?.setEncoding("utf8");
    encoder.stderr?.on("data", (chunk: string) => {
      recording.stderr = (recording.stderr + chunk).slice(-2000);
    });
    // An encoder that fails does so at once (no plugin, the node refused).
    const failed = await Promise.race([
      recording.exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), this.options.settleMs ?? 1000)),
    ]);
    if (failed) {
      await this.options.captureCommand("stop", { id: started.captureId }).catch(() => {});
      throw new Error(`The recording didn't start. ${recording.stderr.trim()}`.trim());
    }
    // Stops it, when the encoder dies on its own.
    void recording.exited.then(() => {
      if (!recording.ended && !recording.stopping) {
        recording.ended = `The encoder stopped. ${recording.stderr.trim()}`.trim();
        recording.endedAt = Date.now();
      }
      void this.options.captureCommand("stop", { id: started.captureId }).catch(() => {});
    });
    this.recordings.set(id, recording);
    return info(recording);
  }

  /** Stops the thread's recording `id` (default: its newest) and finishes the file. */
  async stop(threadId: string, id?: number): Promise<StoppedRecording> {
    const mine = [...this.recordings.values()].filter((entry) => entry.threadId === threadId);
    const recording = id === undefined ? mine.at(-1) : mine.find((entry) => entry.id === id);
    if (!recording) {
      throw new Error(id === undefined ? "This thread isn't recording." : `This thread has no recording ${id}.`);
    }
    this.recordings.delete(recording.id);
    recording.stopping = true;
    const endedAt = recording.endedAt ?? Date.now();
    recording.encoder.kill("SIGINT");
    const timer = setTimeout(() => recording.encoder.kill("SIGKILL"), ENCODER_EXIT_MS);
    await recording.exited;
    clearTimeout(timer);
    await this.options.captureCommand("stop", { id: recording.captureId }).catch(() => {});
    let bytes = 0;
    try {
      bytes = statSync(recording.path).size;
    } catch {
      // None written.
    }
    if (bytes === 0) throw new Error(`The recording has no frames. ${recording.stderr.trim()}`.trim());
    return { ...info(recording), seconds: Math.round((endedAt - recording.startedAt) / 100) / 10, bytes };
  }

  /** Stops them all (the helper is going). */
  stopAll(): void {
    for (const recording of this.recordings.values()) recording.encoder.kill("SIGINT");
  }
}

function info(recording: Recording): RecordingInfo {
  return {
    recording_id: recording.id,
    source: recording.source,
    path: recording.path,
    started: new Date(recording.startedAt).toISOString(),
    ...(recording.ended ? { ended: recording.ended } : {}),
  };
}

function fileName(source: RecordingSource, id: number): string {
  const time = new Date().toISOString().replace(/[:.]/g, "-");
  return `${source.type}-${source.id}-${time}-${id}.webm`;
}

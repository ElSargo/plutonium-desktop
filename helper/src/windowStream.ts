// A window's screencast as one HTTP response, for a frontend's server that
// shows windows to clients away from the desktop (T3 Code's
// /api/window-stream). On the socket only: GET /v1/windows/:id/stream.
//
// The body is a run of frames, each an 8-byte header (the JPEG's length, u32
// big-endian; the frame's width and height in pixels, u16 each) and the JPEG.
// A reader that falls behind loses frames, not latency: a frame is dropped
// while the response still holds more than MAX_BUFFERED bytes.
import type { ServerResponse } from "node:http";

import type { ScreencastFrame } from "./desktop.ts";

export const FRAME_HEADER_BYTES = 8;
const MAX_BUFFERED = 2 * 1024 * 1024;

export function encodeFrame(frame: Pick<ScreencastFrame, "data" | "width" | "height">): Buffer {
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(frame.data.length, 0);
  header.writeUInt16BE(Math.min(frame.width, 0xffff), 4);
  header.writeUInt16BE(Math.min(frame.height, 0xffff), 6);
  return Buffer.concat([header, frame.data]);
}

/** Splits a stream of encodeFrame()s back into frames (for tests and readers). */
export class FrameReader {
  private pending = Buffer.alloc(0);

  push(chunk: Buffer): { data: Buffer; width: number; height: number }[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const frames = [];
    while (this.pending.length >= FRAME_HEADER_BYTES) {
      const length = this.pending.readUInt32BE(0);
      if (this.pending.length < FRAME_HEADER_BYTES + length) break;
      frames.push({
        width: this.pending.readUInt16BE(4),
        height: this.pending.readUInt16BE(6),
        data: this.pending.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length),
      });
      this.pending = this.pending.subarray(FRAME_HEADER_BYTES + length);
    }
    return frames;
  }
}

export interface ScreencastSource {
  screencast(
    id: number,
    options: { format?: "png" | "jpeg"; quality?: number; maxWidth?: number; maxHeight?: number },
    listener: (frame: ScreencastFrame | null) => void,
  ): Promise<() => void>;
}

/**
 * Streams window `id`'s frames into `response` until either ends. `awake`
 * keeps the window drawing at full rate while it streams (a window no page
 * shows draws a frame a second); it's called with false at the end.
 */
export async function streamWindow(
  source: ScreencastSource,
  id: number,
  options: { quality?: number; maxWidth?: number; maxHeight?: number },
  response: ServerResponse,
  awake?: (on: boolean) => void,
): Promise<void> {
  let stop: (() => void) | null = null;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    stop?.();
    awake?.(false);
    response.end();
  };
  response.once("close", end);
  stop = await source.screencast(id, { format: "jpeg", ...options }, (frame) => {
    if (!frame) return end();
    if (ended || response.writableLength > MAX_BUFFERED) return;
    response.write(encodeFrame(frame));
  });
  if (ended) {
    stop();
    return;
  }
  response.writeHead(200, { "Content-Type": "application/x-plutonium-frames", "Cache-Control": "no-cache" });
  response.flushHeaders();
  response.socket?.setNoDelay(true);
  awake?.(true);
}

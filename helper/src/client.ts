// Talks to plutoniumd over its Unix socket.
import { request } from "node:http";

export interface HelperResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
  /** X-Plutonium-Popups: a window snapshot's open popups (JSON), if any. */
  readonly popups?: string;
}

export function helperRequest(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<HelperResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = request(
      {
        socketPath,
        method,
        path,
        headers: payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.once("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            contentType: res.headers["content-type"] ?? "",
            popups: [res.headers["x-plutonium-popups"]].flat()[0],
            body: Buffer.concat(chunks),
          }),
        );
        res.once("error", reject);
      },
    );
    req.once("error", reject);
    req.end(payload);
  });
}

/** The JSON body of a successful request; throws the helper's error message otherwise. */
export async function helperJson<T>(socketPath: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await helperRequest(socketPath, method, path, body);
  const value = response.body.length ? JSON.parse(response.body.toString("utf8")) : null;
  if (response.status >= 400) throw new Error(value?.error ?? `Helper error ${response.status}`);
  return value as T;
}

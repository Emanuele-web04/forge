import { createConnection } from "node:net";
import release from "./cuaDriverRelease.json" with { type: "json" };

export const CUA_DRIVER_VERSION = release.version;
export const CUA_NATIVE_REVISION = release.nativeRevision;
export const CUA_DRIVER_SOURCE = release.source;
export const CUA_DRIVER_ARCHIVE_SHA256 = release.sha256;
export const CUA_HOST_SOCKET_ENV = "SYNARA_CUA_HOST_SOCKET";
export const CUA_MAX_RESPONSE_BYTES = 96 * 1024 * 1024;
export type CuaEffect = "not-dispatched" | "dispatched-unknown" | "verified";
export class CuaTransportError extends Error {
  constructor(
    message: string,
    readonly effect: CuaEffect,
  ) {
    super(message);
  }
}

/** One bounded request per connection. A timeout closes the connection; the GUI
 * broker retires the active driver before admitting its next generation. */
export function cuaRequest<T = unknown>(
  socketPath: string,
  request: unknown,
  options: {
    signal?: AbortSignal | undefined;
    timeoutMs?: number;
    mutation?: boolean;
  } = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new CuaTransportError("Cancelled before dispatch.", "not-dispatched"));
      return;
    }
    let encoded: string;
    try {
      encoded = JSON.stringify(request) + "\n";
      if (Buffer.byteLength(encoded) > 1024 * 1024)
        throw new Error("Request exceeds its byte budget.");
    } catch {
      reject(new CuaTransportError("Invalid or oversized computer request.", "not-dispatched"));
      return;
    }
    const socket = createConnection(socketPath);
    const chunks: Buffer[] = [];
    let bytes = 0;
    let dispatched = false;
    let settled = false;
    const finish = (error?: Error, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(result as T);
    };
    const fail = (message: string) =>
      finish(
        new CuaTransportError(
          message,
          options.mutation && dispatched ? "dispatched-unknown" : "not-dispatched",
        ),
      );
    const abort = () =>
      fail(
        "Computer operation cancelled. Input already dispatched may have taken effect; do not replay.",
      );
    const timer = setTimeout(
      () => fail("Computer request timed out; do not replay an uncertain action."),
      options.timeoutMs ?? 15_000,
    );
    timer.unref?.();
    options.signal?.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => {
      if (options.signal?.aborted) {
        abort();
        return;
      }
      dispatched = true;
      socket.write(encoded);
    });
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > CUA_MAX_RESPONSE_BYTES) {
        fail("Computer response exceeded its byte budget.");
        return;
      }
      const end = chunk.indexOf(10);
      chunks.push(end < 0 ? chunk : chunk.subarray(0, end));
      if (end < 0) return;
      try {
        finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
      } catch {
        fail("Invalid computer response.");
      }
    });
    socket.once("error", (error) => fail(error.message));
    socket.once("close", () => {
      if (!settled) fail("Computer connection closed before a result.");
    });
  });
}

export interface CuaToolResult {
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}
export interface CuaReply {
  ok: boolean;
  result?: CuaToolResult & Record<string, unknown>;
  error?: string;
  effect?: CuaEffect;
}
export const CUA_READ_TOOLS = new Set([
  "check_permissions",
  "check_input_ready",
  "list_windows",
  "get_window_state",
  "get_screen_size",
  "get_desktop_state",
  "get_agent_cursor_state",
]);
export const CUA_ACTION_TOOLS = new Set([
  "click",
  "move_cursor",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "hotkey",
  "set_value",
  "clipboard_read",
  "clipboard_write",
  "launch_app",
  "bring_to_front",
]);

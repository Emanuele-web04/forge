import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  BrowserHostRpcError,
  callBrowserHostTool,
  resolveBrowserHostCapability,
  resolveBrowserHostPipePath,
} from "./browserHostRpcClient.ts";

const HEADER_BYTES = 4;
const TEST_CAPABILITY = "synara-browser-host-client-test-capability-0123456789";

function pipePathForTest(name: string): string {
  return process.platform === "win32"
    ? String.raw`\\.\pipe\synara-${name}-${process.pid}-${crypto.randomUUID()}`
    : path.join("/tmp", `synara-${process.pid}-${crypto.randomUUID().slice(0, 8)}.sock`);
}

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  os.endianness() === "LE"
    ? header.writeUInt32LE(body.byteLength, 0)
    : header.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([header, body]);
}

async function withRpcServer<T>(
  onRequest: (request: Record<string, unknown>) => unknown | Promise<unknown>,
  run: (pipePath: string) => Promise<T>,
): Promise<T> {
  const pipePath = pipePathForTest("browser-host-client");
  let buffer = Buffer.alloc(0);
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.byteLength >= HEADER_BYTES) {
        const length = os.endianness() === "LE" ? buffer.readUInt32LE(0) : buffer.readUInt32BE(0);
        if (buffer.byteLength < HEADER_BYTES + length) return;
        const request = JSON.parse(
          buffer.subarray(HEADER_BYTES, HEADER_BYTES + length).toString("utf8"),
        ) as Record<string, unknown>;
        buffer = buffer.subarray(HEADER_BYTES + length);
        void Promise.resolve(onRequest(request)).then((response) => {
          if (response !== undefined && !socket.destroyed) socket.write(encodeFrame(response));
        });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, resolve);
  });
  try {
    return await run(pipePath);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.platform !== "win32") await fs.rm(pipePath, { force: true });
  }
}

describe("browser host RPC client", () => {
  it("routes the authenticated provider identity through getInfo and executeTool", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const result = await withRpcServer(
      (request) => {
        requests.push(request);
        const id = request.id;
        return request.method === "getInfo"
          ? { jsonrpc: "2.0", id, result: { protocolVersion: 1 } }
          : {
              jsonrpc: "2.0",
              id,
              result: { tabs: [], activeTabId: null, assignedTabId: null },
            };
      },
      (pipePath) =>
        callBrowserHostTool({
          pipePath,
          capability: TEST_CAPABILITY,
          sessionKey: "gateway-session:one",
          provider: "claudeAgent",
          threadId: "thread-one" as never,
          name: "browser_tabs",
          arguments: {},
          workspaceRoot: "/workspace/project-one",
          timeoutMs: 1_000,
        }),
    );

    expect(result).toEqual({ tabs: [], activeTabId: null, assignedTabId: null });
    expect(requests.map((request) => request.method)).toEqual(["getInfo", "executeTool"]);
    expect(requests[1]?.params).toMatchObject({
      session_id: "gateway-session:one",
      provider: "claudeAgent",
      thread_id: "thread-one",
      name: "browser_tabs",
      workspace_root: "/workspace/project-one",
      arguments: { timeoutMs: expect.any(Number) },
    });
    expect((requests[1]?.params as { arguments?: unknown }).arguments).not.toMatchObject({
      workspaceRoot: expect.anything(),
      workspace_root: expect.anything(),
    });
  });

  it("preserves canonical error data returned by the desktop host", async () => {
    const envelope = {
      type: "synara_browser_error",
      version: 1,
      error: { code: "BrowserAuthorizationDenied" },
    };
    const error = await withRpcServer(
      (request) => ({
        jsonrpc: "2.0",
        id: request.id,
        ...(request.method === "getInfo"
          ? { result: { protocolVersion: 1 } }
          : { error: { code: -32001, message: "Denied", data: envelope } }),
      }),
      async (pipePath) => {
        try {
          await callBrowserHostTool({
            pipePath,
            capability: TEST_CAPABILITY,
            sessionKey: "gateway-session:denied",
            provider: "codex",
            threadId: "thread-denied" as never,
            name: "browser_open",
            arguments: { idempotencyKey: "open-once" },
            timeoutMs: 1_000,
          });
          throw new Error("expected desktop rejection");
        } catch (cause) {
          return cause;
        }
      },
    );

    expect(error).toBeInstanceOf(BrowserHostRpcError);
    expect(error).toMatchObject({ kind: "remote", data: envelope });
  });

  it("fails closed before executeTool when the desktop protocol is incompatible", async () => {
    const methods: unknown[] = [];
    const error = await withRpcServer(
      (request) => {
        methods.push(request.method);
        return {
          jsonrpc: "2.0",
          id: request.id,
          result: {
            type: "synara-browser-host",
            metadata: {
              sessionId: "gateway-session:protocol",
              protocolVersion: 2,
              methods: ["executeTool"],
            },
          },
        };
      },
      async (pipePath) => {
        try {
          await callBrowserHostTool({
            pipePath,
            capability: TEST_CAPABILITY,
            sessionKey: "gateway-session:protocol",
            provider: "codex",
            threadId: "thread-protocol" as never,
            name: "browser_status",
            arguments: {},
            timeoutMs: 1_000,
          });
          throw new Error("Expected an incompatible browser host protocol.");
        } catch (caught) {
          return caught;
        }
      },
    );

    expect(error).toMatchObject({ kind: "malformed" });
    expect(methods).toEqual(["getInfo"]);
  });

  it("cancels a hanging desktop request as soon as its provider effect is interrupted", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const error = await withRpcServer(
      (request) =>
        request.method === "getInfo"
          ? { jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1 } }
          : undefined,
      async (pipePath) => {
        const pending = callBrowserHostTool({
          pipePath,
          capability: TEST_CAPABILITY,
          sessionKey: "gateway-session:cancelled",
          provider: "codex",
          threadId: "thread-cancelled" as never,
          name: "browser_run",
          arguments: { code: "return page.waitForLoadState()" },
          timeoutMs: 30_000,
          signal: controller.signal,
        });
        setTimeout(() => controller.abort(), 25);
        try {
          await pending;
          throw new Error("expected cancellation");
        } catch (cause) {
          return cause;
        }
      },
    );

    expect(error).toBeInstanceOf(BrowserHostRpcError);
    expect(error).toMatchObject({ kind: "timeout" });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("uses one monotonic deadline across connect, getInfo, execute, and the desktop budget", async () => {
    let desktopTimeoutMs: number | undefined;
    const startedAt = performance.now();
    const result = await withRpcServer(
      async (request) => {
        if (request.method === "getInfo") {
          await new Promise((resolve) => setTimeout(resolve, 80));
          return { jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1 } };
        }
        const params = request.params as { arguments?: { timeoutMs?: number } };
        desktopTimeoutMs = params.arguments?.timeoutMs;
        await new Promise((resolve) => setTimeout(resolve, 40));
        return {
          jsonrpc: "2.0",
          id: request.id,
          result: { tabs: [], activeTabId: null, assignedTabId: null },
        };
      },
      (pipePath) =>
        callBrowserHostTool({
          pipePath,
          capability: TEST_CAPABILITY,
          sessionKey: "gateway-session:deadline",
          provider: "codex",
          threadId: "thread-deadline" as never,
          name: "browser_tabs",
          arguments: { timeoutMs: 500 },
          timeoutMs: 500,
        }),
    );

    expect(result).toMatchObject({ tabs: [] });
    expect(desktopTimeoutMs).toBeTypeOf("number");
    expect(desktopTimeoutMs!).toBeLessThan(475);
    expect(desktopTimeoutMs!).toBeGreaterThanOrEqual(100);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  it("does not grant executeTool a fresh timeout after getInfo consumed the budget", async () => {
    const startedAt = performance.now();
    const error = await withRpcServer(
      async (request) => {
        if (request.method === "getInfo") {
          await new Promise((resolve) => setTimeout(resolve, 120));
          return { jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1 } };
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { jsonrpc: "2.0", id: request.id, result: {} };
      },
      async (pipePath) => {
        try {
          await callBrowserHostTool({
            pipePath,
            capability: TEST_CAPABILITY,
            sessionKey: "gateway-session:deadline-timeout",
            provider: "codex",
            threadId: "thread-deadline-timeout" as never,
            name: "browser_tabs",
            arguments: {},
            timeoutMs: 180,
          });
          throw new Error("expected one-deadline timeout");
        } catch (cause) {
          return cause;
        }
      },
    );

    expect(error).toMatchObject({ kind: "timeout" });
    expect(performance.now() - startedAt).toBeLessThan(275);
  });

  it("prefers the canonical host path and accepts the legacy alias during upgrade", () => {
    expect(
      resolveBrowserHostPipePath({
        SYNARA_BROWSER_HOST_PIPE_PATH: "/tmp/canonical.sock",
        SYNARA_BROWSER_USE_PIPE_PATH: "/tmp/legacy.sock",
      }),
    ).toBe("/tmp/canonical.sock");
    expect(resolveBrowserHostPipePath({ SYNARA_BROWSER_USE_PIPE_PATH: "/tmp/legacy.sock" })).toBe(
      "/tmp/legacy.sock",
    );
  });

  it("accepts only a bounded private desktop capability from direct test environments", () => {
    expect(
      resolveBrowserHostCapability({
        SYNARA_BROWSER_HOST_CAPABILITY: TEST_CAPABILITY,
      }),
    ).toBe(TEST_CAPABILITY);
    expect(
      resolveBrowserHostCapability({
        SYNARA_BROWSER_HOST_CAPABILITY: "too-short",
      }),
    ).toBeNull();
  });
});

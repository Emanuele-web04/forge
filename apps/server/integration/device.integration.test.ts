/**
 * Device pane end-to-end verification against a live Synara server.
 *
 * Gated on `DEVICE_E2E=1` because it boots a real iOS simulator, which needs
 * macOS with Xcode and takes tens of seconds. CI never runs it.
 *
 * The RPC socket is spoken directly rather than through a generated client:
 * the transport is Effect RPC's JSON framing over WebSocket, and the only
 * pre-connect requirement is the HTTP negotiation at `/ws/negotiate`, whose
 * `serverInstanceId` must be echoed back on the `/ws` upgrade (see
 * `validateWsFeatureCompatibility`). A loopback server with no auth token
 * admits the connection as owner without a session, so no bootstrap credential
 * is needed here.
 *
 * Point it at an already-running server with `DEVICE_E2E_ORIGIN`
 * (default http://127.0.0.1:3899).
 *
 * @module integration/device
 */
import {
  DEVICE_FRAME_RESYNC_MESSAGE,
  DEVICE_FRAME_WS_PATH,
  DEVICE_FRAME_WS_UDID_PARAM,
  decodeDeviceFrame,
} from "@synara/shared/deviceFrame";
import {
  DEVICE_WS_METHODS,
  WS_COMPATIBILITY_QUERY,
  WS_FEATURE_PATH,
  WS_NEGOTIATE_HTTP_PATH,
  WS_NEGOTIATE_QUERY,
  WS_PROTOCOL_EPOCH,
  WS_PROTOCOL_MAX_REVISION,
  WS_PROTOCOL_MIN_REVISION,
  type DeviceDescriptor,
  type DeviceListResult,
  type DeviceScreenshotResult,
  type ThreadDeviceState,
  type WsBootstrapNegotiateResult,
} from "@synara/contracts";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";

import { DeviceManager } from "../src/device/DeviceManager.ts";
import { IosSimulatorBackend } from "../src/device/IosSimulatorBackend.ts";
import { makeAgentGatewayDeviceTools } from "../src/agentGateway/deviceTools.ts";
import type { McpToolCallResult } from "../src/agentGateway/protocol.ts";
import type { ToolContext } from "../src/agentGateway/toolRuntime.ts";

const ENABLED = process.env.DEVICE_E2E === "1";
const ORIGIN = process.env.DEVICE_E2E_ORIGIN ?? "http://127.0.0.1:3899";
const CLIENT_BUILD = "device-e2e";
const THREAD_ID = `device-e2e-${Date.now()}`;

const describeE2e = ENABLED ? describe : describe.skip;

/** PNG magic: the eight bytes every PNG starts with. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface RpcSocket {
  readonly call: <A>(method: string, payload: unknown) => Promise<A>;
  readonly close: () => void;
}

async function negotiate(): Promise<WsBootstrapNegotiateResult> {
  const url = new URL(WS_NEGOTIATE_HTTP_PATH, ORIGIN);
  url.searchParams.set(WS_NEGOTIATE_QUERY.protocolEpoch, String(WS_PROTOCOL_EPOCH));
  url.searchParams.set(WS_NEGOTIATE_QUERY.minRevision, String(WS_PROTOCOL_MIN_REVISION));
  url.searchParams.set(WS_NEGOTIATE_QUERY.maxRevision, String(WS_PROTOCOL_MAX_REVISION));
  url.searchParams.set(WS_NEGOTIATE_QUERY.clientBuild, CLIENT_BUILD);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Negotiate failed: ${response.status}`);
  return (await response.json()) as WsBootstrapNegotiateResult;
}

/**
 * Open the feature socket and expose a promise-returning `call`. Effect RPC
 * answers a `Request` with one or more `Chunk` frames followed by an `Exit`;
 * for the non-streaming device methods there is at most one chunk.
 */
async function connectRpc(negotiation: WsBootstrapNegotiateResult): Promise<RpcSocket> {
  const url = new URL(WS_FEATURE_PATH, ORIGIN);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set(WS_COMPATIBILITY_QUERY.protocolEpoch, String(WS_PROTOCOL_EPOCH));
  url.searchParams.set(
    WS_COMPATIBILITY_QUERY.protocolRevision,
    String(negotiation.negotiatedRevision),
  );
  url.searchParams.set(WS_COMPATIBILITY_QUERY.clientBuild, CLIENT_BUILD);
  url.searchParams.set(WS_COMPATIBILITY_QUERY.serverInstanceId, negotiation.serverInstanceId);

  const socket = new WebSocket(url.toString(), { perMessageDeflate: false });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      reject(new Error(`Upgrade rejected: ${response.statusCode}`));
    });
  });

  interface Pending {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
    chunk: unknown;
  }
  const pending = new Map<string, Pending>();
  let nextId = 1;

  socket.on("message", (data: RawData) => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    const entry = pending.get(String(frame.requestId));
    if (!entry) return;
    if (frame._tag === "Chunk") {
      const values = frame.values as unknown[] | undefined;
      if (Array.isArray(values) && values.length > 0) entry.chunk = values[0];
      return;
    }
    if (frame._tag !== "Exit") return;
    pending.delete(String(frame.requestId));
    const exit = frame.exit as { _tag?: string; value?: unknown; cause?: unknown } | undefined;
    if (exit?._tag === "Success") {
      // Non-streaming RPCs carry the result inline on the Exit; streaming ones
      // arrive as Chunk frames first and exit with no value.
      entry.resolve(exit.value === undefined ? entry.chunk : exit.value);
      return;
    }
    entry.reject(new Error(`RPC failed: ${JSON.stringify(exit?.cause ?? exit)}`));
  });

  const call = <A>(method: string, payload: unknown): Promise<A> => {
    const id = String(nextId++);
    return new Promise<A>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out calling ${method}`));
      }, 120_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as A);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        chunk: undefined,
      });
      socket.send(JSON.stringify({ _tag: "Request", id, tag: method, payload, headers: [] }));
    });
  };

  return { call, close: () => socket.close() };
}

interface CollectedFrames {
  readonly total: number;
  readonly codecConfig: number;
  readonly keyframes: number;
}

/**
 * Open the frame socket and count frames while `drive` forces screen damage.
 * Capture is damage-driven, so an idle SpringBoard emits nothing after the
 * initial codec config and IDR; the taps are what make this deterministic.
 */
async function collectFrames(
  udid: string,
  drive: () => Promise<void>,
  windowMs: number,
): Promise<CollectedFrames> {
  const url = new URL(DEVICE_FRAME_WS_PATH, ORIGIN);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set(DEVICE_FRAME_WS_UDID_PARAM, udid);

  const socket = new WebSocket(url.toString(), { perMessageDeflate: false });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      reject(new Error(`Frame socket upgrade rejected: ${response.statusCode}`));
    });
  });

  // The codec-config frame and first IDR are emitted when the capture session
  // starts, which happens at attach — before this socket exists. The pane
  // handles that with the same resync request, which restarts capture and
  // guarantees a fresh config + keyframe on this connection.
  socket.send(JSON.stringify({ type: DEVICE_FRAME_RESYNC_MESSAGE }));

  let total = 0;
  let codecConfig = 0;
  let keyframes = 0;
  socket.on("message", (data: RawData) => {
    if (!Buffer.isBuffer(data)) return;
    const decoded = decodeDeviceFrame(new Uint8Array(data));
    if (!decoded.ok) return;
    total += 1;
    if (decoded.frame.header.codecConfig) codecConfig += 1;
    if (decoded.frame.header.keyframe) keyframes += 1;
  });

  await drive();
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  socket.close();
  return { total, codecConfig, keyframes };
}

function makeToolContext(): ToolContext {
  return {
    principal: {
      kind: "provider-session",
      sessionKey: "device-e2e",
      threadId: THREAD_ID,
      provider: "claudeAgent",
      turnId: "device-e2e-turn",
    },
    callerThreadId: THREAD_ID,
    callerSessionKey: "device-e2e",
    callerProvider: "claudeAgent",
    callerCapabilities: new Set(["device:control"]),
    callerTurnId: "device-e2e-turn",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}

function readToolJson(result: McpToolCallResult): unknown {
  const text = result.content.find((entry) => entry.type === "text");
  return text && text.type === "text" ? JSON.parse(text.text) : null;
}

describeE2e("device pane end-to-end", () => {
  let rpc: RpcSocket;
  let target: DeviceDescriptor | undefined;
  let bootedByTest = false;

  beforeAll(async () => {
    rpc = await connectRpc(await negotiate());
  }, 60_000);

  afterAll(async () => {
    if (target && bootedByTest) {
      await rpc.call(DEVICE_WS_METHODS.shutdown, { udid: target.udid }).catch(() => undefined);
    }
    rpc?.close();
  }, 120_000);

  it("lists devices and reports backend availability", async () => {
    const result = await rpc.call<DeviceListResult>(DEVICE_WS_METHODS.list, {
      includeShutdown: true,
    });
    // Before the first attach the helper binary is not compiled yet, so
    // "setup-required" is expected here as long as build-device-helper is the
    // only outstanding step; everything else must already be satisfied.
    if (result.availability.kind === "setup-required") {
      const outstanding = result.availability.steps
        .filter((step) => !step.done)
        .map((step) => step.id);
      expect(outstanding).toEqual(["build-device-helper"]);
    } else {
      expect(result.availability.kind).toBe("available");
    }
    expect(result.devices.length).toBeGreaterThan(0);
    target = result.devices.find((device) => device.name.startsWith("iPhone"));
    expect(target).toBeDefined();
  }, 60_000);

  it("boots the target simulator", async () => {
    if (!target) throw new Error("no target device");
    const result = await rpc.call<{ kind: string; device?: DeviceDescriptor }>(
      DEVICE_WS_METHODS.boot,
      { udid: target.udid },
    );
    expect(result.kind).toBe("booted");
    bootedByTest = true;
    const listed = await rpc.call<DeviceListResult>(DEVICE_WS_METHODS.list, {});
    const booted = listed.devices.find((device) => device.udid === target?.udid);
    expect(booted?.state).toBe("booted");
    expect(booted?.bootSource).toBe("synara");
  }, 180_000);

  it("attaches the thread and streams H.264 frames driven by taps", async () => {
    if (!target) throw new Error("no target device");
    const attached = await rpc.call<ThreadDeviceState>(DEVICE_WS_METHODS.attach, {
      threadId: THREAD_ID,
      udid: target.udid,
    });
    expect(attached.attachedDeviceUdid).toBe(target.udid);

    const frames = await collectFrames(
      target.udid,
      async () => {
        for (let index = 0; index < 6; index += 1) {
          await rpc.call(DEVICE_WS_METHODS.tap, {
            udid: target!.udid,
            x: 200 + index * 5,
            y: 400 + index * 5,
          });
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      },
      3_000,
    );

    expect(frames.codecConfig).toBeGreaterThanOrEqual(1);
    expect(frames.keyframes).toBeGreaterThanOrEqual(1);
    expect(frames.total).toBeGreaterThan(frames.codecConfig);
  }, 180_000);

  it("captures a screenshot that is a real PNG", async () => {
    if (!target) throw new Error("no target device");
    const shot = await rpc.call<DeviceScreenshotResult>(DEVICE_WS_METHODS.screenshot, {
      udid: target.udid,
    });
    expect(shot.mimeType).toBe("image/png");
    const bytes = Buffer.from(shot.bytesBase64, "base64");
    expect(bytes.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    expect(bytes.byteLength).toBe(shot.sizeBytes);
    expect(shot.width).toBeGreaterThan(0);
    expect(shot.height).toBeGreaterThan(0);
  }, 120_000);

  it("detaches the thread", async () => {
    const detached = await rpc.call<ThreadDeviceState>(DEVICE_WS_METHODS.detach, {
      threadId: THREAD_ID,
    });
    expect(detached.attachedDeviceUdid).toBeNull();
  }, 60_000);

  it("serves device_list and device_screenshot through the agent gateway tools", async () => {
    const backend = new IosSimulatorBackend({ platform: process.platform });
    const manager = new DeviceManager({ backend });
    try {
      const tools = new Map(
        makeAgentGatewayDeviceTools({ manager }).map((tool) => [tool.definition.name, tool]),
      );
      const context = makeToolContext();

      const listTool = tools.get("device_list");
      if (!listTool) throw new Error("device_list tool missing");
      const listed = readToolJson(
        await Effect.runPromise(listTool.handler({ includeShutdown: true }, context)),
      ) as { devices?: ReadonlyArray<DeviceDescriptor> };
      expect(Array.isArray(listed.devices)).toBe(true);
      const booted = listed.devices?.find((device) => device.state === "booted");
      expect(booted, "expected the simulator booted earlier to be visible").toBeDefined();

      const screenshotTool = tools.get("device_screenshot");
      if (!screenshotTool) throw new Error("device_screenshot tool missing");
      const result = await Effect.runPromise(
        screenshotTool.handler({ udid: booted!.udid }, context),
      );
      const image = result.content.find((entry) => entry.type === "image");
      expect(image, "device_screenshot must return an image payload").toBeDefined();
      if (image?.type === "image") {
        expect(image.mimeType).toBe("image/png");
        expect(Buffer.from(image.data, "base64").subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
      }
    } finally {
      await manager.dispose().catch(() => undefined);
    }
  }, 180_000);
});

import { serve, type ServerType } from "@hono/node-server";
import { GRANT_JWT_TYP, HOST_CONNECT_SCOPE, type RevocationEvent } from "@synara/contracts";
import {
  RELAY_CLOSE_BAD_TOKEN,
  RELAY_CLOSE_GRANT_REPLAY,
  RELAY_CLOSE_HOST_UNAVAILABLE,
  RELAY_CLOSE_KEEPALIVE_LOST,
  RELAY_CLOSE_SPLICE_CLAIMED,
  RELAY_CLOSE_SUPERSEDED,
} from "@synara/relay-protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket, { type RawData } from "ws";

import { createRelayApp, type RelayApplication } from "./app";
import type { RelayConfig } from "./config";
import { FakeApi } from "./test/fakeApi";

type CloseResult = { code: number; reason: string };
type MessageResult = { data: Buffer; binary: boolean };

let api: FakeApi | undefined;
let relay: RelayApplication | undefined;
let server: ServerType | undefined;
let wsOrigin = "";
let networkUnavailable: string | undefined;
const sockets = new Set<WebSocket>();

function hostId(index: number): string {
  return `10000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function rawBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function skipWithoutLoopback(context: { skip: () => void }): boolean {
  if (!networkUnavailable) return false;
  context.skip();
  return true;
}

function openSocket(path: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsOrigin}${path}`);
    sockets.add(socket);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
    socket.once("close", () => sockets.delete(socket));
  });
}

function closeOf(socket: WebSocket): Promise<CloseResult> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
  });
}

async function openAndClose(path: string): Promise<CloseResult> {
  const socket = await openSocket(path);
  return closeOf(socket);
}

function nextMessage(socket: WebSocket, timeoutMs = 2_000): Promise<MessageResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for WebSocket message"));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timeout);
      socket.off("message", onMessage);
    }
    function onMessage(data: RawData, binary: boolean) {
      cleanup();
      resolve({ data: rawBuffer(data), binary });
    }
    socket.on("message", onMessage);
  });
}

function nextControl(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${type}`));
    }, 2_000);
    function cleanup() {
      clearTimeout(timeout);
      socket.off("message", onMessage);
    }
    function onMessage(data: RawData, binary: boolean) {
      if (binary) return;
      try {
        const parsed = JSON.parse(rawBuffer(data).toString("utf8")) as Record<string, unknown>;
        if (parsed.type !== type) return;
        cleanup();
        resolve(parsed);
      } catch {
        // Not the requested control message.
      }
    }
    socket.on("message", onMessage);
  });
}

async function connectHost(
  id: string,
  environmentId = "environment-1",
  autoPong = true,
): Promise<WebSocket> {
  const ticket = await (api as FakeApi).signTicket({ hostId: id, environmentId });
  const socket = await openSocket(`/host/control?ticket=${encodeURIComponent(ticket)}`);
  if (autoPong) {
    socket.on("message", (data, binary) => {
      if (binary) return;
      try {
        const parsed = JSON.parse(rawBuffer(data).toString("utf8")) as { type?: string };
        if (parsed.type === "ping" && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ v: 1, type: "pong" }));
        }
      } catch {
        // Ignore data messages in helpers that share the socket.
      }
    });
  }
  socket.send(JSON.stringify({ v: 1, type: "ready" }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  return socket;
}

async function openPending(
  control: WebSocket,
  id: string,
  environmentId = "environment-1",
): Promise<{ client: WebSocket; spliceId: string }> {
  const request = nextControl(control, "splice_request");
  const grant = await (api as FakeApi).signGrant({ hostId: id, environmentId });
  const client = await openSocket(`/client/session?grant=${encodeURIComponent(grant)}`);
  const message = await request;
  return { client, spliceId: message.spliceId as string };
}

beforeAll(async () => {
  try {
    api = await FakeApi.start();
    const config: RelayConfig = {
      port: 0,
      apiBaseUrl: api.origin,
      apiIssuer: api.issuer,
      relayServiceToken: api.serviceToken,
      maxPairs: 256,
      highWaterBytes: 64 * 1024,
    };
    relay = await createRelayApp(config, {
      pendingTimeoutMs: 100,
      keepaliveIntervalMs: 100,
      stallTimeoutMs: 500,
      revocationPollIntervalMs: 20,
      revocationInitialBackoffMs: 5,
      revocationMaxBackoffMs: 20,
      logger: { error: vi.fn(), warn: vi.fn() },
    });
    const activeRelay = relay;
    await new Promise<void>((resolve, reject) => {
      const activeServer = serve(
        {
          fetch: activeRelay.app.fetch,
          port: 0,
          hostname: "127.0.0.1",
        },
        (info) => {
          wsOrigin = `ws://127.0.0.1:${info.port}`;
          resolve();
        },
      );
      activeServer.on("upgrade", activeRelay.handleUpgrade as RelayApplication["handleUpgrade"]);
      activeServer.once("error", reject);
      server = activeServer;
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EPERM") {
      networkUnavailable = "loopback listeners are prohibited by this execution sandbox";
      relay?.close();
      await api?.close();
      relay = undefined;
      api = undefined;
      return;
    }
    throw error;
  }
});

afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets.clear();
  await new Promise((resolve) => setTimeout(resolve, 5));
});

afterAll(async () => {
  relay?.close();
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
  await api?.close();
});

describe("1. Ticket auth (raw WebSocket)", () => {
  it("admits a valid relay ticket", async (context) => {
    if (skipWithoutLoopback(context)) return;
    const host = await connectHost(hostId(1));
    expect(host.readyState).toBe(WebSocket.OPEN);
  });

  it("rejects every specified ticket confusion and lifetime case with 4401", async (context) => {
    if (skipWithoutLoopback(context)) return;
    const fakeApi = api as FakeApi;
    const now = Math.floor(Date.now() / 1_000);
    const unknownKey = await fakeApi.unpublishedKey();
    const cases = [
      await fakeApi.signTicket({ hostId: hostId(2), overrides: { typ: GRANT_JWT_TYP } }),
      await fakeApi.signTicket({ hostId: hostId(2), overrides: { audience: "wrong-aud" } }),
      await fakeApi.signTicket({
        hostId: hostId(2),
        overrides: { issuer: "https://wrong-issuer.test/api/v1" },
      }),
      await fakeApi.signTicket({
        hostId: hostId(2),
        overrides: {
          claims: {
            environmentId: "environment-1",
            keyGeneration: 1,
            scope: [HOST_CONNECT_SCOPE],
          },
        },
      }),
      await fakeApi.signTicket({
        hostId: hostId(2),
        overrides: { issuedAt: now - 10, expiresAt: now - 1 },
      }),
      await fakeApi.signTicket({
        hostId: hostId(2),
        overrides: { issuedAt: now + 61, expiresAt: now + 62 },
      }),
      await fakeApi.signTicket({ hostId: hostId(2), overrides: { key: unknownKey } }),
    ];
    for (const ticket of cases) {
      await expect(
        openAndClose(`/host/control?ticket=${encodeURIComponent(ticket)}`),
      ).resolves.toMatchObject({ code: RELAY_CLOSE_BAD_TOKEN });
    }
  });
});

describe("2. Grant auth (security critical)", () => {
  it("rejects replay, expiry, absence, and a mismatched hostId with exact codes", async (context) => {
    if (skipWithoutLoopback(context)) return;
    const fakeApi = api as FakeApi;
    const id = hostId(10);
    const control = await connectHost(id, "same-environment");
    const spliceRequest = nextControl(control, "splice_request");
    const grant = await fakeApi.signGrant({ hostId: id, environmentId: "same-environment" });
    const first = await openSocket(`/client/session?grant=${encodeURIComponent(grant)}`);
    await spliceRequest;
    await expect(
      openAndClose(`/client/session?grant=${encodeURIComponent(grant)}`),
    ).resolves.toMatchObject({ code: RELAY_CLOSE_GRANT_REPLAY });

    const now = Math.floor(Date.now() / 1_000);
    const expired = await fakeApi.signGrant({
      hostId: id,
      overrides: { issuedAt: now - 10, expiresAt: now - 1 },
    });
    await expect(
      openAndClose(`/client/session?grant=${encodeURIComponent(expired)}`),
    ).resolves.toMatchObject({ code: RELAY_CLOSE_BAD_TOKEN });

    for (const absentId of [hostId(11), hostId(12)]) {
      const absent = await fakeApi.signGrant({
        hostId: absentId,
        environmentId: "same-environment",
      });
      await expect(
        openAndClose(`/client/session?grant=${encodeURIComponent(absent)}`),
      ).resolves.toMatchObject({ code: RELAY_CLOSE_HOST_UNAVAILABLE });
    }
    first.terminate();
  });
});

describe("3. Splice lifecycle", () => {
  it("forwards text and binary, rejects a second dial, and propagates both close directions", async (context) => {
    if (skipWithoutLoopback(context)) return;
    const id = hostId(20);
    const control = await connectHost(id);
    const first = await openPending(control, id);
    const data = await openSocket(`/host/data?splice=${first.spliceId}`);

    const toHost = nextMessage(data);
    first.client.send("hello");
    await expect(toHost).resolves.toMatchObject({ data: Buffer.from("hello"), binary: false });
    const toClient = nextMessage(first.client);
    data.send(Buffer.from([0, 255, 1]));
    await expect(toClient).resolves.toMatchObject({ data: Buffer.from([0, 255, 1]), binary: true });

    await expect(openAndClose(`/host/data?splice=${first.spliceId}`)).resolves.toMatchObject({
      code: RELAY_CLOSE_SPLICE_CLAIMED,
    });
    const hostClose = closeOf(data);
    first.client.close(4401, "from-client");
    await expect(hostClose).resolves.toMatchObject({ code: 4401, reason: "from-client" });

    const second = await openPending(control, id);
    const secondData = await openSocket(`/host/data?splice=${second.spliceId}`);
    const clientClose = closeOf(second.client);
    secondData.close(4400, "from-host");
    await expect(clientClose).resolves.toMatchObject({ code: 4400, reason: "from-host" });
  });

  it("closes a client with 4404 when the host never dials back", async (context) => {
    if (skipWithoutLoopback(context)) return;
    const id = hostId(21);
    const control = await connectHost(id);
    const pending = await openPending(control, id);
    await expect(closeOf(pending.client)).resolves.toMatchObject({
      code: RELAY_CLOSE_HOST_UNAVAILABLE,
    });
  });
});

describe("4. Backpressure", () => {
  it("uses real socket pausing and bounded stall closure (deterministic adapter test is in splicePair.test)", async (context) => {
    if (skipWithoutLoopback(context)) return;
    const health = await fetch(`${wsOrigin.replace("ws:", "http:")}/healthz`);
    expect(health.status).toBe(200);
  });
});

describe("5. Control protocol", () => {
  it("ignores malformed messages, enforces keepalive, and supersedes control", async (context) => {
    if (skipWithoutLoopback(context)) return;
    const id = hostId(30);
    const first = await connectHost(id, "environment-1", false);
    first.send("not-json");
    first.send(JSON.stringify({ v: 1, type: "future-message" }));
    const firstClose = closeOf(first);
    const second = await connectHost(id);
    await expect(firstClose).resolves.toMatchObject({ code: RELAY_CLOSE_SUPERSEDED });
    second.terminate();

    const lost = await connectHost(hostId(31), "environment-1", false);
    await expect(closeOf(lost)).resolves.toMatchObject({ code: RELAY_CLOSE_KEEPALIVE_LOST });
  });
});

describe("6. Revocation", () => {
  it("delivers duplicate events then unlink closes control and its pair", async (context) => {
    if (skipWithoutLoopback(context)) return;
    const fakeApi = api as FakeApi;
    const id = hostId(40);
    const control = await connectHost(id);
    const pending = await openPending(control, id);
    const data = await openSocket(`/host/data?splice=${pending.spliceId}`);
    const revocation = nextControl(control, "revocation");
    const controlClose = closeOf(control);
    const clientClose = closeOf(pending.client);
    const dataClose = closeOf(data);
    const event: RevocationEvent = {
      id: fakeApi.watermark + 1,
      hostId: id,
      kind: "host_unlinked",
      subject: null,
      createdAt: "2026-08-13T00:00:00.000Z",
    };
    fakeApi.revocationEvents = [event, event];
    fakeApi.watermark = event.id;
    await expect(revocation).resolves.toMatchObject({ events: [event, event] });
    await expect(controlClose).resolves.toMatchObject({ code: RELAY_CLOSE_BAD_TOKEN });
    await expect(clientClose).resolves.toMatchObject({ code: RELAY_CLOSE_BAD_TOKEN });
    await expect(dataClose).resolves.toMatchObject({ code: RELAY_CLOSE_BAD_TOKEN });
  });
});

describe("7. Identity rule (security critical)", () => {
  it("routes duplicate environmentIds independently and signals hostId only", async (context) => {
    if (skipWithoutLoopback(context)) return;
    const first = await connectHost(hostId(50), "duplicate-environment");
    const second = await connectHost(hostId(51), "duplicate-environment");
    const secondRequest = nextControl(second, "splice_request");
    let firstSignaled = false;
    first.on("message", (data, binary) => {
      if (!binary && rawBuffer(data).includes(Buffer.from("splice_request"))) firstSignaled = true;
    });
    const grant = await (api as FakeApi).signGrant({
      hostId: hostId(51),
      environmentId: "duplicate-environment",
    });
    await openSocket(`/client/session?grant=${encodeURIComponent(grant)}`);
    await expect(secondRequest).resolves.toMatchObject({ hostId: hostId(51) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(firstSignaled).toBe(false);
  });
});

describe("8. End-to-end integration", () => {
  it("runs ticket → ready → grant → splice → traffic → revoke → teardown", async (context) => {
    if (skipWithoutLoopback(context)) return;
    const fakeApi = api as FakeApi;
    const id = hostId(60);
    const control = await connectHost(id);
    const pending = await openPending(control, id);
    const data = await openSocket(`/host/data?splice=${pending.spliceId}`);
    const received = nextMessage(data);
    pending.client.send("integrated");
    await expect(received).resolves.toMatchObject({ data: Buffer.from("integrated") });

    const close = closeOf(pending.client);
    fakeApi.revocationEvents = [
      {
        id: fakeApi.watermark + 1,
        hostId: id,
        kind: "host_unlinked",
        subject: null,
        createdAt: "2026-08-13T00:00:00.000Z",
      },
    ];
    fakeApi.watermark += 1;
    await expect(close).resolves.toMatchObject({ code: RELAY_CLOSE_BAD_TOKEN });
  });
});

describe("9. Load smoke", () => {
  // The shared relay pins pendingTimeoutMs to 100ms so the expiry tests in
  // section 3 finish fast. That budget is per splice but the load here creates
  // 100 at once, so on a busy runner the host cannot dial all of them back
  // inside 100ms and the relay correctly expires every one — 4404 "splice timed
  // out", zero pairs, and a failure that reads like cross-talk but is the
  // fixture starving itself. This scenario gets its own relay at the production
  // default (10s) because it is measuring routing, not the expiry deadline.
  let loadRelay: RelayApplication | undefined;
  let loadServer: ServerType | undefined;
  let loadOrigin = "";

  beforeAll(async () => {
    if (networkUnavailable || !api) return;
    const activeApi = api;
    loadRelay = await createRelayApp(
      {
        port: 0,
        apiBaseUrl: activeApi.origin,
        apiIssuer: activeApi.issuer,
        relayServiceToken: activeApi.serviceToken,
        maxPairs: 256,
        highWaterBytes: 64 * 1024,
      },
      {
        keepaliveIntervalMs: 5_000,
        revocationPollIntervalMs: 1_000,
        logger: { error: vi.fn(), warn: vi.fn() },
      },
    );
    const activeRelay = loadRelay;
    await new Promise<void>((resolve, reject) => {
      const activeServer = serve(
        { fetch: activeRelay.app.fetch, port: 0, hostname: "127.0.0.1" },
        (info) => {
          loadOrigin = `ws://127.0.0.1:${info.port}`;
          resolve();
        },
      );
      activeServer.on("upgrade", activeRelay.handleUpgrade as RelayApplication["handleUpgrade"]);
      activeServer.once("error", reject);
      loadServer = activeServer;
    });
  });

  afterAll(async () => {
    loadRelay?.close();
    if (loadServer) await new Promise<void>((resolve) => loadServer?.close(() => resolve()));
  });

  function openLoadSocket(path: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`${loadOrigin}${path}`);
      sockets.add(socket);
      socket.once("open", () => resolve(socket));
      socket.once("error", reject);
      socket.once("close", () => sockets.delete(socket));
    });
  }

  // Raised over the 15s default: this is the only scenario that opens 201
  // sockets, and it shares a CI runner with twelve other packages' suites.
  it(
    "echoes 100 concurrent pairs without reordering or cross-talk",
    { timeout: 60_000 },
    async (context) => {
      if (skipWithoutLoopback(context)) return;
      const id = hostId(70);
      const ticket = await (api as FakeApi).signTicket({
        hostId: id,
        environmentId: "environment-1",
      });
      const control = await openLoadSocket(`/host/control?ticket=${encodeURIComponent(ticket)}`);
      control.on("message", (data, binary) => {
        if (binary) return;
        try {
          const parsed = JSON.parse(rawBuffer(data).toString("utf8")) as { type?: string };
          if (parsed.type === "ping" && control.readyState === WebSocket.OPEN) {
            control.send(JSON.stringify({ v: 1, type: "pong" }));
          }
        } catch {
          // Not a control frame this helper handles.
        }
      });
      control.send(JSON.stringify({ v: 1, type: "ready" }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      const dataSockets: WebSocket[] = [];
      control.on("message", (raw, binary) => {
        if (binary) return;
        let message: { type?: string; spliceId?: string };
        try {
          message = JSON.parse(rawBuffer(raw).toString("utf8")) as typeof message;
        } catch {
          return;
        }
        if (message.type !== "splice_request" || !message.spliceId) return;
        void openLoadSocket(`/host/data?splice=${message.spliceId}`).then((data) => {
          dataSockets.push(data);
          data.on("message", (payload, isBinary) => data.send(payload, { binary: isBinary }));
        });
      });

      const clients = await Promise.all(
        Array.from({ length: 100 }, async (_, index) => {
          const grant = await (api as FakeApi).signGrant({
            hostId: id,
            userId: `user_${index}`,
            deviceJkt: `device_${index}`,
          });
          return openLoadSocket(`/client/session?grant=${encodeURIComponent(grant)}`);
        }),
      );
      await vi.waitFor(() => expect(dataSockets).toHaveLength(100), { timeout: 30_000 });
      // All 100 deadlines start in the same tick, so the default per-message 2s
      // would mean "all 100 round trips finish within 2s" — a latency claim this
      // scenario does not make. What it asserts is below: every reply reaches the
      // client that sent it, in order, with no cross-talk.
      const replies = clients.map((client, index) => {
        const reply = nextMessage(client, 30_000);
        client.send(`pair-${index}`);
        return reply;
      });
      const messages = await Promise.all(replies);
      expect(messages.map(({ data }) => data.toString("utf8"))).toEqual(
        Array.from({ length: 100 }, (_, index) => `pair-${index}`),
      );
    },
  );
});

import {
  RELAY_CLOSE_BAD_TOKEN,
  RELAY_CLOSE_GRANT_REPLAY,
  RELAY_CLOSE_HOST_UNAVAILABLE,
  RELAY_CLOSE_KEEPALIVE_LOST,
  RELAY_CLOSE_SPLICE_CLAIMED,
  RELAY_CLOSE_SUPERSEDED,
} from "@synara/relay-protocol";
import type { RevocationEvent } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiJwtVerifier } from "./jwtVerifier";
import { RelayCore } from "./relayCore";
import { FakeApi } from "./test/fakeApi";
import { FakeSocket } from "./test/fakeSocket";

const hostA = "00000000-0000-4000-8000-000000000001";
const hostB = "00000000-0000-4000-8000-000000000002";

describe("relay state machine", () => {
  let api: FakeApi;
  let verifier: ApiJwtVerifier;
  let relay: RelayCore;

  beforeEach(async () => {
    api = await FakeApi.create();
    verifier = new ApiJwtVerifier({
      apiBaseUrl: "https://fake-api.test",
      issuer: api.issuer,
      fetch: api.fetch,
      logger: { error: vi.fn() },
    });
    await verifier.initialize();
    relay = new RelayCore({
      verifier,
      maxPairs: 1_024,
      highWaterBytes: 1024,
      pendingTimeoutMs: 10_000,
      keepaliveIntervalMs: 30_000,
      logger: { error: vi.fn(), warn: vi.fn() },
    });
  });

  afterEach(() => {
    relay.stop();
    verifier.stop();
    vi.useRealTimers();
  });

  async function connectHost(
    hostId: string,
    environmentId = "shared-environment",
    socket = new FakeSocket(),
  ): Promise<FakeSocket> {
    await relay.admitHost(socket, await api.signTicket({ hostId, environmentId }));
    socket.emitJson({ v: 1, type: "ready" });
    return socket;
  }

  async function pendingFor(
    hostId: string,
    hostSocket: FakeSocket,
    environmentId = "shared-environment",
  ): Promise<{ client: FakeSocket; spliceId: string }> {
    const client = new FakeSocket();
    await relay.admitClient(client, await api.signGrant({ hostId, environmentId }));
    const request = hostSocket
      .sentJson()
      .find(
        (message): message is { type: "splice_request"; spliceId: string } =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "splice_request",
      );
    if (!request) throw new Error("host did not receive a splice request");
    return { client, spliceId: request.spliceId };
  }

  describe("ticket and control admission", () => {
    it("rejects an invalid ticket with 4401", async () => {
      const socket = new FakeSocket();
      await relay.admitHost(socket, "not-a-jwt");
      expect(socket.closes.at(-1)?.code).toBe(RELAY_CLOSE_BAD_TOKEN);
      expect(relay.hostCount).toBe(0);
    });

    it("ignores malformed control messages and supersedes by hostId", async () => {
      const first = await connectHost(hostA);
      first.emitJson({ v: 1, type: "unknown" });
      first.emitMessage(Buffer.from([0, 1, 2]), true);
      expect(first.closes).toHaveLength(0);

      const second = await connectHost(hostA);
      expect(first.closes.at(-1)?.code).toBe(RELAY_CLOSE_SUPERSEDED);
      expect(second.closes).toHaveLength(0);
      expect(relay.hostCount).toBe(1);
    });

    it("closes after two missed keepalives and tears down its pair", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
      relay.stop();
      relay = new RelayCore({
        verifier,
        maxPairs: 10,
        highWaterBytes: 1024,
        keepaliveIntervalMs: 100,
        pendingTimeoutMs: 10_000,
      });
      const host = await connectHost(hostA);
      const { client, spliceId } = await pendingFor(hostA, host);
      const data = new FakeSocket();
      relay.admitHostData(data, spliceId);
      expect(relay.pairCount).toBe(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(host.sentJson()).toContainEqual({ v: 1, type: "ping" });
      await vi.advanceTimersByTimeAsync(100);
      expect(host.closes.at(-1)?.code).toBe(RELAY_CLOSE_KEEPALIVE_LOST);
      expect(client.closes.at(-1)?.code).toBe(RELAY_CLOSE_KEEPALIVE_LOST);
      expect(data.closes.at(-1)?.code).toBe(RELAY_CLOSE_KEEPALIVE_LOST);
    });
  });

  describe("grant security and host identity", () => {
    it("enforces grant jti single-use with 4403", async () => {
      const host = await connectHost(hostA);
      const grant = await api.signGrant({ hostId: hostA });
      const first = new FakeSocket();
      const replay = new FakeSocket();
      await relay.admitClient(first, grant);
      await relay.admitClient(replay, grant);
      expect(
        host
          .sentJson()
          .filter((message) => (message as { type?: string }).type === "splice_request"),
      ).toHaveLength(1);
      expect(replay.closes.at(-1)?.code).toBe(RELAY_CLOSE_GRANT_REPLAY);
    });

    it("requires ready and rejects an expired grant or an absent host", async () => {
      const control = new FakeSocket();
      await relay.admitHost(control, await api.signTicket({ hostId: hostA }));
      const beforeReady = new FakeSocket();
      await relay.admitClient(beforeReady, await api.signGrant({ hostId: hostA }));
      expect(beforeReady.closes.at(-1)?.code).toBe(RELAY_CLOSE_HOST_UNAVAILABLE);

      const absent = new FakeSocket();
      await relay.admitClient(absent, await api.signGrant({ hostId: hostB }));
      expect(absent.closes.at(-1)?.code).toBe(RELAY_CLOSE_HOST_UNAVAILABLE);

      const now = Math.floor(Date.now() / 1_000);
      const expired = new FakeSocket();
      await relay.admitClient(
        expired,
        await api.signGrant({
          hostId: hostA,
          overrides: { issuedAt: now - 10, expiresAt: now - 1 },
        }),
      );
      expect(expired.closes.at(-1)?.code).toBe(RELAY_CLOSE_BAD_TOKEN);
    });

    it("never signals a connected host for a grant carrying another hostId", async () => {
      const connected = await connectHost(hostA, "same-environment");
      const client = new FakeSocket();
      await relay.admitClient(
        client,
        await api.signGrant({ hostId: hostB, environmentId: "same-environment" }),
      );
      expect(client.closes.at(-1)?.code).toBe(RELAY_CLOSE_HOST_UNAVAILABLE);
      expect(connected.sentJson()).not.toContainEqual(
        expect.objectContaining({ type: "splice_request" }),
      );
    });

    it("routes two identical environmentIds independently by hostId only", async () => {
      const first = await connectHost(hostA, "duplicate-environment");
      const second = await connectHost(hostB, "duplicate-environment");
      const client = new FakeSocket();
      await relay.admitClient(
        client,
        await api.signGrant({ hostId: hostB, environmentId: "duplicate-environment" }),
      );
      expect(first.sentJson()).not.toContainEqual(
        expect.objectContaining({ type: "splice_request" }),
      );
      expect(second.sentJson()).toContainEqual(
        expect.objectContaining({ type: "splice_request", hostId: hostB }),
      );
    });
  });

  describe("splice lifecycle", () => {
    it("pairs once, forwards opaque frames, and propagates close", async () => {
      const host = await connectHost(hostA);
      const { client, spliceId } = await pendingFor(hostA, host);
      const data = new FakeSocket();
      relay.admitHostData(data, spliceId);
      expect(client.paused).toBe(false);
      expect(data.paused).toBe(false);
      expect(relay.pairCount).toBe(1);

      const text = Buffer.from("opaque-text");
      const binary = Buffer.from([255, 0, 127]);
      client.emitMessage(text, false);
      data.emitMessage(binary, true);
      expect(data.sent).toContainEqual({ data: text, binary: false });
      expect(client.sent).toContainEqual({ data: binary, binary: true });

      const duplicate = new FakeSocket();
      relay.admitHostData(duplicate, spliceId);
      expect(duplicate.closes.at(-1)?.code).toBe(RELAY_CLOSE_SPLICE_CLAIMED);

      client.emitClose(4401, "client closed");
      expect(data.closes.at(-1)).toEqual({ code: 4401, reason: "client closed" });
      expect(relay.pairCount).toBe(0);
    });

    it("times out a pending client with 4404", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
      relay.stop();
      relay = new RelayCore({
        verifier,
        maxPairs: 10,
        highWaterBytes: 1024,
        pendingTimeoutMs: 100,
        keepaliveIntervalMs: 30_000,
      });
      const host = await connectHost(hostA);
      const { client } = await pendingFor(hostA, host);
      await vi.advanceTimersByTimeAsync(100);
      expect(client.closes.at(-1)?.code).toBe(RELAY_CLOSE_HOST_UNAVAILABLE);
      expect(relay.pendingCount).toBe(0);
    });

    it("counts pending reservations against RELAY_MAX_PAIRS", async () => {
      relay.stop();
      relay = new RelayCore({ verifier, maxPairs: 1, highWaterBytes: 1024 });
      const host = await connectHost(hostA);
      await pendingFor(hostA, host);
      const overloaded = new FakeSocket();
      await relay.admitClient(overloaded, await api.signGrant({ hostId: hostA }));
      expect(overloaded.closes.at(-1)?.code).toBe(1013);
      expect(
        host
          .sentJson()
          .filter((message) => (message as { type?: string }).type === "splice_request"),
      ).toHaveLength(1);
    });
  });

  describe("revocation delivery", () => {
    it("delivers duplicates and host_unlinked tears down control, pending, and pairs", async () => {
      const host = await connectHost(hostA);
      const paired = await pendingFor(hostA, host);
      const data = new FakeSocket();
      relay.admitHostData(data, paired.spliceId);
      const pending = await pendingFor(hostA, host);
      const event: RevocationEvent = {
        id: 7,
        hostId: hostA,
        kind: "host_unlinked",
        subject: null,
        createdAt: "2026-08-13T00:00:00.000Z",
      };
      relay.deliverRevocations([event, event]);
      expect(host.sentJson()).toContainEqual({
        v: 1,
        type: "revocation",
        events: [event, event],
      });
      expect(host.closes.at(-1)?.code).toBe(RELAY_CLOSE_BAD_TOKEN);
      expect(paired.client.closes.at(-1)?.code).toBe(RELAY_CLOSE_BAD_TOKEN);
      expect(data.closes.at(-1)?.code).toBe(RELAY_CLOSE_BAD_TOKEN);
      expect(pending.client.closes.at(-1)?.code).toBe(RELAY_CLOSE_BAD_TOKEN);
      expect(relay.hostCount).toBe(0);
      expect(relay.pairCount).toBe(0);
    });

    it("refuses the unlinked host's still-valid ticket on reconnect", async () => {
      // Closing the socket is not revocation: the ticket the host already
      // holds stays syntactically valid for its full 5 minutes, so without a
      // tombstone the host simply reconnects and keeps serving grants issued
      // before the unlink.
      const host = await connectHost(hostA);
      relay.deliverRevocations([
        {
          id: 8,
          hostId: hostA,
          kind: "host_unlinked",
          subject: null,
          createdAt: "2026-08-13T00:00:00.000Z",
        },
      ]);
      expect(host.closes.at(-1)?.code).toBe(RELAY_CLOSE_BAD_TOKEN);

      const reconnect = new FakeSocket();
      await relay.admitHost(
        reconnect,
        await api.signTicket({ hostId: hostA, environmentId: "shared-environment" }),
      );
      expect(reconnect.closes.at(-1)?.code).toBe(RELAY_CLOSE_BAD_TOKEN);
      expect(relay.hostCount).toBe(0);
    });

    it("tears down orphan pairs when unlink arrives with no control connected", async () => {
      const host = await connectHost(hostA);
      const paired = await pendingFor(hostA, host);
      const data = new FakeSocket();
      relay.admitHostData(data, paired.spliceId);
      expect(relay.pairCount).toBe(1);

      // The control socket drops (TCP reset, process restart) but the spliced
      // data sockets are still live. A revocation must still reach them.
      host.emitClose(1006, "reset");
      expect(relay.hostCount).toBe(0);

      relay.deliverRevocations([
        {
          id: 9,
          hostId: hostA,
          kind: "host_unlinked",
          subject: null,
          createdAt: "2026-08-13T00:00:00.000Z",
        },
      ]);
      expect(relay.pairCount).toBe(0);
    });

    it("closes established pairs when the control socket disconnects", async () => {
      // A pair outliving its control is unreachable by revocation and its
      // capacity slot is never reclaimed.
      const host = await connectHost(hostA);
      const paired = await pendingFor(hostA, host);
      const data = new FakeSocket();
      relay.admitHostData(data, paired.spliceId);
      expect(relay.pairCount).toBe(1);

      host.emitClose(1006, "reset");
      expect(relay.pairCount).toBe(0);
      expect(paired.client.closes.at(-1)?.code).toBe(RELAY_CLOSE_HOST_UNAVAILABLE);
      expect(data.closes.at(-1)?.code).toBe(RELAY_CLOSE_HOST_UNAVAILABLE);
    });
  });
});

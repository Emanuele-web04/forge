import type { RevocationEvent } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RevocationPoller } from "./revocationPoller";
import { FakeApi } from "./test/fakeApi";

const event: RevocationEvent = {
  id: 10,
  hostId: "00000000-0000-4000-8000-000000000001",
  kind: "device_revoked",
  subject: "device_1",
  createdAt: "2026-08-13T00:00:00.000Z",
};

describe("revocation poller", () => {
  let api: FakeApi;
  let deliveries: RevocationEvent[][];
  let poller: RevocationPoller;

  beforeEach(async () => {
    api = await FakeApi.create();
    api.watermark = 2;
    deliveries = [];
    poller = new RevocationPoller({
      apiBaseUrl: "https://fake-api.test",
      serviceToken: api.serviceToken,
      fetch: api.fetch,
      onEvents: (events) => deliveries.push([...events]),
      pollIntervalMs: 10,
      initialBackoffMs: 5,
      maxBackoffMs: 20,
      logger: { error: vi.fn() },
    });
  });

  afterEach(() => poller.stop());

  it("baselines from an omitted cursor and advances only to watermark", async () => {
    api.revocationEvents = [event];
    await poller.initialize();
    expect(api.revocationRequests).toEqual([undefined]);
    expect(poller.cursor).toBe(2);
    expect(deliveries).toEqual([]);

    api.watermark = 3;
    await poller.pollNow();
    expect(api.revocationRequests.at(-1)).toBe(2);
    expect(poller.cursor).toBe(3);
    expect(deliveries).toEqual([[event]]);
  });

  it("delivers duplicate events on repeated xmin-bounded windows", async () => {
    await poller.initialize();
    api.revocationEvents = [event];
    api.watermark = 3;
    await poller.pollNow();
    await poller.pollNow();
    expect(deliveries).toEqual([[event], [event]]);
    expect(poller.cursor).toBe(3);
  });

  it("backs off after failure and keeps polling", async () => {
    await poller.initialize();
    api.revocationEvents = [event];
    api.watermark = 10;
    api.revocationFailuresRemaining = 1;
    poller.start();
    await vi.waitFor(() => expect(deliveries).toEqual([[event]]), { timeout: 1_000 });
    expect(api.revocationRequests.length).toBeGreaterThanOrEqual(3);
    expect(poller.cursor).toBe(10);
  });

  it("falls back to cursor zero when the startup baseline fails", async () => {
    api.revocationFailuresRemaining = 1;
    api.revocationEvents = [event];
    api.watermark = 10;
    await poller.initialize();
    expect(poller.cursor).toBe(0);
    poller.start();
    await vi.waitFor(() => expect(deliveries).toEqual([[event]]), { timeout: 1_000 });
    expect(api.revocationRequests.slice(0, 2)).toEqual([undefined, 0]);
  });

  it("a fresh poller restarts at the current tail", async () => {
    api.revocationEvents = [event];
    api.watermark = 10;
    await poller.initialize();
    poller.stop();

    const restartedDeliveries: RevocationEvent[][] = [];
    poller = new RevocationPoller({
      apiBaseUrl: "https://fake-api.test",
      serviceToken: api.serviceToken,
      fetch: api.fetch,
      onEvents: (events) => restartedDeliveries.push([...events]),
    });
    await poller.initialize();
    expect(poller.cursor).toBe(10);
    expect(restartedDeliveries).toEqual([]);
    expect(api.revocationRequests.at(-1)).toBeUndefined();
  });
});

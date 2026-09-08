import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRelayApp, type RelayApplication } from "./app";
import type { RelayConfig } from "./config";
import { FakeApi } from "./test/fakeApi";
import { FakeSocket } from "./test/fakeSocket";

describe("relay HTTP surface", () => {
  let api: FakeApi;
  let relay: RelayApplication;

  beforeEach(async () => {
    api = await FakeApi.create();
    const config: RelayConfig = {
      port: 8789,
      apiBaseUrl: "https://fake-api.test",
      apiIssuer: api.issuer,
      relayServiceToken: api.serviceToken,
      maxPairs: 32,
      highWaterBytes: 1024,
    };
    relay = await createRelayApp(config, {
      fetch: api.fetch,
      logger: { error: vi.fn(), warn: vi.fn() },
    });
  });

  afterEach(() => relay.close());

  it("reports host and pair counts from healthz", async () => {
    const response = await relay.app.request("/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", hosts: 0, pairs: 0 });
  });

  it("serves no UI or HTTP proxy surface", async () => {
    expect((await relay.app.request("/")).status).toBe(404);
    expect((await relay.app.request("/anything")).status).toBe(404);
    expect((await relay.app.request("/host/control?ticket=secret")).status).toBe(426);
    expect((await relay.app.request("/client/session?grant=secret")).status).toBe(426);
    expect((await relay.app.request("/host/data?splice=id")).status).toBe(426);
  });

  it("answers per-host readiness, not just service health", async () => {
    // The aggregate /healthz cannot say whether a PARTICULAR host is
    // reachable, so a client probing it learned only that the relay was up.
    const absent = await relay.app.request("/healthz/host/00000000-0000-4000-8000-00000000dead");
    expect(absent.status).toBe(200);
    expect(await absent.json()).toEqual({ ready: false });

    // Only the LIVE case proves the probe answers the question the row asks.
    // With only the absent case covered, `ready: false` for every host (full
    // outage) and "connected counts as ready" (the ADR 0010 bug, where the
    // truth surfaces late as a 4404 at session open) both read as correct.
    const hostId = "00000000-0000-4000-8000-000000000001";
    const control = new FakeSocket();
    await relay.core.admitHost(control, await api.signTicket({ hostId }));
    const connectedNotReady = await relay.app.request(`/healthz/host/${hostId}`);
    expect(await connectedNotReady.json()).toEqual({ ready: false });

    control.emitJson({ v: 1, type: "ready" });
    const live = await relay.app.request(`/healthz/host/${hostId}`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ ready: true });

    // And the aggregate view stays a different question entirely.
    expect(await (await relay.app.request("/healthz")).json()).toEqual({
      status: "ok",
      hosts: 1,
      pairs: 0,
    });
  });
});

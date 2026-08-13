import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRelayApp, type RelayApplication } from "./app";
import type { RelayConfig } from "./config";
import { FakeApi } from "./test/fakeApi";

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
});

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ApiJwtVerifier } from "./jwtVerifier";
import { RelayCore } from "./relayCore";
import { FakeApi } from "./test/fakeApi";
import { FakeSocket } from "./test/fakeSocket";

const hostId = "20000000-0000-4000-8000-000000000001";

describe("9. Load smoke", () => {
  let api: FakeApi;
  let verifier: ApiJwtVerifier;

  beforeAll(async () => {
    api = await FakeApi.create();
    verifier = new ApiJwtVerifier({
      apiBaseUrl: "https://fake-api.test",
      issuer: api.issuer,
      fetch: api.fetch,
      logger: { error: vi.fn() },
    });
    await verifier.initialize();
  });

  afterAll(() => verifier.stop());

  it("keeps 100 concurrent signed-grant pairs ordered and isolated", async () => {
    const relay = new RelayCore({ verifier, maxPairs: 100, highWaterBytes: 1024 * 1024 });
    const control = new FakeSocket();
    await relay.admitHost(control, await api.signTicket({ hostId }));
    control.emitJson({ v: 1, type: "ready" });

    const clients = Array.from({ length: 100 }, () => new FakeSocket());
    await Promise.all(
      clients.map(async (client, index) =>
        relay.admitClient(
          client,
          await api.signGrant({
            hostId,
            userId: `user_${index}`,
            deviceJkt: `device_${index}`,
          }),
        ),
      ),
    );
    const requests = control
      .sentJson()
      .filter(
        (message): message is { type: "splice_request"; spliceId: string; userId: string } =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "splice_request",
      );
    expect(requests).toHaveLength(100);

    const dataByUser = new Map<string, FakeSocket>();
    for (const request of requests) {
      const data = new FakeSocket();
      dataByUser.set(request.userId, data);
      relay.admitHostData(data, request.spliceId);
    }
    expect(relay.pairCount).toBe(100);

    clients.forEach((client, index) => client.emitMessage(Buffer.from(`pair-${index}`), false));
    clients.forEach((client, index) => {
      const data = dataByUser.get(`user_${index}`) as FakeSocket;
      expect(data.sent).toEqual([{ data: Buffer.from(`pair-${index}`), binary: false }]);
      data.emitMessage(data.sent[0]?.data as Buffer, false);
      expect(client.sent).toEqual([{ data: Buffer.from(`pair-${index}`), binary: false }]);
    });
    relay.stop();
  });
});

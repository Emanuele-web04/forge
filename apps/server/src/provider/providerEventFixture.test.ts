import { describe, expect, it, vi } from "vitest";

import {
  parseProviderEventFixture,
  ProviderEventFixtureError,
  replayProviderEventFixture,
  sanitizeProviderEventFixtureEvents,
  serializeProviderEventFixture,
} from "./providerEventFixture";

describe("provider event fixtures", () => {
  it("redacts content and preserves deterministic identifier relationships", () => {
    const sanitized = sanitizeProviderEventFixtureEvents([
      {
        type: "message.part.delta",
        properties: {
          sessionID: "session-private",
          partID: "part-private",
          timestamp: 1_786_000_000,
          text: "private assistant text",
          token: "secret-token",
        },
      },
      {
        type: "message.part.updated",
        properties: {
          sessionID: "session-private",
          partID: "part-private",
          timestamp: 1_786_000_100,
          status: "completed",
        },
      },
    ]) as Array<Record<string, any>>;
    const first = sanitized[0]!;
    const second = sanitized[1]!;

    expect(first.properties.sessionID).toBe("<id-1>");
    expect(first.properties.partID).toBe("<id-2>");
    expect(first.properties.timestamp).toBe(0);
    expect(first.properties.text).toBe("<redacted>");
    expect(first.properties.token).toBe("<redacted>");
    expect(second.properties.sessionID).toBe("<id-1>");
    expect(second.properties.partID).toBe("<id-2>");
    expect(second.properties.status).toBe("completed");
  });

  it("keeps numeric and string identifiers distinct", () => {
    const [sanitized] = sanitizeProviderEventFixtureEvents([
      {
        type: "message.part.updated",
        properties: {
          sessionID: 1,
          partID: "1",
          status: "completed",
        },
      },
    ]) as Array<Record<string, any>>;

    expect(sanitized!.properties.sessionID).toBe("<id-1>");
    expect(sanitized!.properties.partID).toBe("<id-2>");
  });

  it("preserves timestamp types while normalizing values", () => {
    const [sanitized] = sanitizeProviderEventFixtureEvents([
      {
        type: "turn.completed",
        createdAt: "2026-08-15T12:34:56.000Z",
        properties: { timestamp: 1_786_000_000, state: "completed" },
      },
    ]) as Array<Record<string, any>>;

    expect(sanitized!.createdAt).toBe("2000-01-01T00:00:00.000Z");
    expect(sanitized!.properties.timestamp).toBe(0);
  });

  it("preserves safe native event methods", () => {
    const [sanitized] = sanitizeProviderEventFixtureEvents([
      {
        method: "thread/started",
        params: { sessionID: "session-private", status: "ready" },
      },
    ]) as Array<Record<string, any>>;

    expect(sanitized!.method).toBe("thread/started");
    expect(sanitized!.params.sessionID).toBe("<id-1>");
  });

  it("fails closed for an unclassified string field", () => {
    expect(() =>
      serializeProviderEventFixture([
        {
          type: "custom.event",
          properties: {
            mystery: "could contain user data",
          },
        },
      ]),
    ).toThrow(ProviderEventFixtureError);
  });

  it("rejects unclassified object keys even when their values are not strings", () => {
    expect(() =>
      serializeProviderEventFixture([
        {
          type: "custom.event",
          metadata: {
            "/home/alice/private-project": true,
          },
        },
      ]),
    ).toThrow(/unclassified object key/u);
  });

  it("does not trust globally safe-looking keys inside arbitrary metadata", () => {
    expect(() =>
      serializeProviderEventFixture([
        {
          type: "custom.event",
          metadata: {
            type: "private-project",
          },
        },
      ]),
    ).toThrow(/unclassified string field/u);
  });

  it("only preserves explicitly classified root protocol discriminators", () => {
    for (const event of [
      { type: "/home/alice/private-project" },
      { method: "thread/private-project-codename" },
    ]) {
      expect(() => serializeProviderEventFixture([event])).toThrow(/unclassified string field/u);
    }
  });

  it("does not trust discriminator-looking strings inside provider payloads", () => {
    expect(() =>
      serializeProviderEventFixture([{ type: "custom.event", status: "private-project-codename" }]),
    ).toThrow(/unclassified string field/u);
    for (const container of ["properties", "payload", "params"] as const) {
      expect(() =>
        serializeProviderEventFixture([
          {
            type: "custom.event",
            [container]: { status: "private-project-codename" },
          },
        ]),
      ).toThrow(/unclassified string field/u);
    }
  });

  it("rejects sensitive data embedded in property names", () => {
    expect(() =>
      serializeProviderEventFixture([
        {
          type: "custom.event",
          metadata: { "authorization-Bearer-private-secret": true },
        },
      ]),
    ).toThrow(/unclassified object key/u);
  });

  it("supports classified Claude and OpenCode payload shapes", () => {
    const [claude, openCode] = sanitizeProviderEventFixtureEvents([
      {
        type: "stream_event",
        payload: {
          type: "result",
          subtype: "success",
          is_error: false,
          parent_tool_use_id: null,
        },
      },
      {
        type: "message.updated",
        properties: {
          info: {
            time: { startedAt: 123, endedAt: 456 },
          },
        },
      },
    ]) as Array<Record<string, any>>;

    expect(claude!.payload).toMatchObject({
      type: "result",
      subtype: "success",
      is_error: false,
      parent_tool_use_id: null,
    });
    expect(openCode!.properties.info.time).toEqual({ startedAt: 0, endedAt: 0 });
  });

  it("preserves numeric usage fields while redacting credential tokens", () => {
    const [sanitized] = sanitizeProviderEventFixtureEvents([
      {
        type: "thread/tokenUsage/updated",
        payload: {
          tokenUsage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
          },
          token: "credential",
        },
      },
    ]) as Array<Record<string, any>>;

    expect(sanitized!.payload.tokenUsage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
    expect(sanitized!.payload.token).toBe("<redacted>");
  });

  it("preserves the structured OpenCode token-usage counters", () => {
    const [sanitized] = sanitizeProviderEventFixtureEvents([
      {
        type: "message.updated",
        properties: {
          info: {
            tokens: {
              total: 18,
              input: 10,
              output: 5,
              reasoning: 1,
              cache: { read: 2, write: 0 },
            },
          },
        },
      },
    ]) as Array<Record<string, any>>;

    expect(sanitized!.properties.info.tokens).toEqual({
      total: 18,
      input: 10,
      output: 5,
      reasoning: 1,
      cache: { read: 2, write: 0 },
    });
  });

  it("redacts string-valued message fields", () => {
    const [sanitized] = sanitizeProviderEventFixtureEvents([
      { type: "process/stderr", message: "private stderr text" },
    ]) as Array<Record<string, any>>;

    expect(sanitized!.message).toBe("<redacted>");
  });

  it("redacts structured sensitive values instead of traversing them", () => {
    const [sanitized] = sanitizeProviderEventFixtureEvents([
      {
        type: "custom.event",
        input: { count: 42 },
        body: [true, false],
      },
    ]) as Array<Record<string, any>>;

    expect(sanitized!.input).toBe("<redacted>");
    expect(sanitized!.body).toBe("<redacted>");
  });

  it("rejects non-object events and non-finite numbers before serialization", () => {
    for (const event of [null, 1, []]) {
      expect(() => serializeProviderEventFixture([event])).toThrow(/events must be objects/u);
    }
    expect(() =>
      serializeProviderEventFixture([{ type: "custom.event", attempt: Number.NaN }]),
    ).toThrow(/numbers must be finite/u);
    expect(() =>
      serializeProviderEventFixture([{ type: "custom.event", usage: [Infinity] }]),
    ).toThrow(/numbers must be finite/u);
  });

  it("rejects prototype-shaped keys instead of mutating the sanitizer result prototype", () => {
    const metadata = JSON.parse('{"__proto__":{"status":"completed"}}') as unknown;
    expect(() =>
      serializeProviderEventFixture([
        {
          type: "custom.event",
          metadata,
        },
      ]),
    ).toThrow(/unclassified object key/u);
  });

  it("round-trips a sanitized line-oriented fixture", () => {
    const serialized = serializeProviderEventFixture([
      {
        type: "session.state.changed",
        properties: {
          sessionID: "session-private",
          status: "ready",
          timestamp: 123,
        },
      },
      {
        type: "turn.completed",
        properties: {
          sessionID: "session-private",
          state: "completed",
          timestamp: 456,
        },
      },
    ]);

    const records = parseProviderEventFixture(serialized);

    expect(records).toHaveLength(2);
    expect(records.map((record) => record.index)).toEqual([0, 1]);
    expect(records[0]?.event).toMatchObject({
      type: "session.state.changed",
      properties: { sessionID: "<id-1>", status: "ready", timestamp: 0 },
    });
  });

  it("rejects malformed, version-mismatched, out-of-order, and non-object events", () => {
    expect(() => parseProviderEventFixture("not-json")).toThrow(ProviderEventFixtureError);
    expect(() =>
      parseProviderEventFixture(JSON.stringify({ version: 2, index: 0, event: {} })),
    ).toThrow(/unsupported version/u);
    expect(() =>
      parseProviderEventFixture(JSON.stringify({ version: 1, index: 1, event: {} })),
    ).toThrow(/out-of-order index/u);
    for (const event of [null, "event", 1, []]) {
      expect(() =>
        parseProviderEventFixture(JSON.stringify({ version: 1, index: 0, event })),
      ).toThrow(/event must be an object/u);
    }
  });

  it("enforces byte and event-count bounds", () => {
    const one = JSON.stringify({ version: 1, index: 0, event: {} });
    const two = `${one}\n${JSON.stringify({ version: 1, index: 1, event: {} })}`;

    expect(() => parseProviderEventFixture(one, { maxBytes: 1 })).toThrow(/exceeds 1 bytes/u);
    expect(() => parseProviderEventFixture(two, { maxEvents: 1 })).toThrow(/exceeds 1 events/u);
    expect(() => serializeProviderEventFixture(Array.from({ length: 2_001 }, () => ({})))).toThrow(
      /exceeds 2000 events/u,
    );
    expect(() =>
      serializeProviderEventFixture([
        {
          type: "custom.event",
          usage: Array.from({ length: 300_000 }, () => 1),
        },
      ]),
    ).toThrow(/exceeds 524288 bytes/u);
  });

  it("replays records sequentially in fixture order", async () => {
    const records = parseProviderEventFixture(
      [
        JSON.stringify({ version: 1, index: 0, event: { type: "first" } }),
        JSON.stringify({ version: 1, index: 1, event: { type: "second" } }),
      ].join("\n"),
    );
    const observed: string[] = [];
    const consume = vi.fn(async (event: unknown) => {
      await Promise.resolve();
      observed.push((event as { type: string }).type);
    });

    await replayProviderEventFixture(records, consume);

    expect(observed).toEqual(["first", "second"]);
    expect(consume).toHaveBeenCalledTimes(2);
  });
});

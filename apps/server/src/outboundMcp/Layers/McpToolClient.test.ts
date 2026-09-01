import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { OutboundMcpDecodeError, type McpConsumerBinding } from "../consumerBinding.ts";
import { makeMcpToolClient, type McpToolSession } from "./McpToolClient.ts";

type FixtureOperation = "read" | "optional";

const fixtureBinding: McpConsumerBinding<FixtureOperation> = {
  id: "fixture-consumer",
  presetIds: new Set(["fixture"]),
  requiredTools: new Set(["fixture_read"]),
  optionalTools: new Set(["fixture_optional"]),
  operations: {
    read: {
      tool: "fixture_read",
      decode: (result) => Effect.succeed(result),
    },
    optional: {
      tool: "fixture_optional",
      decode: (result) => Effect.succeed(result),
    },
  },
};

const fixtureConnection = {
  connectionId: "fixture",
  presetId: "fixture",
  endpoint: new URL("https://mcp.example.test/mcp"),
};

const fixtureTools = [
  {
    name: "fixture_read",
    inputSchema: { type: "object" as const, properties: { value: { type: "string" } } },
  },
  {
    name: "fixture_optional",
    inputSchema: { type: "object" as const },
    outputSchema: { type: "object" as const, properties: { ok: { type: "boolean" } } },
  },
];

function immediateSession(overrides: Partial<McpToolSession> = {}): McpToolSession {
  return {
    listTools: async () => fixtureTools,
    callTool: async (tool, args) => ({ tool, args }),
    close: async () => undefined,
    ...overrides,
  };
}

async function eventually(assertion: () => void, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      if (attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

describe("McpToolClient", () => {
  it("rejects a tool outside the consumer operations before connecting", async () => {
    let connectionAttempts = 0;
    const client = makeMcpToolClient({
      resolveConnection: async () => fixtureConnection,
      createSession: async () => {
        connectionAttempts += 1;
        return immediateSession();
      },
    });

    await expect(
      Effect.runPromise(
        client.call(fixtureBinding, "write_comment", {}, new AbortController().signal),
      ),
    ).rejects.toThrow("Tool is not allowed for this consumer");
    expect(connectionAttempts).toBe(0);
  });

  it("shares one lazy connection attempt between concurrent callers", async () => {
    let connectionAttempts = 0;
    let releaseConnection!: () => void;
    const connectionGate = new Promise<void>((resolve) => {
      releaseConnection = resolve;
    });
    const client = makeMcpToolClient({
      resolveConnection: async () => fixtureConnection,
      createSession: async () => {
        connectionAttempts += 1;
        await connectionGate;
        return immediateSession();
      },
    });

    const first = Effect.runPromise(
      client.call(fixtureBinding, "fixture_read", { value: 1 }, new AbortController().signal),
    );
    const second = Effect.runPromise(
      client.call(fixtureBinding, "fixture_read", { value: 2 }, new AbortController().signal),
    );
    await eventually(() => expect(connectionAttempts).toBe(1));
    releaseConnection();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { tool: "fixture_read", args: { value: 1 } },
      { tool: "fixture_read", args: { value: 2 } },
    ]);
    expect(connectionAttempts).toBe(1);
  });

  it("limits calls to six concurrent operations per connection", async () => {
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const client = makeMcpToolClient({
      resolveConnection: async () => fixtureConnection,
      createSession: async () =>
        immediateSession({
          callTool: async (_tool, args) => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            await new Promise<void>((resolve) => releases.push(resolve));
            active -= 1;
            return args;
          },
        }),
    });

    const calls = Array.from({ length: 7 }, (_, index) =>
      Effect.runPromise(
        client.call(fixtureBinding, "fixture_read", { index }, new AbortController().signal),
      ),
    );
    await eventually(() => expect(active).toBe(6));
    expect(maximumActive).toBe(6);
    expect(releases).toHaveLength(6);

    releases.shift()?.();
    await eventually(() => expect(releases).toHaveLength(6));
    while (releases.length > 0) releases.shift()?.();

    await expect(Promise.all(calls)).resolves.toHaveLength(7);
    expect(maximumActive).toBe(6);
  });

  it("passes caller cancellation to an in-flight tool call", async () => {
    const controller = new AbortController();
    const abortReason = new DOMException("cancelled by caller", "AbortError");
    let observedSignal: AbortSignal | null = null;
    const client = makeMcpToolClient({
      resolveConnection: async () => fixtureConnection,
      createSession: async () =>
        immediateSession({
          callTool: async (_tool, _args, signal) => {
            observedSignal = signal;
            return await new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          },
        }),
    });

    const call = Effect.runPromise(
      client.call(fixtureBinding, "fixture_read", {}, controller.signal),
    );
    await eventually(() => expect(observedSignal).not.toBeNull());
    controller.abort(abortReason);

    await expect(call).rejects.toMatchObject({ name: "AbortError" });
    expect(observedSignal).toBe(controller.signal);
  });

  it("validates required tools while allowing an absent optional tool", async () => {
    const client = makeMcpToolClient({
      resolveConnection: async () => fixtureConnection,
      createSession: async () =>
        immediateSession({
          listTools: async () => [fixtureTools[0]!],
        }),
    });

    await expect(Effect.runPromise(client.validate(fixtureBinding))).resolves.toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("fails validation when a required tool is missing", async () => {
    const client = makeMcpToolClient({
      resolveConnection: async () => fixtureConnection,
      createSession: async () => immediateSession({ listTools: async () => [] }),
    });

    await expect(Effect.runPromise(client.validate(fixtureBinding))).rejects.toMatchObject({
      category: "missing-required-tool",
      consumerId: "fixture-consumer",
    });
  });

  it("makes the catalog fingerprint independent of tool and schema key order", async () => {
    let catalog = fixtureTools;
    const client = makeMcpToolClient({
      resolveConnection: async () => fixtureConnection,
      createSession: async () =>
        immediateSession({
          listTools: async () => catalog,
        }),
    });

    const first = await Effect.runPromise(client.validate(fixtureBinding));
    await Effect.runPromise(client.invalidate("fixture"));
    catalog = [
      {
        outputSchema: {
          properties: { ok: { type: "boolean" } },
          type: "object" as const,
        },
        inputSchema: { type: "object" as const },
        name: "fixture_optional",
      },
      {
        inputSchema: {
          properties: { value: { type: "string" } },
          type: "object" as const,
        },
        name: "fixture_read",
      },
    ];

    const second = await Effect.runPromise(client.validate(fixtureBinding));
    expect(second).toBe(first);
  });

  it("returns decoder failures without retaining the rejected payload", async () => {
    const sensitivePayload = { access_token: "must-not-escape" };
    const rejectingBinding: McpConsumerBinding<"read"> = {
      id: "rejecting-consumer",
      presetIds: new Set(["fixture"]),
      requiredTools: new Set(["fixture_read"]),
      optionalTools: new Set(),
      operations: {
        read: {
          tool: "fixture_read",
          decode: () =>
            Effect.fail(
              new OutboundMcpDecodeError({
                consumerId: "rejecting-consumer",
                operation: "read",
                category: "invalid-result",
              }),
            ),
        },
      },
    };
    const client = makeMcpToolClient({
      resolveConnection: async () => fixtureConnection,
      createSession: async () => immediateSession({ callTool: async () => sensitivePayload }),
    });

    let caught: unknown;
    try {
      await Effect.runPromise(
        client.call(rejectingBinding, "fixture_read", {}, new AbortController().signal),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(OutboundMcpDecodeError);
    expect(JSON.stringify(caught)).not.toContain("must-not-escape");
  });

  it("disposes invalidated sessions and reconnects lazily", async () => {
    let connections = 0;
    let closes = 0;
    const client = makeMcpToolClient({
      resolveConnection: async () => fixtureConnection,
      createSession: async () => {
        connections += 1;
        return immediateSession({
          close: async () => {
            closes += 1;
          },
        });
      },
    });

    await Effect.runPromise(
      client.call(fixtureBinding, "fixture_read", {}, new AbortController().signal),
    );
    await Effect.runPromise(client.invalidate("fixture"));
    await Effect.runPromise(
      client.call(fixtureBinding, "fixture_read", {}, new AbortController().signal),
    );
    await Effect.runPromise(client.closeAll());

    expect(connections).toBe(2);
    expect(closes).toBe(2);
  });

  it("waits for an invalidated connection attempt to dispose its late session", async () => {
    let releaseConnection!: () => void;
    const connectionGate = new Promise<void>((resolve) => {
      releaseConnection = resolve;
    });
    let closes = 0;
    const client = makeMcpToolClient({
      resolveConnection: async () => fixtureConnection,
      createSession: async () => {
        await connectionGate;
        return immediateSession({
          close: async () => {
            closes += 1;
          },
        });
      },
    });

    const call = Effect.runPromise(
      client.call(fixtureBinding, "fixture_read", {}, new AbortController().signal),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    let invalidationSettled = false;
    const invalidation = Effect.runPromise(client.invalidate("fixture")).then(() => {
      invalidationSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invalidationSettled).toBe(false);

    releaseConnection();
    await invalidation;

    await expect(call).rejects.toMatchObject({ category: "connection" });
    expect(closes).toBe(1);
  });
});

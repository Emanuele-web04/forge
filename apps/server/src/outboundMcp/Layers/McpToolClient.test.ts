import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import {
  OutboundMcpDecodeError,
  OutboundMcpInputError,
  type McpConsumerBinding,
} from "../consumerBinding.ts";
import { makeSingleFlightRefreshFetch } from "../networkPolicy.ts";
import type {
  OutboundMcpCredentialRecord,
  OutboundMcpCredentialsShape,
} from "../Services/OutboundMcpCredentials.ts";
import type {
  OutboundMcpConnectionRecord,
  OutboundMcpRepositoryShape,
} from "../Services/OutboundMcpRepository.ts";
import {
  makeLiveMcpToolClient,
  makeMcpSdkRequestFetchContext,
  makeMcpToolClient,
  type McpToolSession,
} from "./McpToolClient.ts";

type FixtureOperation = "read" | "optional";

function encodeFixtureRead(input: unknown) {
  if (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    Object.keys(input).length === 1 &&
    "value" in input &&
    typeof input.value === "string"
  ) {
    return Effect.succeed({ value: input.value });
  }
  return Effect.fail(
    new OutboundMcpInputError({
      consumerId: "fixture-consumer",
      operation: "read",
      category: "invalid-input",
    }),
  );
}

function encodeFixtureOptional(input: unknown) {
  if (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    Object.keys(input).length === 0
  ) {
    return Effect.succeed({});
  }
  return Effect.fail(
    new OutboundMcpInputError({
      consumerId: "fixture-consumer",
      operation: "optional",
      category: "invalid-input",
    }),
  );
}

const fixtureBinding: McpConsumerBinding<FixtureOperation> = {
  id: "fixture-consumer",
  presetIds: new Set(["fixture"]),
  requiredTools: new Set(["fixture_read"]),
  optionalTools: new Set(["fixture_optional"]),
  operations: {
    read: {
      tool: "fixture_read",
      encode: encodeFixtureRead,
      decode: (result) => Effect.succeed(result),
    },
    optional: {
      tool: "fixture_optional",
      encode: encodeFixtureOptional,
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
  it.each([
    "disconnected",
    "reconnect-required",
    "temporarily-unavailable",
    "incompatible",
    "authorizing",
  ] as const)("fences residual credentials while connection status is %s", async (status) => {
    const record: OutboundMcpConnectionRecord = {
      connectionId: "fixture",
      presetId: "fixture",
      displayName: "Fixture MCP",
      endpoint: "https://mcp.example.test/mcp",
      status,
      errorCategory: null,
      catalogFingerprint: null,
      lastValidatedAt: null,
      createdAt: "2026-09-01T08:00:00.000Z",
      updatedAt: "2026-09-01T08:00:00.000Z",
    };
    const repository: OutboundMcpRepositoryShape = {
      list: () => Effect.succeed([record]),
      get: () => Effect.succeed(record),
      upsertMetadata: () => Effect.void,
      setStatus: () => Effect.void,
      delete: () => Effect.void,
    };
    const residualCredentials: OutboundMcpCredentialRecord = {
      clientInformation: { client_id: "fixture-public-client" },
      tokens: { access_token: "synthetic-residual-token", token_type: "Bearer" },
      authorizationServerUrl: "https://auth.example.test/",
    };
    let credentialReads = 0;
    const credentials: OutboundMcpCredentialsShape = {
      read: () =>
        Effect.sync(() => {
          credentialReads += 1;
          return residualCredentials;
        }),
      write: () => Effect.void,
      delete: () => Effect.void,
      clearAttemptSecrets: () => Effect.void,
    };
    let networkRequests = 0;
    const client = makeLiveMcpToolClient({
      repository,
      credentials,
      fetch: async () => {
        networkRequests += 1;
        return new Response(null, { status: 500 });
      },
      resolveAddresses: async () => ["1.1.1.1"],
    });

    await expect(
      Effect.runPromise(
        client.call(
          fixtureBinding,
          "fixture_read",
          { value: "connected" },
          new AbortController().signal,
        ),
      ),
    ).rejects.toMatchObject({ category: "connection-status" });
    expect(credentialReads).toBe(0);
    expect(networkRequests).toBe(0);
  });

  it("pins established refresh discovery to the stored authorization server before secrets", async () => {
    const record: OutboundMcpConnectionRecord = {
      connectionId: "fixture",
      presetId: "fixture",
      displayName: "Fixture MCP",
      endpoint: "https://mcp.example.test/mcp",
      status: "connected",
      errorCategory: null,
      catalogFingerprint: null,
      lastValidatedAt: null,
      createdAt: "2026-09-01T08:00:00.000Z",
      updatedAt: "2026-09-01T08:00:00.000Z",
    };
    const repository: OutboundMcpRepositoryShape = {
      list: () => Effect.succeed([record]),
      get: () => Effect.succeed(record),
      upsertMetadata: () => Effect.void,
      setStatus: () => Effect.void,
      delete: () => Effect.void,
    };
    const credentials: OutboundMcpCredentialsShape = {
      read: () =>
        Effect.succeed({
          authorizationServerUrl: "https://auth-a.example.test/",
          clientInformation: {
            client_id: "fixture-client",
            client_secret: "synthetic-client-secret",
          },
          tokens: {
            access_token: "synthetic-expired-access-token",
            refresh_token: "synthetic-refresh-token",
            token_type: "Bearer",
          },
        }),
      write: () => Effect.void,
      delete: () => Effect.void,
      clearAttemptSecrets: () => Effect.void,
    };
    let sensitiveAuthorizationRequests = 0;
    let storedAuthorityMetadataRequests = 0;
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input);
      const headers = new Headers(init?.headers);
      const body = String(init?.body ?? "");
      if (
        url.origin.startsWith("https://auth-") &&
        (headers.has("authorization") ||
          body.includes("synthetic-client-secret") ||
          body.includes("synthetic-refresh-token"))
      ) {
        sensitiveAuthorizationRequests += 1;
      }
      if (url.origin === "https://mcp.example.test" && (init?.method ?? "GET") === "POST") {
        return new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } });
      }
      if (url.origin === "https://mcp.example.test") {
        return Response.json({
          resource: "https://mcp.example.test/mcp",
          authorization_servers: ["https://auth-b.example.test/"],
        });
      }
      if (url.pathname.includes(".well-known")) {
        if (url.origin === "https://auth-a.example.test") {
          storedAuthorityMetadataRequests += 1;
        }
        return Response.json({
          issuer: `${url.origin}/`,
          authorization_endpoint: `${url.origin}/oauth/authorize`,
          token_endpoint: `${url.origin}/oauth/token`,
          registration_endpoint: `${url.origin}/oauth/register`,
          revocation_endpoint: `${url.origin}/oauth/revoke`,
          response_types_supported: ["code"],
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
        });
      }
      return Response.json(
        {
          access_token: "synthetic-rotated-access-token",
          refresh_token: "synthetic-rotated-refresh-token",
          token_type: "Bearer",
        },
        { status: 200 },
      );
    };
    const client = makeLiveMcpToolClient({
      repository,
      credentials,
      fetch,
      resolveAddresses: async () => ["1.1.1.1"],
    });

    await expect(
      Effect.runPromise(
        client.call(
          fixtureBinding,
          "fixture_read",
          { value: "refresh" },
          new AbortController().signal,
        ),
      ),
    ).rejects.toMatchObject({ category: "connection" });
    expect(storedAuthorityMetadataRequests).toBe(1);
    expect(sensitiveAuthorizationRequests).toBe(0);
  });

  it("rejects an invalid stored authorization server before any network request", async () => {
    const record: OutboundMcpConnectionRecord = {
      connectionId: "fixture",
      presetId: "fixture",
      displayName: "Fixture MCP",
      endpoint: "https://mcp.example.test/mcp",
      status: "connected",
      errorCategory: null,
      catalogFingerprint: null,
      lastValidatedAt: null,
      createdAt: "2026-09-01T08:00:00.000Z",
      updatedAt: "2026-09-01T08:00:00.000Z",
    };
    const repository: OutboundMcpRepositoryShape = {
      list: () => Effect.succeed([record]),
      get: () => Effect.succeed(record),
      upsertMetadata: () => Effect.void,
      setStatus: () => Effect.void,
      delete: () => Effect.void,
    };
    const credentials: OutboundMcpCredentialsShape = {
      read: () =>
        Effect.succeed({
          authorizationServerUrl:
            "http://auth.example.test/private?client_secret=synthetic-client-secret",
          clientInformation: { client_id: "fixture-client" },
          tokens: { access_token: "synthetic-access-token", token_type: "Bearer" },
        }),
      write: () => Effect.void,
      delete: () => Effect.void,
      clearAttemptSecrets: () => Effect.void,
    };
    let networkRequests = 0;
    const client = makeLiveMcpToolClient({
      repository,
      credentials,
      fetch: async () => {
        networkRequests += 1;
        return new Response(null, { status: 500 });
      },
      resolveAddresses: async () => ["1.1.1.1"],
    });

    let caught: unknown;
    try {
      await Effect.runPromise(
        client.call(
          fixtureBinding,
          "fixture_read",
          { value: "blocked" },
          new AbortController().signal,
        ),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ category: "connection" });
    expect(networkRequests).toBe(0);
    expect(JSON.stringify(caught)).not.toContain("synthetic-client-secret");
    expect(JSON.stringify(caught)).not.toContain("private");
  });

  it("aborts only the caller's live SDK HTTP request through the custom fetch boundary", async () => {
    const firstController = new AbortController();
    const secondController = new AbortController();
    let firstHttpSignal: AbortSignal | undefined;
    let secondHttpSignal: AbortSignal | undefined;
    let firstHttpAborted = false;
    let toolRequests = 0;
    const transportFetch = async (
      _url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      if ((init?.method ?? "GET").toUpperCase() === "GET") {
        return new Response(null, { status: 405 });
      }
      const message = JSON.parse(String(init?.body)) as {
        readonly id?: string | number;
        readonly method?: string;
        readonly params?: { readonly arguments?: { readonly call?: string } };
      };
      if (message.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1.0.0" },
          },
        });
      }
      if (message.method !== "tools/call") return new Response(null, { status: 202 });

      toolRequests += 1;
      if (message.params?.arguments?.call === "first") {
        firstHttpSignal = init?.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              firstHttpAborted = true;
              reject(init.signal?.reason);
            },
            { once: true },
          );
        });
      }

      secondHttpSignal = init?.signal ?? undefined;
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: "second completed" }] },
      });
    };
    const requestFetch = makeMcpSdkRequestFetchContext(transportFetch);
    const transport = new StreamableHTTPClientTransport(new URL("https://mcp.example.test/mcp"), {
      fetch: requestFetch.fetch,
    });
    const sdkClient = new Client(
      { name: "request-signal-test", version: "1.0.0" },
      { capabilities: {} },
    );

    try {
      await sdkClient.connect(transport);
      const first = requestFetch.run(firstController.signal, () =>
        sdkClient.callTool({ name: "fixture_read", arguments: { call: "first" } }, undefined, {
          signal: firstController.signal,
        }),
      );
      const second = requestFetch.run(secondController.signal, () =>
        sdkClient.callTool({ name: "fixture_read", arguments: { call: "second" } }, undefined, {
          signal: secondController.signal,
        }),
      );
      await eventually(() => expect(toolRequests).toBe(2));

      firstController.abort(new DOMException("first caller stopped", "AbortError"));

      await expect(first).rejects.toThrow("AbortError");
      await expect(second).resolves.toMatchObject({
        content: [{ type: "text", text: "second completed" }],
      });
      expect(firstHttpAborted).toBe(true);
      expect(firstHttpSignal?.aborted).toBe(true);
      expect(secondHttpSignal?.aborted).toBe(false);
    } finally {
      await sdkClient.close();
    }
  });

  it("keeps a coalesced OAuth refresh independent of either caller signal", async () => {
    const firstController = new AbortController();
    const secondController = new AbortController();
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshSignal: AbortSignal | undefined;
    let refreshRequests = 0;
    const sharedRefreshFetch = makeSingleFlightRefreshFetch(async (_url, init) => {
      refreshRequests += 1;
      refreshSignal = init?.signal ?? undefined;
      await refreshGate;
      return Response.json({ access_token: "rotated", token_type: "Bearer" });
    });
    const requestFetch = makeMcpSdkRequestFetchContext(sharedRefreshFetch);
    const refreshInit: RequestInit = {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "refresh-token",
      }),
    };

    const first = requestFetch.run(firstController.signal, () =>
      requestFetch.fetch("https://auth.example.test/token", refreshInit),
    );
    const second = requestFetch.run(secondController.signal, () =>
      requestFetch.fetch("https://auth.example.test/token", refreshInit),
    );
    await eventually(() => expect(refreshRequests).toBe(1));
    firstController.abort(new DOMException("first caller stopped", "AbortError"));

    expect(refreshSignal?.aborted).not.toBe(true);
    releaseRefresh();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    await expect(firstResponse.json()).resolves.toMatchObject({ access_token: "rotated" });
    await expect(secondResponse.json()).resolves.toMatchObject({ access_token: "rotated" });
    expect(refreshRequests).toBe(1);
  });

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

  it.each([
    ["missing", {}],
    ["extra", { value: "allowed", extra: true }],
    ["wrong type", { value: 42 }],
  ])("rejects %s tool input before resolving or calling a session", async (_case, input) => {
    let connectionAttempts = 0;
    let toolCalls = 0;
    const client = makeMcpToolClient({
      resolveConnection: async () => {
        connectionAttempts += 1;
        return fixtureConnection;
      },
      createSession: async () =>
        immediateSession({
          callTool: async () => {
            toolCalls += 1;
            return {};
          },
        }),
    });

    await expect(
      Effect.runPromise(
        client.call(fixtureBinding, "fixture_read", input, new AbortController().signal),
      ),
    ).rejects.toBeInstanceOf(OutboundMcpInputError);
    expect(connectionAttempts).toBe(0);
    expect(toolCalls).toBe(0);
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
      client.call(fixtureBinding, "fixture_read", { value: "one" }, new AbortController().signal),
    );
    const second = Effect.runPromise(
      client.call(fixtureBinding, "fixture_read", { value: "two" }, new AbortController().signal),
    );
    await eventually(() => expect(connectionAttempts).toBe(1));
    releaseConnection();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { tool: "fixture_read", args: { value: "one" } },
      { tool: "fixture_read", args: { value: "two" } },
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
        client.call(
          fixtureBinding,
          "fixture_read",
          { value: String(index) },
          new AbortController().signal,
        ),
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
      client.call(fixtureBinding, "fixture_read", { value: "abort" }, controller.signal),
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

  it("aborts an internally-owned validation signal when the validate Effect is interrupted", async () => {
    let observedSignal: AbortSignal | null = null;
    const client = makeMcpToolClient({
      resolveConnection: async () => fixtureConnection,
      createSession: async () =>
        immediateSession({
          listTools: async (signal) => {
            observedSignal = signal;
            return await new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          },
        }),
    });
    const fiber = Effect.runFork(client.validate(fixtureBinding));
    await eventually(() => expect(observedSignal).not.toBeNull());
    expect(observedSignal?.aborted).toBe(false);

    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(observedSignal?.aborted).toBe(true);
  });

  it("does not abort an external validation signal when the validate Effect is interrupted", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | null = null;
    const client = makeMcpToolClient({
      resolveConnection: async () => fixtureConnection,
      createSession: async () =>
        immediateSession({
          listTools: async (signal) => {
            observedSignal = signal;
            return await new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          },
        }),
    });
    const fiber = Effect.runFork(client.validate(fixtureBinding, controller.signal));
    await eventually(() => expect(observedSignal).toBe(controller.signal));

    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(controller.signal.aborted).toBe(false);
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
          encode: encodeFixtureRead,
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
        client.call(
          rejectingBinding,
          "fixture_read",
          { value: "decode" },
          new AbortController().signal,
        ),
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
      client.call(fixtureBinding, "fixture_read", { value: "first" }, new AbortController().signal),
    );
    await Effect.runPromise(client.invalidate("fixture"));
    await Effect.runPromise(
      client.call(
        fixtureBinding,
        "fixture_read",
        { value: "second" },
        new AbortController().signal,
      ),
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
      client.call(fixtureBinding, "fixture_read", { value: "late" }, new AbortController().signal),
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

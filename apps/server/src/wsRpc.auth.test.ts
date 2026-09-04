import { WS_METHODS, WsRpcError } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";

import { AuthError } from "./auth/Services/ServerAuth";
import {
  bindOutboundMcpCallbackEndpoint,
  makeOutboundMcpCallbackEndpoint,
  withOutboundMcpCallbackCapability,
} from "./outboundMcp/callbackEndpoint";
import type { McpConnectionServiceShape } from "./outboundMcp/Services/McpConnectionService";
import { CurrentWsSessionRole } from "./wsConnectionSessions";
import {
  authenticateRpcWebSocketUpgrade,
  authorizeDeviceFrameWebSocketUpgrade,
  canManageExternalMcp,
  makeOutboundMcpLifecycleRpcHandlers,
} from "./wsRpc";

const requireTestMcpOwner = Effect.gen(function* () {
  if ((yield* CurrentWsSessionRole) !== "owner") {
    return yield* Effect.fail(
      new WsRpcError({ message: "Owner authorization is required for this operation." }),
    );
  }
});

function observedMcpManagementService() {
  const state = {
    calls: [] as string[],
    authorizing: false,
    credentialsPresent: true,
  };
  const service = {
    list: () =>
      Effect.sync(() => {
        state.calls.push("list");
        return [];
      }),
    beginAuthorization: () =>
      Effect.sync(() => {
        state.calls.push("begin");
        state.authorizing = true;
        return {
          attemptId: "attempt-owner-gate",
          authorizationUrl: "https://auth.example.test/authorize",
        };
      }),
    disconnect: () =>
      Effect.sync(() => {
        state.calls.push("disconnect");
        state.credentialsPresent = false;
      }),
    completeAuthorization: () => Effect.die("not used"),
    invoke: () => Effect.die("not used"),
    subscribe: () => Effect.die("not used"),
  } as never;
  return { service, state };
}

it.effect("denies all outbound MCP lifecycle management to the default client role", () =>
  Effect.gen(function* () {
    const observed = observedMcpManagementService();
    const handlers = makeOutboundMcpLifecycleRpcHandlers(observed.service, requireTestMcpOwner);

    const errors = yield* Effect.all([
      handlers[WS_METHODS.serverListOutboundMcpConnections]({}).pipe(Effect.flip),
      handlers[WS_METHODS.serverBeginOutboundMcpAuthorization]({ presetId: "paraty" }).pipe(
        Effect.flip,
      ),
      handlers[WS_METHODS.serverDisconnectOutboundMcpConnection]({ connectionId: "paraty" }).pipe(
        Effect.flip,
      ),
    ]);

    assert.deepStrictEqual(
      errors.map((error) => error.message),
      Array.from({ length: 3 }, () => "Owner authorization is required for this operation."),
    );
    assert.deepStrictEqual(observed.state.calls, []);
    assert.isFalse(observed.state.authorizing);
    assert.isTrue(observed.state.credentialsPresent);
  }),
);

it.effect("allows an owner role to use all outbound MCP lifecycle management", () =>
  Effect.gen(function* () {
    const observed = observedMcpManagementService();
    const handlers = makeOutboundMcpLifecycleRpcHandlers(observed.service, requireTestMcpOwner);

    yield* Effect.gen(function* () {
      yield* handlers[WS_METHODS.serverListOutboundMcpConnections]({});
      yield* handlers[WS_METHODS.serverBeginOutboundMcpAuthorization]({ presetId: "paraty" });
      yield* handlers[WS_METHODS.serverDisconnectOutboundMcpConnection]({
        connectionId: "paraty",
      });
    }).pipe(Effect.provideService(CurrentWsSessionRole, "owner"));

    assert.deepStrictEqual(observed.state.calls, ["list", "begin", "disconnect"]);
    assert.isTrue(observed.state.authorizing);
    assert.isFalse(observed.state.credentialsPresent);
  }),
);

function deniedOutboundMcpBegin(config: {
  readonly host: string;
  readonly publicUrl: URL | undefined;
}) {
  return Effect.gen(function* () {
    const delegatedBegins: string[] = [];
    const endpoint = makeOutboundMcpCallbackEndpoint();
    yield* endpoint.configure({
      config,
      serverAddress: { address: "127.0.0.1", family: "IPv4", port: 58090 },
    });
    const baseService = {
      list: () => Effect.succeed([]),
      beginAuthorization: (input: { readonly presetId: string }) =>
        Effect.sync(() => {
          delegatedBegins.push(input.presetId);
          return {
            attemptId: "must-not-be-created",
            authorizationUrl: "https://auth.example.test/authorize",
          };
        }),
      disconnect: () => Effect.void,
      completeAuthorization: () => Effect.die("not used"),
      invoke: () => Effect.die("not used"),
      subscribe: () => Effect.die("not used"),
    } as never;
    const handlers = makeOutboundMcpLifecycleRpcHandlers(
      withOutboundMcpCallbackCapability(baseService, endpoint),
      Effect.void,
    );

    const error = yield* handlers[WS_METHODS.serverBeginOutboundMcpAuthorization]({
      presetId: "paraty",
    }).pipe(Effect.flip);

    assert.deepStrictEqual(delegatedBegins, []);
    assert.match(error.message, /callback-unavailable/);
    assert.notMatch(JSON.stringify(error), /0\.0\.0\.0|synara\.example\.test|58090/);
  });
}

it.effect("denies outbound MCP authorization before attempt creation on a non-loopback bind", () =>
  deniedOutboundMcpBegin({ host: "0.0.0.0", publicUrl: undefined }),
);

it.effect("denies outbound MCP authorization before attempt creation with a public URL", () =>
  deniedOutboundMcpBegin({
    host: "127.0.0.1",
    publicUrl: new URL("https://synara.example.test"),
  }),
);

it.effect("denies outbound MCP authorization until the listener endpoint is ready", () =>
  Effect.gen(function* () {
    let delegated = false;
    const endpoint = makeOutboundMcpCallbackEndpoint();
    const service = withOutboundMcpCallbackCapability(
      {
        list: () => Effect.succeed([]),
        beginAuthorization: () =>
          Effect.sync(() => {
            delegated = true;
            return {
              attemptId: "must-not-be-created",
              authorizationUrl: "https://auth.example.test/authorize",
            };
          }),
        disconnect: () => Effect.void,
        completeAuthorization: () => Effect.die("not used"),
        invoke: () => Effect.die("not used"),
        subscribe: () => Effect.die("not used"),
      } as never,
      endpoint,
    );

    const error = yield* service.beginAuthorization({ presetId: "paraty" }).pipe(Effect.flip);

    assert.isFalse(delegated);
    assert.equal(error.category, "callback-unavailable");
  }),
);

it.effect("uses the listener endpoint resolved after connection-service construction", () =>
  Effect.gen(function* () {
    const endpoint = makeOutboundMcpCallbackEndpoint();
    let observedRedirectUrl: string | null = null;
    const service = bindOutboundMcpCallbackEndpoint(
      (callbackUrl) =>
        ({
          list: () => Effect.succeed([]),
          beginAuthorization: () =>
            Effect.sync(() => {
              observedRedirectUrl = callbackUrl.href;
              return {
                attemptId: "attempt-dynamic-port",
                authorizationUrl: "https://auth.example.test/authorize",
              };
            }),
          disconnect: () => Effect.void,
          completeAuthorization: () => Effect.die("not used"),
          invoke: () => Effect.die("not used"),
          subscribe: () => Effect.die("not used"),
        }) as never,
      endpoint,
    );

    yield* endpoint.configure({
      config: { host: "127.0.0.1", publicUrl: undefined },
      serverAddress: { address: "127.0.0.1", family: "IPv4", port: 49152 },
    });
    yield* service.beginAuthorization({ presetId: "paraty" });

    assert.equal(observedRedirectUrl, "http://127.0.0.1:49152/api/mcp/outbound/oauth/callback");
  }),
);

it.effect("registers contract-shaped outbound MCP lifecycle handlers", () =>
  Effect.gen(function* () {
    const connection = {
      id: "paraty",
      presetId: "paraty",
      displayName: "Paraty MCP",
      endpoint: "https://mcp.example.test/mcp",
      status: "disconnected",
      lastValidatedAt: null,
      errorCategory: null,
    } as const;
    const calls: string[] = [];
    const service = {
      list: () => Effect.sync(() => (calls.push("list"), [connection])),
      beginAuthorization: (input) =>
        Effect.sync(() => {
          calls.push(`begin:${input.presetId}`);
          return {
            attemptId: "attempt-1",
            authorizationUrl: "https://auth.example.test/authorize",
          };
        }),
      disconnect: (input) =>
        Effect.sync(() => {
          calls.push(`disconnect:${input.connectionId}`);
        }),
      completeAuthorization: () => Effect.die("not exposed over WS"),
      invoke: () => Effect.die("not exposed over WS"),
      subscribe: () => Effect.die("not exposed over WS"),
    } satisfies McpConnectionServiceShape;
    const handlers = makeOutboundMcpLifecycleRpcHandlers(service, Effect.void);

    const list = yield* handlers[WS_METHODS.serverListOutboundMcpConnections]({});
    const begin = yield* handlers[WS_METHODS.serverBeginOutboundMcpAuthorization]({
      presetId: "paraty",
    });
    yield* handlers[WS_METHODS.serverDisconnectOutboundMcpConnection]({
      connectionId: "paraty",
    });

    assert.deepStrictEqual(list, { connections: [connection] });
    assert.deepStrictEqual(begin, {
      attemptId: "attempt-1",
      authorizationUrl: "https://auth.example.test/authorize",
    });
    assert.deepStrictEqual(calls, ["list", "begin:paraty", "disconnect:paraty"]);
    assert.deepStrictEqual(
      Object.keys(handlers).toSorted(),
      [
        WS_METHODS.serverBeginOutboundMcpAuthorization,
        WS_METHODS.serverDisconnectOutboundMcpConnection,
        WS_METHODS.serverListOutboundMcpConnections,
      ].toSorted(),
    );
  }),
);

it("reserves external MCP management for owner sessions", () => {
  assert.isTrue(canManageExternalMcp("owner"));
  assert.isFalse(canManageExternalMcp("client"));
});

it.effect("rejects an unauthorized websocket upgrade on a non-loopback bind", () =>
  Effect.gen(function* () {
    const authenticateWebSocketUpgrade = vi.fn(() =>
      Effect.fail(
        new AuthError({
          message: "Authentication required.",
          status: 401,
        }),
      ),
    );

    const error = yield* authenticateRpcWebSocketUpgrade({
      config: { host: "0.0.0.0", authToken: "remote-secret", publicUrl: undefined },
      legacyToken: null,
      request: {
        headers: {},
        cookies: {},
        url: new URL("http://192.168.1.50:3773/ws"),
      },
      serverAuth: { authenticateWebSocketUpgrade },
    }).pipe(Effect.flip);

    assert.equal(error.status, 401);
    assert.equal(authenticateWebSocketUpgrade.mock.calls.length, 1);
  }),
);

it.effect("does not accept a legacy query token on a non-loopback bind", () =>
  Effect.gen(function* () {
    const authenticateWebSocketUpgrade = vi.fn(() =>
      Effect.fail(
        new AuthError({
          message: "Authentication required.",
          status: 401,
        }),
      ),
    );

    const error = yield* authenticateRpcWebSocketUpgrade({
      config: { host: "192.168.1.50", authToken: "remote-secret", publicUrl: undefined },
      legacyToken: "remote-secret",
      request: {
        headers: {},
        cookies: {},
        url: new URL("http://192.168.1.50:3773/ws?token=remote-secret"),
      },
      serverAuth: { authenticateWebSocketUpgrade },
    }).pipe(Effect.flip);

    assert.equal(error.status, 401);
    assert.equal(authenticateWebSocketUpgrade.mock.calls.length, 1);
  }),
);

it.effect("accepts an authenticated session on a non-loopback bind", () =>
  Effect.gen(function* () {
    const authenticatedSession = {
      sessionId: "remote-session" as never,
      subject: "owner-bootstrap",
      method: "browser-session-cookie" as const,
      role: "owner" as const,
    };
    const authenticateWebSocketUpgrade = vi.fn(() => Effect.succeed(authenticatedSession));

    const session = yield* authenticateRpcWebSocketUpgrade({
      config: { host: "0.0.0.0", authToken: "remote-secret", publicUrl: undefined },
      legacyToken: "remote-secret",
      request: {
        headers: {},
        cookies: { "synara-session": "paired-session-credential" },
        url: new URL("http://192.168.1.50:3773/ws?token=remote-secret"),
      },
      serverAuth: { authenticateWebSocketUpgrade },
    });

    assert.equal(session, authenticatedSession);
    assert.equal(authenticateWebSocketUpgrade.mock.calls.length, 1);
  }),
);

it.effect("preserves the legacy query token for loopback desktop sessions", () =>
  Effect.gen(function* () {
    const authenticateWebSocketUpgrade = vi.fn(() =>
      Effect.fail(new AuthError({ message: "Unexpected authentication call.", status: 500 })),
    );

    const session = yield* authenticateRpcWebSocketUpgrade({
      config: { host: "127.0.0.1", authToken: "desktop-secret", publicUrl: undefined },
      legacyToken: "desktop-secret",
      request: {
        headers: {},
        cookies: {},
        url: new URL("http://127.0.0.1:3773/ws?token=desktop-secret"),
      },
      serverAuth: { authenticateWebSocketUpgrade },
    });

    assert.equal(session, null);
    assert.equal(authenticateWebSocketUpgrade.mock.calls.length, 0);
  }),
);

it.effect("preserves the legacy loopback token on the device frame socket", () =>
  Effect.gen(function* () {
    const authenticateWebSocketUpgrade = vi.fn(() =>
      Effect.fail(new AuthError({ message: "Unexpected authentication call.", status: 500 })),
    );

    const authorized = yield* authorizeDeviceFrameWebSocketUpgrade({
      config: { host: "127.0.0.1", authToken: "desktop-secret", publicUrl: undefined },
      legacyToken: "desktop-secret",
      request: {
        headers: {},
        cookies: {},
        url: new URL("http://127.0.0.1:3773/ws/device-frames?token=desktop-secret&udid=device-1"),
      },
      serverAuth: { authenticateWebSocketUpgrade },
    });

    assert.isTrue(authorized);
    assert.equal(authenticateWebSocketUpgrade.mock.calls.length, 0);
  }),
);

it.effect("rejects an invalid legacy token on a remotely exposed device frame socket", () =>
  Effect.gen(function* () {
    const authenticateWebSocketUpgrade = vi.fn(() =>
      Effect.fail(new AuthError({ message: "Authentication required.", status: 401 })),
    );

    const authorized = yield* authorizeDeviceFrameWebSocketUpgrade({
      config: { host: "0.0.0.0", authToken: "remote-secret", publicUrl: undefined },
      legacyToken: "wrong-secret",
      request: {
        headers: {},
        cookies: {},
        url: new URL("http://192.168.1.50:3773/ws/device-frames?token=wrong-secret&udid=device-1"),
      },
      serverAuth: { authenticateWebSocketUpgrade },
    });

    assert.isFalse(authorized);
    assert.equal(authenticateWebSocketUpgrade.mock.calls.length, 1);
  }),
);

it.effect(
  "disables the legacy loopback query token when an HTTPS public origin is configured",
  () =>
    Effect.gen(function* () {
      const authenticatedSession = {
        sessionId: "proxy-session" as never,
        subject: "owner-bootstrap",
        method: "browser-session-cookie" as const,
        role: "owner" as const,
      };
      const authenticateWebSocketUpgrade = vi.fn(() => Effect.succeed(authenticatedSession));

      const session = yield* authenticateRpcWebSocketUpgrade({
        config: {
          host: "127.0.0.1",
          authToken: "proxy-secret",
          publicUrl: new URL("https://synara.example.test/"),
        },
        legacyToken: "proxy-secret",
        request: {
          headers: {},
          cookies: { "synara-session": "paired-session-credential" },
          url: new URL("http://127.0.0.1:3773/ws?token=proxy-secret"),
        },
        serverAuth: { authenticateWebSocketUpgrade },
      });

      assert.equal(session, authenticatedSession);
      assert.equal(authenticateWebSocketUpgrade.mock.calls.length, 1);
    }),
);

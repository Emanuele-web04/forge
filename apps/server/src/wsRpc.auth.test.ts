import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";

import { AuthError } from "./auth/Services/ServerAuth";
import {
  authenticateRpcWebSocketUpgrade,
  authorizeDeviceFrameWebSocketUpgrade,
  canAccessProviderProfiles,
  canManageExternalMcp,
  toProviderProfileWsRpcError,
} from "./wsRpc";
import { ProviderProfileRegistryError } from "./provider/Services/ProviderProfileRegistry";
import { CodexAccountControlError } from "./provider/Services/CodexAccountControl";

it("reserves external MCP management for owner sessions", () => {
  assert.isTrue(canManageExternalMcp("owner"));
  assert.isFalse(canManageExternalMcp("client"));
});

it("allows clients to list provider profiles but reserves account data and mutations for owners", () => {
  assert.isTrue(canAccessProviderProfiles("client", "list"));
  for (const operation of [
    "readAccount",
    "create",
    "rename",
    "setEnabled",
    "tombstone",
    "startLogin",
    "cancelLogin",
    "logout",
  ] as const) {
    assert.isTrue(canAccessProviderProfiles("owner", operation));
    assert.isFalse(canAccessProviderProfiles("client", operation));
  }
});

it("redacts account-control causes while preserving safe retry metadata", () => {
  const secretUrl = "https://auth.example.test/start?token=secret";
  const rpcError = toProviderProfileWsRpcError(
    new CodexAccountControlError({
      code: "PROVIDER_ACCOUNT_CONTROL_FAILED",
      message: "The Codex account operation failed.",
      retryable: true,
      cause: new Error(secretUrl),
    }),
  );

  assert.equal(rpcError.code, "PROVIDER_ACCOUNT_CONTROL_FAILED");
  assert.isTrue(rpcError.retryable);
  assert.equal(rpcError.cause, undefined);
  assert.isFalse(JSON.stringify(rpcError).includes(secretUrl));
});

it("redacts registry error causes before they cross RPC", () => {
  const privatePath = "/private/state/provider-profiles/index.json";
  const rpcError = toProviderProfileWsRpcError(
    new ProviderProfileRegistryError({
      code: "PROVIDER_PROFILE_STORAGE_ERROR",
      message: "Could not save the Codex provider profile registry.",
      cause: new Error(`EACCES: ${privatePath}`),
    }),
  );

  assert.equal(rpcError.code, "PROVIDER_PROFILE_STORAGE_ERROR");
  assert.equal(rpcError.cause, undefined);
  assert.isFalse(JSON.stringify(rpcError).includes(privatePath));
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

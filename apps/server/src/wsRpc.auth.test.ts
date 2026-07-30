import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";

import { AuthError } from "./auth/Services/ServerAuth";
import type { AuthenticatedDeployment } from "./remoteAccessPolicy";
import { authenticateRpcWebSocketUpgrade } from "./wsRpc";

const failingUpgrade = () =>
  vi.fn(() =>
    Effect.fail(
      new AuthError({
        message: "Authentication required.",
        status: 401,
      }),
    ),
  );

const remoteDeployments: ReadonlyArray<readonly [string, AuthenticatedDeployment]> = [
  [
    "a wildcard bind with a token",
    {
      host: "0.0.0.0",
      authToken: "remote-secret",
      publicUrl: undefined,
      allowInsecureRemote: false,
    },
  ],
  [
    "a wildcard bind with NO token",
    { host: "0.0.0.0", authToken: undefined, publicUrl: undefined, allowInsecureRemote: false },
  ],
  [
    "a LAN bind with NO token",
    {
      host: "192.168.1.50",
      authToken: undefined,
      publicUrl: undefined,
      allowInsecureRemote: false,
    },
  ],
  [
    "a published loopback bind with NO token",
    {
      host: "127.0.0.1",
      authToken: undefined,
      publicUrl: new URL("https://synara.example.test/"),
      allowInsecureRemote: false,
    },
  ],
  [
    "an insecure-remote loopback bind with NO token",
    { host: "127.0.0.1", authToken: undefined, publicUrl: undefined, allowInsecureRemote: true },
  ],
  // SYNARA_HOST="" binds 0.0.0.0. This upgrade must never hand out the
  // implicit owner session for it.
  [
    "a blank host (binds 0.0.0.0) with NO token",
    { host: "", authToken: undefined, publicUrl: undefined, allowInsecureRemote: false },
  ],
  [
    "a whitespace-only host with NO token",
    { host: "   ", authToken: undefined, publicUrl: undefined, allowInsecureRemote: false },
  ],
];

// Auth enforcement must follow the deployment's reachability, never the
// presence of an auth token: dropping the token from any remote-reachable
// config must still demand a real session credential.
for (const [label, config] of remoteDeployments) {
  it.effect(`requires an authenticated session on ${label}`, () =>
    Effect.gen(function* () {
      const authenticateWebSocketUpgrade = failingUpgrade();

      const error = yield* authenticateRpcWebSocketUpgrade({
        config,
        legacyToken: config.authToken ?? null,
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
}

it.effect("does not accept a legacy query token on a non-loopback bind", () =>
  Effect.gen(function* () {
    const authenticateWebSocketUpgrade = failingUpgrade();

    const error = yield* authenticateRpcWebSocketUpgrade({
      config: {
        host: "192.168.1.50",
        authToken: "remote-secret",
        publicUrl: undefined,
        allowInsecureRemote: false,
      },
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
      config: {
        host: "0.0.0.0",
        authToken: "remote-secret",
        publicUrl: undefined,
        allowInsecureRemote: false,
      },
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
      config: {
        host: "127.0.0.1",
        authToken: "desktop-secret",
        publicUrl: undefined,
        allowInsecureRemote: false,
      },
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

it.effect("keeps a loopback bind with no configured token on the implicit-owner path", () =>
  Effect.gen(function* () {
    const authenticateWebSocketUpgrade = failingUpgrade();

    const session = yield* authenticateRpcWebSocketUpgrade({
      config: {
        host: "127.0.0.1",
        authToken: undefined,
        publicUrl: undefined,
        allowInsecureRemote: false,
      },
      legacyToken: null,
      request: {
        headers: {},
        cookies: {},
        url: new URL("http://127.0.0.1:3773/ws"),
      },
      serverAuth: { authenticateWebSocketUpgrade },
    });

    assert.equal(session, null);
    assert.equal(authenticateWebSocketUpgrade.mock.calls.length, 0);
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
          allowInsecureRemote: false,
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

// Second assertions for predicates that were otherwise pinned by exactly one
// test each. A single test edit should not be able to silently unpin the
// implicit-owner path or the legacy query-token gate.
it.effect("refuses the implicit-owner path when the legacy token does not match", () =>
  Effect.gen(function* () {
    const authenticateWebSocketUpgrade = failingUpgrade();

    const error = yield* authenticateRpcWebSocketUpgrade({
      config: {
        host: "127.0.0.1",
        authToken: "desktop-secret",
        publicUrl: undefined,
        allowInsecureRemote: false,
      },
      legacyToken: "wrong-secret",
      request: {
        headers: {},
        cookies: {},
        url: new URL("http://127.0.0.1:3773/ws"),
      },
      serverAuth: { authenticateWebSocketUpgrade },
    }).pipe(Effect.flip);

    assert.equal(error.status, 401);
    assert.equal(authenticateWebSocketUpgrade.mock.calls.length, 1);
  }),
);

it.effect("refuses the implicit-owner path when a configured token is not presented", () =>
  Effect.gen(function* () {
    const authenticateWebSocketUpgrade = failingUpgrade();

    const error = yield* authenticateRpcWebSocketUpgrade({
      config: {
        host: "127.0.0.1",
        authToken: "desktop-secret",
        publicUrl: undefined,
        allowInsecureRemote: false,
      },
      legacyToken: null,
      request: {
        headers: {},
        cookies: {},
        url: new URL("http://127.0.0.1:3773/ws"),
      },
      serverAuth: { authenticateWebSocketUpgrade },
    }).pipe(Effect.flip);

    assert.equal(error.status, 401);
    assert.equal(authenticateWebSocketUpgrade.mock.calls.length, 1);
  }),
);

// The proxy attaches the environment's provisioned credential to everything it
// forwards, so this gate is the only thing standing between an unauthenticated
// local caller and a fully authenticated remote one. Every case here is a
// security assertion.

import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { AuthError, type ServerAuthShape } from "./auth/Services/ServerAuth";
import type { ServerConfigShape } from "./config";
import {
  makeEnvironmentProxyAuthorizer,
  parseCookieHeader,
  requestOriginOf,
} from "./environmentProxyAuthorization";

const LOCAL_ONLY = {
  host: "127.0.0.1",
  publicUrl: undefined,
  allowInsecureRemote: false,
  authToken: undefined,
} as unknown as ServerConfigShape;

const REMOTE_REACHABLE = {
  host: "0.0.0.0",
  publicUrl: undefined,
  allowInsecureRemote: false,
  authToken: "operator-token",
} as unknown as ServerConfigShape;

const session = { sessionId: "s1", subject: "owner", method: "browser-session-cookie" };

function authorizerWith(input: {
  readonly config: ServerConfigShape;
  readonly authenticates: boolean;
}) {
  const authenticateHttpRequest = vi.fn(() =>
    input.authenticates
      ? Effect.succeed(session)
      : Effect.fail(new AuthError({ message: "Authentication required.", status: 401 })),
  ) as unknown as ServerAuthShape["authenticateHttpRequest"];
  const authenticateWebSocketUpgrade = vi.fn(() =>
    input.authenticates
      ? Effect.succeed(session)
      : Effect.fail(new AuthError({ message: "Authentication required.", status: 401 })),
  ) as unknown as ServerAuthShape["authenticateWebSocketUpgrade"];
  const serverAuth = { authenticateHttpRequest, authenticateWebSocketUpgrade };
  return {
    serverAuth,
    authorize: makeEnvironmentProxyAuthorizer({
      config: input.config,
      serverAuth,
      runAuth: (effect) => Effect.runPromise(effect as Effect.Effect<unknown, unknown>),
    }),
  };
}

const proxiedRequest = (headers: Record<string, string> = {}) => ({
  url: "/env/host-a/api/threads",
  headers: { host: "127.0.0.1:3773", ...headers },
});

describe("environment proxy authorization", () => {
  it("denies a remote-reachable deployment with no credential at all", async () => {
    const { authorize } = authorizerWith({ config: REMOTE_REACHABLE, authenticates: false });
    expect(await authorize({ request: proxiedRequest(), kind: "http" })).toEqual({
      allowed: false,
      status: 401,
      message: "Unauthorized",
    });
  });

  it("allows a remote-reachable deployment once the session authenticates", async () => {
    const { authorize } = authorizerWith({ config: REMOTE_REACHABLE, authenticates: true });
    expect(await authorize({ request: proxiedRequest(), kind: "http" })).toEqual({ allowed: true });
  });

  it("uses the WebSocket authenticator on an upgrade and the HTTP one otherwise", async () => {
    // They are not interchangeable: the upgrade path also accepts a one-shot
    // `?token=` WebSocket ticket that the HTTP path must never honour.
    const { authorize, serverAuth } = authorizerWith({
      config: REMOTE_REACHABLE,
      authenticates: true,
    });
    await authorize({ request: proxiedRequest(), kind: "upgrade" });
    expect(serverAuth.authenticateWebSocketUpgrade).toHaveBeenCalledTimes(1);
    expect(serverAuth.authenticateHttpRequest).not.toHaveBeenCalled();

    await authorize({ request: proxiedRequest(), kind: "http" });
    expect(serverAuth.authenticateHttpRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps the implicit-owner path only for a local-only deployment", async () => {
    // Same predicate the RPC WebSocket upgrade uses. A local-only deployment
    // has no session to present, so demanding one here would break every
    // desktop install; a remote-reachable one always needs a real session.
    const local = authorizerWith({ config: LOCAL_ONLY, authenticates: false });
    expect(await local.authorize({ request: proxiedRequest(), kind: "http" })).toEqual({
      allowed: true,
    });
    expect(local.serverAuth.authenticateHttpRequest).not.toHaveBeenCalled();

    const remote = authorizerWith({ config: REMOTE_REACHABLE, authenticates: false });
    expect(
      (await remote.authorize({ request: proxiedRequest(), kind: "http" })).allowed,
      "a remote-reachable deployment must never take the implicit-owner path",
    ).toBe(false);
  });

  it("rejects an untrusted Origin even when the session would authenticate", async () => {
    // A credential-attaching endpoint reachable from any web page is CSRF by
    // construction, and this proxy is the most powerful one the server has. The
    // browser attaches its ambient cookie whether or not the page is ours.
    const { authorize, serverAuth } = authorizerWith({
      config: REMOTE_REACHABLE,
      authenticates: true,
    });
    const decision = await authorize({
      request: proxiedRequest({ origin: "https://evil.example" }),
      kind: "http",
    });
    expect(decision).toEqual({
      allowed: false,
      status: 403,
      message: "Trusted request origin required.",
    });
    // ...and it refused BEFORE authenticating, so a cross-site request cannot
    // even use the timing of a session lookup.
    expect(serverAuth.authenticateHttpRequest).not.toHaveBeenCalled();
  });

  it("rejects an untrusted Origin on a LOCAL-only deployment too", async () => {
    // Local-only skips the session, not the CSRF check: a page in the user's
    // browser can reach loopback, and the implicit owner is the most privileged
    // session there is.
    const { authorize } = authorizerWith({ config: LOCAL_ONLY, authenticates: false });
    const decision = await authorize({
      request: proxiedRequest({ origin: "https://evil.example" }),
      kind: "http",
    });
    expect(decision.allowed).toBe(false);
  });

  it("denies a request with no Host header rather than guessing an origin", async () => {
    const { authorize } = authorizerWith({ config: REMOTE_REACHABLE, authenticates: true });
    const decision = await authorize({
      request: { url: "/env/host-a/api", headers: {} },
      kind: "http",
    });
    expect(decision).toEqual({ allowed: false, status: 400, message: "Bad Request" });
  });

  it("does not let a client-supplied x-forwarded-proto decide the origin scheme", async () => {
    // The scheme comes from the deployment's own configuration. Taking it from
    // a header would let a caller manufacture an origin that compares equal.
    const url = requestOriginOf({
      requestTarget: "/env/a",
      host: "synara.example:443",
      config: { publicUrl: undefined },
    });
    expect(url?.protocol).toBe("http:");
    const published = requestOriginOf({
      requestTarget: "/env/a",
      host: "synara.example",
      config: { publicUrl: new URL("https://synara.example/") },
    });
    expect(published?.protocol).toBe("https:");
  });
});

describe("parseCookieHeader", () => {
  it("splits a jar into names and values without decoding either", () => {
    expect(parseCookieHeader("a=1; b=two; c=with=equals")).toEqual({
      a: "1",
      b: "two",
      c: "with=equals",
    });
  });

  it("ignores malformed entries rather than inventing a name", () => {
    // A nameless or valueless fragment must not become a cookie called "" that
    // a lookup could accidentally match.
    expect(parseCookieHeader("=novalue; ; justname; a=1")).toEqual({ a: "1" });
    expect(parseCookieHeader(undefined)).toEqual({});
  });
});

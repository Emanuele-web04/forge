// FILE: wsNativeApi.authBuildIdentity.test.ts
// Purpose: Prove the REAL auth client methods declare their build, so the
//          server's skew guard can classify them.
// Layer: Web transport tests
//
// WHY THIS FILE EXISTS
//
// The server deliberately treats a request with NO declared build as
// non-skewed: HTTP has no negotiation, and pre-guard clients must not be locked
// out of the recovery routes. That leniency is only sound if OUR client always
// declares — and it did not. The voice upload route stamped the build; the auth
// routes did not, so every revoke arrived unstamped and a stale read-only
// client passed straight through a guard that was itself correct.
//
// The server-side allowlist was right and irrelevant, because its
// classification INPUT was missing. Every server-side skew test supplies
// `clientBuild` by hand, so the client half was never exercised end to end:
// this is a contract with two sides and only one of them was enforced.
//
// These tests drive the actual client methods and inspect the URL that reaches
// `fetch`, which is the only place the two halves meet.

import { WS_COMPATIBILITY_QUERY } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWsEnvironmentClient } from "./wsNativeApi";

const fetchMock = vi.fn(async (..._args: readonly unknown[]) =>
  Response.json({ revoked: true }, { status: 200 }),
);

function requestedUrls(): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

describe("auth requests declare the client build", () => {
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    // Unit tests run in node; the transport reaches for `window` on construction.
    // `setTimeout`/`clearTimeout` included deliberately: the transport's retry
    // path calls `window.setTimeout`, and a stub without it throws into an
    // unhandled rejection rather than failing a test.
    vi.stubGlobal("window", {
      location: { origin: "http://localhost" },
      setTimeout: () => 0,
      clearTimeout: () => undefined,
    });
    // The client opens a real socket on construction. Left alone it produces
    // unhandled rejections that make vitest exit 1 while printing a GREEN
    // "Tests 3 passed" line — the exact trap where reading the summary rather
    // than the exit code records a pass. These tests exercise the HTTP auth
    // path only, so the socket is stubbed inert rather than tolerated.
    vi.stubGlobal(
      "WebSocket",
      class {
        static readonly CONNECTING = 0;
        readonly readyState = 0;
        addEventListener(): void {}
        removeEventListener(): void {}
        close(): void {}
        send(): void {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stamps the build on every DESTRUCTIVE auth route", async () => {
    // These are the three the server guards. Without a declared build the
    // guard classifies them as non-skewed and lets them through — revoking
    // every other device from a client the server has declared read-only.
    const client = createWsEnvironmentClient();
    await client.api.server.revokeAuthClient({ sessionId: "session-1" } as never);
    await client.api.server.revokeOtherAuthClients();
    await client.api.server.revokeAuthPairingLink({ id: "pairing-1" } as never);

    expect(requestedUrls()).toHaveLength(3);
    for (const url of requestedUrls()) {
      expect(url, `${url} carried no client build`).toContain(
        `${WS_COMPATIBILITY_QUERY.clientBuild}=`,
      );
    }
  });

  it("stamps the build on the RECOVERY routes too", async () => {
    // Recovery routes stay reachable while skewed — that is the server's
    // design and this does not change it. But they must still tell the truth:
    // the server decides what to allow, and it can only do that from a
    // complete input. Declaring is the client's job either way.
    const client = createWsEnvironmentClient();
    await client.api.server.getAuthSession();
    await client.api.server.listAuthPairingLinks();

    expect(requestedUrls()).toHaveLength(2);
    for (const url of requestedUrls()) {
      expect(url).toContain(`${WS_COMPATIBILITY_QUERY.clientBuild}=`);
    }
  });

  it("keeps the route path intact while stamping", () => {
    // Guards the obvious way to break this: a stamp that mangles the path
    // would send every auth call to a 404 and the tests above would still see
    // a clientBuild parameter.
    const client = createWsEnvironmentClient();
    void client.api.server.revokeOtherAuthClients();

    const url = requestedUrls()[0] ?? "";
    expect(url).toContain("/api/auth/clients/revoke-others");
  });
});

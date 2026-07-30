import { describe, expect, it } from "vitest";

import { resolveBindHost } from "./startupAccess";
import {
  isLocalOnlyDeployment,
  isRemoteReachableDeployment,
  normalizeHttpsPublicOrigin,
  remoteAccessPolicyError,
  requiresSessionAuthentication,
} from "./remoteAccessPolicy";

const remoteBase = {
  host: "0.0.0.0",
  authToken: "remote-secret",
  devUrl: undefined,
  publicUrl: undefined,
  allowInsecureRemote: false,
} as const;

const loopbackBase = {
  ...remoteBase,
  host: "127.0.0.1",
  authToken: undefined,
} as const;

describe("remote reachability", () => {
  it.each([
    ["a wildcard IPv4 bind", { host: "0.0.0.0" }],
    ["a wildcard IPv6 bind", { host: "::" }],
    ["a bracketed wildcard IPv6 bind", { host: "[::]" }],
    ["a LAN bind", { host: "192.168.1.50" }],
    ["a published loopback bind", { publicUrl: new URL("https://synara.example.test/") }],
    ["an explicit insecure-remote opt-in", { allowInsecureRemote: true }],
  ])("treats %s as remote-reachable", (_label, overrides) => {
    const config = { ...loopbackBase, ...overrides };
    expect(isRemoteReachableDeployment(config)).toBe(true);
    expect(isLocalOnlyDeployment(config)).toBe(false);
  });

  it.each(["127.0.0.1", "localhost", "::1", "[::1]", undefined])(
    "treats loopback host %s with no public URL as local-only",
    (host) => {
      const config = { ...loopbackBase, host };
      expect(isRemoteReachableDeployment(config)).toBe(false);
      expect(isLocalOnlyDeployment(config)).toBe(true);
    },
  );
});

// Regression: SYNARA_HOST="" survives `??` (only null/undefined fall through)
// and Node binds it as 0.0.0.0. If it were classified as loopback, startup
// would succeed and a remote client would receive the implicit owner session.
describe("blank host closes the unauthenticated public bind", () => {
  it.each(["", " ", "\t"])("treats host %j as remote-reachable", (host) => {
    const config = { ...loopbackBase, host };
    expect(isRemoteReachableDeployment(config)).toBe(true);
    expect(isLocalOnlyDeployment(config)).toBe(false);
  });

  it.each(["", " ", "\t"])("requires session auth for host %j with no token", (host) => {
    expect(requiresSessionAuthentication({ ...loopbackBase, host })).toBe(true);
  });

  it.each(["", " ", "\t"])("refuses to start on host %j without a credential", (host) => {
    expect(remoteAccessPolicyError({ ...remoteBase, host, authToken: undefined })).toContain(
      "Refusing",
    );
  });
});

describe("session authentication policy", () => {
  // The security property this module exists for: enforcement follows the
  // deployment's reachability, never the presence of an auth token. Removing
  // the token from a remote-reachable config must not relax anything.
  it.each([
    ["a wildcard bind", { host: "0.0.0.0" }],
    ["a LAN bind", { host: "192.168.1.50" }],
    ["a published loopback bind", { publicUrl: new URL("https://synara.example.test/") }],
    ["an explicit insecure-remote opt-in", { allowInsecureRemote: true }],
  ])("requires session auth for %s even with no auth token", (_label, overrides) => {
    expect(
      requiresSessionAuthentication({ ...loopbackBase, ...overrides, authToken: undefined }),
    ).toBe(true);
  });

  it("keeps implicit-owner behavior only for a loopback bind with no token", () => {
    expect(requiresSessionAuthentication(loopbackBase)).toBe(false);
  });

  it("still enforces auth on a loopback bind when a token is configured", () => {
    expect(requiresSessionAuthentication({ ...loopbackBase, authToken: "desktop-secret" })).toBe(
      true,
    );
  });
});

describe("remote access startup policy", () => {
  it("fails closed for authenticated plaintext remote binds", () => {
    expect(remoteAccessPolicyError(remoteBase)).toContain("Refusing plaintext remote access");
  });

  it("allows an HTTPS reverse-proxy origin or explicit insecure LAN opt-in", () => {
    expect(
      remoteAccessPolicyError({
        ...remoteBase,
        publicUrl: new URL("https://synara.example.test/"),
      }),
    ).toBeNull();
    expect(remoteAccessPolicyError({ ...remoteBase, allowInsecureRemote: true })).toBeNull();
  });

  // Refuse to serve rather than boot an open socket: every remote-reachable
  // shape without a configured credential path must fail startup.
  it.each([
    ["a wildcard bind", { host: "0.0.0.0" }, "non-loopback host"],
    ["a LAN bind", { host: "192.168.1.50" }, "non-loopback host"],
    [
      "a published loopback bind",
      { host: "127.0.0.1", publicUrl: new URL("https://synara.example.test/") },
      "SYNARA_PUBLIC_URL",
    ],
    [
      "an insecure-remote loopback bind",
      { host: "127.0.0.1", allowInsecureRemote: true },
      "SYNARA_ALLOW_INSECURE_REMOTE",
    ],
  ])("refuses to serve %s without a credential", (_label, overrides, expected) => {
    const error = remoteAccessPolicyError({ ...remoteBase, ...overrides, authToken: undefined });
    expect(error).toContain("Refusing");
    expect(error).toContain(expected);
    expect(error).toContain("one-time pairing link");
  });

  it("rejects a whitespace-only auth token on a remote bind", () => {
    expect(remoteAccessPolicyError({ ...remoteBase, authToken: "   " })).toContain("Refusing");
  });

  it("allows a loopback bind with no credentials at all", () => {
    expect(remoteAccessPolicyError(loopbackBase)).toBeNull();
  });

  it("rejects invalid public URLs in the shared embedded-server policy", () => {
    for (const publicUrl of [
      new URL("http://synara.example.test/"),
      new URL("https://synara.example.test/app"),
    ]) {
      expect(
        remoteAccessPolicyError({
          ...remoteBase,
          host: "127.0.0.1",
          publicUrl,
        }),
      ).toContain("must be an HTTPS root origin");
    }
  });

  it("rejects a dev URL whenever a public proxy origin exposes the loopback bind", () => {
    expect(
      remoteAccessPolicyError({
        ...remoteBase,
        host: "127.0.0.1",
        devUrl: new URL("http://localhost:5173/"),
        publicUrl: new URL("https://synara.example.test/"),
      }),
    ).toContain("cannot be combined with VITE_DEV_SERVER_URL");
  });

  it("accepts only credential-free HTTPS root origins", () => {
    expect(normalizeHttpsPublicOrigin(new URL("https://synara.example.test/"))?.origin).toBe(
      "https://synara.example.test",
    );
    for (const value of [
      "http://synara.example.test/",
      "https://user:pass@synara.example.test/",
      "https://synara.example.test/app",
      "https://synara.example.test/?query=1",
      "https://synara.example.test/#fragment",
    ]) {
      expect(normalizeHttpsPublicOrigin(new URL(value))).toBeNull();
    }
  });
});

/**
 * Cross-module invariant. The critical auth bypass existed because host
 * resolution and policy classification lived in separate modules and
 * disagreed: `isLoopbackHost("")` said loopback while the listener bound
 * 0.0.0.0. Neither module's own tests could see that. This asserts the two
 * agree for every host we might bind — the address actually bound must be
 * loopback if and only if the policy treated the deployment as local-only.
 */
describe("bind host and policy classification agree", () => {
  const LOOPBACK_BIND_ADDRESSES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

  const hostVectors = [
    undefined,
    "",
    " ",
    "\t",
    "  \n ",
    "127.0.0.1",
    " 127.0.0.1 ",
    "localhost",
    "::1",
    "[::1]",
    "0.0.0.0",
    " 0.0.0.0 ",
    "::",
    "[::]",
    "192.168.1.50",
    "10.0.0.7",
    "127.0.0.2",
    "::ffff:127.0.0.1",
    "2130706433",
    "0177.0.0.1",
    "localhost.evil.com",
  ] as const;

  it.each(hostVectors)("binds host %j consistently with how policy classified it", (host) => {
    const boundAddress = resolveBindHost(host);
    const config = { ...loopbackBase, host };

    const bindsLoopbackOnly = LOOPBACK_BIND_ADDRESSES.has(boundAddress);
    const policySaysLocalOnly = isLocalOnlyDeployment(config);

    expect(
      policySaysLocalOnly,
      `host ${JSON.stringify(host)} binds ${boundAddress} but policy said localOnly=${policySaysLocalOnly}`,
    ).toBe(bindsLoopbackOnly);

    // The consequence that matters: anything not bound to a loopback address
    // must demand a session credential, with no auth token configured.
    if (!bindsLoopbackOnly) {
      expect(requiresSessionAuthentication(config)).toBe(true);
      expect(remoteAccessPolicyError({ ...remoteBase, host, authToken: undefined })).toContain(
        "Refusing",
      );
    }
  });
});

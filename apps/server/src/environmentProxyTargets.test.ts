import { EnvironmentId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  assertLoopbackUpstream,
  EnvironmentProxyTargetError,
  makeEnvironmentProxyRegistry,
  resolveEnvironmentProxyUpstream,
  type EnvironmentProxyUpstream,
} from "./environmentProxyTargets";

const upstream = (id: string, overrides: Partial<EnvironmentProxyUpstream> = {}) => ({
  environmentId: EnvironmentId.makeUnsafe(id),
  host: "127.0.0.1",
  port: 41_000,
  credential: `credential-for-${id}`,
  ...overrides,
});

describe("environment proxy upstream registry", () => {
  it("refuses to register a non-loopback upstream", () => {
    // The proxy only ever forwards to the near end of a tunnel WE hold open.
    // A registry entry pointing at an arbitrary host would make the local
    // server an open relay for anyone who can reach the local UI (SSRF).
    for (const host of [
      "10.0.0.5",
      "attacker.example",
      "169.254.169.254",
      "0.0.0.0",
      "192.168.1.10",
      "",
    ]) {
      expect(() => makeEnvironmentProxyRegistry().register(upstream("e1", { host })), host).toThrow(
        EnvironmentProxyTargetError,
      );
    }
  });

  it("accepts the loopback spellings a held tunnel actually uses", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]"]) {
      expect(() => assertLoopbackUpstream(host, 41_000), host).not.toThrow();
    }
  });

  it("refuses a port that is not a real TCP port", () => {
    for (const port of [0, -1, 65_536, 1.5, Number.NaN]) {
      expect(() => assertLoopbackUpstream("127.0.0.1", port), String(port)).toThrow(
        EnvironmentProxyTargetError,
      );
    }
  });
});

describe("resolveEnvironmentProxyUpstream", () => {
  it("resolves a registered environment and strips its path prefix", () => {
    const registry = makeEnvironmentProxyRegistry();
    registry.register(upstream("host-a"));
    const resolved = resolveEnvironmentProxyUpstream({
      registry,
      requestTarget: "/env/host-a/threads/t9?after=3",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.upstream.port).toBe(41_000);
    expect(resolved.target).toBe("/threads/t9?after=3");
  });

  it("denies by default: an unregistered environment resolves to nothing", () => {
    // The path segment SELECTS a registry entry; it can never describe one.
    // This is what makes "an environmentId in the path cannot address an
    // unintended target" structural rather than a validation someone must
    // remember to run.
    const registry = makeEnvironmentProxyRegistry();
    registry.register(upstream("host-a"));
    for (const target of [
      "/env/host-b/threads",
      "/env/HOST-A/threads",
      "/env/host-a2/threads",
      "/env/unknown",
    ]) {
      const resolved = resolveEnvironmentProxyUpstream({ registry, requestTarget: target });
      expect(resolved.ok, target).toBe(false);
    }
  });

  it("matches the environment id exactly, never by prefix or case", () => {
    const registry = makeEnvironmentProxyRegistry();
    registry.register(upstream("prod"));
    registry.register(upstream("prod-staging", { port: 41_001 }));
    const resolved = resolveEnvironmentProxyUpstream({
      registry,
      requestTarget: "/env/prod-staging/x",
    });
    expect(resolved.ok && resolved.upstream.port).toBe(41_001);
  });

  it("cannot be reached through a traversal or encoded-separator spelling", () => {
    // Both registered, so a traversal that "worked" would land on a real
    // upstream rather than merely 404ing — which is why these are asserted
    // against a populated registry.
    const registry = makeEnvironmentProxyRegistry();
    registry.register(upstream("a"));
    registry.register(upstream("b", { port: 41_002 }));
    for (const target of [
      "/env/../b/x",
      "/env/a/../../b/x",
      "/env/a/..%2fb",
      "/env/%2e%2e/b",
      "/env//b/x",
    ]) {
      const resolved = resolveEnvironmentProxyUpstream({ registry, requestTarget: target });
      expect(resolved.ok, target).toBe(false);
    }
  });

  it("reports a malformed path and an unknown environment distinguishably for logs only", () => {
    const registry = makeEnvironmentProxyRegistry();
    const bad = resolveEnvironmentProxyUpstream({ registry, requestTarget: "/env/../x" });
    const unknown = resolveEnvironmentProxyUpstream({ registry, requestTarget: "/env/nope/x" });
    expect(bad.ok || unknown.ok).toBe(false);
    if (bad.ok || unknown.ok) return;
    expect(bad.reason).toBe("bad-request");
    expect(unknown.reason).toBe("unknown-environment");
  });

  it("stops resolving an environment once it is unregistered", () => {
    // Tunnel torn down for good: the upstream must become unreachable
    // immediately, not on the next restart.
    const registry = makeEnvironmentProxyRegistry();
    registry.register(upstream("gone"));
    expect(resolveEnvironmentProxyUpstream({ registry, requestTarget: "/env/gone/x" }).ok).toBe(
      true,
    );
    registry.unregister(EnvironmentId.makeUnsafe("gone"));
    expect(resolveEnvironmentProxyUpstream({ registry, requestTarget: "/env/gone/x" }).ok).toBe(
      false,
    );
  });
});

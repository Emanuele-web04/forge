import { parseEnvironmentProxyTarget } from "@synara/shared/environmentProxyPath";
import { describe, expect, it } from "vitest";

import { resolveEnvironmentHttpUrl, relativePathFallback } from "./wsHttpUrl";
import { withWsPathPrefix, wsUrlPathPrefix } from "./wsUrlPathPrefix";

/**
 * A remote environment reached through the single-origin proxy shares the
 * local server's protocol AND host. The path prefix is the entire difference,
 * so every test here asserts against the PROXY PARSER rather than a string:
 * the question is not "does the URL look right" but "does the proxy route it to
 * the environment we meant", and only the parser answers that.
 *
 * The shape these cover — same origin, path-prefixed — is the one the feature
 * actually produces, and was the one shape no existing fixture used: the remote
 * fixtures were all distinct origins (`wss://b.example/`), which need no prefix
 * and so exercised a state the product cannot reach.
 */
const ENVIRONMENT_ID = "8c51b4b7-c11d-4d16-a9c5-4bd9e3cb12db";
const PROXIED_WS_URL = `ws://local.test/env/${ENVIRONMENT_ID}/ws`;

function proxyTargetOf(url: string) {
  const parsed = new URL(url);
  return parseEnvironmentProxyTarget(`${parsed.pathname}${parsed.search}`);
}

describe("wsUrlPathPrefix", () => {
  it("returns the mount prefix of a proxied environment socket", () => {
    expect(wsUrlPathPrefix(new URL(PROXIED_WS_URL))).toBe(`/env/${ENVIRONMENT_ID}`);
  });

  it("strips each socket path the transport may have appended", () => {
    for (const suffix of ["/ws", "/ws/bootstrap", "/ws/negotiate"]) {
      expect(wsUrlPathPrefix(new URL(`ws://local.test/env/e1${suffix}`))).toBe("/env/e1");
    }
  });

  it("returns the empty string for a root-mounted server", () => {
    expect(wsUrlPathPrefix(new URL("ws://127.0.0.1:3773/"))).toBe("");
    expect(wsUrlPathPrefix(new URL("ws://127.0.0.1:3773/ws"))).toBe("");
    expect(wsUrlPathPrefix(new URL("wss://remote.example/?token=t"))).toBe("");
  });
});

describe("withWsPathPrefix", () => {
  it("is identity under an empty prefix", () => {
    expect(withWsPathPrefix("", "/api/auth/session")).toBe("/api/auth/session");
  });

  it("mounts the path under the prefix", () => {
    expect(withWsPathPrefix("/env/e1", "/api/auth/session")).toBe("/env/e1/api/auth/session");
  });
});

describe("resolveEnvironmentHttpUrl path prefix", () => {
  it("addresses the proxied environment, not the local server", () => {
    const url = resolveEnvironmentHttpUrl(
      PROXIED_WS_URL,
      "/api/auth/session",
      relativePathFallback,
    );
    expect(url).toBe(`http://local.test/env/${ENVIRONMENT_ID}/api/auth/session`);

    const target = proxyTargetOf(url);
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    expect(target.environmentId).toBe(ENVIRONMENT_ID);
    expect(target.upstreamTarget).toBe("/api/auth/session");
  });

  it("keeps the query string on the far side of the prefix", () => {
    const url = resolveEnvironmentHttpUrl(
      PROXIED_WS_URL,
      "/api/voice/transcribe?provider=codex&clientBuild=1.2.3",
      relativePathFallback,
    );
    const target = proxyTargetOf(url);
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    expect(target.environmentId).toBe(ENVIRONMENT_ID);
    expect(target.upstreamTarget).toBe("/api/voice/transcribe?provider=codex&clientBuild=1.2.3");
  });

  it("leaves the local environment on a bare path", () => {
    expect(resolveEnvironmentHttpUrl(null, "/api/auth/session", relativePathFallback)).toBe(
      "/api/auth/session",
    );
  });

  it("leaves a root-mounted remote unprefixed, so the proxy never claims it", () => {
    const url = resolveEnvironmentHttpUrl(
      "wss://b.example/",
      "/api/auth/session",
      relativePathFallback,
    );
    expect(url).toBe("https://b.example/api/auth/session");
    expect(proxyTargetOf(url)).toEqual({ ok: false, reason: "not-proxy-path" });
  });
});

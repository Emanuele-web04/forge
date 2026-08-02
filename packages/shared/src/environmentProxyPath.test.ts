// This parser decides WHICH server a byte-for-byte relay talks to, so every
// case below is a security assertion, not a formatting one. A spelling that
// classifies as one environment but forwards a target the upstream reads
// differently is the whole class of bug this file exists to prevent.

import { describe, expect, it } from "vitest";

import {
  isEnvironmentProxyRequestTarget,
  parseEnvironmentProxyTarget,
} from "./environmentProxyPath";

function expectOk(target: string) {
  const parsed = parseEnvironmentProxyTarget(target);
  if (!parsed.ok) throw new Error(`Expected ${target} to parse, got ${parsed.reason}`);
  return parsed;
}

function expectRejected(target: string) {
  const parsed = parseEnvironmentProxyTarget(target);
  if (parsed.ok) {
    throw new Error(
      `Expected ${target} to be rejected, but it resolved to ${parsed.environmentId} -> ${parsed.upstreamTarget}`,
    );
  }
  return parsed;
}

describe("parseEnvironmentProxyTarget", () => {
  it("strips exactly the /env/<id> prefix and forwards the rest verbatim", () => {
    expect(expectOk("/env/abc/threads/t1")).toMatchObject({
      environmentId: "abc",
      upstreamTarget: "/threads/t1",
    });
    // A deep link is the acceptance case from the issue: it must resolve to the
    // same path on the upstream, not to a rewritten or normalized one.
    expect(expectOk("/env/host-1/threads/9f2c/messages?after=12").upstreamTarget).toBe(
      "/threads/9f2c/messages?after=12",
    );
    expect(expectOk("/env/abc").upstreamTarget).toBe("/");
    expect(expectOk("/env/abc/").upstreamTarget).toBe("/");
  });

  it("preserves the query string and fragment byte for byte", () => {
    // Percent-encoding, case, and repeated keys all survive: the upstream's own
    // router must see what the browser sent. A normalizing parse here is how a
    // proxy silently changes a request's meaning.
    for (const [input, expected] of [
      ["/env/e1/ws?token=AbC%2BdEf%3D&x=1&x=2", "/ws?token=AbC%2BdEf%3D&x=1&x=2"],
      ["/env/e1/a?b=%7Bjson%7D", "/a?b=%7Bjson%7D"],
      ["/env/e1/a#Frag", "/a#Frag"],
      ["/env/e1?only=query", "/?only=query"],
    ] as const) {
      expect(expectOk(input).upstreamTarget, input).toBe(expected);
    }
  });

  it("does not fold case or collapse slashes in the forwarded target", () => {
    // The upstream is a full Synara server whose router does its own
    // normalization. If we normalized first, our logs and its behaviour could
    // disagree about what was delivered.
    expect(expectOk("/env/e1/API/Threads").upstreamTarget).toBe("/API/Threads");
    expect(expectOk("/env/e1//double//slash").upstreamTarget).toBe("//double//slash");
  });

  it("refuses targets that are not the proxy prefix", () => {
    for (const target of ["/", "/ws", "/api/auth/session", "/environments/abc", "/envx/abc"]) {
      expect(expectRejected(target).reason, target).toBe("not-proxy-path");
    }
  });

  it("refuses an absent or empty environment id rather than looking up an empty key", () => {
    for (const target of ["/env", "/env/", "/env//threads", "/env?x=1"]) {
      expect(expectRejected(target).reason, target).toMatch(/missing-environment-id/);
    }
  });

  it("refuses an environment id that could address something other than a registry entry", () => {
    // Each of these is a traversal or an absolute-target attempt in the id
    // position. None may reach a registry lookup, let alone a socket.
    for (const target of [
      "/env/../secret/x",
      "/env/./x",
      "/env/..%2F..%2Fetc/x",
      "/env/%2e%2e/x",
      "/env/-leading-dash/x",
      "/env/has space/x",
      "/env/has:colon/x",
      "/env/has@at/x",
    ]) {
      const rejection = expectRejected(target);
      expect(rejection.reason, target).not.toBe("not-proxy-path");
    }
  });

  it("refuses an over-long environment id", () => {
    expect(expectRejected(`/env/${"a".repeat(65)}/x`).reason).toBe("environment-id-too-long");
    expect(expectOk(`/env/${"a".repeat(64)}/x`).environmentId).toHaveLength(64);
  });

  it("refuses traversal segments after the environment id", () => {
    // `..` cannot escape the upstream host, but it changes which upstream PATH
    // was actually delivered relative to what we logged. Refuse, do not
    // normalize.
    for (const target of ["/env/e1/../../etc", "/env/e1/a/../../b", "/env/e1/."]) {
      expect(expectRejected(target).reason, target).toBe("traversal-segment");
    }
  });

  it("refuses percent-encoded path separators", () => {
    // These decode to `/`, `\` or NUL at the UPSTREAM, so a target we
    // classified as one segment would arrive there as several — our parse and
    // its parse would disagree about the request.
    for (const target of [
      "/env/e1/a%2Fb",
      "/env/e1/a%2fb",
      "/env/e1/a%5Cb",
      "/env/e1/a%00b",
      "/env/e1/a?x=%2F..%2Fadmin",
    ]) {
      expect(expectRejected(target).reason, target).toBe("encoded-separator");
    }
  });

  it("refuses percent-encoded dots and double-encoding in the path", () => {
    // Each of these decodes to a traversal the LITERAL `..` check cannot see:
    // `new URL()` normalizes `/env/a/%2e%2e/admin` to `/admin`, so an upstream
    // with a normalizing router serves a different path than the proxy
    // classified and logged. Table-driven so the spellings are the assertion.
    for (const [target, reason] of [
      ["/env/e1/%2e%2e/admin", "encoded-dot"],
      ["/env/e1/%2E%2E/admin", "encoded-dot"],
      ["/env/e1/.%2e/admin", "encoded-dot"],
      ["/env/e1/%2e./admin", "encoded-dot"],
      ["/env/e1/a/%2e", "encoded-dot"],
      ["/env/e1/%252f/admin", "double-encoded"],
      ["/env/e1/%252e%252e/admin", "double-encoded"],
    ] as const) {
      expect(expectRejected(target).reason, target).toBe(reason);
    }
  });

  it("still forwards percent-encoding in the QUERY, where it changes no segment", () => {
    // The refusal is about the segment structure the upstream router walks. A
    // query value legitimately carries encoded dots and percent signs, and
    // rejecting those would break real requests without closing anything.
    expect(expectOk("/env/e1/a?path=%2e%2e").upstreamTarget).toBe("/a?path=%2e%2e");
    expect(expectOk("/env/e1/a?raw=100%25").upstreamTarget).toBe("/a?raw=100%25");
  });
});

describe("isEnvironmentProxyRequestTarget", () => {
  it("classifies exactly what the parser accepts as a proxy path", () => {
    // The dispatcher uses this predicate to divert a request away from the
    // local router. If it said "not mine" for something the parser would have
    // accepted, that request would be served by the LOCAL server instead of the
    // remote one — a cross-environment answer.
    for (const target of ["/env", "/env/", "/env/abc", "/env/abc/threads", "/env?x=1"]) {
      expect(isEnvironmentProxyRequestTarget(target), target).toBe(true);
    }
    for (const target of ["/", "/ws", "/envs/abc", "/environment/abc", "/api/env/abc"]) {
      expect(isEnvironmentProxyRequestTarget(target), target).toBe(false);
    }
  });

  it("never claims a target the parser would call not-proxy-path", () => {
    // Structural agreement: a target the predicate diverts but the parser
    // rejects as "not a proxy path" would be dropped by both layers.
    for (const target of ["/env/a", "/env", "/ws", "/api/auth/session", "/env/a/b", "/enveloped"]) {
      const parsed = parseEnvironmentProxyTarget(target);
      const parserSaysNotProxy = !parsed.ok && parsed.reason === "not-proxy-path";
      expect(isEnvironmentProxyRequestTarget(target), target).toBe(!parserSaysNotProxy);
    }
  });
});

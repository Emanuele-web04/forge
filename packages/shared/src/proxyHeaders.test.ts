import { describe, expect, it } from "vitest";

import {
  environmentCookieHeader,
  environmentCookieName,
  environmentCookiePath,
  forwardableRequestHeaders,
  forwardableResponseHeaders,
  HOP_BY_HOP_HEADERS,
  scopeSetCookieForEnvironment,
} from "./proxyHeaders";

describe("hop-by-hop stripping", () => {
  it("names every hop-by-hop header RFC 9110 defines", () => {
    // Asserting the CONTENTS, not just that a set exists: a header quietly
    // dropped from this list starts being forwarded, and the upstream then
    // believes something about a connection it does not have.
    expect([...HOP_BY_HOP_HEADERS].sort()).toEqual([
      "connection",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
    ]);
  });

  it("strips them from requests and responses regardless of case", () => {
    const request = forwardableRequestHeaders(
      {
        "Transfer-Encoding": "chunked",
        KEEP_ALIVE: "timeout=5",
        "keep-alive": "timeout=5",
        TE: "trailers",
        accept: "application/json",
      },
      "e1",
    );
    expect(request["transfer-encoding"]).toBeUndefined();
    expect(request["keep-alive"]).toBeUndefined();
    expect(request["te"]).toBeUndefined();
    expect(request["accept"]).toBe("application/json");

    const response = forwardableResponseHeaders(
      { "Transfer-Encoding": "chunked", "content-type": "text/html" },
      "e1",
    );
    expect(response["transfer-encoding"]).toBeUndefined();
    expect(response["content-type"]).toBe("text/html");
  });

  it("honours headers the Connection header nominates as hop-by-hop", () => {
    // RFC 9110 lets a hop nominate its own. A proxy that ignored the list is
    // how `Connection: x-internal-trust` survives a hop it was meant to die at.
    const forwarded = forwardableRequestHeaders(
      {
        connection: "keep-alive, X-Internal-Trust",
        "x-internal-trust": "yes",
        "x-normal": "kept",
      },
      "e1",
    );
    expect(forwarded["x-internal-trust"]).toBeUndefined();
    expect(forwarded["x-normal"]).toBe("kept");
  });

  it("refuses to forward a client-supplied Authorization or forwarded-for header", () => {
    // The proxy replaces Authorization with the environment's own provisioned
    // credential. If the client's survived, a browser could choose which
    // credential the local server presents to a remote host.
    const forwarded = forwardableRequestHeaders(
      {
        authorization: "Bearer attacker-chosen",
        "x-forwarded-for": "10.0.0.1",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
        "x-real-ip": "10.0.0.1",
        host: "evil.example",
      },
      "e1",
    );
    expect(forwarded["authorization"]).toBeUndefined();
    expect(forwarded["x-forwarded-for"]).toBeUndefined();
    expect(forwarded["x-forwarded-host"]).toBeUndefined();
    expect(forwarded["x-forwarded-proto"]).toBeUndefined();
    expect(forwarded["x-real-ip"]).toBeUndefined();
    expect(forwarded["host"]).toBeUndefined();
  });

  it("preserves the WebSocket extension handshake headers verbatim", () => {
    // permessage-deflate negotiates end to end only because these cross the
    // proxy untouched. Rewriting or dropping any of them silently disables
    // compression on the link that needs it most.
    const offered = "permessage-deflate; client_max_window_bits";
    const forwarded = forwardableRequestHeaders(
      {
        "sec-websocket-extensions": offered,
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
        "sec-websocket-protocol": "synara",
      },
      "e1",
    );
    expect(forwarded["sec-websocket-extensions"]).toBe(offered);
    expect(forwarded["sec-websocket-key"]).toBe("dGhlIHNhbXBsZSBub25jZQ==");
    expect(forwarded["sec-websocket-version"]).toBe("13");
    expect(forwarded["sec-websocket-protocol"]).toBe("synara");
  });
});

describe("per-environment cookie isolation on the request", () => {
  it("never forwards the LOCAL server's session cookie", () => {
    // The local session cookie is issued with Path=/, so the browser attaches
    // it to every /env/<id>/* request. Relaying it hands the LOCAL session
    // token to every remote environment operator.
    const forwarded = forwardableRequestHeaders(
      { cookie: "synara_session=local-secret; theme=dark" },
      "host-a",
    );
    expect(forwarded["cookie"]).toBeUndefined();
    expect(JSON.stringify(forwarded)).not.toContain("local-secret");
  });

  it("forwards only the cookies belonging to THIS environment, under their original names", () => {
    // Both environments' cookies live in one jar on one origin. A request to A
    // must carry A's cookie and nothing else, spelled the way A's server set it.
    const jar = [
      "synara_session=local-secret",
      `${environmentCookieName({ environmentId: "host-a", cookieName: "synara_session" })}=token-a`,
      `${environmentCookieName({ environmentId: "host-b", cookieName: "synara_session" })}=token-b`,
    ].join("; ");

    const toA = forwardableRequestHeaders({ cookie: jar }, "host-a");
    expect(toA["cookie"]).toBe("synara_session=token-a");

    const toB = forwardableRequestHeaders({ cookie: jar }, "host-b");
    expect(toB["cookie"]).toBe("synara_session=token-b");
  });

  it("omits the Cookie header entirely when nothing belongs to this environment", () => {
    // An empty `Cookie:` is not the same as no cookie header, and sending one
    // tells the upstream something about a jar it has no business seeing.
    expect(
      forwardableRequestHeaders({ cookie: "synara_session=local; other=1" }, "host-a")["cookie"],
    ).toBeUndefined();
    expect(forwardableRequestHeaders({}, "host-a")["cookie"]).toBeUndefined();
  });

  it("does not let one environment's id prefix another's cookies", () => {
    // A prefix match on the id alone would let `host` read `host-a`'s cookies.
    // The separator is what makes the namespace exact.
    const jar = `${environmentCookieName({ environmentId: "host-a", cookieName: "s" })}=a`;
    expect(environmentCookieHeader(jar, "host")).toBeUndefined();
    expect(environmentCookieHeader(jar, "host-a")).toBe("s=a");
  });
});

describe("per-environment cookie scoping on the response", () => {
  it("namespaces the cookie NAME so two environments cannot collide in one jar", () => {
    // Every Synara server names its session cookie `synara_session`, and in web
    // mode there is no port suffix to tell them apart. Path scoping alone is
    // not isolation: the browser stores one name per origin, so B's Set-Cookie
    // would overwrite A's token.
    const scopedA = scopeSetCookieForEnvironment("synara_session=token-a; Path=/", "host-a");
    const scopedB = scopeSetCookieForEnvironment("synara_session=token-b; Path=/", "host-b");
    expect(scopedA.split("=")[0]).not.toBe(scopedB.split("=")[0]);
    expect(scopedA).toContain(
      environmentCookieName({ environmentId: "host-a", cookieName: "synara_session" }),
    );
    expect(scopedA).toContain("token-a");
  });

  it("confines a cookie to its environment's path", () => {
    // Every environment is served from ONE origin. Without this rewrite the
    // browser sends environment A's session cookie to environment B — an
    // authentication credential delivered to a server that never issued it.
    expect(scopeSetCookieForEnvironment("synara_session=abc; Path=/; HttpOnly", "env-1")).toBe(
      "env~env-1~synara_session=abc; HttpOnly; Path=/env/env-1",
    );
    expect(environmentCookiePath("env-1")).toBe("/env/env-1");
  });

  it("round-trips: what the response stores is what the next request forwards", () => {
    // The two halves are only isolation if they agree. Asserting them together
    // pins the naming scheme as a contract rather than two independent guesses.
    const scoped = scopeSetCookieForEnvironment("synara_session=abc; Path=/; HttpOnly", "host-a");
    const stored = scoped.split(";")[0]!;
    expect(forwardableRequestHeaders({ cookie: stored }, "host-a")["cookie"]).toBe(
      "synara_session=abc",
    );
    expect(forwardableRequestHeaders({ cookie: stored }, "host-b")["cookie"]).toBeUndefined();
  });

  it("preserves a cookie whose NAME is `path` or `domain`", () => {
    // parts[0] is the name-value pair, never an attribute. Filtering it as one
    // deletes the cookie outright and the upstream's session silently vanishes.
    for (const name of ["path", "domain", "Path", "DOMAIN"]) {
      const scoped = scopeSetCookieForEnvironment(`${name}=secret-value; HttpOnly`, "host-a");
      expect(scoped, name).toContain("secret-value");
      expect(scoped, name).toContain(
        `${environmentCookieName({ environmentId: "host-a", cookieName: name })}=secret-value`,
      );
      expect(scoped, name).toContain("HttpOnly");
      expect(scoped, name).toContain("Path=/env/host-a");
    }
  });

  it("replaces the upstream's Path rather than adding to it", () => {
    // The upstream sets Path=/ because it believes it owns the origin. Keeping
    // that value is the leak; there is nothing to preserve.
    const scoped = scopeSetCookieForEnvironment("s=1; Path=/; Secure; SameSite=Lax", "e9");
    expect(scoped).not.toMatch(/Path=\/;/);
    expect(scoped.match(/Path=/g)).toHaveLength(1);
    expect(scoped).toContain("Path=/env/e9");
    expect(scoped).toContain("Secure");
    expect(scoped).toContain("SameSite=Lax");
  });

  it("drops a Domain attribute, which would defeat path scoping entirely", () => {
    // A domain-scoped cookie is sent to every subdomain regardless of path, so
    // preserving Domain would reintroduce the cross-environment leak.
    const scoped = scopeSetCookieForEnvironment("s=1; Domain=example.com; Path=/", "e2");
    expect(scoped.toLowerCase()).not.toContain("domain=example.com");
    expect(scoped).toContain("Path=/env/e2");
  });

  it("scopes a cookie that declared no Path at all", () => {
    // With no Path the browser defaults to the request's directory — which for
    // a proxied request is already under /env/<id>, but only for THAT request.
    // Making it explicit removes the dependency on where the response came from.
    expect(scopeSetCookieForEnvironment("s=1", "e3")).toBe("env~e3~s=1; Path=/env/e3");
  });

  it("scopes every cookie when the upstream sets several", () => {
    const headers = forwardableResponseHeaders(
      { "set-cookie": ["a=1; Path=/", "b=2; Path=/api; HttpOnly"] },
      "e4",
    );
    expect(headers["set-cookie"]).toEqual([
      "env~e4~a=1; Path=/env/e4",
      "env~e4~b=2; HttpOnly; Path=/env/e4",
    ]);
  });

  it("is case-insensitive about the attribute names it rewrites", () => {
    // `Set-Cookie` attribute names are case-insensitive; a case-sensitive
    // filter would leave `path=/` in place and the leak with it.
    for (const spelling of ["path=/", "PATH=/", "Path =/", "pAtH=/"]) {
      const scoped = scopeSetCookieForEnvironment(`s=1; ${spelling}; HttpOnly`, "e5");
      expect(scoped.match(/path=/gi), spelling).toHaveLength(1);
      expect(scoped, spelling).toContain("Path=/env/e5");
    }
  });
});

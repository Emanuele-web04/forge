import http from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../config.ts";
import {
  makeOutboundMcpCallbackEndpoint,
  OutboundMcpCallbackEndpoint,
} from "./callbackEndpoint.ts";
import {
  McpConnectionService,
  type McpCompleteAuthorizationInput,
} from "./Services/McpConnectionService.ts";
import {
  isOutboundMcpCallbackAuthority,
  OUTBOUND_MCP_OAUTH_CALLBACK_PATH,
  outboundMcpRouteLayer,
} from "./httpRoute.ts";

interface CallbackHttpResponse {
  readonly body: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly status: number;
}

function requestCallback(
  origin: string,
  path: string,
  headers: ReadonlyArray<string>,
): Promise<CallbackHttpResponse> {
  const target = new URL(path, origin);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers,
        setHost: false,
      },
      (response) => {
        response.setEncoding("utf8");
        let body = "";
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({ body, headers: response.headers, status: response.statusCode ?? 0 });
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function withOutboundMcpCallbackServer(
  input: {
    readonly host?: string;
    readonly publicUrl?: URL;
    readonly completeAuthorization?: (input: McpCompleteAuthorizationInput) => Effect.Effect<never>;
  },
  run: (input: {
    readonly origin: string;
    readonly completed: ReadonlyArray<McpCompleteAuthorizationInput>;
    readonly callbackUrl: URL | null;
  }) => Promise<void>,
): Promise<void> {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  const completed: McpCompleteAuthorizationInput[] = [];
  const availableStates = new Set(["s1", "cancel-state"]);
  const callbackEndpoint = makeOutboundMcpCallbackEndpoint();
  let nodeServer: http.Server | null = null;
  const connectionService = {
    list: () => Effect.succeed([]),
    beginAuthorization: () => Effect.die("not used"),
    completeAuthorization: (callback: McpCompleteAuthorizationInput) =>
      Effect.sync(() => completed.push(callback)).pipe(
        Effect.andThen(
          input.completeAuthorization?.(callback) ??
            Effect.sync(() => {
              if (!availableStates.delete(callback.state)) {
                return {
                  ok: false as const,
                  category: "invalid-authorization-attempt" as const,
                };
              }
              if (callback.error !== undefined) {
                return { ok: false as const, category: "authorization-cancelled" as const };
              }
              return callback.code === "c1"
                ? { ok: true as const }
                : { ok: false as const, category: "invalid-authorization-attempt" as const };
            }),
        ),
      ),
    disconnect: () => Effect.die("not used"),
    invoke: () => Effect.die("not used"),
    subscribe: () => Effect.die("not used"),
  } as never;

  try {
    await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const server = yield* NodeHttpServer.make(
            () => {
              nodeServer = http.createServer();
              return nodeServer;
            },
            { port: 0, host: "127.0.0.1" },
          );
          yield* callbackEndpoint.configure({
            config: {
              host: input.host ?? "127.0.0.1",
              publicUrl: input.publicUrl,
            },
            serverAddress: nodeServer?.address() ?? null,
          });
          yield* server.serve(yield* HttpRouter.toHttpEffect(outboundMcpRouteLayer));
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(McpConnectionService, connectionService),
              Layer.succeed(OutboundMcpCallbackEndpoint, callbackEndpoint),
              Layer.succeed(ServerConfig, {
                host: input.host ?? "127.0.0.1",
                publicUrl: input.publicUrl,
              } as never),
              NodeServices.layer,
            ),
          ),
        ),
        scope,
      ),
    );

    const address = (nodeServer as http.Server | null)?.address();
    if (!address || typeof address !== "object") throw new Error("Missing test server address");
    await run({
      origin: `http://127.0.0.1:${address.port}`,
      completed,
      callbackUrl: await Effect.runPromise(callbackEndpoint.currentUrl),
    });
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

describe("outboundMcpRouteLayer", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["duplicate", "127.0.0.1:58090, attacker.example.test"],
    ["userinfo-like", "attacker@127.0.0.1:58090"],
    ["malformed port", "127.0.0.1:58090:80"],
    ["scheme-like", "http://127.0.0.1:58090"],
    ["default-port alias", "127.0.0.1:80"],
  ])("rejects a %s callback authority", (_label, authority) => {
    expect(
      isOutboundMcpCallbackAuthority(
        authority,
        new URL("http://127.0.0.1:58090/api/mcp/outbound/oauth/callback"),
      ),
    ).toBe(false);
  });

  it("accepts exact canonical IPv4 and bracketed IPv6 callback authorities", () => {
    expect(
      isOutboundMcpCallbackAuthority(
        "127.0.0.1:58090",
        new URL("http://127.0.0.1:58090/api/mcp/outbound/oauth/callback"),
      ),
    ).toBe(true);
    expect(
      isOutboundMcpCallbackAuthority(
        "[::1]:58090",
        new URL("http://[::1]:58090/api/mcp/outbound/oauth/callback"),
      ),
    ).toBe(true);
  });

  it("rejects an explicit default port when WHATWG canonicalization omits it", () => {
    const callbackUrl = new URL("http://127.0.0.1:80/api/mcp/outbound/oauth/callback");

    expect(isOutboundMcpCallbackAuthority("127.0.0.1:80", callbackUrl)).toBe(false);
    expect(isOutboundMcpCallbackAuthority("127.0.0.1", callbackUrl)).toBe(true);
  });

  it("derives the redirect URI from the resolved IPv4 listener port and clears it", async () => {
    const endpoint = makeOutboundMcpCallbackEndpoint();
    const stableCallbackUrl = endpoint.callbackUrl;
    await Effect.runPromise(
      endpoint.configure({
        config: { host: "127.0.0.1", publicUrl: undefined },
        serverAddress: { address: "127.0.0.1", family: "IPv4", port: 49152 },
      }),
    );

    await expect(Effect.runPromise(endpoint.currentUrl)).resolves.toEqual(
      new URL("http://127.0.0.1:49152/api/mcp/outbound/oauth/callback"),
    );
    expect(endpoint.callbackUrl.href).toBe(
      "http://127.0.0.1:49152/api/mcp/outbound/oauth/callback",
    );
    expect(endpoint.callbackUrl).toBe(stableCallbackUrl);

    await Effect.runPromise(endpoint.clear);
    await expect(Effect.runPromise(endpoint.currentUrl)).resolves.toBeNull();
  });

  it("formats an actual IPv6 loopback listener as a bracketed redirect URI", async () => {
    const endpoint = makeOutboundMcpCallbackEndpoint();
    await Effect.runPromise(
      endpoint.configure({
        config: { host: "::1", publicUrl: undefined },
        serverAddress: { address: "::1", family: "IPv6", port: 58090 },
      }),
    );

    await expect(Effect.runPromise(endpoint.currentUrl)).resolves.toEqual(
      new URL("http://[::1]:58090/api/mcp/outbound/oauth/callback"),
    );
  });

  it("keeps the capability disabled for non-loopback and public configurations", async () => {
    for (const input of [
      {
        config: { host: "0.0.0.0", publicUrl: undefined },
        address: "127.0.0.1",
      },
      {
        config: { host: "127.0.0.1", publicUrl: new URL("https://synara.example.test") },
        address: "127.0.0.1",
      },
      {
        config: { host: "127.0.0.1", publicUrl: undefined },
        address: "0.0.0.0",
      },
    ]) {
      const endpoint = makeOutboundMcpCallbackEndpoint();
      await Effect.runPromise(
        endpoint.configure({
          config: input.config,
          serverAddress: { address: input.address, family: "IPv4", port: 58090 },
        }),
      );
      await expect(Effect.runPromise(endpoint.currentUrl)).resolves.toBeNull();
    }
  });

  it("completes a loopback callback once without reflecting OAuth values", async () => {
    await withOutboundMcpCallbackServer({}, async ({ origin, completed, callbackUrl }) => {
      const requestUrl = `${origin}${OUTBOUND_MCP_OAUTH_CALLBACK_PATH}?code=c1&state=s1`;
      const response = await requestCallback(origin, requestUrl, [
        "Host",
        callbackUrl?.host ?? "missing.test",
        "X-Forwarded-Host",
        "attacker.example.test",
        "X-Forwarded-Proto",
        "https",
      ]);

      expect(response.status).toBe(200);
      expect(callbackUrl?.href).toBe(new URL(OUTBOUND_MCP_OAUTH_CALLBACK_PATH, origin).href);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).not.toContain("c1");
      expect(response.body).not.toContain("s1");
      expect(response.body).not.toContain("attacker.example.test");
      expect(completed).toEqual([{ code: "c1", state: "s1" }]);

      const replay = await fetch(requestUrl);
      expect(replay.status).toBe(400);
      expect(await replay.text()).not.toContain("c1");
    });
  });

  it("rejects spoofed and malformed Host values before completing authorization", async () => {
    await withOutboundMcpCallbackServer({}, async ({ origin, completed, callbackUrl }) => {
      const query = "?code=secret-code&state=secret-state";
      const expectedAuthority = callbackUrl?.host ?? "127.0.0.1:1";
      const requests: ReadonlyArray<readonly [string, ReadonlyArray<string>, number]> = [
        ["hostile", ["Host", "attacker.example.test"], 404],
        ["missing", [], 400],
        ["duplicate", ["Host", expectedAuthority, "Host", "attacker.example.test"], 404],
        ["missing port", ["Host", "127.0.0.1"], 404],
        ["userinfo-like", ["Host", `attacker@${expectedAuthority}`], 404],
        ["malformed", ["Host", `${expectedAuthority}:80`], 404],
      ];

      for (const [label, rawHeaders, expectedStatus] of requests) {
        const response = await requestCallback(
          origin,
          `${OUTBOUND_MCP_OAUTH_CALLBACK_PATH}${query}`,
          [...rawHeaders, "X-Forwarded-Host", expectedAuthority, "X-Forwarded-Proto", "http"],
        );

        expect(response.status, label).toBe(expectedStatus);
        if (expectedStatus === 404) expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.body).not.toContain(expectedAuthority);
        expect(response.body).not.toContain("secret-code");
        expect(response.body).not.toContain("secret-state");
      }
      expect(completed).toEqual([]);
    });
  });

  it("does not treat a spoofed loopback Host header as proof of a loopback bind", async () => {
    await withOutboundMcpCallbackServer({ host: "0.0.0.0" }, async ({ origin, completed }) => {
      const response = await fetch(
        `${origin}${OUTBOUND_MCP_OAUTH_CALLBACK_PATH}?code=c1&state=s1`,
        { headers: { Host: "127.0.0.1:3773" } },
      );

      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("c1");
      expect(completed).toEqual([]);
    });
  });

  it("disables the callback when a public origin is configured", async () => {
    await withOutboundMcpCallbackServer(
      { publicUrl: new URL("https://synara.example.test") },
      async ({ origin, completed }) => {
        const response = await fetch(
          `${origin}${OUTBOUND_MCP_OAUTH_CALLBACK_PATH}?code=c1&state=s1`,
        );

        expect(response.status).toBe(404);
        expect(completed).toEqual([]);
      },
    );
  });

  it.each([
    ["missing state", "?code=secret-code"],
    ["missing code and error", "?state=s1"],
    ["code and error together", "?state=s1&code=secret-code&error=secret-error"],
    ["an empty code alongside an error", "?state=s1&code=&error=secret-error"],
  ])("rejects %s without invoking the connection service", async (_label, query) => {
    await withOutboundMcpCallbackServer({}, async ({ origin, completed }) => {
      const response = await fetch(`${origin}${OUTBOUND_MCP_OAUTH_CALLBACK_PATH}${query}`);
      const body = await response.text();

      expect(response.status).toBe(400);
      expect(body).not.toContain("secret-code");
      expect(body).not.toContain("secret-error");
      expect(body).not.toContain("s1");
      expect(completed).toEqual([]);
    });
  });

  it("fails state mismatch and cancellation with non-sensitive HTML", async () => {
    await withOutboundMcpCallbackServer({}, async ({ origin, completed }) => {
      const mismatch = await fetch(
        `${origin}${OUTBOUND_MCP_OAUTH_CALLBACK_PATH}?code=token-shaped-code&state=wrong-state`,
      );
      const cancelled = await fetch(
        `${origin}${OUTBOUND_MCP_OAUTH_CALLBACK_PATH}?error=access_denied&state=cancel-state&token=secret-token`,
      );
      const bodies = `${await mismatch.text()}${await cancelled.text()}`;

      expect(mismatch.status).toBe(400);
      expect(cancelled.status).toBe(400);
      expect(bodies).not.toContain("token-shaped-code");
      expect(bodies).not.toContain("wrong-state");
      expect(bodies).not.toContain("access_denied");
      expect(bodies).not.toContain("secret-token");
      expect(completed).toEqual([
        { code: "token-shaped-code", state: "wrong-state" },
        { error: "access_denied", state: "cancel-state" },
      ]);
    });
  });

  it("does not expose service errors or add HTTP lifecycle management routes", async () => {
    await withOutboundMcpCallbackServer(
      {
        completeAuthorization: () =>
          Effect.die(
            new Error(
              "raw-cause secret-code secret-state secret-token secret-verifier client-secret",
            ),
          ),
      },
      async ({ origin, completed }) => {
        const callback = await fetch(
          `${origin}${OUTBOUND_MCP_OAUTH_CALLBACK_PATH}?code=secret-code&state=s1`,
        );
        const callbackBody = await callback.text();
        const management = await fetch(`${origin}/api/mcp/outbound/connections`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ presetId: "paraty" }),
        });

        expect(callback.status).toBe(400);
        expect(callbackBody).not.toMatch(
          /raw-cause|secret-code|secret-state|secret-token|secret-verifier|client-secret/,
        );
        expect(management.status).toBe(404);
        expect(completed).toEqual([{ code: "secret-code", state: "s1" }]);
      },
    );
  });
});

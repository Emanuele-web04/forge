import http from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../config.ts";
import {
  McpConnectionService,
  type McpCompleteAuthorizationInput,
} from "./Services/McpConnectionService.ts";
import { OUTBOUND_MCP_OAUTH_CALLBACK_PATH, outboundMcpRouteLayer } from "./httpRoute.ts";

async function withOutboundMcpCallbackServer(
  input: {
    readonly host?: string;
    readonly publicUrl?: URL;
    readonly completeAuthorization?: (input: McpCompleteAuthorizationInput) => Effect.Effect<never>;
  },
  run: (input: {
    readonly origin: string;
    readonly completed: ReadonlyArray<McpCompleteAuthorizationInput>;
  }) => Promise<void>,
): Promise<void> {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  const completed: McpCompleteAuthorizationInput[] = [];
  const availableStates = new Set(["s1", "cancel-state"]);
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
          yield* server.serve(yield* HttpRouter.toHttpEffect(outboundMcpRouteLayer));
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(McpConnectionService, connectionService),
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
    await run({ origin: `http://127.0.0.1:${address.port}`, completed });
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

describe("outboundMcpRouteLayer", () => {
  it("completes a loopback callback once without reflecting OAuth values", async () => {
    await withOutboundMcpCallbackServer({}, async ({ origin, completed }) => {
      const callbackUrl = `${origin}${OUTBOUND_MCP_OAUTH_CALLBACK_PATH}?code=c1&state=s1`;
      const response = await fetch(callbackUrl, {
        headers: { Host: "attacker.example.test" },
      });
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body).not.toContain("c1");
      expect(body).not.toContain("s1");
      expect(body).not.toContain("attacker.example.test");
      expect(completed).toEqual([{ code: "c1", state: "s1" }]);

      const replay = await fetch(callbackUrl);
      expect(replay.status).toBe(400);
      expect(await replay.text()).not.toContain("c1");
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

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId } from "@synara/contracts";
import {
  ATTACHMENT_CANCEL_ROUTE_PATH,
  ATTACHMENT_UPLOAD_ROUTE_PATH,
  VOICE_TRANSCRIPTION_UPLOAD_ROUTE_PATH,
} from "@synara/shared/binaryTransfer";
import { DateTime, Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { describe, expect, it, vi } from "vitest";

import { AuthError, ServerAuth, type ServerAuthShape } from "./auth/Services/ServerAuth";
import {
  SessionCredentialService,
  type SessionCredentialServiceShape,
} from "./auth/Services/SessionCredentialService";
import { ServerConfig, type ServerConfigShape } from "./config";
import { ManagedAttachmentRepositoryLive } from "./persistence/Layers/ManagedAttachments";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import {
  AUTH_JSON_BODY_MAX_BYTES,
  authEffectRouteLayer,
  binaryUploadEffectRouteLayer,
} from "./http";
import {
  ProviderAdapterRegistry,
  type ProviderAdapterRegistryShape,
} from "./provider/Services/ProviderAdapterRegistry";
import { ServerSettingsService } from "./serverSettings";

const currentSessionId = AuthSessionId.makeUnsafe("11111111-1111-4111-8111-111111111111");
const otherSessionId = AuthSessionId.makeUnsafe("22222222-2222-4222-8222-222222222222");

function makeSessionCredentialService(): SessionCredentialServiceShape {
  return {
    cookieName: "synara_session",
  } as SessionCredentialServiceShape;
}

function makeServerAuth(sideEffects: { count: number }): ServerAuthShape {
  const expiresAt = DateTime.toUtc(Effect.runSync(DateTime.now));
  const descriptor = {
    policy: "remote-reachable" as const,
    bootstrapMethods: ["one-time-token" as const],
    sessionMethods: ["browser-session-cookie" as const, "bearer-session-token" as const],
    sessionCookieName: "synara_session",
  };
  const mutate = <A>(value: A) =>
    Effect.sync(() => {
      sideEffects.count += 1;
      return value;
    });
  return {
    getDescriptor: () => Effect.succeed(descriptor),
    getSessionState: () => Effect.succeed({ authenticated: false, auth: descriptor }),
    exchangeBootstrapCredential: () =>
      mutate({
        response: {
          authenticated: true,
          role: "owner",
          sessionMethod: "browser-session-cookie",
          expiresAt,
        },
        sessionToken: "cookie-token",
      }),
    exchangeBootstrapCredentialForBearerSession: () =>
      mutate({
        authenticated: true,
        role: "owner",
        sessionMethod: "bearer-session-token",
        expiresAt,
        sessionToken: "bearer-token",
      }),
    issuePairingCredential: () =>
      mutate({ id: "pairing-id", credential: "PAIRINGTOKEN", expiresAt }),
    listPairingLinks: () => Effect.succeed([]),
    revokePairingLink: () => mutate(true),
    listClientSessions: () => Effect.succeed([]),
    revokeClientSession: () => mutate(true),
    revokeOtherClientSessions: () => mutate(1),
    logoutSession: () => mutate(true),
    authenticateHttpRequest: (request) => {
      const bearer = request.headers.authorization === "Bearer bearer-token";
      const cookie = request.cookies.synara_session === "cookie-token";
      if (!bearer && !cookie) {
        return Effect.fail(new AuthError({ message: "Authentication required.", status: 401 }));
      }
      return Effect.succeed({
        sessionId: currentSessionId,
        subject: "owner",
        method: bearer ? "bearer-session-token" : "browser-session-cookie",
        role: "owner",
        expiresAt,
        credentialSource: bearer ? "bearer" : "cookie",
      });
    },
    authenticateWebSocketUpgrade: () =>
      Effect.fail(new AuthError({ message: "Not used in auth route tests.", status: 401 })),
    issueWebSocketToken: () => mutate({ token: "ws-token", expiresAt }),
    issueStartupPairingUrl: () =>
      Effect.succeed("https://synara.example.test/pair#token=PAIRINGTOKEN"),
  } satisfies ServerAuthShape;
}

async function withAuthEffectServer(
  config: ServerConfigShape,
  serverAuth: ServerAuthShape,
  run: (origin: string) => Promise<void>,
  routeLayer:
    | typeof authEffectRouteLayer
    | typeof binaryUploadEffectRouteLayer = authEffectRouteLayer,
  overrides?: {
    readonly providerAdapterRegistry?: ProviderAdapterRegistryShape;
    readonly serverSettingsLayer?: Layer.Layer<ServerSettingsService>;
  },
): Promise<void> {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  let nodeServer: http.Server | null = null;
  try {
    const services = await Effect.runPromise(
      Layer.buildWithScope(
        Layer.mergeAll(
          Layer.succeed(ServerConfig, config),
          Layer.succeed(ServerAuth, serverAuth),
          Layer.succeed(SessionCredentialService, makeSessionCredentialService()),
          Layer.succeed(
            ProviderAdapterRegistry,
            overrides?.providerAdapterRegistry ?? {
              getByProvider: () => Effect.die("voice adapter not used in this test"),
              listProviders: () => Effect.succeed([]),
            },
          ),
          overrides?.serverSettingsLayer ?? ServerSettingsService.layerTest(),
          ManagedAttachmentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
          NodeServices.layer,
        ),
        scope,
      ),
    );
    await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const httpServer = yield* NodeHttpServer.make(
            () => {
              nodeServer = http.createServer();
              return nodeServer;
            },
            { port: 0, host: "127.0.0.1" },
          );
          if (routeLayer === authEffectRouteLayer) {
            yield* httpServer.serve(yield* HttpRouter.toHttpEffect(authEffectRouteLayer));
          } else {
            yield* httpServer.serve(yield* HttpRouter.toHttpEffect(binaryUploadEffectRouteLayer));
          }
        }).pipe(Effect.provideServices(services)),
        scope,
      ),
    );
    const address = (nodeServer as http.Server | null)?.address();
    if (!address || typeof address !== "object") throw new Error("Expected server address");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

const mutationRoutes: ReadonlyArray<{ readonly path: string; readonly body?: unknown }> = [
  { path: "/api/auth/ws-token" },
  { path: "/api/auth/pairing-token" },
  { path: "/api/auth/pairing-links/revoke", body: { id: "pairing-id" } },
  { path: "/api/auth/clients/revoke", body: { sessionId: otherSessionId } },
  { path: "/api/auth/clients/revoke-others" },
  { path: "/api/auth/logout" },
] as const;

function mutationRequest(input: {
  readonly origin?: string;
  readonly credential: "bearer" | "cookie";
  readonly body?: unknown;
}): RequestInit {
  return {
    method: "POST",
    headers: {
      ...(input.origin === undefined ? {} : { Origin: input.origin }),
      ...(input.credential === "bearer"
        ? { Authorization: "Bearer bearer-token" }
        : { Cookie: "synara_session=cookie-token" }),
      ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  };
}

describe("authEffectRouteLayer", () => {
  it("rejects declared and chunked oversized bootstrap JSON before auth exchange", async () => {
    const sideEffects = { count: 0 };
    const config = { host: "127.0.0.1", publicUrl: undefined } as ServerConfigShape;
    await withAuthEffectServer(config, makeServerAuth(sideEffects), async (serverOrigin) => {
      const oversizedBody = JSON.stringify({
        credential: "x".repeat(AUTH_JSON_BODY_MAX_BYTES),
      });
      const declaredResponse = await fetch(`${serverOrigin}/api/auth/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: oversizedBody,
      });
      expect(declaredResponse.status).toBe(413);
      expect(sideEffects.count).toBe(0);

      const chunkedStatus = await new Promise<number>((resolve, reject) => {
        const url = new URL("/api/auth/bootstrap", serverOrigin);
        const request = http.request(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Transfer-Encoding": "chunked",
            },
          },
          (response) => {
            response.resume();
            response.once("end", () => resolve(response.statusCode ?? 0));
          },
        );
        request.once("error", reject);
        request.write('{"credential":"');
        request.write("x".repeat(AUTH_JSON_BODY_MAX_BYTES));
        request.end('"}');
      });
      expect(chunkedStatus).toBe(413);
      expect(sideEffects.count).toBe(0);

      const malformedResponse = await fetch(`${serverOrigin}/api/auth/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      });
      expect(malformedResponse.status).toBe(400);

      const validResponse = await fetch(`${serverOrigin}/api/auth/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: "PAIRINGTOKEN" }),
      });
      expect(validResponse.status).toBe(200);
      expect(sideEffects.count).toBe(1);
    });
  });

  it("rejects every cookie-authenticated mutation without a trusted origin", async () => {
    const sideEffects = { count: 0 };
    const config = {
      host: "0.0.0.0",
      publicUrl: new URL("https://synara.example.test/"),
    } as ServerConfigShape;
    await withAuthEffectServer(config, makeServerAuth(sideEffects), async (serverOrigin) => {
      for (const route of mutationRoutes) {
        for (const origin of [
          undefined,
          "null",
          "not a url",
          "https://evil.example.test",
          "https://cross-site.invalid",
        ]) {
          const response = await fetch(
            `${serverOrigin}${route.path}`,
            mutationRequest({
              ...(origin === undefined ? {} : { origin }),
              credential: "cookie",
              ...(route.body === undefined ? {} : { body: route.body }),
            }),
          );
          expect(response.status, `${route.path} with ${String(origin)}`).toBe(403);
        }
        for (const origin of [
          "null",
          "not a url",
          "https://evil.example.test",
          "https://cross-site.invalid",
        ]) {
          const response = await fetch(
            `${serverOrigin}${route.path}`,
            mutationRequest({
              origin,
              credential: "bearer",
              ...(route.body === undefined ? {} : { body: route.body }),
            }),
          );
          expect(response.status, `${route.path} bearer with ${origin}`).toBe(403);
        }
      }
      expect(sideEffects.count).toBe(0);
    });
  });

  it("allows trusted-origin cookies and originless explicit bearer credentials", async () => {
    const sideEffects = { count: 0 };
    const config = { host: "127.0.0.1", publicUrl: undefined } as ServerConfigShape;
    await withAuthEffectServer(config, makeServerAuth(sideEffects), async (serverOrigin) => {
      for (const route of mutationRoutes) {
        const body = route.body === undefined ? {} : { body: route.body };
        const cookieResponse = await fetch(
          `${serverOrigin}${route.path}`,
          mutationRequest({ origin: serverOrigin, credential: "cookie", ...body }),
        );
        expect(cookieResponse.status, `${route.path} cookie`).toBe(200);

        const bearerResponse = await fetch(
          `${serverOrigin}${route.path}`,
          mutationRequest({ credential: "bearer", ...body }),
        );
        expect(bearerResponse.status, `${route.path} bearer`).toBe(200);
      }
      expect(sideEffects.count).toBe(mutationRoutes.length * 2);
    });
  });

  it("logs out either role and clears the exact cookie with secure public-mode attributes", async () => {
    const sideEffects = { count: 0 };
    const config = {
      host: "0.0.0.0",
      publicUrl: new URL("https://synara.example.test/"),
    } as ServerConfigShape;
    await withAuthEffectServer(config, makeServerAuth(sideEffects), async (serverOrigin) => {
      const response = await fetch(
        `${serverOrigin}/api/auth/logout`,
        mutationRequest({
          origin: "https://synara.example.test",
          credential: "cookie",
        }),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ revoked: true });
      const cookie = response.headers.get("set-cookie") ?? "";
      expect(cookie).toContain("synara_session=");
      expect(cookie).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
      expect(cookie).toContain("Max-Age=0");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("Secure");
      expect(sideEffects.count).toBe(1);
    });
  });
});

describe("binaryUploadEffectRouteLayer", () => {
  it("rejects voice uploads before transcription when the provider is disabled", async () => {
    const transcribeVoice = vi.fn(() => Effect.succeed({ text: "unexpected" }));
    await withAuthEffectServer(
      { host: "127.0.0.1", publicUrl: undefined } as ServerConfigShape,
      makeServerAuth({ count: 0 }),
      async (serverOrigin) => {
        const params = new URLSearchParams({
          provider: "codex",
          cwd: "/tmp/project",
          mimeType: "audio/wav",
          sampleRateHz: "16000",
          durationMs: "250",
        });
        const response = await fetch(
          `${serverOrigin}${VOICE_TRANSCRIPTION_UPLOAD_ROUTE_PATH}?${params.toString()}`,
          {
            method: "POST",
            headers: { Authorization: "Bearer bearer-token" },
            body: Uint8Array.from([1]),
          },
        );

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toEqual({
          error: "Codex is disabled in Settings > Providers.",
        });
        expect(transcribeVoice).not.toHaveBeenCalled();
      },
      binaryUploadEffectRouteLayer,
      {
        providerAdapterRegistry: {
          getByProvider: () => Effect.succeed({ provider: "codex", transcribeVoice } as never),
          listProviders: () => Effect.succeed(["codex"]),
        },
        serverSettingsLayer: ServerSettingsService.layerTest({
          providers: { codex: { enabled: false } },
        }),
      },
    );
  });

  it("allows credentialed Canary attachment upload preflights", async () => {
    const config = {
      host: "127.0.0.1",
      attachmentsDir: fs.mkdtempSync(path.join(os.tmpdir(), "synara-upload-cors-")),
    } as ServerConfigShape;
    try {
      await withAuthEffectServer(
        config,
        makeServerAuth({ count: 0 }),
        async (serverOrigin) => {
          const response = await fetch(`${serverOrigin}${ATTACHMENT_UPLOAD_ROUTE_PATH}`, {
            method: "OPTIONS",
            headers: {
              Origin: "synara-canary://app",
              "Access-Control-Request-Method": "POST",
              "Access-Control-Request-Headers": "content-type",
            },
          });

          expect(response.status).toBe(204);
          expect(response.headers.get("access-control-allow-origin")).toBe("synara-canary://app");
          expect(response.headers.get("access-control-allow-credentials")).toBe("true");
          expect(response.headers.get("access-control-allow-methods")).toContain("POST");
          expect(response.headers.get("access-control-allow-headers")?.toLowerCase()).toContain(
            "content-type",
          );
        },
        binaryUploadEffectRouteLayer,
      );
    } finally {
      fs.rmSync(config.attachmentsDir, { recursive: true, force: true });
    }
  });

  it("rejects ambient cookie uploads without an origin and accepts explicit bearer auth", async () => {
    const attachmentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-upload-route-"));
    const config = {
      host: "0.0.0.0",
      publicUrl: new URL("https://synara.example.test/"),
      attachmentsDir,
    } as ServerConfigShape;
    try {
      await withAuthEffectServer(
        config,
        makeServerAuth({ count: 0 }),
        async (serverOrigin) => {
          const params = new URLSearchParams({
            type: "image",
            threadId: "thread-1",
            name: "screen.png",
            mimeType: "image/png",
          });
          const url = `${serverOrigin}${ATTACHMENT_UPLOAD_ROUTE_PATH}?${params.toString()}`;
          const cookieResponse = await fetch(url, {
            method: "POST",
            headers: { Cookie: "synara_session=cookie-token" },
            body: Uint8Array.from([1]),
          });
          expect(cookieResponse.status).toBe(403);
          expect(fs.readdirSync(attachmentsDir)).toEqual([]);

          const oversizedStatus = await new Promise<number>((resolve, reject) => {
            const target = new URL(url);
            const request = http.request(
              {
                hostname: target.hostname,
                port: target.port,
                path: `${target.pathname}${target.search}`,
                method: "POST",
                headers: {
                  Authorization: "Bearer bearer-token",
                  "Content-Length": String(10 * 1024 * 1024 + 1),
                },
              },
              (response) => {
                response.resume();
                response.once("end", () => resolve(response.statusCode ?? 0));
              },
            );
            request.once("error", reject);
            request.end();
          });
          expect(oversizedStatus).toBe(413);
          expect(fs.readdirSync(attachmentsDir)).toEqual([]);

          const bearerResponse = await fetch(url, {
            method: "POST",
            headers: { Authorization: "Bearer bearer-token" },
            body: Uint8Array.from([1]),
          });
          const bearerPayload = (await bearerResponse.json()) as {
            readonly error?: unknown;
            readonly id?: unknown;
          };
          expect(bearerResponse.status, JSON.stringify(bearerPayload)).toBe(201);
          expect(bearerPayload).toEqual(expect.objectContaining({ type: "image", sizeBytes: 1 }));
          expect(
            fs
              .readdirSync(path.join(attachmentsDir, "objects"), { recursive: true })
              .some((entry) => String(entry).endsWith(`${String(bearerPayload.id)}.png`)),
          ).toBe(true);
          expect(fs.readdirSync(path.join(attachmentsDir, ".staging"))).toEqual([]);

          const cancel = () =>
            fetch(`${serverOrigin}${ATTACHMENT_CANCEL_ROUTE_PATH}`, {
              method: "POST",
              headers: {
                Authorization: "Bearer bearer-token",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ attachmentId: bearerPayload.id }),
            });
          expect((await cancel()).status).toBe(200);
          expect((await cancel()).status).toBe(200);
        },
        binaryUploadEffectRouteLayer,
      );
    } finally {
      fs.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });
});

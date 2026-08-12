import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vitest";

import { ServerAuth, type ServerAuthShape } from "./auth/Services/ServerAuth";
import {
  resolveDefaultChatWorkspaceRoot,
  resolveDefaultStudioWorkspaceRoot,
  ServerConfig,
  type ServerConfigShape,
} from "./config";
import {
  editorIconEffectRouteLayer,
  isLegacyTokenAuthorized,
  makeDesktopShutdownEffectRouteLayer,
  makeHealthEffectRouteLayer,
  projectFaviconEffectRouteLayer,
  staticAndDevEffectRouteLayer,
} from "./http";
import {
  ProjectFaviconResolver,
  type ProjectFaviconResolverShape,
} from "./project/Services/ProjectFaviconResolver";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./orchestration/Services/OrchestrationEngine";
import type { ServerReadiness } from "./server/readiness";
import {
  DESKTOP_SHUTDOWN_ROUTE_PATH,
  makeServerShutdownController,
  type ServerShutdownController,
} from "./serverShutdown";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeConfig(overrides: Partial<ServerConfigShape> = {}): ServerConfigShape {
  const baseDir = makeTempDir("synara-effect-http-");
  return {
    mode: "web",
    port: 0,
    host: "127.0.0.1",
    cwd: baseDir,
    homeDir: os.homedir(),
    chatWorkspaceRoot: resolveDefaultChatWorkspaceRoot({ homeDir: os.homedir() }),
    studioWorkspaceRoot: resolveDefaultStudioWorkspaceRoot({ homeDir: os.homedir() }),
    baseDir,
    keybindingsConfigPath: path.join(baseDir, "keybindings.json"),
    serverRuntimeStatePath: path.join(baseDir, "runtime.json"),
    serverSettingsPath: path.join(baseDir, "settings.json"),
    attachmentsDir: path.join(baseDir, "attachments"),
    sqlitePath: path.join(baseDir, "state.sqlite"),
    staticDir: undefined,
    devUrl: undefined,
    publicUrl: undefined,
    allowInsecureRemote: false,
    noBrowser: true,
    authToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logProviderEvents: false,
    logWebSocketEvents: false,
    ...overrides,
  } as ServerConfigShape;
}

const readiness: ServerReadiness = {
  awaitServerReady: Effect.void,
  markHttpListening: Effect.void,
  markPushBusReady: Effect.void,
  markKeybindingsReady: Effect.void,
  markTerminalSubscriptionsReady: Effect.void,
  markOrchestrationSubscriptionsReady: Effect.void,
  getSnapshot: Effect.succeed({
    httpListening: true,
    pushBusReady: true,
    keybindingsReady: true,
    terminalSubscriptionsReady: false,
    orchestrationSubscriptionsReady: false,
    startupReady: false,
  }),
};

const serverAuth = {
  authenticateHttpRequest: () =>
    Effect.succeed({
      sessionId: "11111111-1111-4111-8111-111111111111" as never,
      subject: "test-owner",
      method: "browser-session-cookie" as const,
      role: "owner" as const,
      credentialSource: "cookie" as const,
    }),
} as unknown as ServerAuthShape;

const projectFaviconResolver: ProjectFaviconResolverShape = {
  resolvePath: () => Effect.succeed(null),
};

const healthyOrchestrationEngine = {
  getProjectionCatchUpStatus: Effect.succeed({
    state: "healthy" as const,
    inFlight: false,
    retryAttempts: 0,
    lastFailure: null,
    highWaterSequence: 0,
    lagByProjector: {},
    missingProjectors: [],
  }),
} as unknown as OrchestrationEngineShape;

type TestedRoute =
  | { readonly kind: "health"; readonly readiness: typeof readiness }
  | { readonly kind: "shutdown"; readonly controller: ServerShutdownController }
  | { readonly kind: "static" }
  | { readonly kind: "favicon" }
  | { readonly kind: "editor-icon" };

async function withEffectServer(
  config: ServerConfigShape,
  route: TestedRoute,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  let nodeServer: http.Server | null = null;
  try {
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
          if (route.kind === "static") {
            yield* httpServer.serve(yield* HttpRouter.toHttpEffect(staticAndDevEffectRouteLayer));
          } else if (route.kind === "shutdown") {
            yield* httpServer.serve(
              yield* HttpRouter.toHttpEffect(makeDesktopShutdownEffectRouteLayer(route.controller)),
            );
          } else if (route.kind === "favicon") {
            yield* httpServer.serve(yield* HttpRouter.toHttpEffect(projectFaviconEffectRouteLayer));
          } else if (route.kind === "editor-icon") {
            yield* httpServer.serve(yield* HttpRouter.toHttpEffect(editorIconEffectRouteLayer));
          } else {
            yield* httpServer.serve(
              yield* HttpRouter.toHttpEffect(makeHealthEffectRouteLayer(route.readiness)),
            );
          }
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(ServerConfig, config),
              Layer.succeed(ServerAuth, serverAuth),
              Layer.succeed(ProjectFaviconResolver, projectFaviconResolver),
              Layer.succeed(OrchestrationEngineService, healthyOrchestrationEngine),
              NodeHttpServer.layerHttpServices,
            ),
          ),
        ),
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

describe("production Effect HTTP routes", () => {
  it("preserves the loopback-only startup-token policy", () => {
    const loopback = makeConfig({ authToken: "desktop-secret" });
    expect(
      isLegacyTokenAuthorized({
        config: loopback,
        url: new URL("http://127.0.0.1/attachments/id?token=desktop-secret"),
      }),
    ).toBe(true);
    expect(
      isLegacyTokenAuthorized({
        config: { ...loopback, host: "0.0.0.0", allowInsecureRemote: true },
        url: new URL("http://192.168.1.50/attachments/id?token=desktop-secret"),
      }),
    ).toBe(false);
    expect(
      isLegacyTokenAuthorized({
        config: { ...loopback, publicUrl: new URL("https://synara.example.test/") },
        url: new URL("http://127.0.0.1/attachments/id?token=desktop-secret"),
      }),
    ).toBe(false);
  });

  it("serves readiness through the deployed health route", async () => {
    await withEffectServer(makeConfig(), { kind: "health", readiness }, async (origin) => {
      const response = await fetch(`${origin}/health`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        readonly projection: Record<string, unknown>;
      };
      expect(body).toMatchObject({
        status: "ok",
        startupReady: false,
        pushBusReady: true,
        projection: { state: "healthy", hasFailure: false },
      });
      // /health is unauthenticated: failure detail (which can embed raw event
      // payloads via pretty-printed decode causes) must never cross this route.
      expect(body.projection).not.toHaveProperty("lastFailure");
    });
  });

  it("accepts and idempotently replays the dedicated desktop shutdown request", async () => {
    const shutdownToken = "a".repeat(64);
    const controller = await Effect.runPromise(makeServerShutdownController());
    await withEffectServer(
      makeConfig({
        mode: "desktop",
        desktopShutdownToken: shutdownToken,
        authToken: "browser-token",
      }),
      { kind: "shutdown", controller },
      async (origin) => {
        for (let requestIndex = 0; requestIndex < 2; requestIndex += 1) {
          const response = await fetch(`${origin}${DESKTOP_SHUTDOWN_ROUTE_PATH}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${shutdownToken}` },
          });
          expect(response.status).toBe(202);
          await expect(response.json()).resolves.toEqual({ accepted: true });
        }
      },
    );

    await Effect.runPromise(controller.stopSignal);
    await expect(Effect.runPromise(controller.requestStop)).resolves.toBe(false);
  });

  it("rejects browser authority, query, cookie, missing, malformed, and wrong tokens", async () => {
    const shutdownToken = "a".repeat(64);
    const controller = await Effect.runPromise(makeServerShutdownController());
    await withEffectServer(
      makeConfig({
        mode: "desktop",
        desktopShutdownToken: shutdownToken,
        authToken: "browser-token",
      }),
      { kind: "shutdown", controller },
      async (origin) => {
        const requests: ReadonlyArray<RequestInit | undefined> = [
          undefined,
          { method: "POST", headers: { Authorization: `Bearer ${"b".repeat(64)}` } },
          { method: "POST", headers: { Authorization: "Basic browser-token" } },
          { method: "POST", headers: { Authorization: "Bearer browser-token" } },
          { method: "POST", headers: { Cookie: "synara_session=browser-session" } },
        ];

        for (const request of requests) {
          const requestOptions = request ? { method: "POST", ...request } : { method: "POST" };
          const response = await fetch(
            `${origin}${DESKTOP_SHUTDOWN_ROUTE_PATH}?token=${shutdownToken}`,
            requestOptions,
          );
          expect(response.status).toBe(401);
          expect(response.headers.get("www-authenticate")).toContain("Bearer");
        }
      },
    );

    await expect(Effect.runPromise(controller.requestStop)).resolves.toBe(true);
  });

  it("keeps the route unavailable outside a private desktop loopback deployment", async () => {
    const shutdownToken = "a".repeat(64);
    const unsafeConfigs: ReadonlyArray<Partial<ServerConfigShape>> = [
      { mode: "web" },
      { mode: "desktop", host: "0.0.0.0", allowInsecureRemote: true },
      { mode: "desktop", host: "192.168.1.50", allowInsecureRemote: true },
      { mode: "desktop", publicUrl: new URL("https://synara.example.test/") },
      { mode: "desktop", desktopShutdownToken: undefined },
    ];

    for (const overrides of unsafeConfigs) {
      const controller = await Effect.runPromise(makeServerShutdownController());
      await withEffectServer(
        makeConfig({ desktopShutdownToken: shutdownToken, ...overrides }),
        { kind: "shutdown", controller },
        async (origin) => {
          const response = await fetch(`${origin}${DESKTOP_SHUTDOWN_ROUTE_PATH}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${shutdownToken}` },
          });
          expect(response.status).toBe(404);
        },
      );
      await expect(Effect.runPromise(controller.requestStop)).resolves.toBe(true);
    }
  });

  it("does not register GET or OPTIONS shutdown handlers", async () => {
    const shutdownToken = "a".repeat(64);
    const controller = await Effect.runPromise(makeServerShutdownController());
    await withEffectServer(
      makeConfig({ mode: "desktop", desktopShutdownToken: shutdownToken }),
      { kind: "shutdown", controller },
      async (origin) => {
        for (const method of ["GET", "OPTIONS"]) {
          const response = await fetch(`${origin}${DESKTOP_SHUTDOWN_ROUTE_PATH}`, { method });
          expect(response.status).toBe(404);
        }
      },
    );
  });

  it("preserves dev redirect, static file, and SPA fallback behavior", async () => {
    await withEffectServer(
      makeConfig({ devUrl: new URL("http://localhost:5173/") }),
      { kind: "static" },
      async (origin) => {
        const response = await fetch(`${origin}/chat`, { redirect: "manual" });
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("http://localhost:5173/");
      },
    );

    const staticDir = makeTempDir("synara-effect-static-");
    mkdirSync(path.join(staticDir, "assets"), { recursive: true });
    writeFileSync(path.join(staticDir, "index.html"), "<main>Synara shell</main>");
    writeFileSync(path.join(staticDir, "assets", "app.js"), "globalThis.synara = true;");
    await withEffectServer(makeConfig({ staticDir }), { kind: "static" }, async (origin) => {
      const asset = await fetch(`${origin}/assets/app.js`);
      expect(asset.status).toBe(200);
      await expect(asset.text()).resolves.toContain("globalThis.synara");

      const fallback = await fetch(`${origin}/chat/thread-id`);
      expect(fallback.status).toBe(200);
      expect(fallback.headers.get("content-type")).toContain("text/html");
      await expect(fallback.text()).resolves.toContain("Synara shell");
    });
  });

  it("serves precompressed sidecars by Accept-Encoding with identity fallback", async () => {
    const staticDir = makeTempDir("synara-effect-static-");
    mkdirSync(path.join(staticDir, "assets"), { recursive: true });
    const source = "globalThis.synara = true;".repeat(64);
    writeFileSync(path.join(staticDir, "assets", "app-abc123.js"), source);
    writeFileSync(path.join(staticDir, "assets", "app-abc123.js.gz"), zlib.gzipSync(source));
    writeFileSync(
      path.join(staticDir, "assets", "app-abc123.js.br"),
      zlib.brotliCompressSync(source),
    );
    writeFileSync(path.join(staticDir, "assets", "plain-def456.js"), source);

    await withEffectServer(makeConfig({ staticDir }), { kind: "static" }, async (origin) => {
      const brotli = await fetch(`${origin}/assets/app-abc123.js`, {
        headers: { "accept-encoding": "gzip, br" },
      });
      expect(brotli.status).toBe(200);
      expect(brotli.headers.get("content-encoding")).toBe("br");
      expect(brotli.headers.get("content-type")).toContain("javascript");
      expect(brotli.headers.get("vary")).toBe("Accept-Encoding");
      await expect(brotli.text()).resolves.toBe(source);

      const gzipOnly = await fetch(`${origin}/assets/app-abc123.js`, {
        headers: { "accept-encoding": "gzip, br;q=0" },
      });
      expect(gzipOnly.headers.get("content-encoding")).toBe("gzip");
      await expect(gzipOnly.text()).resolves.toBe(source);

      const identity = await fetch(`${origin}/assets/app-abc123.js`, {
        headers: { "accept-encoding": "identity" },
      });
      expect(identity.headers.get("content-encoding")).toBeNull();
      expect(identity.headers.get("vary")).toBe("Accept-Encoding");
      await expect(identity.text()).resolves.toBe(source);

      // No sidecar on disk: fall back to identity even when compression is accepted.
      const noSidecar = await fetch(`${origin}/assets/plain-def456.js`, {
        headers: { "accept-encoding": "gzip, br" },
      });
      expect(noSidecar.status).toBe(200);
      expect(noSidecar.headers.get("content-encoding")).toBeNull();
      await expect(noSidecar.text()).resolves.toBe(source);

      // A specific q=0 exclusion outranks the wildcard.
      const excludedBrotli = await fetch(`${origin}/assets/app-abc123.js`, {
        headers: { "accept-encoding": "br;q=0, *" },
      });
      expect(excludedBrotli.headers.get("content-encoding")).toBe("gzip");
      await expect(excludedBrotli.text()).resolves.toBe(source);

      // Sidecars are a negotiation detail, not addressable resources.
      for (const direct of ["/assets/app-abc123.js.br", "/assets/app-abc123.js.gz"]) {
        const response = await fetch(`${origin}${direct}`);
        expect(response.status, direct).toBe(404);
      }
    });
  });

  it("refuses symlinks that escape the static root", async () => {
    const parentDir = makeTempDir("synara-effect-static-");
    const staticDir = path.join(parentDir, "static");
    mkdirSync(path.join(staticDir, "assets"), { recursive: true });
    writeFileSync(path.join(staticDir, "index.html"), "<main>Synara shell</main>");
    const secretPath = path.join(parentDir, "secret.js");
    writeFileSync(secretPath, "outside root");
    writeFileSync(`${secretPath}.gz`, zlib.gzipSync("outside root"));
    // Lexically inside the root, physically outside it — the guard must
    // canonicalize before opening rather than trusting the prefix.
    symlinkSync(secretPath, path.join(staticDir, "assets", "leak.js"));
    symlinkSync(`${secretPath}.gz`, path.join(staticDir, "assets", "leak-sidecar.js.gz"));
    writeFileSync(path.join(staticDir, "assets", "leak-sidecar.js"), "inside root");

    await withEffectServer(makeConfig({ staticDir }), { kind: "static" }, async (origin) => {
      // The escaping source is refused outright — the containment check runs
      // before any read, so the link target's bytes never reach the response.
      const escaped = await fetch(`${origin}/assets/leak.js`);
      const escapedBody = await escaped.text();
      expect(escaped.status).toBe(500);
      expect(escapedBody).not.toContain("outside root");

      // A sidecar that escapes is skipped; the in-root source is still served.
      const sidecarEscape = await fetch(`${origin}/assets/leak-sidecar.js`, {
        headers: { "accept-encoding": "gzip" },
      });
      expect(sidecarEscape.headers.get("content-encoding")).toBeNull();
      await expect(sidecarEscape.text()).resolves.toBe("inside root");
    });
  });

  it("returns 406 when no acceptable encoding exists and identity is excluded", async () => {
    const staticDir = makeTempDir("synara-effect-static-");
    mkdirSync(path.join(staticDir, "assets"), { recursive: true });
    const source = "globalThis.synara = true;".repeat(64);
    writeFileSync(path.join(staticDir, "index.html"), "<main>Synara shell</main>");
    writeFileSync(path.join(staticDir, "assets", "plain-def456.js"), source);

    await withEffectServer(makeConfig({ staticDir }), { kind: "static" }, async (origin) => {
      // No sidecars on disk and identity refused: nothing is servable.
      const refused = await fetch(`${origin}/assets/plain-def456.js`, {
        headers: { "accept-encoding": "identity;q=0" },
      });
      expect(refused.status).toBe(406);
      expect(refused.headers.get("vary")).toBe("Accept-Encoding");

      // Same exclusion, but a sidecar the client accepts exists → 200.
      writeFileSync(path.join(staticDir, "assets", "plain-def456.js.gz"), zlib.gzipSync(source));
      const served = await fetch(`${origin}/assets/plain-def456.js`, {
        headers: { "accept-encoding": "gzip, identity;q=0" },
      });
      expect(served.status).toBe(200);
      expect(served.headers.get("content-encoding")).toBe("gzip");
    });
  });

  it("revalidates with ETags and answers matching conditionals with 304", async () => {
    const staticDir = makeTempDir("synara-effect-static-");
    mkdirSync(path.join(staticDir, "assets"), { recursive: true });
    const source = "globalThis.synara = true;".repeat(64);
    writeFileSync(path.join(staticDir, "index.html"), "<main>Synara shell</main>");
    writeFileSync(path.join(staticDir, "assets", "app-abc123.js"), source);
    writeFileSync(path.join(staticDir, "assets", "app-abc123.js.gz"), zlib.gzipSync(source));

    await withEffectServer(makeConfig({ staticDir }), { kind: "static" }, async (origin) => {
      const first = await fetch(`${origin}/`);
      const etag = first.headers.get("etag");
      expect(etag).toMatch(/^W\//);

      const revalidated = await fetch(`${origin}/`, {
        headers: { "if-none-match": etag! },
      });
      expect(revalidated.status).toBe(304);
      await expect(revalidated.text()).resolves.toBe("");

      // Validators must differ per served encoding: the gzip variant's ETag
      // cannot satisfy an identity conditional and vice versa.
      const gzipResponse = await fetch(`${origin}/assets/app-abc123.js`, {
        headers: { "accept-encoding": "gzip" },
      });
      const gzipEtag = gzipResponse.headers.get("etag");
      const identityResponse = await fetch(`${origin}/assets/app-abc123.js`, {
        headers: { "accept-encoding": "identity" },
      });
      expect(gzipEtag).not.toBeNull();
      expect(identityResponse.headers.get("etag")).not.toBe(gzipEtag);

      const gzipRevalidated = await fetch(`${origin}/assets/app-abc123.js`, {
        headers: { "accept-encoding": "gzip", "if-none-match": gzipEtag! },
      });
      expect(gzipRevalidated.status).toBe(304);
    });
  });

  it("marks hashed assets immutable and keeps index.html revalidating", async () => {
    const staticDir = makeTempDir("synara-effect-static-");
    mkdirSync(path.join(staticDir, "assets"), { recursive: true });
    writeFileSync(path.join(staticDir, "index.html"), "<main>Synara shell</main>");
    writeFileSync(path.join(staticDir, "assets", "app-abc123.js"), "globalThis.synara = true;");

    await withEffectServer(makeConfig({ staticDir }), { kind: "static" }, async (origin) => {
      const asset = await fetch(`${origin}/assets/app-abc123.js`);
      expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

      const index = await fetch(`${origin}/`);
      expect(index.headers.get("cache-control")).toBe("no-cache");
      expect(index.headers.get("content-type")).toContain("text/html");

      const spaFallback = await fetch(`${origin}/chat/thread-id`);
      expect(spaFallback.headers.get("cache-control")).toBe("no-cache");
    });
  });

  it("rejects traversal attempts including sidecar-shaped paths", async () => {
    const parentDir = makeTempDir("synara-effect-static-");
    const staticDir = path.join(parentDir, "static");
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(path.join(staticDir, "index.html"), "<main>Synara shell</main>");
    writeFileSync(path.join(parentDir, "secret.js"), "outside root");
    writeFileSync(path.join(parentDir, "secret.js.gz"), zlib.gzipSync("outside root"));
    writeFileSync(path.join(parentDir, "secret.js.br"), zlib.brotliCompressSync("outside root"));

    // fetch() normalizes dot segments away client-side; send the raw request
    // path so the server's own guard is what gets exercised.
    const rawRequest = (origin: string, rawPath: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const { hostname, port } = new URL(origin);
        const request = http.request(
          { hostname, port, path: rawPath, headers: { "accept-encoding": "gzip, br" } },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("latin1"),
              }),
            );
          },
        );
        request.on("error", reject);
        request.end();
      });

    await withEffectServer(makeConfig({ staticDir }), { kind: "static" }, async (origin) => {
      // Dot segments are stripped by URL parsing before the path guard runs,
      // and percent-encoded separators stay literal filename characters — both
      // must resolve inside the root (shell fallback) or be rejected outright,
      // never reach the sibling secret or its sidecars.
      // Sidecar-shaped request paths 404 outright (they are never addressable),
      // which also removes them as a traversal target.
      for (const traversal of [
        "/../secret.js",
        "/../secret.js.gz",
        "/../secret.js.br",
        "/assets/../../secret.js.gz",
        "/..%2Fsecret.js.gz",
        "/assets/..%2f..%2fsecret.js.br",
        "/%2e%2e/secret.js.br",
      ]) {
        const response = await rawRequest(origin, traversal);
        expect([200, 400, 404], traversal).toContain(response.status);
        expect(response.body, traversal).not.toContain("outside root");
        if (response.status === 200) {
          expect(response.body, traversal).toContain("Synara shell");
        }
      }
    });
  });

  it("uses the deployed favicon and editor-icon routes before static fallback", async () => {
    await withEffectServer(makeConfig(), { kind: "favicon" }, async (origin) => {
      const fallback = await fetch(`${origin}/api/project-favicon?cwd=/missing`);
      expect(fallback.status).toBe(200);
      expect(fallback.headers.get("content-type")).toContain("image/svg+xml");

      const noFallback = await fetch(`${origin}/api/project-favicon?cwd=/missing&fallback=none`);
      expect(noFallback.status).toBe(204);
    });

    await withEffectServer(makeConfig(), { kind: "editor-icon" }, async (origin) => {
      const response = await fetch(`${origin}/api/editor-icon`);
      expect(response.status).toBe(400);
      await expect(response.text()).resolves.toBe("Missing id parameter");
    });
  });
});

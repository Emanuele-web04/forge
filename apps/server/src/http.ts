import nodePath from "node:path";

import Mime from "@effect/platform-node/Mime";
import {
  AuthBootstrapInput,
  AuthCreatePairingCredentialInput,
  AuthRevokeClientSessionInput,
  AuthRevokePairingLinkInput,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES,
  ThreadId,
} from "@synara/contracts";
import {
  ATTACHMENT_CANCEL_ROUTE_PATH,
  ATTACHMENT_UPLOAD_ROUTE_PATH,
  VOICE_TRANSCRIPTION_UPLOAD_ROUTE_PATH,
} from "@synara/shared/binaryTransfer";
import { EDITOR_ICON_ROUTE_PATH } from "@synara/shared/editorIcons";
import { threadExportBlockedReason } from "@synara/shared/threadExport";
import { Cause, DateTime, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths";
import { resolveAttachmentPathById } from "./attachmentStore.ts";
import { authErrorResponse, makeEffectAuthRequest } from "./auth/effectHttp";
import { AuthError, ServerAuth } from "./auth/Services/ServerAuth";
import { SessionCredentialService } from "./auth/Services/SessionCredentialService";
import { deriveAuthClientMetadata } from "./auth/utils";
import { ServerConfig, type ServerConfigShape } from "./config";
import { resolveCachedEditorIcon } from "./editorAppIcons";
import { LOCAL_IMAGE_ROUTE_PATH, resolveAllowedLocalPreviewFile } from "./localImageFiles.ts";
import { ProjectFaviconResolver } from "./project/Services/ProjectFaviconResolver";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { ProviderAdapterRegistry } from "./provider/Services/ProviderAdapterRegistry";
import { threadArchiveChunks, threadArchiveFileName } from "./orchestration/exportThreadArchive";
import type { ServerReadiness } from "./server/readiness";
import { isLoopbackHost } from "./startupAccess";
import {
  attachmentPrincipalForSession,
  LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
} from "./managedAttachmentPrincipal";
import {
  persistReservedManagedAttachment,
  reserveManagedAttachmentUpload,
} from "./managedAttachmentStore";
import { ManagedAttachmentRepository } from "./persistence/Services/ManagedAttachments";
import {
  authorizeDesktopShutdown,
  DESKTOP_SHUTDOWN_ROUTE_PATH,
  type ServerShutdownController,
} from "./serverShutdown";
import { resolveFavicon, tryParseHost } from "./siteFaviconCache";
import {
  ifNoneMatchSatisfies,
  isSidecarRequestPath,
  negotiateStaticEncodingPreference,
  staticCacheControl,
  staticEtag,
} from "./staticAssets";
import {
  isTrustedAppOrigin,
  normalizeCorsOrigin,
  shouldRejectAuthMutationOrigin,
} from "./trustedOrigins";
import {
  VOICE_UPLOAD_CAPACITY_ERROR_MESSAGE,
  voiceUploadAdmissionGate,
} from "./voiceUploadAdmission";

const PROJECT_FAVICON_CACHE_CONTROL = "public, max-age=3600";
const SITE_FAVICON_CACHE_CONTROL_SUCCESS = "public, max-age=86400"; // 24 h
const SITE_FAVICON_CACHE_CONTROL_FALLBACK = "public, max-age=3600"; // 1 h (negative result)
const EDITOR_ICON_CACHE_CONTROL_SUCCESS = "public, max-age=86400"; // 24 h
const SVG_DOCUMENT_SECURITY_HEADERS = {
  "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
  "X-Content-Type-Options": "nosniff",
} as const;
export const AUTH_JSON_BODY_MAX_BYTES = 16 * 1024;
const decodeBootstrapInput = Schema.decodeUnknownEffect(AuthBootstrapInput);
const decodeCreatePairingCredentialInput = Schema.decodeUnknownEffect(
  AuthCreatePairingCredentialInput,
);
const decodeRevokePairingLinkInput = Schema.decodeUnknownEffect(AuthRevokePairingLinkInput);
const decodeRevokeClientSessionInput = Schema.decodeUnknownEffect(AuthRevokeClientSessionInput);

function resolveEditorIconCacheDir(config: ServerConfigShape): string {
  return nodePath.join(config.stateDir, "app-icons");
}

function resolveEditorIconEnv(config: ServerConfigShape): NodeJS.ProcessEnv {
  return { ...process.env, HOME: config.homeDir };
}

interface HttpPayload {
  readonly statusCode: number;
  readonly contentType: string;
  readonly headers?: Record<string, string>;
  readonly body: string | Uint8Array;
}

// Shared by the Effect route and the legacy request listener so editor-icon
// behavior cannot drift between the two HTTP stacks.
const resolveEditorIconHttpPayload = Effect.fn(function* (input: {
  readonly url: URL;
  readonly serverConfig: ServerConfigShape;
  readonly fileSystem: FileSystem.FileSystem;
}) {
  const editorId = input.url.searchParams.get("id");
  if (!editorId) {
    return {
      statusCode: 400,
      contentType: "text/plain",
      body: "Missing id parameter",
    } satisfies HttpPayload;
  }

  const icon = yield* Effect.promise(() =>
    resolveCachedEditorIcon({
      editorId,
      cacheDir: resolveEditorIconCacheDir(input.serverConfig),
      env: resolveEditorIconEnv(input.serverConfig),
    }),
  );
  if (!icon) {
    return {
      statusCode: 404,
      contentType: "text/plain",
      body: "Not Found",
    } satisfies HttpPayload;
  }

  const data = yield* input.fileSystem
    .readFile(icon.path)
    .pipe(Effect.catch(() => Effect.succeed(null)));
  if (!data) {
    return {
      statusCode: 404,
      contentType: "text/plain",
      body: "Not Found",
    } satisfies HttpPayload;
  }

  return {
    statusCode: 200,
    contentType: icon.contentType,
    headers: { "Cache-Control": EDITOR_ICON_CACHE_CONTROL_SUCCESS },
    body: data,
  } satisfies HttpPayload;
});

function toEffectHttpResponse(payload: HttpPayload) {
  if (typeof payload.body === "string") {
    return HttpServerResponse.text(payload.body, {
      status: payload.statusCode,
      contentType: payload.contentType,
      ...(payload.headers ? { headers: payload.headers } : {}),
    });
  }

  return HttpServerResponse.uint8Array(payload.body, {
    status: payload.statusCode,
    contentType: payload.contentType,
    ...(payload.headers ? { headers: payload.headers } : {}),
  });
}

function localPreviewCorsHeaders(input: {
  readonly config: ServerConfigShape;
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly url: URL;
}): Record<string, string> {
  const origin = normalizeCorsOrigin(input.request.headers.origin);
  if (
    !origin ||
    !isTrustedAppOrigin({ origin, requestOrigin: input.url.origin, config: input.config })
  ) {
    return {};
  }
  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
  };
}

export function makeEffectHttpRouteLayer(
  readiness: ServerReadiness,
  shutdownController: ServerShutdownController,
) {
  return Layer.mergeAll(
    makeHealthEffectRouteLayer(readiness),
    makeDesktopShutdownEffectRouteLayer(shutdownController),
    authEffectRouteLayer,
    projectFaviconEffectRouteLayer,
    threadExportEffectRouteLayer,
    siteFaviconEffectRouteLayer,
    editorIconEffectRouteLayer,
    localImageEffectRouteLayer,
    binaryUploadEffectRouteLayer,
    attachmentsEffectRouteLayer,
    staticAndDevEffectRouteLayer,
  );
}

export function makeDesktopShutdownEffectRouteLayer(shutdownController: ServerShutdownController) {
  return HttpRouter.add(
    "POST",
    DESKTOP_SHUTDOWN_ROUTE_PATH,
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const config = yield* ServerConfig;
      const authorization = authorizeDesktopShutdown({
        config,
        remoteAddress: request.remoteAddress,
        authorization: request.headers.authorization,
      });

      if (!authorization.authorized) {
        return HttpServerResponse.jsonUnsafe(
          { error: authorization.reason === "unavailable" ? "Not Found" : "Unauthorized" },
          {
            status: authorization.status,
            ...(authorization.status === 401
              ? { headers: { "WWW-Authenticate": 'Bearer realm="synara-desktop-shutdown"' } }
              : {}),
          },
        );
      }

      yield* shutdownController.requestStop;
      return HttpServerResponse.jsonUnsafe({ accepted: true }, { status: 202 });
    }),
  );
}

export function makeHealthEffectRouteLayer(readiness: ServerReadiness) {
  return HttpRouter.add(
    "GET",
    "/health",
    readiness.getSnapshot.pipe(
      Effect.map((snapshot) =>
        HttpServerResponse.jsonUnsafe(
          {
            status: "ok",
            startupReady: snapshot.startupReady,
            pushBusReady: snapshot.pushBusReady,
            keybindingsReady: snapshot.keybindingsReady,
            terminalSubscriptionsReady: snapshot.terminalSubscriptionsReady,
            orchestrationSubscriptionsReady: snapshot.orchestrationSubscriptionsReady,
          },
          { status: 200 },
        ),
      ),
    ),
  );
}

const requireAuthenticatedRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  yield* serverAuth.authenticateHttpRequest(makeEffectAuthRequest(request));
});

const requireAuthenticatedMutationRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (!url) return yield* Effect.fail({ message: "Bad Request", status: 400 as const });
  const config = yield* ServerConfig;
  const serverAuth = yield* ServerAuth;
  const session = yield* serverAuth.authenticateHttpRequest(makeEffectAuthRequest(request));
  if (
    shouldRejectAuthMutationOrigin({
      rawOrigin: request.headers.origin,
      requestOrigin: url.origin,
      config,
      credentialSource: session.credentialSource,
    })
  ) {
    return yield* Effect.fail({
      message: "Trusted request origin required.",
      status: 403 as const,
    });
  }
  return session;
});

function trustedMutationCorsHeaders(input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly url: URL;
  readonly config: ServerConfigShape;
}): Record<string, string> | null {
  const origin = normalizeCorsOrigin(input.request.headers.origin);
  if (!origin) return {};
  if (!isTrustedAppOrigin({ origin, requestOrigin: input.url.origin, config: input.config })) {
    return null;
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

export function isLegacyTokenAuthorized(input: {
  readonly config: ServerConfigShape;
  readonly url: URL;
}): boolean {
  if (!isLoopbackHost(input.config.host) || input.config.publicUrl) {
    return false;
  }
  const legacyToken = input.url.searchParams.get("token");
  return !input.config.authToken || legacyToken === input.config.authToken;
}

function encodeCookie(input: {
  readonly name: string;
  readonly value: string;
  readonly expiresAt: DateTime.DateTime;
  readonly secure: boolean;
}) {
  return `${encodeURIComponent(input.name)}=${encodeURIComponent(input.value)}; Expires=${DateTime.toDate(input.expiresAt).toUTCString()}; HttpOnly; Path=/; SameSite=Lax${input.secure ? "; Secure" : ""}`;
}

function encodeExpiredCookie(input: { readonly name: string; readonly secure: boolean }) {
  return `${encodeURIComponent(input.name)}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; Path=/; SameSite=Lax${input.secure ? "; Secure" : ""}`;
}

function isBodyCapacityError(cause: unknown): boolean {
  if (Cause.isExceededCapacityError(cause)) return true;
  if (cause instanceof Error && cause.message === "maxBytes exceeded") return true;
  if (!cause || typeof cause !== "object") return false;
  const record = cause as { readonly reason?: unknown; readonly cause?: unknown };
  return (
    (record.cause !== undefined && record.cause !== cause && isBodyCapacityError(record.cause)) ||
    (record.reason !== undefined && isBodyCapacityError(record.reason))
  );
}

function mapPayloadError(message: string, cause: unknown) {
  if (
    cause &&
    typeof cause === "object" &&
    "status" in cause &&
    (cause as { readonly status?: unknown }).status === 413
  ) {
    return cause as { readonly message: string; readonly status: 413; readonly cause?: unknown };
  }
  return { message, status: 400 as const, cause };
}

const readEffectJson = (
  request: HttpServerRequest.HttpServerRequest,
  message: string,
): Effect.Effect<
  unknown,
  Error | { readonly message: string; readonly status: 413; readonly cause?: unknown }
> => {
  const declaredLength = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > AUTH_JSON_BODY_MAX_BYTES) {
    return Effect.fail({
      message: "Request body too large.",
      status: 413 as const,
    });
  }
  return request.json.pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(AUTH_JSON_BODY_MAX_BYTES)),
    Effect.mapError((cause) =>
      isBodyCapacityError(cause)
        ? { message: "Request body too large.", status: 413 as const, cause }
        : new (class extends Error {
            override readonly cause = cause;
          })(message),
    ),
  );
};

const readEffectBinary = (
  request: HttpServerRequest.HttpServerRequest,
  maxBytes: number,
): Effect.Effect<
  Uint8Array,
  { readonly message: string; readonly status: number; readonly cause?: unknown }
> => {
  const declaredLength = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return Effect.fail({ message: "Request body too large.", status: 413 as const });
  }
  return request.arrayBuffer.pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(maxBytes)),
    Effect.map((buffer) => new Uint8Array(buffer)),
    Effect.mapError((cause) => ({
      message: isBodyCapacityError(cause)
        ? "Request body too large."
        : "Could not read request body.",
      status: isBodyCapacityError(cause) ? 413 : 400,
      cause,
    })),
  );
};

export const authEffectRouteLayer = HttpRouter.add(
  "*",
  "/api/auth/*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig;
    const serverAuth = yield* ServerAuth;
    const sessions = yield* SessionCredentialService;
    const url = HttpServerRequest.toURL(request);
    if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });
    const authRequest = makeEffectAuthRequest(request);

    if (request.method === "GET" && url.pathname === "/api/auth/session") {
      return HttpServerResponse.jsonUnsafe(yield* serverAuth.getSessionState(authRequest));
    }

    if (request.method === "POST" && url.pathname === "/api/auth/bootstrap") {
      const payload = yield* readEffectJson(request, "Invalid bootstrap payload.").pipe(
        Effect.flatMap(decodeBootstrapInput),
        Effect.mapError((cause) => mapPayloadError("Invalid bootstrap payload.", cause)),
      );
      const result = yield* serverAuth.exchangeBootstrapCredential(payload.credential, {
        ...deriveAuthClientMetadata({
          headers: request.headers,
          remoteAddress: request.remoteAddress ?? null,
        }),
      });
      return HttpServerResponse.jsonUnsafe(result.response, {
        headers: {
          "Set-Cookie": encodeCookie({
            name: sessions.cookieName,
            value: result.sessionToken,
            expiresAt: result.response.expiresAt,
            secure: config.publicUrl !== undefined,
          }),
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/api/auth/bootstrap/bearer") {
      const payload = yield* readEffectJson(request, "Invalid bootstrap payload.").pipe(
        Effect.flatMap(decodeBootstrapInput),
        Effect.mapError((cause) => mapPayloadError("Invalid bootstrap payload.", cause)),
      );
      return HttpServerResponse.jsonUnsafe(
        yield* serverAuth.exchangeBootstrapCredentialForBearerSession(payload.credential, {
          ...deriveAuthClientMetadata({
            headers: request.headers,
            remoteAddress: request.remoteAddress ?? null,
          }),
        }),
      );
    }

    const authenticatedMutationSession = requireAuthenticatedMutationRequest;

    if (request.method === "POST" && url.pathname === "/api/auth/ws-token") {
      const session = yield* authenticatedMutationSession;
      return HttpServerResponse.jsonUnsafe(yield* serverAuth.issueWebSocketToken(session));
    }

    if (request.method === "POST" && url.pathname === "/api/auth/pairing-token") {
      const session = yield* authenticatedMutationSession;
      if (session.role !== "owner")
        return HttpServerResponse.jsonUnsafe(
          { error: "Only owner sessions can create pairing credentials." },
          { status: 403 },
        );
      const payload =
        Number(request.headers["content-length"] ?? "0") > 0
          ? yield* readEffectJson(request, "Invalid pairing credential payload.").pipe(
              Effect.flatMap(decodeCreatePairingCredentialInput),
              Effect.mapError((cause) =>
                mapPayloadError("Invalid pairing credential payload.", cause),
              ),
            )
          : {};
      return HttpServerResponse.jsonUnsafe(yield* serverAuth.issuePairingCredential(payload));
    }

    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      const session = yield* authenticatedMutationSession;
      return HttpServerResponse.jsonUnsafe(
        { revoked: yield* serverAuth.logoutSession(session.sessionId) },
        {
          headers: {
            "Set-Cookie": encodeExpiredCookie({
              name: sessions.cookieName,
              secure: config.publicUrl !== undefined,
            }),
          },
        },
      );
    }

    const ownerSession = Effect.gen(function* () {
      const session = yield* serverAuth.authenticateHttpRequest(authRequest);
      if (session.role !== "owner") {
        return yield* Effect.fail({
          message: "Only owner sessions can manage network access.",
          status: 403 as const,
        });
      }
      return session;
    });

    const ownerMutationSession = Effect.gen(function* () {
      const session = yield* authenticatedMutationSession;
      if (session.role !== "owner") {
        return yield* Effect.fail({
          message: "Only owner sessions can manage network access.",
          status: 403 as const,
        });
      }
      return session;
    });

    if (request.method === "GET" && url.pathname === "/api/auth/pairing-links") {
      yield* ownerSession;
      return HttpServerResponse.jsonUnsafe(yield* serverAuth.listPairingLinks());
    }

    if (request.method === "POST" && url.pathname === "/api/auth/pairing-links/revoke") {
      yield* ownerMutationSession;
      const payload = yield* readEffectJson(request, "Invalid revoke pairing link payload.").pipe(
        Effect.flatMap(decodeRevokePairingLinkInput),
        Effect.mapError((cause) => mapPayloadError("Invalid revoke pairing link payload.", cause)),
      );
      return HttpServerResponse.jsonUnsafe({
        revoked: yield* serverAuth.revokePairingLink(payload.id),
      });
    }

    if (request.method === "GET" && url.pathname === "/api/auth/clients") {
      const session = yield* ownerSession;
      return HttpServerResponse.jsonUnsafe(yield* serverAuth.listClientSessions(session.sessionId));
    }

    if (request.method === "POST" && url.pathname === "/api/auth/clients/revoke") {
      const session = yield* ownerMutationSession;
      const payload = yield* readEffectJson(request, "Invalid revoke client payload.").pipe(
        Effect.flatMap(decodeRevokeClientSessionInput),
        Effect.mapError((cause) => mapPayloadError("Invalid revoke client payload.", cause)),
      );
      return HttpServerResponse.jsonUnsafe({
        revoked: yield* serverAuth.revokeClientSession(session.sessionId, payload.sessionId),
      });
    }

    if (request.method === "POST" && url.pathname === "/api/auth/clients/revoke-others") {
      const session = yield* ownerMutationSession;
      return HttpServerResponse.jsonUnsafe({
        revokedCount: yield* serverAuth.revokeOtherClientSessions(session.sessionId),
      });
    }

    return HttpServerResponse.text("Not Found", { status: 404 });
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          {
            error:
              error instanceof Error
                ? error.message
                : String((error as { message?: unknown }).message ?? error),
          },
          {
            status:
              typeof (error as { status?: unknown }).status === "number"
                ? (error as { status: number }).status
                : 500,
          },
        ),
      ),
    ),
  ),
);

export const projectFaviconEffectRouteLayer = HttpRouter.add(
  "GET",
  "/api/project-favicon",
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest.pipe(
      Effect.catchTag("AuthError", (error) => Effect.fail(error)),
    );
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });
    const projectCwd = url.searchParams.get("cwd");
    if (!projectCwd) return HttpServerResponse.text("Missing cwd parameter", { status: 400 });
    const resolver = yield* ProjectFaviconResolver;
    const faviconPath = yield* resolver.resolvePath(projectCwd);
    if (!faviconPath) {
      if (url.searchParams.get("fallback") === "none")
        return HttpServerResponse.empty({ status: 204 });
      return HttpServerResponse.text(FALLBACK_FAVICON_SVG, {
        status: 200,
        contentType: "image/svg+xml",
        headers: {
          "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL,
          ...SVG_DOCUMENT_SECURITY_HEADERS,
        },
      });
    }
    return yield* HttpServerResponse.file(faviconPath, {
      status: 200,
      headers: {
        "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL,
        ...(nodePath.extname(faviconPath).toLowerCase() === ".svg"
          ? SVG_DOCUMENT_SECURITY_HEADERS
          : {}),
      },
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", (error) => Effect.succeed(authErrorResponse(error)))),
);

// Resolves a real website favicon by domain (cached server-side, deduped by host)
// so the UI can replace generic globe icons. Mirrors project-favicon's auth +
// SVG-fallback shape; the actual fetch/cache logic lives in siteFaviconCache.ts.
const siteFaviconEffectRouteLayer = HttpRouter.add(
  "GET",
  "/api/site-favicon",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });

    // Loaded via <img> tags, which cannot attach Authorization headers — accept the
    // same startup-token rule the local-image/attachments routes use so favicons
    // load in local dev without a session cookie.
    const config = yield* ServerConfig;
    if (!isLegacyTokenAuthorized({ config, url })) {
      yield* requireAuthenticatedRequest;
    }

    const domainParam = url.searchParams.get("domain") ?? url.searchParams.get("url");
    if (!domainParam) return HttpServerResponse.text("Missing domain parameter", { status: 400 });
    const host = tryParseHost(domainParam);
    if (!host) return HttpServerResponse.text("Invalid domain", { status: 400 });

    const favicon = yield* Effect.promise(() => resolveFavicon(host));
    if (!favicon.bytes) {
      return HttpServerResponse.text(FALLBACK_SITE_FAVICON_SVG, {
        status: 200,
        contentType: "image/svg+xml",
        headers: {
          "Cache-Control": SITE_FAVICON_CACHE_CONTROL_FALLBACK,
          ...SVG_DOCUMENT_SECURITY_HEADERS,
        },
      });
    }
    return HttpServerResponse.uint8Array(favicon.bytes, {
      status: 200,
      contentType: favicon.contentType ?? "image/x-icon",
      headers: {
        "Cache-Control": SITE_FAVICON_CACHE_CONTROL_SUCCESS,
        ...(favicon.contentType?.toLowerCase().startsWith("image/svg+xml")
          ? SVG_DOCUMENT_SECURITY_HEADERS
          : {}),
      },
    });
  }).pipe(Effect.catchTag("AuthError", (error) => Effect.succeed(authErrorResponse(error)))),
);

// Builds a ZIP export of a single thread (thread.json + transcript.md) and streams
// it back as a download. Loads only the requested thread detail so the export cost
// scales with that thread rather than the whole projection; mirrors the auth shape
// of the other binary GET routes (favicon/attachments).
const threadExportEffectRouteLayer = HttpRouter.add(
  "GET",
  "/api/thread-export",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });

    const config = yield* ServerConfig;
    if (!isLegacyTokenAuthorized({ config, url })) {
      yield* requireAuthenticatedRequest;
    }

    // Error responses need the trusted-origin CORS headers too: the desktop
    // app fetches cross-origin (synara://app), and without them the browser masks
    // a 400/404/409 body as an opaque network failure.
    const corsHeaders = localPreviewCorsHeaders({ config, request, url });

    const threadIdParam = url.searchParams.get("threadId")?.trim();
    if (!threadIdParam)
      return HttpServerResponse.text("Missing threadId parameter", {
        status: 400,
        headers: corsHeaders,
      });

    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const threadOption = yield* snapshotQuery.getThreadDetailForExportById(
      ThreadId.makeUnsafe(threadIdParam),
    );
    if (Option.isNone(threadOption))
      return HttpServerResponse.text("Not Found", { status: 404, headers: corsHeaders });
    const thread = threadOption.value;

    const blockedReason = threadExportBlockedReason(thread);
    if (blockedReason !== null) {
      return HttpServerResponse.text(blockedReason, { status: 409, headers: corsHeaders });
    }

    const fileName = threadArchiveFileName({ title: thread.title, isoTimestamp: thread.updatedAt });
    return HttpServerResponse.stream(
      Stream.fromAsyncIterable(threadArchiveChunks(thread), (cause) => cause),
      {
        status: 200,
        contentType: "application/zip",
        headers: {
          "Content-Disposition": `attachment; filename="${fileName.replaceAll('"', "")}"`,
          "Cache-Control": "no-store",
          ...corsHeaders,
          "Access-Control-Expose-Headers": "Content-Disposition",
        },
      },
    );
  }).pipe(Effect.catchTag("AuthError", (error) => Effect.succeed(authErrorResponse(error)))),
);

export const editorIconEffectRouteLayer = HttpRouter.add(
  "GET",
  EDITOR_ICON_ROUTE_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });

    const config = yield* ServerConfig;
    if (!isLegacyTokenAuthorized({ config, url })) {
      yield* requireAuthenticatedRequest;
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const payload = yield* resolveEditorIconHttpPayload({
      url,
      serverConfig: config,
      fileSystem,
    });
    return toEffectHttpResponse(payload);
  }).pipe(Effect.catchTag("AuthError", (error) => Effect.succeed(authErrorResponse(error)))),
);

// Streams a disk file as the response body instead of buffering it in memory:
// preview files can be large (PDFs especially), and a full-file buffer per
// request is an easy way to balloon server memory under concurrent loads.
// Callers must have stat'ed the file already — an unreadable file after that
// point aborts the connection mid-stream, which clients surface as a failed
// load (the same outcome the buffered 404 produced, minus the status code).
function streamedFileResponse(input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: string;
  readonly sizeBytes: number;
  readonly headers: Record<string, string>;
}): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.stream(input.fileSystem.stream(input.path), {
    status: 200,
    contentType: Mime.getType(input.path) ?? "application/octet-stream",
    contentLength: input.sizeBytes,
    headers: input.headers,
  });
}

export const localImageEffectRouteLayer = HttpRouter.add(
  "GET",
  LOCAL_IMAGE_ROUTE_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });

    const config = yield* ServerConfig;
    if (!isLegacyTokenAuthorized({ config, url })) {
      yield* requireAuthenticatedRequest;
    }

    const previewFile = yield* Effect.promise(() =>
      resolveAllowedLocalPreviewFile({
        requestedPath: url.searchParams.get("path"),
        cwd: url.searchParams.get("cwd"),
        allowAbsoluteLocalPreviewFile: true,
        previewGrant: url.searchParams.get("grant"),
      }).catch(() => null),
    );
    if (!previewFile) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    // Stream (don't use HttpServerResponse.file, which depends on
    // Etag.Generator/Path services and was failing with a 500 here).
    const fileSystem = yield* FileSystem.FileSystem;
    const isDownload = url.searchParams.get("download") === "1";
    const safeFileName = previewFile.fileName.replaceAll('"', "");
    const isSvg = nodePath.extname(previewFile.path).toLowerCase() === ".svg";
    return streamedFileResponse({
      fileSystem,
      path: previewFile.path,
      sizeBytes: previewFile.sizeBytes,
      headers: {
        "Cache-Control": "private, max-age=60",
        // The PDF viewer fetches bytes from either the desktop app origin or
        // the configured Vite dev origin. Reflect only those trusted origins:
        // auth-token-less local servers must not expose workspace files to any
        // random web page that can guess path/cwd query params.
        ...localPreviewCorsHeaders({ config, request, url }),
        // PDFs render in an unsandboxed same-origin iframe; never let the
        // browser second-guess the declared content type.
        "X-Content-Type-Options": "nosniff",
        ...(isSvg ? SVG_DOCUMENT_SECURITY_HEADERS : {}),
        ...(isDownload ? { "Content-Disposition": `attachment; filename="${safeFileName}"` } : {}),
      },
    });
  }).pipe(Effect.catchTag("AuthError", (error) => Effect.succeed(authErrorResponse(error)))),
);

const binaryUploadEffectHandler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });
  const config = yield* ServerConfig;
  const corsHeaders = trustedMutationCorsHeaders({ request, url, config });
  if (corsHeaders === null) {
    return HttpServerResponse.jsonUnsafe(
      { error: "Trusted request origin required." },
      { status: 403 },
    );
  }
  if (request.method === "OPTIONS") {
    return HttpServerResponse.empty({ status: 204, headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return HttpServerResponse.text("Method Not Allowed", { status: 405, headers: corsHeaders });
  }
  const attachmentPrincipal = isLegacyTokenAuthorized({ config, url })
    ? LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL
    : attachmentPrincipalForSession((yield* requireAuthenticatedMutationRequest).sessionId);

  if (url.pathname === ATTACHMENT_UPLOAD_ROUTE_PATH) {
    const type = url.searchParams.get("type");
    const threadId = url.searchParams.get("threadId")?.trim() ?? "";
    const name = url.searchParams.get("name") ?? "";
    const mimeType = url.searchParams.get("mimeType") ?? "";
    if ((type !== "image" && type !== "file") || !threadId || !name || !mimeType) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Attachment upload metadata is invalid." },
        { status: 400, headers: corsHeaders },
      );
    }
    const maxBytes =
      type === "image" ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
    const declaredLength = Number(request.headers["content-length"] ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Request body too large." },
        { status: 413, headers: corsHeaders },
      );
    }
    const reservedBytes =
      Number.isSafeInteger(declaredLength) && declaredLength > 0 && declaredLength <= maxBytes
        ? declaredLength
        : maxBytes;
    const repository = yield* ManagedAttachmentRepository;
    const now = new Date().toISOString();
    const reservation = yield* reserveManagedAttachmentUpload({
      type,
      threadId,
      name,
      mimeType,
      reservedBytes,
      now,
      principal: attachmentPrincipal,
      repository,
    });
    const bytes = yield* readEffectBinary(request, maxBytes).pipe(
      Effect.tapError(() =>
        repository
          .cancelStaged({
            attachmentId: reservation.attachmentId,
            ownerKind: attachmentPrincipal.ownerKind,
            ownerId: attachmentPrincipal.ownerId,
            reason: "upload-body-failed",
            requestedAt: new Date().toISOString(),
          })
          .pipe(Effect.ignore),
      ),
    );
    const attachment = yield* persistReservedManagedAttachment({
      reservation,
      bytes,
      attachmentsDir: config.attachmentsDir,
      now: new Date().toISOString(),
      principal: attachmentPrincipal,
      repository,
    });
    return HttpServerResponse.jsonUnsafe(attachment, { status: 201, headers: corsHeaders });
  }

  if (url.pathname === ATTACHMENT_CANCEL_ROUTE_PATH) {
    const payload = yield* readEffectJson(request, "Invalid attachment cancellation payload.");
    const attachmentId =
      payload && typeof payload === "object" && "attachmentId" in payload
        ? String((payload as { readonly attachmentId?: unknown }).attachmentId ?? "").trim()
        : "";
    if (!attachmentId || attachmentId.length > 128 || !/^[a-z0-9_-]+$/iu.test(attachmentId)) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Attachment cancellation payload is invalid." },
        { status: 400, headers: corsHeaders },
      );
    }
    const repository = yield* ManagedAttachmentRepository;
    const result = yield* repository.cancelStaged({
      attachmentId,
      ownerKind: attachmentPrincipal.ownerKind,
      ownerId: attachmentPrincipal.ownerId,
      reason: "client-cancelled",
      requestedAt: new Date().toISOString(),
    });
    if (result.status === "not-found") {
      return HttpServerResponse.jsonUnsafe(
        { error: "Attachment not found." },
        { status: 404, headers: corsHeaders },
      );
    }
    if (result.status === "already-claimed") {
      return HttpServerResponse.jsonUnsafe(
        { error: "Attachment is already committed." },
        { status: 409, headers: corsHeaders },
      );
    }
    return HttpServerResponse.jsonUnsafe(
      { cancelled: true },
      { status: 200, headers: corsHeaders },
    );
  }

  if (url.pathname === VOICE_TRANSCRIPTION_UPLOAD_ROUTE_PATH) {
    const provider = url.searchParams.get("provider")?.trim() ?? "";
    const cwd = url.searchParams.get("cwd")?.trim() ?? "";
    const threadId = url.searchParams.get("threadId")?.trim() || undefined;
    const mimeType = url.searchParams.get("mimeType")?.trim() ?? "";
    const sampleRateHz = Number(url.searchParams.get("sampleRateHz"));
    const durationMs = Number(url.searchParams.get("durationMs"));
    if (
      !provider ||
      !cwd ||
      !mimeType ||
      !Number.isSafeInteger(sampleRateHz) ||
      !Number.isSafeInteger(durationMs)
    ) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Voice transcription metadata is invalid." },
        { status: 400, headers: corsHeaders },
      );
    }
    const releaseUpload = voiceUploadAdmissionGate.tryAcquire();
    if (!releaseUpload) {
      return HttpServerResponse.jsonUnsafe(
        { error: VOICE_UPLOAD_CAPACITY_ERROR_MESSAGE },
        { status: 429, headers: corsHeaders },
      );
    }
    return yield* Effect.gen(function* () {
      const bytes = yield* readEffectBinary(request, SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES);
      const registry = yield* ProviderAdapterRegistry;
      const adapter = yield* registry.getByProvider(provider as never);
      if (!adapter.transcribeVoice) {
        return HttpServerResponse.jsonUnsafe(
          { error: `Voice transcription is unavailable for provider '${provider}'.` },
          { status: 400, headers: corsHeaders },
        );
      }
      const result = yield* adapter.transcribeVoice({
        provider: provider as never,
        cwd,
        ...(threadId ? { threadId: ThreadId.makeUnsafe(threadId) } : {}),
        mimeType,
        sampleRateHz,
        durationMs,
        audioBase64: Buffer.from(bytes).toString("base64"),
      });
      return HttpServerResponse.jsonUnsafe(result, { status: 200, headers: corsHeaders });
    }).pipe(Effect.ensuring(Effect.sync(releaseUpload)));
  }

  return HttpServerResponse.text("Not Found", { status: 404, headers: corsHeaders });
}).pipe(
  Effect.catch((error) =>
    Effect.succeed(
      error instanceof AuthError
        ? authErrorResponse(error)
        : HttpServerResponse.jsonUnsafe(
            {
              error:
                error instanceof Error
                  ? error.message
                  : String((error as { readonly message?: unknown }).message ?? error),
            },
            {
              status:
                typeof (error as { readonly status?: unknown }).status === "number"
                  ? (error as { readonly status: number }).status
                  : 500,
            },
          ),
    ),
  ),
);

export const binaryUploadEffectRouteLayer = Layer.merge(
  HttpRouter.add("*", ATTACHMENT_UPLOAD_ROUTE_PATH, binaryUploadEffectHandler),
  Layer.merge(
    HttpRouter.add("*", ATTACHMENT_CANCEL_ROUTE_PATH, binaryUploadEffectHandler),
    HttpRouter.add("*", VOICE_TRANSCRIPTION_UPLOAD_ROUTE_PATH, binaryUploadEffectHandler),
  ),
);

export const attachmentsEffectRouteLayer = HttpRouter.add(
  "GET",
  `${ATTACHMENTS_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });

    const config = yield* ServerConfig;
    // Desktop image tags cannot attach Authorization headers; preserve the same
    // startup token rule that the WebSocket route already accepts.
    if (!isLegacyTokenAuthorized({ config, url })) {
      yield* requireAuthenticatedRequest;
    }

    const rawRelativePath = url.pathname.slice(ATTACHMENTS_ROUTE_PREFIX.length);
    const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
    if (!normalizedRelativePath) {
      return HttpServerResponse.text("Invalid attachment path", { status: 400 });
    }
    if (
      normalizedRelativePath.startsWith("objects/") ||
      normalizedRelativePath.startsWith(".staging/")
    ) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const isIdLookup =
      !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
    const managedBlob =
      isIdLookup && normalizedRelativePath.startsWith("att_v2_")
        ? yield* (yield* ManagedAttachmentRepository).findClaimedById({
            attachmentId: normalizedRelativePath,
          })
        : Option.none();
    const filePath = Option.isSome(managedBlob)
      ? resolveAttachmentRelativePath({
          attachmentsDir: config.attachmentsDir,
          relativePath: managedBlob.value.relativePath,
        })
      : isIdLookup && !normalizedRelativePath.startsWith("att_v2_")
        ? resolveAttachmentPathById({
            attachmentsDir: config.attachmentsDir,
            attachmentId: normalizedRelativePath,
          })
        : !isIdLookup
          ? resolveAttachmentRelativePath({
              attachmentsDir: config.attachmentsDir,
              relativePath: normalizedRelativePath,
            })
          : null;
    if (!filePath) {
      return HttpServerResponse.text(isIdLookup ? "Not Found" : "Invalid attachment path", {
        status: isIdLookup ? 404 : 400,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    if (
      Option.isSome(managedBlob) &&
      managedBlob.value.sizeBytes !== null &&
      Number(fileInfo.size) !== managedBlob.value.sizeBytes
    ) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    // Mirror local-image serving instead of using HttpServerResponse.file; the Effect
    // route stack used by the desktop server can miss that helper's file services.
    return streamedFileResponse({
      fileSystem,
      path: filePath,
      sizeBytes: Number(fileInfo.size),
      // Attachment access is session/token gated and attachments are mutable
      // lifecycle resources: deletion or session revocation must take effect on
      // the next request, including when a shared proxy is present.
      headers: {
        "Cache-Control": "private, no-store",
        Pragma: "no-cache",
      },
    });
  }).pipe(Effect.catchTag("AuthError", (error) => Effect.succeed(authErrorResponse(error)))),
);

export const staticAndDevEffectRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });

    const config = yield* ServerConfig;
    if (config.devUrl) {
      return HttpServerResponse.redirect(config.devUrl.toString(), { status: 302 });
    }

    if (!config.staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(config.staticDir);
    const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const rawRelativePath = requestPath.replace(/^[/\\]+/, "");
    const relativePath = path.normalize(rawRelativePath).replace(/^[/\\]+/, "");
    if (
      relativePath.length === 0 ||
      rawRelativePath.startsWith("..") ||
      relativePath.startsWith("..") ||
      relativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }
    if (isSidecarRequestPath(relativePath)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    // Lexical containment is not containment: stat and readFile follow
    // symlinks, so a link inside the root pointing outside it would be served.
    // Canonicalize before opening anything. The root itself is canonicalized
    // too, otherwise a symlinked staticDir would fail its own check.
    const canonicalStaticRoot = yield* fileSystem
      .realPath(staticRoot)
      .pipe(Effect.catch(() => Effect.succeed(staticRoot)));
    const isWithinCanonicalRoot = (candidate: string) =>
      candidate === canonicalStaticRoot ||
      candidate.startsWith(
        canonicalStaticRoot.endsWith(path.sep)
          ? canonicalStaticRoot
          : `${canonicalStaticRoot}${path.sep}`,
      );
    const resolvesInsideRoot = Effect.fn(function* (candidate: string) {
      const real = yield* fileSystem
        .realPath(candidate)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      // A path that cannot be canonicalized does not exist; the caller's own
      // stat/readFile will fail it, and refusing here keeps 404 semantics.
      return real === null ? false : isWithinCanonicalRoot(real);
    });

    let filePath = path.resolve(staticRoot, relativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }
    if (!path.extname(filePath)) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    // Serves a resolved static file, preferring build-time .br/.gz sidecars
    // when the client accepts them. Content-Type always reflects the
    // underlying file; Vary is set even on identity responses so shared
    // caches never hand a compressed body to a client that cannot decode it.
    // Every response carries an ETag derived from the served file (sidecar's
    // when a sidecar is served, so validators differ per encoding), making
    // no-cache revalidation a 304 instead of a full re-transfer.
    const serveStaticFile = Effect.fn(function* (resolvedPath: string) {
      const cacheHeaders = {
        "Cache-Control": staticCacheControl(path.relative(staticRoot, resolvedPath)),
        Vary: "Accept-Encoding",
      };
      const ifNoneMatch = request.headers["if-none-match"];
      const baseContentType = Mime.getType(resolvedPath) ?? "application/octet-stream";
      const contentType =
        baseContentType === "text/html" ? "text/html; charset=utf-8" : baseContentType;
      const respond = Effect.fn(function* (servedPath: string, encoding?: string) {
        // Canonicalize before opening: a symlink inside the root pointing
        // outside it passes the lexical guard but must not be served.
        if (!(yield* resolvesInsideRoot(servedPath))) return null;
        const info = yield* fileSystem
          .stat(servedPath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!info || info.type !== "File") return null;
        const etag = staticEtag(Number(info.size), info.mtime?.getTime() ?? 0, encoding);
        const encodingHeaders = encoding ? { "Content-Encoding": encoding } : {};
        const headers = { ...cacheHeaders, ...encodingHeaders, ETag: etag };
        if (ifNoneMatchSatisfies(ifNoneMatch, etag)) {
          return HttpServerResponse.empty({ status: 304, headers });
        }
        const data = yield* fileSystem
          .readFile(servedPath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!data) return null;
        return HttpServerResponse.uint8Array(data, { status: 200, contentType, headers });
      });
      const preference = negotiateStaticEncodingPreference(request.headers["accept-encoding"]);
      // Candidates are ranked by client weight with identity (null) in its own
      // ranked position, so a client preferring identity over a coding is not
      // handed a sidecar it ranked lower.
      for (const candidate of preference.candidates) {
        if (candidate === null) {
          const identityResponse = yield* respond(resolvedPath);
          if (identityResponse) return identityResponse;
          continue;
        }
        const sidecarPath = `${resolvedPath}${candidate.sidecarExtension}`;
        // Sidecars share the traversal guard with their source file: appending
        // an extension cannot escape the root, but keep the invariant explicit.
        if (!isWithinStaticRoot(sidecarPath)) continue;
        const sidecarResponse = yield* respond(sidecarPath, candidate.encoding);
        if (sidecarResponse) return sidecarResponse;
      }
      // Nothing acceptable was servable. With identity excluded that is a 406
      // per RFC 9110 §12.5.3; otherwise the file itself is missing.
      if (!preference.identityAcceptable) {
        return HttpServerResponse.text("Not Acceptable", {
          status: 406,
          headers: { Vary: "Accept-Encoding" },
        });
      }
      return null;
    });

    const fileInfo = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      const fallback = yield* serveStaticFile(path.resolve(staticRoot, "index.html"));
      return fallback ?? HttpServerResponse.text("Not Found", { status: 404 });
    }

    const response = yield* serveStaticFile(filePath);
    return response ?? HttpServerResponse.text("Internal Server Error", { status: 500 });
  }),
);

const FALLBACK_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b728080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-fallback="project-favicon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/></svg>`;

const FALLBACK_SITE_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b728080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-fallback="site-favicon"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20M12 2a14.5 14.5 0 0 1 0 20M2 12h20"/></svg>`;

import {
  ExternalMcpCreateIntegrationInput,
  ExternalMcpPairInput,
  ExternalMcpRefreshPairingInput,
  ExternalMcpRevokeIntegrationInput,
} from "@synara/contracts";
import { Effect, Layer, Option, Schema, Semaphore } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { readMcpJsonBody, type McpBodyReadResult } from "../agentGateway/httpRoute.ts";
import { extractBearerToken } from "../agentGateway/bearerToken.ts";
import { makeEffectAuthRequest } from "../auth/effectHttp.ts";
import { ServerAuth } from "../auth/Services/ServerAuth.ts";
import { ServerConfig } from "../config.ts";
import { isLoopbackHost } from "../startupAccess.ts";
import { shouldRejectAuthMutationOrigin } from "../trustedOrigins.ts";
import { ExternalMcpGateway } from "./Services/ExternalMcpGateway.ts";
import { ExternalMcpService } from "./Services/ExternalMcpService.ts";
import { verifyExternalMcpTransportCredential } from "./credentialVerification.ts";
import { makeExternalMcpExecutionAdmission } from "./executionAdmission.ts";
import {
  computeExternalMcpRuntimeProof,
  EXTERNAL_MCP_RUNTIME_CHALLENGE_HEADER,
  externalMcpRuntimeSecret,
} from "./runtimeProof.ts";

export const EXTERNAL_MCP_PATH = "/mcp/external";
// A maximal 100k-character prompt still fits when every character needs JSON
// escaping. Larger JSON-RPC batches receive 413 instead of consuming memory
// without bound; only a small number of authenticated bodies may buffer at once.
export const EXTERNAL_MCP_MAX_BODY_BYTES = 1024 * 1024;
export const EXTERNAL_MCP_BODY_READ_TIMEOUT_MS = 10_000;
const EXTERNAL_MCP_BODY_BUFFER_SLOTS = 4;
const externalMcpBodyBufferSlots = Effect.runSync(Semaphore.make(EXTERNAL_MCP_BODY_BUFFER_SLOTS));
const MANAGEMENT_MAX_BODY_BYTES = 32 * 1024;
const MANAGEMENT_BODY_BUFFER_SLOTS = 2;
const managementBodyBufferSlots = Effect.runSync(Semaphore.make(MANAGEMENT_BODY_BUFFER_SLOTS));
const EXTERNAL_MCP_EXECUTION_SLOTS_PER_INTEGRATION = 8;
const externalMcpExecutionAdmission = makeExternalMcpExecutionAdmission(
  EXTERNAL_MCP_EXECUTION_SLOTS_PER_INTEGRATION,
);

type ExternalMcpBodyReadResult = McpBodyReadResult | { readonly kind: "timeout" };

const readBoundedExternalMcpBody = (
  request: HttpServerRequest.HttpServerRequest,
  maxBytes: number,
  timeoutMs: number,
  slots: Semaphore.Semaphore,
): Effect.Effect<ExternalMcpBodyReadResult> =>
  slots.withPermit(readMcpJsonBody(request, maxBytes)).pipe(
    Effect.timeoutOption(timeoutMs),
    Effect.map(
      Option.match({
        onNone: () => ({ kind: "timeout" as const }),
        onSome: (result) => result,
      }),
    ),
  );

export const readExternalMcpBody = (
  request: HttpServerRequest.HttpServerRequest,
  timeoutMs = EXTERNAL_MCP_BODY_READ_TIMEOUT_MS,
): Effect.Effect<ExternalMcpBodyReadResult> =>
  readBoundedExternalMcpBody(
    request,
    EXTERNAL_MCP_MAX_BODY_BYTES,
    timeoutMs,
    externalMcpBodyBufferSlots,
  );

export const readExternalMcpManagementBody = (
  request: HttpServerRequest.HttpServerRequest,
  timeoutMs = EXTERNAL_MCP_BODY_READ_TIMEOUT_MS,
): Effect.Effect<ExternalMcpBodyReadResult> =>
  readBoundedExternalMcpBody(
    request,
    MANAGEMENT_MAX_BODY_BYTES,
    timeoutMs,
    managementBodyBufferSlots,
  );

const decodeCreateIntegration = Schema.decodeUnknownEffect(ExternalMcpCreateIntegrationInput);
const decodeRevokeIntegration = Schema.decodeUnknownEffect(ExternalMcpRevokeIntegrationInput);
const decodePair = Schema.decodeUnknownEffect(ExternalMcpPairInput);
const decodeRefreshPairing = Schema.decodeUnknownEffect(ExternalMcpRefreshPairingInput);
const decodeRuntimeChallenge = Schema.decodeUnknownEffect(
  Schema.Struct({
    nonce: Schema.String.check(Schema.isMinLength(24)).check(Schema.isMaxLength(128)),
  }),
);

const localExternalMcpEnabled = Effect.gen(function* () {
  const config = yield* ServerConfig;
  return isLoopbackHost(config.host) && config.publicUrl === undefined;
});

const disabledResponse = () =>
  HttpServerResponse.jsonUnsafe(
    { error: "External MCP is available only from a loopback-only Synara instance." },
    { status: 404 },
  );

const externalUnauthorized = () =>
  HttpServerResponse.jsonUnsafe(
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message:
          "external_credential_invalid: Missing, expired, revoked, or invalid external MCP credential.",
      },
    },
    { status: 401 },
  );

const externalUnavailable = () =>
  HttpServerResponse.jsonUnsafe(
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32603,
        message:
          "external_service_unavailable: External MCP credential verification is temporarily unavailable.",
      },
    },
    { status: 503 },
  );

const postExternalMcp = HttpRouter.add(
  "POST",
  EXTERNAL_MCP_PATH,
  Effect.gen(function* () {
    if (!(yield* localExternalMcpEnabled)) return disabledResponse();
    const request = yield* HttpServerRequest.HttpServerRequest;
    const externalMcp = yield* ExternalMcpService;
    const gateway = yield* ExternalMcpGateway;
    const token = extractBearerToken(request.headers.authorization);
    if (!token) return externalUnauthorized();
    const verification = yield* verifyExternalMcpTransportCredential(externalMcp, token);
    if (verification.kind === "invalid") return externalUnauthorized();
    if (verification.kind === "unavailable") return externalUnavailable();
    const body = yield* readExternalMcpBody(request);
    if (body.kind === "timeout") {
      return HttpServerResponse.jsonUnsafe(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Request body read timed out." },
        },
        { status: 408, headers: { Connection: "close" } },
      );
    }
    if (body.kind === "too-large") {
      return HttpServerResponse.jsonUnsafe(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Request body exceeds the 1 MiB limit." },
        },
        { status: 413 },
      );
    }
    if (body.kind === "invalid") {
      return HttpServerResponse.jsonUnsafe(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON body." } },
        { status: 400 },
      );
    }
    const admitted = yield* externalMcpExecutionAdmission.run(
      verification.client.integration.integrationId,
      gateway.handleVerifiedPost({
        client: verification.client,
        body: body.body,
      }),
    );
    if (Option.isNone(admitted)) {
      return HttpServerResponse.jsonUnsafe(
        {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32000,
            message:
              "external_concurrency_limit: Too many requests are already running for this integration.",
          },
        },
        { status: 429 },
      );
    }
    const result = admitted.value;
    return result.body === undefined
      ? HttpServerResponse.empty({ status: result.status })
      : HttpServerResponse.jsonUnsafe(result.body, { status: result.status });
  }),
);

const externalMethodNotAllowed = (method: "GET" | "DELETE") =>
  HttpRouter.add(
    method,
    EXTERNAL_MCP_PATH,
    Effect.gen(function* () {
      if (!(yield* localExternalMcpEnabled)) return disabledResponse();
      return HttpServerResponse.text("Method Not Allowed", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }),
  );

const requireOwner = (mutation: boolean) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const session = yield* serverAuth.authenticateHttpRequest(makeEffectAuthRequest(request));
    if (session.role !== "owner") {
      return yield* Effect.fail({ message: "Owner session required.", status: 403 as const });
    }
    if (mutation) {
      const url = HttpServerRequest.toURL(request);
      if (!url) return yield* Effect.fail({ message: "Bad Request", status: 400 as const });
      const config = yield* ServerConfig;
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
    }
  });

const managementError = (error: unknown) => {
  const value = error as { readonly message?: string; readonly status?: number };
  return HttpServerResponse.jsonUnsafe(
    { error: value.message ?? "External MCP management request failed." },
    {
      status: value.status ?? 500,
      ...(value.status === 408 ? { headers: { Connection: "close" } } : {}),
    },
  );
};

const readManagementBody = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const body = yield* readExternalMcpManagementBody(request);
  if (body.kind === "timeout") {
    return yield* Effect.fail({ message: "Request body read timed out.", status: 408 as const });
  }
  if (body.kind === "too-large") {
    return yield* Effect.fail({ message: "Request body too large.", status: 413 as const });
  }
  if (body.kind === "invalid") {
    return yield* Effect.fail({ message: "Invalid JSON body.", status: 400 as const });
  }
  return body.body;
});

const listIntegrations = HttpRouter.add(
  "GET",
  "/api/mcp/external/integrations",
  Effect.gen(function* () {
    if (!(yield* localExternalMcpEnabled)) return disabledResponse();
    yield* requireOwner(false);
    const externalMcp = yield* ExternalMcpService;
    return HttpServerResponse.jsonUnsafe(yield* externalMcp.listIntegrations());
  }).pipe(Effect.catch((error) => Effect.succeed(managementError(error)))),
);

const createIntegration = HttpRouter.add(
  "POST",
  "/api/mcp/external/integrations",
  Effect.gen(function* () {
    if (!(yield* localExternalMcpEnabled)) return disabledResponse();
    yield* requireOwner(true);
    const externalMcp = yield* ExternalMcpService;
    const input = yield* decodeCreateIntegration(yield* readManagementBody).pipe(
      Effect.mapError(() => ({ message: "Invalid integration request.", status: 400 as const })),
    );
    return HttpServerResponse.jsonUnsafe(yield* externalMcp.createIntegration(input));
  }).pipe(Effect.catch((error) => Effect.succeed(managementError(error)))),
);

const revokeIntegration = HttpRouter.add(
  "POST",
  "/api/mcp/external/integrations/revoke",
  Effect.gen(function* () {
    if (!(yield* localExternalMcpEnabled)) return disabledResponse();
    yield* requireOwner(true);
    const externalMcp = yield* ExternalMcpService;
    const input = yield* decodeRevokeIntegration(yield* readManagementBody).pipe(
      Effect.mapError(() => ({ message: "Invalid revoke request.", status: 400 as const })),
    );
    return HttpServerResponse.jsonUnsafe({
      revoked: yield* externalMcp.revokeIntegration(input.integrationId),
    });
  }).pipe(Effect.catch((error) => Effect.succeed(managementError(error)))),
);

const refreshPairing = HttpRouter.add(
  "POST",
  "/api/mcp/external/integrations/pairing",
  Effect.gen(function* () {
    if (!(yield* localExternalMcpEnabled)) return disabledResponse();
    yield* requireOwner(true);
    const externalMcp = yield* ExternalMcpService;
    const input = yield* decodeRefreshPairing(yield* readManagementBody).pipe(
      Effect.mapError(() => ({
        message: "Invalid refresh-pairing request.",
        status: 400 as const,
      })),
    );
    return HttpServerResponse.jsonUnsafe(yield* externalMcp.refreshPairing(input));
  }).pipe(Effect.catch((error) => Effect.succeed(managementError(error)))),
);

const runtimeChallenge = HttpRouter.add(
  "POST",
  "/api/mcp/external/runtime-challenge",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const input = yield* decodeRuntimeChallenge({
      nonce: request.headers[EXTERNAL_MCP_RUNTIME_CHALLENGE_HEADER],
    }).pipe(
      Effect.mapError(() => ({ message: "Invalid runtime challenge.", status: 400 as const })),
    );
    return HttpServerResponse.jsonUnsafe({
      proof: computeExternalMcpRuntimeProof(externalMcpRuntimeSecret, input.nonce),
    });
  }).pipe(Effect.catch((error) => Effect.succeed(managementError(error)))),
);

const pairIntegration = HttpRouter.add(
  "POST",
  "/api/mcp/external/pair",
  Effect.gen(function* () {
    if (!(yield* localExternalMcpEnabled)) return disabledResponse();
    const externalMcp = yield* ExternalMcpService;
    const input = yield* decodePair(yield* readManagementBody).pipe(
      Effect.mapError(() => ({ message: "Invalid pairing request.", status: 400 as const })),
    );
    return HttpServerResponse.jsonUnsafe(
      yield* externalMcp.pair(input.pairingCode, input.credential),
    );
  }).pipe(Effect.catch((error) => Effect.succeed(managementError(error)))),
);

export const externalMcpRouteLayer = Layer.mergeAll(
  postExternalMcp,
  externalMethodNotAllowed("GET"),
  externalMethodNotAllowed("DELETE"),
  listIntegrations,
  createIntegration,
  revokeIntegration,
  refreshPairing,
  runtimeChallenge,
  pairIntegration,
);

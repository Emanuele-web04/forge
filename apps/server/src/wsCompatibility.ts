import { randomUUID } from "node:crypto";

import {
  WS_COMPATIBILITY_QUERY,
  WS_NEGOTIATE_QUERY,
  WS_PROTOCOL_EPOCH,
  WS_PROTOCOL_MAX_REVISION,
  WS_PROTOCOL_MIN_REVISION,
  WS_SERVER_CAPABILITIES,
  WsCompatibilityError,
  type WsBootstrapNegotiateInput,
  type WsBootstrapNegotiateResult,
  type WsCompatibilityAction,
} from "@synara/contracts";
import { Effect } from "effect";

import { classifyBuildSkew } from "@synara/shared/buildSkew";

import { version as serverBuild } from "../package.json" with { type: "json" };

const serverInstanceId = randomUUID();

function incompatibility(
  action: WsCompatibilityAction,
  message: string,
  code: WsCompatibilityError["code"] = "WS_PROTOCOL_INCOMPATIBLE",
): WsCompatibilityError {
  return new WsCompatibilityError({
    message,
    code,
    retryable: false,
    action,
    serverBuild,
    protocolEpoch: WS_PROTOCOL_EPOCH,
    minRevision: WS_PROTOCOL_MIN_REVISION,
    maxRevision: WS_PROTOCOL_MAX_REVISION,
  });
}

export function negotiateWsCompatibility(
  input: WsBootstrapNegotiateInput,
): Effect.Effect<WsBootstrapNegotiateResult, WsCompatibilityError> {
  if (input.minRevision > input.maxRevision) {
    return Effect.fail(
      incompatibility("reload", "The client sent an invalid WebSocket protocol range."),
    );
  }
  if (input.protocolEpoch !== WS_PROTOCOL_EPOCH) {
    return Effect.fail(
      incompatibility(
        input.protocolEpoch < WS_PROTOCOL_EPOCH ? "update-client" : "update-server",
        `WebSocket protocol epoch ${input.protocolEpoch} is incompatible with server epoch ${WS_PROTOCOL_EPOCH}.`,
      ),
    );
  }

  const lowestCompatibleRevision = Math.max(input.minRevision, WS_PROTOCOL_MIN_REVISION);
  const negotiatedRevision = Math.min(input.maxRevision, WS_PROTOCOL_MAX_REVISION);
  if (negotiatedRevision < lowestCompatibleRevision) {
    return Effect.fail(
      incompatibility(
        input.maxRevision < WS_PROTOCOL_MIN_REVISION ? "update-client" : "update-server",
        `WebSocket protocol revisions ${input.minRevision}-${input.maxRevision} do not overlap server revisions ${WS_PROTOCOL_MIN_REVISION}-${WS_PROTOCOL_MAX_REVISION}.`,
      ),
    );
  }

  const missingCapabilities = input.requiredCapabilities.filter(
    (capability) => !WS_SERVER_CAPABILITIES.some((supported) => supported === capability),
  );
  if (missingCapabilities.length > 0) {
    return Effect.fail(
      incompatibility(
        "update-server",
        `The server is missing required WebSocket capabilities: ${missingCapabilities.join(", ")}.`,
        "WS_CAPABILITIES_INCOMPATIBLE",
      ),
    );
  }

  return Effect.succeed({
    protocolEpoch: WS_PROTOCOL_EPOCH,
    negotiatedRevision,
    serverBuild,
    serverInstanceId,
    capabilities: [...WS_SERVER_CAPABILITIES],
  });
}

// The HTTP negotiate endpoint carries the same input as bootstrap.negotiate,
// flattened into query params so the request stays a cacheable-free plain GET
// with no body to decode before the compatibility gate runs.
// Decimal digits only. `Number()` would accept "0x1" and "1e0", which the RPC
// path's Schema.Int rejects — the two transports must decode identically or
// "one negotiation, two transports" is only true for well-formed clients.
function parseDecimalInteger(raw: string | null): number | null {
  // No trimming: surrounding whitespace (including a `+` that decodes to a
  // space) is not a well-formed integer on either transport.
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseWsNegotiateSearchParams(
  searchParams: URLSearchParams,
): WsBootstrapNegotiateInput | WsCompatibilityError {
  const protocolEpoch = parseDecimalInteger(searchParams.get(WS_NEGOTIATE_QUERY.protocolEpoch));
  const minRevision = parseDecimalInteger(searchParams.get(WS_NEGOTIATE_QUERY.minRevision));
  const maxRevision = parseDecimalInteger(searchParams.get(WS_NEGOTIATE_QUERY.maxRevision));
  const clientBuild = searchParams.get(WS_NEGOTIATE_QUERY.clientBuild)?.trim() ?? "";
  if (
    protocolEpoch === null ||
    minRevision === null ||
    maxRevision === null ||
    clientBuild.length === 0
  ) {
    return incompatibility(
      "reload",
      "WebSocket negotiation request is missing required parameters.",
      "WS_NEGOTIATION_REQUIRED",
    );
  }
  return {
    protocolEpoch,
    minRevision,
    maxRevision,
    clientBuild,
    requiredCapabilities: searchParams.getAll(WS_NEGOTIATE_QUERY.requiredCapability),
  };
}

export function validateWsFeatureCompatibility(
  searchParams: URLSearchParams,
): WsCompatibilityError | null {
  const epoch = Number(searchParams.get(WS_COMPATIBILITY_QUERY.protocolEpoch));
  const revision = Number(searchParams.get(WS_COMPATIBILITY_QUERY.protocolRevision));
  const clientBuild = searchParams.get(WS_COMPATIBILITY_QUERY.clientBuild)?.trim() ?? "";
  const expectedServerInstanceId =
    searchParams.get(WS_COMPATIBILITY_QUERY.serverInstanceId)?.trim() ?? "";
  if (!Number.isSafeInteger(epoch) || epoch !== WS_PROTOCOL_EPOCH) {
    return incompatibility(
      "reload",
      "Feature RPC rejected before compatible WebSocket protocol negotiation.",
      "WS_NEGOTIATION_REQUIRED",
    );
  }
  if (
    !Number.isSafeInteger(revision) ||
    revision < WS_PROTOCOL_MIN_REVISION ||
    revision > WS_PROTOCOL_MAX_REVISION
  ) {
    return incompatibility(
      revision < WS_PROTOCOL_MIN_REVISION ? "update-client" : "update-server",
      "Feature RPC rejected because its negotiated protocol revision is unsupported.",
    );
  }
  if (clientBuild.length === 0) {
    return incompatibility(
      "reload",
      "Feature RPC rejected because the client build identity is missing.",
      "WS_NEGOTIATION_REQUIRED",
    );
  }
  if (expectedServerInstanceId !== serverInstanceId) {
    return incompatibility(
      "reload",
      "The Synara server restarted during WebSocket negotiation. Reload to reconnect to the new server generation.",
      "WS_SERVER_GENERATION_CHANGED",
    );
  }
  return null;
}

/**
 * Classifies the connecting client's build against this server's. The client
 * enforces the same policy for UX, but that guard lives in code the client
 * controls: an older official client predating it, or any direct client, is
 * only stopped by this classification feeding the admission middleware.
 */
export function isWsClientBuildSkewed(searchParams: URLSearchParams): boolean {
  return (
    classifyBuildSkew({
      clientBuild: searchParams.get(WS_COMPATIBILITY_QUERY.clientBuild) ?? undefined,
      serverBuild,
    }) !== "compatible"
  );
}

export function makeCurrentWsFeatureCompatibilitySearchParams(
  clientBuild: string,
): URLSearchParams {
  return new URLSearchParams({
    [WS_COMPATIBILITY_QUERY.clientBuild]: clientBuild,
    [WS_COMPATIBILITY_QUERY.protocolEpoch]: String(WS_PROTOCOL_EPOCH),
    [WS_COMPATIBILITY_QUERY.protocolRevision]: String(WS_PROTOCOL_MAX_REVISION),
    [WS_COMPATIBILITY_QUERY.serverInstanceId]: serverInstanceId,
  });
}

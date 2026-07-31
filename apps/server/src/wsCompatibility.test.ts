import {
  WS_PROTOCOL_EPOCH,
  WS_PROTOCOL_MAX_REVISION,
  WS_PROTOCOL_MIN_REVISION,
  WS_SERVER_CAPABILITIES,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  isWsClientBuildSkewed,
  makeCurrentWsFeatureCompatibilitySearchParams,
  negotiateWsCompatibility,
  validateWsFeatureCompatibility,
} from "./wsCompatibility";
import { version as serverBuild } from "../package.json" with { type: "json" };
import { WS_COMPATIBILITY_QUERY } from "@synara/contracts";

/**
 * The classification step that feeds the admission middleware's skew guard.
 *
 * Enforcement is well covered, but every enforcement test injects `buildSkewed`
 * directly — so the upgrade-URL -> classification -> session wiring had no test
 * at all: mutating this function to `return false` left wsRpc.auth,
 * wsRpc.admissionAuthorization, wsRpc.connectionLifecycle and this file all
 * green. That matters because the server-side guard exists precisely because
 * the client's own guard cannot be trusted; a classification that silently
 * regresses to never-classifying makes the client's read-only notice a lie
 * while every enforcement assertion still passes.
 */
describe("client build skew classification", () => {
  const paramsFor = (clientBuild: string) =>
    new URLSearchParams({ [WS_COMPATIBILITY_QUERY.clientBuild]: clientBuild });

  it("does not classify this server's own build as skewed", () => {
    expect(isWsClientBuildSkewed(paramsFor(serverBuild))).toBe(false);
    expect(isWsClientBuildSkewed(makeCurrentWsFeatureCompatibilitySearchParams(serverBuild))).toBe(
      false,
    );
  });

  it("classifies a major/minor mismatch as skewed", () => {
    const [major = "0", minor = "0"] = serverBuild.split(".");
    expect(isWsClientBuildSkewed(paramsFor(`${Number(major) + 1}.${minor}.0`))).toBe(true);
    expect(isWsClientBuildSkewed(paramsFor(`${major}.${Number(minor) + 1}.0`))).toBe(true);
  });

  it("treats a missing or unparseable client build as skewed", () => {
    expect(isWsClientBuildSkewed(new URLSearchParams())).toBe(true);
    expect(isWsClientBuildSkewed(paramsFor("not-a-version"))).toBe(true);
  });
});

describe("WebSocket compatibility bootstrap", () => {
  it("negotiates the stable epoch/range and returns process/build capabilities", async () => {
    const result = await Effect.runPromise(
      negotiateWsCompatibility({
        protocolEpoch: WS_PROTOCOL_EPOCH,
        minRevision: WS_PROTOCOL_MIN_REVISION,
        maxRevision: WS_PROTOCOL_MAX_REVISION,
        clientBuild: "test-client",
        requiredCapabilities: [...WS_SERVER_CAPABILITIES],
      }),
    );

    expect(result).toMatchObject({
      protocolEpoch: WS_PROTOCOL_EPOCH,
      negotiatedRevision: WS_PROTOCOL_MAX_REVISION,
    });
    expect(result.serverBuild.length).toBeGreaterThan(0);
    expect(result.serverInstanceId.length).toBeGreaterThan(0);
    expect(result.capabilities).toContain("orchestration.cursor-safe-streams");
    expect(result.capabilities).toContain("orchestration.thread-detail-snapshot");
  });

  it("returns terminal update guidance and rejects feature calls without negotiated query data", async () => {
    const error = await Effect.runPromise(
      negotiateWsCompatibility({
        protocolEpoch: WS_PROTOCOL_EPOCH - 1,
        minRevision: 0,
        maxRevision: 0,
        clientBuild: "stale-client",
        requiredCapabilities: [],
      }).pipe(Effect.flip),
    );

    expect(error).toMatchObject({
      code: "WS_PROTOCOL_INCOMPATIBLE",
      retryable: false,
      action: "update-client",
    });
    expect(validateWsFeatureCompatibility(new URLSearchParams())).toMatchObject({
      code: "WS_NEGOTIATION_REQUIRED",
      retryable: false,
    });
    expect(
      validateWsFeatureCompatibility(makeCurrentWsFeatureCompatibilitySearchParams("test-client")),
    ).toBeNull();
  });

  it("rejects a missing required capability with terminal server-update guidance", async () => {
    const error = await Effect.runPromise(
      negotiateWsCompatibility({
        protocolEpoch: WS_PROTOCOL_EPOCH,
        minRevision: WS_PROTOCOL_MIN_REVISION,
        maxRevision: WS_PROTOCOL_MAX_REVISION,
        clientBuild: "future-client",
        requiredCapabilities: ["rpc.future-capability"],
      }).pipe(Effect.flip),
    );

    expect(error).toMatchObject({
      code: "WS_CAPABILITIES_INCOMPATIBLE",
      retryable: false,
      action: "update-server",
    });
  });
});

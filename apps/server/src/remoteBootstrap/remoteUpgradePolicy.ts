// FILE: remoteUpgradePolicy.ts
// Purpose: Decide what a version-skewed remote environment may do, and when an
//          upgrade is allowed to actually swap the release. Weekly releases must
//          never kill someone's long-running turn, so the swap is user-invoked
//          and drain-gated; nothing here ever restarts a server on its own.
// Layer: Server / remote broker policy
// Exports: RemoteEnvironmentPosture, classifyRemotePosture,
//          UpgradeGate, evaluateUpgradeGate, DrainState, describePosture,
//          RequestedUpgrade, describeUpgradeGate

import { classifyBuildSkew } from "@synara/shared/buildSkew";

export type RemoteEnvironmentPosture =
  /** Versions line up: full read/write. */
  | "operational"
  /** Skewed but idle: an upgrade can proceed immediately when the user asks. */
  | "read-degraded-idle"
  /** Skewed with work in flight: reads only, and the swap has to wait. */
  | "read-degraded-active";

export interface DrainState {
  /** Turns still streaming on the remote server. */
  readonly activeTurnCount: number;
}

export function classifyRemotePosture(input: {
  readonly brokerBuild: string | undefined;
  readonly remoteBuild: string | undefined;
  readonly drain: DrainState;
}): RemoteEnvironmentPosture {
  const skew = classifyBuildSkew({
    clientBuild: input.brokerBuild,
    serverBuild: input.remoteBuild,
  });
  if (skew === "compatible") return "operational";
  return input.drain.activeTurnCount > 0 ? "read-degraded-active" : "read-degraded-idle";
}

export function describePosture(posture: RemoteEnvironmentPosture): string {
  switch (posture) {
    case "operational":
      return "Remote environment is running a compatible build.";
    case "read-degraded-idle":
      return "Remote environment is running a different build. It is read-only until you upgrade it.";
    case "read-degraded-active":
      return "Remote environment is running a different build and still has active turns. It is read-only; upgrading will wait for those turns to finish.";
  }
}

export type UpgradeGate =
  /** Proceed with the release swap now. */
  | { readonly decision: "swap" }
  /** Keep waiting for turns to finish; nothing has been stopped. */
  | { readonly decision: "wait"; readonly activeTurnCount: number }
  /** The drain deadline passed; the caller decides to force or abort. */
  | { readonly decision: "drain-timeout"; readonly activeTurnCount: number }
  /** Nothing to do — the remote already runs the target release. */
  | { readonly decision: "already-current" }
  /** Refused: an upgrade was requested without a user asking for one. */
  | { readonly decision: "refused"; readonly reason: string };

export interface UpgradeGateInput {
  readonly currentReleaseId: string | null;
  readonly targetReleaseId: string;
  /**
   * True only when a human explicitly asked for this upgrade. There is no code
   * path that sets this from a timer, a release feed, or a health check: an
   * automatic restart is exactly the failure mode this policy exists to
   * prevent.
   */
  readonly userInvoked: boolean;
  readonly drain: DrainState;
  readonly elapsedDrainMs: number;
  readonly drainTimeoutMs: number;
}

/**
 * What the caller supplies when asking for an upgrade.
 *
 * The release ids are deliberately absent: `bootstrapRemoteServer` fills them
 * from the host and the artifact set, so a caller cannot accidentally gate on a
 * stale view of what is running.
 */
export type RequestedUpgrade = Omit<UpgradeGateInput, "currentReleaseId" | "targetReleaseId">;

/** A user-facing explanation of why a swap did not happen. */
export function describeUpgradeGate(gate: UpgradeGate): string {
  switch (gate.decision) {
    case "swap":
      return "Upgrading the remote environment.";
    case "already-current":
      return "The remote environment already runs this release.";
    case "wait":
      return `Waiting for ${gate.activeTurnCount} active turn(s) to finish before upgrading.`;
    case "drain-timeout":
      return `${gate.activeTurnCount} turn(s) were still active when the drain deadline passed. Upgrade aborted; retry to force it.`;
    case "refused":
      return gate.reason;
  }
}

export function evaluateUpgradeGate(input: UpgradeGateInput): UpgradeGate {
  if (!input.userInvoked) {
    return {
      decision: "refused",
      reason: "Remote upgrades are user-invoked; Synara never restarts a remote server on its own.",
    };
  }
  if (input.currentReleaseId === input.targetReleaseId) {
    return { decision: "already-current" };
  }
  if (input.drain.activeTurnCount > 0) {
    return input.elapsedDrainMs >= input.drainTimeoutMs
      ? { decision: "drain-timeout", activeTurnCount: input.drain.activeTurnCount }
      : { decision: "wait", activeTurnCount: input.drain.activeTurnCount };
  }
  return { decision: "swap" };
}

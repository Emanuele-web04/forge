// FILE: ConnectionPlanPolicy.ts
// Purpose: Policy gate that turns a validated `ConnectionCandidate` into a
//          `ConnectionPlan` — the ONLY code path allowed to do so. It rejects
//          any candidate whose launch would rely on a shell string, a
//          pipeline, or fetch-and-run (AC #6), requires an absolute launch
//          target, and requires provenance. This is defense-in-depth over the
//          schema: even if a future caller constructs a candidate by hand, the
//          plan builder still refuses to propagate it.
// Layer: Server discovery policy
import { Data } from "effect";

import type { ConnectionCandidate, ConnectionPlan } from "@synara/contracts";

/**
 * A candidate the policy gate refuses to turn into a launch plan. `code` is
 * structured (never free-form) so the RPC layer can surface a precise,
 * non-defect reason:
 *   - `policyRefused` — a malformed launch target (non-absolute command,
 *     shell operators, unsafe endpoint, missing provenance);
 *   - `missingBinary` — a configured recipe binary that is not installed;
 *   - `catalogOnly` — registry display entry with no local binary/endpoint.
 * `reason` is the human-readable companion message.
 */
export class ConnectionPlanPolicyViolation extends Data.TaggedError(
  "ConnectionPlanPolicyViolation",
)<{
  readonly code: "policyRefused" | "missingBinary" | "catalogOnly";
  readonly reason: string;
}> {}

const SHELL_METACHARACTERS = /[\s"'$`\\|&;<>()[\]{}*?~!#\n\r]/u;
const ABSOLUTE_PATH_PATTERN = /^(?:\/|[A-Za-z]:[\\/])/u;

function isAbsolutePath(value: string): boolean {
  return ABSOLUTE_PATH_PATTERN.test(value);
}

/**
 * True when `value` smells like a shell string rather than a separate argv
 * element. The launch metadata must never come from docs text (AC #6); a
 * launch is either a resolved absolute binary or an explicit endpoint.
 */
function looksLikeShellConstruction(value: string): boolean {
  return SHELL_METACHARACTERS.test(value);
}

/** Reject a launch command that might rely on docs text or a shell. */
export function assertSafeLaunchTarget(input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}): void {
  if (!isAbsolutePath(input.command)) {
    throw new ConnectionPlanPolicyViolation({
      code: "policyRefused",
      reason: `Launch command must be an absolute path, got: ${input.command}`,
    });
  }
  if (looksLikeShellConstruction(input.command)) {
    throw new ConnectionPlanPolicyViolation({
      code: "policyRefused",
      reason: `Launch command must not contain shell operators or whitespace: ${input.command}`,
    });
  }
  for (const arg of input.args) {
    if (looksLikeShellConstruction(arg)) {
      throw new ConnectionPlanPolicyViolation({
        code: "policyRefused",
        reason: `Launch argument must not contain shell operators or whitespace: ${JSON.stringify(arg)}`,
      });
    }
  }
}

export function assertSafeEndpoint(input: { readonly endpoint: string }): void {
  let url: URL;
  try {
    url = new URL(input.endpoint);
  } catch {
    throw new ConnectionPlanPolicyViolation({
      code: "policyRefused",
      reason: `Launch endpoint must be a valid URL, got: ${input.endpoint}`,
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConnectionPlanPolicyViolation({
      code: "policyRefused",
      reason: `Launch endpoint must use http(s), got: ${input.endpoint}`,
    });
  }
  if (url.username || url.password) {
    throw new ConnectionPlanPolicyViolation({
      code: "policyRefused",
      reason: `Launch endpoint must not embed credentials, got: ${input.endpoint}`,
    });
  }
}

export interface ConnectionPlanBuildInput {
  readonly candidate: ConnectionCandidate;
  /** Literal (non-secret) environment the launcher needs, e.g. package-runner env. */
  readonly launchEnv?: Readonly<Record<string, string>>;
  /** Working directory for command launches; defaults to server cwd (unset). */
  readonly cwd?: string;
  readonly planId: string;
  readonly resolvedAt: string;
}

/**
 * Build a plan from a validated candidate. Every rejection reason is an
 * explicit `ConnectionPlanPolicyViolation` so the RPC layer can surface it
 * without ever suggesting an install command.
 *
 * Deliberate scope decision (KAR-525 is read-only discovery):
 *   - a candidate with a resolved local binary OR an explicit endpoint can
 *     become a launch plan;
 *   - a registry-only candidate (e.g. an `npx` distribution with no local
 *     binary and no endpoint) is LISTABLE but cannot be resolved to a launch
 *     plan here: that would require an install-then-launch, which is exactly
 *     the "executable setup from structured metadata" this milestone does not
 *     do. KAR-526 owns install UX + profile creation.
 */
export function buildConnectionPlan(input: ConnectionPlanBuildInput): ConnectionPlan {
  const { candidate } = input;

  if (candidate.provenance.source.trim().length === 0) {
    throw new ConnectionPlanPolicyViolation({
      code: "policyRefused",
      reason: "Candidate has no provenance.",
    });
  }

  if (candidate.resolvedPath !== undefined) {
    const command = candidate.resolvedPath;
    assertSafeLaunchTarget({ command, args: [] });
    return {
      planId: input.planId,
      agentId: candidate.agentId,
      candidateId: candidate.candidateId,
      candidateSource: candidate.source,
      displayName: candidate.displayName,
      launch: {
        kind: "command",
        command,
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      },
      ...(input.launchEnv !== undefined && Object.keys(input.launchEnv).length > 0
        ? { launchEnv: input.launchEnv }
        : {}),
      ...(candidate.compatibility !== undefined ? { compatibility: candidate.compatibility } : {}),
      provenance: candidate.provenance,
      resolvedAt: input.resolvedAt,
    };
  }

  if (candidate.resolvedEndpoint !== undefined) {
    assertSafeEndpoint({ endpoint: candidate.resolvedEndpoint });
    return {
      planId: input.planId,
      agentId: candidate.agentId,
      candidateId: candidate.candidateId,
      candidateSource: candidate.source,
      displayName: candidate.displayName,
      launch: { kind: "endpoint", endpoint: candidate.resolvedEndpoint },
      ...(candidate.compatibility !== undefined ? { compatibility: candidate.compatibility } : {}),
      provenance: candidate.provenance,
      resolvedAt: input.resolvedAt,
    };
  }

  // A `missing`-classified candidate (configured recipe binary absent from
  // PATH) is its own refusal: distinguishable from a catalog-only display
  // entry, and never resolvable to a launch.
  if (candidate.versionProbe?.state === "missing") {
    throw new ConnectionPlanPolicyViolation({
      code: "missingBinary",
      reason: `Configured binary for '${candidate.agentId}' is not installed; install it, then re-run discovery.`,
    });
  }

  throw new ConnectionPlanPolicyViolation({
    code: "catalogOnly",
    reason:
      "Candidate is catalog-only (no local binary and no explicit endpoint); " +
      "install the agent first, then re-run discovery.",
  });
}

// FILE: agentProfileTrust.ts
// Purpose: Pure, deterministic provenance-based trust evaluation shared by the
// profile lifecycle service and the session-launch gate. Kept dependency-free
// so both services can import the same verdict without a cycle.
// Layer: Server external agents
// Exports: evaluateAgentProfileTrust, profileEvidenceNamespace,
//          assertSessionAllowed (the single shared session-launch gate), and
//          ProfileSessionRefused (its refusal error)

import type { AgentProfile, AgentProfileRevision } from "@synara/contracts";
import type { AgentProfileTrust } from "@synara/contracts";

/**
 * Refusal raised by {@link assertSessionAllowed} when a session start must be
 * blocked (quarantined/retired profile, or an untrusted profile that needs
 * credential release). The `code` is the single source of the profile-level
 * error codes exposed to consumers; successful launches never produce one.
 */
export class ProfileSessionRefused extends Error {
  readonly _tag = "ProfileSessionRefused";
  readonly code: "profile-quarantined" | "profile-removed" | "profile-untrusted";
  constructor(input: {
    readonly code: "profile-quarantined" | "profile-removed" | "profile-untrusted";
    readonly message: string;
  }) {
    super(input.message);
    this.name = "ProfileSessionRefused";
    this.code = input.code;
  }
}

const KNOWN_GOOD_WORKFLOWS = new Set(["code-review", "plan", "harnessed"]);
const KNOWN_GOOD_BRANDS = new Set(["openai", "anthropic", "synara"]);
const KNOWN_GOOD_ORGANIZATIONS = new Set(["synara"]);

/**
 * Capability-evidence namespace for a profile. Evidence rows are keyed by this
 * namespace; the conformance runner and evidence service both write to it.
 */
export const profileEvidenceNamespace = (profileId: string): string =>
  `external:agentprofile:${profileId}`;

/**
 * Deterministic trust verdict for a profile revision. A profile is trusted for
 * credential release when it shipped with a known-good workflow, OR an explicit
 * vendor-brand/org claim was verified. Explicitly distrust claims
 * (`distrust:*`) win over everything and force untrusted.
 */
export function evaluateAgentProfileTrust(input: {
  readonly provenance?: { readonly source?: string; readonly version?: string | undefined };
  readonly trust?: AgentProfileTrust | undefined;
}): boolean {
  const source = input.provenance?.source ?? "";
  const claims = input.trust ?? {};
  const workflows = claims.workflows ?? [];
  const brands = claims.brands ?? [];
  const organizations = claims.organizations ?? [];

  // TODO(KAR-529 C2): self-asserted trust claims — a profile's own `trust`
  // claims are additive today, so a hostile agent can self-assert
  // `brands:["openai"]` and pass the gate. The verified-claims pipeline
  // (vendor-brand/org verification) must land before self-asserted claims are
  // treated as trustworthy; see the C2 review item. No behavior change here.

  // Explicit distrust wins before the additive default.
  if ([...workflows, ...brands, ...organizations].some((claim) => claim.startsWith("distrust:"))) {
    return false;
  }

  const viaWorkflow = workflows.some((workflow) => KNOWN_GOOD_WORKFLOWS.has(workflow));
  const viaBrand = brands.some((brand) => KNOWN_GOOD_BRANDS.has(brand));
  const viaOrg = organizations.some((org) => KNOWN_GOOD_ORGANIZATIONS.has(org));
  if (viaWorkflow || viaBrand || viaOrg) return true;

  // A manually imported profile with no claims is treated as untrusted until a
  // trusted workflow is attached or a vendor claim is verified. The single
  // legacy slot ships with a known-good workflow.
  return source === "legacy-settings-acp";
}

/** Convenience wrapper over a stored revision object. */
export function isAgentProfileRevisionTrusted(revision: AgentProfileRevision): boolean {
  return evaluateAgentProfileTrust({
    provenance: revision.provenance,
    trust: revision.trust,
  });
}

const hasCredentialRefs = (revision: AgentProfileRevision): boolean =>
  (revision.credentialRefs?.length ?? 0) > 0 ||
  (revision.launch.kind === "command" && (revision.launch.envRefs?.length ?? 0) > 0);

/**
 * The single shared session-launch gate (KAR-529 AC5). Refuses new sessions for
 * quarantined/retired profiles, and refuses credential release to an untrusted
 * profile that needs credentials (provenance-based trust). Both the profile
 * service's `resolveSessionLaunch` and the lifecycle service's
 * `assertSessionAllowed` delegate here so the trust/status rules live in one
 * place. Pure: no services, no I/O.
 */
export function assertSessionAllowed(input: {
  readonly profile: AgentProfile;
  readonly revision: AgentProfileRevision;
}): asserts input is {
  readonly profile: AgentProfile;
  readonly revision: AgentProfileRevision;
} {
  const { profile, revision } = input;
  if (profile.status === "quarantined") {
    throw new ProfileSessionRefused({
      code: "profile-quarantined",
      message: `External agent profile "${profile.name}" is quarantined; new sessions are blocked until it is re-certified.`,
    });
  }
  if (profile.status === "retired") {
    throw new ProfileSessionRefused({
      code: "profile-removed",
      message: `External agent profile "${profile.name}" has been removed; new sessions are disabled.`,
    });
  }
  if (hasCredentialRefs(revision) && !isAgentProfileRevisionTrusted(revision)) {
    throw new ProfileSessionRefused({
      code: "profile-untrusted",
      message: `External agent profile "${profile.name}" is not trusted for credential release; attach a trusted workflow or verified vendor claim first.`,
    });
  }
}

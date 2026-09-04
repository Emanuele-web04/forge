// FILE: capabilityEvidence.ts
// Purpose: Shared helper for deriving external-agent capability evidence
// namespaces from an agent profile. Used by both the server (where runtime
// turn feedback and conformance runs attribute observations) and the web app
// (where the badge queries the evidence store for a profile).
// Layer: Shared capability-evidence utilities
// Exports: externalAgentEvidenceNamespace

/**
 * The evidence namespace for an external agent profile. This is the canonical
 * key under which all capability observations for that profile are recorded,
 * so conformance runs and live-session runtime feedback converge on the same
 * history (KAR-530).
 *
 * The namespace is profile-scoped, not revision-scoped: the badge reads the
 * current profile state, so evidence for a profile must aggregate under one
 * key across revisions. The running revision is carried as observation run
 * metadata instead of in the namespace, which also keeps the name within the
 * `ExternalAgentNamespace` length cap (revision hashes are 64 hex chars).
 */
export function externalAgentEvidenceNamespace(profileId: string): string {
  return `synara:external:${profileId}`;
}

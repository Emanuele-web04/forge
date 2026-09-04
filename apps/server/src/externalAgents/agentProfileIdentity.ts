import { createHash } from "node:crypto";

import { AgentProfileId, AgentProfileRevisionId } from "@synara/contracts";
import type {
  AgentProfileCredentialRef,
  AgentProfileLaunch,
  AgentProfileProvenance,
  AgentProfileRevision,
  AgentProfileTrust,
  ConnectorKind,
} from "@synara/contracts";

/**
 * Canonical content of an external agent profile revision. Revision identity
 * is derived from this payload, so identical normalized revisions dedupe to
 * the same revision id. Per-insert metadata (createdAt, parentRevisionId,
 * revisionId) is excluded on purpose: it records history, not behavior.
 */
export interface AgentProfileRevisionContent {
  readonly displayName: string;
  readonly connectorKind: ConnectorKind;
  readonly launch: AgentProfileLaunch;
  readonly credentialRefs: ReadonlyArray<AgentProfileCredentialRef>;
  readonly provenance: AgentProfileProvenance;
  readonly trust?: AgentProfileTrust;
}

export function toAgentProfileRevisionContent(
  revision: AgentProfileRevision,
): AgentProfileRevisionContent {
  return {
    displayName: revision.displayName,
    connectorKind: revision.connectorKind,
    launch: revision.launch,
    credentialRefs: revision.credentialRefs ?? [],
    provenance: revision.provenance,
    ...(revision.trust !== undefined ? { trust: revision.trust } : {}),
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const record: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item !== undefined) {
        record[key] = canonicalize(item);
      }
    }
    return record;
  }
  return value;
}

/** Deterministic sha256 (hex) of the canonicalized revision content. */
export function computeAgentProfileContentHash(content: AgentProfileRevisionContent): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(content)))
    .digest("hex");
}

/**
 * Revision id derived from the content hash. Two profiles that carry the same
 * normalized content resolve to the same revision id, which is how identical
 * revisions dedupe to a single immutable row.
 */
export function computeAgentProfileRevisionId(
  content: AgentProfileRevisionContent,
): AgentProfileRevisionId {
  return AgentProfileRevisionId.makeUnsafe(`rev_${computeAgentProfileContentHash(content)}`);
}

// Deterministic identity for the single legacy generic-ACP settings slot. The
// slot shape is defined by the generic ACP foundation work; until that lands,
// persisted provider:"acp" state maps to this fixed external identity, so the
// migration is deterministic across restarts and upgrades.
export const LEGACY_ACP_PROFILE_ID = "agentprofile_legacy-acp";

const LEGACY_ACP_REVISION_CONTENT: AgentProfileRevisionContent = {
  displayName: "Legacy ACP Agent",
  connectorKind: "acp",
  launch: { kind: "command", command: "acp", args: [] },
  credentialRefs: [],
  provenance: { source: "legacy-settings-acp" },
};

export function legacyAcpProfileId(): AgentProfileId {
  return AgentProfileId.makeUnsafe(LEGACY_ACP_PROFILE_ID);
}

export function legacyAcpRevisionContent(): AgentProfileRevisionContent {
  return LEGACY_ACP_REVISION_CONTENT;
}

export function legacyAcpRevisionId(): AgentProfileRevisionId {
  return computeAgentProfileRevisionId(LEGACY_ACP_REVISION_CONTENT);
}

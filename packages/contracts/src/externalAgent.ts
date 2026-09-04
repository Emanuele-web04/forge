import { Schema } from "effect";
import {
  AgentProfileId,
  AgentProfileRevisionId,
  IsoDateTime,
  TrimmedNonEmptyString,
} from "./baseSchemas";

/**
 * External agent connector kinds.
 *
 * Adds the KAR-527 generic CLI tiers additively:
 * - `acp` — Agent Client Protocol over stdio JSON-RPC.
 * - `cli-structured` — a generic CLI speaking the Synara structured CLI wire
 *   protocol (NDJSON events/commands, see `cliConnector.ts`). Distinct from
 *   each provider's native runtime.
 * - `cli-basic` — a generic CLI with no structured protocol. Honest limits:
 *   streaming is line-based, cancellation asks the process tree to stop, and
 *   resume/permissions/elicitation are never faked.
 *
 * The launch metadata is connector-shaped, so new kinds stay backward
 * compatible with stored profiles.
 */
export const ConnectorKind = Schema.Literals(["acp", "cli-structured", "cli-basic"]);
export type ConnectorKind = typeof ConnectorKind.Type;

/**
 * A named credential the profile needs at launch time. A profile stores the
 * reference (name plus destination environment key) and never the secret
 * value; the value lives in the server secret store under a profile-scoped
 * name and is resolved when a session starts.
 */
export const AgentProfileCredentialRef = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  envKey: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  required: Schema.optional(Schema.Boolean),
});
export type AgentProfileCredentialRef = typeof AgentProfileCredentialRef.Type;

const LaunchCommand = TrimmedNonEmptyString.check(Schema.isMaxLength(4096));
const LaunchArgument = Schema.String.check(Schema.isMaxLength(4096));

/**
 * How a generic CLI frames its output. `ndjson` is the structured protocol
 * (one JSON object per line, schema in `cliConnector.ts`); `line` is plain
 * text streaming used by the basic tier. Absent for ACP profiles.
 */
const CliLaunchFrameMode = Schema.Literals(["line", "ndjson"]);
export type CliLaunchFrameMode = typeof CliLaunchFrameMode.Type;

const AgentProfileCommandLaunch = Schema.Struct({
  kind: Schema.Literal("command"),
  command: LaunchCommand,
  args: Schema.optional(Schema.Array(LaunchArgument).pipe(Schema.withDecodingDefault(() => []))),
  cwd: Schema.optional(LaunchCommand),
  envRefs: Schema.optional(
    Schema.Array(AgentProfileCredentialRef).pipe(Schema.withDecodingDefault(() => [])),
  ),
  /**
   * Required for the KAR-527 CLI tiers: `cli-structured` must be `ndjson` and
   * `cli-basic` must be `line`. Optional so legacy ACP profiles (which never
   * carry it) keep decoding.
   */
  frameMode: Schema.optional(CliLaunchFrameMode),
});

const AgentProfileEndpointLaunch = Schema.Struct({
  kind: Schema.Literal("endpoint"),
  endpoint: LaunchCommand,
});

/**
 * Exact launch/configuration metadata for one revision: either a resolved
 * executable command (argv plus credential env references) or a remote
 * endpoint. Never raw secrets.
 */
export const AgentProfileLaunch = Schema.Union([
  AgentProfileCommandLaunch,
  AgentProfileEndpointLaunch,
]);
export type AgentProfileLaunch = typeof AgentProfileLaunch.Type;

// ─────────────────────────────────────────────────────────────────────────────
// Connector-kind ↔ launch mapping validation (single source of truth)
//
// `cli-structured` and `cli-basic` are the only kinds with framing requirements,
// and both must use a command launch. Enforcing the mapping here makes the
// schema reject bad mappings at decode time (create input, update input, and
// persisted revision reads all route through it), so a profile can never claim
// a structured protocol while using line framing.
interface CliConfigurableMappingValue {
  readonly connectorKind: ConnectorKind;
  readonly launch: AgentProfileLaunch;
}
export type CliConfigurableMappingValueShape = {
  readonly connectorKind: ConnectorKind;
  readonly launch: AgentProfileLaunch;
};

export function validateCliConnectorMapping<S extends CliConfigurableMappingValue>(
  value: S,
): value is S {
  if (value.connectorKind === "cli-structured") {
    return value.launch.kind === "command" && value.launch.frameMode === "ndjson";
  }
  if (value.connectorKind === "cli-basic") {
    return value.launch.kind === "command" && value.launch.frameMode === "line";
  }
  return true;
}

export const CLI_CONNECTOR_MAPPING_ERROR_MESSAGE =
  "cli CLI tiers require a command launch with the matching frame mode (cli-structured → ndjson, cli-basic → line)";

const cliConnectorMappingRefinement = {
  message: CLI_CONNECTOR_MAPPING_ERROR_MESSAGE,
};

export const AgentProfileProvenance = Schema.Struct({
  source: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  version: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
});
export type AgentProfileProvenance = typeof AgentProfileProvenance.Type;

/**
 * Provenance-based trust attributes of an external agent profile. These derive
 * from the same launch provenance (workflows, brands, organizations) that the
 * profile's revisions carry, but are promoted to lifecycle-level trust so the
 * runtime can answer "is this profile trusted for credential release?"
 * independent of which revision is currently pinned.
 *
 * Every field is additive and optional: an externally imported profile with no
 * recorded brand/org claims still gets a deterministic trust verdict (trusted
 * by default only when it shipped with a known-good workflow; see the server
 * lifecycle service for how these inputs fold into a verdict).
 */
export const AgentProfileTrust = Schema.Struct({
  /** Named workflows the profile participates in (e.g. "code-review", "plan"). */
  workflows: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(256))).pipe(
      Schema.withDecodingDefault(() => []),
    ),
  ),
  /** Brands the profile claims to belong to (vendor/brand identity). */
  brands: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(256))).pipe(
      Schema.withDecodingDefault(() => []),
    ),
  ),
  /** Organizations the profile claims to belong to. */
  organizations: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(256))).pipe(
      Schema.withDecodingDefault(() => []),
    ),
  ),
});
export type AgentProfileTrust = typeof AgentProfileTrust.Type;

/**
 * When and why a profile was quarantined or retired. Kept minimal: the full
 * evidence trail lives in the capability evidence store under the profile's
 * namespace; this is the pointer a user/RPC consumer needs to know why a
 * session was refused.
 */
export const AgentProfileLifecycleEvent = Schema.Struct({
  kind: Schema.Literals(["quarantine", "re-certify", "retire"]),
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  observedAt: IsoDateTime,
});
export type AgentProfileLifecycleEvent = typeof AgentProfileLifecycleEvent.Type;

/**
 * One immutable revision of an external agent profile.
 *
 * The revisionId is derived from the normalized content hash, so identical
 * normalized revisions dedupe to the same revision. Edits insert a new
 * revision and repoint the profile currentRevisionId; historical revisions
 * are never mutated.
 */
export const AgentProfileRevision = Schema.Struct({
  revisionId: AgentProfileRevisionId,
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  connectorKind: ConnectorKind,
  launch: AgentProfileLaunch,
  credentialRefs: Schema.optional(
    Schema.Array(AgentProfileCredentialRef).pipe(Schema.withDecodingDefault(() => [])),
  ),
  provenance: AgentProfileProvenance,
  trust: Schema.optional(AgentProfileTrust),
  parentRevisionId: Schema.optional(AgentProfileRevisionId),
  createdAt: IsoDateTime,
}).pipe(Schema.refine(validateCliConnectorMapping, cliConnectorMappingRefinement));
export type AgentProfileRevision = typeof AgentProfileRevision.Type;

/**
 * Lifecycle state of an external agent profile.
 *
 * - `active`: sessions may start. The pinned revision is trusted OR untrusted;
 *   a trusted profile still must satisfy re-certification cadence.
 * - `quarantined`: sessions are refused; running sessions for this profile are
 *   killed. A broken/abusive agent is quarantined before it can harm more
 *   threads. Re-certification can lift a quarantine into `active`.
 * - `retired`: permanent terminal state (was tombstoned or re-certified as
 *   hopeless). No new sessions, no un-quarantine.
 */
// NOTE: `tombstoned` was removed vs. the KAR-522 base contract. This is an
// intentional breaking literal change for old clients: the status is an
// internal RPC layer value and the only consumer in front of it is the
// archive-only web client, so the removal is safe. Server-side legacy rows are
// normalized to `retired` by migration 099.
export const AgentProfileStatus = Schema.Literals(["active", "quarantined", "retired"]);
export type AgentProfileStatus = typeof AgentProfileStatus.Type;

/**
 * A user-configured external agent connection identified by a stable opaque
 * AgentProfileId. Removal is retirement: the row stays so historical threads
 * can still resolve their referenced revision, but new sessions are refused.
 */
export const AgentProfile = Schema.Struct({
  profileId: AgentProfileId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  currentRevisionId: AgentProfileRevisionId,
  status: AgentProfileStatus.pipe(Schema.withDecodingDefault(() => "active")),
  /** The most recent lifecycle event (quarantine/re-certify/retire), when any. */
  lifecycleEvent: Schema.optional(AgentProfileLifecycleEvent),
  /** Effective trust of the current revision, when derivable from provenance. */
  trust: Schema.optional(AgentProfileTrust),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AgentProfile = typeof AgentProfile.Type;

// RPC input/result types -------------------------------------------------

export const ExternalAgentProfileListResult = Schema.Struct({
  profiles: Schema.Array(AgentProfile),
});
export type ExternalAgentProfileListResult = typeof ExternalAgentProfileListResult.Type;

export const ExternalAgentProfileGetInput = Schema.Struct({
  profileId: AgentProfileId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExternalAgentProfileGetInput = typeof ExternalAgentProfileGetInput.Type;

export const ExternalAgentProfileGetResult = Schema.Struct({
  profile: AgentProfile,
  currentRevision: AgentProfileRevision,
  revisions: Schema.Array(AgentProfileRevision),
});
export type ExternalAgentProfileGetResult = typeof ExternalAgentProfileGetResult.Type;

export const ExternalAgentProfileCreateInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  connectorKind: ConnectorKind,
  launch: AgentProfileLaunch,
  credentialRefs: Schema.optional(Schema.Array(AgentProfileCredentialRef)),
  provenance: Schema.optional(AgentProfileProvenance),
})
  .pipe(Schema.refine(validateCliConnectorMapping, cliConnectorMappingRefinement))
  .annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExternalAgentProfileCreateInput = typeof ExternalAgentProfileCreateInput.Type;

export const ExternalAgentProfileCreateResult = Schema.Struct({
  profile: AgentProfile,
  revision: AgentProfileRevision,
  reused: Schema.Boolean,
});
export type ExternalAgentProfileCreateResult = typeof ExternalAgentProfileCreateResult.Type;

export const ExternalAgentProfileUpdateInput = Schema.Struct({
  profileId: AgentProfileId,
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  launch: AgentProfileLaunch,
  credentialRefs: Schema.optional(Schema.Array(AgentProfileCredentialRef)),
  provenance: Schema.optional(AgentProfileProvenance),
  trust: Schema.optional(AgentProfileTrust),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExternalAgentProfileUpdateInput = typeof ExternalAgentProfileUpdateInput.Type;

export const ExternalAgentProfileUpdateResult = Schema.Struct({
  profile: AgentProfile,
  revision: AgentProfileRevision,
  reused: Schema.Boolean,
});
export type ExternalAgentProfileUpdateResult = typeof ExternalAgentProfileUpdateResult.Type;

export const ExternalAgentProfileTombstoneInput = Schema.Struct({
  profileId: AgentProfileId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExternalAgentProfileTombstoneInput = typeof ExternalAgentProfileTombstoneInput.Type;

export const ExternalAgentProfileTombstoneResult = Schema.Struct({
  profile: AgentProfile,
});
export type ExternalAgentProfileTombstoneResult = typeof ExternalAgentProfileTombstoneResult.Type;

// Lifecycle RPC types (KAR-529) ----------------------------------------------

export const ExternalAgentProfileQuarantineInput = ExternalAgentProfileTombstoneInput;
export type ExternalAgentProfileQuarantineInput = typeof ExternalAgentProfileQuarantineInput.Type;

export const ExternalAgentProfileQuarantineResult = Schema.Struct({
  profile: AgentProfile,
  /** Live sessions for this profile that were force-stopped. */
  stoppedSessions: Schema.Number,
});
export type ExternalAgentProfileQuarantineResult = typeof ExternalAgentProfileQuarantineResult.Type;

export const ExternalAgentProfileUnquarantineInput = ExternalAgentProfileTombstoneInput;
export type ExternalAgentProfileUnquarantineInput =
  typeof ExternalAgentProfileUnquarantineInput.Type;

export const ExternalAgentProfileUnquarantineResult = Schema.Struct({
  profile: AgentProfile,
});
export type ExternalAgentProfileUnquarantineResult =
  typeof ExternalAgentProfileUnquarantineResult.Type;

export const ExternalAgentProfileRecertifyInput = ExternalAgentProfileTombstoneInput;
export type ExternalAgentProfileRecertifyInput = typeof ExternalAgentProfileRecertifyInput.Type;

export const ExternalAgentProfileRecertifyResult = Schema.Struct({
  profile: AgentProfile,
  /** Effective capability states after re-certification, by capability id. */
  states: Schema.Record(Schema.String, Schema.String),
});
export type ExternalAgentProfileRecertifyResult = typeof ExternalAgentProfileRecertifyResult.Type;

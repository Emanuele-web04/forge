// FILE: connectionPlan.ts
// Purpose: Schema-validated contracts for deterministic ACP agent discovery and
//          read-only connection planning. KAR-525 builds the server side only;
//          the Add Agent UI (KAR-526) consumes these shapes.
//
//          Safety invariants (AC #6):
//          - A plan launch is command+argv or an explicit endpoint ONLY. Never a
//            shell string, never fetch-and-run, never a pipeline. Policy
//            enforcement lives in ConnectionPlanPolicy on the server; the schema
//            here pins the shape.
//          - Install metadata is carried for display only. The plan itself never
//            carries an install command; KAR-526 turns a plan into a persisted
//            profile, and installs remain manual.
// Layer: Contracts (schema + data only)
import { Schema } from "effect";

import { IsoDateTime, ProcessEnvRecord, TrimmedNonEmptyString } from "./baseSchemas";
import { AgentProfileLaunch, AgentProfileProvenance } from "./externalAgent";

// ── Discovery sources ────────────────────────────────────────────────

export const AgentConnectionSource = Schema.Literals(["recipe", "registry", "custom"]);
export type AgentConnectionSource = typeof AgentConnectionSource.Type;

export const CandidateDistributionKind = Schema.Literals(["binary", "npx", "uvx"]);
export type CandidateDistributionKind = typeof CandidateDistributionKind.Type;

/** Structured distribution metadata carried by an upstream registry entry. */
export const CandidateDistribution = Schema.Struct({
  kind: CandidateDistributionKind,
  /** Package identifier for npx/uvx distributions, e.g. `cline@3.0.55`. */
  package: Schema.optional(Schema.String),
  /** Relative binary command inside a binary distribution archive, e.g. `./goose`. */
  binaryCmd: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => []))),
  env: Schema.optional(ProcessEnvRecord),
  /** Direct archive URL (binary distributions only), for display / manual install. */
  archiveUrl: Schema.optional(Schema.String),
  /** Publisher-supplied digest for the binary artifact, for display validation. */
  sha256: Schema.optional(Schema.String),
});
export type CandidateDistribution = typeof CandidateDistribution.Type;

/**
 * The upstream ACP Registry entry as Synara consumed it. `provenance` on the
 * candidate records WHERE this data came from (source URL + registry version +
 * fetch time), so a candidate can never be mistaken for a Synara assertion.
 */
export const AcpRegistryEntry = Schema.Struct({
  agentId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  name: Schema.String,
  description: Schema.optional(Schema.String),
  repository: Schema.optional(Schema.String),
  website: Schema.optional(Schema.String),
  authors: Schema.optional(Schema.Array(Schema.String)),
  license: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String),
  distribution: Schema.optional(CandidateDistribution),
  registry: Schema.Struct({
    sourceUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
    registryVersion: Schema.optional(Schema.String),
    fetchedAt: IsoDateTime,
  }),
});
export type AcpRegistryEntry = typeof AcpRegistryEntry.Type;

export const CandidateInstallKind = Schema.Literals(["npx", "uvx", "binary"]);
export type CandidateInstallKind = typeof CandidateInstallKind.Type;

/**
 * Display metadata for "this agent can be installed through X". No shell text
 * is ever stored here: only structured package/archive facts that a UI can
 * render as buttons/links. The plan policy additionally refuses to derive a
 * launch from any free-form string.
 */
export const CandidateInstall = Schema.Struct({
  kind: CandidateInstallKind,
  package: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => []))),
  env: Schema.optional(ProcessEnvRecord),
  binaryCmd: Schema.optional(Schema.String),
  archiveUrl: Schema.optional(Schema.String),
  sha256: Schema.optional(Schema.String),
});
export type CandidateInstall = typeof CandidateInstall.Type;

// ── Version-probe classification (AC #3) ─────────────────────────────

export const CandidateVersionState = Schema.Literals([
  "unprobed",
  "missing",
  "failure",
  "timeout",
  "nonzero",
  "success",
]);
export type CandidateVersionState = typeof CandidateVersionState.Type;

export const CandidateVersionProbe = Schema.Struct({
  state: CandidateVersionState,
  /** Parsed upstream version reported by the probe, when parseable. */
  version: Schema.optional(Schema.String),
  /**
   * Opaque display-only diagnostics for missing/failure/nonzero/timeout
   * (e.g. the probed child's stderr, copied verbatim). Never a source of
   * command/URL/install values: a hostile agent controls what it prints, so
   * nothing may be derived from `detail` for a launch/install decision.
   */
  detail: Schema.optional(Schema.String),
  probedAt: IsoDateTime,
});
export type CandidateVersionProbe = typeof CandidateVersionProbe.Type;

// ── ACP initialize probe (advertised identity/capabilities) ─────────

export const AcpProbeState = Schema.Literals(["ok", "failed"]);
export type AcpProbeState = typeof AcpProbeState.Type;

/**
 * Result of the bounded ACP `initialize` probe. `ok` carries what the agent
 * itself advertises (name/version/auth methods/capabilities) — this is how a
 * candidate is characterized WITHOUT any model: everything here is read off
 * the wire, never synthesized. `failed` carries a structured reason and never
 * a suggested install command.
 */
export const AcpProbeResult = Schema.Struct({
  state: AcpProbeState,
  agentName: Schema.optional(Schema.String),
  agentVersion: Schema.optional(Schema.String),
  authMethodIds: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(() => [])),
  capabilities: Schema.optional(
    Schema.Struct({
      loadSession: Schema.Boolean,
      resumeSession: Schema.Boolean,
      forkSession: Schema.Boolean,
    }),
  ),
  protocolVersion: Schema.optional(Schema.Number),
  /** `executableIdentity` of the probed binary (size:mtime), for change detection. */
  identityFingerprint: Schema.optional(Schema.String),
  /** Failure reason when `state === "failed"`: timeout | auth | spawn | handshake | unknown. */
  reason: Schema.optional(Schema.String),
  /**
   * Opaque display-only failure diagnostics (e.g. the child's stderr or the
   * error text, copied verbatim). Never a source of command/URL/install
   * values: a hostile agent controls what it prints, so nothing may be
   * derived from `detail` for a launch/install decision.
   */
  detail: Schema.optional(Schema.String),
  probedAt: IsoDateTime,
});
export type AcpProbeResult = typeof AcpProbeResult.Type;

// ── Compatibility assessment (recipe overlay, AC #5) ─────────────────

export const CandidateCompatibility = Schema.Struct({
  /** Default true. Recipe overlay can demote a registry entry (listed: false). */
  listed: Schema.optional(Schema.Boolean),
  summary: Schema.optional(Schema.String),
  version: Schema.optional(
    Schema.Struct({
      minimum: Schema.optional(Schema.String),
      knownGood: Schema.optional(Schema.String),
    }),
  ),
});
export type CandidateCompatibility = typeof CandidateCompatibility.Type;

// ── Connection candidate / plan ──────────────────────────────────────

export const ConnectionCandidate = Schema.Struct({
  /** Stable identity for this candidate within a discovery run. */
  candidateId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  agentId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  displayName: Schema.String,
  description: Schema.optional(Schema.String),
  source: AgentConnectionSource,
  /**
   * Absolute path of a detected local executable, when one was found on PATH.
   * Separate candidates per distinct install path (AC #2).
   */
  resolvedPath: Schema.optional(Schema.String),
  /** Remote endpoint candidates (registry entries whose launch is an endpoint). */
  resolvedEndpoint: Schema.optional(Schema.String),
  /** Structured install facts for display; never a command. */
  install: Schema.optional(CandidateInstall),
  versionProbe: Schema.optional(CandidateVersionProbe),
  /** Bounded ACP `initialize` probe of the resolved binary, when run. */
  acpProbe: Schema.optional(AcpProbeResult),
  compatibility: Schema.optional(CandidateCompatibility),
  /** Where this candidate's facts came from (recipe/registry/custom + URL). */
  provenance: AgentProfileProvenance,
  /** The upstream registry record, when source === "registry". */
  registry: Schema.optional(AcpRegistryEntry),
  /** Ordinal for deterministic ordering within the discovery result. */
  order: Schema.Number,
});
export type ConnectionCandidate = typeof ConnectionCandidate.Type;

/**
 * A read-only "what would connecting to this agent look like" plan. The launch
 * reuses the persisted AgentProfileLaunch shape so KAR-526 can hand a plan
 * straight to createProfile after user confirmation. The plan never contains
 * an install command and never trusts docs text (AC #6).
 */
export const ConnectionPlan = Schema.Struct({
  planId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  agentId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  candidateId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  candidateSource: AgentConnectionSource,
  displayName: Schema.String,
  launch: AgentProfileLaunch,
  /**
   * Literal (non-secret) environment the launcher needs (e.g. package-runner
   * distribution env like `AUGMENT_DISABLE_AUTO_UPDATE`). Never credential
   * material: credentials belong in profile credentialRefs, not here.
   */
  launchEnv: Schema.optional(ProcessEnvRecord),
  compatibility: Schema.optional(CandidateCompatibility),
  provenance: AgentProfileProvenance,
  resolvedAt: IsoDateTime,
});
export type ConnectionPlan = typeof ConnectionPlan.Type;

// ── RPC input/result types ───────────────────────────────────────────

export const ConnectionCandidateListInput = Schema.Struct({
  /** Optional custom absolute executable paths to include in discovery. */
  customCommands: Schema.optional(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(4096))).pipe(
      Schema.withDecodingDefault(() => []),
    ),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ConnectionCandidateListInput = typeof ConnectionCandidateListInput.Type;

/**
 * A user-supplied custom command rejected at the discovery input edge. The
 * command text is display-only; `reason` is a structured code so the UI can
 * render a precise explanation without ever treating the text as a runnable
 * command (shell metacharacters are rejected before anything is listed).
 */
export const InvalidCustomCandidate = Schema.Struct({
  command: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  reason: Schema.Literals(["not-absolute", "shell-metacharacters", "not-executable"]),
});
export type InvalidCustomCandidate = typeof InvalidCustomCandidate.Type;

export const RegistrySnapshotStatus = Schema.Struct({
  /** Whether the registry could be loaded (from network or offline cache). */
  available: Schema.Boolean,
  fetchedAt: Schema.optional(IsoDateTime),
  registryVersion: Schema.optional(Schema.String),
  /** Human-readable offline-degradation reason when unavailable. */
  error: Schema.optional(Schema.String),
});
export type RegistrySnapshotStatus = typeof RegistrySnapshotStatus.Type;

export const ConnectionCandidateListResult = Schema.Struct({
  candidates: Schema.Array(ConnectionCandidate),
  registryStatus: RegistrySnapshotStatus,
  /**
   * Custom commands rejected at the input edge (never launched, never listed).
   * Always present on new encodings; defaults to [] when decoding older
   * payloads so old callers keep round-tripping.
   */
  invalidCustomCandidates: Schema.optional(Schema.Array(InvalidCustomCandidate)).pipe(
    Schema.withDecodingDefault(() => []),
  ),
});
export type ConnectionCandidateListResult = typeof ConnectionCandidateListResult.Type;

export const ConnectionPlanResolveInput = Schema.Struct({
  candidateId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  /** Optional working directory the launch should use; defaults to server cwd. */
  cwd: Schema.optional(Schema.String),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ConnectionPlanResolveInput = typeof ConnectionPlanResolveInput.Type;

export const ConnectionPlanResolveResult = Schema.Struct({
  plan: ConnectionPlan,
});
export type ConnectionPlanResolveResult = typeof ConnectionPlanResolveResult.Type;

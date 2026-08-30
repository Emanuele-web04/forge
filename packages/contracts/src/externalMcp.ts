import { Schema } from "effect";

import { IsoDateTime, MessageId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderKind, RuntimeMode } from "./orchestration";

export const EXTERNAL_MCP_AUDIENCE = "synara.external-mcp" as const;
export const EXTERNAL_MCP_MAX_PROMPT_CHARS = 100_000;
export const EXTERNAL_MCP_MAX_REQUEST_ID_LENGTH = 256;
export const EXTERNAL_MCP_DEFAULT_WAIT_MS = 30_000;
export const EXTERNAL_MCP_MAX_WAIT_MS = 60_000;
export const EXTERNAL_MCP_CREATE_TIMEOUT_MS = 10 * 60_000;
export const EXTERNAL_MCP_MAX_MESSAGE_CHARS = 10_000;

export const ExternalMcpCapability = Schema.Literals([
  "projects:read",
  "tasks:create",
  "tasks:wait",
  "tasks:read",
  "tasks:read-project",
  "runtime:local",
  "runtime:full-access",
]);
export type ExternalMcpCapability = typeof ExternalMcpCapability.Type;

export const ExternalMcpClientKind = Schema.Literals([
  "codex",
  "claudeCode",
  "claudeDesktop",
  "other",
]);
export type ExternalMcpClientKind = typeof ExternalMcpClientKind.Type;

// "all" grants every current AND future project; the effective project set is
// recomputed on every request, so newly added projects are visible immediately.
export const ExternalMcpProjectScope = Schema.Literals(["all", "selected"]);
export type ExternalMcpProjectScope = typeof ExternalMcpProjectScope.Type;

export const ExternalMcpIntegrationId = TrimmedNonEmptyString;
export type ExternalMcpIntegrationId = typeof ExternalMcpIntegrationId.Type;

export const ExternalMcpProjectGrant = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
});
export type ExternalMcpProjectGrant = typeof ExternalMcpProjectGrant.Type;

export const ExternalMcpStdioConfiguration = Schema.Struct({
  command: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type ExternalMcpStdioConfiguration = typeof ExternalMcpStdioConfiguration.Type;

export const ExternalMcpIntegration = Schema.Struct({
  integrationId: ExternalMcpIntegrationId,
  name: TrimmedNonEmptyString,
  audience: Schema.Literal(EXTERNAL_MCP_AUDIENCE),
  capabilities: Schema.Array(ExternalMcpCapability),
  projectScope: Schema.optional(ExternalMcpProjectScope).pipe(
    Schema.withDecodingDefault(() => "selected"),
  ),
  allowedProjects: Schema.Array(ExternalMcpProjectGrant),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  lastUsedAt: Schema.NullOr(IsoDateTime),
  pairedAt: Schema.NullOr(IsoDateTime),
  revokedAt: Schema.NullOr(IsoDateTime),
  rateLimitPerMinute: Schema.Int,
  concurrencyLimit: Schema.Int,
  clientKind: ExternalMcpClientKind,
  stdio: ExternalMcpStdioConfiguration,
});
export type ExternalMcpIntegration = typeof ExternalMcpIntegration.Type;

export const ExternalMcpCreateIntegrationInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  // With projectScope "all" the project list is ignored; with "selected"
  // (the default) the service requires at least one project id.
  projectScope: Schema.optional(ExternalMcpProjectScope),
  projectIds: Schema.optional(Schema.Array(ProjectId).check(Schema.isMaxLength(100))),
  capabilities: Schema.Array(ExternalMcpCapability)
    .check(Schema.isMinLength(1))
    .check(Schema.isMaxLength(16)),
  expiresInDays: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(365)),
  ),
  clientKind: Schema.optional(ExternalMcpClientKind),
});
export type ExternalMcpCreateIntegrationInput = typeof ExternalMcpCreateIntegrationInput.Type;

export const ExternalMcpCreateIntegrationResult = Schema.Struct({
  integration: ExternalMcpIntegration,
  pairingCode: TrimmedNonEmptyString,
  pairingExpiresAt: IsoDateTime,
  setupCommand: TrimmedNonEmptyString,
  stdio: ExternalMcpStdioConfiguration,
});
export type ExternalMcpCreateIntegrationResult = typeof ExternalMcpCreateIntegrationResult.Type;

export const ExternalMcpRevokeIntegrationInput = Schema.Struct({
  integrationId: ExternalMcpIntegrationId,
});
export type ExternalMcpRevokeIntegrationInput = typeof ExternalMcpRevokeIntegrationInput.Type;

export const ExternalMcpRefreshPairingInput = Schema.Struct({
  integrationId: ExternalMcpIntegrationId,
});
export type ExternalMcpRefreshPairingInput = typeof ExternalMcpRefreshPairingInput.Type;

export const ExternalMcpPairInput = Schema.Struct({
  pairingCode: TrimmedNonEmptyString,
  credential: TrimmedNonEmptyString,
});
export type ExternalMcpPairInput = typeof ExternalMcpPairInput.Type;

export const ExternalMcpPairResult = Schema.Struct({
  integrationId: ExternalMcpIntegrationId,
  name: TrimmedNonEmptyString,
  credential: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type ExternalMcpPairResult = typeof ExternalMcpPairResult.Type;

export const ExternalMcpCreateTaskInput = Schema.Struct({
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(EXTERNAL_MCP_MAX_REQUEST_ID_LENGTH)),
  projectId: ProjectId,
  provider: ProviderKind,
  model: TrimmedNonEmptyString,
  options: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(EXTERNAL_MCP_MAX_PROMPT_CHARS)),
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(240))),
  environment: Schema.optional(Schema.Literals(["local", "worktree"])),
  runtimeMode: Schema.optional(RuntimeMode),
  baseRef: Schema.optional(TrimmedNonEmptyString),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExternalMcpCreateTaskInput = typeof ExternalMcpCreateTaskInput.Type;

export const ExternalMcpReadTaskInput = Schema.Struct({
  threadId: ThreadId,
  cursor: Schema.optional(Schema.String),
  messageLimit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(100)),
  ),
  maxMessageChars: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(50)).check(
      Schema.isLessThanOrEqualTo(EXTERNAL_MCP_MAX_MESSAGE_CHARS),
    ),
  ),
  messageIndex: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  messageOffsetChars: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  messageId: Schema.optional(MessageId),
  messageVersion: Schema.optional(TrimmedNonEmptyString),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExternalMcpReadTaskInput = typeof ExternalMcpReadTaskInput.Type;

export const ExternalMcpWaitTaskInput = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(
      Schema.isLessThanOrEqualTo(EXTERNAL_MCP_MAX_WAIT_MS),
    ),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExternalMcpWaitTaskInput = typeof ExternalMcpWaitTaskInput.Type;

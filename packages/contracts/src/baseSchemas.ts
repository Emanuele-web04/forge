import { Schema } from "effect";

export const TrimmedString = Schema.Trim;
export const TrimmedNonEmptyString = TrimmedString.check(Schema.isNonEmpty());

export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

// Shared schema for child-process environment overrides (terminals, dev servers).
// Keys follow POSIX env-name rules; values and total size are capped to keep
// requests bounded. Extracted here so terminal and project contracts stay in sync.
const ProcessEnvKey = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)).check(
  Schema.isMaxLength(128),
);
const ProcessEnvValue = Schema.String.check(Schema.isMaxLength(8_192));
export const ProcessEnvRecord = Schema.Record(ProcessEnvKey, ProcessEnvValue).check(
  Schema.isMaxProperties(128),
);
export type ProcessEnvRecord = typeof ProcessEnvRecord.Type;

export const IsoDateTime = Schema.String;
export type IsoDateTime = typeof IsoDateTime.Type;

/**
 * Construct a branded identifier. Enforces non-empty trimmed strings
 */
const makeEntityId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const ThreadId = makeEntityId("ThreadId");
export type ThreadId = typeof ThreadId.Type;
export const ProjectId = makeEntityId("ProjectId");
export type ProjectId = typeof ProjectId.Type;
export const SpaceId = makeEntityId("SpaceId");
export type SpaceId = typeof SpaceId.Type;
export const EnvironmentId = makeEntityId("EnvironmentId");
export type EnvironmentId = typeof EnvironmentId.Type;
export const AuthSessionId = makeEntityId("AuthSessionId");
export type AuthSessionId = typeof AuthSessionId.Type;
export const CommandId = makeEntityId("CommandId");
export type CommandId = typeof CommandId.Type;
export const EventId = makeEntityId("EventId");
export type EventId = typeof EventId.Type;
export const MessageId = makeEntityId("MessageId");
export type MessageId = typeof MessageId.Type;
export const ThreadMarkerId = makeEntityId("ThreadMarkerId");
export type ThreadMarkerId = typeof ThreadMarkerId.Type;
export const AutomationId = makeEntityId("AutomationId");
export type AutomationId = typeof AutomationId.Type;
export const AutomationRunId = makeEntityId("AutomationRunId");
export type AutomationRunId = typeof AutomationRunId.Type;
export const AgentProfileId = makeEntityId("AgentProfileId");
export type AgentProfileId = typeof AgentProfileId.Type;
export const AgentProfileRevisionId = makeEntityId("AgentProfileRevisionId");
export type AgentProfileRevisionId = typeof AgentProfileRevisionId.Type;
export const TurnId = makeEntityId("TurnId");
export type TurnId = typeof TurnId.Type;

export const ProviderItemId = makeEntityId("ProviderItemId");
export type ProviderItemId = typeof ProviderItemId.Type;
export const RuntimeSessionId = makeEntityId("RuntimeSessionId");
export type RuntimeSessionId = typeof RuntimeSessionId.Type;
export const RuntimeItemId = makeEntityId("RuntimeItemId");
export type RuntimeItemId = typeof RuntimeItemId.Type;
export const RuntimeRequestId = makeEntityId("RuntimeRequestId");
export type RuntimeRequestId = typeof RuntimeRequestId.Type;
export const RuntimeTaskId = makeEntityId("RuntimeTaskId");
export type RuntimeTaskId = typeof RuntimeTaskId.Type;
export const ApprovalRequestId = makeEntityId("ApprovalRequestId");
export type ApprovalRequestId = typeof ApprovalRequestId.Type;
export const CheckpointRef = makeEntityId("CheckpointRef");
export type CheckpointRef = typeof CheckpointRef.Type;

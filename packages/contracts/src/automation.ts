import { Schema } from "effect";

import {
  AutomationId,
  AutomationRunId,
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";
import { ModelSelection, ProviderKind, ProviderStartOptions, RuntimeMode } from "./orchestration";

export const DEFAULT_AUTOMATION_RUNTIME_MODE: RuntimeMode = "approval-required";
export const AutomationInteractionMode = Schema.Literals(["default", "plan"]);
export type AutomationInteractionMode = typeof AutomationInteractionMode.Type;

const AutomationIsoDateTime = IsoDateTime.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/),
);

export const AutomationTimeOfDay = TrimmedNonEmptyString.check(
  Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/),
);
export type AutomationTimeOfDay = typeof AutomationTimeOfDay.Type;

export const AutomationTimezone = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type AutomationTimezone = typeof AutomationTimezone.Type;

export const AutomationCronExpression = TrimmedNonEmptyString.check(Schema.isMaxLength(120));
export type AutomationCronExpression = typeof AutomationCronExpression.Type;

export const AutomationSchedule = Schema.Union([
  Schema.Struct({ type: Schema.Literal("manual") }),
  Schema.Struct({
    type: Schema.Literal("once"),
    runAt: AutomationIsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("interval"),
    everySeconds: PositiveInt,
  }),
  Schema.Struct({
    type: Schema.Literal("daily"),
    timeOfDay: AutomationTimeOfDay,
    timezone: Schema.optional(AutomationTimezone),
  }),
  // Runs at `timeOfDay` on every weekday (Mon-Fri) in the optional schedule timezone.
  Schema.Struct({
    type: Schema.Literal("weekdays"),
    timeOfDay: AutomationTimeOfDay,
    timezone: Schema.optional(AutomationTimezone),
  }),
  Schema.Struct({
    type: Schema.Literal("weekly"),
    dayOfWeek: NonNegativeInt.check(Schema.isLessThanOrEqualTo(6)),
    timeOfDay: AutomationTimeOfDay,
    timezone: Schema.optional(AutomationTimezone),
  }),
  Schema.Struct({
    type: Schema.Literal("cron"),
    expression: AutomationCronExpression,
    timezone: AutomationTimezone,
  }),
]);
export type AutomationSchedule = typeof AutomationSchedule.Type;

export const AutomationWorktreeMode = Schema.Literals(["auto", "local", "worktree"]);
export type AutomationWorktreeMode = typeof AutomationWorktreeMode.Type;

/**
 * Automation execution model. It selects *where* runs execute; it never restricts
 * which stop conditions an automation may use.
 * - `standalone`: every run creates a fresh thread + turn (project task on a schedule).
 * - `heartbeat`: every run continues an existing target thread (a self-resuming loop).
 * - `dedicated`: the first run creates a thread the automation owns, and every later
 *   run continues that same thread — one growing conversation instead of one thread
 *   per run, without ever writing into somebody else's thread.
 */
export const AutomationMode = Schema.Literals(["standalone", "heartbeat", "dedicated"]);
export type AutomationMode = typeof AutomationMode.Type;

export const AutomationProposalState = Schema.Literals(["pending", "accepted", "dismissed"]);
export type AutomationProposalState = typeof AutomationProposalState.Type;

export const AutomationNotificationPolicy = Schema.Literals(["all", "failed-runs-only"]);
export type AutomationNotificationPolicy = typeof AutomationNotificationPolicy.Type;

export const DEFAULT_AUTOMATION_NOTIFICATION_POLICY: AutomationNotificationPolicy = "all";
export const DEFAULT_AUTOMATION_HEARTBEAT_COOLDOWN_SECONDS = 60;

export const AutomationTrigger = Schema.Union([
  Schema.Struct({ type: Schema.Literal("manual") }),
  Schema.Struct({ type: Schema.Literal("scheduled") }),
]);
export type AutomationTrigger = typeof AutomationTrigger.Type;

export const AutomationRunStatus = Schema.Literals([
  "pending",
  "claimed",
  "running",
  "waiting-for-approval",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "skipped",
]);
export type AutomationRunStatus = typeof AutomationRunStatus.Type;

export const AutomationRunResult = Schema.Struct({
  outcome: Schema.Literals([
    "findings",
    "no-findings",
    "changed-files",
    "needs-attention",
    "unknown",
  ]),
  summary: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(160))),
  decision: Schema.optional(Schema.Literals(["notify", "silent"])),
  severity: Schema.optional(Schema.Literals(["info", "warning", "error"])),
  unread: Schema.Boolean,
  archivedAt: Schema.NullOr(AutomationIsoDateTime),
  completionEvaluation: Schema.optional(
    Schema.Struct({
      stopMatched: Schema.Boolean,
      confidence: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
        Schema.isLessThanOrEqualTo(1),
      ),
      reason: TrimmedNonEmptyString.check(Schema.isMaxLength(1_000)),
    }),
  ),
});
export type AutomationRunResult = typeof AutomationRunResult.Type;

export const AutomationAllowedCapability = Schema.Literals([
  "send-turn",
  "create-worktree",
  "full-access",
]);
export type AutomationAllowedCapability = typeof AutomationAllowedCapability.Type;

export const AutomationPermissionSnapshot = Schema.Struct({
  provider: ProviderKind,
  settingsRevision: Schema.optional(NonNegativeInt),
  modelSelection: ModelSelection,
  providerOptions: Schema.optional(ProviderStartOptions),
  completionPolicyVersion: Schema.optional(NonNegativeInt),
  /** Stable one-based iteration ordinal claimed for this run. */
  iterationNumber: Schema.optional(PositiveInt),
  runtimeMode: RuntimeMode,
  interactionMode: AutomationInteractionMode,
  worktreeMode: AutomationWorktreeMode,
  allowedCapabilities: Schema.Array(AutomationAllowedCapability),
  createdAt: AutomationIsoDateTime,
});
export type AutomationPermissionSnapshot = typeof AutomationPermissionSnapshot.Type;

export const AutomationRetryPolicy = Schema.Union([
  Schema.Struct({ type: Schema.Literal("none") }),
  Schema.Struct({
    type: Schema.Literal("fixed"),
    maxAttempts: PositiveInt,
    delaySeconds: PositiveInt,
  }),
  Schema.Struct({
    type: Schema.Literal("exponential"),
    maxAttempts: PositiveInt,
    initialDelaySeconds: PositiveInt,
    maxDelaySeconds: PositiveInt,
  }),
]);
export type AutomationRetryPolicy = typeof AutomationRetryPolicy.Type;

export const AutomationMisfirePolicy = Schema.Literals(["skip", "coalesce", "run-latest"]);
export type AutomationMisfirePolicy = typeof AutomationMisfirePolicy.Type;

export const DEFAULT_AUTOMATION_MINIMUM_INTERVAL_SECONDS = 60;
export const DEFAULT_AUTOMATION_FAST_INTERVAL_MAX_ITERATIONS = 10;
export const DEFAULT_AUTOMATION_MAX_RUNTIME_SECONDS = 60 * 60;
export const DEFAULT_AUTOMATION_RETRY_POLICY: AutomationRetryPolicy = { type: "none" };
export const DEFAULT_AUTOMATION_MISFIRE_POLICY: AutomationMisfirePolicy = "coalesce";
export const DEFAULT_AUTOMATION_COMPLETION_POLICY = { type: "none" } as const;
export const DEFAULT_AUTOMATION_STOP_CONFIDENCE_THRESHOLD = 0.8;

export const AutomationCompletionPolicy = Schema.Union([
  Schema.Struct({ type: Schema.Literal("none") }),
  Schema.Struct({
    type: Schema.Literal("ai-evaluated"),
    stopWhen: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
    confidenceThreshold: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
      Schema.isLessThanOrEqualTo(1),
    ),
  }),
]);
export type AutomationCompletionPolicy = typeof AutomationCompletionPolicy.Type;

export const AutomationDefinition = Schema.Struct({
  id: AutomationId,
  projectId: ProjectId,
  sourceThreadId: Schema.NullOr(ThreadId),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(64_000)),
  schedule: AutomationSchedule,
  enabled: Schema.Boolean,
  nextRunAt: Schema.NullOr(AutomationIsoDateTime),
  modelSelection: ModelSelection,
  providerOptions: Schema.optional(ProviderStartOptions),
  runtimeMode: RuntimeMode,
  interactionMode: AutomationInteractionMode,
  worktreeMode: AutomationWorktreeMode,
  mode: AutomationMode,
  /**
   * Thread continued on each wake: the user-chosen target for heartbeat, or the
   * automation's own thread for dedicated (server-assigned after its first run).
   * Always null for standalone automations.
   */
  targetThreadId: Schema.NullOr(ThreadId),
  /** Suggested agent-created automations require an explicit user resolution. */
  proposalState: Schema.optional(Schema.NullOr(AutomationProposalState)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  /** Successful-run attention policy. Null legacy rows decode as the default "all". */
  notificationPolicy: Schema.optional(AutomationNotificationPolicy).pipe(
    Schema.withDecodingDefault(() => DEFAULT_AUTOMATION_NOTIFICATION_POLICY),
  ),
  /** Minimum quiet period after the continued thread's last completed turn. */
  heartbeatCooldownSeconds: Schema.optional(NonNegativeInt).pipe(
    Schema.withDecodingDefault(() => DEFAULT_AUTOMATION_HEARTBEAT_COOLDOWN_SECONDS),
  ),
  /** Hard cap on total runs before the automation auto-disables. Null = unbounded. */
  maxIterations: Schema.NullOr(PositiveInt),
  /** When true, a failed run disables the automation (stops a runaway loop). */
  stopOnError: Schema.Boolean,
  /** Natural language stop condition, evaluated in every mode. */
  completionPolicy: Schema.optional(AutomationCompletionPolicy).pipe(
    Schema.withDecodingDefault(() => DEFAULT_AUTOMATION_COMPLETION_POLICY),
  ),
  /** Increments whenever the persisted stop policy changes; run snapshots use it for stale checks. */
  completionPolicyVersion: Schema.optional(NonNegativeInt).pipe(
    Schema.withDecodingDefault(() => 0),
  ),
  /** Save time for the current completion policy; used only for legacy run snapshots. */
  completionPolicyUpdatedAt: Schema.optional(AutomationIsoDateTime).pipe(
    Schema.withDecodingDefault(() => "1970-01-01T00:00:00.000Z"),
  ),
  minimumIntervalSeconds: PositiveInt,
  maxRuntimeSeconds: Schema.NullOr(PositiveInt),
  retryPolicy: AutomationRetryPolicy,
  misfirePolicy: AutomationMisfirePolicy,
  acknowledgedRisks: Schema.Array(
    Schema.Literals(["full-access", "local-checkout", "fast-interval"]),
  ),
  /** Number of runs created so far; used to enforce maxIterations. */
  iterationCount: NonNegativeInt,
  createdAt: AutomationIsoDateTime,
  updatedAt: AutomationIsoDateTime,
  archivedAt: Schema.NullOr(AutomationIsoDateTime),
});
export type AutomationDefinition = typeof AutomationDefinition.Type;

const AutomationDefinitionConfig = Schema.Struct({
  projectId: ProjectId,
  sourceThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(64_000)),
  schedule: AutomationSchedule,
  enabled: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => true)),
  modelSelection: ModelSelection,
  providerOptions: Schema.optional(ProviderStartOptions),
  runtimeMode: Schema.optional(RuntimeMode).pipe(
    Schema.withDecodingDefault(() => DEFAULT_AUTOMATION_RUNTIME_MODE),
  ),
  interactionMode: Schema.optional(AutomationInteractionMode).pipe(
    Schema.withDecodingDefault(() => "default" as const),
  ),
  worktreeMode: Schema.optional(AutomationWorktreeMode).pipe(
    Schema.withDecodingDefault(() => "auto" as const),
  ),
  mode: Schema.optional(AutomationMode).pipe(
    Schema.withDecodingDefault(() => "standalone" as const),
  ),
  targetThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  proposalState: Schema.optional(Schema.NullOr(AutomationProposalState)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  notificationPolicy: Schema.optional(AutomationNotificationPolicy).pipe(
    Schema.withDecodingDefault(() => DEFAULT_AUTOMATION_NOTIFICATION_POLICY),
  ),
  heartbeatCooldownSeconds: Schema.optional(NonNegativeInt).pipe(
    Schema.withDecodingDefault(() => DEFAULT_AUTOMATION_HEARTBEAT_COOLDOWN_SECONDS),
  ),
  maxIterations: Schema.optional(Schema.NullOr(PositiveInt)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  stopOnError: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => true)),
  completionPolicy: Schema.optional(AutomationCompletionPolicy).pipe(
    Schema.withDecodingDefault(() => DEFAULT_AUTOMATION_COMPLETION_POLICY),
  ),
  minimumIntervalSeconds: Schema.optional(PositiveInt).pipe(
    Schema.withDecodingDefault(() => DEFAULT_AUTOMATION_MINIMUM_INTERVAL_SECONDS),
  ),
  maxRuntimeSeconds: Schema.optional(Schema.NullOr(PositiveInt)).pipe(
    Schema.withDecodingDefault(() => DEFAULT_AUTOMATION_MAX_RUNTIME_SECONDS),
  ),
  retryPolicy: Schema.optional(AutomationRetryPolicy).pipe(
    Schema.withDecodingDefault(() => DEFAULT_AUTOMATION_RETRY_POLICY),
  ),
  misfirePolicy: Schema.optional(AutomationMisfirePolicy).pipe(
    Schema.withDecodingDefault(() => DEFAULT_AUTOMATION_MISFIRE_POLICY),
  ),
  acknowledgedRisks: Schema.optional(
    Schema.Array(Schema.Literals(["full-access", "local-checkout", "fast-interval"])),
  ).pipe(Schema.withDecodingDefault(() => [])),
});

export const AutomationCreateInput = AutomationDefinitionConfig;
export type AutomationCreateInput = typeof AutomationCreateInput.Type;

export const AutomationUpdateInput = Schema.Struct({
  id: AutomationId,
  projectId: Schema.optional(ProjectId),
  sourceThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(160))),
  prompt: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64_000))),
  schedule: Schema.optional(AutomationSchedule),
  enabled: Schema.optional(Schema.Boolean),
  modelSelection: Schema.optional(ModelSelection),
  providerOptions: Schema.optional(ProviderStartOptions),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(AutomationInteractionMode),
  worktreeMode: Schema.optional(AutomationWorktreeMode),
  mode: Schema.optional(AutomationMode),
  targetThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  proposalState: Schema.optional(Schema.NullOr(AutomationProposalState)),
  notificationPolicy: Schema.optional(AutomationNotificationPolicy),
  heartbeatCooldownSeconds: Schema.optional(NonNegativeInt),
  maxIterations: Schema.optional(Schema.NullOr(PositiveInt)),
  stopOnError: Schema.optional(Schema.Boolean),
  completionPolicy: Schema.optional(AutomationCompletionPolicy),
  minimumIntervalSeconds: Schema.optional(PositiveInt),
  maxRuntimeSeconds: Schema.optional(Schema.NullOr(PositiveInt)),
  retryPolicy: Schema.optional(AutomationRetryPolicy),
  misfirePolicy: Schema.optional(AutomationMisfirePolicy),
  acknowledgedRisks: Schema.optional(
    Schema.Array(Schema.Literals(["full-access", "local-checkout", "fast-interval"])),
  ),
});
export type AutomationUpdateInput = typeof AutomationUpdateInput.Type;

export const AutomationDeleteInput = Schema.Struct({
  id: AutomationId,
});
export type AutomationDeleteInput = typeof AutomationDeleteInput.Type;

export const AutomationResolveProposalInput = Schema.Struct({
  automationId: AutomationId,
  resolution: Schema.Literals(["accepted", "dismissed"]),
});
export type AutomationResolveProposalInput = typeof AutomationResolveProposalInput.Type;

export const AutomationResolveProposalResult = Schema.Struct({
  definition: AutomationDefinition,
});
export type AutomationResolveProposalResult = typeof AutomationResolveProposalResult.Type;

export const AutomationListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  includeArchived: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
});
export type AutomationListInput = typeof AutomationListInput.Type;

export const AutomationGetMemoryInput = Schema.Struct({
  automationId: AutomationId,
});
export type AutomationGetMemoryInput = typeof AutomationGetMemoryInput.Type;

export const AutomationRunNowInput = Schema.Struct({
  automationId: AutomationId,
});
export type AutomationRunNowInput = typeof AutomationRunNowInput.Type;

export const AutomationCancelRunInput = Schema.Struct({
  runId: AutomationRunId,
});
export type AutomationCancelRunInput = typeof AutomationCancelRunInput.Type;

export const AutomationMarkRunReadInput = Schema.Struct({
  runId: AutomationRunId,
  unread: Schema.Boolean,
});
export type AutomationMarkRunReadInput = typeof AutomationMarkRunReadInput.Type;

export const AutomationArchiveRunInput = Schema.Struct({
  runId: AutomationRunId,
  archived: Schema.Boolean,
});
export type AutomationArchiveRunInput = typeof AutomationArchiveRunInput.Type;

export const AutomationRun = Schema.Struct({
  id: AutomationRunId,
  automationId: AutomationId,
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId),
  turnId: Schema.optional(Schema.NullOr(TurnId)),
  trigger: AutomationTrigger,
  status: AutomationRunStatus,
  scheduledFor: AutomationIsoDateTime,
  deferredUntil: Schema.optional(Schema.NullOr(AutomationIsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  claimedBy: Schema.NullOr(TrimmedNonEmptyString),
  claimedAt: Schema.NullOr(AutomationIsoDateTime),
  leaseExpiresAt: Schema.NullOr(AutomationIsoDateTime),
  startedAt: Schema.NullOr(AutomationIsoDateTime),
  finishedAt: Schema.NullOr(AutomationIsoDateTime),
  threadCreateCommandId: Schema.NullOr(CommandId),
  turnStartCommandId: Schema.NullOr(CommandId),
  messageId: Schema.NullOr(MessageId),
  error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4_000))),
  result: Schema.NullOr(AutomationRunResult),
  permissionSnapshot: AutomationPermissionSnapshot,
  createdAt: AutomationIsoDateTime,
  updatedAt: AutomationIsoDateTime,
});
export type AutomationRun = typeof AutomationRun.Type;

export const AutomationMemory = Schema.Struct({
  automationId: AutomationId,
  content: Schema.String.check(Schema.isMaxLength(32 * 1_024)),
  updatedAt: AutomationIsoDateTime,
});
export type AutomationMemory = typeof AutomationMemory.Type;

export const AutomationListResult = Schema.Struct({
  definitions: Schema.Array(AutomationDefinition),
  runs: Schema.Array(AutomationRun),
  memories: Schema.optional(Schema.Array(AutomationMemory)).pipe(
    Schema.withDecodingDefault(() => []),
  ),
});
export type AutomationListResult = typeof AutomationListResult.Type;

export const AutomationRunNowResult = Schema.Struct({
  run: AutomationRun,
});
export type AutomationRunNowResult = typeof AutomationRunNowResult.Type;

export const AutomationCancelRunResult = Schema.Struct({
  run: AutomationRun,
});
export type AutomationCancelRunResult = typeof AutomationCancelRunResult.Type;

export const AutomationRunActionResult = Schema.Struct({
  run: AutomationRun,
});
export type AutomationRunActionResult = typeof AutomationRunActionResult.Type;

export const AutomationStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    definitions: Schema.Array(AutomationDefinition),
    runs: Schema.Array(AutomationRun),
    memories: Schema.optional(Schema.Array(AutomationMemory)).pipe(
      Schema.withDecodingDefault(() => []),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("definition-upserted"),
    definition: AutomationDefinition,
  }),
  Schema.Struct({
    type: Schema.Literal("definition-deleted"),
    automationId: AutomationId,
  }),
  Schema.Struct({
    type: Schema.Literal("run-upserted"),
    run: AutomationRun,
  }),
  Schema.Struct({
    type: Schema.Literal("memory-upserted"),
    memory: AutomationMemory,
  }),
]);
export type AutomationStreamEvent = typeof AutomationStreamEvent.Type;

import { randomUUID } from "node:crypto";

import {
  AutomationId,
  AutomationRunId,
  CommandId,
  DEFAULT_AUTOMATION_FAST_INTERVAL_MAX_ITERATIONS,
  DEFAULT_AUTOMATION_HEARTBEAT_COOLDOWN_SECONDS,
  DEFAULT_AUTOMATION_MINIMUM_INTERVAL_SECONDS,
  DEFAULT_AUTOMATION_STOP_AFTER_CONSECUTIVE_FAILURES,
  MessageId,
  ThreadId,
  type AutomationAllowedCapability,
  type AutomationCompletionPolicy,
  type AutomationCreateInput,
  type AutomationDefinition,
  type AutomationRun,
  type AutomationRunResult,
  type AutomationRunNowResult,
  type AutomationRunStatus,
  type AutomationStreamEvent,
  type AutomationUpdateInput,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ProviderStartOptions,
  type ThreadEnvironmentMode,
  type TurnId,
} from "@synara/contracts";
import {
  automationContinuationThreadId,
  automationContinuesThread,
  automationOwnsItsThread,
  automationRequiresTargetThread,
} from "@synara/shared/automationMode";
import { buildTemporaryWorktreeBranchName } from "@synara/shared/git";
import { providerStartOptionsFromServerSettings } from "@synara/shared/serverSettings";
import { autoRuntimeModeSelectionIssue } from "@synara/shared/runtimeMode";
import { Cause, Effect, Layer, Option, PubSub, Queue, Stream } from "effect";

import { GitCore } from "../../git/Services/GitCore.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import {
  hasDedicatedTextGenerationProvider,
  resolveTextGenerationInputForSelection,
} from "../../git/textGenerationSelection.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { providerDisabledSettingsMessage } from "../../provider/enabledProviderAdapter.ts";
import { threadHasInFlightTurn } from "../../orchestration/commandInvariants.ts";
import {
  AutomationRepository,
  type MarkAutomationRunFailedResult,
} from "../../persistence/Services/AutomationRepository.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { runWorktreeSetupScript } from "../../worktreeSetup.ts";
import type { ProjectionTurn } from "../../persistence/Services/ProjectionTurns.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { AutomationServiceError } from "../Errors.ts";
import { AutomationService, type AutomationServiceShape } from "../Services/AutomationService.ts";
import { buildAutomationProposalActivity } from "../proposalActivity.ts";
import {
  type AutomationCompletionEvaluation,
  automationCompletionRunResult,
  automationRunResultSummary,
  automationRunResultSummaryWithNotice,
  failedAutomationCompletionEvaluation,
  normalizeAutomationCompletionReason,
} from "../runResult.ts";
import { buildAutomationRunEnvelope } from "../runEnvelope.ts";
import { resolveAutomationStopPolicy } from "../stopPolicy.ts";
import {
  type AutomationScheduleJitterContext,
  computeAutomationScheduleSpacingSeconds,
  computeNextAutomationRunAt,
  computeNextAutomationRunAtAfter,
} from "../schedule.ts";

const AUTOMATION_ERROR_MAX_CHARS = 4_000;
const FAST_INTERVAL_ACKNOWLEDGED_MINIMUM_SECONDS = 1;
const AUTOMATION_COMPLETION_EVALUATION_WORKERS = 2;
const AUTOMATION_COMPLETION_EVALUATION_QUEUE_CAPACITY = 100;
// Hard ceiling on a single AI stop-evaluation. With only a couple of evaluation
// workers, a hung provider call would otherwise pin a worker indefinitely and
// starve stop checks for every other heartbeat automation.
const AUTOMATION_COMPLETION_EVALUATION_TIMEOUT_MS = 30_000;
const AUTOMATION_HEARTBEAT_DEFER_RETRY_MS = 15_000;
const AUTOMATION_HEARTBEAT_DEFER_WINDOW_MS = 10 * 60_000;
const AUTOMATION_MEMORY_MAX_BYTES = 32 * 1_024;
const AUTOMATION_DEFINITION_UPDATE_MAX_ATTEMPTS = 3;

interface AutomationCompletionEvaluationJob {
  readonly definition: AutomationDefinition;
  readonly run: AutomationRun;
  readonly policy: Extract<AutomationCompletionPolicy, { type: "ai-evaluated" }>;
}

/** Statuses a run can no longer leave; reconciliation never overwrites these. */
const TERMINAL_RUN_STATUSES: ReadonlySet<AutomationRunStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "skipped",
]);

function isTerminalRunStatus(status: AutomationRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

function isoNow(): string {
  return new Date().toISOString();
}

function nextDefinitionUpdatedAt(previousUpdatedAt: string): string {
  const candidate = isoNow();
  const previousTime = Date.parse(previousUpdatedAt);
  const candidateTime = Date.parse(candidate);
  return Number.isFinite(previousTime) && candidateTime <= previousTime
    ? new Date(previousTime + 1).toISOString()
    : candidate;
}

function makeAutomationId(): AutomationId {
  return AutomationId.makeUnsafe(`automation:${randomUUID()}`);
}

function makeAutomationRunId(): AutomationRunId {
  return AutomationRunId.makeUnsafe(`automation-run:${randomUUID()}`);
}

function makeAutomationCommandId(runId: AutomationRunId, suffix: string): CommandId {
  return CommandId.makeUnsafe(`automation:${runId}:${suffix}`);
}

function deriveAutomationRunIds(runId: AutomationRunId) {
  return {
    threadId: ThreadId.makeUnsafe(`automation:${runId}:thread`),
    messageId: MessageId.makeUnsafe(`automation:${runId}:message`),
    threadCreateCommandId: CommandId.makeUnsafe(`automation:${runId}:thread-create`),
    turnStartCommandId: CommandId.makeUnsafe(`automation:${runId}:turn-start`),
  };
}

/** Redact common secret shapes before persisting/surfacing an automation error string. */
function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk|pk|ghp|gho|ghs|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(
      /\b(authorization|bearer|token|api[_-]?key|secret|password)\b(\s*[=:]\s*|\s+)\S+/gi,
      "$1=[redacted]",
    );
}

function errorMessage(cause: unknown): string {
  const raw =
    cause instanceof Error && cause.message.trim().length > 0 ? cause.message : String(cause);
  return redactSecrets(raw).slice(0, AUTOMATION_ERROR_MAX_CHARS);
}

// Recovery/reconcile failures arrive multiply wrapped: toServiceError ->
// AutomationServiceError whose `.cause` is often a PersistenceSqlError whose own `.cause`
// holds the real driver failure ("database is locked", a constraint, ...). Each layer's
// own `message` is a generic wrapper string, so walk down the `.cause` chain to the root
// and log that, otherwise the warning is unactionable. Bounded to avoid a cyclic cause.
function recoveryErrorMessage(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current == null || typeof current !== "object" || !("cause" in current)) {
      break;
    }
    const cause = (current as { readonly cause?: unknown }).cause;
    if (cause == null) {
      break;
    }
    current = cause;
  }
  return errorMessage(current);
}

function resultSummary(value: string | null | undefined, fallback?: string): string | null {
  return automationRunResultSummary(value, fallback);
}

function completionFailureReason(error: unknown): string {
  const message = error instanceof AutomationServiceError ? error.message : errorMessage(error);
  return normalizeAutomationCompletionReason(`Stop check failed: ${message}`);
}

function isSameAiCompletionPolicy(
  left: Extract<AutomationCompletionPolicy, { type: "ai-evaluated" }>,
  right: Extract<AutomationCompletionPolicy, { type: "ai-evaluated" }>,
): boolean {
  return left.stopWhen === right.stopWhen && left.confidenceThreshold === right.confidenceThreshold;
}

function isSameCompletionPolicy(
  left: AutomationCompletionPolicy,
  right: AutomationCompletionPolicy,
): boolean {
  if (left.type !== right.type) {
    return false;
  }
  if (left.type === "none") {
    return true;
  }
  return right.type === "ai-evaluated" && isSameAiCompletionPolicy(left, right);
}

const DEFAULT_COMPLETION_POLICY = { type: "none" } as const satisfies AutomationCompletionPolicy;

type CallerAutomationRunFailure =
  | "no-active-turn"
  | "not-automation-dispatched"
  | "turn-not-part-of-run";

type CallerAutomationRunResolution =
  | { readonly run: AutomationRun }
  | { readonly reason: CallerAutomationRunFailure };

const CALLER_AUTOMATION_RUN_FAILURES: Record<CallerAutomationRunFailure, string> = {
  "no-active-turn": "This operation is only available inside an active automation turn.",
  "not-automation-dispatched": "The active turn was not dispatched by an automation.",
  "turn-not-part-of-run": "The active turn was not dispatched by this automation run.",
};

function completionPolicyForDefinition(
  definition: AutomationDefinition,
): AutomationCompletionPolicy {
  return definition.completionPolicy ?? DEFAULT_COMPLETION_POLICY;
}

function completionPolicyVersionForDefinition(definition: AutomationDefinition): number {
  return definition.completionPolicyVersion ?? 1;
}

function completionPolicyUpdatedAtForDefinition(definition: AutomationDefinition): string {
  return definition.completionPolicyUpdatedAt ?? definition.createdAt;
}

function runUsesCurrentCompletionPolicy(
  run: AutomationRun,
  definition: AutomationDefinition,
): boolean {
  if (run.permissionSnapshot.completionPolicyVersion !== undefined) {
    return (
      run.permissionSnapshot.completionPolicyVersion ===
      completionPolicyVersionForDefinition(definition)
    );
  }
  const runPolicyAnchorMs = Date.parse(run.startedAt ?? run.createdAt);
  const policyUpdatedAtMs = Date.parse(completionPolicyUpdatedAtForDefinition(definition));
  return (
    Number.isFinite(runPolicyAnchorMs) &&
    Number.isFinite(policyUpdatedAtMs) &&
    runPolicyAnchorMs > policyUpdatedAtMs
  );
}

function resultForRunStatus(
  status: AutomationRunStatus,
  input: { readonly summary?: string | null; readonly now: string },
): AutomationRunResult | null {
  switch (status) {
    case "succeeded":
      return {
        outcome: "unknown",
        summary: resultSummary(input.summary),
        unread: true,
        archivedAt: null,
      };
    case "failed":
    case "interrupted":
    case "cancelled":
    case "waiting-for-approval":
      return {
        outcome: "needs-attention",
        summary: resultSummary(input.summary, "Automation run needs attention."),
        severity: status === "failed" ? "error" : "warning",
        unread: true,
        archivedAt: null,
      };
    case "skipped":
      return {
        outcome: "no-findings",
        summary: resultSummary(input.summary, "Run skipped."),
        severity: "info",
        unread: false,
        archivedAt: input.now,
      };
    case "pending":
    case "claimed":
    case "running":
      return null;
  }
}

function toServiceError(message: string) {
  return (cause: unknown) => new AutomationServiceError({ message, cause });
}

function hasOwn<T extends object, K extends PropertyKey>(
  value: T,
  key: K,
): value is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function allowedCapabilitiesFor(definition: AutomationDefinition): AutomationAllowedCapability[] {
  const capabilities: AutomationAllowedCapability[] = ["send-turn"];
  if (definition.worktreeMode !== "local") {
    capabilities.push("create-worktree");
  }
  if (definition.runtimeMode === "full-access") {
    capabilities.push("full-access");
  }
  return capabilities;
}

function makePermissionSnapshot(
  definition: AutomationDefinition,
  now: string,
  settingsRevision?: number,
  providerOptions?: ProviderStartOptions,
) {
  return {
    provider: definition.modelSelection.provider,
    ...(settingsRevision !== undefined ? { settingsRevision } : {}),
    modelSelection: definition.modelSelection,
    ...(providerOptions ? { providerOptions } : {}),
    completionPolicyVersion: completionPolicyVersionForDefinition(definition),
    iterationNumber: definition.iterationCount + 1,
    runtimeMode: definition.runtimeMode,
    interactionMode: definition.interactionMode,
    worktreeMode: definition.worktreeMode,
    allowedCapabilities: allowedCapabilitiesFor(definition),
    createdAt: now,
  };
}

function safeComputeNextRunAt(
  schedule: AutomationDefinition["schedule"],
  now: string,
  fallback: string | null,
  jitterContext?: AutomationScheduleJitterContext,
) {
  try {
    return computeNextAutomationRunAt(schedule, now, jitterContext);
  } catch {
    return fallback;
  }
}

function effectiveMinimumIntervalSeconds(input: {
  readonly minimumIntervalSeconds: number;
  readonly acknowledgedRisks: readonly string[];
}): number {
  if (
    input.acknowledgedRisks.includes("fast-interval") &&
    input.minimumIntervalSeconds === DEFAULT_AUTOMATION_MINIMUM_INTERVAL_SECONDS
  ) {
    return FAST_INTERVAL_ACKNOWLEDGED_MINIMUM_SECONDS;
  }
  return input.minimumIntervalSeconds;
}

// Single source of truth for the runtime risks an automation must acknowledge before it can
// run. Enforced uniformly at create, update, and run (dispatchRun) so an automation can never
// reach a run unacknowledged. The `local` worktree check applies to every mode: a heartbeat
// reuses its target thread, but that thread can itself sit on the local checkout, so continuing
// it still runs the provider against the active project root.
function riskAcknowledgementError(input: {
  readonly runtimeMode: AutomationDefinition["runtimeMode"];
  readonly worktreeMode: AutomationDefinition["worktreeMode"];
  readonly acknowledgedRisks: readonly string[];
}): string | null {
  const acknowledgedRisks = new Set(input.acknowledgedRisks);
  if (input.runtimeMode === "full-access" && !acknowledgedRisks.has("full-access")) {
    return "Automation full-access mode requires an explicit acknowledgement.";
  }
  if (input.worktreeMode === "local" && !acknowledgedRisks.has("local-checkout")) {
    return "Automation local checkout mode requires an explicit acknowledgement.";
  }
  return null;
}

// Single source of truth for the fast-interval policy: a sub-minute schedule needs the
// `fast-interval` acknowledgement AND a bounded iteration cap, treated as a pair so an
// acknowledged loop can't run unbounded. Shared by validateSchedulePolicy (create/update) and
// the dispatch gate (the run-path backstop). May throw if the schedule has an invalid cron or
// timezone, so callers must wrap it (Effect.try) to surface a typed error.
function fastIntervalPolicyError(input: {
  readonly schedule: AutomationDefinition["schedule"];
  readonly enabled: boolean;
  readonly maxIterations: AutomationDefinition["maxIterations"];
  readonly acknowledgedRisks: readonly string[];
  readonly now: string;
}): string | null {
  const spacingSeconds = computeAutomationScheduleSpacingSeconds(input.schedule, input.now);
  if (spacingSeconds === null || spacingSeconds >= DEFAULT_AUTOMATION_MINIMUM_INTERVAL_SECONDS) {
    return null;
  }
  if (!input.acknowledgedRisks.includes("fast-interval")) {
    return `Automation schedule must run at least ${DEFAULT_AUTOMATION_MINIMUM_INTERVAL_SECONDS} seconds apart.`;
  }
  const exceedsFastIterationCap =
    input.maxIterations === null ||
    input.maxIterations > DEFAULT_AUTOMATION_FAST_INTERVAL_MAX_ITERATIONS;
  // Pausing a legacy fast loop must always remain possible; enforce the hard cap only for
  // definitions that will continue running.
  if (input.enabled && exceedsFastIterationCap) {
    return `Fast interval automations must set max iterations to ${DEFAULT_AUTOMATION_FAST_INTERVAL_MAX_ITERATIONS} runs or fewer.`;
  }
  return null;
}

function proposalCreateError(input: AutomationCreateInput): string | null {
  if (input.proposalState === "accepted" || input.proposalState === "dismissed") {
    return "New automation proposals must start in the pending state.";
  }
  if (input.proposalState === "pending" && input.enabled !== false) {
    return "Pending automation proposals must be created disabled.";
  }
  return null;
}

function isBeforeIso(value: string, comparison: string): boolean {
  const valueMs = Date.parse(value);
  const comparisonMs = Date.parse(comparison);
  return Number.isFinite(valueMs) && Number.isFinite(comparisonMs) && valueMs < comparisonMs;
}

function hasExceededMaxRuntime(
  definition: AutomationDefinition,
  run: AutomationRun,
  now: string,
): boolean {
  if (definition.maxRuntimeSeconds === null || run.startedAt === null) {
    return false;
  }
  const startedAtMs = Date.parse(run.startedAt);
  const nowMs = Date.parse(now);
  return (
    Number.isFinite(startedAtMs) &&
    Number.isFinite(nowMs) &&
    nowMs - startedAtMs >= definition.maxRuntimeSeconds * 1000
  );
}

function runUsesExistingThread(run: AutomationRun): boolean {
  return run.threadCreateCommandId === null;
}

function definitionReachedMaxIterations(definition: AutomationDefinition): boolean {
  return definition.maxIterations !== null && definition.iterationCount >= definition.maxIterations;
}

function scheduledOccurrenceForDefinition(
  definition: AutomationDefinition,
  now: string,
  jitterContext: AutomationScheduleJitterContext,
) {
  const plannedScheduledFor = definition.nextRunAt ?? now;
  const missed = isBeforeIso(plannedScheduledFor, now);
  const scheduledFor =
    missed && definition.misfirePolicy === "run-latest" ? now : plannedScheduledFor;
  const nextRunAt = computeNextAutomationRunAtAfter(
    definition.schedule,
    scheduledFor,
    now,
    jitterContext,
  );
  return {
    scheduledFor,
    nextRunAt,
    skip: missed && definition.misfirePolicy === "skip",
  };
}

function mergeDefinitionUpdate(
  current: AutomationDefinition,
  input: AutomationUpdateInput,
  now: string,
  jitterContext: AutomationScheduleJitterContext,
): AutomationDefinition {
  const schedule = input.schedule ?? current.schedule;
  const nextRunAt =
    schedule.type === "manual"
      ? null
      : input.schedule
        ? safeComputeNextRunAt(schedule, now, current.nextRunAt, jitterContext)
        : (current.nextRunAt ?? safeComputeNextRunAt(schedule, now, null, jitterContext));
  const providerOptions = input.providerOptions ?? current.providerOptions;
  const mode = input.mode ?? current.mode;
  const currentCompletionPolicy = completionPolicyForDefinition(current);
  const completionPolicy = input.completionPolicy ?? currentCompletionPolicy;
  const completionPolicyChanged = !isSameCompletionPolicy(
    currentCompletionPolicy,
    completionPolicy,
  );
  // A dedicated automation owns its continuation thread, so the caller never picks it and
  // an update must not move it. Changing mode always releases the previous thread: the new
  // mode either needs none (standalone), needs a caller-supplied one (heartbeat), or must
  // create its own on the next run (dedicated).
  const targetThreadId =
    mode !== current.mode
      ? automationRequiresTargetThread(mode)
        ? ((input.targetThreadId as AutomationDefinition["targetThreadId"] | undefined) ?? null)
        : null
      : automationOwnsItsThread(mode)
        ? current.targetThreadId
        : hasOwn(input, "targetThreadId")
          ? ((input.targetThreadId as AutomationDefinition["targetThreadId"] | undefined) ?? null)
          : current.targetThreadId;
  // Run caps apply to every mode; chat parsing uses them for bounded requests like
  // "every 15 seconds for 3 times".
  const maxIterations = hasOwn(input, "maxIterations")
    ? ((input.maxIterations as AutomationDefinition["maxIterations"] | undefined) ?? null)
    : current.maxIterations;
  const enabled = input.enabled ?? current.enabled;
  const userDisabled = current.enabled && !enabled;
  const userReenabled = !current.enabled && enabled;
  const userRestartedExhaustedLoop =
    userReenabled &&
    (current.disabledReason === "max-iterations" ||
      (maxIterations !== null && current.iterationCount >= maxIterations));
  const currentFailureThreshold =
    current.stopAfterConsecutiveFailures === undefined
      ? DEFAULT_AUTOMATION_STOP_AFTER_CONSECUTIVE_FAILURES
      : current.stopAfterConsecutiveFailures;
  const nextDefinition: AutomationDefinition = {
    ...current,
    projectId: input.projectId ?? current.projectId,
    sourceThreadId: hasOwn(input, "sourceThreadId")
      ? ((input.sourceThreadId as AutomationDefinition["sourceThreadId"] | undefined) ?? null)
      : current.sourceThreadId,
    name: input.name ?? current.name,
    prompt: input.prompt ?? current.prompt,
    schedule,
    enabled,
    nextRunAt,
    modelSelection: input.modelSelection ?? current.modelSelection,
    runtimeMode: input.runtimeMode ?? current.runtimeMode,
    interactionMode: input.interactionMode ?? current.interactionMode,
    worktreeMode: input.worktreeMode ?? current.worktreeMode,
    mode,
    targetThreadId,
    proposalState: current.proposalState,
    notificationPolicy: input.notificationPolicy ?? current.notificationPolicy,
    heartbeatCooldownSeconds: input.heartbeatCooldownSeconds ?? current.heartbeatCooldownSeconds,
    maxIterations,
    stopAfterConsecutiveFailures: resolveAutomationStopPolicy(input, currentFailureThreshold),
    consecutiveFailureCount: userReenabled ? 0 : current.consecutiveFailureCount,
    disabledReason: userDisabled ? "user" : userReenabled ? null : current.disabledReason,
    disabledAt: userDisabled ? now : userReenabled ? null : current.disabledAt,
    completionPolicy,
    completionPolicyVersion: completionPolicyChanged
      ? completionPolicyVersionForDefinition(current) + 1
      : completionPolicyVersionForDefinition(current),
    completionPolicyUpdatedAt: completionPolicyChanged
      ? now
      : completionPolicyUpdatedAtForDefinition(current),
    minimumIntervalSeconds: input.minimumIntervalSeconds ?? current.minimumIntervalSeconds,
    maxRuntimeSeconds: hasOwn(input, "maxRuntimeSeconds")
      ? ((input.maxRuntimeSeconds as AutomationDefinition["maxRuntimeSeconds"] | undefined) ?? null)
      : current.maxRuntimeSeconds,
    retryPolicy: input.retryPolicy ?? current.retryPolicy,
    misfirePolicy: input.misfirePolicy ?? current.misfirePolicy,
    acknowledgedRisks: input.acknowledgedRisks ?? current.acknowledgedRisks,
    iterationCount: userRestartedExhaustedLoop ? 0 : current.iterationCount,
    updatedAt: now,
  };

  return providerOptions ? { ...nextDefinition, providerOptions } : nextDefinition;
}

type ThreadEnvironment = {
  readonly envMode: ThreadEnvironmentMode;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly associatedWorktreePath: string | null;
  readonly associatedWorktreeBranch: string | null;
  readonly associatedWorktreeRef: string | null;
};

const localThreadEnvironment: ThreadEnvironment = {
  envMode: "local",
  branch: null,
  worktreePath: null,
  associatedWorktreePath: null,
  associatedWorktreeBranch: null,
  associatedWorktreeRef: null,
};

const SCHEDULER_LEASE_TTL_MS = 120_000;

export const AutomationServiceLive = Layer.effect(
  AutomationService,
  Effect.gen(function* () {
    const automationRepository = yield* AutomationRepository;
    const scheduleInstallSalt = yield* automationRepository
      .getOrCreateInstallSalt()
      .pipe(Effect.mapError(toServiceError("Failed to initialize automation schedule jitter.")));
    const jitterContextFor = (
      automationId: AutomationDefinition["id"],
    ): AutomationScheduleJitterContext => ({
      installSalt: scheduleInstallSalt,
      automationId,
    });
    const git = yield* GitCore;
    const textGeneration = yield* TextGeneration;
    const serverSettings = yield* ServerSettingsService;
    const providerDisabledReason = (definition: AutomationDefinition) =>
      serverSettings.getSettings.pipe(
        Effect.map((settings) =>
          settings.providers[definition.modelSelection.provider].enabled
            ? null
            : providerDisabledSettingsMessage(definition.modelSelection.provider),
        ),
        Effect.mapError(toServiceError("Failed to read provider settings.")),
      );
    const completionEvaluationProviderDisabledReason = (definition: AutomationDefinition) =>
      serverSettings.getSettings.pipe(
        Effect.map((settings) => {
          const directInput = resolveTextGenerationInputForSelection(
            definition.modelSelection,
            definition.providerOptions,
          );
          const provider =
            directInput?.modelSelection.provider ??
            (hasDedicatedTextGenerationProvider(settings.textGenerationModelSelection.provider)
              ? settings.textGenerationModelSelection.provider
              : "codex");
          return settings.providers[provider].enabled
            ? null
            : providerDisabledSettingsMessage(provider);
        }),
        Effect.mapError(toServiceError("Failed to read completion-evaluation provider settings.")),
      );
    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const projectionTurnRepository = yield* ProjectionTurnRepository;
    // Unbounded so we never silently drop run/definition updates under a burst, matching
    // the rest of the server's PubSub usage.
    const events = yield* PubSub.unbounded<AutomationStreamEvent>();
    // Stop-condition AI calls can be slow; cap queued+active jobs and let DB
    // reconciliation rediscover excess pending rows when worker capacity frees up.
    const completionEvaluationQueue = yield* Queue.bounded<AutomationCompletionEvaluationJob>(
      AUTOMATION_COMPLETION_EVALUATION_QUEUE_CAPACITY,
    );
    const queuedCompletionEvaluationRunIds = new Set<string>();

    const publish = (event: AutomationStreamEvent) =>
      PubSub.publish(events, event).pipe(Effect.asVoid);

    const publishProposalActivity = (
      definition: AutomationDefinition,
      proposalState: "pending" | "accepted" | "dismissed",
      createdAt: string,
    ) => {
      if (!definition.sourceThreadId) {
        return Effect.void;
      }
      return orchestrationEngine
        .dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe(`automation:${definition.id}:proposal:${randomUUID()}`),
          threadId: definition.sourceThreadId,
          activity: buildAutomationProposalActivity({
            definition,
            proposalState,
          }),
          createdAt,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("automation proposal activity could not be updated", {
              automationId: definition.id,
              proposalState,
              error: errorMessage(error),
            }),
          ),
          Effect.asVoid,
        );
    };

    const cleanupUnattachedWorktree = (input: {
      readonly definition: AutomationDefinition;
      readonly run: AutomationRun;
      readonly project: OrchestrationProjectShell;
      readonly environment: ThreadEnvironment;
      readonly reason: string;
    }) => {
      const path = input.environment.associatedWorktreePath;
      if (input.environment.envMode !== "worktree" || !path) {
        return Effect.void;
      }
      return git
        .removeWorktree({
          cwd: input.project.workspaceRoot,
          path,
          force: true,
          reclaimTemporaryBranch: true,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("automation unattached worktree cleanup failed", {
              automationId: input.definition.id,
              runId: input.run.id,
              path,
              reason: input.reason,
              error: errorMessage(error),
            }),
          ),
          Effect.asVoid,
        );
    };

    const requireDefinition = (id: AutomationId) =>
      automationRepository.getDefinitionById({ id }).pipe(
        Effect.mapError(toServiceError("Failed to load automation.")),
        Effect.flatMap((definitionOption) =>
          Option.match(definitionOption, {
            onNone: () =>
              Effect.fail(new AutomationServiceError({ message: "Automation was not found." })),
            onSome: (definition) =>
              definition.archivedAt
                ? Effect.fail(
                    new AutomationServiceError({ message: "Automation has been deleted." }),
                  )
                : Effect.succeed(definition),
          }),
        ),
      );

    const publishDefinition = (id: AutomationId) =>
      automationRepository.getDefinitionById({ id }).pipe(
        Effect.mapError(toServiceError("Failed to load automation.")),
        Effect.flatMap((definitionOption) =>
          Option.match(definitionOption, {
            onNone: () => Effect.void,
            onSome: (definition) => publish({ type: "definition-upserted", definition }),
          }),
        ),
      );

    const requireProject = (projectId: AutomationDefinition["projectId"]) =>
      projectionSnapshotQuery.getShellSnapshot().pipe(
        Effect.mapError(toServiceError("Failed to load project snapshot.")),
        Effect.flatMap((snapshot) => {
          const project = snapshot.projects.find((entry) => entry.id === projectId);
          return project
            ? Effect.succeed(project)
            : Effect.fail(
                new AutomationServiceError({ message: "Automation project was not found." }),
              );
        }),
      );

    const validateHeartbeatTarget = (input: {
      readonly mode: AutomationDefinition["mode"];
      readonly projectId: AutomationDefinition["projectId"];
      readonly targetThreadId: AutomationDefinition["targetThreadId"];
    }) => {
      // Only heartbeat validates a thread here. A dedicated automation's thread is created
      // by its own first run, so there is nothing to check until then.
      if (!automationRequiresTargetThread(input.mode)) {
        return Effect.void;
      }
      if (!input.targetThreadId) {
        return Effect.fail(
          new AutomationServiceError({ message: "Heartbeat automations require a target thread." }),
        );
      }
      return projectionSnapshotQuery.getThreadShellById(input.targetThreadId).pipe(
        Effect.mapError(toServiceError("Failed to load heartbeat target thread.")),
        Effect.flatMap((threadOption) =>
          Option.match(threadOption, {
            onNone: () =>
              Effect.fail(
                new AutomationServiceError({
                  message: "Heartbeat target thread was not found.",
                }),
              ),
            onSome: (thread) =>
              thread.projectId === input.projectId
                ? Effect.void
                : Effect.fail(
                    new AutomationServiceError({
                      message: "Heartbeat target thread must belong to the automation project.",
                    }),
                  ),
          }),
        ),
      );
    };

    const validateSchedulePolicy = (input: {
      readonly schedule: AutomationDefinition["schedule"];
      readonly enabled: boolean;
      readonly maxIterations: AutomationDefinition["maxIterations"];
      readonly minimumIntervalSeconds: number;
      readonly acknowledgedRisks: readonly string[];
      readonly now: string;
    }) =>
      Effect.try({
        try: () => {
          const spacingSeconds = computeAutomationScheduleSpacingSeconds(input.schedule, input.now);
          const fastIntervalError = fastIntervalPolicyError(input);
          if (fastIntervalError) {
            throw new Error(fastIntervalError);
          }
          const minimumIntervalSeconds = effectiveMinimumIntervalSeconds(input);
          if (spacingSeconds !== null && spacingSeconds < minimumIntervalSeconds) {
            throw new Error(
              `Automation schedule must run at least ${minimumIntervalSeconds} seconds apart.`,
            );
          }
          const nextRunAt = computeNextAutomationRunAt(input.schedule, input.now);
          if (input.enabled && input.schedule.type !== "manual" && nextRunAt === null) {
            throw new Error("Automation schedule must have a future run time.");
          }
        },
        catch: (cause) =>
          new AutomationServiceError({
            message: errorMessage(cause),
            cause,
          }),
      }).pipe(Effect.asVoid);

    const validateExecutionPolicies = (input: {
      readonly retryPolicy: AutomationDefinition["retryPolicy"];
    }) =>
      input.retryPolicy.type === "none"
        ? Effect.void
        : Effect.fail(
            new AutomationServiceError({
              message: "Automation retry policies are not supported yet.",
            }),
          );

    const validateRiskAcknowledgements = (input: {
      readonly runtimeMode: AutomationDefinition["runtimeMode"];
      readonly worktreeMode: AutomationDefinition["worktreeMode"];
      readonly acknowledgedRisks: readonly string[];
    }) => {
      const message = riskAcknowledgementError(input);
      return message
        ? Effect.fail(
            new AutomationServiceError({
              message,
            }),
          )
        : Effect.void;
    };

    const validateAutoRuntimeMode = (input: {
      readonly modelSelection: AutomationDefinition["modelSelection"];
      readonly runtimeMode: AutomationDefinition["runtimeMode"];
    }) => {
      const issue = autoRuntimeModeSelectionIssue(input);
      return issue === null
        ? Effect.void
        : Effect.fail(new AutomationServiceError({ message: issue }));
    };

    // Run-path backstop for the fast-interval policy. validateSchedulePolicy enforces this at
    // create/update; this guards the run path it never covers. Effect.try converts a throwing
    // schedule (invalid cron/timezone in a persisted row) into a typed error so the dispatch
    // failure path records the run as failed instead of dying on a defect.
    const validateFastIntervalPolicy = (input: {
      readonly schedule: AutomationDefinition["schedule"];
      readonly enabled: boolean;
      readonly maxIterations: AutomationDefinition["maxIterations"];
      readonly acknowledgedRisks: readonly string[];
      readonly now: string;
    }) =>
      Effect.try({
        try: () => fastIntervalPolicyError(input),
        catch: (cause) => new AutomationServiceError({ message: errorMessage(cause), cause }),
      }).pipe(
        Effect.flatMap((message) =>
          message ? Effect.fail(new AutomationServiceError({ message })) : Effect.void,
        ),
      );

    const resolveThreadEnvironment = (
      definition: AutomationDefinition,
      project: OrchestrationProjectShell,
      beforeWorktreeCreate: () => Effect.Effect<void, AutomationServiceError> = () => Effect.void,
    ): Effect.Effect<ThreadEnvironment, AutomationServiceError> => {
      const requireLocalCheckoutAcknowledgement = () =>
        definition.acknowledgedRisks.includes("local-checkout")
          ? Effect.void
          : Effect.fail(
              new AutomationServiceError({
                message: "Automation local checkout fallback requires an explicit acknowledgement.",
              }),
            );

      if (definition.worktreeMode === "local") {
        return requireLocalCheckoutAcknowledgement().pipe(Effect.as(localThreadEnvironment));
      }

      return git.statusDetails(project.workspaceRoot).pipe(
        Effect.mapError(toServiceError("Failed to inspect project Git status.")),
        Effect.flatMap((status) => {
          if (!status.isRepo) {
            return definition.worktreeMode === "worktree"
              ? Effect.fail(
                  new AutomationServiceError({
                    message:
                      "Automation requires a Git worktree, but the project is not a Git repository.",
                  }),
                )
              : requireLocalCheckoutAcknowledgement().pipe(Effect.as(localThreadEnvironment));
          }

          return beforeWorktreeCreate().pipe(
            Effect.flatMap(() =>
              git
                .createDetachedWorktree({
                  cwd: project.workspaceRoot,
                  ref: "HEAD",
                  path: null,
                  copyChangesFrom: project.workspaceRoot,
                  newBranch: buildTemporaryWorktreeBranchName(),
                })
                .pipe(
                  Effect.mapError(toServiceError("Failed to create automation worktree.")),
                  Effect.map(
                    (result): ThreadEnvironment => ({
                      envMode: "worktree",
                      branch: result.worktree.branch,
                      worktreePath: result.worktree.path,
                      associatedWorktreePath: result.worktree.path,
                      associatedWorktreeBranch: result.worktree.branch,
                      associatedWorktreeRef: result.worktree.ref,
                    }),
                  ),
                ),
            ),
          );
        }),
        Effect.catch((error) =>
          definition.worktreeMode === "auto"
            ? requireLocalCheckoutAcknowledgement().pipe(Effect.as(localThreadEnvironment))
            : Effect.fail(error),
        ),
      );
    };

    // Heartbeat runs reuse busy user threads, so reconcile only against the turn created
    // from this run's stored message id; the shell's latest turn may belong to someone else.
    const resolveRunTurn = (
      run: AutomationRun,
      shell: OrchestrationThreadShell,
    ): Effect.Effect<
      ProjectionTurn | OrchestrationThreadShell["latestTurn"] | null,
      AutomationServiceError
    > => {
      if (!runUsesExistingThread(run)) {
        return Effect.succeed(shell.latestTurn);
      }
      if (!run.threadId || !run.messageId) {
        return Effect.succeed(null);
      }
      if (run.turnId) {
        return projectionTurnRepository
          .getByTurnId({ threadId: run.threadId, turnId: run.turnId })
          .pipe(
            Effect.mapError(toServiceError("Failed to load automation turn.")),
            Effect.map((turnOption) =>
              Option.match(turnOption, {
                onNone: () => null,
                onSome: (turn) => turn,
              }),
            ),
          );
      }
      return projectionTurnRepository.listByThreadId({ threadId: run.threadId }).pipe(
        Effect.mapError(toServiceError("Failed to list automation turns.")),
        Effect.map(
          (turns) => turns.find((turn) => turn.pendingMessageId === run.messageId) ?? null,
        ),
      );
    };

    const runTurnOwnsPendingInput = (
      run: AutomationRun,
      shell: OrchestrationThreadShell,
      turn: ProjectionTurn | OrchestrationThreadShell["latestTurn"] | null,
    ) =>
      !runUsesExistingThread(run) ||
      (turn?.turnId !== null &&
        turn?.turnId !== undefined &&
        shell.latestTurn?.turnId === turn.turnId);

    // Dispatch a run: with no thread to continue it creates a fresh thread + turn, otherwise
    // it appends a turn to the thread the definition continues (the heartbeat target, or the
    // thread a dedicated automation owns). A failure marks the run failed before re-raising
    // so the scheduler/caller still observes the error.
    const dispatchRun = (
      definition: AutomationDefinition,
      run: AutomationRun,
      now: string,
    ): Effect.Effect<AutomationRunNowResult, AutomationServiceError> => {
      return Effect.gen(function* () {
        const plannedIds = deriveAutomationRunIds(run.id);
        // Read the thread from the definition rather than the run: a dedicated automation can
        // claim its thread after this run was planned, and continuing it beats creating a second.
        const continuationThreadId = automationContinuationThreadId(definition);
        if (automationRequiresTargetThread(definition.mode) && continuationThreadId === null) {
          return yield* Effect.fail(
            new AutomationServiceError({
              message: "Heartbeat automation has no target thread to continue.",
            }),
          );
        }
        const plannedThreadId = continuationThreadId ?? plannedIds.threadId;
        const messageId = run.messageId;
        const turnStartCommandId = run.turnStartCommandId;
        if (!plannedThreadId || !messageId || !turnStartCommandId) {
          return yield* Effect.fail(
            new AutomationServiceError({
              message: "Automation run is missing planned dispatch references.",
            }),
          );
        }

        // Enforce the gate at dispatch, not just create/update, so an enabled automation that
        // reached a run unacknowledged (e.g. inserted via the API/DB without consent) cannot run
        // on schedule or via Run now. Reuses the same validators as create/update so the backstop
        // stays consistent with them. Fails before the run is marked started; the catch at the end
        // of dispatchRun records it as a clean failed run, and the scheduler has already advanced
        // past this occurrence.
        yield* validateRiskAcknowledgements({
          runtimeMode: definition.runtimeMode,
          worktreeMode: definition.worktreeMode,
          acknowledgedRisks: definition.acknowledgedRisks,
        });
        yield* validateAutoRuntimeMode(definition);
        yield* validateFastIntervalPolicy({
          schedule: definition.schedule,
          enabled: definition.enabled,
          maxIterations: definition.maxIterations,
          acknowledgedRisks: definition.acknowledgedRisks,
          now,
        });

        const [memoryOption, lastRunOption] = yield* Effect.all([
          automationRepository
            .getMemory({ automationId: definition.id })
            .pipe(Effect.mapError(toServiceError("Failed to load automation memory."))),
          automationRepository
            .getLatestFinishedRunForDefinition({ automationId: definition.id })
            .pipe(Effect.mapError(toServiceError("Failed to load automation run history."))),
        ]);
        const dispatchMessage = buildAutomationRunEnvelope({
          definition,
          run,
          memoryContent: Option.isSome(memoryOption) ? memoryOption.value.content : "",
          lastRunAt: Option.isSome(lastRunOption)
            ? (lastRunOption.value.finishedAt ?? lastRunOption.value.startedAt)
            : null,
        });

        const stopIfRunCannotDispatch = (latest: AutomationRun, detail: string) =>
          latest.status === "running"
            ? Effect.succeed(latest)
            : publish({ type: "run-upserted", run: latest }).pipe(
                Effect.flatMap(() =>
                  Effect.fail(
                    new AutomationServiceError({
                      message: detail,
                    }),
                  ),
                ),
              );

        const markRunDispatchStarted = (
          threadId: ThreadId,
          threadCreateCommandId: CommandId | null,
        ) =>
          automationRepository
            .markRunStarted({
              id: run.id,
              threadId,
              messageId,
              threadCreateCommandId,
              turnStartCommandId,
              startedAt: now,
            })
            .pipe(
              Effect.mapError(toServiceError("Failed to update automation run.")),
              Effect.tap((started) => publish({ type: "run-upserted", run: started })),
              Effect.flatMap((started) =>
                stopIfRunCannotDispatch(
                  started,
                  "Automation run was cancelled before dispatch started.",
                ),
              ),
            );

        const requireRunStillDispatching = (detail: string) =>
          automationRepository.getRunById({ id: run.id }).pipe(
            Effect.mapError(toServiceError("Failed to load automation run.")),
            Effect.flatMap((runOption) =>
              Option.match(runOption, {
                onNone: () =>
                  Effect.fail(
                    new AutomationServiceError({
                      message: "Automation run no longer exists.",
                    }),
                  ),
                onSome: (latest) => stopIfRunCannotDispatch(latest, detail),
              }),
            ),
          );

        if (continuationThreadId !== null) {
          const started = yield* markRunDispatchStarted(continuationThreadId, null);
          yield* requireRunStillDispatching(
            "Automation run was cancelled before continuing the thread.",
          );

          yield* orchestrationEngine
            .dispatch({
              type: "thread.turn.start",
              commandId: turnStartCommandId,
              threadId: continuationThreadId,
              message: {
                messageId,
                role: "user",
                text: dispatchMessage,
                attachments: [],
              },
              modelSelection: definition.modelSelection,
              ...(definition.providerOptions
                ? { providerOptions: definition.providerOptions }
                : {}),
              dispatchMode: "queue",
              dispatchOrigin: "automation",
              runtimeMode: definition.runtimeMode,
              interactionMode: definition.interactionMode,
              createdAt: now,
            })
            .pipe(Effect.mapError(toServiceError("Failed to continue automation thread.")));

          return { run: started };
        }

        const project = yield* requireProject(definition.projectId);
        const threadCreateCommandId = run.threadCreateCommandId;
        if (!threadCreateCommandId) {
          return yield* Effect.fail(
            new AutomationServiceError({
              message: "Automation run is missing its planned thread command.",
            }),
          );
        }
        const started = yield* markRunDispatchStarted(plannedThreadId, threadCreateCommandId);
        const environment = yield* resolveThreadEnvironment(definition, project, () =>
          requireRunStillDispatching(
            "Automation run was cancelled before creating the automation worktree.",
          ).pipe(Effect.asVoid),
        );
        yield* requireRunStillDispatching(
          "Automation run was cancelled before creating the automation thread.",
        ).pipe(
          Effect.catch((error) =>
            cleanupUnattachedWorktree({
              definition,
              run,
              project,
              environment,
              reason: "cancelled-before-thread-create",
            }).pipe(Effect.flatMap(() => Effect.fail(error))),
          ),
        );

        if (environment.worktreePath) {
          yield* Effect.tryPromise({
            try: (signal) =>
              runWorktreeSetupScript(project.scripts, environment.worktreePath!, signal),
            catch: (cause) =>
              new AutomationServiceError({
                message: `Automation worktree setup failed: ${errorMessage(cause)}`,
                cause,
              }),
          }).pipe(
            Effect.catch((error) =>
              cleanupUnattachedWorktree({
                definition,
                run,
                project,
                environment,
                reason: "setup-failed",
              }).pipe(Effect.flatMap(() => Effect.fail(error))),
            ),
          );
        }

        yield* orchestrationEngine
          .dispatch({
            type: "thread.create",
            commandId: threadCreateCommandId,
            threadId: plannedThreadId,
            projectId: definition.projectId,
            // A dedicated thread outlives this run, so it is titled for the automation
            // rather than for the occurrence that happened to open it.
            title: automationOwnsItsThread(definition.mode)
              ? definition.name
              : `${definition.name} - ${now}`,
            // A per-run throwaway thread is marked so the sidebar can hide it; a
            // dedicated thread is a persistent conversation and stays unmarked.
            ...(automationOwnsItsThread(definition.mode)
              ? {}
              : { creationSource: "automation_run" as const }),
            modelSelection: definition.modelSelection,
            runtimeMode: definition.runtimeMode,
            interactionMode: definition.interactionMode,
            envMode: environment.envMode,
            branch: environment.branch,
            worktreePath: environment.worktreePath,
            associatedWorktreePath: environment.associatedWorktreePath,
            associatedWorktreeBranch: environment.associatedWorktreeBranch,
            associatedWorktreeRef: environment.associatedWorktreeRef,
            createdAt: now,
          })
          .pipe(
            Effect.mapError(toServiceError("Failed to create automation thread.")),
            Effect.catch((error) =>
              cleanupUnattachedWorktree({
                definition,
                run,
                project,
                environment,
                reason: "thread-create-failed",
              }).pipe(Effect.flatMap(() => Effect.fail(error))),
            ),
          );

        // Claim the thread before the turn starts, so a run dispatched while this one is
        // still working already sees the thread and continues it instead of opening another.
        if (automationOwnsItsThread(definition.mode)) {
          const attached = yield* automationRepository
            .attachDefinitionThread({
              id: definition.id,
              threadId: plannedThreadId,
              updatedAt: now,
            })
            .pipe(Effect.mapError(toServiceError("Failed to attach the automation thread.")));
          if (attached) {
            yield* publishDefinition(definition.id);
          }
        }

        yield* requireRunStillDispatching(
          "Automation run was cancelled before starting the automation turn.",
        );
        yield* orchestrationEngine
          .dispatch({
            type: "thread.turn.start",
            commandId: turnStartCommandId,
            threadId: plannedThreadId,
            message: {
              messageId,
              role: "user",
              text: dispatchMessage,
              attachments: [],
            },
            modelSelection: definition.modelSelection,
            ...(definition.providerOptions ? { providerOptions: definition.providerOptions } : {}),
            dispatchMode: "queue",
            dispatchOrigin: "automation",
            runtimeMode: definition.runtimeMode,
            interactionMode: definition.interactionMode,
            createdAt: now,
          })
          .pipe(Effect.mapError(toServiceError("Failed to start automation turn.")));

        return { run: started };
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const failedAt = isoNow();
            const summary = errorMessage(error);
            const failedResult = yield* automationRepository
              .markRunFailed({
                id: run.id,
                error: summary,
                finishedAt: failedAt,
              })
              .pipe(Effect.mapError(toServiceError("Failed to update automation run.")));
            if (!failedResult.transitioned) {
              yield* publish({ type: "run-upserted", run: failedResult.run });
              return yield* Effect.fail(error);
            }
            const updated = yield* publishRunResult(failedResult.run, "failed", failedAt, summary);
            yield* finishFailedRunAccounting({ ...failedResult, run: updated }, failedAt);
            return yield* Effect.fail(error);
          }).pipe(Effect.catch(() => Effect.fail(error))),
        ),
      );
    };

    const normalizeCreatedDefinitionSchedule = (definition: AutomationDefinition, now: string) => {
      const nextRunAt = computeNextAutomationRunAt(
        definition.schedule,
        now,
        jitterContextFor(definition.id),
      );
      if (definition.nextRunAt === nextRunAt) {
        return Effect.succeed(definition);
      }
      const normalized = { ...definition, nextRunAt, updatedAt: now };
      return automationRepository
        .setDefinitionNextRunAt({ id: definition.id, nextRunAt, updatedAt: now })
        .pipe(Effect.as(normalized));
    };

    // Create + persist a pending run and return whether it was a fresh insert. Scheduled
    // occurrences dedupe via INSERT OR IGNORE on (automationId, scheduledFor), so createRun
    // may return a pre-existing row (inserted === false); callers count + dispatch only
    // fresh runs, and the schedule is only advanced once the run has durably succeeded.
    const pendingRunInput = (
      definition: AutomationDefinition,
      trigger: AutomationRun["trigger"],
      scheduledFor: string,
      now: string,
      options: {
        readonly threadIdOverride?: ThreadId | null;
        readonly deferredUntil?: string | null;
      } = {},
      settingsRevision?: number,
      providerOptions?: ProviderStartOptions,
    ) => {
      const runId = makeAutomationRunId();
      const ids = deriveAutomationRunIds(runId);
      // A dedicated automation continues its own thread from the second run on; before that
      // it plans a thread creation exactly like a standalone run.
      const continuationThreadId = automationContinuationThreadId(definition);
      return {
        id: runId,
        automationId: definition.id,
        projectId: definition.projectId,
        threadId:
          "threadIdOverride" in options
            ? options.threadIdOverride
            : continuationThreadId === null
              ? ids.threadId
              : options.deferredUntil != null
                ? null
                : continuationThreadId,
        messageId: ids.messageId,
        threadCreateCommandId: continuationThreadId === null ? ids.threadCreateCommandId : null,
        turnStartCommandId: ids.turnStartCommandId,
        trigger,
        scheduledFor,
        deferredUntil: options.deferredUntil ?? null,
        permissionSnapshot: makePermissionSnapshot(
          definition,
          now,
          settingsRevision,
          providerOptions,
        ),
        now,
      };
    };

    const createPendingRun = (
      definition: AutomationDefinition,
      trigger: AutomationRun["trigger"],
      scheduledFor: string,
      now: string,
      options: { readonly threadIdOverride?: ThreadId | null } = {},
    ) =>
      Effect.gen(function* () {
        const settings = yield* serverSettings.getSnapshot;
        const input = pendingRunInput(
          definition,
          trigger,
          scheduledFor,
          now,
          options,
          settings.revision,
          providerStartOptionsFromServerSettings(settings.settings),
        );
        const run = yield* automationRepository
          .createRun(input)
          .pipe(Effect.mapError(toServiceError("Failed to create automation run.")));
        yield* publish({ type: "run-upserted", run });
        return { run, inserted: run.id === input.id };
      });

    const claimPendingRun = (
      definition: AutomationDefinition,
      trigger: AutomationRun["trigger"],
      scheduledFor: string,
      now: string,
      scheduleAdvance?: {
        readonly nextRunAt: string | null;
        readonly disable: boolean;
        readonly consumeIteration?: boolean;
      },
      deferredUntil?: string | null,
      threadIdOverride?: ThreadId | null,
    ) =>
      Effect.gen(function* () {
        const settings = yield* serverSettings.getSnapshot;
        return yield* automationRepository.createRunAndIncrementDefinition(
          pendingRunInput(
            definition,
            trigger,
            scheduledFor,
            now,
            {
              ...(deferredUntil !== undefined ? { deferredUntil } : {}),
              ...(threadIdOverride !== undefined ? { threadIdOverride } : {}),
            },
            settings.revision,
            providerStartOptionsFromServerSettings(settings.settings),
          ),
          scheduleAdvance
            ? {
                ...scheduleAdvance,
                expectedDefinitionUpdatedAt: definition.updatedAt,
              }
            : undefined,
        );
      }).pipe(
        Effect.mapError(toServiceError("Failed to claim automation run.")),
        Effect.tap((run) =>
          Option.match(run, {
            onNone: () => Effect.void,
            onSome: (claimed) => publish({ type: "run-upserted", run: claimed }),
          }),
        ),
      );

    // Recovery may find a durable run + thread without the queued turn row; retire it so
    // future heartbeat ticks and scheduled occurrences are not blocked forever.
    const interruptRunForRecovery = (run: AutomationRun, now: string) =>
      automationRepository.markRunInterrupted({ id: run.id, turnId: null, finishedAt: now }).pipe(
        Effect.flatMap((interrupted) =>
          interrupted.status !== "interrupted"
            ? Effect.succeed(interrupted)
            : automationRepository
                .markRunResult({
                  id: interrupted.id,
                  result: resultForRunStatus("interrupted", {
                    summary: "Automation run was interrupted during recovery.",
                    now,
                  }),
                  updatedAt: now,
                })
                .pipe(Effect.orElseSucceed(() => interrupted)),
        ),
        Effect.tap((updated) => publish({ type: "run-upserted", run: updated })),
      );

    // Stop checks must only evaluate evidence from the just-finished heartbeat turn.
    const findRunCompletionMessages = (input: {
      readonly run: AutomationRun;
      readonly thread: {
        readonly messages: ReadonlyArray<{
          readonly id: string;
          readonly role: string;
          readonly text: string;
          readonly turnId: string | null;
        }>;
      };
    }) => {
      const runMessages = input.thread.messages.filter(
        (message) =>
          message.id === input.run.messageId ||
          (input.run.turnId !== null && message.turnId === input.run.turnId),
      );
      const userMessage =
        input.thread.messages.find((message) => message.id === input.run.messageId)?.text ?? "";
      const assistantMessages = runMessages.filter((message) => message.role === "assistant");
      const runThreadContext = runMessages
        .slice(-8)
        .map((message) => `${message.role}: ${message.text}`)
        .join("\n\n");
      return {
        runUserMessage: userMessage,
        runAssistantText:
          assistantMessages.length > 0
            ? assistantMessages.map((message) => message.text).join("\n\n")
            : "",
        runThreadContext,
      };
    };

    const staleStopCheckEvaluation = (rawEvaluation: AutomationCompletionEvaluation) => ({
      ...rawEvaluation,
      stopMatched: false,
      reason: normalizeAutomationCompletionReason(
        "Stop check ignored because the automation changed before evaluation finished.",
      ),
    });

    const disableDefinitionForCompletionMatch = (definition: AutomationDefinition) =>
      automationRepository
        .disableDefinitionIfUnchanged({
          id: definition.id,
          expectedUpdatedAt: definition.updatedAt,
          now: isoNow(),
          reason: "completion",
        })
        .pipe(Effect.mapError(toServiceError("Failed to disable automation.")));

    // The AI check runs after the run is published; reload so read/archive changes win the race.
    const latestRunForCompletionResult = (run: AutomationRun) =>
      automationRepository.getRunById({ id: run.id }).pipe(
        Effect.mapError(toServiceError("Failed to load automation run.")),
        Effect.map((runOption) =>
          Option.match(runOption, {
            onNone: () => run,
            onSome: (latestRun) => latestRun,
          }),
        ),
      );

    const recordCompletionEvaluation = (input: {
      readonly run: AutomationRun;
      readonly evaluation: AutomationCompletionEvaluation;
      readonly matched: boolean;
      readonly summary?: string;
      readonly severity?: NonNullable<AutomationRunResult["severity"]>;
    }) =>
      Effect.gen(function* () {
        const latestRun = yield* latestRunForCompletionResult(input.run);
        const updatedAt = isoNow();
        const updated = yield* automationRepository
          .markRunResultPreservingTriage({
            id: latestRun.id,
            result: automationCompletionRunResult({
              baseResult: latestRun.result,
              evaluation: input.evaluation,
              matched: input.matched,
              ...(input.summary !== undefined ? { summary: input.summary } : {}),
              ...(input.severity ? { severity: input.severity } : {}),
            }),
            updatedAt,
          })
          .pipe(Effect.mapError(toServiceError("Failed to update automation run result.")));
        yield* publish({ type: "run-upserted", run: updated });
        return updated;
      });

    const resolveAutomationCompletionTextGenerationInput = (definition: AutomationDefinition) =>
      Effect.gen(function* () {
        const directInput = resolveTextGenerationInputForSelection(
          definition.modelSelection,
          definition.providerOptions,
        );
        if (directInput) {
          return directInput;
        }

        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError(toServiceError("Failed to load text-generation settings.")),
        );
        return (
          resolveTextGenerationInputForSelection(
            settings.textGenerationModelSelection,
            definition.providerOptions,
          ) ?? {}
        );
      });

    const shouldUseStopPolicyForDefinition = (
      definition: AutomationDefinition,
      policy: Extract<AutomationCompletionPolicy, { type: "ai-evaluated" }>,
    ): boolean => {
      const currentPolicy = completionPolicyForDefinition(definition);
      // Mode-independent: a stop clause decides when the automation retires, which is
      // orthogonal to whether its runs continue a target thread or open a fresh one.
      return (
        definition.enabled &&
        definition.archivedAt === null &&
        currentPolicy.type === "ai-evaluated" &&
        isSameAiCompletionPolicy(currentPolicy, policy)
      );
    };

    const loadCurrentStopDefinition = (
      definition: AutomationDefinition,
      policy: Extract<AutomationCompletionPolicy, { type: "ai-evaluated" }>,
    ) =>
      automationRepository.getDefinitionById({ id: definition.id }).pipe(
        Effect.mapError(toServiceError("Failed to load automation.")),
        Effect.map((definitionOption) =>
          Option.match(definitionOption, {
            onNone: () => Option.none<AutomationDefinition>(),
            onSome: (currentDefinition) =>
              currentDefinition.updatedAt === definition.updatedAt &&
              shouldUseStopPolicyForDefinition(currentDefinition, policy)
                ? Option.some(currentDefinition)
                : Option.none<AutomationDefinition>(),
          }),
        ),
      );

    const evaluateCompletionPolicy = (
      definition: AutomationDefinition,
      run: AutomationRun,
      policy: Extract<AutomationCompletionPolicy, { type: "ai-evaluated" }>,
    ) =>
      Effect.gen(function* () {
        if (yield* completionEvaluationProviderDisabledReason(definition)) {
          return false;
        }
        if (!run.threadId) {
          yield* recordCompletionEvaluation({
            run,
            evaluation: failedAutomationCompletionEvaluation(
              "Stop check skipped because the automation run has no target thread.",
            ),
            matched: false,
            summary: "Stop check skipped because the automation run has no target thread.",
            severity: "warning",
          });
          return false;
        }
        const project = yield* requireProject(definition.projectId);
        const threadOption = yield* projectionSnapshotQuery
          .getThreadDetailById(run.threadId)
          .pipe(Effect.mapError(toServiceError("Failed to load automation thread detail.")));
        if (Option.isNone(threadOption)) {
          yield* recordCompletionEvaluation({
            run,
            evaluation: failedAutomationCompletionEvaluation(
              "Stop check skipped because the target thread could not be found.",
            ),
            matched: false,
            summary: "Stop check skipped because the target thread could not be found.",
            severity: "warning",
          });
          return false;
        }
        const thread = threadOption.value;
        const { runUserMessage, runAssistantText, runThreadContext } = findRunCompletionMessages({
          run,
          thread,
        });
        const textGenerationInput =
          yield* resolveAutomationCompletionTextGenerationInput(definition);
        const evaluationOption = yield* textGeneration
          .evaluateAutomationCompletion({
            cwd: project.workspaceRoot,
            automationName: definition.name,
            automationPrompt: definition.prompt,
            stopWhen: policy.stopWhen,
            runUserMessage: runUserMessage || definition.prompt,
            runAssistantText: runAssistantText || "(no assistant output)",
            threadContext: runThreadContext || "(no run-scoped thread context)",
            ...textGenerationInput,
          })
          .pipe(
            Effect.mapError(toServiceError("Failed to evaluate automation stop condition.")),
            Effect.timeoutOption(AUTOMATION_COMPLETION_EVALUATION_TIMEOUT_MS),
          );
        if (Option.isNone(evaluationOption)) {
          // Timed out. Reload the definition first: if the automation was edited, disabled,
          // archived, or its policy changed while the provider call hung, record the same
          // stale-check result the success path uses rather than surfacing a misleading live
          // "Stop check timed out." warning for a policy the user already changed. Either way
          // keep the heartbeat alive without retrying (a retry would risk another stuck worker).
          const reason = normalizeAutomationCompletionReason("Stop check timed out.");
          const timedOut = failedAutomationCompletionEvaluation(reason);
          const stillCurrent = Option.isSome(yield* loadCurrentStopDefinition(definition, policy));
          if (stillCurrent) {
            yield* recordCompletionEvaluation({
              run,
              evaluation: timedOut,
              matched: false,
              summary: reason,
              severity: "warning",
            });
          } else {
            yield* recordCompletionEvaluation({
              run,
              evaluation: staleStopCheckEvaluation(timedOut),
              matched: false,
            });
          }
          return false;
        }
        const evaluationRaw = evaluationOption.value;
        const rawEvaluation = {
          stopMatched: evaluationRaw.stopMatched,
          confidence: Math.max(0, Math.min(1, evaluationRaw.confidence)),
          reason: normalizeAutomationCompletionReason(evaluationRaw.reason),
        };
        const currentDefinitionOption = yield* loadCurrentStopDefinition(definition, policy);
        const policyStillCurrent = Option.isSome(currentDefinitionOption);
        const evaluation: AutomationCompletionEvaluation = policyStillCurrent
          ? rawEvaluation
          : staleStopCheckEvaluation(rawEvaluation);
        const matched =
          policyStillCurrent &&
          evaluation.stopMatched &&
          evaluation.confidence >= policy.confidenceThreshold;
        if (!matched) {
          yield* recordCompletionEvaluation({
            run,
            evaluation,
            matched: false,
          });
          return false;
        }
        const currentDefinition = Option.getOrThrow(currentDefinitionOption);
        // Disable before clearing the pending stop-check marker, so no extra heartbeat can launch.
        const disabled = yield* disableDefinitionForCompletionMatch(currentDefinition);
        if (!disabled) {
          yield* recordCompletionEvaluation({
            run,
            evaluation: staleStopCheckEvaluation(rawEvaluation),
            matched: false,
          });
          return false;
        }
        yield* publishDefinition(currentDefinition.id);
        yield* recordCompletionEvaluation({
          run,
          evaluation,
          matched: true,
        });
        return true;
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const disabledReason = yield* completionEvaluationProviderDisabledReason(
              definition,
            ).pipe(
              Effect.catch((settingsError) =>
                Effect.logWarning(
                  "automation completion evaluation provider state could not be rechecked",
                  {
                    automationId: definition.id,
                    runId: run.id,
                    error: errorMessage(settingsError),
                  },
                ).pipe(Effect.as(null)),
              ),
            );
            if (disabledReason) {
              return false;
            }
            const reason = completionFailureReason(error);
            yield* Effect.logWarning("automation completion evaluation failed", {
              automationId: definition.id,
              runId: run.id,
              error: errorMessage(error),
            });
            // Keep the heartbeat active, but make the failed stop check visible in run history.
            yield* recordCompletionEvaluation({
              run,
              evaluation: failedAutomationCompletionEvaluation(reason),
              matched: false,
              summary: reason,
              severity: "warning",
            }).pipe(
              Effect.catch((recordError) =>
                Effect.logWarning(
                  "automation completion evaluation failure could not be recorded",
                  {
                    automationId: definition.id,
                    runId: run.id,
                    error: errorMessage(recordError),
                  },
                ),
              ),
            );
            return false;
          }),
        ),
      );

    const enqueueCompletionEvaluationJob = (job: AutomationCompletionEvaluationJob) =>
      Effect.sync(() => {
        if (queuedCompletionEvaluationRunIds.has(job.run.id)) {
          return "duplicate" as const;
        }
        if (
          queuedCompletionEvaluationRunIds.size >= AUTOMATION_COMPLETION_EVALUATION_QUEUE_CAPACITY
        ) {
          return "full" as const;
        }
        queuedCompletionEvaluationRunIds.add(job.run.id);
        return "queued" as const;
      }).pipe(
        Effect.flatMap((state) => {
          switch (state) {
            case "duplicate":
              return Effect.void;
            case "full":
              return Effect.logWarning("automation completion evaluation queue at capacity", {
                automationId: job.definition.id,
                runId: job.run.id,
                capacity: AUTOMATION_COMPLETION_EVALUATION_QUEUE_CAPACITY,
              });
            case "queued":
              return Queue.offer(completionEvaluationQueue, job).pipe(Effect.asVoid);
          }
        }),
      );

    const enqueueCompletionEvaluationForRun = (run: AutomationRun) => {
      if (run.status !== "succeeded" || run.result?.completionEvaluation !== undefined) {
        return Effect.void;
      }

      return automationRepository.getDefinitionById({ id: run.automationId }).pipe(
        Effect.mapError(toServiceError("Failed to load automation.")),
        Effect.flatMap((definitionOption) =>
          Option.match(definitionOption, {
            onNone: () => Effect.void,
            onSome: (definition) => {
              const policy = completionPolicyForDefinition(definition);
              if (policy.type !== "ai-evaluated") {
                return Effect.void;
              }
              if (!shouldUseStopPolicyForDefinition(definition, policy)) {
                return Effect.void;
              }
              if (!runUsesCurrentCompletionPolicy(run, definition)) {
                return Effect.void;
              }
              return completionEvaluationProviderDisabledReason(definition).pipe(
                Effect.flatMap((disabledReason) =>
                  disabledReason
                    ? Effect.void
                    : enqueueCompletionEvaluationJob({
                        definition,
                        run,
                        policy,
                      }),
                ),
              );
            },
          }),
        ),
      );
    };

    const enqueuePendingCompletionEvaluations = () =>
      automationRepository.listRunsNeedingCompletionEvaluation({ limit: 100 }).pipe(
        Effect.mapError(toServiceError("Failed to list pending stop evaluations.")),
        Effect.flatMap((runs) =>
          Effect.forEach(runs, enqueueCompletionEvaluationForRun, { concurrency: 1 }),
        ),
        Effect.asVoid,
      );

    const processCompletionEvaluationJob = (job: AutomationCompletionEvaluationJob) =>
      evaluateCompletionPolicy(job.definition, job.run, job.policy).pipe(
        Effect.asVoid,
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.failCause(cause);
          }
          return Effect.logWarning("automation completion evaluation worker failed", {
            automationId: job.definition.id,
            runId: job.run.id,
            cause: Cause.pretty(cause),
          });
        }),
        Effect.ensuring(Effect.sync(() => queuedCompletionEvaluationRunIds.delete(job.run.id))),
      );

    const completionEvaluationWorker = Effect.forever(
      Queue.take(completionEvaluationQueue).pipe(
        Effect.flatMap(processCompletionEvaluationJob),
        Effect.flatMap(() =>
          enqueuePendingCompletionEvaluations().pipe(
            Effect.catch((error) =>
              Effect.logWarning("automation pending stop evaluations could not be requeued", {
                error: errorMessage(error),
              }),
            ),
          ),
        ),
      ),
    );

    yield* Effect.forEach(
      Array.from({ length: AUTOMATION_COMPLETION_EVALUATION_WORKERS }),
      () => Effect.forkScoped(completionEvaluationWorker),
      { discard: true },
    );

    yield* enqueuePendingCompletionEvaluations().pipe(
      Effect.catch((error) =>
        Effect.logWarning("automation pending stop evaluations could not be queued", {
          error: errorMessage(error),
        }),
      ),
    );

    yield* serverSettings.streamChanges.pipe(
      Stream.runForEach(() =>
        enqueuePendingCompletionEvaluations().pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              "automation pending stop evaluations could not be reconciled after settings changed",
              { error: errorMessage(error) },
            ),
          ),
        ),
      ),
      Effect.forkScoped,
    );

    const appendFailureAutoDisableResult = (
      run: AutomationRun,
      consecutiveFailureCount: number,
      now: string,
    ) => {
      const notice = `Automation was stopped after ${consecutiveFailureCount} consecutive failed runs.`;
      const baseResult =
        run.result ??
        resultForRunStatus("failed", {
          summary: run.error,
          now,
        });
      if (!baseResult) {
        return Effect.void;
      }
      return automationRepository
        .markRunResultPreservingTriage({
          id: run.id,
          result: {
            ...baseResult,
            summary: automationRunResultSummaryWithNotice(baseResult.summary, notice),
          },
          updatedAt: now,
        })
        .pipe(
          Effect.mapError(toServiceError("Failed to update automation run result.")),
          Effect.tap((updated) => publish({ type: "run-upserted", run: updated })),
          Effect.tap(() =>
            Effect.logWarning("automation disabled after consecutive failed runs", {
              automationId: run.automationId,
              runId: run.id,
              consecutiveFailureCount,
            }),
          ),
          Effect.asVoid,
        );
    };

    const disableDefinitionAtMaxIterations = (definition: AutomationDefinition, now: string) =>
      automationRepository
        .disableDefinition({ id: definition.id, now, reason: "max-iterations" })
        .pipe(
          Effect.mapError(toServiceError("Failed to disable automation.")),
          Effect.andThen(publishDefinition(definition.id)),
        );

    const stopFailedRunAtMaxIterations = (run: AutomationRun, now: string) =>
      automationRepository.getDefinitionById({ id: run.automationId }).pipe(
        Effect.mapError(toServiceError("Failed to load automation.")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (definition) =>
              definition.enabled &&
              !definition.archivedAt &&
              definitionReachedMaxIterations(definition)
                ? disableDefinitionAtMaxIterations(definition, now)
                : Effect.void,
          }),
        ),
      );

    const finishFailedRunAccounting = (result: MarkAutomationRunFailedResult, now: string) =>
      Option.match(result.failureAccounting, {
        onNone: () => Effect.void,
        onSome: ({ autoDisabled, consecutiveFailureCount }) =>
          autoDisabled
            ? publishDefinition(result.run.automationId).pipe(
                Effect.andThen(
                  appendFailureAutoDisableResult(result.run, consecutiveFailureCount, now),
                ),
              )
            : stopFailedRunAtMaxIterations(result.run, now),
      });

    const processSuccessfulRun = (
      run: AutomationRun,
      definition: AutomationDefinition,
      now: string,
      failureCountReset: boolean,
    ) =>
      Effect.gen(function* () {
        if (failureCountReset) {
          yield* publish({ type: "definition-upserted", definition });
        }
        if (!definition.enabled || definition.archivedAt) {
          return;
        }
        if (definitionReachedMaxIterations(definition)) {
          yield* disableDefinitionAtMaxIterations(definition, now);
          return;
        }
        const completionPolicy = completionPolicyForDefinition(definition);
        if (
          completionPolicy.type === "ai-evaluated" &&
          runUsesCurrentCompletionPolicy(run, definition)
        ) {
          yield* enqueueCompletionEvaluationJob({
            definition,
            run,
            policy: completionPolicy,
          });
        }
      });

    const processSuccessfulRunAfterTransition = (
      run: AutomationRun,
      now: string,
      failureCountReset: boolean,
    ) =>
      automationRepository.getDefinitionById({ id: run.automationId }).pipe(
        Effect.mapError(toServiceError("Failed to load automation.")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (definition) =>
              definition.archivedAt
                ? Effect.void
                : processSuccessfulRun(run, definition, now, failureCountReset),
          }),
        ),
      );

    const publishRunResult = (
      run: AutomationRun,
      status: AutomationRunStatus,
      now: string,
      summary?: string | null,
      interruptBeforePublish = false,
    ) =>
      automationRepository
        .markRunResult({
          id: run.id,
          result: resultForRunStatus(status, {
            ...(summary !== undefined ? { summary } : {}),
            now,
          }),
          updatedAt: now,
        })
        .pipe(
          Effect.mapError(toServiceError("Failed to update automation run result.")),
          Effect.tap((updated) =>
            interruptBeforePublish ? interruptRunBestEffort(updated, now) : Effect.void,
          ),
          Effect.tap((updated) => publish({ type: "run-upserted", run: updated })),
        );

    const loadRunAssistantText = (
      run: AutomationRun,
      turnId: TurnId,
    ): Effect.Effect<string | null, never> => {
      if (!run.threadId) {
        return Effect.succeed(null);
      }
      return projectionSnapshotQuery.getThreadDetailById(run.threadId).pipe(
        Effect.map((threadOption) =>
          Option.match(threadOption, {
            onNone: () => null,
            onSome: (thread) =>
              findRunCompletionMessages({
                run: { ...run, turnId },
                thread,
              }).runAssistantText,
          }),
        ),
        Effect.catch(() => Effect.succeed(null)),
      );
    };

    const successfulRunResult = (
      definition: AutomationDefinition,
      run: AutomationRun,
      assistantText: string | null,
    ): AutomationRunResult => {
      const reportedDecision = run.result?.decision;
      // A run that continues a thread is one iteration of a loop the user can already read,
      // so it stays silent unless it actually said something. A fresh thread per run is the
      // result itself and always deserves attention.
      const decision =
        reportedDecision ??
        (automationContinuesThread(definition.mode)
          ? assistantText !== null && assistantText.trim().length > 0
            ? "notify"
            : "silent"
          : "notify");
      const policy = definition.notificationPolicy ?? "all";
      const unread = decision === "notify" && policy !== "failed-runs-only";
      return {
        ...(run.result ?? {}),
        outcome: run.result?.outcome ?? "unknown",
        summary:
          run.result?.summary ??
          (assistantText === null ? null : automationRunResultSummary(assistantText)),
        decision,
        unread,
        archivedAt: run.result?.archivedAt ?? null,
      };
    };

    const reconcileThread: AutomationServiceShape["reconcileThread"] = ({ threadId }) =>
      Effect.gen(function* () {
        const runOption = yield* automationRepository
          .getRunByThreadId({ threadId })
          .pipe(Effect.mapError(toServiceError("Failed to load automation run for thread.")));
        if (Option.isNone(runOption)) {
          return;
        }
        const run = runOption.value;
        if (isTerminalRunStatus(run.status)) {
          return;
        }

        const shellOption = yield* projectionSnapshotQuery
          .getThreadShellById(threadId)
          .pipe(Effect.mapError(toServiceError("Failed to load automation thread state.")));
        if (Option.isNone(shellOption)) {
          return;
        }
        const shell = shellOption.value;
        const turn = yield* resolveRunTurn(run, shell);
        const now = isoNow();

        if (
          (shell.hasPendingApprovals === true || shell.hasPendingUserInput === true) &&
          runTurnOwnsPendingInput(run, shell, turn)
        ) {
          if (run.status !== "waiting-for-approval") {
            const updated = yield* automationRepository
              .markRunWaitingForApproval({
                id: run.id,
                turnId: turn?.turnId ?? null,
                updatedAt: now,
              })
              .pipe(Effect.mapError(toServiceError("Failed to update automation run.")));
            yield* publishRunResult(
              updated,
              "waiting-for-approval",
              now,
              "Automation run is waiting for input or approval.",
            );
          }
          return;
        }

        if (!turn || turn.turnId === null || turn.state === "pending" || turn.state === "running") {
          // A heartbeat run's turn can be abandoned mid-flight when the user sends a
          // manual turn on the same thread: the provider session moves on, the run's
          // turn row stays pending/running forever, and no reconcile event ever flips
          // the run terminal. Detect the supersession (a strictly newer turn owns the
          // thread) and close the run out as interrupted instead of looping here.
          if (
            runUsesExistingThread(run) &&
            turn !== null &&
            turn.turnId !== null &&
            shell.latestTurn !== null &&
            shell.latestTurn.turnId !== turn.turnId &&
            isBeforeIso(turn.requestedAt, shell.latestTurn.requestedAt)
          ) {
            const interrupted = yield* automationRepository
              .markRunInterrupted({
                id: run.id,
                turnId: turn.turnId,
                finishedAt: now,
              })
              .pipe(Effect.mapError(toServiceError("Failed to update automation run.")));
            yield* publishRunResult(
              interrupted,
              "interrupted",
              now,
              "Automation run was superseded by a newer turn on the target thread.",
            );
            return;
          }
          if (
            run.status === "waiting-for-approval" &&
            run.threadId &&
            run.messageId &&
            run.turnStartCommandId &&
            // Only resume *our* run: if a later, foreign turn now owns the thread's
            // pending input, flipping back to running would resurrect a run that no
            // longer owns the turn (mirrors the entry guard above).
            runTurnOwnsPendingInput(run, shell, turn)
          ) {
            const running = yield* automationRepository
              .markRunStarted({
                id: run.id,
                threadId: run.threadId,
                messageId: run.messageId,
                threadCreateCommandId: run.threadCreateCommandId,
                turnStartCommandId: run.turnStartCommandId,
                startedAt: run.startedAt ?? now,
              })
              .pipe(Effect.mapError(toServiceError("Failed to update automation run.")));
            const cleared = yield* automationRepository
              .markRunResult({
                id: running.id,
                result: null,
                updatedAt: now,
              })
              .pipe(Effect.mapError(toServiceError("Failed to update automation run result.")));
            yield* publish({ type: "run-upserted", run: cleared });
          }
          return;
        }

        if (turn.state === "completed") {
          const definition = yield* requireDefinition(run.automationId);
          const assistantText = yield* loadRunAssistantText(run, turn.turnId);
          const succeededResult = yield* automationRepository
            .markRunSucceeded({
              id: run.id,
              turnId: turn.turnId,
              result: successfulRunResult(definition, run, assistantText),
              finishedAt: turn.completedAt ?? now,
              accountedAt: now,
            })
            .pipe(Effect.mapError(toServiceError("Failed to update automation run.")));
          const updated = succeededResult.run;
          yield* publish({ type: "run-upserted", run: updated });
          if (!succeededResult.transitioned) {
            return;
          }
          yield* processSuccessfulRunAfterTransition(
            updated,
            now,
            succeededResult.failureCountReset,
          );
          return;
        } else if (turn.state === "error") {
          const summary = errorMessage(shell.session?.lastError ?? "Automation turn failed.");
          const failedResult = yield* automationRepository
            .markRunFailed({
              id: run.id,
              error: summary,
              finishedAt: now,
            })
            .pipe(Effect.mapError(toServiceError("Failed to update automation run.")));
          if (!failedResult.transitioned) {
            yield* publish({ type: "run-upserted", run: failedResult.run });
            return;
          }
          const failed = yield* publishRunResult(failedResult.run, "failed", now, summary);
          yield* finishFailedRunAccounting({ ...failedResult, run: failed }, now);
          return;
        } else {
          const interrupted = yield* automationRepository
            .markRunInterrupted({
              id: run.id,
              turnId: turn.turnId,
              finishedAt: now,
            })
            .pipe(Effect.mapError(toServiceError("Failed to update automation run.")));
          yield* publishRunResult(
            interrupted,
            "interrupted",
            now,
            "Automation run was interrupted.",
          );
          return;
        }
      });

    const failRunForTimeout = (definition: AutomationDefinition, run: AutomationRun, now: string) =>
      Effect.gen(function* () {
        const summary = `Automation run exceeded its ${definition.maxRuntimeSeconds}-second runtime limit.`;
        yield* interruptRunBestEffort(run, now);
        const failedResult = yield* automationRepository
          .markRunFailed({ id: run.id, error: summary, finishedAt: now })
          .pipe(Effect.mapError(toServiceError("Failed to time out automation run.")));
        if (!failedResult.transitioned) {
          yield* publish({ type: "run-upserted", run: failedResult.run });
          return;
        }
        const failed = yield* publishRunResult(failedResult.run, "failed", now, summary);
        yield* finishFailedRunAccounting({ ...failedResult, run: failed }, now);
      });

    const reconcileActiveRun = (run: AutomationRun, now: string) =>
      automationRepository.getDefinitionById({ id: run.automationId }).pipe(
        Effect.mapError(toServiceError("Failed to load automation.")),
        Effect.flatMap((definitionOption) =>
          Option.match(definitionOption, {
            onNone: () => Effect.void,
            onSome: (definition) =>
              hasExceededMaxRuntime(definition, run, now)
                ? failRunForTimeout(definition, run, now)
                : run.threadId
                  ? reconcileThread({ threadId: run.threadId })
                  : Effect.void,
          }),
        ),
      );

    const reconcileActiveRuns: AutomationServiceShape["reconcileActiveRuns"] = () =>
      automationRepository.listRecoverableRuns({ limit: 100 }).pipe(
        Effect.mapError(toServiceError("Failed to list active automation runs.")),
        Effect.flatMap((runs) =>
          Effect.forEach(
            runs,
            (run) =>
              reconcileActiveRun(run, isoNow()).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("automation active-run reconcile failed", {
                    automationId: run.automationId,
                    runId: run.id,
                    error: recoveryErrorMessage(error),
                  }),
                ),
              ),
            { concurrency: 1 },
          ),
        ),
        Effect.flatMap(() => enqueuePendingCompletionEvaluations()),
        Effect.asVoid,
      );

    const recoverRun = (run: AutomationRun) => {
      const now = isoNow();
      const threadId = run.threadId;
      if (!threadId) {
        // Orphaned before any thread was created (crash between create and dispatch).
        return interruptRunForRecovery(run, now).pipe(
          Effect.mapError(toServiceError("Failed to recover automation run.")),
          Effect.asVoid,
          Effect.catch((error) =>
            Effect.logWarning("automation orphaned-run recovery failed", {
              automationId: run.automationId,
              runId: run.id,
              error: recoveryErrorMessage(error),
            }),
          ),
        );
      }
      return projectionSnapshotQuery.getThreadShellById(threadId).pipe(
        Effect.mapError(toServiceError("Failed to load automation thread state.")),
        Effect.flatMap((shellOption) =>
          Option.isNone(shellOption)
            ? interruptRunForRecovery(run, now).pipe(
                Effect.mapError(toServiceError("Failed to recover automation run.")),
                Effect.asVoid,
              )
            : resolveRunTurn(run, shellOption.value).pipe(
                Effect.flatMap((turn) =>
                  turn === null
                    ? interruptRunForRecovery(run, now).pipe(
                        Effect.mapError(toServiceError("Failed to recover automation run.")),
                        Effect.asVoid,
                      )
                    : reconcileThread({ threadId }),
                ),
              ),
        ),
        Effect.catch((error) =>
          Effect.logWarning("automation pending-run recovery failed", {
            automationId: run.automationId,
            runId: run.id,
            error: recoveryErrorMessage(error),
          }),
        ),
      );
    };

    const recoverPendingRuns: AutomationServiceShape["recoverPendingRuns"] = () => {
      const recoverPage = (after?: AutomationRun): Effect.Effect<void, AutomationServiceError> =>
        automationRepository
          .listRecoverableRuns({
            limit: 200,
            ...(after ? { afterCreatedAt: after.createdAt, afterRunId: after.id } : {}),
          })
          .pipe(
            Effect.mapError(toServiceError("Failed to list recoverable automation runs.")),
            Effect.flatMap((runs) =>
              Effect.forEach(runs, recoverRun, { concurrency: 1 }).pipe(
                Effect.flatMap(() =>
                  runs.length === 200 ? recoverPage(runs[runs.length - 1]) : Effect.void,
                ),
              ),
            ),
          );

      return recoverPage().pipe(
        Effect.flatMap(() => enqueuePendingCompletionEvaluations()),
        Effect.asVoid,
      );
    };

    const list: AutomationServiceShape["list"] = (input = {}) =>
      automationRepository
        .list(input)
        .pipe(Effect.mapError(toServiceError("Failed to list automations.")));

    // Resolves the automation run that dispatched the caller's active turn, if any.
    // This is the only authority a standalone run has over its own automation: its
    // thread is created per run, so it matches neither sourceThreadId nor targetThreadId.
    const resolveCallerAutomationRun = (input: {
      readonly callerThreadId: ThreadId;
      readonly callerTurnId: TurnId | null;
    }): Effect.Effect<CallerAutomationRunResolution, AutomationServiceError> =>
      Effect.gen(function* () {
        if (!input.callerTurnId) {
          return { reason: "no-active-turn" } as const;
        }
        const runOption = yield* automationRepository
          .getRunByThreadId({ threadId: input.callerThreadId })
          .pipe(Effect.mapError(toServiceError("Failed to resolve the automation run.")));
        if (Option.isNone(runOption)) {
          return { reason: "not-automation-dispatched" } as const;
        }
        const run = runOption.value;
        if (run.turnId === input.callerTurnId) {
          return { run } as const;
        }
        const turnOption = yield* projectionTurnRepository
          .getByTurnId({
            threadId: input.callerThreadId,
            turnId: input.callerTurnId,
          })
          .pipe(Effect.mapError(toServiceError("Failed to resolve the automation turn.")));
        if (
          Option.isNone(turnOption) ||
          run.messageId === null ||
          turnOption.value.pendingMessageId !== run.messageId
        ) {
          return { reason: "turn-not-part-of-run" } as const;
        }
        return { run } as const;
      });

    const requireCallerAutomationRun = (input: {
      readonly callerThreadId: ThreadId;
      readonly callerTurnId: TurnId | null;
    }) =>
      resolveCallerAutomationRun(input).pipe(
        Effect.flatMap((resolution) =>
          "run" in resolution
            ? Effect.succeed(resolution.run)
            : Effect.fail(
                new AutomationServiceError({
                  message: CALLER_AUTOMATION_RUN_FAILURES[resolution.reason],
                }),
              ),
        ),
      );

    const resolveCallerRun: AutomationServiceShape["resolveCallerRun"] = (input) =>
      resolveCallerAutomationRun(input).pipe(
        Effect.map((resolution) =>
          "run" in resolution ? Option.some(resolution.run) : Option.none<AutomationRun>(),
        ),
      );

    const getMemory: AutomationServiceShape["getMemory"] = (automationId) =>
      automationRepository.getMemory({ automationId }).pipe(
        Effect.mapError(toServiceError("Failed to load automation memory.")),
        Effect.map((memoryOption) =>
          Option.match(memoryOption, {
            onNone: () => null,
            onSome: (memory) => memory,
          }),
        ),
      );

    const listRunsForDefinition: AutomationServiceShape["listRunsForDefinition"] = (input) =>
      automationRepository
        .listRunsForDefinition(input)
        .pipe(Effect.mapError(toServiceError("Failed to list automation runs.")));

    const updateMemory: AutomationServiceShape["updateMemory"] = (input) =>
      Effect.gen(function* () {
        if (Buffer.byteLength(input.content, "utf8") > AUTOMATION_MEMORY_MAX_BYTES) {
          return yield* Effect.fail(
            new AutomationServiceError({
              message: "Automation memory must not exceed 32 KiB.",
            }),
          );
        }
        let definition: AutomationDefinition;
        if (input.automationId === null) {
          const run = yield* requireCallerAutomationRun(input).pipe(
            Effect.mapError(
              (error) =>
                new AutomationServiceError({
                  message: `${error.message} Pass "automationId" explicitly outside automation-dispatched turns.`,
                }),
            ),
          );
          definition = yield* requireDefinition(run.automationId);
        } else {
          definition = yield* requireDefinition(input.automationId);
          const callerOwnsDefinition =
            definition.sourceThreadId === input.callerThreadId ||
            definition.targetThreadId === input.callerThreadId;
          if (!callerOwnsDefinition) {
            const run = yield* requireCallerAutomationRun(input);
            if (run.automationId !== definition.id) {
              return yield* Effect.fail(
                new AutomationServiceError({
                  message: "The active turn does not belong to this automation.",
                }),
              );
            }
          }
        }
        const memory = yield* automationRepository
          .upsertMemory({
            automationId: definition.id,
            content: input.content,
            updatedAt: isoNow(),
          })
          .pipe(Effect.mapError(toServiceError("Failed to update automation memory.")));
        yield* publish({ type: "memory-upserted", memory });
        return memory;
      });

    const reportResult: AutomationServiceShape["reportResult"] = (input) =>
      Effect.gen(function* () {
        const run = yield* requireCallerAutomationRun(input);
        const now = isoNow();
        const baseResult =
          run.result ??
          ({
            outcome: "unknown",
            summary: null,
            unread: false,
            archivedAt: null,
          } satisfies AutomationRunResult);
        const result: AutomationRunResult = {
          ...baseResult,
          decision: input.decision,
          ...(input.title ? { title: input.title } : {}),
          summary:
            input.summary === undefined
              ? baseResult.summary
              : automationRunResultSummary(input.summary),
          unread: false,
        };
        const updated = yield* automationRepository
          .markRunResult({ id: run.id, result, updatedAt: now })
          .pipe(Effect.mapError(toServiceError("Failed to report automation result.")));
        yield* publish({ type: "run-upserted", run: updated });
        return updated;
      });

    const create: AutomationServiceShape["create"] = (input) =>
      Effect.gen(function* () {
        const now = isoNow();
        const normalizedInput: AutomationCreateInput = {
          ...input,
          stopAfterConsecutiveFailures: resolveAutomationStopPolicy(
            input,
            DEFAULT_AUTOMATION_STOP_AFTER_CONSECUTIVE_FAILURES,
          ),
        };
        const proposalError = proposalCreateError(input);
        if (proposalError) {
          return yield* Effect.fail(new AutomationServiceError({ message: proposalError }));
        }
        yield* requireProject(input.projectId);
        yield* validateSchedulePolicy({
          schedule: input.schedule,
          enabled: input.enabled ?? true,
          maxIterations: input.maxIterations ?? null,
          minimumIntervalSeconds:
            input.minimumIntervalSeconds ?? DEFAULT_AUTOMATION_MINIMUM_INTERVAL_SECONDS,
          acknowledgedRisks: input.acknowledgedRisks ?? [],
          now,
        });
        yield* validateExecutionPolicies({
          retryPolicy: input.retryPolicy ?? { type: "none" },
        });
        yield* validateRiskAcknowledgements({
          runtimeMode: input.runtimeMode ?? "approval-required",
          worktreeMode: input.worktreeMode ?? "auto",
          acknowledgedRisks: input.acknowledgedRisks ?? [],
        });
        yield* validateAutoRuntimeMode({
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode ?? "approval-required",
        });
        yield* validateHeartbeatTarget({
          mode: input.mode ?? "standalone",
          projectId: input.projectId,
          targetThreadId: input.targetThreadId ?? null,
        });
        const id = makeAutomationId();
        const initialNextRunAt = computeNextAutomationRunAt(
          input.schedule,
          now,
          jitterContextFor(id),
        );
        const definition = yield* automationRepository
          .createDefinition({ id, input: normalizedInput, now, nextRunAt: initialNextRunAt })
          .pipe(Effect.mapError(toServiceError("Failed to create automation.")));
        const normalized = yield* normalizeCreatedDefinitionSchedule(definition, now).pipe(
          Effect.mapError(toServiceError("Failed to initialize automation schedule.")),
        );
        yield* publish({ type: "definition-upserted", definition: normalized });
        return normalized;
      });

    const validateDefinitionUpdate = (definition: AutomationDefinition, now: string) =>
      Effect.gen(function* () {
        yield* requireProject(definition.projectId);
        yield* validateSchedulePolicy({
          schedule: definition.schedule,
          enabled: definition.enabled,
          maxIterations: definition.maxIterations,
          minimumIntervalSeconds: definition.minimumIntervalSeconds,
          acknowledgedRisks: definition.acknowledgedRisks,
          now,
        });
        yield* validateExecutionPolicies({ retryPolicy: definition.retryPolicy });
        yield* validateRiskAcknowledgements({
          runtimeMode: definition.runtimeMode,
          worktreeMode: definition.worktreeMode,
          acknowledgedRisks: definition.acknowledgedRisks,
        });
        yield* validateAutoRuntimeMode(definition);
        yield* validateHeartbeatTarget(definition);
      });

    const saveDefinitionUpdate = (
      input: AutomationUpdateInput,
      attempt: number,
    ): Effect.Effect<AutomationDefinition, AutomationServiceError> =>
      Effect.gen(function* () {
        const current = yield* requireDefinition(input.id);
        if (current.proposalState === "pending") {
          return yield* Effect.fail(
            new AutomationServiceError({
              message: "Pending automation proposals must be accepted or dismissed first.",
            }),
          );
        }
        const now = nextDefinitionUpdatedAt(current.updatedAt);
        const updated = mergeDefinitionUpdate(current, input, now, jitterContextFor(current.id));
        yield* validateDefinitionUpdate(updated, now);
        const savedOption = yield* automationRepository
          .saveDefinition({ definition: updated, expectedUpdatedAt: current.updatedAt })
          .pipe(Effect.mapError(toServiceError("Failed to update automation.")));
        if (Option.isNone(savedOption)) {
          if (attempt < AUTOMATION_DEFINITION_UPDATE_MAX_ATTEMPTS) {
            return yield* saveDefinitionUpdate(input, attempt + 1);
          }
          return yield* Effect.fail(
            new AutomationServiceError({
              message: "The automation changed while saving. Try again.",
            }),
          );
        }
        const saved = savedOption.value;
        yield* publish({ type: "definition-upserted", definition: saved });
        return saved;
      });

    const update: AutomationServiceShape["update"] = (input) => {
      if (hasOwn(input, "proposalState")) {
        return Effect.fail(
          new AutomationServiceError({
            message: "Automation proposal state can only change through proposal resolution.",
          }),
        );
      }
      return saveDefinitionUpdate(input, 1);
    };

    const resolveProposal: AutomationServiceShape["resolveProposal"] = (input) =>
      Effect.gen(function* () {
        const current = yield* requireDefinition(input.automationId);
        if (current.proposalState !== "pending") {
          return yield* Effect.fail(
            new AutomationServiceError({
              message: "Automation proposal is no longer pending.",
            }),
          );
        }
        const now = isoNow();
        const accepted = input.resolution === "accepted";
        const nextRunAt = accepted
          ? computeNextAutomationRunAt(current.schedule, now, jitterContextFor(current.id))
          : null;
        if (accepted) {
          yield* validateSchedulePolicy({
            schedule: current.schedule,
            enabled: true,
            maxIterations: current.maxIterations,
            minimumIntervalSeconds: current.minimumIntervalSeconds,
            acknowledgedRisks: current.acknowledgedRisks,
            now,
          });
        }
        const definition: AutomationDefinition = {
          ...current,
          enabled: accepted,
          nextRunAt,
          proposalState: input.resolution,
          archivedAt: accepted ? null : now,
          updatedAt: now,
        };
        const resolved = yield* automationRepository
          .resolvePendingProposal({
            id: definition.id,
            resolution: input.resolution,
            nextRunAt: definition.nextRunAt,
            updatedAt: now,
            archivedAt: definition.archivedAt,
          })
          .pipe(Effect.mapError(toServiceError("Failed to resolve automation proposal.")));
        if (!resolved) {
          return yield* Effect.fail(
            new AutomationServiceError({
              message: "Automation proposal is no longer pending.",
            }),
          );
        }
        yield* publishProposalActivity(definition, input.resolution, now);
        yield* publish(
          accepted
            ? { type: "definition-upserted", definition }
            : { type: "definition-deleted", automationId: definition.id },
        );
        return { definition };
      });

    const interruptRunBestEffort = (run: AutomationRun, now: string) => {
      if (!run.threadId) {
        return Effect.void;
      }
      return orchestrationEngine
        .dispatch({
          type: "thread.turn.interrupt",
          commandId: makeAutomationCommandId(run.id, "interrupt"),
          threadId: run.threadId,
          ...(run.turnId ? { turnId: run.turnId } : {}),
          createdAt: now,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("automation run interrupt failed", {
              runId: run.id,
              threadId: run.threadId,
              error: errorMessage(error),
            }),
          ),
          Effect.asVoid,
        );
    };

    const cancelRunById = (input: { readonly runId: AutomationRunId }) =>
      Effect.gen(function* () {
        const now = isoNow();
        const run = yield* automationRepository
          .cancelRun({ ...input, now })
          .pipe(Effect.mapError(toServiceError("Failed to cancel automation run.")));
        if (run.status !== "cancelled") {
          yield* publish({ type: "run-upserted", run });
          return run;
        }
        return yield* publishRunResult(
          run,
          "cancelled",
          now,
          "Automation run was cancelled.",
          true,
        );
      });

    const deleteAutomation: AutomationServiceShape["delete"] = (input) =>
      Effect.gen(function* () {
        const activeRuns = yield* automationRepository
          .listActiveRunsForDefinition({ automationId: input.id })
          .pipe(Effect.mapError(toServiceError("Failed to load active automation runs.")));
        yield* Effect.forEach(
          activeRuns,
          (run) => cancelRunById({ runId: run.id }).pipe(Effect.catch(() => Effect.void)),
          { concurrency: 1 },
        );
        yield* automationRepository
          .archiveDefinition({ id: input.id, archivedAt: isoNow() })
          .pipe(Effect.mapError(toServiceError("Failed to delete automation.")));
        yield* publish({ type: "definition-deleted", automationId: input.id });
      });

    const heartbeatThreadRunState = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const activeRuns = yield* automationRepository
          .countActiveRunsForThread({ threadId })
          .pipe(Effect.mapError(toServiceError("Failed to count active automation runs.")));
        const pendingCompletionEvaluations = yield* automationRepository
          .countPendingCompletionEvaluationsForThread({ threadId })
          .pipe(
            Effect.mapError(toServiceError("Failed to count pending automation stop evaluations.")),
          );
        return { activeRuns, pendingCompletionEvaluations };
      });

    // Gate a run that would append to an existing thread. A dedicated automation is the only
    // writer on its own thread, so in practice it only ever waits for its predecessor; the
    // same checks still apply, because a user can open and drive that thread by hand.
    const continuationEligibility = (
      definition: AutomationDefinition,
      now: string,
    ): Effect.Effect<
      { readonly eligible: true } | { readonly eligible: false; readonly reason: string },
      AutomationServiceError
    > =>
      Effect.gen(function* () {
        const targetThreadId = automationContinuationThreadId(definition);
        if (!targetThreadId) {
          return { eligible: false as const, reason: "Heartbeat target thread was not found." };
        }
        const shellOption = yield* projectionSnapshotQuery
          .getThreadShellById(targetThreadId)
          .pipe(Effect.mapError(toServiceError("Failed to load heartbeat target state.")));
        if (Option.isNone(shellOption)) {
          return { eligible: false as const, reason: "Heartbeat target thread was not found." };
        }
        const shell = shellOption.value;
        if (threadHasInFlightTurn(shell)) {
          return { eligible: false as const, reason: "Target thread has an active turn." };
        }
        if (shell.hasPendingApprovals === true) {
          return {
            eligible: false as const,
            reason: "Target thread has a pending approval request.",
          };
        }
        if (shell.hasPendingUserInput === true) {
          return {
            eligible: false as const,
            reason: "Target thread has a pending user-input request.",
          };
        }
        const latestTurn = shell.latestTurn;
        const completedAt = latestTurn?.completedAt;
        const cooldownSeconds =
          definition.heartbeatCooldownSeconds ?? DEFAULT_AUTOMATION_HEARTBEAT_COOLDOWN_SECONDS;
        if (latestTurn && completedAt && cooldownSeconds > 0) {
          const completedAtMs = Date.parse(completedAt);
          const nowMs = Date.parse(now);
          if (
            Number.isFinite(completedAtMs) &&
            Number.isFinite(nowMs) &&
            nowMs - completedAtMs < cooldownSeconds * 1_000
          ) {
            // The cooldown protects user/agent activity on the target thread; the
            // automation's own previous run must not throttle its successor, or every
            // schedule faster than the cooldown silently degrades to cooldown cadence.
            const ownLatestRun = yield* automationRepository
              .getLatestFinishedRunForDefinition({ automationId: definition.id })
              .pipe(Effect.mapError(toServiceError("Failed to load the automation's latest run.")));
            const latestTurnIsOwnRun =
              Option.isSome(ownLatestRun) && ownLatestRun.value.turnId === latestTurn.turnId;
            if (!latestTurnIsOwnRun) {
              return {
                eligible: false as const,
                reason: `Target thread is inside its ${cooldownSeconds}-second activity cooldown.`,
              };
            }
          }
        }
        return { eligible: true as const };
      });

    const heartbeatDeferState = (scheduledFor: string, now: string) => {
      const scheduledForMs = Date.parse(scheduledFor);
      const nowMs = Date.parse(now);
      const safeScheduledForMs = Number.isFinite(scheduledForMs) ? scheduledForMs : nowMs;
      const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
      const deadlineMs = safeScheduledForMs + AUTOMATION_HEARTBEAT_DEFER_WINDOW_MS;
      return {
        expired: safeNowMs >= deadlineMs,
        deferredUntil: new Date(
          Math.min(safeNowMs + AUTOMATION_HEARTBEAT_DEFER_RETRY_MS, deadlineMs),
        ).toISOString(),
      };
    };

    const restartExhaustedBoundedDefinition = (definition: AutomationDefinition, now: string) =>
      Effect.gen(function* () {
        if (
          definition.maxIterations === null ||
          definition.iterationCount < definition.maxIterations
        ) {
          return definition;
        }
        if (definition.disabledReason === "failures") {
          return definition;
        }
        const computedNextRunAt =
          definition.schedule.type === "manual"
            ? null
            : computeNextAutomationRunAtAfter(
                definition.schedule,
                now,
                now,
                jitterContextFor(definition.id),
              );
        // Manual reruns should not revive legacy definitions that cannot pass today's
        // active-schedule policy, such as oversized sub-minute loops.
        let canBecomeEnabled = false;
        if (definition.schedule.type === "manual" || computedNextRunAt !== null) {
          canBecomeEnabled = yield* validateSchedulePolicy({
            schedule: definition.schedule,
            enabled: true,
            maxIterations: definition.maxIterations,
            minimumIntervalSeconds: definition.minimumIntervalSeconds,
            acknowledgedRisks: definition.acknowledgedRisks,
            now,
          }).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          );
        }
        const enabled = canBecomeEnabled;
        const nextRunAt = enabled ? computedNextRunAt : null;
        const restarted: AutomationDefinition = enabled
          ? {
              ...definition,
              enabled: true,
              iterationCount: 0,
              consecutiveFailureCount: 0,
              disabledReason: null,
              disabledAt: null,
              nextRunAt,
              updatedAt: now,
            }
          : {
              ...definition,
              enabled: false,
              iterationCount: 0,
              nextRunAt: null,
              updatedAt: now,
            };
        return yield* automationRepository
          .restartDefinitionLoop({ id: definition.id, enabled, nextRunAt, updatedAt: now })
          .pipe(
            Effect.mapError(toServiceError("Failed to restart automation loop.")),
            Effect.as(restarted),
            Effect.tap((definition) => publish({ type: "definition-upserted", definition })),
          );
      });

    const runNow: AutomationServiceShape["runNow"] = (input) =>
      Effect.gen(function* () {
        const definition = yield* requireDefinition(input.automationId);
        if (definition.proposalState === "pending") {
          return yield* Effect.fail(
            new AutomationServiceError({
              message: "Pending automation proposals must be accepted before they can run.",
            }),
          );
        }
        if (!definition.enabled && definition.disabledReason === "failures") {
          return yield* Effect.fail(
            new AutomationServiceError({
              message: "Re-enable the automation before running it again.",
            }),
          );
        }
        const disabledReason = yield* providerDisabledReason(definition);
        if (disabledReason) {
          return yield* Effect.fail(
            new AutomationServiceError({
              message: `Automation is paused because ${disabledReason}`,
            }),
          );
        }
        const now = isoNow();
        let heartbeatRunState:
          | { readonly activeRuns: number; readonly pendingCompletionEvaluations: number }
          | undefined;
        if (automationRequiresTargetThread(definition.mode) && !definition.targetThreadId) {
          return yield* Effect.fail(
            new AutomationServiceError({
              message: "Heartbeat automation has no target thread to continue.",
            }),
          );
        }
        // A dedicated automation that has not opened its thread yet has nothing to wait for:
        // this run creates the thread, exactly like a standalone one.
        const continuationThreadId = automationContinuationThreadId(definition);
        if (continuationThreadId) {
          heartbeatRunState = yield* heartbeatThreadRunState(continuationThreadId);
        }
        const runnableDefinition = yield* restartExhaustedBoundedDefinition(definition, now);
        if (continuationThreadId) {
          const eligibility =
            (heartbeatRunState?.activeRuns ?? 0) > 0
              ? ({
                  eligible: false as const,
                  reason: "Target thread has an active automation run.",
                } as const)
              : (heartbeatRunState?.pendingCompletionEvaluations ?? 0) > 0
                ? ({
                    eligible: false as const,
                    reason: "Target thread has a pending automation stop evaluation.",
                  } as const)
                : yield* continuationEligibility(runnableDefinition, now);
          if (!eligibility.eligible) {
            const deferState = heartbeatDeferState(now, now);
            const deferredRun = yield* claimPendingRun(
              runnableDefinition,
              { type: "manual" },
              now,
              now,
              undefined,
              deferState.deferredUntil,
              null,
            );
            if (Option.isNone(deferredRun)) {
              return yield* Effect.fail(
                new AutomationServiceError({
                  message: "Automation run capacity or iteration limit was reached.",
                }),
              );
            }
            return { run: deferredRun.value };
          }
        }
        const claimedRun = yield* claimPendingRun(runnableDefinition, { type: "manual" }, now, now);
        if (Option.isNone(claimedRun)) {
          return yield* Effect.fail(
            new AutomationServiceError({
              message: "Automation run capacity or iteration limit was reached.",
            }),
          );
        }
        return yield* dispatchRun(runnableDefinition, claimedRun.value, now);
      });

    const cancelRun: AutomationServiceShape["cancelRun"] = (input) =>
      cancelRunById(input).pipe(Effect.map((run) => ({ run })));

    const markRunRead: AutomationServiceShape["markRunRead"] = (input) =>
      automationRepository.markRunRead({ ...input, now: isoNow() }).pipe(
        Effect.mapError(toServiceError("Failed to update automation run.")),
        Effect.tap((run) => publish({ type: "run-upserted", run })),
        Effect.map((run) => ({ run })),
      );

    const archiveRun: AutomationServiceShape["archiveRun"] = (input) =>
      automationRepository.archiveRun({ ...input, now: isoNow() }).pipe(
        Effect.mapError(toServiceError("Failed to update automation run.")),
        Effect.tap((run) => publish({ type: "run-upserted", run })),
        Effect.map((run) => ({ run })),
      );

    const markScheduledRunSkipped = (run: AutomationRun, reason: string, now: string) =>
      Effect.gen(function* () {
        const skipped = yield* automationRepository
          .markRunSkipped({ id: run.id, reason, finishedAt: now })
          .pipe(Effect.mapError(toServiceError("Failed to skip automation run.")));
        return yield* publishRunResult(skipped, "skipped", now, reason);
      });

    const advanceScheduledDefinition = (
      definition: AutomationDefinition,
      nextRunAt: string | null,
      now: string,
    ) =>
      Effect.gen(function* () {
        if (definition.schedule.type === "once" && nextRunAt === null) {
          yield* automationRepository
            .disableDefinition({ id: definition.id, now, reason: "schedule" })
            .pipe(Effect.mapError(toServiceError("Failed to complete one-shot automation.")));
        } else {
          yield* automationRepository
            .setDefinitionNextRunAt({ id: definition.id, nextRunAt, updatedAt: now })
            .pipe(Effect.mapError(toServiceError("Failed to advance automation schedule.")));
        }
        yield* publishDefinition(definition.id);
      });

    const completeDeferredOneShotDefinition = (definition: AutomationDefinition, now: string) =>
      definition.schedule.type !== "once"
        ? Effect.void
        : automationRepository
            .disableDefinition({ id: definition.id, now, reason: "schedule" })
            .pipe(
              Effect.mapError(toServiceError("Failed to complete deferred one-shot automation.")),
              Effect.andThen(publishDefinition(definition.id)),
            );

    // Run one due definition: enforce the iteration cap, apply misfire policy, skip when a
    // prior heartbeat run is still in flight, then dispatch. The run row is durable before
    // schedule advancement, so dispatch failures still leave auditable history.
    const runDueDefinition = (definition: AutomationDefinition, now: string) =>
      Effect.gen(function* () {
        if (definition.proposalState === "pending") {
          return Option.none<AutomationRunNowResult>();
        }
        if (
          definition.maxIterations !== null &&
          definition.iterationCount >= definition.maxIterations
        ) {
          yield* automationRepository
            .disableDefinition({ id: definition.id, now, reason: "max-iterations" })
            .pipe(Effect.mapError(toServiceError("Failed to disable automation.")));
          yield* publishDefinition(definition.id);
          return Option.none<AutomationRunNowResult>();
        }

        const occurrence = scheduledOccurrenceForDefinition(
          definition,
          now,
          jitterContextFor(definition.id),
        );
        const { scheduledFor, nextRunAt } = occurrence;
        if (occurrence.skip) {
          const { run, inserted } = yield* createPendingRun(
            definition,
            { type: "scheduled" },
            scheduledFor,
            now,
            { threadIdOverride: null },
          );
          if (inserted) {
            yield* markScheduledRunSkipped(run, "Scheduled occurrence was missed.", now);
          }
          yield* advanceScheduledDefinition(definition, nextRunAt, now);
          return Option.none<AutomationRunNowResult>();
        }

        const disabledReason = yield* providerDisabledReason(definition);
        if (disabledReason && definition.schedule.type === "once") {
          const deferredRun = yield* claimPendingRun(
            definition,
            { type: "scheduled" },
            scheduledFor,
            now,
            { nextRunAt, disable: false },
            new Date(Date.parse(now) + AUTOMATION_HEARTBEAT_DEFER_RETRY_MS).toISOString(),
          );
          yield* publishDefinition(definition.id);
          return Option.match(deferredRun, {
            onNone: () => Option.none<AutomationRunNowResult>(),
            onSome: (run) => Option.some({ run }),
          });
        }
        if (disabledReason) {
          const claimedRun = yield* claimPendingRun(
            definition,
            { type: "scheduled" },
            scheduledFor,
            now,
            { nextRunAt, disable: false, consumeIteration: false },
            undefined,
            null,
          );
          yield* publishDefinition(definition.id);
          const skipped = Option.isSome(claimedRun)
            ? yield* markScheduledRunSkipped(claimedRun.value, disabledReason, now)
            : null;
          return skipped
            ? Option.some<AutomationRunNowResult>({ run: skipped })
            : Option.none<AutomationRunNowResult>();
        }

        if (automationRequiresTargetThread(definition.mode) && !definition.targetThreadId) {
          return yield* Effect.fail(
            new AutomationServiceError({
              message: "Heartbeat automation has no target thread to continue.",
            }),
          );
        }
        const continuationThreadId = automationContinuationThreadId(definition);
        if (continuationThreadId) {
          const runState = yield* heartbeatThreadRunState(continuationThreadId);
          if (runState.pendingCompletionEvaluations > 0) {
            const deferState = heartbeatDeferState(scheduledFor, now);
            const deferredRun = yield* claimPendingRun(
              definition,
              { type: "scheduled" },
              scheduledFor,
              now,
              {
                nextRunAt,
                // A deferred one-shot must remain enabled so listDueDeferredRuns
                // can see it. It is disabled when that durable run is dispatched
                // or terminally skipped.
                disable: false,
              },
              deferState.expired ? null : deferState.deferredUntil,
              null,
            );
            yield* publishDefinition(definition.id);
            if (Option.isNone(deferredRun)) {
              return Option.none<AutomationRunNowResult>();
            }
            if (deferState.expired) {
              yield* markScheduledRunSkipped(
                deferredRun.value,
                "Target thread has a pending automation stop evaluation.",
                now,
              );
              yield* completeDeferredOneShotDefinition(definition, now);
              return Option.none<AutomationRunNowResult>();
            }
            return Option.some({ run: deferredRun.value });
          }
          if (runState.activeRuns > 0) {
            const deferState = heartbeatDeferState(scheduledFor, now);
            const deferredRun = yield* claimPendingRun(
              definition,
              { type: "scheduled" },
              scheduledFor,
              now,
              {
                nextRunAt,
                disable: false,
              },
              deferState.expired ? null : deferState.deferredUntil,
              null,
            );
            yield* publishDefinition(definition.id);
            if (Option.isNone(deferredRun)) {
              return Option.none<AutomationRunNowResult>();
            }
            if (deferState.expired) {
              yield* markScheduledRunSkipped(
                deferredRun.value,
                "Target thread has an active automation run.",
                now,
              );
              yield* completeDeferredOneShotDefinition(definition, now);
              return Option.none<AutomationRunNowResult>();
            }
            return Option.some({ run: deferredRun.value });
          }
          const eligibility = yield* continuationEligibility(definition, now);
          if (!eligibility.eligible) {
            const deferState = heartbeatDeferState(scheduledFor, now);
            const deferredRun = yield* claimPendingRun(
              definition,
              { type: "scheduled" },
              scheduledFor,
              now,
              {
                nextRunAt,
                disable: false,
              },
              deferState.expired ? null : deferState.deferredUntil,
            );
            yield* publishDefinition(definition.id);
            if (Option.isNone(deferredRun)) {
              return Option.none<AutomationRunNowResult>();
            }
            if (deferState.expired) {
              yield* markScheduledRunSkipped(deferredRun.value, eligibility.reason, now);
              yield* completeDeferredOneShotDefinition(definition, now);
              return Option.none<AutomationRunNowResult>();
            }
            return Option.some({ run: deferredRun.value });
          }
        }

        const claimedRun = yield* claimPendingRun(
          definition,
          { type: "scheduled" },
          scheduledFor,
          now,
          {
            nextRunAt,
            disable: definition.schedule.type === "once" && nextRunAt === null,
          },
        );
        yield* publishDefinition(definition.id);

        if (Option.isNone(claimedRun)) {
          // This scheduled occurrence already had a durable row (e.g. a run interrupted by a
          // crash before the schedule advanced). Don't re-dispatch or double-count it; the
          // occurrence is already recorded and the schedule has now moved past it.
          return Option.none<AutomationRunNowResult>();
        }

        const run = claimedRun.value;
        const result = yield* dispatchRun(definition, run, now).pipe(
          Effect.catch(() =>
            automationRepository.getRunById({ id: run.id }).pipe(
              Effect.mapError(toServiceError("Failed to load automation run.")),
              Effect.map((runOption) =>
                Option.match(runOption, {
                  onNone: (): AutomationRunNowResult => ({ run }),
                  onSome: (failed): AutomationRunNowResult => ({ run: failed }),
                }),
              ),
            ),
          ),
        );
        return Option.some(result);
      });

    const retryDeferredRun = (run: AutomationRun, now: string) =>
      Effect.gen(function* () {
        const definition = yield* requireDefinition(run.automationId);
        if (!definition.enabled) {
          return Option.none<AutomationRunNowResult>();
        }
        const disabledReason = yield* providerDisabledReason(definition);
        if (disabledReason) {
          const deferred = yield* automationRepository
            .setRunDeferred({
              id: run.id,
              deferredUntil: new Date(
                Date.parse(now) + AUTOMATION_HEARTBEAT_DEFER_RETRY_MS,
              ).toISOString(),
              updatedAt: now,
            })
            .pipe(Effect.mapError(toServiceError("Failed to defer automation run.")));
          yield* publish({ type: "run-upserted", run: deferred });
          return Option.none<AutomationRunNowResult>();
        }
        if (!automationContinuesThread(definition.mode)) {
          const plannedThreadId = run.threadId ?? deriveAutomationRunIds(run.id).threadId;
          const reserved = yield* automationRepository
            .reserveDeferredRun({
              id: run.id,
              threadId: plannedThreadId,
              reservedAt: now,
            })
            .pipe(Effect.mapError(toServiceError("Failed to reserve deferred automation run.")));
          if (!reserved) {
            return Option.none<AutomationRunNowResult>();
          }
          yield* completeDeferredOneShotDefinition(definition, now);
          const result = yield* dispatchRun(definition, run, now).pipe(
            Effect.catch(() =>
              automationRepository.getRunById({ id: run.id }).pipe(
                Effect.mapError(toServiceError("Failed to load automation run.")),
                Effect.map((runOption) =>
                  Option.match(runOption, {
                    onNone: (): AutomationRunNowResult => ({ run }),
                    onSome: (failed): AutomationRunNowResult => ({ run: failed }),
                  }),
                ),
              ),
            ),
          );
          return Option.some(result);
        }
        const deferState = heartbeatDeferState(run.scheduledFor, now);
        const continuationThreadId = automationContinuationThreadId(definition);
        const runState = continuationThreadId
          ? yield* heartbeatThreadRunState(continuationThreadId)
          : { activeRuns: 0, pendingCompletionEvaluations: 0 };
        const eligibility =
          runState.activeRuns > 0
            ? ({
                eligible: false as const,
                reason: "Target thread has an active automation run.",
              } as const)
            : runState.pendingCompletionEvaluations > 0
              ? ({
                  eligible: false as const,
                  reason: "Target thread has a pending automation stop evaluation.",
                } as const)
              : yield* continuationEligibility(definition, now);
        if (!eligibility.eligible) {
          if (deferState.expired) {
            yield* markScheduledRunSkipped(run, eligibility.reason, now);
            yield* completeDeferredOneShotDefinition(definition, now);
            return Option.none<AutomationRunNowResult>();
          }
          const deferred = yield* automationRepository
            .setRunDeferred({
              id: run.id,
              deferredUntil: deferState.deferredUntil,
              updatedAt: now,
            })
            .pipe(Effect.mapError(toServiceError("Failed to defer automation run.")));
          yield* publish({ type: "run-upserted", run: deferred });
          return Option.none<AutomationRunNowResult>();
        }
        if (!continuationThreadId) {
          yield* markScheduledRunSkipped(run, "Heartbeat target thread was not found.", now);
          yield* completeDeferredOneShotDefinition(definition, now);
          return Option.none<AutomationRunNowResult>();
        }
        const reserved = yield* automationRepository
          .reserveDeferredRun({
            id: run.id,
            threadId: continuationThreadId,
            reservedAt: now,
          })
          .pipe(Effect.mapError(toServiceError("Failed to reserve deferred automation run.")));
        if (!reserved) {
          const deferred = yield* automationRepository
            .setRunDeferred({
              id: run.id,
              deferredUntil: deferState.deferredUntil,
              updatedAt: now,
            })
            .pipe(Effect.mapError(toServiceError("Failed to defer automation run.")));
          yield* publish({ type: "run-upserted", run: deferred });
          return Option.none<AutomationRunNowResult>();
        }
        yield* completeDeferredOneShotDefinition(definition, now);
        const result = yield* dispatchRun(definition, run, now).pipe(
          Effect.catch(() =>
            automationRepository.getRunById({ id: run.id }).pipe(
              Effect.mapError(toServiceError("Failed to load automation run.")),
              Effect.map((runOption) =>
                Option.match(runOption, {
                  onNone: (): AutomationRunNowResult => ({ run }),
                  onSome: (failed): AutomationRunNowResult => ({ run: failed }),
                }),
              ),
            ),
          ),
        );
        return Option.some(result);
      });

    const runDueOnce: AutomationServiceShape["runDueOnce"] = (input = {}) =>
      Effect.gen(function* () {
        const now = input.now ?? isoNow();
        const ownerId = input.leaseOwnerId ?? `automation-scheduler:${process.pid}`;
        const nowMs = Date.parse(now);
        const leaseExpiresAt = new Date(
          (Number.isFinite(nowMs) ? nowMs : Date.now()) + SCHEDULER_LEASE_TTL_MS,
        ).toISOString();
        const acquired = yield* automationRepository
          .tryAcquireSchedulerLease({
            leaseKey: "automation-scheduler",
            ownerId,
            now,
            leaseExpiresAt,
          })
          .pipe(Effect.mapError(toServiceError("Failed to acquire automation scheduler lease.")));
        if (!acquired) {
          // Another instance holds the scheduler lease. Expected under multi-instance;
          // logged at debug so lease contention is observable without log noise.
          yield* Effect.logDebug("automation scheduler lease not acquired", { ownerId });
          return [];
        }

        const passLimit = Math.max(0, input.limit ?? 3);
        const deferredRuns = yield* automationRepository
          .listDueDeferredRuns({ now, limit: passLimit })
          .pipe(Effect.mapError(toServiceError("Failed to list deferred automation runs.")));
        const deferredResults = yield* Effect.forEach(
          deferredRuns,
          (run) =>
            retryDeferredRun(run, now).pipe(
              Effect.catch((error) =>
                Effect.logWarning("automation deferred run failed", {
                  automationId: run.automationId,
                  runId: run.id,
                  error: errorMessage(error),
                }).pipe(Effect.as(Option.none<AutomationRunNowResult>())),
              ),
            ),
          { concurrency: 3 },
        );

        const dispatchedDeferredCount = deferredResults.filter(Option.isSome).length;
        const remaining = Math.max(0, passLimit - dispatchedDeferredCount);
        const definitions = yield* automationRepository
          .listDueDefinitions({
            now,
            limit: remaining,
          })
          .pipe(Effect.mapError(toServiceError("Failed to list due automations.")));

        const results = yield* Effect.forEach(
          definitions,
          (definition) =>
            runDueDefinition(definition, now).pipe(
              Effect.catch((error) =>
                Effect.logWarning("automation scheduled run failed", {
                  automationId: definition.id,
                  error: errorMessage(error),
                }).pipe(Effect.as(Option.none<AutomationRunNowResult>())),
              ),
            ),
          { concurrency: 3 },
        );

        return [...deferredResults, ...results].filter(Option.isSome).map((result) => result.value);
      });

    return {
      list,
      create,
      update,
      delete: deleteAutomation,
      resolveProposal,
      getMemory,
      listRunsForDefinition,
      updateMemory,
      reportResult,
      resolveCallerRun,
      runNow,
      cancelRun,
      markRunRead,
      archiveRun,
      runDueOnce,
      reconcileThread,
      reconcileActiveRuns,
      recoverPendingRuns,
      streamEvents: Stream.fromPubSub(events),
    } satisfies AutomationServiceShape;
  }),
);

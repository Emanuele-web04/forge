// FILE: automationDraft.ts
// Purpose: Builds editable automation drafts and safety warnings for chat-triggered creation.
// Layer: Web lib
// Exports: AutomationCreationDraft plus pure warning/skill helpers.
// Depends on: automation contracts shared with the native API.

import { DEFAULT_AUTOMATION_FAST_INTERVAL_MAX_ITERATIONS } from "@synara/contracts";
import type {
  AutomationMode,
  AutomationSchedule,
  AutomationInteractionMode,
  AutomationWorktreeMode,
  ModelSelection,
  ProjectId,
  RuntimeMode,
  ThreadId,
} from "@synara/contracts";
import { automationRequiresTargetThread } from "@synara/shared/automationMode";

import type { ChatAutomationExecutionScope } from "./automationIntent";

// Heartbeat runs inside a thread the user already owns, so its checkout is the user's
// concern. Every other mode opens its own thread and may create its own worktree.
function automationOpensItsOwnCheckout(mode: AutomationMode): boolean {
  return !automationRequiresTargetThread(mode);
}

export type AutomationCreationDraftSource = "slash" | "mention" | "dialog" | "generated";

export type AutomationDraftWarningId =
  | "attachments-not-persisted"
  | "fast-recurring-interval"
  | "full-access"
  | "local-checkout"
  | "missing-schedule"
  | "generated-low-confidence"
  | "skill-reference"
  | "worktree-cleanup";

export interface AutomationDraftWarning {
  readonly id: AutomationDraftWarningId;
  readonly title: string;
  readonly detail: string;
  readonly requiresAcknowledgement: boolean;
}

export type AutomationAcknowledgedRiskId = "full-access" | "local-checkout" | "fast-interval";

export interface AutomationCreationDraft {
  readonly source: AutomationCreationDraftSource;
  readonly name: string;
  readonly prompt: string;
  readonly schedule: AutomationSchedule;
  readonly mode: AutomationMode;
  readonly targetThreadId: ThreadId | null;
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: AutomationInteractionMode;
  readonly worktreeMode: AutomationWorktreeMode;
  readonly maxIterations: number | null;
  readonly stopOnError: boolean;
  readonly warnings: readonly AutomationDraftWarning[];
}

export function containsAutomationSkillReference(prompt: string): boolean {
  return /(^|\s)\$[a-z0-9][a-z0-9_-]*(?=\s|$|[,.!?;:])/i.test(prompt);
}

export function buildAutomationDraftWarnings(input: {
  readonly schedule: AutomationSchedule;
  readonly mode: AutomationMode;
  readonly runtimeMode: RuntimeMode;
  readonly worktreeMode: AutomationWorktreeMode;
  readonly hasEphemeralContext: boolean;
  readonly generatedConfidence: number | null;
  readonly generatedNeedsConfirmation: boolean;
  readonly prompt: string;
}): readonly AutomationDraftWarning[] {
  const warnings: AutomationDraftWarning[] = [];
  if (input.hasEphemeralContext) {
    warnings.push({
      id: "attachments-not-persisted",
      title: "Composer context is not persisted",
      detail:
        "Attachments, provider mentions, pasted context, and terminal snippets will not be replayed on scheduled runs.",
      requiresAcknowledgement: true,
    });
  }
  if (input.schedule.type === "manual") {
    warnings.push({
      id: "missing-schedule",
      title: "Schedule needs review",
      detail: "Choose when this automation should run before creating it.",
      requiresAcknowledgement: false,
    });
  }
  if (input.schedule.type === "interval" && input.schedule.everySeconds < 60) {
    warnings.push({
      id: "fast-recurring-interval",
      title: "Fast recurring loop",
      detail: "Intervals under one minute can create noisy unattended runs.",
      requiresAcknowledgement: true,
    });
  }
  if (input.runtimeMode === "full-access") {
    warnings.push({
      id: "full-access",
      title: "Full access",
      detail: "Scheduled full-access runs can make changes without per-step approval.",
      requiresAcknowledgement: true,
    });
  }
  if (
    input.worktreeMode === "local" ||
    (automationOpensItsOwnCheckout(input.mode) && input.worktreeMode === "auto")
  ) {
    warnings.push({
      id: "local-checkout",
      title:
        input.worktreeMode === "auto" ? "Auto fallback may use local checkout" : "Local checkout",
      detail:
        input.worktreeMode === "auto"
          ? "If Synara cannot create a worktree, runs may fall back to editing the active project checkout."
          : "Runs may edit files in the active project checkout.",
      requiresAcknowledgement: true,
    });
  }
  if (
    automationOpensItsOwnCheckout(input.mode) &&
    (input.worktreeMode === "worktree" || input.worktreeMode === "auto")
  ) {
    warnings.push({
      id: "worktree-cleanup",
      title: "Worktree cleanup",
      detail: "Generated worktrees or branches are kept after archiving until you remove them.",
      requiresAcknowledgement: false,
    });
  }
  if (
    input.generatedNeedsConfirmation ||
    (input.generatedConfidence !== null && input.generatedConfidence < 0.75)
  ) {
    warnings.push({
      id: "generated-low-confidence",
      title: "Review generated fields",
      detail: "Synara was not fully confident about the parsed automation fields.",
      requiresAcknowledgement: false,
    });
  }
  if (containsAutomationSkillReference(input.prompt)) {
    warnings.push({
      id: "skill-reference",
      title: "Skill reference kept in prompt",
      detail:
        "Skill tokens stay as prompt text unless the selected provider can resolve them at run time.",
      requiresAcknowledgement: false,
    });
  }
  return warnings;
}

// Computes the approval an existing automation still needs before it can run or update.
// `warnings` drives the banner; `runBlockingWarnings` is the narrower subset that should
// disable Run now. `acknowledgedRisks` is the full set to persist on approval.
export function automationApprovalGaps(input: {
  readonly schedule: AutomationSchedule;
  readonly enabled: boolean;
  readonly maxIterations: number | null;
  readonly mode: AutomationMode;
  readonly runtimeMode: RuntimeMode;
  readonly worktreeMode: AutomationWorktreeMode;
  readonly prompt: string;
  readonly acknowledgedRisks: readonly AutomationAcknowledgedRiskId[];
}): {
  readonly warnings: readonly AutomationDraftWarning[];
  readonly runBlockingWarnings: readonly AutomationDraftWarning[];
  readonly acknowledgedRisks: readonly AutomationAcknowledgedRiskId[];
  readonly maxIterations: number | undefined;
} {
  const acknowledged = new Set(input.acknowledgedRisks);
  const approvalIds = new Set<AutomationDraftWarningId>();
  const maxIterations = maxIterationsForFastIntervalApproval(input);
  // Definite run blockers: full-access and a local checkout the automation opens itself.
  // Heartbeats reuse their target thread, so local-checkout consent is needed for updates
  // but not dispatch.
  const runBlockingIds = new Set<AutomationDraftWarningId>();
  if (input.runtimeMode === "full-access" && !acknowledged.has("full-access")) {
    approvalIds.add("full-access");
    runBlockingIds.add("full-access");
  }
  if (input.worktreeMode === "local" && !acknowledged.has("local-checkout")) {
    approvalIds.add("local-checkout");
    if (automationOpensItsOwnCheckout(input.mode)) {
      runBlockingIds.add("local-checkout");
    }
  }
  if (
    input.schedule.type === "interval" &&
    input.schedule.everySeconds < 60 &&
    !acknowledged.has("fast-interval")
  ) {
    approvalIds.add("fast-recurring-interval");
  }
  if (maxIterations !== undefined) {
    approvalIds.add("fast-recurring-interval");
  }
  if (
    approvalIds.size > 0 &&
    automationOpensItsOwnCheckout(input.mode) &&
    input.worktreeMode === "auto" &&
    !acknowledged.has("local-checkout")
  ) {
    // Auto fallback is not enough to show the banner by itself, but if the user is already
    // approving another risk, include the fallback consent instead of saving a hidden risk.
    approvalIds.add("local-checkout");
  }
  if (approvalIds.size === 0) {
    return {
      warnings: [],
      runBlockingWarnings: [],
      acknowledgedRisks: input.acknowledgedRisks,
      maxIterations: undefined,
    };
  }
  const warnings = buildAutomationDraftWarnings({
    schedule: input.schedule,
    mode: input.mode,
    runtimeMode: input.runtimeMode,
    worktreeMode: input.worktreeMode,
    hasEphemeralContext: false,
    generatedConfidence: null,
    generatedNeedsConfirmation: false,
    prompt: input.prompt,
  }).filter((warning) => approvalIds.has(warning.id));
  const runBlockingWarnings = warnings.filter((warning) => runBlockingIds.has(warning.id));
  const acknowledgedWarningIds = new Set(warnings.map((warning) => warning.id));
  const required = new Set<AutomationAcknowledgedRiskId>(input.acknowledgedRisks);
  for (const risk of acknowledgedRiskIdsForDraft(warnings, acknowledgedWarningIds)) {
    required.add(risk);
  }
  return {
    warnings,
    runBlockingWarnings,
    acknowledgedRisks: Array.from(required),
    maxIterations,
  };
}

// Approval of an enabled legacy fast loop must also satisfy the server's hard iteration cap.
export function maxIterationsForFastIntervalApproval(input: {
  readonly schedule: AutomationSchedule;
  readonly enabled: boolean;
  readonly maxIterations: number | null;
}): number | undefined {
  if (
    input.enabled &&
    input.schedule.type === "interval" &&
    input.schedule.everySeconds < 60 &&
    (input.maxIterations === null ||
      input.maxIterations > DEFAULT_AUTOMATION_FAST_INTERVAL_MAX_ITERATIONS)
  ) {
    return DEFAULT_AUTOMATION_FAST_INTERVAL_MAX_ITERATIONS;
  }
  return undefined;
}

export function acknowledgedRiskIdsForDraft(
  warnings: readonly AutomationDraftWarning[],
  acknowledgedWarningIds: ReadonlySet<AutomationDraftWarningId>,
) {
  const risks: AutomationAcknowledgedRiskId[] = [];
  for (const warning of warnings) {
    if (!warning.requiresAcknowledgement || !acknowledgedWarningIds.has(warning.id)) {
      continue;
    }
    if (warning.id === "full-access" || warning.id === "local-checkout") {
      risks.push(warning.id);
    } else if (warning.id === "fast-recurring-interval") {
      risks.push("fast-interval");
    }
  }
  return risks;
}

export function warningIdsForAcknowledgedRisks(
  risks: readonly AutomationAcknowledgedRiskId[],
): ReadonlySet<AutomationDraftWarningId> {
  const ids = new Set<AutomationDraftWarningId>();
  for (const risk of risks) {
    ids.add(risk === "fast-interval" ? "fast-recurring-interval" : risk);
  }
  return ids;
}

export function updateAutomationDraftWarningAcknowledgement(
  current: ReadonlySet<AutomationDraftWarningId>,
  warningId: AutomationDraftWarningId,
  acknowledged: boolean,
): ReadonlySet<AutomationDraftWarningId> {
  const next = new Set(current);
  if (acknowledged) {
    next.add(warningId);
  } else {
    next.delete(warningId);
  }
  return next;
}

export function hasBlockingAutomationDraftWarnings(
  warnings: readonly AutomationDraftWarning[],
  acknowledgedWarningIds: ReadonlySet<AutomationDraftWarningId>,
): boolean {
  return warnings.some(
    (warning) =>
      warning.id === "missing-schedule" ||
      (warning.requiresAcknowledgement && !acknowledgedWarningIds.has(warning.id)),
  );
}

// Thread-bound chat creation can accept bounded fast loops without reopening the form.
export function acknowledgedWarningIdsForAutomaticChatAutomation(input: {
  readonly warnings: readonly AutomationDraftWarning[];
  readonly maxIterations: number | null;
  readonly executionScope: ChatAutomationExecutionScope;
}): ReadonlySet<AutomationDraftWarningId> {
  const ids = new Set<AutomationDraftWarningId>();
  if (input.executionScope !== "thread") {
    return ids;
  }
  for (const warning of input.warnings) {
    if (
      warning.id === "fast-recurring-interval" &&
      input.maxIterations !== null &&
      input.maxIterations <= DEFAULT_AUTOMATION_FAST_INTERVAL_MAX_ITERATIONS
    ) {
      ids.add(warning.id);
    }
  }
  return ids;
}

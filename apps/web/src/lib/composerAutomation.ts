// FILE: composerAutomation.ts
// Purpose: Turns composer text into automation decisions and drafts while keeping ChatView thin.
// Layer: Web composer orchestration helper
// Exports: composer automation resolver plus draft builder for ChatView.
// Depends on: automationIntent parsing and automation form helpers.

import { DEFAULT_AUTOMATION_FAST_INTERVAL_MAX_ITERATIONS } from "@synara/contracts";
import type {
  AutomationMode,
  ModelSelection,
  ProjectId,
  ServerAutomationIntentMissingField,
  ServerGenerateAutomationIntentInput,
  ServerGenerateAutomationIntentResult,
  ThreadId,
} from "@synara/contracts";

import {
  applyScheduleToForm,
  formFromDefinition,
  isFormSubmittable,
  type AutomationFormState,
} from "./automationForm";
import { stopWhenFromCompletionPolicy } from "@synara/shared/automationCompletionPolicy";
import { automationRequiresTargetThread } from "@synara/shared/automationMode";
import {
  acknowledgedWarningIdsForAutomaticChatAutomation,
  buildAutomationDraftWarnings,
  hasBlockingAutomationDraftWarnings,
  type AutomationDraftWarning,
  type AutomationDraftWarningId,
} from "./automationDraft";
import {
  detectChatAutomationExecutionScope,
  ensureAutomationConversationScaffold,
  extractChatAutomationInvocation,
  extractPlainChatAutomationCreationInvocation,
  parseChatAutomationInvocation,
  parsePlainChatAutomationInvocation,
  resolveChatAutomationIntent,
  shouldGenerateAutomationIntent,
  type ChatAutomationIntent,
  type ResolvedChatAutomationIntent,
} from "./automationIntent";

type GenerateComposerAutomationIntent = (
  input: ServerGenerateAutomationIntentInput,
) => Promise<ServerGenerateAutomationIntentResult>;

const DEFAULT_GENERATE_INTENT_TIMEOUT_MS = 1_500;

export type ComposerAutomationRequestDecision =
  | { readonly type: "normal-chat" }
  | {
      // The message reads as an automation request but is missing required fields
      // (a task and/or a schedule). ChatView turns this into a conversational
      // follow-up instead of dropping the message: it asks for what's missing and
      // folds the user's next reply back in before re-resolving. `automationMessage`
      // is the cleaned invocation (politeness/creation scaffold stripped) so the
      // accumulated request never re-parses "could you create an automation for me?"
      // scaffolding as task content.
      readonly type: "needs-clarification";
      readonly automationMessage: string;
      readonly missingFields: readonly ServerAutomationIntentMissingField[];
      readonly reason: string | null;
    }
  | {
      readonly type: "automation";
      readonly automationMessage: string;
      readonly resolution: ResolvedChatAutomationIntent;
    };

export interface ComposerAutomationDraftDecision {
  readonly form: AutomationFormState;
  readonly warnings: readonly AutomationDraftWarning[];
  readonly warningContext: {
    readonly hasEphemeralContext: boolean;
    readonly generatedConfidence: number | null;
    readonly generatedNeedsConfirmation: boolean;
  };
  readonly acknowledgedWarningIds: ReadonlySet<AutomationDraftWarningId>;
  readonly needsDraftReview: boolean;
}

// Possessive "for me" filler carries no task content, but once a follow-up answer
// is folded onto the accumulated request it would survive into the parsed prompt
// (e.g. "for me check the build"). Strip it while keeping "please", which can be
// real task content ("say please").
function stripTrailingAutomationFiller(message: string): string {
  return message
    .replace(/[.!?。！？]+\s*$/u, "")
    .replace(/\b(automation|task|job|check|monitor|reminder)\s+for\s+(?:me|myself)\s+/iu, "$1 ")
    .replace(/\b(automazione|task|controllo|monitoraggio)\s+per\s+(?:me|noi)\s+/iu, "$1 ")
    .replace(/\s+(?:for\s+(?:me|myself)|per\s+(?:me|noi))\s*$/iu, "")
    .trim();
}

// Builds the follow-up question shown when an automation request is missing required
// fields. Falls back to asking for a schedule (the dominant missing field) when the
// generator could not report what was missing.
export function automationClarificationPrompt(
  missingFields: readonly ServerAutomationIntentMissingField[],
): string {
  // When the generator could not say what was missing (timeout/failure on a bare
  // request), ask for both task and schedule so setup can still recover instead of
  // looping on a cadence-only question that a bare "create an automation" can't answer.
  const fields: readonly ServerAutomationIntentMissingField[] =
    missingFields.length > 0 ? missingFields : ["taskPrompt", "schedule"];
  const needsTask = fields.includes("taskPrompt");
  const needsSchedule = fields.includes("schedule");
  if (needsTask && needsSchedule) {
    return 'Sure, what should this automation do, and how often should it run? For example: "every weekday at 9am, summarize my open PRs."';
  }
  if (needsTask) {
    // Cadence is already known, so asking for it again risks the user repeating it and
    // leaving a duplicate schedule phrase in the saved task.
    return "What should this automation do? For example: summarize my open PRs, or check the build.";
  }
  if (needsSchedule) {
    return "How often should this automation run? For example: every 6 hours, weekdays at 9am, or daily at 18:00.";
  }
  return "A couple more details: what should this automation do, and how often should it run?";
}

// ─── ENTRY POINT ─────────────────────────────────────────────

async function generateIntentWithTimeout(input: {
  readonly generateIntent: GenerateComposerAutomationIntent;
  readonly request: ServerGenerateAutomationIntentInput;
  readonly timeoutMs: number;
}): Promise<ServerGenerateAutomationIntentResult | null> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      input.generateIntent(input.request).catch(() => null),
      new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => resolve(null), Math.max(0, input.timeoutMs));
      }),
    ]);
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

function isAutoSubmittableBoundedFastLoop(intent: ChatAutomationIntent | null): boolean {
  if (!intent || intent.executionScope !== "thread") {
    return false;
  }
  return (
    intent.schedule.type === "interval" &&
    intent.schedule.everySeconds < 60 &&
    intent.maxIterations !== null &&
    intent.maxIterations <= DEFAULT_AUTOMATION_FAST_INTERVAL_MAX_ITERATIONS
  );
}

// Resolves whether a composer submission should stay chat or become an automation.
export async function resolveComposerAutomationRequest(input: {
  readonly message: string;
  readonly cwd: string;
  readonly nowIso?: string;
  readonly generateIntent: GenerateComposerAutomationIntent;
  readonly generateIntentTimeoutMs?: number;
}): Promise<ComposerAutomationRequestDecision> {
  const trimmed = input.message.trim();
  if (!trimmed) {
    return { type: "normal-chat" };
  }

  const explicitAutomationInvocation = extractChatAutomationInvocation(trimmed);
  const nowIso = input.nowIso ?? new Date().toISOString();
  const plainCreationInvocation =
    explicitAutomationInvocation === null
      ? extractPlainChatAutomationCreationInvocation(trimmed)
      : null;
  const automaticAutomationIntent =
    explicitAutomationInvocation === null
      ? parsePlainChatAutomationInvocation(trimmed, { nowIso })
      : null;
  const automationInvocation =
    explicitAutomationInvocation ?? (automaticAutomationIntent ? trimmed : plainCreationInvocation);
  if (automationInvocation === null) {
    return { type: "normal-chat" };
  }

  const automationMessage = automationInvocation.trim();
  const deterministicAutomationIntent =
    automaticAutomationIntent ??
    parseChatAutomationInvocation(automationInvocation, {
      nowIso,
    });
  const automationExecutionScope =
    deterministicAutomationIntent?.executionScope ??
    detectChatAutomationExecutionScope(automationMessage);
  const automationDefaultMode: AutomationMode =
    automationExecutionScope === "thread" ? "heartbeat" : "standalone";
  const shouldGenerateIntent =
    !isAutoSubmittableBoundedFastLoop(deterministicAutomationIntent) &&
    shouldGenerateAutomationIntent({
      deterministicIntent: deterministicAutomationIntent,
      automationMessage,
    });
  const generatedAutomationIntent = shouldGenerateIntent
    ? await generateIntentWithTimeout({
        generateIntent: input.generateIntent,
        timeoutMs: input.generateIntentTimeoutMs ?? DEFAULT_GENERATE_INTENT_TIMEOUT_MS,
        request: {
          cwd: input.cwd,
          message: automationMessage,
          defaultMode: automationDefaultMode,
          nowIso,
        },
      })
    : null;
  const automationResolution = resolveChatAutomationIntent({
    deterministicIntent: deterministicAutomationIntent,
    generatedIntent: generatedAutomationIntent,
    defaultMode: automationDefaultMode,
    executionScope: automationExecutionScope,
  });
  // The generator defaults an unspecified schedule to "manual", which would otherwise
  // open a manual-automation review dialog for "create an automation to check the build"
  // instead of asking "how often?". When generation reports the schedule as still
  // missing, keep the conversational follow-up rather than accepting that default.
  const generatedScheduleStillMissing =
    automationResolution !== null &&
    automationResolution.source === "generated" &&
    (generatedAutomationIntent?.missingFields.includes("schedule") ?? false) &&
    automationResolution.intent.schedule.type === "manual";
  if (!automationResolution || generatedScheduleStillMissing) {
    return {
      type: "needs-clarification",
      // Strip trailing filler, then guarantee a parseable trigger survives so the next
      // folded reply still resolves as an automation (markers/cadence-only would not).
      automationMessage: ensureAutomationConversationScaffold(
        stripTrailingAutomationFiller(automationMessage),
      ),
      missingFields: generatedAutomationIntent?.missingFields ?? [],
      reason: generatedAutomationIntent?.reason ?? null,
    };
  }

  return {
    type: "automation",
    automationMessage,
    resolution: automationResolution,
  };
}

// Builds the draft form and review state once ChatView has resolved any thread target.
export function buildComposerAutomationDraft(input: {
  readonly resolution: ResolvedChatAutomationIntent;
  readonly projectId: ProjectId;
  readonly projectModelSelection: ModelSelection;
  readonly selectedModelSelection: ModelSelection;
  readonly targetThreadId: ThreadId | null;
  readonly hasEphemeralContext: boolean;
}): ComposerAutomationDraftDecision {
  const { intent: automationIntent, mode: automationMode } = input.resolution;
  const automationStopWhen = stopWhenFromCompletionPolicy(automationIntent.completionPolicy);
  const baseForm = formFromDefinition(null, input.projectId, input.projectModelSelection);
  // Chat-created automations should not inherit live Full access; escalating scheduled
  // runs stays an explicit review step in the automation dialog.
  const nextForm = applyScheduleToForm(
    {
      ...baseForm,
      name: automationIntent.name,
      prompt: automationIntent.prompt,
      projectId: input.projectId,
      modelSelection: input.selectedModelSelection,
      runtimeMode: "approval-required",
      worktreeMode: automationIntent.executionScope === "worktree" ? "worktree" : "auto",
      mode: automationMode,
      targetThreadId:
        automationRequiresTargetThread(automationMode) && input.targetThreadId
          ? input.targetThreadId
          : "",
      maxIterations:
        automationIntent.maxIterations === null ? "" : String(automationIntent.maxIterations),
      // Stop clauses are mode-independent: a standalone or dedicated automation retires
      // itself on the same condition a heartbeat would.
      stopWhen: automationStopWhen,
    },
    automationIntent.schedule,
  );
  const warnings = buildAutomationDraftWarnings({
    schedule: automationIntent.schedule,
    mode: nextForm.mode,
    runtimeMode: nextForm.runtimeMode,
    worktreeMode: nextForm.worktreeMode,
    hasEphemeralContext: input.hasEphemeralContext,
    generatedConfidence: input.resolution.generatedConfidence,
    generatedNeedsConfirmation: input.resolution.generatedNeedsConfirmation,
    prompt: automationIntent.prompt,
  });
  const warningContext = {
    hasEphemeralContext: input.hasEphemeralContext,
    generatedConfidence: input.resolution.generatedConfidence,
    generatedNeedsConfirmation: input.resolution.generatedNeedsConfirmation,
  };
  const acknowledgedWarningIds = acknowledgedWarningIdsForAutomaticChatAutomation({
    warnings,
    maxIterations: automationIntent.maxIterations,
    executionScope: automationIntent.executionScope,
  });
  const needsDraftReview =
    input.resolution.requiresReview ||
    input.resolution.generatedNeedsConfirmation ||
    !isFormSubmittable(nextForm) ||
    hasBlockingAutomationDraftWarnings(warnings, acknowledgedWarningIds);

  return {
    form: nextForm,
    warnings,
    warningContext,
    acknowledgedWarningIds,
    needsDraftReview,
  };
}

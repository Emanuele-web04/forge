// FILE: runResult.ts
// Purpose: Builds and normalizes automation run-history result payloads.
// Layer: Server automation helper
// Exports: summary/reason normalizers plus AI completion-evaluation result builders.
// Depends on: automation run-result contracts shared with the web app.

import type { AutomationRunResult } from "@synara/contracts";

const AUTOMATION_RUN_RESULT_SUMMARY_MAX_CHARS = 2_000;
const AUTOMATION_COMPLETION_REASON_MAX_CHARS = 1_000;

export type AutomationCompletionEvaluation = NonNullable<
  AutomationRunResult["completionEvaluation"]
>;

export function automationRunResultSummary(
  value: string | null | undefined,
  fallback?: string,
): string | null {
  const summary = value ?? fallback ?? null;
  const trimmed = summary?.trim();
  return trimmed ? trimmed.slice(0, AUTOMATION_RUN_RESULT_SUMMARY_MAX_CHARS) : null;
}

export function automationRunResultSummaryWithNotice(
  baseSummary: string | null | undefined,
  notice: string,
): string | null {
  const normalizedBase = baseSummary?.trim();
  if (!normalizedBase) {
    return automationRunResultSummary(notice);
  }
  const separator = "\n\n";
  const availableBaseChars = Math.max(
    0,
    AUTOMATION_RUN_RESULT_SUMMARY_MAX_CHARS - notice.length - separator.length,
  );
  const truncatedBase = normalizedBase.slice(0, availableBaseChars).trimEnd();
  return automationRunResultSummary(`${truncatedBase}${separator}${notice}`);
}

export function normalizeAutomationCompletionReason(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, AUTOMATION_COMPLETION_REASON_MAX_CHARS) : "No reason given.";
}

export function failedAutomationCompletionEvaluation(
  reason: string,
): AutomationCompletionEvaluation {
  return {
    stopMatched: false,
    confidence: 0,
    reason: normalizeAutomationCompletionReason(reason),
  };
}

// Merges a stop-check evaluation into the latest run result without clobbering read/archive state.
export function automationCompletionRunResult(input: {
  readonly baseResult: AutomationRunResult | null;
  readonly evaluation: AutomationCompletionEvaluation;
  readonly matched: boolean;
  readonly summary?: string;
  readonly severity?: NonNullable<AutomationRunResult["severity"]>;
  readonly unread?: boolean;
}): AutomationRunResult {
  const base = input.baseResult ?? {
    outcome: "unknown" as const,
    summary: null,
    unread: true,
    archivedAt: null,
  };

  return {
    ...base,
    outcome: input.matched ? "no-findings" : base.outcome,
    summary: input.matched
      ? automationRunResultSummary(`Stopped: ${input.evaluation.reason}`)
      : input.summary !== undefined
        ? automationRunResultSummary(input.summary)
        : automationRunResultSummary(input.evaluation.reason),
    severity: input.matched ? "info" : (input.severity ?? base.severity),
    unread: input.unread ?? base.unread,
    completionEvaluation: input.evaluation,
  };
}

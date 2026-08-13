// FILE: automationDraft.test.ts
// Purpose: Locks down automation creation draft warnings.
// Layer: Web lib test
// Depends on: automationDraft warning helpers.

import { describe, expect, it } from "vitest";

import {
  acknowledgedWarningIdsForAutomaticChatAutomation,
  acknowledgedRiskIdsForDraft,
  automationApprovalGaps,
  buildAutomationDraftWarnings,
  hasBlockingAutomationDraftWarnings,
  maxIterationsForFastIntervalApproval,
  updateAutomationDraftWarningAcknowledgement,
  warningIdsForAcknowledgedRisks,
  type AutomationDraftWarningId,
} from "./automationDraft";

describe("automation draft warnings", () => {
  it("surfaces skill references and standalone worktree cleanup risk", () => {
    const warnings = buildAutomationDraftWarnings({
      schedule: { type: "interval", everySeconds: 300 },
      mode: "standalone",
      runtimeMode: "approval-required",
      worktreeMode: "worktree",
      hasEphemeralContext: false,
      generatedConfidence: null,
      generatedNeedsConfirmation: false,
      prompt: "Use $sentry to inspect crashes.",
    });

    expect(warnings.map((warning) => warning.id)).toEqual(["worktree-cleanup", "skill-reference"]);
  });

  it("blocks direct submission when composer context is not persisted", () => {
    const warnings = buildAutomationDraftWarnings({
      schedule: { type: "interval", everySeconds: 300 },
      mode: "heartbeat",
      runtimeMode: "approval-required",
      worktreeMode: "auto",
      hasEphemeralContext: true,
      generatedConfidence: null,
      generatedNeedsConfirmation: false,
      prompt: "Check the Linear issue.",
    });

    expect(warnings).toMatchObject([
      {
        id: "attachments-not-persisted",
        requiresAcknowledgement: true,
      },
    ]);
    expect(warnings[0]?.detail).toContain("provider mentions");
    expect(hasBlockingAutomationDraftWarnings(warnings, new Set())).toBe(true);
  });

  it("requires acknowledgement for standalone auto fallback to local checkout", () => {
    const warnings = buildAutomationDraftWarnings({
      schedule: { type: "interval", everySeconds: 300 },
      mode: "standalone",
      runtimeMode: "approval-required",
      worktreeMode: "auto",
      hasEphemeralContext: false,
      generatedConfidence: null,
      generatedNeedsConfirmation: false,
      prompt: "Check stale dependencies.",
    });

    expect(warnings).toMatchObject([
      {
        id: "local-checkout",
        requiresAcknowledgement: true,
      },
      {
        id: "worktree-cleanup",
        requiresAcknowledgement: false,
      },
    ]);
    expect(acknowledgedRiskIdsForDraft(warnings, new Set(["local-checkout"]))).toEqual([
      "local-checkout",
    ]);
  });

  it("maps acknowledged blocking warnings into persisted risk ids", () => {
    const warnings = buildAutomationDraftWarnings({
      schedule: { type: "interval", everySeconds: 30 },
      mode: "standalone",
      runtimeMode: "full-access",
      worktreeMode: "local",
      hasEphemeralContext: false,
      generatedConfidence: null,
      generatedNeedsConfirmation: false,
      prompt: "Fix flaky tests.",
    });

    expect(
      acknowledgedRiskIdsForDraft(
        warnings,
        new Set(["fast-recurring-interval", "full-access", "local-checkout"]),
      ),
    ).toEqual(["fast-interval", "full-access", "local-checkout"]);
  });

  it("maps persisted risk ids back to warning acknowledgements", () => {
    expect(
      Array.from(
        warningIdsForAcknowledgedRisks(["fast-interval", "full-access", "local-checkout"]),
      ),
    ).toEqual(["fast-recurring-interval", "full-access", "local-checkout"]);
  });

  it("immutably updates warning acknowledgements", () => {
    const initial = new Set<AutomationDraftWarningId>(["full-access"]);
    const added = updateAutomationDraftWarningAcknowledgement(initial, "local-checkout", true);
    const removed = updateAutomationDraftWarningAcknowledgement(added, "full-access", false);

    expect(Array.from(initial)).toEqual(["full-access"]);
    expect(Array.from(added)).toEqual(["full-access", "local-checkout"]);
    expect(Array.from(removed)).toEqual(["local-checkout"]);
  });

  it("blocks submission until required warning acknowledgements are present", () => {
    const warnings = buildAutomationDraftWarnings({
      schedule: { type: "interval", everySeconds: 30 },
      mode: "standalone",
      runtimeMode: "full-access",
      worktreeMode: "local",
      hasEphemeralContext: false,
      generatedConfidence: null,
      generatedNeedsConfirmation: false,
      prompt: "Fix flaky tests.",
    });

    expect(hasBlockingAutomationDraftWarnings(warnings, new Set())).toBe(true);
    expect(
      hasBlockingAutomationDraftWarnings(
        warnings,
        new Set(["fast-recurring-interval", "full-access", "local-checkout"]),
      ),
    ).toBe(false);
  });

  it("auto-acknowledges bounded thread fast loops without hiding standalone risks", () => {
    const threadWarnings = buildAutomationDraftWarnings({
      schedule: { type: "interval", everySeconds: 15 },
      mode: "heartbeat",
      runtimeMode: "approval-required",
      worktreeMode: "auto",
      hasEphemeralContext: false,
      generatedConfidence: null,
      generatedNeedsConfirmation: false,
      prompt: "Say hi.",
    });

    const boundedIds = acknowledgedWarningIdsForAutomaticChatAutomation({
      warnings: threadWarnings,
      maxIterations: 3,
      executionScope: "thread",
    });
    expect(Array.from(boundedIds)).toEqual(["fast-recurring-interval"]);
    expect(hasBlockingAutomationDraftWarnings(threadWarnings, boundedIds)).toBe(false);
    expect(acknowledgedRiskIdsForDraft(threadWarnings, boundedIds)).toEqual(["fast-interval"]);

    const unboundedIds = acknowledgedWarningIdsForAutomaticChatAutomation({
      warnings: threadWarnings,
      maxIterations: null,
      executionScope: "thread",
    });
    expect(Array.from(unboundedIds)).toEqual([]);
    expect(hasBlockingAutomationDraftWarnings(threadWarnings, unboundedIds)).toBe(true);

    const standaloneWarnings = buildAutomationDraftWarnings({
      schedule: { type: "interval", everySeconds: 15 },
      mode: "standalone",
      runtimeMode: "approval-required",
      worktreeMode: "auto",
      hasEphemeralContext: false,
      generatedConfidence: null,
      generatedNeedsConfirmation: false,
      prompt: "Say hi.",
    });
    const standaloneIds = acknowledgedWarningIdsForAutomaticChatAutomation({
      warnings: standaloneWarnings,
      maxIterations: 3,
      executionScope: "standalone",
    });
    expect(Array.from(standaloneIds)).toEqual([]);
    expect(hasBlockingAutomationDraftWarnings(standaloneWarnings, standaloneIds)).toBe(true);
  });

  it("mentions a manual schedule without blocking submission", () => {
    const warnings = buildAutomationDraftWarnings({
      schedule: { type: "manual" },
      mode: "standalone",
      runtimeMode: "approval-required",
      worktreeMode: "worktree",
      hasEphemeralContext: false,
      generatedConfidence: null,
      generatedNeedsConfirmation: false,
      prompt: "Summarize open reviews.",
    });

    expect(warnings).toMatchObject([
      {
        id: "missing-schedule",
        title: "Manual runs only",
        detail: "This automation only runs when you press Run now.",
        requiresAcknowledgement: false,
      },
      { id: "worktree-cleanup", requiresAcknowledgement: false },
    ]);
    expect(hasBlockingAutomationDraftWarnings(warnings, new Set())).toBe(false);
  });

  it("does not show worktree cleanup risk for heartbeat runs", () => {
    const warnings = buildAutomationDraftWarnings({
      schedule: { type: "interval", everySeconds: 300 },
      mode: "heartbeat",
      runtimeMode: "approval-required",
      worktreeMode: "auto",
      hasEphemeralContext: false,
      generatedConfidence: null,
      generatedNeedsConfirmation: false,
      prompt: "Check this thread.",
    });

    expect(warnings.map((warning) => warning.id)).not.toContain("local-checkout");
    expect(warnings.map((warning) => warning.id)).not.toContain("worktree-cleanup");
  });
});

describe("automationApprovalGaps", () => {
  const base = {
    schedule: { type: "daily" as const, timeOfDay: "09:00" },
    enabled: true,
    maxIterations: null,
    mode: "standalone" as const,
    runtimeMode: "approval-required" as const,
    worktreeMode: "worktree" as const,
    prompt: "Check the build.",
  };

  it("requires full-access approval when unacknowledged", () => {
    const gaps = automationApprovalGaps({
      ...base,
      runtimeMode: "full-access",
      acknowledgedRisks: [],
    });
    expect(gaps.warnings.map((warning) => warning.id)).toEqual(["full-access"]);
    expect(gaps.runBlockingWarnings.map((warning) => warning.id)).toEqual(["full-access"]);
    expect(gaps.acknowledgedRisks).toEqual(["full-access"]);
  });

  it("requires local-checkout approval for a local worktree", () => {
    const gaps = automationApprovalGaps({
      ...base,
      worktreeMode: "local",
      acknowledgedRisks: [],
    });
    expect(gaps.warnings.map((warning) => warning.id)).toEqual(["local-checkout"]);
    expect(gaps.runBlockingWarnings.map((warning) => warning.id)).toEqual(["local-checkout"]);
    expect(gaps.acknowledgedRisks).toEqual(["local-checkout"]);
  });

  it("reports both blocking risks together", () => {
    const gaps = automationApprovalGaps({
      ...base,
      runtimeMode: "full-access",
      worktreeMode: "local",
      acknowledgedRisks: [],
    });
    expect(new Set(gaps.warnings.map((warning) => warning.id))).toEqual(
      new Set(["full-access", "local-checkout"]),
    );
    expect(new Set(gaps.runBlockingWarnings.map((warning) => warning.id))).toEqual(
      new Set(["full-access", "local-checkout"]),
    );
    expect(new Set(gaps.acknowledgedRisks)).toEqual(new Set(["full-access", "local-checkout"]));
  });

  it("clears the banner once the risks are acknowledged", () => {
    const gaps = automationApprovalGaps({
      ...base,
      runtimeMode: "full-access",
      worktreeMode: "local",
      acknowledgedRisks: ["full-access", "local-checkout"],
    });
    expect(gaps.warnings).toEqual([]);
    expect(gaps.runBlockingWarnings).toEqual([]);
    expect(new Set(gaps.acknowledgedRisks)).toEqual(new Set(["full-access", "local-checkout"]));
  });

  it("needs no approval for an approval-required worktree automation", () => {
    const gaps = automationApprovalGaps({ ...base, acknowledgedRisks: [] });
    expect(gaps.warnings).toEqual([]);
    expect(gaps.runBlockingWarnings).toEqual([]);
    expect(gaps.acknowledgedRisks).toEqual([]);
  });

  it("shows local-checkout approval for heartbeat updates without blocking the run", () => {
    // Heartbeat reuses the target thread (no local env), so local-checkout never blocks
    // dispatch. It is still surfaced so automation.update accepts a local heartbeat.
    const gaps = automationApprovalGaps({
      ...base,
      runtimeMode: "full-access",
      worktreeMode: "local",
      mode: "heartbeat",
      acknowledgedRisks: [],
    });
    expect(new Set(gaps.warnings.map((warning) => warning.id))).toEqual(
      new Set(["full-access", "local-checkout"]),
    );
    expect(gaps.runBlockingWarnings.map((warning) => warning.id)).toEqual(["full-access"]);
    expect(new Set(gaps.acknowledgedRisks)).toEqual(new Set(["full-access", "local-checkout"]));
  });

  it("keeps an approval path for an approval-required local heartbeat", () => {
    const gaps = automationApprovalGaps({
      ...base,
      worktreeMode: "local",
      mode: "heartbeat",
      acknowledgedRisks: [],
    });
    expect(gaps.warnings.map((warning) => warning.id)).toEqual(["local-checkout"]);
    expect(gaps.runBlockingWarnings).toEqual([]);
    expect(gaps.acknowledgedRisks).toEqual(["local-checkout"]);
  });

  it("does not block an auto worktree but covers its fallback on approve", () => {
    // worktreeMode "auto" is not a definite blocker, so Run now is blocked only by
    // full-access. The banner still shows the local-checkout fallback risk that approval saves.
    const gaps = automationApprovalGaps({
      ...base,
      runtimeMode: "full-access",
      worktreeMode: "auto",
      mode: "standalone",
      acknowledgedRisks: [],
    });
    expect(new Set(gaps.warnings.map((warning) => warning.id))).toEqual(
      new Set(["full-access", "local-checkout"]),
    );
    expect(gaps.runBlockingWarnings.map((warning) => warning.id)).toEqual(["full-access"]);
    expect(new Set(gaps.acknowledgedRisks)).toEqual(new Set(["full-access", "local-checkout"]));
  });

  it("needs no approval for an approval-required auto automation", () => {
    const gaps = automationApprovalGaps({
      ...base,
      worktreeMode: "auto",
      mode: "standalone",
      acknowledgedRisks: [],
    });
    expect(gaps.warnings).toEqual([]);
    expect(gaps.runBlockingWarnings).toEqual([]);
    expect(gaps.acknowledgedRisks).toEqual([]);
  });

  it("surfaces and persists the fast-loop risk when approving for another blocker", () => {
    // fast-interval never blocks a run on its own, but when the banner is already shown for a
    // run blocker, approving also persists fast-interval (or automation.update would reject
    // the sub-minute schedule). It is therefore surfaced too, so consent is transparent.
    const gaps = automationApprovalGaps({
      ...base,
      schedule: { type: "interval", everySeconds: 15 },
      runtimeMode: "full-access",
      acknowledgedRisks: [],
    });
    expect(new Set(gaps.warnings.map((warning) => warning.id))).toEqual(
      new Set(["full-access", "fast-recurring-interval"]),
    );
    expect(gaps.runBlockingWarnings.map((warning) => warning.id)).toEqual(["full-access"]);
    expect(new Set(gaps.acknowledgedRisks)).toEqual(new Set(["full-access", "fast-interval"]));
    expect(gaps.maxIterations).toBe(10);
  });

  it("surfaces fast-loop approval for imported definitions without blocking run now", () => {
    const gaps = automationApprovalGaps({
      ...base,
      schedule: { type: "interval", everySeconds: 15 },
      acknowledgedRisks: [],
    });
    expect(gaps.warnings.map((warning) => warning.id)).toEqual(["fast-recurring-interval"]);
    expect(gaps.runBlockingWarnings).toEqual([]);
    expect(gaps.acknowledgedRisks).toEqual(["fast-interval"]);
    expect(gaps.maxIterations).toBe(10);
  });

  it("surfaces a cap-only fast-loop repair for legacy acknowledged definitions", () => {
    const gaps = automationApprovalGaps({
      ...base,
      schedule: { type: "interval", everySeconds: 15 },
      maxIterations: 25,
      acknowledgedRisks: ["fast-interval"],
    });
    expect(gaps.warnings.map((warning) => warning.id)).toEqual(["fast-recurring-interval"]);
    expect(gaps.runBlockingWarnings).toEqual([]);
    expect(gaps.acknowledgedRisks).toEqual(["fast-interval"]);
    expect(gaps.maxIterations).toBe(10);
  });

  it("keeps an existing compliant fast interval cap", () => {
    const gaps = automationApprovalGaps({
      ...base,
      schedule: { type: "interval", everySeconds: 15 },
      runtimeMode: "full-access",
      acknowledgedRisks: [],
      maxIterations: 3,
    });
    expect(gaps.maxIterations).toBeUndefined();
  });

  it("does not show a cap-only repair for paused legacy fast loops", () => {
    const gaps = automationApprovalGaps({
      ...base,
      schedule: { type: "interval", everySeconds: 15 },
      enabled: false,
      acknowledgedRisks: ["fast-interval"],
    });
    expect(gaps.warnings).toEqual([]);
    expect(gaps.runBlockingWarnings).toEqual([]);
    expect(gaps.acknowledgedRisks).toEqual(["fast-interval"]);
    expect(gaps.maxIterations).toBeUndefined();
  });
});

describe("maxIterationsForFastIntervalApproval", () => {
  it("caps enabled imported fast loops without a max iteration limit", () => {
    expect(
      maxIterationsForFastIntervalApproval({
        schedule: { type: "interval", everySeconds: 15 },
        enabled: true,
        maxIterations: null,
      }),
    ).toBe(10);
  });

  it("caps enabled imported fast loops above the server cap", () => {
    expect(
      maxIterationsForFastIntervalApproval({
        schedule: { type: "interval", everySeconds: 15 },
        enabled: true,
        maxIterations: 25,
      }),
    ).toBe(10);
  });

  it("leaves already-bounded fast loops unchanged", () => {
    expect(
      maxIterationsForFastIntervalApproval({
        schedule: { type: "interval", everySeconds: 15 },
        enabled: true,
        maxIterations: 3,
      }),
    ).toBeUndefined();
  });

  it("does not cap disabled legacy fast loops during approval", () => {
    expect(
      maxIterationsForFastIntervalApproval({
        schedule: { type: "interval", everySeconds: 15 },
        enabled: false,
        maxIterations: null,
      }),
    ).toBeUndefined();
  });
});

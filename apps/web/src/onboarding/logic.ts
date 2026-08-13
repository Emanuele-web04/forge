export const ONBOARDING_STEPS = ["welcome", "providers", "projects", "threads", "done"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export function nextOnboardingStep(step: OnboardingStep): OnboardingStep {
  const index = ONBOARDING_STEPS.indexOf(step);
  return ONBOARDING_STEPS[Math.min(index + 1, ONBOARDING_STEPS.length - 1)] ?? "done";
}

export function previousOnboardingStep(step: OnboardingStep): OnboardingStep {
  const index = ONBOARDING_STEPS.indexOf(step);
  return ONBOARDING_STEPS[Math.max(index - 1, 0)] ?? "welcome";
}

export type OnboardingGate = "pending" | "show" | "hidden";

export interface OnboardingGateInputs {
  readonly threadsHydrated: boolean;
  readonly settingsSettled: boolean;
  readonly settingsAvailable: boolean;
  readonly projectCount: number;
  readonly serverCompletedAt: string | null;
  readonly localCompletedAt: string | null;
}

export function resolveOnboardingGate(input: OnboardingGateInputs): OnboardingGate {
  if (!input.threadsHydrated || !input.settingsSettled) {
    return "pending";
  }
  const alreadyCompleted = input.settingsAvailable
    ? input.serverCompletedAt !== null
    : input.localCompletedAt !== null;
  return !alreadyCompleted && input.projectCount === 0 ? "show" : "hidden";
}

export function defaultCandidateSelection(
  candidates: ReadonlyArray<{
    readonly workspaceRoot: string;
    readonly existingProjectId: string | null;
  }>,
): ReadonlySet<string> {
  return new Set(
    candidates
      .filter((candidate) => candidate.existingProjectId === null)
      .map((candidate) => candidate.workspaceRoot),
  );
}

export function toggleSelection(selection: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(selection);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

export interface OnboardingThreadImportResult {
  readonly sessionId: string;
  readonly status: "imported" | "failed";
  readonly message?: string;
}

export function summarizeThreadImports(results: ReadonlyArray<OnboardingThreadImportResult>): {
  imported: number;
  failed: number;
} {
  return {
    imported: results.filter((result) => result.status === "imported").length,
    failed: results.filter((result) => result.status === "failed").length,
  };
}

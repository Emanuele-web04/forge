// FILE: logic.ts
// Purpose: Pure step, gate, and provider-classification rules for the first-run welcome tour.
// Layer: Web domain helper (no React, no I/O)
// Exports: ONBOARDING_STEPS, nextOnboardingStep, previousOnboardingStep, resolveOnboardingGate,
//          resolveOnboardingCompletionToReconcile, classifyProviderSetup, summarizeProviderSetup,
//          toggleSelection

import type { ProviderKind, ServerProviderStatus } from "@synara/contracts";

export const ONBOARDING_STEPS = [
  "welcome",
  "tour",
  "providers",
  "theme",
  "project",
  "done",
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export function nextOnboardingStep(step: OnboardingStep): OnboardingStep {
  const index = ONBOARDING_STEPS.indexOf(step);
  return ONBOARDING_STEPS[Math.min(index + 1, ONBOARDING_STEPS.length - 1)] ?? "done";
}

export function previousOnboardingStep(step: OnboardingStep): OnboardingStep {
  const index = ONBOARDING_STEPS.indexOf(step);
  return ONBOARDING_STEPS[Math.max(index - 1, 0)] ?? "welcome";
}

/** Steps where the user has started making setup choices; the tour must not auto-close past here. */
export function isOnboardingSetupStep(step: OnboardingStep): boolean {
  return step !== "welcome" && step !== "tour";
}

export type OnboardingGate = "pending" | "show" | "hidden";

export interface OnboardingGateInputs {
  /** Local project state has been hydrated from the server at least once. */
  readonly threadsHydrated: boolean;
  /** The server settings query has settled (success or error). */
  readonly settingsSettled: boolean;
  /** Count of ordinary (non-container) projects. */
  readonly projectCount: number;
  readonly serverCompletedAt: string | null;
  readonly localCompletedAt: string | null;
}

/**
 * The tour shows on a fresh install (no ordinary projects) that has not recorded
 * completion anywhere. Either marker counts: the server one is durable across browser
 * profiles, the local one covers a completion whose server write failed and is
 * reconciled back to the server on the next launch (see
 * `resolveOnboardingCompletionToReconcile`).
 *
 * The result is *not* authoritative until the inputs are: callers re-evaluate as
 * snapshots and settings arrive instead of latching the first non-pending answer.
 */
export function resolveOnboardingGate(input: OnboardingGateInputs): OnboardingGate {
  if (!input.threadsHydrated || !input.settingsSettled) {
    return "pending";
  }
  const completed = input.serverCompletedAt !== null || input.localCompletedAt !== null;
  return !completed && input.projectCount === 0 ? "show" : "hidden";
}

export interface OnboardingReconcileInputs {
  readonly threadsHydrated: boolean;
  /** Server settings are readable, so a null marker is a real absence, not a fetch error. */
  readonly settingsAvailable: boolean;
  readonly projectCount: number;
  readonly serverCompletedAt: string | null;
  readonly localCompletedAt: string | null;
  /** ISO timestamp used when an existing install is exempted without a local marker. */
  readonly now: string;
}

/**
 * Returns the completion timestamp to write to the server, or null when nothing is owed.
 * Two cases need the marker persisted after the fact:
 * - a completion whose server write failed (only the local marker exists), and
 * - an installation that predates the tour (projects exist, no marker anywhere), which
 *   must never see the "first run" tour just because its last project is later removed.
 */
export function resolveOnboardingCompletionToReconcile(
  input: OnboardingReconcileInputs,
): string | null {
  if (!input.threadsHydrated || !input.settingsAvailable || input.serverCompletedAt !== null) {
    return null;
  }
  if (input.localCompletedAt !== null) {
    return input.localCompletedAt;
  }
  return input.projectCount > 0 ? input.now : null;
}

export type ProviderSetupState = "connected" | "needs-sign-in" | "not-installed" | "disabled";

export function classifyProviderSetup(input: {
  readonly status: Pick<ServerProviderStatus, "available" | "authStatus"> | null | undefined;
  readonly disabled: boolean;
}): ProviderSetupState {
  if (input.disabled) return "disabled";
  if (!input.status || !input.status.available) return "not-installed";
  // Providers whose auth is not probed report "unknown"; treat a detected binary as
  // usable rather than nagging for a sign-in Synara cannot verify.
  return input.status.authStatus === "unauthenticated" ? "needs-sign-in" : "connected";
}

export interface ProviderSetupSummary {
  readonly enabled: number;
  readonly connected: number;
  readonly needsSignIn: number;
  readonly notInstalled: number;
}

export function summarizeProviderSetup(
  states: ReadonlyArray<{ readonly provider: ProviderKind; readonly state: ProviderSetupState }>,
): ProviderSetupSummary {
  let enabled = 0;
  let connected = 0;
  let needsSignIn = 0;
  let notInstalled = 0;
  for (const entry of states) {
    if (entry.state !== "disabled") enabled += 1;
    if (entry.state === "connected") connected += 1;
    if (entry.state === "needs-sign-in") needsSignIn += 1;
    if (entry.state === "not-installed") notInstalled += 1;
  }
  return { enabled, connected, needsSignIn, notInstalled };
}

export function toggleSelection<T>(selection: ReadonlySet<T>, id: T): ReadonlySet<T> {
  const next = new Set(selection);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

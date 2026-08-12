// FILE: automationMode.ts
// Purpose: Single source for what an AutomationMode implies about thread ownership.
// Layer: Shared runtime utility (server dispatch/scheduling + web forms)
// Exports: mode predicates and the continuation-thread resolver.
// Depends on: automation contracts shared with the native API.
//
// Mode answers exactly one question: where does a run execute?
//   standalone -> a fresh thread per run
//   heartbeat  -> a thread the user chose and still owns
//   dedicated  -> a thread the automation created for itself and reuses
// "heartbeat" and "dedicated" therefore share every continuation rule (idle gating,
// deferral, retention protection); they differ only in who chose the thread. Branch on
// these predicates instead of comparing the mode literal, so adding a mode cannot leave
// one dispatch site behind.

import type { AutomationMode, ThreadCreationSource, ThreadId } from "@synara/contracts";

/** Runs append a turn to a thread that already exists instead of creating one. */
export function automationContinuesThread(mode: AutomationMode): boolean {
  return mode === "heartbeat" || mode === "dedicated";
}

/** The automation created its continuation thread and is its only writer. */
export function automationOwnsItsThread(mode: AutomationMode): boolean {
  return mode === "dedicated";
}

/** The continuation thread must be supplied by the caller before the first run. */
export function automationRequiresTargetThread(mode: AutomationMode): boolean {
  return mode === "heartbeat";
}

/**
 * The thread this automation's next run continues, or null when the run must create
 * one. Dedicated automations return null exactly once — before their first run has
 * created and claimed the thread they reuse from then on.
 */
export function automationContinuationThreadId(definition: {
  readonly mode: AutomationMode;
  readonly targetThreadId: ThreadId | null;
}): ThreadId | null {
  return automationContinuesThread(definition.mode) ? definition.targetThreadId : null;
}

/**
 * The thread is a per-run artifact a standalone automation created, not a conversation the
 * user started. Dedicated/heartbeat continuation threads are never marked (see the
 * ThreadCreationSource contract), so this stays false for them.
 */
export function isAutomationRunThread(thread: {
  readonly creationSource?: ThreadCreationSource | null;
}): boolean {
  return thread.creationSource === "automation_run";
}

// FILE: environmentAutomationOwnership.ts
// Purpose: Resolve which host owns an automation or one of its runs, so
//          automation commands reach the server that actually holds it.
// Layer: Web transport routing
// Exports: recordAutomationOwnership, forgetEnvironmentAutomationOwnership,
//          automationProjectId, runProjectId, resetAutomationOwnershipForTests
//
// WHY THIS IS NOT POSITIONAL LIKE THREADS, PROJECTS AND SPACES
//
// Those live in the environment store, so ownership is a scan of the records
// that already hold them. Automations do not: they are fetched per-query
// (`automation.list`) and never enter `environmentById`, so there is no record
// to scan and nothing to be positional about.
//
// What every automation and run DOES carry is its `projectId`, and projects
// are positional. So ownership is derived rather than stored: id -> projectId
// here, projectId -> environment through the existing store lookup. That keeps
// exactly one source of truth for which host owns what, and means a project
// moving hosts cannot leave an automation pointing at the old one.
//
// THE GAP THIS CLOSES: `automation.runNow`, `cancelRun`, `delete`, `getMemory`,
// `resolveProposal`, `markRunRead` and `archiveRun` carry only an automationId
// or runId — invisible to the thread, project and cwd keys the router had. But
// `create` and `update` carry projectId and WERE routed, so a user could create
// an automation on a remote host and then run, cancel or delete it against the
// LOCAL server, which does not have it.

import type { AutomationId, AutomationRunId, ProjectId } from "@synara/contracts";

/**
 * id -> owning project, learned from whatever the app has already fetched.
 *
 * Deliberately a cache of observations rather than an authority: an id nobody
 * has listed resolves to `null`, and the caller falls back to local — the same
 * answer as before this existed, so an unknown id is never worse than it was.
 */
const projectIdByAutomationId = new Map<string, ProjectId>();
const projectIdByRunId = new Map<string, ProjectId>();

/** Records what a listing told us about automations and their runs. */
export function recordAutomationOwnership(input: {
  readonly automations?: ReadonlyArray<{
    readonly id: AutomationId;
    readonly projectId: ProjectId;
  }>;
  readonly runs?: ReadonlyArray<{
    readonly id: AutomationRunId;
    readonly automationId: AutomationId;
    readonly projectId: ProjectId;
  }>;
}): void {
  for (const automation of input.automations ?? []) {
    projectIdByAutomationId.set(automation.id, automation.projectId);
  }
  for (const run of input.runs ?? []) {
    projectIdByRunId.set(run.id, run.projectId);
    // A run names its automation too, so listing runs alone still teaches us
    // the automation's owner.
    projectIdByAutomationId.set(run.automationId, run.projectId);
  }
}

/**
 * Drops everything learned from an environment that has gone away.
 *
 * Takes the projects that environment owned, because the index is keyed by
 * project rather than by environment — the same reason ownership is derived
 * rather than stored. Retaining these would let a disconnected host's ids keep
 * resolving to a project that is no longer reachable.
 */
export function forgetEnvironmentAutomationOwnership(projectIds: ReadonlySet<string>): void {
  // Snapshotted because both loops DELETE from the map they walk. Lint calls
  // the spread unnecessary; removing it skips entries, which here would leave a
  // departed host's ids still resolving.
  for (const [automationId, projectId] of [...projectIdByAutomationId]) {
    if (projectIds.has(projectId)) projectIdByAutomationId.delete(automationId);
  }
  for (const [runId, projectId] of [...projectIdByRunId]) {
    if (projectIds.has(projectId)) projectIdByRunId.delete(runId);
  }
}

/** The project owning `automationId`, or `null` when nothing has reported it. */
export function automationProjectId(automationId: string): ProjectId | null {
  return projectIdByAutomationId.get(automationId) ?? null;
}

/** The project owning `runId`, or `null` when nothing has reported it. */
export function runProjectId(runId: string): ProjectId | null {
  return projectIdByRunId.get(runId) ?? null;
}

/** Test seam; production never clears the whole index at once. */
export function resetAutomationOwnershipForTests(): void {
  projectIdByAutomationId.clear();
  projectIdByRunId.clear();
}

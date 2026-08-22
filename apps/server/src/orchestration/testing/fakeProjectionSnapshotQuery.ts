// FILE: fakeProjectionSnapshotQuery.ts
// Purpose: Shared test fake for the ProjectionSnapshotQuery service — every read dies
//          unless the test opts into it, so a test only declares the reads it exercises.
// Layer: Server test utility (imported by *.test.ts only; never by production code)
// Note: centralizing the shape keeps unrelated suites from breaking whenever the
//       service grows a new read.

import { Effect } from "effect";

import type { ProjectionSnapshotQueryShape } from "../Services/ProjectionSnapshotQuery.ts";

/**
 * Build a ProjectionSnapshotQuery fake whose reads all die with `unused`, except
 * the ones the caller overrides. Dying (rather than returning empty results)
 * keeps an unexpected read a loud test failure instead of silent nonsense.
 */
export function fakeProjectionSnapshotQuery(
  overrides: Partial<ProjectionSnapshotQueryShape> = {},
): ProjectionSnapshotQueryShape {
  const unused = (): never => Effect.die("unused") as never;
  return {
    getCommandReadModel: unused,
    getSnapshot: unused,
    getCounts: unused,
    getSnapshotSequence: unused,
    listStaleInFlightThreadIds: unused,
    listManagedWorktreeThreads: unused,
    getShellSnapshot: unused,
    getActiveProjectByWorkspaceRoot: unused,
    getProjectShellById: unused,
    getSpaceShellById: unused,
    getFirstActiveThreadIdByProjectId: unused,
    getThreadCheckpointContext: unused,
    listGeneratedImageActivitiesByTurn: unused,
    getFullThreadDiffContext: unused,
    getThreadShellById: unused,
    threadIdExistsIncludingDeleted: unused,
    findSyntheticSubagentParentThread: unused,
    getThreadDetailById: unused,
    getThreadDetailForExportById: unused,
    getThreadDetailSnapshotById: unused,
    ...overrides,
  };
}

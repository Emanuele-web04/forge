import {
  CheckpointRef,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationPendingInteraction,
  OrchestrationCheckpointFile,
  OrchestrationProjectShell,
  OrchestrationSpaceShell,
  OrchestrationProposedPlanId,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadPullRequest,
  ThreadPinnedMessages,
  ThreadMarkers,
  ProjectScript,
  ProjectId,
  ProjectKind,
  SpaceId,
  STUDIO_OUTPUTS_ACTIVITY_KIND,
  ThreadId,
  ThreadEnvironmentMode,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationProposedPlan,
  type OrchestrationProject,
  type OrchestrationSession,
  OrchestrationThread,
  type OrchestrationThreadShell,
  type OrchestrationThreadActivity,
  ThreadHandoff,
  ModelSelection,
} from "@synara/contracts";
import { Effect, Layer, Option, Schema, Struct } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  isPersistenceError,
  toPersistenceDecodeError,
  toPersistenceSqlOrDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import { normalizePersistedModelSelection } from "../../persistence/modelSelectionCompatibility.ts";
import { deriveThreadSummaryMetadata } from "@synara/shared/threadSummary";
import { ProjectionCheckpoint } from "../../persistence/Services/ProjectionCheckpoints.ts";
import { ProjectionProject } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionSpace } from "../../persistence/Services/ProjectionSpaces.ts";
import { ProjectionState } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import {
  ProjectionThreadMessageDbRowSchema,
  orchestrationMessageFromProjectionRow,
  type ProjectionThreadMessageDbRow,
} from "../../persistence/projectionThreadMessageRow.ts";
import { ProjectionThreadProposedPlan } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSession } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThread } from "../../persistence/Services/ProjectionThreads.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionFullThreadDiffContext,
  type ProjectionGeneratedImageActivityRecord,
  type ProjectionManagedWorktreeThread,
  type ProjectionSnapshotCounts,
  type ProjectionSnapshotSequence,
  type ProjectionThreadCheckpointContext,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";

const decodeReadModel = Schema.decodeUnknownEffect(OrchestrationReadModel);
const decodeShellSnapshot = Schema.decodeUnknownEffect(OrchestrationShellSnapshot);
const decodeThreadDetail = Schema.decodeUnknownEffect(OrchestrationThread);
const decodeThreadDetailSnapshot = Schema.decodeUnknownEffect(OrchestrationThreadDetailSnapshot);
const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);
const ModelSelectionJsonUnknown = Schema.fromJsonString(Schema.Unknown);
const MAX_THREAD_MESSAGES = 2_000;
const MAX_THREAD_ACTIVITIES = 500;
const MAX_THREAD_FILE_CHANGE_ACTIVITIES = 2_000;
const MAX_TURN_GENERATED_IMAGE_ACTIVITY_RECORDS = 64;
const ProjectionProjectDbRowSchema = ProjectionProject.mapFields(
  Struct.assign({
    defaultModelSelection: Schema.NullOr(ModelSelectionJsonUnknown),
    scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
    isPinned: Schema.Number,
  }),
);
const ProjectionThreadProposedPlanDbRowSchema = ProjectionThreadProposedPlan;
const ProjectionThreadDbRowSchema = ProjectionThread.mapFields(
  Struct.assign({
    createBranchFlowCompleted: Schema.Number,
    isPinned: Schema.Number,
    handoff: Schema.NullOr(Schema.fromJsonString(ThreadHandoff)),
    lastKnownPr: Schema.NullOr(Schema.fromJsonString(OrchestrationThreadPullRequest)),
    pinnedMessages: Schema.NullOr(Schema.fromJsonString(ThreadPinnedMessages)),
    threadMarkers: Schema.NullOr(Schema.fromJsonString(ThreadMarkers)),
    modelSelection: ModelSelectionJsonUnknown,
  }),
);
const {
  pinnedMessages: _projectionThreadPinnedMessagesField,
  threadMarkers: _projectionThreadMarkersField,
  notes: _projectionThreadNotesField,
  ...ProjectionThreadShellFields
} = ProjectionThread.fields;
const ProjectionThreadShellDbRowSchema = Schema.Struct(ProjectionThreadShellFields).mapFields(
  Struct.assign({
    createBranchFlowCompleted: Schema.Number,
    isPinned: Schema.Number,
    handoff: Schema.NullOr(Schema.fromJsonString(ThreadHandoff)),
    lastKnownPr: Schema.NullOr(Schema.fromJsonString(OrchestrationThreadPullRequest)),
    modelSelection: ModelSelectionJsonUnknown,
  }),
);
/**
 * Narrow projection row for managed-worktree retention. Deliberately keeps
 * soft-deleted threads visible: retention-deleted threads still own on-disk
 * worktrees that must be snapshotted and reclaimed. Fields are picked from
 * `ProjectionThread` so decoding stays identical to the full thread reader.
 */
const ProjectionManagedWorktreeThreadRowSchema = Schema.Struct({
  threadId: ProjectionThread.fields.threadId,
  archivedAt: ProjectionThread.fields.archivedAt,
  worktreePath: ProjectionThread.fields.worktreePath,
  associatedWorktreePath: ProjectionThread.fields.associatedWorktreePath,
});
const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);
type PendingInteractionRow = typeof OrchestrationPendingInteraction.Type;
const ProjectionThreadSessionDbRowSchema = ProjectionThreadSession;
const ProjectionCheckpointDbRowSchema = ProjectionCheckpoint.mapFields(
  Struct.assign({
    files: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
);
const ProjectionFileChangeActivityPayloadDbRowSchema = Schema.Struct({
  payload: Schema.fromJsonString(Schema.Unknown),
});
const ProjectionGeneratedImageActivityDbRowSchema = Schema.Struct({
  kind: Schema.String,
  payload: Schema.fromJsonString(Schema.Unknown),
});
const ProjectionLatestTurnDbRowSchema = Schema.Struct({
  threadId: ProjectionThread.fields.threadId,
  turnId: TurnId,
  state: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
});
const ProjectionStateDbRowSchema = ProjectionState;
const ProjectionCountsRowSchema = Schema.Struct({
  projectCount: Schema.Number,
  threadCount: Schema.Number,
});
const WorkspaceRootLookupInput = Schema.Struct({
  workspaceRoot: Schema.String,
});
const ProjectIdLookupInput = Schema.Struct({
  projectId: ProjectId,
});
const SpaceIdLookupInput = Schema.Struct({
  spaceId: SpaceId,
});
const ThreadIdLookupInput = Schema.Struct({
  threadId: ThreadId,
});
const StaleInFlightThreadLookupInput = Schema.Struct({
  updatedBefore: IsoDateTime,
  limit: Schema.Number,
});
const ThreadTurnLookupInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
});
const ThreadMessagesByThreadLookupInput = Schema.Struct({
  threadId: ThreadId,
  maxMessages: Schema.NullOr(Schema.Number),
});
const SyntheticSubagentParentLookupInput = Schema.Struct({
  threadId: ThreadId,
});
const FullThreadDiffContextLookupInput = Schema.Struct({
  threadId: ThreadId,
  checkpointTurnCount: NonNegativeInt,
});
const ProjectionProjectLookupRowSchema = ProjectionProjectDbRowSchema;
const ProjectionThreadIdLookupRowSchema = Schema.Struct({
  threadId: ThreadId,
});
const ProjectionThreadCheckpointContextThreadRowSchema = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  projectKind: ProjectKind.pipe(Schema.withDecodingDefault(() => "project")),
  workspaceRoot: Schema.String,
  envMode: ThreadEnvironmentMode,
  worktreePath: Schema.NullOr(Schema.String),
  workingDirectory: Schema.NullOr(Schema.String),
});
const ProjectionFullThreadDiffContextRowSchema = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  projectKind: ProjectKind.pipe(Schema.withDecodingDefault(() => "project")),
  workspaceRoot: Schema.String,
  envMode: ThreadEnvironmentMode,
  worktreePath: Schema.NullOr(Schema.String),
  workingDirectory: Schema.NullOr(Schema.String),
  latestCheckpointTurnCount: Schema.NullOr(NonNegativeInt),
  baselineCheckpointRef: Schema.NullOr(CheckpointRef),
  toCheckpointRef: Schema.NullOr(CheckpointRef),
});

type ProjectionThreadDbRowRaw = Schema.Schema.Type<typeof ProjectionThreadDbRowSchema>;
type ProjectionThreadShellDbRowRaw = Schema.Schema.Type<typeof ProjectionThreadShellDbRowSchema>;
type ProjectionProjectDbRowRaw = Schema.Schema.Type<typeof ProjectionProjectDbRowSchema>;
type ProjectionSpaceDbRow = Schema.Schema.Type<typeof ProjectionSpace>;
type ProjectionThreadDbRow = Omit<ProjectionThreadDbRowRaw, "modelSelection"> & {
  readonly modelSelection: typeof ModelSelection.Type;
};
type ProjectionThreadShellDbRow = Omit<ProjectionThreadShellDbRowRaw, "modelSelection"> & {
  readonly modelSelection: typeof ModelSelection.Type;
};
type ProjectionProjectDbRow = Omit<ProjectionProjectDbRowRaw, "defaultModelSelection"> & {
  readonly defaultModelSelection: typeof ModelSelection.Type | null;
};
type ProjectionThreadProposedPlanDbRow = Schema.Schema.Type<
  typeof ProjectionThreadProposedPlanDbRowSchema
>;
type ProjectionThreadActivityDbRow = Schema.Schema.Type<typeof ProjectionThreadActivityDbRowSchema>;
type ProjectionCheckpointDbRow = Schema.Schema.Type<typeof ProjectionCheckpointDbRowSchema>;
type ProjectionLatestTurnDbRow = Schema.Schema.Type<typeof ProjectionLatestTurnDbRowSchema>;
type ProjectionThreadSessionDbRow = Schema.Schema.Type<typeof ProjectionThreadSessionDbRowSchema>;
type ProjectionStateDbRow = Schema.Schema.Type<typeof ProjectionStateDbRowSchema>;

function decodeProjectionProjectRow(
  row: ProjectionProjectDbRowRaw,
): Effect.Effect<ProjectionProjectDbRow, Schema.SchemaError> {
  if (row.defaultModelSelection === null) {
    return Effect.succeed({ ...row, defaultModelSelection: null });
  }
  return decodeModelSelection(normalizePersistedModelSelection(row.defaultModelSelection)).pipe(
    Effect.map((defaultModelSelection) => ({ ...row, defaultModelSelection })),
  );
}

function decodeProjectionThreadRow(
  row: ProjectionThreadDbRowRaw,
): Effect.Effect<ProjectionThreadDbRow, Schema.SchemaError> {
  return decodeModelSelection(normalizePersistedModelSelection(row.modelSelection)).pipe(
    Effect.map((modelSelection) => ({ ...row, modelSelection })),
  );
}

function decodeProjectionThreadShellRow(
  row: ProjectionThreadShellDbRowRaw,
): Effect.Effect<ProjectionThreadShellDbRow, Schema.SchemaError> {
  return decodeModelSelection(normalizePersistedModelSelection(row.modelSelection)).pipe(
    Effect.map((modelSelection) => ({ ...row, modelSelection })),
  );
}

function decodeProjectionProjectRows(
  rows: ReadonlyArray<ProjectionProjectDbRowRaw>,
  operation: string,
): Effect.Effect<ReadonlyArray<ProjectionProjectDbRow>, ProjectionRepositoryError> {
  return Effect.forEach(rows, decodeProjectionProjectRow).pipe(
    Effect.mapError(toPersistenceDecodeError(operation)),
  );
}

function decodeProjectionThreadRows(
  rows: ReadonlyArray<ProjectionThreadDbRowRaw>,
  operation: string,
): Effect.Effect<ReadonlyArray<ProjectionThreadDbRow>, ProjectionRepositoryError> {
  return Effect.forEach(rows, decodeProjectionThreadRow).pipe(
    Effect.mapError(toPersistenceDecodeError(operation)),
  );
}

function decodeProjectionThreadShellRows(
  rows: ReadonlyArray<ProjectionThreadShellDbRowRaw>,
  operation: string,
): Effect.Effect<ReadonlyArray<ProjectionThreadShellDbRow>, ProjectionRepositoryError> {
  return Effect.forEach(rows, decodeProjectionThreadShellRow).pipe(
    Effect.mapError(toPersistenceDecodeError(operation)),
  );
}

function decodeProjectionProjectOption(
  option: Option.Option<ProjectionProjectDbRowRaw>,
  operation: string,
): Effect.Effect<Option.Option<ProjectionProjectDbRow>, ProjectionRepositoryError> {
  if (Option.isNone(option)) {
    return Effect.succeed(Option.none());
  }
  return decodeProjectionProjectRow(option.value).pipe(
    Effect.map(Option.some),
    Effect.mapError(toPersistenceDecodeError(operation)),
  );
}

function decodeProjectionThreadOption(
  option: Option.Option<ProjectionThreadDbRowRaw>,
  operation: string,
): Effect.Effect<Option.Option<ProjectionThreadDbRow>, ProjectionRepositoryError> {
  if (Option.isNone(option)) {
    return Effect.succeed(Option.none());
  }
  return decodeProjectionThreadRow(option.value).pipe(
    Effect.map(Option.some),
    Effect.mapError(toPersistenceDecodeError(operation)),
  );
}

const REQUIRED_SNAPSHOT_PROJECTORS = [
  ORCHESTRATION_PROJECTOR_NAMES.hot,
  ORCHESTRATION_PROJECTOR_NAMES.threadShellSummaries,
] as const;

function maxIso(left: string | null, right: string): string {
  if (left === null) {
    return right;
  }
  return left > right ? left : right;
}

function maxOptionalIso(left: string | null, right: string | null | undefined): string | null {
  return right ? maxIso(left, right) : left;
}

function pushGrouped<T>(map: Map<string, T[]>, threadId: string, value: T): void {
  const existing = map.get(threadId);
  if (existing) {
    existing.push(value);
    return;
  }
  map.set(threadId, [value]);
}

function toProjectedProposedPlan(
  row: ProjectionThreadProposedPlanDbRow,
): OrchestrationProposedPlan {
  return {
    id: row.planId,
    turnId: row.turnId,
    planMarkdown: row.planMarkdown,
    implementedAt: row.implementedAt,
    implementationThreadId: row.implementationThreadId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toProjectedActivity(row: ProjectionThreadActivityDbRow): OrchestrationThreadActivity {
  return {
    id: row.activityId,
    tone: row.tone,
    kind: row.kind,
    summary: row.summary,
    payload: row.payload as OrchestrationThreadActivity["payload"],
    turnId: row.turnId,
    ...(row.sequence !== null ? { sequence: row.sequence } : {}),
    createdAt: row.createdAt,
  };
}

function toProjectedCheckpoint(row: ProjectionCheckpointDbRow): OrchestrationCheckpointSummary {
  return {
    turnId: row.turnId,
    checkpointTurnCount: row.checkpointTurnCount,
    checkpointRef: row.checkpointRef,
    status: row.status,
    files: row.files,
    assistantMessageId: row.assistantMessageId,
    completedAt: row.completedAt,
  };
}

function toProjectedLatestTurn(row: ProjectionLatestTurnDbRow): OrchestrationLatestTurn {
  return {
    turnId: row.turnId,
    state:
      row.state === "error"
        ? "error"
        : row.state === "interrupted"
          ? "interrupted"
          : row.state === "completed"
            ? "completed"
            : "running",
    requestedAt: row.requestedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    assistantMessageId: row.assistantMessageId,
    ...(row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
      ? {
          sourceProposedPlan: {
            threadId: row.sourceProposedPlanThreadId,
            planId: row.sourceProposedPlanId,
          },
        }
      : {}),
  };
}

function toProjectedSession(row: ProjectionThreadSessionDbRow): OrchestrationSession {
  return {
    threadId: row.threadId,
    status: row.status,
    providerName: row.providerName,
    runtimeMode: row.runtimeMode,
    activeTurnId: row.activeTurnId,
    lastError: row.lastError,
    updatedAt: row.updatedAt,
  };
}

function toProjectedProject(row: ProjectionProjectDbRow): OrchestrationProject {
  return {
    id: row.projectId,
    kind: row.kind,
    title: row.title,
    workspaceRoot: row.workspaceRoot,
    defaultModelSelection: row.defaultModelSelection,
    scripts: row.scripts,
    isPinned: row.isPinned > 0,
    spaceId: row.spaceId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

function toProjectedSpace(row: ProjectionSpaceDbRow) {
  return {
    id: row.spaceId,
    name: row.name,
    icon: row.icon,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  } as const;
}

function toProjectedSpaceShell(row: ProjectionSpaceDbRow): OrchestrationSpaceShell {
  return {
    id: row.spaceId,
    name: row.name,
    icon: row.icon,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function collectBaseUpdatedAt(input: {
  readonly spaceRows: ReadonlyArray<ProjectionSpaceDbRow>;
  readonly projectRows: ReadonlyArray<ProjectionProjectDbRow>;
  readonly threadRows: ReadonlyArray<{ readonly updatedAt: string }>;
  readonly stateRows: ReadonlyArray<ProjectionStateDbRow>;
}): string | null {
  let updatedAt: string | null = null;
  for (const row of input.spaceRows) {
    updatedAt = maxIso(updatedAt, row.updatedAt);
  }
  for (const row of input.projectRows) {
    updatedAt = maxIso(updatedAt, row.updatedAt);
  }
  for (const row of input.threadRows) {
    updatedAt = maxIso(updatedAt, row.updatedAt);
  }
  for (const row of input.stateRows) {
    updatedAt = maxIso(updatedAt, row.updatedAt);
  }
  return updatedAt;
}

function collectProjectedMessages(rows: ReadonlyArray<ProjectionThreadMessageDbRow>): {
  readonly byThread: Map<string, Array<OrchestrationMessage>>;
  readonly updatedAt: string | null;
} {
  const byThread = new Map<string, Array<OrchestrationMessage>>();
  let updatedAt: string | null = null;
  for (const row of rows) {
    updatedAt = maxIso(updatedAt, row.updatedAt);
    pushGrouped(byThread, row.threadId, orchestrationMessageFromProjectionRow(row));
  }
  return { byThread, updatedAt };
}

function collectProjectedProposedPlans(rows: ReadonlyArray<ProjectionThreadProposedPlanDbRow>): {
  readonly byThread: Map<string, Array<OrchestrationProposedPlan>>;
  readonly updatedAt: string | null;
} {
  const byThread = new Map<string, Array<OrchestrationProposedPlan>>();
  let updatedAt: string | null = null;
  for (const row of rows) {
    updatedAt = maxIso(updatedAt, row.updatedAt);
    pushGrouped(byThread, row.threadId, toProjectedProposedPlan(row));
  }
  return { byThread, updatedAt };
}

function collectProjectedActivities(rows: ReadonlyArray<ProjectionThreadActivityDbRow>): {
  readonly byThread: Map<string, Array<OrchestrationThreadActivity>>;
  readonly updatedAt: string | null;
} {
  const byThread = new Map<string, Array<OrchestrationThreadActivity>>();
  let updatedAt: string | null = null;
  for (const row of rows) {
    updatedAt = maxIso(updatedAt, row.createdAt);
    pushGrouped(byThread, row.threadId, toProjectedActivity(row));
  }
  return { byThread, updatedAt };
}

function collectPendingInteractions(rows: ReadonlyArray<PendingInteractionRow>): {
  readonly byThread: Map<string, Array<PendingInteractionRow>>;
  readonly updatedAt: string | null;
} {
  const byThread = new Map<string, Array<PendingInteractionRow>>();
  let updatedAt: string | null = null;
  for (const row of rows) {
    updatedAt = maxIso(updatedAt, row.createdAt);
    updatedAt = maxOptionalIso(updatedAt, row.responseRequestedAt);
    updatedAt = maxOptionalIso(updatedAt, row.resolvedAt);
    pushGrouped(byThread, row.threadId, row);
  }
  return { byThread, updatedAt };
}

function collectProjectedCheckpoints(rows: ReadonlyArray<ProjectionCheckpointDbRow>): {
  readonly byThread: Map<string, Array<OrchestrationCheckpointSummary>>;
  readonly updatedAt: string | null;
} {
  const byThread = new Map<string, Array<OrchestrationCheckpointSummary>>();
  let updatedAt: string | null = null;
  for (const row of rows) {
    updatedAt = maxIso(updatedAt, row.completedAt);
    pushGrouped(byThread, row.threadId, toProjectedCheckpoint(row));
  }
  return { byThread, updatedAt };
}

function collectProjectedLatestTurns(rows: ReadonlyArray<ProjectionLatestTurnDbRow>): {
  readonly byThread: Map<string, OrchestrationLatestTurn>;
  readonly updatedAt: string | null;
} {
  const byThread = new Map<string, OrchestrationLatestTurn>();
  let updatedAt: string | null = null;
  for (const row of rows) {
    updatedAt = maxIso(updatedAt, row.requestedAt);
    updatedAt = maxOptionalIso(updatedAt, row.startedAt);
    updatedAt = maxOptionalIso(updatedAt, row.completedAt);
    if (byThread.has(row.threadId)) {
      continue;
    }
    byThread.set(row.threadId, toProjectedLatestTurn(row));
  }
  return { byThread, updatedAt };
}

function collectProjectedSessions(rows: ReadonlyArray<ProjectionThreadSessionDbRow>): {
  readonly byThread: Map<string, OrchestrationSession>;
  readonly updatedAt: string | null;
} {
  const byThread = new Map<string, OrchestrationSession>();
  let updatedAt: string | null = null;
  for (const row of rows) {
    updatedAt = maxIso(updatedAt, row.updatedAt);
    byThread.set(row.threadId, toProjectedSession(row));
  }
  return { byThread, updatedAt };
}

function toProjectedProjectShell(row: ProjectionProjectDbRow): OrchestrationProjectShell {
  return {
    id: row.projectId,
    kind: row.kind,
    title: row.title,
    workspaceRoot: row.workspaceRoot,
    defaultModelSelection: row.defaultModelSelection,
    scripts: row.scripts,
    isPinned: row.isPinned > 0,
    spaceId: row.spaceId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toProjectedThreadShellFromStoredSummary(input: {
  readonly threadRow: ProjectionThreadShellDbRow;
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly session: OrchestrationSession | null;
}): OrchestrationThreadShell {
  const { threadRow } = input;
  return {
    id: threadRow.threadId,
    projectId: threadRow.projectId,
    title: threadRow.title,
    modelSelection: threadRow.modelSelection,
    runtimeMode: threadRow.runtimeMode,
    interactionMode: threadRow.interactionMode,
    envMode: threadRow.envMode,
    branch: threadRow.branch,
    worktreePath: threadRow.worktreePath,
    workingDirectory: threadRow.workingDirectory,
    associatedWorktreePath: threadRow.associatedWorktreePath,
    associatedWorktreeBranch: threadRow.associatedWorktreeBranch,
    associatedWorktreeRef: threadRow.associatedWorktreeRef,
    createBranchFlowCompleted: threadRow.createBranchFlowCompleted > 0,
    isPinned: threadRow.isPinned > 0,
    parentThreadId: threadRow.parentThreadId ?? null,
    creationSource: threadRow.creationSource ?? null,
    sourceThreadId: threadRow.sourceThreadId ?? null,
    sourceTurnId: threadRow.sourceTurnId ?? null,
    gatewayOperationId: threadRow.gatewayOperationId ?? null,
    gatewayOperationIndex: threadRow.gatewayOperationIndex ?? null,
    subagentAgentId: threadRow.subagentAgentId ?? null,
    subagentNickname: threadRow.subagentNickname ?? null,
    subagentRole: threadRow.subagentRole ?? null,
    forkSourceThreadId: threadRow.forkSourceThreadId ?? null,
    sidechatSourceThreadId: threadRow.sidechatSourceThreadId ?? null,
    lastKnownPr: threadRow.lastKnownPr,
    latestTurn: input.latestTurn,
    latestUserMessageAt: threadRow.latestUserMessageAt,
    hasPendingApprovals: threadRow.pendingApprovalCount > 0,
    hasPendingUserInput: threadRow.pendingUserInputCount > 0,
    hasActionableProposedPlan: threadRow.hasActionableProposedPlan > 0,
    createdAt: threadRow.createdAt,
    updatedAt: threadRow.updatedAt,
    archivedAt: threadRow.archivedAt ?? null,
    handoff: threadRow.handoff,
    session: input.session,
  };
}

function toProjectedThread(input: {
  readonly threadRow: ProjectionThreadDbRow;
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly proposedPlans: ReadonlyArray<OrchestrationProposedPlan>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly pendingInteractions: ReadonlyArray<PendingInteractionRow>;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
  readonly session: OrchestrationSession | null;
}): OrchestrationThread {
  const { threadRow } = input;
  const summary = deriveThreadSummaryMetadata(input);
  return {
    id: threadRow.threadId,
    projectId: threadRow.projectId,
    title: threadRow.title,
    modelSelection: threadRow.modelSelection,
    runtimeMode: threadRow.runtimeMode,
    interactionMode: threadRow.interactionMode,
    envMode: threadRow.envMode,
    branch: threadRow.branch,
    worktreePath: threadRow.worktreePath,
    workingDirectory: threadRow.workingDirectory,
    associatedWorktreePath: threadRow.associatedWorktreePath,
    associatedWorktreeBranch: threadRow.associatedWorktreeBranch,
    associatedWorktreeRef: threadRow.associatedWorktreeRef,
    createBranchFlowCompleted: threadRow.createBranchFlowCompleted > 0,
    isPinned: threadRow.isPinned > 0,
    parentThreadId: threadRow.parentThreadId ?? null,
    creationSource: threadRow.creationSource ?? null,
    sourceThreadId: threadRow.sourceThreadId ?? null,
    sourceTurnId: threadRow.sourceTurnId ?? null,
    gatewayOperationId: threadRow.gatewayOperationId ?? null,
    gatewayOperationIndex: threadRow.gatewayOperationIndex ?? null,
    subagentAgentId: threadRow.subagentAgentId ?? null,
    subagentNickname: threadRow.subagentNickname ?? null,
    subagentRole: threadRow.subagentRole ?? null,
    forkSourceThreadId: threadRow.forkSourceThreadId,
    sidechatSourceThreadId: threadRow.sidechatSourceThreadId ?? null,
    lastKnownPr: threadRow.lastKnownPr,
    latestTurn: input.latestTurn,
    createdAt: threadRow.createdAt,
    updatedAt: threadRow.updatedAt,
    archivedAt: threadRow.archivedAt ?? null,
    deletedAt: threadRow.deletedAt,
    handoff: threadRow.handoff,
    latestUserMessageAt: summary.latestUserMessageAt,
    hasPendingApprovals: summary.hasPendingApprovals,
    hasPendingUserInput: summary.hasPendingUserInput,
    hasActionableProposedPlan: summary.hasActionableProposedPlan,
    messages: input.messages,
    proposedPlans: input.proposedPlans,
    activities: input.activities,
    pendingInteractions: input.pendingInteractions,
    checkpoints: input.checkpoints,
    ...(threadRow.pinnedMessages !== null ? { pinnedMessages: threadRow.pinnedMessages } : {}),
    ...(threadRow.threadMarkers !== null ? { threadMarkers: threadRow.threadMarkers } : {}),
    ...(threadRow.notes !== null ? { notes: threadRow.notes } : {}),
    session: input.session,
  };
}

function computeSnapshotSequence(
  stateRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionStateDbRowSchema>>,
): number {
  if (stateRows.length === 0) {
    return 0;
  }
  const sequenceByProjector = new Map(
    stateRows.map((row) => [row.projector, row.lastAppliedSequence] as const),
  );

  let minSequence = Number.POSITIVE_INFINITY;
  for (const projector of REQUIRED_SNAPSHOT_PROJECTORS) {
    const sequence = sequenceByProjector.get(projector);
    if (sequence === undefined) {
      return 0;
    }
    if (sequence < minSequence) {
      minSequence = sequence;
    }
  }

  return Number.isFinite(minSequence) ? minSequence : 0;
}

const makeProjectionSnapshotQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Thread retention soft-deletes and never purges (see ThreadDeletionReactor), so the
  // projection tables keep every row of every deleted thread forever. `getSnapshot` is the
  // only reader that hydrates message/activity bodies for the whole database at once, and
  // every consumer of its read model drops soft-deleted threads before use. Ranking those
  // rows was therefore ~95% pure waste on a mature database.
  //
  // Filtering by thread removes whole `PARTITION BY thread_id` partitions, so the
  // ROW_NUMBER() ranks of the threads that survive are bit-for-bit unchanged.
  const liveThreadScope = sql`
    thread_id IN (SELECT thread_id FROM projection_threads WHERE deleted_at IS NULL)
  `;

  const listSpaceRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionSpace,
    execute: () =>
      sql`
        SELECT
          space_id AS "spaceId",
          name,
          icon,
          sort_order AS "sortOrder",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_spaces
        ORDER BY sort_order ASC, space_id ASC
      `,
  });

  const listProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRowSchema,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          kind,
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          is_pinned AS "isPinned",
          space_id AS "spaceId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        ORDER BY created_at ASC, project_id ASC
      `,
  });

  const listThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          env_mode AS "envMode",
          branch,
          worktree_path AS "worktreePath",
          working_directory AS "workingDirectory",
          associated_worktree_path AS "associatedWorktreePath",
          associated_worktree_branch AS "associatedWorktreeBranch",
          associated_worktree_ref AS "associatedWorktreeRef",
          create_branch_flow_completed AS "createBranchFlowCompleted",
          is_pinned AS "isPinned",
          pinned_messages_json AS "pinnedMessages",
          thread_markers_json AS "threadMarkers",
          notes,
          parent_thread_id AS "parentThreadId",
          creation_source AS "creationSource",
          source_thread_id AS "sourceThreadId",
          source_turn_id AS "sourceTurnId",
          gateway_operation_id AS "gatewayOperationId",
          gateway_operation_index AS "gatewayOperationIndex",
          subagent_agent_id AS "subagentAgentId",
          subagent_nickname AS "subagentNickname",
          subagent_role AS "subagentRole",
          fork_source_thread_id AS "forkSourceThreadId",
          sidechat_source_thread_id AS "sidechatSourceThreadId",
          last_known_pr_json AS "lastKnownPr",
          latest_turn_id AS "latestTurnId",
          handoff_json AS "handoff",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const listThreadShellRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadShellDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          env_mode AS "envMode",
          branch,
          worktree_path AS "worktreePath",
          working_directory AS "workingDirectory",
          associated_worktree_path AS "associatedWorktreePath",
          associated_worktree_branch AS "associatedWorktreeBranch",
          associated_worktree_ref AS "associatedWorktreeRef",
          create_branch_flow_completed AS "createBranchFlowCompleted",
          is_pinned AS "isPinned",
          parent_thread_id AS "parentThreadId",
          creation_source AS "creationSource",
          source_thread_id AS "sourceThreadId",
          source_turn_id AS "sourceTurnId",
          gateway_operation_id AS "gatewayOperationId",
          gateway_operation_index AS "gatewayOperationIndex",
          subagent_agent_id AS "subagentAgentId",
          subagent_nickname AS "subagentNickname",
          subagent_role AS "subagentRole",
          fork_source_thread_id AS "forkSourceThreadId",
          sidechat_source_thread_id AS "sidechatSourceThreadId",
          last_known_pr_json AS "lastKnownPr",
          latest_turn_id AS "latestTurnId",
          handoff_json AS "handoff",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const listManagedWorktreeThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionManagedWorktreeThreadRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          archived_at AS "archivedAt",
          worktree_path AS "worktreePath",
          associated_worktree_path AS "associatedWorktreePath"
        FROM projection_threads
        WHERE worktree_path IS NOT NULL
           OR associated_worktree_path IS NOT NULL
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const listStaleInFlightThreadIdRows = SqlSchema.findAll({
    Request: StaleInFlightThreadLookupInput,
    Result: ProjectionThreadIdLookupRowSchema,
    execute: ({ updatedBefore, limit }) =>
      sql`
        SELECT threads.thread_id AS "threadId"
        FROM projection_threads AS threads
        INNER JOIN provider_session_runtime AS runtime
          ON runtime.thread_id = threads.thread_id
        LEFT JOIN projection_thread_sessions AS sessions
          ON sessions.thread_id = threads.thread_id
        LEFT JOIN projection_turns AS latest_turn
          ON latest_turn.thread_id = threads.thread_id
         AND latest_turn.turn_id = threads.latest_turn_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          AND (
            (
              sessions.active_turn_id IS NOT NULL
              AND sessions.status <> 'error'
            )
            OR latest_turn.state = 'running'
            OR json_extract(runtime.runtime_payload_json, '$.activeTurnId') IS NOT NULL
          )
          AND COALESCE(sessions.updated_at, threads.updated_at) <= ${updatedBefore}
        ORDER BY COALESCE(sessions.updated_at, threads.updated_at) ASC, threads.thread_id ASC
        LIMIT ${Math.max(1, Math.min(1_000, Math.floor(limit)))}
      `,
  });

  const listThreadMessageRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: () =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          skills_json AS "skills",
          mentions_json AS "mentions",
          dispatch_mode AS "dispatchMode",
          dispatch_origin AS "dispatchOrigin",
          is_streaming AS "isStreaming",
          source,
          sequence,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM (
          SELECT
            *,
            ROW_NUMBER() OVER (
              PARTITION BY thread_id
              ORDER BY
                CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
                sequence DESC,
                created_at DESC,
                message_id DESC
            ) AS message_rank
          FROM projection_thread_messages
          WHERE ${liveThreadScope}
        )
        WHERE message_rank <= ${MAX_THREAD_MESSAGES}
        ORDER BY
          thread_id ASC,
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          message_id ASC
      `,
  });

  const listThreadProposedPlanRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: () =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        ORDER BY thread_id ASC, created_at ASC, plan_id ASC
      `,
  });

  const listThreadActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: () =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM (
          SELECT
            *,
            ROW_NUMBER() OVER (
              PARTITION BY thread_id
              ORDER BY
                CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
                sequence DESC,
                created_at DESC,
                activity_id DESC
            ) AS activity_rank
          FROM projection_thread_activities
          WHERE ${liveThreadScope}
        ) AS ranked
        WHERE activity_rank <= ${MAX_THREAD_ACTIVITIES}
          OR (
            kind IN ('approval.requested', 'user-input.requested')
            AND json_extract(payload_json, '$.requestId') IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM projection_thread_activities AS later
              WHERE later.thread_id = ranked.thread_id
                AND json_extract(later.payload_json, '$.requestId') =
                  json_extract(ranked.payload_json, '$.requestId')
                AND (
                  (ranked.kind = 'approval.requested' AND later.kind = 'approval.resolved')
                  OR (
                    ranked.kind = 'approval.requested'
                    AND later.kind = 'provider.approval.respond.failed'
                    AND (
                      lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                        '%stale pending approval request%'
                      OR lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                        '%unknown pending approval request%'
                      OR lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                        '%unknown pending permission request%'
                    )
                  )
                  OR (ranked.kind = 'user-input.requested' AND later.kind = 'user-input.resolved')
                  OR (
                    ranked.kind = 'user-input.requested'
                    AND later.kind = 'provider.user-input.respond.failed'
                    AND (
                      lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                        '%stale pending user-input request%'
                      OR lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                        '%unknown pending user-input request%'
                    )
                  )
                )
                AND (
                  CASE WHEN later.sequence IS NULL THEN 0 ELSE 1 END >
                    CASE WHEN ranked.sequence IS NULL THEN 0 ELSE 1 END
                  OR (
                    CASE WHEN later.sequence IS NULL THEN 0 ELSE 1 END =
                      CASE WHEN ranked.sequence IS NULL THEN 0 ELSE 1 END
                    AND COALESCE(later.sequence, -1) > COALESCE(ranked.sequence, -1)
                  )
                  OR (
                    CASE WHEN later.sequence IS NULL THEN 0 ELSE 1 END =
                      CASE WHEN ranked.sequence IS NULL THEN 0 ELSE 1 END
                    AND COALESCE(later.sequence, -1) = COALESCE(ranked.sequence, -1)
                    AND later.created_at > ranked.created_at
                  )
                  OR (
                    CASE WHEN later.sequence IS NULL THEN 0 ELSE 1 END =
                      CASE WHEN ranked.sequence IS NULL THEN 0 ELSE 1 END
                    AND COALESCE(later.sequence, -1) = COALESCE(ranked.sequence, -1)
                    AND later.created_at = ranked.created_at
                    AND later.activity_id > ranked.activity_id
                  )
                )
            )
          )
        ORDER BY
          thread_id ASC,
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listCheckpointRevertLifecycleActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: () =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM (
          SELECT
            *,
            ROW_NUMBER() OVER (
              PARTITION BY thread_id
              ORDER BY
                CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
                sequence DESC,
                created_at DESC,
                activity_id DESC
            ) AS activity_rank
          FROM projection_thread_activities
          WHERE kind IN (
            'checkpoint.revert.started',
            'checkpoint.revert.succeeded',
            'checkpoint.revert.failed'
          )
        ) AS ranked
        WHERE activity_rank = 1
        ORDER BY thread_id ASC
      `,
  });

  const listPendingInteractionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: OrchestrationPendingInteraction,
    execute: () => sql`
      SELECT
        interaction_kind AS "interactionKind",
        request_id AS "requestId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        lifecycle_generation AS "lifecycleGeneration",
        status,
        decision,
        response_command_id AS "responseCommandId",
        response_requested_at AS "responseRequestedAt",
        created_at AS "createdAt",
        resolved_at AS "resolvedAt"
      FROM projection_pending_interactions
      WHERE status <> 'confirmed'
      ORDER BY thread_id ASC, created_at ASC, interaction_kind ASC, request_id ASC
    `,
  });

  const listThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_session_id AS "providerSessionId",
          provider_thread_id AS "providerThreadId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        ORDER BY thread_id ASC
      `,
  });

  const listCheckpointRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionCheckpointDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          COALESCE(completed_at, started_at, requested_at) AS "completedAt"
        FROM projection_turns
        -- Provider-diff placeholders can reserve checkpoint metadata before the
        -- turn is complete; snapshot checkpoint summaries require completedAt.
        WHERE checkpoint_turn_count IS NOT NULL
          AND completed_at IS NOT NULL
        ORDER BY thread_id ASC, checkpoint_turn_count ASC
      `,
  });

  const listLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          state,
          requested_at AS "requestedAt",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          assistant_message_id AS "assistantMessageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_turns
        WHERE turn_id IS NOT NULL
        ORDER BY thread_id ASC, requested_at DESC, turn_id DESC
      `,
  });

  const listProjectionStateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionStateDbRowSchema,
    execute: () =>
      sql`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence",
          updated_at AS "updatedAt"
        FROM projection_state
      `,
  });

  // Cheap targeted reads avoid hydrating the full snapshot for startup and diff lookups.
  const readProjectionCounts = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ProjectionCountsRowSchema,
    execute: () =>
      sql`
        SELECT
          (SELECT COUNT(*) FROM projection_projects) AS "projectCount",
          (SELECT COUNT(*) FROM projection_threads) AS "threadCount"
      `,
  });

  const getActiveProjectRowByWorkspaceRoot = SqlSchema.findOneOption({
    Request: WorkspaceRootLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ workspaceRoot }) =>
      sql`
        SELECT
          project_id AS "projectId",
          kind,
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          is_pinned AS "isPinned",
          space_id AS "spaceId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE workspace_root = ${workspaceRoot}
          AND deleted_at IS NULL
        ORDER BY CASE kind WHEN 'project' THEN 0 ELSE 1 END, created_at ASC, project_id ASC
        LIMIT 1
      `,
  });

  const getSpaceRowById = SqlSchema.findOneOption({
    Request: SpaceIdLookupInput,
    Result: ProjectionSpace,
    execute: ({ spaceId }) =>
      sql`
        SELECT
          space_id AS "spaceId",
          name,
          icon,
          sort_order AS "sortOrder",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_spaces
        WHERE space_id = ${spaceId}
          AND deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getFirstActiveThreadIdByProject = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionThreadIdLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId"
        FROM projection_threads
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, thread_id ASC
        LIMIT 1
      `,
  });

  const getProjectRowById = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          kind,
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          is_pinned AS "isPinned",
          space_id AS "spaceId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getThreadRowById = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          env_mode AS "envMode",
          branch,
          worktree_path AS "worktreePath",
          working_directory AS "workingDirectory",
          associated_worktree_path AS "associatedWorktreePath",
          associated_worktree_branch AS "associatedWorktreeBranch",
          associated_worktree_ref AS "associatedWorktreeRef",
          create_branch_flow_completed AS "createBranchFlowCompleted",
          is_pinned AS "isPinned",
          pinned_messages_json AS "pinnedMessages",
          thread_markers_json AS "threadMarkers",
          notes,
          parent_thread_id AS "parentThreadId",
          creation_source AS "creationSource",
          source_thread_id AS "sourceThreadId",
          source_turn_id AS "sourceTurnId",
          gateway_operation_id AS "gatewayOperationId",
          gateway_operation_index AS "gatewayOperationIndex",
          subagent_agent_id AS "subagentAgentId",
          subagent_nickname AS "subagentNickname",
          subagent_role AS "subagentRole",
          fork_source_thread_id AS "forkSourceThreadId",
          sidechat_source_thread_id AS "sidechatSourceThreadId",
          last_known_pr_json AS "lastKnownPr",
          latest_turn_id AS "latestTurnId",
          handoff_json AS "handoff",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
          AND deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getSyntheticSubagentParentThreadRow = SqlSchema.findOneOption({
    Request: SyntheticSubagentParentLookupInput,
    Result: ProjectionThreadDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          env_mode AS "envMode",
          branch,
          worktree_path AS "worktreePath",
          working_directory AS "workingDirectory",
          associated_worktree_path AS "associatedWorktreePath",
          associated_worktree_branch AS "associatedWorktreeBranch",
          associated_worktree_ref AS "associatedWorktreeRef",
          create_branch_flow_completed AS "createBranchFlowCompleted",
          is_pinned AS "isPinned",
          pinned_messages_json AS "pinnedMessages",
          thread_markers_json AS "threadMarkers",
          notes,
          parent_thread_id AS "parentThreadId",
          creation_source AS "creationSource",
          source_thread_id AS "sourceThreadId",
          source_turn_id AS "sourceTurnId",
          gateway_operation_id AS "gatewayOperationId",
          gateway_operation_index AS "gatewayOperationIndex",
          subagent_agent_id AS "subagentAgentId",
          subagent_nickname AS "subagentNickname",
          subagent_role AS "subagentRole",
          fork_source_thread_id AS "forkSourceThreadId",
          sidechat_source_thread_id AS "sidechatSourceThreadId",
          last_known_pr_json AS "lastKnownPr",
          latest_turn_id AS "latestTurnId",
          handoff_json AS "handoff",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE ${threadId} LIKE ('subagent:' || thread_id || ':%')
          AND deleted_at IS NULL
        ORDER BY length(thread_id) DESC, created_at ASC, thread_id ASC
        LIMIT 1
      `,
  });

  const listThreadMessageRowsByThread = SqlSchema.findAll({
    Request: ThreadMessagesByThreadLookupInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId, maxMessages }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          skills_json AS "skills",
          mentions_json AS "mentions",
          dispatch_mode AS "dispatchMode",
          dispatch_origin AS "dispatchOrigin",
          is_streaming AS "isStreaming",
          source,
          sequence,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM (
          SELECT
            *,
            ROW_NUMBER() OVER (
              PARTITION BY thread_id
              ORDER BY
                CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
                sequence DESC,
                created_at DESC,
                message_id DESC
            ) AS message_rank
          FROM projection_thread_messages
          WHERE thread_id = ${threadId}
        )
        WHERE thread_id = ${threadId}
          AND (${maxMessages} IS NULL OR message_rank <= ${maxMessages})
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          message_id ASC
      `,
  });

  const listThreadProposedPlanRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, plan_id ASC
      `,
  });

  const listThreadActivityRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM (
          SELECT
            *,
            ROW_NUMBER() OVER (
              PARTITION BY thread_id
              ORDER BY
                CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
                sequence DESC,
                created_at DESC,
                activity_id DESC
            ) AS activity_rank
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
        ) AS ranked
        WHERE thread_id = ${threadId}
          AND (
            activity_rank <= ${MAX_THREAD_ACTIVITIES}
            OR (
              kind IN ('approval.requested', 'user-input.requested')
              AND json_extract(payload_json, '$.requestId') IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM projection_thread_activities AS later
                WHERE later.thread_id = ranked.thread_id
                  AND json_extract(later.payload_json, '$.requestId') =
                    json_extract(ranked.payload_json, '$.requestId')
                  AND (
                    (ranked.kind = 'approval.requested' AND later.kind = 'approval.resolved')
                    OR (
                      ranked.kind = 'approval.requested'
                      AND later.kind = 'provider.approval.respond.failed'
                      AND (
                        lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                          '%stale pending approval request%'
                        OR lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                          '%unknown pending approval request%'
                        OR lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                          '%unknown pending permission request%'
                      )
                    )
                    OR (ranked.kind = 'user-input.requested' AND later.kind = 'user-input.resolved')
                    OR (
                      ranked.kind = 'user-input.requested'
                      AND later.kind = 'provider.user-input.respond.failed'
                      AND (
                        lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                          '%stale pending user-input request%'
                        OR lower(COALESCE(json_extract(later.payload_json, '$.detail'), '')) LIKE
                          '%unknown pending user-input request%'
                      )
                    )
                  )
                  AND (
                    CASE WHEN later.sequence IS NULL THEN 0 ELSE 1 END >
                      CASE WHEN ranked.sequence IS NULL THEN 0 ELSE 1 END
                    OR (
                      CASE WHEN later.sequence IS NULL THEN 0 ELSE 1 END =
                        CASE WHEN ranked.sequence IS NULL THEN 0 ELSE 1 END
                      AND COALESCE(later.sequence, -1) > COALESCE(ranked.sequence, -1)
                    )
                    OR (
                      CASE WHEN later.sequence IS NULL THEN 0 ELSE 1 END =
                        CASE WHEN ranked.sequence IS NULL THEN 0 ELSE 1 END
                      AND COALESCE(later.sequence, -1) = COALESCE(ranked.sequence, -1)
                      AND later.created_at > ranked.created_at
                    )
                    OR (
                      CASE WHEN later.sequence IS NULL THEN 0 ELSE 1 END =
                        CASE WHEN ranked.sequence IS NULL THEN 0 ELSE 1 END
                      AND COALESCE(later.sequence, -1) = COALESCE(ranked.sequence, -1)
                      AND later.created_at = ranked.created_at
                      AND later.activity_id > ranked.activity_id
                    )
                  )
              )
            )
          )
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listPendingInteractionRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: OrchestrationPendingInteraction,
    execute: ({ threadId }) => sql`
      SELECT
        interaction_kind AS "interactionKind",
        request_id AS "requestId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        lifecycle_generation AS "lifecycleGeneration",
        status,
        decision,
        response_command_id AS "responseCommandId",
        response_requested_at AS "responseRequestedAt",
        created_at AS "createdAt",
        resolved_at AS "resolvedAt"
      FROM projection_pending_interactions
      WHERE thread_id = ${threadId}
        AND status <> 'confirmed'
      ORDER BY created_at ASC, interaction_kind ASC, request_id ASC
    `,
  });

  const getThreadSessionRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_session_id AS "providerSessionId",
          provider_thread_id AS "providerThreadId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
        LIMIT 1
      `,
  });

  const getLatestTurnRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          state,
          requested_at AS "requestedAt",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          assistant_message_id AS "assistantMessageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NOT NULL
        ORDER BY requested_at DESC, turn_id DESC
        LIMIT 1
      `,
  });

  const getThreadCheckpointContextThreadRow = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadCheckpointContextThreadRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          projects.kind AS "projectKind",
          projects.workspace_root AS "workspaceRoot",
          threads.env_mode AS "envMode",
          threads.worktree_path AS "worktreePath",
          threads.working_directory AS "workingDirectory"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  });

  const listCheckpointRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          COALESCE(completed_at, started_at, requested_at) AS "completedAt"
        FROM projection_turns
        -- Keep incomplete provider-diff placeholders out of the public
        -- checkpoint summary contract, which requires completedAt.
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count IS NOT NULL
          AND completed_at IS NOT NULL
        ORDER BY checkpoint_turn_count ASC
      `,
  });

  // File-change tool payloads and captured per-turn Studio outputs remain available in
  // non-Git workspaces, where checkpoint capture intentionally does not run. Studio output
  // attribution requests this narrow slice.
  const listFileChangeActivityPayloadsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionFileChangeActivityPayloadDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT payload_json AS "payload"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND (
            (kind = 'tool.completed' AND json_extract(payload_json, '$.itemType') = 'file_change')
            OR kind = ${STUDIO_OUTPUTS_ACTIVITY_KIND}
          )
        ORDER BY created_at DESC, activity_id DESC
        LIMIT ${MAX_THREAD_FILE_CHANGE_ACTIVITIES}
      `,
  });

  // Generated-image references are recovered at turn settlement. Keep this query
  // independent of the 500-row thread-detail activity window: a long-running turn
  // can emit far more tool activities before its terminal event arrives.
  const listGeneratedImageActivityRowsByTurn = SqlSchema.findAll({
    Request: ThreadTurnLookupInput,
    Result: ProjectionGeneratedImageActivityDbRowSchema,
    execute: ({ threadId, turnId }) =>
      sql`
        SELECT kind, payload_json AS "payload"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND turn_id = ${turnId}
          AND (
            (kind = 'tool.completed' AND json_extract(payload_json, '$.itemType') = 'image_generation')
            OR (
              kind = ${STUDIO_OUTPUTS_ACTIVITY_KIND}
              AND json_type(payload_json, '$.data.generatedImage') = 'object'
            )
          )
        -- Provider replay can project the same completion more than once. Collapse
        -- exact payload duplicates before applying the two-records-per-image cap.
        GROUP BY kind, payload_json
        ORDER BY MIN(created_at) ASC, MIN(activity_id) ASC
        LIMIT ${MAX_TURN_GENERATED_IMAGE_ACTIVITY_RECORDS}
      `,
  });

  const getFullThreadDiffContextRow = SqlSchema.findOneOption({
    Request: FullThreadDiffContextLookupInput,
    Result: ProjectionFullThreadDiffContextRowSchema,
    execute: ({ threadId, checkpointTurnCount }) =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          projects.kind AS "projectKind",
          projects.workspace_root AS "workspaceRoot",
          threads.env_mode AS "envMode",
          threads.worktree_path AS "worktreePath",
          threads.working_directory AS "workingDirectory",
          (
            SELECT MAX(turns.checkpoint_turn_count)
            FROM projection_turns AS turns
            WHERE turns.thread_id = threads.thread_id
              AND turns.checkpoint_turn_count IS NOT NULL
              AND turns.completed_at IS NOT NULL
          ) AS "latestCheckpointTurnCount",
          (
            SELECT turns.checkpoint_ref
            FROM projection_turns AS turns
            WHERE turns.thread_id = threads.thread_id
              AND turns.checkpoint_turn_count IS NOT NULL
              AND turns.completed_at IS NOT NULL
            ORDER BY turns.checkpoint_turn_count ASC
            LIMIT 1
          ) AS "baselineCheckpointRef",
          (
            SELECT turns.checkpoint_ref
            FROM projection_turns AS turns
            WHERE turns.thread_id = threads.thread_id
              AND turns.checkpoint_turn_count = ${checkpointTurnCount}
              AND turns.completed_at IS NOT NULL
            LIMIT 1
          ) AS "toCheckpointRef"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getSnapshot: ProjectionSnapshotQueryShape["getSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [
            spaceRows,
            projectRows,
            threadRows,
            messageRows,
            proposedPlanRows,
            activityRows,
            pendingInteractionRows,
            sessionRows,
            checkpointRows,
            latestTurnRows,
            stateRows,
          ] = yield* Effect.all([
            listSpaceRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listSpaces:query",
                  "ProjectionSnapshotQuery.getSnapshot:listSpaces:decodeRows",
                ),
              ),
            ),
            listProjectRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listProjects:query",
                  "ProjectionSnapshotQuery.getSnapshot:listProjects:decodeRows",
                ),
              ),
              Effect.flatMap((rows) =>
                decodeProjectionProjectRows(
                  rows,
                  "ProjectionSnapshotQuery.getSnapshot:listProjects:decodeModelSelections",
                ),
              ),
            ),
            listThreadRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreads:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreads:decodeRows",
                ),
              ),
              Effect.flatMap((rows) =>
                decodeProjectionThreadRows(
                  rows,
                  "ProjectionSnapshotQuery.getSnapshot:listThreads:decodeModelSelections",
                ),
              ),
            ),
            listThreadMessageRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:decodeRows",
                ),
              ),
            ),
            listThreadProposedPlanRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:decodeRows",
                ),
              ),
            ),
            listThreadActivityRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:decodeRows",
                ),
              ),
            ),
            listPendingInteractionRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listPendingInteractions:query",
                  "ProjectionSnapshotQuery.getSnapshot:listPendingInteractions:decodeRows",
                ),
              ),
            ),
            listThreadSessionRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:decodeRows",
                ),
              ),
            ),
            listCheckpointRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:query",
                  "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:decodeRows",
                ),
              ),
            ),
            listLatestTurnRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:query",
                  "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:decodeRows",
                ),
              ),
            ),
            listProjectionStateRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listProjectionState:query",
                  "ProjectionSnapshotQuery.getSnapshot:listProjectionState:decodeRows",
                ),
              ),
            ),
          ]);

          const messages = collectProjectedMessages(messageRows);
          const proposedPlans = collectProjectedProposedPlans(proposedPlanRows);
          const activities = collectProjectedActivities(activityRows);
          const pendingInteractions = collectPendingInteractions(pendingInteractionRows);
          const checkpoints = collectProjectedCheckpoints(checkpointRows);
          const latestTurns = collectProjectedLatestTurns(latestTurnRows);
          const sessions = collectProjectedSessions(sessionRows);

          let updatedAt = collectBaseUpdatedAt({ spaceRows, projectRows, threadRows, stateRows });
          updatedAt = maxOptionalIso(updatedAt, messages.updatedAt);
          updatedAt = maxOptionalIso(updatedAt, proposedPlans.updatedAt);
          updatedAt = maxOptionalIso(updatedAt, activities.updatedAt);
          updatedAt = maxOptionalIso(updatedAt, pendingInteractions.updatedAt);
          updatedAt = maxOptionalIso(updatedAt, checkpoints.updatedAt);
          updatedAt = maxOptionalIso(updatedAt, latestTurns.updatedAt);
          updatedAt = maxOptionalIso(updatedAt, sessions.updatedAt);

          const projects: ReadonlyArray<OrchestrationProject> = projectRows.map(toProjectedProject);

          const threads: ReadonlyArray<OrchestrationThread> = threadRows.map((row) =>
            toProjectedThread({
              threadRow: row,
              latestTurn: latestTurns.byThread.get(row.threadId) ?? null,
              messages: messages.byThread.get(row.threadId) ?? [],
              proposedPlans: proposedPlans.byThread.get(row.threadId) ?? [],
              activities: activities.byThread.get(row.threadId) ?? [],
              pendingInteractions: pendingInteractions.byThread.get(row.threadId) ?? [],
              checkpoints: checkpoints.byThread.get(row.threadId) ?? [],
              session: sessions.byThread.get(row.threadId) ?? null,
            }),
          );

          const snapshot = {
            snapshotSequence: computeSnapshotSequence(stateRows),
            spaces: spaceRows.map(toProjectedSpace),
            projects,
            threads,
            updatedAt: updatedAt ?? new Date(0).toISOString(),
          };

          return yield* decodeReadModel(snapshot).pipe(
            Effect.mapError(
              toPersistenceDecodeError("ProjectionSnapshotQuery.getSnapshot:decodeReadModel"),
            ),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getSnapshot:query")(error);
        }),
      );

  const getCommandReadModel: ProjectionSnapshotQueryShape["getCommandReadModel"] = () =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [
            spaceRows,
            projectRows,
            threadRows,
            proposedPlanRows,
            checkpointRevertActivityRows,
            sessionRows,
            latestTurnRows,
            stateRows,
          ] = yield* Effect.all([
            listSpaceRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getCommandReadModel:listSpaces:query",
                  "ProjectionSnapshotQuery.getCommandReadModel:listSpaces:decodeRows",
                ),
              ),
            ),
            listProjectRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getCommandReadModel:listProjects:query",
                  "ProjectionSnapshotQuery.getCommandReadModel:listProjects:decodeRows",
                ),
              ),
              Effect.flatMap((rows) =>
                decodeProjectionProjectRows(
                  rows,
                  "ProjectionSnapshotQuery.getCommandReadModel:listProjects:decodeModelSelections",
                ),
              ),
            ),
            listThreadRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getCommandReadModel:listThreads:query",
                  "ProjectionSnapshotQuery.getCommandReadModel:listThreads:decodeRows",
                ),
              ),
              Effect.flatMap((rows) =>
                decodeProjectionThreadRows(
                  rows,
                  "ProjectionSnapshotQuery.getCommandReadModel:listThreads:decodeModelSelections",
                ),
              ),
            ),
            listThreadProposedPlanRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getCommandReadModel:listThreadProposedPlans:query",
                  "ProjectionSnapshotQuery.getCommandReadModel:listThreadProposedPlans:decodeRows",
                ),
              ),
            ),
            listCheckpointRevertLifecycleActivityRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getCommandReadModel:listCheckpointRevertActivities:query",
                  "ProjectionSnapshotQuery.getCommandReadModel:listCheckpointRevertActivities:decodeRows",
                ),
              ),
            ),
            listThreadSessionRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getCommandReadModel:listThreadSessions:query",
                  "ProjectionSnapshotQuery.getCommandReadModel:listThreadSessions:decodeRows",
                ),
              ),
            ),
            listLatestTurnRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getCommandReadModel:listLatestTurns:query",
                  "ProjectionSnapshotQuery.getCommandReadModel:listLatestTurns:decodeRows",
                ),
              ),
            ),
            listProjectionStateRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getCommandReadModel:listProjectionState:query",
                  "ProjectionSnapshotQuery.getCommandReadModel:listProjectionState:decodeRows",
                ),
              ),
            ),
          ]);

          const proposedPlans = collectProjectedProposedPlans(proposedPlanRows);
          const checkpointRevertActivities = collectProjectedActivities(
            checkpointRevertActivityRows,
          );
          const sessions = collectProjectedSessions(sessionRows);
          const latestTurns = collectProjectedLatestTurns(latestTurnRows);

          let updatedAt = collectBaseUpdatedAt({ spaceRows, projectRows, threadRows, stateRows });
          updatedAt = maxOptionalIso(updatedAt, proposedPlans.updatedAt);
          updatedAt = maxOptionalIso(updatedAt, checkpointRevertActivities.updatedAt);
          updatedAt = maxOptionalIso(updatedAt, sessions.updatedAt);
          updatedAt = maxOptionalIso(updatedAt, latestTurns.updatedAt);

          const projects: ReadonlyArray<OrchestrationProject> = projectRows.map(toProjectedProject);

          const threads: ReadonlyArray<OrchestrationThread> = threadRows.map((row) =>
            toProjectedThread({
              threadRow: row,
              latestTurn: latestTurns.byThread.get(row.threadId) ?? null,
              messages: [],
              proposedPlans: proposedPlans.byThread.get(row.threadId) ?? [],
              activities: checkpointRevertActivities.byThread.get(row.threadId) ?? [],
              pendingInteractions: [],
              checkpoints: [],
              session: sessions.byThread.get(row.threadId) ?? null,
            }),
          );

          return yield* decodeReadModel({
            snapshotSequence: computeSnapshotSequence(stateRows),
            spaces: spaceRows.map(toProjectedSpace),
            projects,
            threads,
            updatedAt: updatedAt ?? new Date(0).toISOString(),
          }).pipe(
            Effect.mapError(
              toPersistenceDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:decodeReadModel",
              ),
            ),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getCommandReadModel:query")(error);
        }),
      );

  const getShellSnapshot: ProjectionSnapshotQueryShape["getShellSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [spaceRows, projectRows, threadRows, sessionRows, latestTurnRows, stateRows] =
            yield* Effect.all([
              listSpaceRows(undefined).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:listSpaces:query",
                    "ProjectionSnapshotQuery.getShellSnapshot:listSpaces:decodeRows",
                  ),
                ),
              ),
              listProjectRows(undefined).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:listProjects:query",
                    "ProjectionSnapshotQuery.getShellSnapshot:listProjects:decodeRows",
                  ),
                ),
                Effect.flatMap((rows) =>
                  decodeProjectionProjectRows(
                    rows,
                    "ProjectionSnapshotQuery.getShellSnapshot:listProjects:decodeModelSelections",
                  ),
                ),
              ),
              listThreadShellRows(undefined).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:listThreads:query",
                    "ProjectionSnapshotQuery.getShellSnapshot:listThreads:decodeRows",
                  ),
                ),
                Effect.flatMap((rows) =>
                  decodeProjectionThreadShellRows(
                    rows,
                    "ProjectionSnapshotQuery.getShellSnapshot:listThreads:decodeModelSelections",
                  ),
                ),
              ),
              listThreadSessionRows(undefined).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:query",
                    "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:decodeRows",
                  ),
                ),
              ),
              listLatestTurnRows(undefined).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:query",
                    "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:decodeRows",
                  ),
                ),
              ),
              listProjectionStateRows(undefined).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:query",
                    "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:decodeRows",
                  ),
                ),
              ),
            ]);

          const latestTurns = collectProjectedLatestTurns(latestTurnRows);
          const sessions = collectProjectedSessions(sessionRows);

          let updatedAt = collectBaseUpdatedAt({ spaceRows, projectRows, threadRows, stateRows });
          updatedAt = maxOptionalIso(updatedAt, latestTurns.updatedAt);
          updatedAt = maxOptionalIso(updatedAt, sessions.updatedAt);

          const snapshot = {
            snapshotSequence: computeSnapshotSequence(stateRows),
            spaces: spaceRows.filter((row) => row.deletedAt === null).map(toProjectedSpaceShell),
            projects: projectRows
              .filter((row) => row.deletedAt === null)
              .map((row) => toProjectedProjectShell(row)),
            threads: threadRows
              .filter((row) => row.deletedAt === null)
              .map((row) =>
                toProjectedThreadShellFromStoredSummary({
                  threadRow: row,
                  latestTurn: latestTurns.byThread.get(row.threadId) ?? null,
                  session: sessions.byThread.get(row.threadId) ?? null,
                }),
              ),
            updatedAt: updatedAt ?? new Date(0).toISOString(),
          };

          return yield* decodeShellSnapshot(snapshot).pipe(
            Effect.mapError(
              toPersistenceDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:decodeShellSnapshot",
              ),
            ),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getShellSnapshot:query")(error);
        }),
      );

  const listStaleInFlightThreadIds: ProjectionSnapshotQueryShape["listStaleInFlightThreadIds"] = (
    input,
  ) =>
    listStaleInFlightThreadIdRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.listStaleInFlightThreadIds:query",
          "ProjectionSnapshotQuery.listStaleInFlightThreadIds:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.threadId)),
    );

  const listManagedWorktreeThreads: ProjectionSnapshotQueryShape["listManagedWorktreeThreads"] =
    () =>
      listManagedWorktreeThreadRows(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.listManagedWorktreeThreads:query",
            "ProjectionSnapshotQuery.listManagedWorktreeThreads:decodeRows",
          ),
        ),
        Effect.map((rows) =>
          rows.map(
            // Normalize absent columns to `null` so the published row shape stays
            // strict (`string | null`) rather than leaking `undefined` outward.
            (row): ProjectionManagedWorktreeThread => ({
              id: row.threadId,
              archivedAt: row.archivedAt ?? null,
              worktreePath: row.worktreePath ?? null,
              associatedWorktreePath: row.associatedWorktreePath ?? null,
            }),
          ),
        ),
      );

  const getCounts: ProjectionSnapshotQueryShape["getCounts"] = () =>
    readProjectionCounts(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getCounts:query",
          "ProjectionSnapshotQuery.getCounts:decodeRow",
        ),
      ),
      Effect.map(
        (row): ProjectionSnapshotCounts => ({
          projectCount: row.projectCount,
          threadCount: row.threadCount,
        }),
      ),
    );

  const getSnapshotSequence: ProjectionSnapshotQueryShape["getSnapshotSequence"] = () =>
    listProjectionStateRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getSnapshotSequence:query",
          "ProjectionSnapshotQuery.getSnapshotSequence:decodeRows",
        ),
      ),
      Effect.map(
        (stateRows): ProjectionSnapshotSequence => ({
          snapshotSequence: computeSnapshotSequence(stateRows),
        }),
      ),
    );

  const getActiveProjectByWorkspaceRoot: ProjectionSnapshotQueryShape["getActiveProjectByWorkspaceRoot"] =
    (workspaceRoot) =>
      getActiveProjectRowByWorkspaceRoot({ workspaceRoot }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:query",
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:decodeRow",
          ),
        ),
        Effect.flatMap((option) =>
          decodeProjectionProjectOption(
            option,
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:decodeModelSelection",
          ),
        ),
        Effect.map((option) =>
          Option.map(
            option,
            (row): OrchestrationProject => ({
              id: row.projectId,
              kind: row.kind,
              title: row.title,
              workspaceRoot: row.workspaceRoot,
              defaultModelSelection: row.defaultModelSelection,
              scripts: row.scripts,
              isPinned: row.isPinned > 0,
              spaceId: row.spaceId,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              deletedAt: row.deletedAt,
            }),
          ),
        ),
      );

  const getProjectShellById: ProjectionSnapshotQueryShape["getProjectShellById"] = (projectId) =>
    getProjectRowById({ projectId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getProjectShellById:query",
          "ProjectionSnapshotQuery.getProjectShellById:decodeRow",
        ),
      ),
      Effect.flatMap((option) =>
        decodeProjectionProjectOption(
          option,
          "ProjectionSnapshotQuery.getProjectShellById:decodeModelSelection",
        ),
      ),
      Effect.map((option) => Option.map(option, (row) => toProjectedProjectShell(row))),
    );

  const getSpaceShellById: ProjectionSnapshotQueryShape["getSpaceShellById"] = (spaceId) =>
    getSpaceRowById({ spaceId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getSpaceShellById:query",
          "ProjectionSnapshotQuery.getSpaceShellById:decodeRow",
        ),
      ),
      Effect.map(Option.map(toProjectedSpaceShell)),
    );

  const getFirstActiveThreadIdByProjectId: ProjectionSnapshotQueryShape["getFirstActiveThreadIdByProjectId"] =
    (projectId) =>
      getFirstActiveThreadIdByProject({ projectId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:query",
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:decodeRow",
          ),
        ),
        Effect.map(Option.map((row) => row.threadId)),
      );

  const getThreadCheckpointContext: ProjectionSnapshotQueryShape["getThreadCheckpointContext"] = (
    threadId,
    options,
  ) =>
    Effect.gen(function* () {
      const threadRow = yield* getThreadCheckpointContextThreadRow({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:query",
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:decodeRow",
          ),
        ),
      );
      if (Option.isNone(threadRow)) {
        return Option.none<ProjectionThreadCheckpointContext>();
      }

      const checkpointRows = yield* listCheckpointRowsByThread({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:query",
            "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:decodeRows",
          ),
        ),
      );
      const fileChangeActivityPayloads = options?.includeFileChangeActivityPayloads
        ? yield* listFileChangeActivityPayloadsByThread({ threadId }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadCheckpointContext:listFileChangeActivities:query",
                "ProjectionSnapshotQuery.getThreadCheckpointContext:listFileChangeActivities:decodeRows",
              ),
            ),
            Effect.map((rows) => rows.map((row) => row.payload)),
          )
        : undefined;

      return Option.some({
        threadId: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        projectKind: threadRow.value.projectKind,
        workspaceRoot: threadRow.value.workspaceRoot,
        envMode: threadRow.value.envMode,
        worktreePath: threadRow.value.worktreePath,
        workingDirectory: threadRow.value.workingDirectory,
        checkpoints: checkpointRows.map(
          (row): OrchestrationCheckpointSummary => ({
            turnId: row.turnId,
            checkpointTurnCount: row.checkpointTurnCount,
            checkpointRef: row.checkpointRef,
            status: row.status,
            files: row.files,
            assistantMessageId: row.assistantMessageId,
            completedAt: row.completedAt,
          }),
        ),
        ...(fileChangeActivityPayloads ? { fileChangeActivityPayloads } : {}),
      });
    });

  const listGeneratedImageActivitiesByTurn: ProjectionSnapshotQueryShape["listGeneratedImageActivitiesByTurn"] =
    (threadId, turnId) =>
      listGeneratedImageActivityRowsByTurn({ threadId, turnId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.listGeneratedImageActivitiesByTurn:query",
            "ProjectionSnapshotQuery.listGeneratedImageActivitiesByTurn:decodeRows",
          ),
        ),
        Effect.map(
          (rows): ReadonlyArray<ProjectionGeneratedImageActivityRecord> =>
            rows.map((row) => ({ kind: row.kind, payload: row.payload })),
        ),
      );

  const getFullThreadDiffContext: ProjectionSnapshotQueryShape["getFullThreadDiffContext"] = (
    threadId,
    toTurnCount,
  ) =>
    Effect.gen(function* () {
      const row = yield* getFullThreadDiffContextRow({
        threadId,
        checkpointTurnCount: toTurnCount,
      }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFullThreadDiffContext:query",
            "ProjectionSnapshotQuery.getFullThreadDiffContext:decodeRow",
          ),
        ),
      );
      if (Option.isNone(row)) {
        return Option.none<ProjectionFullThreadDiffContext>();
      }

      return Option.some({
        threadId: row.value.threadId,
        projectId: row.value.projectId,
        projectKind: row.value.projectKind,
        workspaceRoot: row.value.workspaceRoot,
        envMode: row.value.envMode,
        worktreePath: row.value.worktreePath,
        workingDirectory: row.value.workingDirectory,
        latestCheckpointTurnCount: row.value.latestCheckpointTurnCount ?? 0,
        baselineCheckpointRef: row.value.baselineCheckpointRef,
        toCheckpointRef: row.value.toCheckpointRef,
      });
    });

  const getThreadShellById: ProjectionSnapshotQueryShape["getThreadShellById"] = (threadId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const threadRow = yield* getThreadRowById({ threadId }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadShellById:getThread:query",
                "ProjectionSnapshotQuery.getThreadShellById:getThread:decodeRow",
              ),
            ),
            Effect.flatMap((option) =>
              decodeProjectionThreadOption(
                option,
                "ProjectionSnapshotQuery.getThreadShellById:getThread:decodeModelSelection",
              ),
            ),
          );
          if (Option.isNone(threadRow)) {
            return Option.none<OrchestrationThreadShell>();
          }

          const [latestTurnRow, sessionRow] = yield* Effect.all([
            getLatestTurnRowByThread({ threadId }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:query",
                  "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:decodeRow",
                ),
              ),
            ),
            getThreadSessionRowByThread({ threadId }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadShellById:getSession:query",
                  "ProjectionSnapshotQuery.getThreadShellById:getSession:decodeRow",
                ),
              ),
            ),
          ]);

          return Option.some(
            toProjectedThreadShellFromStoredSummary({
              threadRow: threadRow.value,
              latestTurn: Option.match(latestTurnRow, {
                onNone: () => null,
                onSome: (row) => toProjectedLatestTurn(row),
              }),
              session: Option.match(sessionRow, {
                onNone: () => null,
                onSome: (row) => toProjectedSession(row),
              }),
            }),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getThreadShellById:query")(error);
        }),
      );

  const findSyntheticSubagentParentThread: ProjectionSnapshotQueryShape["findSyntheticSubagentParentThread"] =
    (threadId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const parentRow = yield* getSyntheticSubagentParentThreadRow({ threadId }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.findSyntheticSubagentParentThread:getThread:query",
                  "ProjectionSnapshotQuery.findSyntheticSubagentParentThread:getThread:decodeRow",
                ),
              ),
              Effect.flatMap((option) =>
                decodeProjectionThreadOption(
                  option,
                  "ProjectionSnapshotQuery.findSyntheticSubagentParentThread:getThread:decodeModelSelection",
                ),
              ),
            );
            if (Option.isNone(parentRow)) {
              return Option.none<OrchestrationThread>();
            }
            return yield* loadThreadDetail(parentRow.value.threadId);
          }),
        )
        .pipe(
          Effect.mapError((error) => {
            if (isPersistenceError(error)) {
              return error;
            }
            return toPersistenceSqlError(
              "ProjectionSnapshotQuery.findSyntheticSubagentParentThread:query",
            )(error);
          }),
        );

  // Hydrate a full thread detail projection without opening its own transaction.
  const loadThreadDetail = (
    threadId: ThreadId,
    options: { readonly messageLimit: number | null; readonly tracePrefix: string } = {
      messageLimit: MAX_THREAD_MESSAGES,
      tracePrefix: "ProjectionSnapshotQuery.getThreadDetailById",
    },
  ) =>
    Effect.gen(function* () {
      const threadRow = yield* getThreadRowById({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            `${options.tracePrefix}:getThread:query`,
            `${options.tracePrefix}:getThread:decodeRow`,
          ),
        ),
        Effect.flatMap((option) =>
          decodeProjectionThreadOption(
            option,
            `${options.tracePrefix}:getThread:decodeModelSelection`,
          ),
        ),
      );
      if (Option.isNone(threadRow)) {
        return Option.none<OrchestrationThread>();
      }

      const [
        messageRows,
        proposedPlanRows,
        activityRows,
        pendingInteractionRows,
        checkpointRows,
        latestTurnRow,
        sessionRow,
      ] = yield* Effect.all([
        listThreadMessageRowsByThread({ threadId, maxMessages: options.messageLimit }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              `${options.tracePrefix}:listMessages:query`,
              `${options.tracePrefix}:listMessages:decodeRows`,
            ),
          ),
        ),
        listThreadProposedPlanRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              `${options.tracePrefix}:listPlans:query`,
              `${options.tracePrefix}:listPlans:decodeRows`,
            ),
          ),
        ),
        listThreadActivityRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              `${options.tracePrefix}:listActivities:query`,
              `${options.tracePrefix}:listActivities:decodeRows`,
            ),
          ),
        ),
        listPendingInteractionRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              `${options.tracePrefix}:listPendingInteractions:query`,
              `${options.tracePrefix}:listPendingInteractions:decodeRows`,
            ),
          ),
        ),
        listCheckpointRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              `${options.tracePrefix}:listCheckpoints:query`,
              `${options.tracePrefix}:listCheckpoints:decodeRows`,
            ),
          ),
        ),
        getLatestTurnRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              `${options.tracePrefix}:getLatestTurn:query`,
              `${options.tracePrefix}:getLatestTurn:decodeRow`,
            ),
          ),
        ),
        getThreadSessionRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              `${options.tracePrefix}:getSession:query`,
              `${options.tracePrefix}:getSession:decodeRow`,
            ),
          ),
        ),
      ]);

      const thread = toProjectedThread({
        threadRow: threadRow.value,
        latestTurn: Option.match(latestTurnRow, {
          onNone: () => null,
          onSome: (row) => toProjectedLatestTurn(row),
        }),
        messages: messageRows.map(orchestrationMessageFromProjectionRow),
        proposedPlans: proposedPlanRows.map((row) => toProjectedProposedPlan(row)),
        activities: activityRows.map((row) => toProjectedActivity(row)),
        pendingInteractions: pendingInteractionRows,
        checkpoints: checkpointRows.map((row) => toProjectedCheckpoint(row)),
        session: Option.match(sessionRow, {
          onNone: () => null,
          onSome: (row) => toProjectedSession(row),
        }),
      });

      return yield* decodeThreadDetail(thread).pipe(
        Effect.map((decodedThread) => Option.some(decodedThread)),
        Effect.mapError(toPersistenceDecodeError(`${options.tracePrefix}:decodeThread`)),
      );
    });

  const getThreadDetailById: ProjectionSnapshotQueryShape["getThreadDetailById"] = (threadId) =>
    sql.withTransaction(loadThreadDetail(threadId)).pipe(
      Effect.mapError((error) => {
        if (isPersistenceError(error)) {
          return error;
        }
        return toPersistenceSqlError("ProjectionSnapshotQuery.getThreadDetailById:query")(error);
      }),
    );

  const getThreadDetailForExportById: ProjectionSnapshotQueryShape["getThreadDetailForExportById"] =
    (threadId) =>
      sql
        .withTransaction(
          loadThreadDetail(threadId, {
            messageLimit: null,
            tracePrefix: "ProjectionSnapshotQuery.getThreadDetailForExportById",
          }),
        )
        .pipe(
          Effect.mapError((error) => {
            if (isPersistenceError(error)) {
              return error;
            }
            return toPersistenceSqlError(
              "ProjectionSnapshotQuery.getThreadDetailForExportById:query",
            )(error);
          }),
        );

  // Capture the projection cursor and thread detail in one transaction so the
  // snapshot fence cannot advance past the detail payload the client receives.
  const getThreadDetailSnapshotById: ProjectionSnapshotQueryShape["getThreadDetailSnapshotById"] = (
    threadId,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [threadDetail, stateRows] = yield* Effect.all([
            loadThreadDetail(threadId),
            listProjectionStateRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadDetailSnapshotById:listProjectionState:query",
                  "ProjectionSnapshotQuery.getThreadDetailSnapshotById:listProjectionState:decodeRows",
                ),
              ),
            ),
          ]);
          if (Option.isNone(threadDetail)) {
            return Option.none<OrchestrationThreadDetailSnapshot>();
          }

          return yield* decodeThreadDetailSnapshot({
            snapshotSequence: computeSnapshotSequence(stateRows),
            thread: threadDetail.value,
          }).pipe(
            Effect.map((snapshot) => Option.some(snapshot)),
            Effect.mapError(
              toPersistenceDecodeError(
                "ProjectionSnapshotQuery.getThreadDetailSnapshotById:decodeSnapshot",
              ),
            ),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getThreadDetailSnapshotById:query")(
            error,
          );
        }),
      );

  return {
    getCommandReadModel,
    getSnapshot,
    getShellSnapshot,
    getCounts,
    getSnapshotSequence,
    listStaleInFlightThreadIds,
    listManagedWorktreeThreads,
    getActiveProjectByWorkspaceRoot,
    getProjectShellById,
    getSpaceShellById,
    getFirstActiveThreadIdByProjectId,
    getThreadCheckpointContext,
    listGeneratedImageActivitiesByTurn,
    getFullThreadDiffContext,
    getThreadShellById,
    findSyntheticSubagentParentThread,
    getThreadDetailById,
    getThreadDetailForExportById,
    getThreadDetailSnapshotById,
  } satisfies ProjectionSnapshotQueryShape;
});

export const OrchestrationProjectionSnapshotQueryLive = Layer.effect(
  ProjectionSnapshotQuery,
  makeProjectionSnapshotQuery,
);

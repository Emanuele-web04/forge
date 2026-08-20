import type {
  ApprovalRequestId,
  OrchestrationCommand,
  OrchestrationLatestTurn,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationSpace,
  OrchestrationSession,
  OrchestrationThread,
  OrchestrationThreadActivity,
  ProjectKind,
  ProjectId,
  SpaceId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { THREAD_NOT_ARCHIVED_INVARIANT_MARKER } from "@synara/shared/errorMessages";
import {
  isLegacyHomeChatContainerRow as isSharedLegacyHomeChatContainerRow,
  isOrdinaryProjectRow as isSharedOrdinaryProjectRow,
} from "@synara/shared/projectContainers";
import { normalizeWorkspaceRootForComparison } from "@synara/shared/threadWorkspace";
import { Effect } from "effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";

function invariantError(commandType: string, detail: string): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

/**
 * True when the thread still has an in-flight / unsettled turn:
 * session mid-lifecycle ("starting"/"running"), a non-error session with an
 * activeTurnId, or a latestTurn still projected as "running".
 *
 * Runtime errors can retain the failed turn id for attribution even though the
 * session and turn are terminal, so an errored session's activeTurnId is stale.
 */
export function threadHasInFlightTurn(thread: {
  readonly session: Pick<OrchestrationSession, "status" | "activeTurnId"> | null;
  readonly latestTurn: Pick<OrchestrationLatestTurn, "state"> | null;
}): boolean {
  const session = thread.session;
  return (
    (session?.status !== "error" && session?.activeTurnId != null) ||
    session?.status === "starting" ||
    session?.status === "running" ||
    thread.latestTurn?.state === "running"
  );
}

export function checkpointRevertActiveTurnDetail(threadId: ThreadId): string {
  return `Thread '${threadId}' has an active turn. Interrupt the current turn before reverting checkpoints.`;
}

export const CHECKPOINT_REVERT_STARTED_ACTIVITY_KIND = "checkpoint.revert.started";
export const CHECKPOINT_REVERT_SUCCEEDED_ACTIVITY_KIND = "checkpoint.revert.succeeded";
export const CHECKPOINT_REVERT_FAILED_ACTIVITY_KIND = "checkpoint.revert.failed";

const CHECKPOINT_REVERT_LIFECYCLE_ACTIVITY_KINDS = new Set([
  CHECKPOINT_REVERT_STARTED_ACTIVITY_KIND,
  CHECKPOINT_REVERT_SUCCEEDED_ACTIVITY_KIND,
  CHECKPOINT_REVERT_FAILED_ACTIVITY_KIND,
]);

export function threadHasCheckpointRevertInProgress(thread: {
  readonly activities: ReadonlyArray<
    Pick<OrchestrationThreadActivity, "createdAt" | "id" | "kind" | "sequence">
  >;
}): boolean {
  const latestLifecycleActivity = thread.activities
    .filter((activity) => CHECKPOINT_REVERT_LIFECYCLE_ACTIVITY_KINDS.has(activity.kind))
    .toSorted(
      (left, right) =>
        (right.sequence ?? -1) - (left.sequence ?? -1) ||
        right.createdAt.localeCompare(left.createdAt) ||
        right.id.localeCompare(left.id),
    )
    .at(0);
  return latestLifecycleActivity?.kind === CHECKPOINT_REVERT_STARTED_ACTIVITY_KIND;
}

export function checkpointRevertInProgressDetail(threadId: ThreadId): string {
  return `Thread '${threadId}' has a checkpoint revert in progress. Wait for it to finish before starting a turn.`;
}

export function checkpointRevertDeleteInProgressDetail(threadId: ThreadId): string {
  return `Thread '${threadId}' has a checkpoint revert in progress. Wait for it to finish before deleting the thread.`;
}

export function findThreadById(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  return readModel.threads.find((thread) => thread.id === threadId);
}

export function findProjectById(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): OrchestrationProject | undefined {
  return readModel.projects.find((project) => project.id === projectId);
}

export function findSpaceById(
  readModel: OrchestrationReadModel,
  spaceId: SpaceId,
): OrchestrationSpace | undefined {
  return readModel.spaces.find((space) => space.id === spaceId);
}

export function listActiveSpaces(
  readModel: OrchestrationReadModel,
): ReadonlyArray<OrchestrationSpace> {
  return readModel.spaces
    .filter((space) => space.deletedAt === null)
    .toSorted((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
}

export function requireSpace(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly spaceId: SpaceId;
}): Effect.Effect<OrchestrationSpace, OrchestrationCommandInvariantError> {
  const space = findSpaceById(input.readModel, input.spaceId);
  if (space && space.deletedAt === null) {
    return Effect.succeed(space);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      space
        ? `Space '${input.spaceId}' was deleted and cannot handle command '${input.command.type}'.`
        : `Space '${input.spaceId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireSpaceAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly spaceId: SpaceId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  // Aggregate ids are durable event-stream identities, not recyclable row ids. A deleted
  // Space remains in the read model as a tombstone; recreating it would append a second
  // `space.created` lifecycle to the same aggregate and make replay semantics ambiguous.
  if (!findSpaceById(input.readModel, input.spaceId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Space '${input.spaceId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireSpaceNameAvailable(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly name: string;
  readonly excludeSpaceId?: SpaceId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const normalizedName = input.name.trim().toLowerCase();
  if (normalizedName === "void") {
    return Effect.fail(
      invariantError(input.command.type, "'Void' is reserved for unassigned projects."),
    );
  }
  const conflict = input.readModel.spaces.find(
    (space) =>
      space.deletedAt === null &&
      space.id !== input.excludeSpaceId &&
      space.name.trim().toLowerCase() === normalizedName,
  );
  if (!conflict) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(input.command.type, `A space named '${input.name}' already exists.`),
  );
}

export interface SpaceAssignmentWorkspacePaths {
  readonly homeDir: string;
  readonly chatWorkspaceRoot: string;
}

/**
 * Server half of the web's `isOrdinarySpaceProject` membership rule. Managed chat and
 * Studio containers are excluded by kind alone, but legacy Home chat containers kept
 * `kind: "project"` — they are recognizable by the reserved home/chat workspace root plus
 * their canonical "Home" title. Those containers are reachable from every Space, so they
 * must never belong to one. The decider rejects renaming this legacy row so the signal cannot
 * drift through supported commands.
 */
export function isLegacyHomeChatContainerRow(input: {
  readonly projectTitle: string;
  readonly projectWorkspaceRoot: string;
  readonly workspacePaths: SpaceAssignmentWorkspacePaths | undefined;
}): boolean {
  return isSharedLegacyHomeChatContainerRow({
    projectTitle: input.projectTitle,
    projectWorkspaceRoot: input.projectWorkspaceRoot,
    paths: {
      homeDir: input.workspacePaths?.homeDir ?? null,
      chatWorkspaceRoot: input.workspacePaths?.chatWorkspaceRoot ?? null,
    },
    comparisonOptions: { platform: process.platform },
  });
}

/**
 * Server half of the web's project partitioning: ordinary projects are the user-visible
 * ones. Managed chat and Studio containers are excluded by kind alone; the legacy Home
 * chat container kept `kind: "project"` and is recognized by its row shape instead.
 */
export function isOrdinaryProjectRow(input: {
  readonly projectKind: ProjectKind | undefined;
  readonly projectTitle: string;
  readonly projectWorkspaceRoot: string;
  readonly workspacePaths: SpaceAssignmentWorkspacePaths | undefined;
}): boolean {
  return isSharedOrdinaryProjectRow({
    projectKind: input.projectKind,
    projectTitle: input.projectTitle,
    projectWorkspaceRoot: input.projectWorkspaceRoot,
    paths: {
      homeDir: input.workspacePaths?.homeDir ?? null,
      chatWorkspaceRoot: input.workspacePaths?.chatWorkspaceRoot ?? null,
    },
    comparisonOptions: { platform: process.platform },
  });
}

/** The rejecting form for explicit assignment commands, where a bad target is an error. */
export function requireSpaceAssignableProject(input: {
  readonly command: OrchestrationCommand;
  readonly projectTitle: string;
  readonly projectWorkspaceRoot: string;
  readonly workspacePaths: SpaceAssignmentWorkspacePaths | undefined;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!isLegacyHomeChatContainerRow(input)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      "The Chats container is reachable from every space and cannot be assigned to one.",
    ),
  );
}

// Finds active projects by workspace root using the same comparison rules as import flows.
export function listActiveProjectsByWorkspaceRoot(
  readModel: OrchestrationReadModel,
  workspaceRoot: string,
  options?: { readonly kinds?: ReadonlySet<ProjectKind> },
): ReadonlyArray<OrchestrationProject> {
  const normalizedWorkspaceRoot = normalizeWorkspaceRootForComparison(workspaceRoot, {
    platform: process.platform,
  });
  const acceptedKinds = options?.kinds ?? new Set<ProjectKind>(["project"]);
  return readModel.projects.filter(
    (project) =>
      project.deletedAt === null &&
      acceptedKinds.has(project.kind ?? "project") &&
      normalizeWorkspaceRootForComparison(project.workspaceRoot, {
        platform: process.platform,
      }) === normalizedWorkspaceRoot,
  );
}

export function listThreadsByProjectId(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => thread.projectId === projectId);
}

export function requireProject(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  const project = findProjectById(input.readModel, input.projectId);
  if (project) {
    return Effect.succeed(project);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireProjectAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findProjectById(input.readModel, input.projectId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireProjectWorkspaceRootAvailable(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly workspaceRoot: string;
  readonly excludeProjectId?: ProjectId;
  readonly kinds?: ReadonlySet<ProjectKind>;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  // Skip the excluded project BEFORE picking, not after: if corrupt state ever leaves two
  // active owners on one root, the project being updated must not mask the other owner.
  const existingProject = listActiveProjectsByWorkspaceRoot(
    input.readModel,
    input.workspaceRoot,
    input.kinds ? { kinds: input.kinds } : undefined,
  ).find((project) => project.id !== input.excludeProjectId);
  if (!existingProject) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${existingProject.id}' already uses workspace root '${existingProject.workspaceRoot}'.`,
    ),
  );
}

export function requireProjectHasNoThreads(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const remainingThreads = listThreadsByProjectId(input.readModel, input.projectId).filter(
    (thread) => thread.deletedAt === null,
  );
  if (remainingThreads.length === 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' still has ${remainingThreads.length} thread${remainingThreads.length === 1 ? "" : "s"} and cannot be deleted.`,
    ),
  );
}

export function requireThread(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  const thread = findThreadById(input.readModel, input.threadId);
  if (thread && thread.deletedAt === null) {
    return Effect.succeed(thread);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      thread
        ? `Thread '${input.threadId}' was deleted and cannot handle command '${input.command.type}'.`
        : `Thread '${input.threadId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireApprovalNotResponded(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
  readonly requestId: ApprovalRequestId;
  readonly lifecycleGeneration?: string;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const thread = findThreadById(input.readModel, input.threadId);
  const interaction = thread?.pendingInteractions?.find(
    (entry) =>
      entry.interactionKind === "approval" &&
      entry.requestId === input.requestId &&
      (input.lifecycleGeneration === undefined ||
        entry.lifecycleGeneration === input.lifecycleGeneration),
  );
  if (
    interaction === undefined ||
    interaction.status === "pending" ||
    interaction.status === "retryable"
  ) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Approval request '${input.requestId}' on thread '${input.threadId}' was already answered.`,
    ),
  );
}

export function requireThreadAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findThreadById(input.readModel, input.threadId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireThreadArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt != null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' ${THREAD_NOT_ARCHIVED_INVARIANT_MARKER} '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt == null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is already archived and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireNonNegativeInteger(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly field: string;
  readonly value: number;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (Number.isInteger(input.value) && input.value >= 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.commandType,
      `${input.field} must be an integer greater than or equal to 0.`,
    ),
  );
}

export type ThreadResumePreconditionViolation =
  | "thread-archived"
  | "turn-completed"
  | "turn-in-flight";

export interface ThreadResumePrecondition {
  /** Turn in flight when the chat was recorded; null while the provider was still connecting. */
  readonly recordedTurnId: TurnId | null;
  readonly recordedAt: string;
}

/**
 * Shared by the boot-time quit-resume planner and the decider: a chat remembered
 * at quit is continued only while the thread is not archived, has nothing in
 * flight, and no turn finished on its own since the record was taken — neither
 * the recorded turn (it was running then, so it can only have completed later)
 * nor any newer one. A turn that completed before the record is the previous
 * turn of a chat that was still connecting and does not count; an interrupted or
 * errored turn is exactly what a continuation is for.
 */
export function threadResumePreconditionViolation(
  thread: {
    readonly archivedAt?: string | null | undefined;
    readonly session: Pick<OrchestrationSession, "status" | "activeTurnId"> | null;
    readonly latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "state" | "completedAt"> | null;
  },
  precondition: ThreadResumePrecondition,
): ThreadResumePreconditionViolation | null {
  if (thread.archivedAt != null) {
    return "thread-archived";
  }
  if (threadHasInFlightTurn(thread)) {
    return "turn-in-flight";
  }
  const latestTurn = thread.latestTurn;
  if (
    latestTurn !== null &&
    latestTurn.state === "completed" &&
    (latestTurn.turnId === precondition.recordedTurnId ||
      // A completed turn without a completion time is unknowable; stay on the
      // side of not sending an unwanted message.
      latestTurn.completedAt === null ||
      latestTurn.completedAt >= precondition.recordedAt)
  ) {
    return "turn-completed";
  }
  return null;
}

export function threadResumePreconditionDetail(
  threadId: ThreadId,
  violation: ThreadResumePreconditionViolation,
): string {
  switch (violation) {
    case "thread-archived":
      return `Thread '${threadId}' was archived after it was remembered for resume.`;
    case "turn-completed":
      return `Thread '${threadId}' finished on its own; there is nothing to resume.`;
    case "turn-in-flight":
      return `Thread '${threadId}' already has a turn in flight.`;
  }
}

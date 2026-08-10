// FILE: storeTestFixtures.ts
// Purpose: Shared builders for store facade, projection, and event reducer tests.
// Exports: Minimal normalized-state and orchestration payload fixtures.

import {
  DEFAULT_PROVIDER_PROFILE_ID,
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadActivity,
} from "@synara/contracts";

import { getThreadsFromState } from "./threadDerivation";
import type { AppState } from "./storeState";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";

export function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
      model: "gpt-5-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    envMode: "local",
    branch: null,
    worktreePath: null,
    forkSourceThreadId: null,
    sidechatSourceThreadId: null,
    handoff: null,
    ...overrides,
  };
}

export function makeDomainEvent<TType extends OrchestrationEvent["type"]>(
  type: TType,
  payload: Extract<OrchestrationEvent, { type: TType }>["payload"],
  overrides: Partial<Omit<Extract<OrchestrationEvent, { type: TType }>, "type" | "payload">> = {},
): Extract<OrchestrationEvent, { type: TType }> {
  const aggregateId =
    "threadId" in payload
      ? payload.threadId
      : "spaceId" in payload
        ? payload.spaceId
        : "projectId" in payload
          ? payload.projectId
          : ProjectId.makeUnsafe("project-1");
  const aggregateKind =
    "threadId" in payload ? "thread" : "spaceId" in payload ? "space" : "project";
  return {
    type,
    payload,
    sequence: overrides.sequence ?? 1,
    eventId: overrides.eventId ?? EventId.makeUnsafe(`event-${crypto.randomUUID()}`),
    aggregateKind: overrides.aggregateKind ?? aggregateKind,
    aggregateId,
    occurredAt: overrides.occurredAt ?? "2026-02-27T00:00:00.000Z",
    commandId: overrides.commandId ?? null,
    causationEventId: overrides.causationEventId ?? null,
    correlationId: overrides.correlationId ?? null,
    metadata: overrides.metadata ?? {},
    ...overrides,
  } as Extract<OrchestrationEvent, { type: TType }>;
}

export function makeActivity(overrides: {
  id?: string;
  createdAt?: string;
  kind?: string;
  summary?: string;
  tone?: OrchestrationThreadActivity["tone"];
  payload?: OrchestrationThreadActivity["payload"];
  turnId?: string;
  sequence?: number;
}): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(overrides.id ?? crypto.randomUUID()),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind ?? "tool.started",
    summary: overrides.summary ?? "Tool call",
    tone: overrides.tone ?? "tool",
    payload: overrides.payload ?? {},
    turnId: overrides.turnId ? TurnId.makeUnsafe(overrides.turnId) : null,
    ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}),
  };
}

export function makeState(thread: Thread): AppState {
  const {
    session,
    latestTurn,
    pendingSourceProposedPlan,
    messages,
    activities,
    proposedPlans,
    turnDiffSummaries,
    ...shell
  } = thread;
  return {
    spaces: [],
    projects: [makeProject()],
    sidebarThreadSummaryById: {},
    threadsHydrated: true,
    threadIds: [thread.id],
    threadShellById: { [thread.id]: shell },
    threadSessionById: { [thread.id]: session },
    threadTurnStateById: { [thread.id]: { latestTurn, pendingSourceProposedPlan } },
    messageIdsByThreadId: { [thread.id]: messages.map((message) => message.id) },
    messageByThreadId: {
      [thread.id]: Object.fromEntries(messages.map((message) => [message.id, message])),
    },
    activityIdsByThreadId: { [thread.id]: activities.map((activity) => activity.id) },
    activityByThreadId: {
      [thread.id]: Object.fromEntries(activities.map((activity) => [activity.id, activity])),
    },
    proposedPlanIdsByThreadId: { [thread.id]: proposedPlans.map((plan) => plan.id) },
    proposedPlanByThreadId: {
      [thread.id]: Object.fromEntries(proposedPlans.map((plan) => [plan.id, plan])),
    },
    turnDiffIdsByThreadId: { [thread.id]: turnDiffSummaries.map((summary) => summary.turnId) },
    turnDiffSummaryByThreadId: {
      [thread.id]: Object.fromEntries(
        turnDiffSummaries.map((summary) => [summary.turnId, summary]),
      ),
    },
  };
}

export function makeProject(
  overrides: Partial<AppState["projects"][number]> = {},
): AppState["projects"][number] {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    kind: "project",
    name: "Project",
    remoteName: "Project",
    folderName: "project",
    localName: null,
    cwd: "/tmp/project",
    defaultModelSelection: {
      provider: "codex",
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
      model: "gpt-5-codex",
    },
    expanded: true,
    spaceId: null,
    scripts: [],
    ...overrides,
  };
}

export function makeReadModelThread(overrides: Partial<OrchestrationReadModel["threads"][number]>) {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
      model: "gpt-5.3-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    envMode: "local",
    branch: null,
    worktreePath: null,
    forkSourceThreadId: null,
    sidechatSourceThreadId: null,
    latestTurn: null,
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    deletedAt: null,
    handoff: null,
    messages: [],
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    session: null,
    ...overrides,
  } satisfies OrchestrationReadModel["threads"][number];
}

export function makeReadModel(
  thread: OrchestrationReadModel["threads"][number],
): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: "2026-02-27T00:00:00.000Z",
    spaces: [],
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        kind: "project",
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          profileId: DEFAULT_PROVIDER_PROFILE_ID,
          model: "gpt-5.3-codex",
        },
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
        deletedAt: null,
        scripts: [],
        spaceId: null,
      },
    ],
    threads: [thread],
  };
}

export function makeShellSnapshot(thread: OrchestrationShellSnapshot["threads"][number]) {
  return {
    snapshotSequence: 2,
    updatedAt: "2026-02-27T00:01:00.000Z",
    spaces: [],
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          profileId: DEFAULT_PROVIDER_PROFILE_ID,
          model: "gpt-5.3-codex",
        },
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
        scripts: [],
        spaceId: null,
      },
    ],
    threads: [thread],
  } satisfies OrchestrationShellSnapshot;
}

export function makeReadModelProject(
  overrides: Partial<OrchestrationReadModel["projects"][number]>,
): OrchestrationReadModel["projects"][number] {
  return {
    id: ProjectId.makeUnsafe("project-1"),
    kind: "project",
    title: "Project",
    workspaceRoot: "/tmp/project",
    defaultModelSelection: {
      provider: "codex",
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
      model: "gpt-5.3-codex",
    },
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    deletedAt: null,
    scripts: [],
    spaceId: null,
    ...overrides,
  };
}

export const threadsOf = getThreadsFromState;

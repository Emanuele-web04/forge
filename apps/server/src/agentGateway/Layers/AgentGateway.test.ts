import { assert, describe, it } from "@effect/vitest";
import type {
  AutomationCreateInput,
  AutomationDefinition,
  AutomationUpdateInput,
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationProjectShell,
  OrchestrationThread,
  OrchestrationThreadShell,
  ProviderKind,
  ServerProviderStatus,
  ThreadId as ThreadIdType,
} from "@synara/contracts";
import {
  AutomationId,
  EventId,
  MessageId,
  ModelSelection,
  ProjectId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";

import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { AutomationService } from "../../automation/Services/AutomationService.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationEventDeliveryRepository } from "../../persistence/Services/OrchestrationEventDeliveries.ts";
import {
  ProviderRuntimeEventRepository,
  type PersistedProviderRuntimeEvent,
} from "../../persistence/Services/ProviderRuntimeEvents.ts";
import { ThreadDiagnosticsQuery } from "../../diagnostics/Services/ThreadDiagnosticsQuery.ts";
import type {
  DiagnosticThreadActivity,
  OperationalDiagnostic,
} from "../../diagnostics/Services/ThreadDiagnosticsQuery.ts";
import type { ProviderBlockingDeliveryEvidence } from "../../persistence/Services/OrchestrationEventDeliveries.ts";
import { ProviderDiscoveryService } from "../../provider/Services/ProviderDiscoveryService.ts";
import { ProviderHealth } from "../../provider/Services/ProviderHealth.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { AgentGateway } from "../Services/AgentGateway.ts";
import { AgentGatewayCredentials } from "../Services/AgentGatewayCredentials.ts";
import {
  AgentGatewayOperationRepository,
  type AgentGatewayOperationRecord,
} from "../Services/AgentGatewayOperationRepository.ts";
import { AgentGatewayLive } from "./AgentGateway.ts";
import { recordCreatedWorktreeInPlan } from "../operationPlan.ts";

const NOW = "2026-03-01T10:00:00.000Z";
const PROJECT_ID = ProjectId.makeUnsafe("project-1");

function makeProjectShell(
  scripts: OrchestrationProjectShell["scripts"] = [],
): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    kind: "project",
    title: "Demo project",
    workspaceRoot: "/tmp/demo",
    defaultModelSelection: null,
    scripts,
    isPinned: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeThreadShell(
  id: string,
  overrides?: Partial<OrchestrationThreadShell>,
): OrchestrationThreadShell {
  return {
    id: ThreadId.makeUnsafe(id),
    projectId: PROJECT_ID,
    title: `Thread ${id}`,
    modelSelection: { provider: "codex", model: "gpt-5.5" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    envMode: "local",
    branch: null,
    worktreePath: null,
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
    createBranchFlowCompleted: false,
    isPinned: false,
    parentThreadId: null,
    subagentAgentId: null,
    subagentNickname: null,
    subagentRole: null,
    forkSourceThreadId: null,
    sidechatSourceThreadId: null,
    lastKnownPr: null,
    latestTurn:
      id === "thread-parent"
        ? {
            turnId: TurnId.makeUnsafe("turn-parent-active"),
            state: "running",
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: null,
            assistantMessageId: null,
          }
        : null,
    latestUserMessageAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    handoff: null,
    session: null,
    ...overrides,
  };
}

function makeThreadDetail(shell: OrchestrationThreadShell): OrchestrationThread {
  return {
    ...shell,
    deletedAt: null,
    pinnedMessages: [],
    threadMarkers: [],
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
  };
}

interface GatewayHarness {
  readonly dispatched: Array<OrchestrationCommand>;
  readonly automationCreates: Array<AutomationCreateInput>;
  readonly automationUpdates: Array<AutomationUpdateInput>;
  readonly automationDeletes: Array<{ id: string }>;
  readonly automationMemoryUpdates: Array<{ automationId: string | null; content: string }>;
  readonly worktreeCreates: Array<{
    ref?: string;
    newBranch?: string;
    path?: string;
    copyChangesFrom?: string;
  }>;
  readonly gitExecutions: Array<{ operation: string; cwd: string; args: ReadonlyArray<string> }>;
  readonly fetchedPullRequests: number[];
  readonly fetchedPullRequestRepositories: Array<string | undefined>;
  readonly worktreeRemoves: Array<{ path: string }>;
  readonly branchDeletes: Array<{ branch: string }>;
  readonly setThreadDetail: (thread: OrchestrationThread) => void;
  readonly deleteThread: (threadId: string) => void;
  readonly setProjectionTurn: (input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly state: "pending" | "running" | "completed" | "error" | "interrupted";
    readonly assistantMessageId?: string | null;
  }) => void;
  readonly setProviderStatuses: (statuses: ReadonlyArray<ServerProviderStatus>) => void;
  readonly getOperationStatus: (callerTurnId: string) => string | null;
  readonly getOperationErrorCode: (callerTurnId: string) => string | null;
  readonly getWaitReadCounts: () => {
    readonly detailReads: number;
    readonly batchTurnReads: number;
  };
  readonly callTool: (input: {
    readonly token: string;
    readonly name: string;
    readonly args: Record<string, unknown>;
  }) => Effect.Effect<{ status: number; result: Record<string, unknown> | undefined }>;
  readonly postRaw: (input: {
    readonly authorizationHeader: string | undefined;
    readonly body: unknown;
  }) => Effect.Effect<{ status: number; body?: unknown }>;
}

function makeAutomationDefinition(
  overrides: Partial<AutomationDefinition> = {},
): AutomationDefinition {
  return {
    id: AutomationId.makeUnsafe("automation-1"),
    projectId: PROJECT_ID,
    sourceThreadId: ThreadId.makeUnsafe("thread-parent"),
    name: "Monitor children",
    prompt: "check children",
    schedule: { type: "interval", everySeconds: 300 },
    enabled: true,
    nextRunAt: NOW,
    modelSelection: { provider: "codex", model: "gpt-5.5" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    worktreeMode: "local",
    mode: "heartbeat",
    targetThreadId: ThreadId.makeUnsafe("thread-parent"),
    maxIterations: 50,
    stopOnError: true,
    completionPolicyVersion: 0,
    completionPolicyUpdatedAt: NOW,
    minimumIntervalSeconds: 60,
    maxRuntimeSeconds: 3600,
    retryPolicy: { type: "none" },
    misfirePolicy: "coalesce",
    acknowledgedRisks: ["local-checkout"],
    iterationCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...overrides,
  };
}

const VALID_TOKENS: Record<string, string> = {
  "token-parent": "thread-parent",
  "token-parent-claude": "thread-parent",
  "token-parent-readonly": "thread-parent",
  "token-ghost": "thread-ghost",
};

function makeHarnessLayer(
  threads: ReadonlyArray<OrchestrationThreadShell>,
  automationDefinitions: ReadonlyArray<AutomationDefinition> = [],
  options: {
    readonly threadDetails?: ReadonlyMap<string, OrchestrationThread>;
    readonly failDispatch?: (command: OrchestrationCommand) => boolean;
    readonly dispatchDelayMs?: number;
    readonly interruptedOperations?: ReadonlyArray<AgentGatewayOperationRecord>;
    readonly providerStatuses?: ReadonlyArray<ServerProviderStatus>;
    readonly existingBranches?: ReadonlyArray<string>;
    readonly existingWorktrees?: Readonly<Record<string, string>>;
    readonly verifiedOwnershipTokens?: ReadonlyArray<string>;
    readonly failRecordWorktreeOwnership?: boolean;
    readonly failRemoveWorktree?: boolean;
    readonly failDeleteBranch?: boolean;
    readonly failOperationComplete?: boolean;
    readonly pauseAfterReservation?: {
      readonly entered: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    };
    readonly pauseAfterOperationComplete?: {
      readonly entered: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    };
    readonly pauseAfterWorktreeCreate?: {
      readonly entered: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    };
    readonly pauseAfterDispatch?: {
      readonly commandType: OrchestrationCommand["type"];
      readonly entered: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    };
    readonly advanceParentTurnAfterDispatch?: {
      readonly commandType: OrchestrationCommand["type"];
      readonly turnId: string;
      readonly state?: "running" | "completed" | "interrupted";
    };
    readonly projectScripts?: OrchestrationProjectShell["scripts"];
    readonly extraProjects?: ReadonlyArray<OrchestrationProjectShell>;
    readonly diagnosticActivities?: ReadonlyArray<DiagnosticThreadActivity>;
    readonly diagnosticEvents?: ReadonlyArray<OrchestrationEvent>;
    readonly providerRuntimeEvents?: ReadonlyArray<PersistedProviderRuntimeEvent>;
    readonly operationalDiagnostics?: ReadonlyArray<OperationalDiagnostic>;
    readonly providerDeliveryBlockers?: ReadonlyArray<ProviderBlockingDeliveryEvidence>;
    readonly automationRuns?: ReadonlyArray<{
      readonly id: string;
      readonly automationId: AutomationDefinition["id"];
    }>;
  } = {},
) {
  const dispatched: Array<OrchestrationCommand> = [];
  const automationCreates: Array<AutomationCreateInput> = [];
  const automationMemoryUpdates: Array<{ automationId: string | null; content: string }> = [];
  const automationUpdates: Array<AutomationUpdateInput> = [];
  const automationDeletes: Array<{ id: string }> = [];
  const worktreeCreates: Array<{
    ref?: string;
    newBranch?: string;
    path?: string;
    copyChangesFrom?: string;
  }> = [];
  const gitExecutions: Array<{
    operation: string;
    cwd: string;
    args: ReadonlyArray<string>;
  }> = [];
  const fetchedPullRequests: number[] = [];
  const fetchedPullRequestRepositories: Array<string | undefined> = [];
  const worktreeRemoves: Array<{ path: string }> = [];
  const branchDeletes: Array<{ branch: string }> = [];
  const branchWorktreePaths = new Map<string, string | null>(
    (options.existingBranches ?? []).map((branch) => [branch, null]),
  );
  for (const [branch, path] of Object.entries(options.existingWorktrees ?? {})) {
    branchWorktreePaths.set(branch, path);
  }
  const verifiedOwnershipTokens = new Set(options.verifiedOwnershipTokens ?? []);

  const credentialsLayer = Layer.succeed(AgentGatewayCredentials, {
    mcpEndpointUrl: "http://127.0.0.1:3773/mcp",
    setListeningPort: () => undefined,
    issueSessionToken: (threadId: ThreadIdType) => `token-for-${threadId}`,
    verifySessionToken: (token: string) => VALID_TOKENS[token] ?? null,
    verifySession: (token: string) => {
      const threadId = VALID_TOKENS[token];
      return threadId
        ? {
            sessionKey: `session-for-${threadId}`,
            threadId: ThreadId.makeUnsafe(threadId),
            provider:
              token === "token-parent-claude" ? ("claudeAgent" as const) : ("codex" as const),
            issuedAt: 0,
            capabilities:
              token === "token-parent-readonly"
                ? new Set(["thread:read"] as const)
                : new Set([
                    "thread:read",
                    "thread:write",
                    "automation:write",
                    "diagnostics:read",
                  ] as const),
          }
        : null;
    },
    bindWriteAuthority: (token: string, turnId: string) => {
      const threadId = VALID_TOKENS[token];
      return threadId
        ? {
            sessionKey: `session-for-${threadId}`,
            threadId: ThreadId.makeUnsafe(threadId),
            provider:
              token === "token-parent-claude" ? ("claudeAgent" as const) : ("codex" as const),
            turnId,
          }
        : null;
    },
    verifyWriteAuthority: (authority) =>
      authority.sessionKey === `session-for-${authority.threadId}`,
    revokeSessionToken: () => undefined,
    connectionForThread: (threadId: ThreadIdType) => ({
      url: "http://127.0.0.1:3773/mcp",
      bearerToken: `token-for-${threadId}`,
    }),
    stdioProxy: { command: "node", args: ["/tmp/proxy.mjs"] },
  });

  const threadsById = new Map(threads.map((thread) => [thread.id as string, thread]));
  const threadDetailsById = new Map(options.threadDetails ?? []);
  const projectionTurnsByKey = new Map<
    string,
    {
      readonly threadId: string;
      readonly turnId: string;
      readonly state: "pending" | "running" | "completed" | "error" | "interrupted";
      readonly assistantMessageId: string | null;
    }
  >();
  let threadDetailReads = 0;
  let batchTurnReads = 0;

  const snapshotLayer = Layer.succeed(ProjectionSnapshotQuery, {
    getShellSnapshot: () =>
      Effect.succeed({
        snapshotSequence: 1,
        projects: [makeProjectShell(options.projectScripts), ...(options.extraProjects ?? [])],
        threads: [...threadsById.values()],
        updatedAt: NOW,
      }),
    getThreadShellById: (threadId: ThreadIdType) =>
      Effect.succeed(Option.fromNullishOr(threadsById.get(threadId as string))),
    getProjectShellById: (projectId: string) =>
      Effect.succeed(
        projectId === (PROJECT_ID as string)
          ? Option.some(makeProjectShell(options.projectScripts))
          : Option.none<OrchestrationProjectShell>(),
      ),
    getThreadDetailById: (threadId: ThreadIdType) =>
      Effect.sync(() => {
        threadDetailReads += 1;
        return Option.fromNullishOr(
          threadDetailsById.get(threadId as string) ??
            Option.getOrUndefined(
              Option.map(
                Option.fromNullishOr(threadsById.get(threadId as string)),
                makeThreadDetail,
              ),
            ),
        );
      }),
  } as unknown as (typeof ProjectionSnapshotQuery)["Service"]);

  const diagnosticsLayer = Layer.succeed(ThreadDiagnosticsQuery, {
    getActivityCoverage: (threadId: string) =>
      Effect.succeed({
        highWaterSequence: Math.max(
          0,
          ...(options.diagnosticActivities ?? [])
            .filter((activity) => activity.threadId === threadId)
            .map((activity) => activity.sequence),
        ),
        unsequencedCount: 0,
      }),
    listActivities: (input: {
      threadId: string;
      throughSequenceInclusive?: number;
      beforeSequenceExclusive?: number;
      limit: number;
      turnId?: string;
      kinds?: ReadonlyArray<string>;
    }) =>
      Effect.succeed(
        (options.diagnosticActivities ?? [])
          .filter((activity) => activity.threadId === input.threadId)
          .filter(
            (activity) =>
              activity.sequence <= (input.throughSequenceInclusive ?? Number.MAX_SAFE_INTEGER),
          )
          .filter(
            (activity) =>
              activity.sequence < (input.beforeSequenceExclusive ?? Number.MAX_SAFE_INTEGER),
          )
          .filter((activity) => input.turnId === undefined || activity.turnId === input.turnId)
          .filter((activity) => input.kinds === undefined || input.kinds.includes(activity.kind))
          .toSorted((left, right) => right.sequence - left.sequence)
          .slice(0, input.limit),
      ),
    recordOperationalDiagnostic: () => Effect.void,
    listOperationalDiagnostics: (input: { threadId: string; limit: number }) =>
      Effect.succeed(
        (options.operationalDiagnostics ?? [])
          .filter((incident) => incident.threadId === input.threadId)
          .slice(0, input.limit),
      ),
  });
  const eventStoreLayer = Layer.succeed(OrchestrationEventStore, {
    append: () => Effect.die("append is not used by the gateway harness"),
    getHighWaterSequence: () => Effect.succeed(0),
    getThreadHighWaterSequence: (threadId: string) =>
      Effect.succeed(
        Math.max(
          0,
          ...(options.diagnosticEvents ?? [])
            .filter((event) => event.aggregateId === threadId)
            .map((event) => event.sequence),
        ),
      ),
    readThreadEvents: (input: {
      threadId: string;
      throughSequenceInclusive: number;
      beforeSequenceExclusive?: number;
      limit: number;
      eventTypes?: ReadonlyArray<string>;
    }) =>
      Effect.succeed(
        (options.diagnosticEvents ?? [])
          .filter((event) => event.aggregateId === input.threadId)
          .filter((event) => event.sequence <= input.throughSequenceInclusive)
          .filter(
            (event) => event.sequence < (input.beforeSequenceExclusive ?? Number.MAX_SAFE_INTEGER),
          )
          .filter(
            (event) => input.eventTypes === undefined || input.eventTypes.includes(event.type),
          )
          .toSorted((left, right) => right.sequence - left.sequence)
          .slice(0, input.limit),
      ),
    readFromSequence: () => Stream.empty,
    readAll: () => Stream.empty,
  });
  const eventDeliveriesLayer = Layer.succeed(OrchestrationEventDeliveryRepository, {
    listBlockingDeliveries: (input: { threadId?: string; limit: number }) =>
      Effect.succeed(
        (options.providerDeliveryBlockers ?? [])
          .filter((blocker) => input.threadId === undefined || blocker.threadId === input.threadId)
          .slice(0, input.limit),
      ),
  } as unknown as (typeof OrchestrationEventDeliveryRepository)["Service"]);
  const providerRuntimeEventsLayer = Layer.succeed(ProviderRuntimeEventRepository, {
    getThreadCoverage: (threadId: string) => {
      const events = (options.providerRuntimeEvents ?? []).filter(
        (row) => row.event.threadId === threadId,
      );
      return Effect.succeed({
        retainedCount: events.length,
        oldestSequence: events.length === 0 ? null : Math.min(...events.map((row) => row.sequence)),
        highWaterSequence: Math.max(0, ...events.map((row) => row.sequence)),
      });
    },
    readThreadEvents: (input: {
      threadId: string;
      throughSequenceInclusive: number;
      beforeSequenceExclusive?: number;
      limit: number;
      turnId?: string;
      eventTypes?: ReadonlyArray<string>;
    }) =>
      Effect.succeed(
        (options.providerRuntimeEvents ?? [])
          .filter((row) => row.event.threadId === input.threadId)
          .filter((row) => row.sequence <= input.throughSequenceInclusive)
          .filter(
            (row) => row.sequence < (input.beforeSequenceExclusive ?? Number.MAX_SAFE_INTEGER),
          )
          .filter((row) => input.turnId === undefined || row.event.turnId === input.turnId)
          .filter(
            (row) => input.eventTypes === undefined || input.eventTypes.includes(row.event.type),
          )
          .toSorted((left, right) => right.sequence - left.sequence)
          .slice(0, input.limit),
      ),
  } as unknown as (typeof ProviderRuntimeEventRepository)["Service"]);

  const engineLayer = Layer.succeed(OrchestrationEngineService, {
    dispatch: (command: OrchestrationCommand) =>
      Effect.sleep(options.dispatchDelayMs ?? 0).pipe(
        Effect.flatMap(() =>
          Effect.suspend(() => {
            dispatched.push(command);
            const advancedTurnState = options.advanceParentTurnAfterDispatch?.state ?? "running";
            if (
              options.advanceParentTurnAfterDispatch?.commandType === command.type &&
              (threadsById.get("thread-parent")?.latestTurn?.turnId !==
                options.advanceParentTurnAfterDispatch.turnId ||
                threadsById.get("thread-parent")?.latestTurn?.state !== advancedTurnState)
            ) {
              threadsById.set(
                "thread-parent",
                makeThreadShell("thread-parent", {
                  latestTurn: {
                    turnId: TurnId.makeUnsafe(options.advanceParentTurnAfterDispatch.turnId),
                    state: advancedTurnState,
                    requestedAt: NOW,
                    startedAt: NOW,
                    completedAt: advancedTurnState === "running" ? null : NOW,
                    assistantMessageId: null,
                  },
                }),
              );
            }
            const result = options.failDispatch?.(command)
              ? Effect.fail(new Error("injected dispatch failure"))
              : Effect.succeed({ sequence: dispatched.length });
            if (options.pauseAfterDispatch?.commandType !== command.type) return result;
            return Deferred.succeed(options.pauseAfterDispatch.entered, undefined).pipe(
              Effect.andThen(Deferred.await(options.pauseAfterDispatch.release)),
              Effect.andThen(result),
            );
          }),
        ),
      ),
  } as unknown as (typeof OrchestrationEngineService)["Service"]);

  const automationLayer = Layer.succeed(AutomationService, {
    create: (input: AutomationCreateInput) =>
      Effect.sync(() => {
        automationCreates.push(input);
        return {
          ...input,
          id: "automation-1",
          enabled: input.enabled ?? true,
          nextRunAt: NOW,
          completionPolicyVersion: 0,
          completionPolicyUpdatedAt: NOW,
          iterationCount: 0,
          createdAt: NOW,
          updatedAt: NOW,
          archivedAt: null,
        };
      }),
    update: (input: AutomationUpdateInput) =>
      Effect.sync(() => {
        automationUpdates.push(input);
        return { id: input.id };
      }),
    delete: (input: { id: string }) =>
      Effect.sync(() => {
        automationDeletes.push(input);
      }),
    list: (input?: { projectId?: string; includeArchived?: boolean }) =>
      Effect.succeed({
        definitions: automationDefinitions
          .filter((definition) =>
            input?.projectId ? definition.projectId === input.projectId : true,
          )
          .filter((definition) => (input?.includeArchived ? true : definition.archivedAt === null)),
        runs: [],
        memories: [],
      }),
    listRunsForDefinition: (input: { automationId: AutomationDefinition["id"]; limit: number }) =>
      Effect.succeed(
        (options.automationRuns ?? [])
          .filter((run) => run.automationId === input.automationId)
          .slice(0, input.limit),
      ),
    getMemory: () => Effect.succeed(null),
    updateMemory: (input: { automationId: string | null; content: string }) =>
      Effect.sync(() => {
        automationMemoryUpdates.push({ automationId: input.automationId, content: input.content });
        return {
          automationId: input.automationId ?? "automation-1",
          content: input.content,
          updatedAt: NOW,
        };
      }),
  } as unknown as (typeof AutomationService)["Service"]);

  const gitLayer = Layer.succeed(GitCore, {
    withMutation: (_cwd: string, effect: Effect.Effect<unknown, unknown, unknown>) => effect,
    execute: (input: { operation: string; cwd: string; args: ReadonlyArray<string> }) =>
      Effect.sync(() => {
        gitExecutions.push(input);
        return {
          code: 0,
          stdout: "0123456789abcdef0123456789abcdef01234567\n",
          stderr: "",
        };
      }),
    statusDetails: () => Effect.succeed({ isRepo: true, branch: "main" }),
    listBranches: () =>
      Effect.succeed({
        isRepo: true,
        hasOriginRemote: false,
        branches: [...branchWorktreePaths].map(([name, worktreePath]) => ({
          name,
          current: false,
          isDefault: false,
          worktreePath,
        })),
      }),
    createWorktree: (input: { newBranch?: string; path?: string }) =>
      Effect.gen(function* () {
        worktreeCreates.push(input);
        if (options.pauseAfterWorktreeCreate) {
          yield* Deferred.succeed(options.pauseAfterWorktreeCreate.entered, undefined);
          yield* Deferred.await(options.pauseAfterWorktreeCreate.release);
        }
        return {
          worktree: {
            path: input.path ?? `/tmp/worktrees/${input.newBranch ?? "generated"}`,
            branch: input.newBranch ?? "generated",
          },
        };
      }),
    createDetachedWorktree: (input: { ref: string; path?: string }) =>
      Effect.gen(function* () {
        worktreeCreates.push(input);
        if (options.pauseAfterWorktreeCreate) {
          yield* Deferred.succeed(options.pauseAfterWorktreeCreate.entered, undefined);
          yield* Deferred.await(options.pauseAfterWorktreeCreate.release);
        }
        return {
          worktree: {
            path: input.path ?? "/tmp/worktrees/generated/synara",
            ref: input.ref,
            branch: null,
          },
        };
      }),
    fetchPullRequestCommit: (input: {
      prNumber: number;
      expectedRepositoryNameWithOwner?: string;
    }) =>
      Effect.sync(() => {
        fetchedPullRequests.push(input.prNumber);
        fetchedPullRequestRepositories.push(input.expectedRepositoryNameWithOwner);
        return "fedcba9876543210fedcba9876543210fedcba98";
      }),
    recordWorktreeOwnership: (input: { path: string; branch: string | null; token: string }) =>
      options.failRecordWorktreeOwnership
        ? Effect.fail(new Error("injected ownership marker failure"))
        : Effect.sync(() => {
            verifiedOwnershipTokens.add(input.token);
            return {
              token: input.token,
              gitDir: `/tmp/git-admin/${input.token}`,
              branch: input.branch,
              head: `head:${input.branch ?? "detached"}`,
            };
          }),
    verifyWorktreeOwnership: (input: { proof: { token: string } }) =>
      Effect.succeed(
        verifiedOwnershipTokens.has(input.proof.token)
          ? { verified: true, reason: null }
          : { verified: false, reason: "ownership marker does not match" },
      ),
    removeWorktree: (input: { path: string }) =>
      Effect.sync(() => {
        worktreeRemoves.push(input);
      }).pipe(
        Effect.flatMap(() =>
          options.failRemoveWorktree
            ? Effect.fail(new Error("injected worktree removal failure"))
            : Effect.void,
        ),
      ),
    deleteBranch: (input: { branch: string }) =>
      Effect.sync(() => {
        branchDeletes.push(input);
      }).pipe(
        Effect.flatMap(() =>
          options.failDeleteBranch
            ? Effect.fail(new Error("injected branch deletion failure"))
            : Effect.void,
        ),
      ),
    deleteBranchIfUnchanged: (input: { branch: string }) =>
      Effect.sync(() => {
        branchDeletes.push(input);
      }).pipe(
        Effect.flatMap(() =>
          options.failDeleteBranch
            ? Effect.fail(new Error("injected branch deletion failure"))
            : Effect.void,
        ),
      ),
  } as unknown as (typeof GitCore)["Service"]);

  const providerDiscoveryLayer = Layer.succeed(ProviderDiscoveryService, {
    listModels: ({ provider }: { provider: string }) => {
      const modelsByProvider: Record<string, ReadonlyArray<Record<string, unknown>>> = {
        codex: [
          { slug: "gpt-5.5", name: "GPT-5.5" },
          {
            slug: "gpt-5.6-terra",
            name: "GPT-5.6 Terra",
            supportedReasoningEfforts: [
              { value: "low", label: "Low" },
              { value: "high", label: "High" },
            ],
          },
        ],
        claudeAgent: [{ slug: "claude-sonnet-5", name: "Claude Sonnet 5" }],
        cursor: [{ slug: "auto", name: "Auto" }],
        antigravity: [
          {
            slug: "Gemini 3.5 Flash",
            name: "Gemini 3.5 Flash",
            supportedReasoningEfforts: [
              { value: "low", label: "Low" },
              { value: "high", label: "High" },
            ],
          },
        ],
        grok: [{ slug: "grok-build", name: "Grok Build" }],
        droid: [{ slug: "claude-opus-4-8", name: "Claude Opus 4.8" }],
        kilo: [{ slug: "kilo/kilo-auto/free", name: "Kilo Auto" }],
        opencode: [{ slug: "openai/gpt-5", name: "OpenAI GPT-5" }],
        pi: [{ slug: "test-pi", name: "Test Pi" }],
      };
      return Effect.succeed({ models: modelsByProvider[provider] ?? [], source: "test" });
    },
  } as unknown as (typeof ProviderDiscoveryService)["Service"]);

  const providerKinds: ReadonlyArray<ProviderKind> = [
    "codex",
    "claudeAgent",
    "cursor",
    "antigravity",
    "grok",
    "droid",
    "kilo",
    "opencode",
    "pi",
  ];
  let providerStatuses =
    options.providerStatuses ??
    providerKinds.map(
      (provider): ServerProviderStatus => ({
        provider,
        status: "ready",
        available: true,
        authStatus: "authenticated",
        checkedAt: NOW,
      }),
    );
  const providerHealthLayer = Layer.succeed(ProviderHealth, {
    getStatuses: Effect.sync(() => providerStatuses),
    refresh: Effect.sync(() => providerStatuses),
    updateProvider: () => Effect.die("Provider updates are not used by gateway tests."),
    streamChanges: Stream.empty,
  } as unknown as (typeof ProviderHealth)["Service"]);

  const operationsByScope = new Map<string, AgentGatewayOperationRecord>();
  for (const operation of options.interruptedOperations ?? []) {
    operationsByScope.set(
      `${operation.callerThreadId}:${operation.callerTurnId}:${operation.operationKind}`,
      operation,
    );
  }
  const operationLayer = Layer.succeed(AgentGatewayOperationRepository, {
    reserve: (input: {
      operationId: string;
      callerThreadId: string;
      callerTurnId: string;
      operationKind: "create_threads";
      requestId: string;
      fingerprint: string;
      requestedCount: number;
      planJson: string;
      now: string;
    }) =>
      Effect.gen(function* () {
        const key = `${input.callerThreadId}:${input.callerTurnId}:${input.operationKind}`;
        const existing = operationsByScope.get(key);
        if (existing) {
          const kind =
            existing.requestId !== input.requestId
              ? "creation_plan_locked"
              : existing.fingerprint !== input.fingerprint
                ? "idempotency_conflict"
                : "replay";
          return { kind, operation: existing };
        }
        const operation: AgentGatewayOperationRecord = {
          ...input,
          status: "reserved",
          resultJson: null,
          errorJson: null,
          createdAt: input.now,
          updatedAt: input.now,
        };
        operationsByScope.set(key, operation);
        if (options.pauseAfterReservation) {
          yield* Deferred.succeed(options.pauseAfterReservation.entered, undefined);
          yield* Deferred.await(options.pauseAfterReservation.release);
        }
        return { kind: "reserved" as const, operation };
      }),
    markDispatching: ({ operationId, now }: { operationId: string; now: string }) =>
      Effect.sync(() => {
        for (const [key, operation] of operationsByScope) {
          if (operation.operationId !== operationId || operation.status !== "reserved") continue;
          operationsByScope.set(key, { ...operation, status: "dispatching", updatedAt: now });
          return true;
        }
        return false;
      }),
    recordWorktreeCreated: (input: {
      operationId: string;
      index: number;
      workspaceRoot: string;
      path: string;
      branch: string | null;
      token: string;
      gitDir: string;
      head: string;
      now: string;
    }) =>
      Effect.sync(() => {
        for (const [key, operation] of operationsByScope) {
          if (operation.operationId !== input.operationId || operation.status !== "dispatching") {
            continue;
          }
          operationsByScope.set(key, {
            ...operation,
            planJson: recordCreatedWorktreeInPlan({
              planJson: operation.planJson,
              ...input,
              recordedAt: input.now,
            }),
            updatedAt: input.now,
          });
          return true;
        }
        return false;
      }),
    markCompensating: ({ operationId, now }: { operationId: string; now: string }) =>
      Effect.sync(() => {
        for (const [key, operation] of operationsByScope) {
          if (operation.operationId === operationId) {
            operationsByScope.set(key, {
              ...operation,
              status: "compensating",
              updatedAt: now,
            });
          }
        }
      }),
    recordCompensationFailure: ({
      operationId,
      errorJson,
      now,
    }: {
      operationId: string;
      errorJson: string;
      now: string;
    }) =>
      Effect.sync(() => {
        for (const [key, operation] of operationsByScope) {
          if (
            operation.operationId === operationId &&
            (operation.status === "dispatching" || operation.status === "compensating")
          ) {
            operationsByScope.set(key, {
              ...operation,
              status: "compensating",
              errorJson,
              updatedAt: now,
            });
          }
        }
      }),
    complete: ({
      operationId,
      resultJson,
      now,
    }: {
      operationId: string;
      resultJson: string;
      now: string;
    }) => {
      if (options.failOperationComplete) {
        return Effect.fail(new Error("injected operation completion failure"));
      }
      return Effect.gen(function* () {
        yield* Effect.sync(() => {
          for (const [key, operation] of operationsByScope) {
            if (operation.operationId === operationId) {
              operationsByScope.set(key, {
                ...operation,
                status: "completed",
                resultJson,
                updatedAt: now,
              });
            }
          }
        });
        if (options.pauseAfterOperationComplete) {
          yield* Deferred.succeed(options.pauseAfterOperationComplete.entered, undefined);
          yield* Deferred.await(options.pauseAfterOperationComplete.release);
        }
      });
    },
    fail: ({
      operationId,
      errorJson,
      now,
    }: {
      operationId: string;
      errorJson: string;
      now: string;
    }) =>
      Effect.sync(() => {
        for (const [key, operation] of operationsByScope) {
          if (operation.operationId === operationId) {
            operationsByScope.set(key, {
              ...operation,
              status: "failed",
              errorJson,
              updatedAt: now,
            });
          }
        }
      }),
    getById: (operationId: string) =>
      Effect.sync(
        () =>
          [...operationsByScope.values()].find(
            (operation) => operation.operationId === operationId,
          ) ?? null,
      ),
    getByScope: (input: {
      callerThreadId: string;
      callerTurnId: string;
      operationKind: "create_threads";
    }) =>
      Effect.sync(
        () =>
          operationsByScope.get(
            `${input.callerThreadId}:${input.callerTurnId}:${input.operationKind}`,
          ) ?? null,
      ),
    listNonTerminal: () =>
      Effect.sync(() =>
        [...operationsByScope.values()].filter(
          (operation) =>
            operation.status === "reserved" ||
            operation.status === "dispatching" ||
            operation.status === "compensating",
        ),
      ),
  });

  const readProjectionTurn = (threadId: string, turnId: string) => {
    const pinned = projectionTurnsByKey.get(`${threadId}:${turnId}`);
    if (pinned) {
      return {
        threadId: ThreadId.makeUnsafe(pinned.threadId),
        turnId: TurnId.makeUnsafe(pinned.turnId),
        pendingMessageId: null,
        sourceProposedPlanThreadId: null,
        sourceProposedPlanId: null,
        assistantMessageId:
          pinned.assistantMessageId === null
            ? null
            : MessageId.makeUnsafe(pinned.assistantMessageId),
        state: pinned.state,
        requestedAt: NOW,
        startedAt: pinned.state === "pending" ? null : NOW,
        completedAt:
          pinned.state === "completed" || pinned.state === "error" || pinned.state === "interrupted"
            ? NOW
            : null,
        checkpointTurnCount: null,
        checkpointRef: null,
        checkpointStatus: null,
        checkpointFiles: [],
      };
    }
    const thread = threadsById.get(threadId);
    const turn = thread?.latestTurn;
    return turn?.turnId === turnId
      ? {
          threadId: ThreadId.makeUnsafe(threadId),
          turnId: TurnId.makeUnsafe(turnId),
          pendingMessageId: null,
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          assistantMessageId: turn.assistantMessageId,
          state: turn.state,
          requestedAt: turn.requestedAt,
          startedAt: turn.startedAt,
          completedAt: turn.completedAt,
          checkpointTurnCount: null,
          checkpointRef: null,
          checkpointStatus: null,
          checkpointFiles: [],
        }
      : undefined;
  };
  const projectionTurnsLayer = Layer.succeed(ProjectionTurnRepository, {
    getByTurnId: ({ threadId, turnId }: { threadId: string; turnId: string }) =>
      Effect.succeed(Option.fromNullishOr(readProjectionTurn(threadId, turnId))),
    getManyByTurnId: (input: ReadonlyArray<{ threadId: string; turnId: string }>) =>
      Effect.sync(() => {
        batchTurnReads += 1;
        return input.flatMap(({ threadId, turnId }) => {
          const turn = readProjectionTurn(threadId, turnId);
          return turn ? [turn] : [];
        });
      }),
    getManyWaitSnapshot: (input: {
      readonly threadIds: ReadonlyArray<string>;
      readonly turns: ReadonlyArray<{ threadId: string; turnId: string }>;
    }) =>
      Effect.sync(() => {
        batchTurnReads += 1;
        return {
          existingThreadIds: input.threadIds.filter((threadId) => threadsById.has(threadId)),
          turns: input.turns.flatMap(({ threadId, turnId }) => {
            const turn = readProjectionTurn(threadId, turnId);
            return turn ? [turn] : [];
          }),
        };
      }),
  } as unknown as (typeof ProjectionTurnRepository)["Service"]);

  const gatewayLayer = AgentGatewayLive.pipe(
    Layer.provide(credentialsLayer),
    Layer.provide(snapshotLayer),
    Layer.provide(engineLayer),
    Layer.provide(automationLayer),
    Layer.provide(gitLayer),
    Layer.provide(providerDiscoveryLayer),
    Layer.provide(providerHealthLayer),
    Layer.provide(ServerSettingsService.layerTest()),
    Layer.provide(operationLayer),
    Layer.provide(projectionTurnsLayer),
    Layer.provide(diagnosticsLayer),
    Layer.provide(eventStoreLayer),
    Layer.provide(eventDeliveriesLayer),
    Layer.provide(providerRuntimeEventsLayer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provide(NodeServices.layer),
  );

  const makeHarness = Effect.gen(function* () {
    const gateway = yield* AgentGateway;
    const postRaw: GatewayHarness["postRaw"] = (input) => gateway.handleMcpPost(input);
    const callTool: GatewayHarness["callTool"] = ({ token, name, args }) =>
      gateway
        .handleMcpPost({
          authorizationHeader: `Bearer ${token}`,
          body: {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          },
        })
        .pipe(
          Effect.map((response) => ({
            status: response.status,
            result: (response.body as { result?: Record<string, unknown> } | undefined)?.result,
          })),
        );
    return {
      dispatched,
      automationCreates,
      automationUpdates,
      automationDeletes,
      automationMemoryUpdates,
      worktreeCreates,
      gitExecutions,
      fetchedPullRequests,
      fetchedPullRequestRepositories,
      worktreeRemoves,
      branchDeletes,
      setThreadDetail: (thread) => {
        threadsById.set(thread.id, thread);
        threadDetailsById.set(thread.id, thread);
      },
      deleteThread: (threadId) => {
        threadsById.delete(threadId);
        threadDetailsById.delete(threadId);
      },
      setProjectionTurn: (input) => {
        projectionTurnsByKey.set(`${input.threadId}:${input.turnId}`, {
          threadId: input.threadId,
          turnId: input.turnId,
          state: input.state,
          assistantMessageId: input.assistantMessageId ?? null,
        });
      },
      setProviderStatuses: (statuses) => {
        providerStatuses = statuses;
      },
      getOperationStatus: (callerTurnId) =>
        [...operationsByScope.values()].find((operation) => operation.callerTurnId === callerTurnId)
          ?.status ?? null,
      getOperationErrorCode: (callerTurnId) => {
        const errorJson = [...operationsByScope.values()].find(
          (operation) => operation.callerTurnId === callerTurnId,
        )?.errorJson;
        if (!errorJson) return null;
        return (JSON.parse(errorJson) as { code?: string }).code ?? null;
      },
      getWaitReadCounts: () => ({
        detailReads: threadDetailReads,
        batchTurnReads,
      }),
      callTool,
      postRaw,
    } satisfies GatewayHarness;
  });

  return { gatewayLayer, makeHarness };
}

function toolResultJson(result: Record<string, unknown> | undefined): Record<string, unknown> {
  const content = (result?.content as Array<{ text: string }> | undefined) ?? [];
  return JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
}

function isToolError(result: Record<string, unknown> | undefined): boolean {
  return result?.isError === true;
}

function toolErrorText(result: Record<string, unknown> | undefined): string {
  const content = (result?.content as Array<{ text: string }> | undefined) ?? [];
  return content[0]?.text ?? "";
}

describe("AgentGateway", () => {
  const baseThreads = [
    makeThreadShell("thread-parent"),
    makeThreadShell("thread-child", { parentThreadId: ThreadId.makeUnsafe("thread-parent") }),
    makeThreadShell("thread-archived", { archivedAt: NOW }),
  ];

  it.effect("rejects requests without a valid bearer token", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const missing = yield* harness.postRaw({
        authorizationHeader: undefined,
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      assert.equal(missing.status, 401);
      const invalid = yield* harness.postRaw({
        authorizationHeader: "Bearer nope",
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      assert.equal(invalid.status, 401);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects malformed JSON-RPC ids before invoking a tool", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.postRaw({
        authorizationHeader: "Bearer token-parent",
        body: {
          jsonrpc: "2.0",
          id: true,
          method: "tools/call",
          params: { name: "synara_set_thread_title", arguments: { title: "Must not run" } },
        },
      });
      assert.equal((response.body as { error?: { code: number } }).error?.code, -32600);
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects a provider-scoped token that no longer owns the thread", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.postRaw({
        authorizationHeader: "Bearer token-parent-claude",
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      assert.equal(response.status, 401);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect(
    "validates a token against the live session provider instead of the saved model",
    () => {
      const threads = baseThreads.map((thread) =>
        thread.id === "thread-parent"
          ? {
              ...thread,
              session: {
                threadId: thread.id,
                status: "running" as const,
                providerName: "claudeAgent",
                runtimeMode: thread.runtimeMode,
                activeTurnId: thread.latestTurn?.turnId ?? null,
                lastError: null,
                updatedAt: NOW,
              },
            }
          : thread,
      );
      const { gatewayLayer, makeHarness } = makeHarnessLayer(threads);
      return Effect.gen(function* () {
        const harness = yield* makeHarness;
        const response = yield* harness.postRaw({
          authorizationHeader: "Bearer token-parent-claude",
          body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
        });
        assert.equal(response.status, 200);
      }).pipe(Effect.provide(gatewayLayer));
    },
  );

  it.effect("enforces provider-session capabilities before destructive dispatch", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent-readonly",
        name: "synara_create_threads",
        args: {
          requestId: "readonly-create",
          threads: [
            {
              prompt: "should not run",
              target: { provider: "codex", model: "gpt-5.5" },
            },
          ],
        },
      });
      assert.equal(
        (toolResultJson(response.result).error as { code: string }).code,
        "capability_denied",
      );
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("requires the explicit diagnostics capability for forensic tools", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent-readonly",
        name: "synara_diagnose_thread",
        args: { threadId: "thread-parent" },
      });
      const error = toolResultJson(response.result).error as {
        code: string;
        details: { requiredCapability: string };
      };
      assert.equal(error.code, "capability_denied");
      assert.equal(error.details.requiredCapability, "diagnostics:read");
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects oversized and duplicate-id JSON-RPC batches before dispatch", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const request = (id: number, requestId: string) => ({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: {
          name: "synara_create_threads",
          arguments: {
            requestId,
            threads: [
              {
                prompt: requestId,
                target: { provider: "codex", model: "gpt-5.5" },
              },
            ],
          },
        },
      });

      const duplicate = yield* harness.postRaw({
        authorizationHeader: "Bearer token-parent",
        body: [request(7, "duplicate-a"), request(7, "duplicate-b")],
      });
      assert.equal(duplicate.status, 400);
      assert.include(JSON.stringify(duplicate.body), "Duplicate JSON-RPC request id");

      const oversized = yield* harness.postRaw({
        authorizationHeader: "Bearer token-parent",
        body: Array.from({ length: 51 }, (_, index) => request(index, `oversized-${index}`)),
      });
      assert.equal(oversized.status, 400);
      assert.include(JSON.stringify(oversized.body), "at most 50");
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("answers initialize with instructions and lists tools", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const init = yield* harness.postRaw({
        authorizationHeader: "Bearer token-parent",
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18" },
        },
      });
      assert.equal(init.status, 200);
      const initResult = (init.body as { result: Record<string, unknown> }).result;
      assert.equal(initResult.protocolVersion, "2025-06-18");
      assert.isString(initResult.instructions);

      const list = yield* harness.postRaw({
        authorizationHeader: "Bearer token-parent",
        body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
      });
      const tools = (
        list.body as {
          result: {
            tools: Array<{
              name: string;
              description?: string;
              inputSchema: { properties?: Record<string, unknown> };
            }>;
          };
        }
      ).result.tools;
      const names = tools.map((tool) => tool.name);
      assert.includeMembers(names, [
        "synara_context",
        "synara_capabilities",
        "synara_list_projects",
        "synara_list_threads",
        "synara_read_thread",
        "synara_read_thread_activity",
        "synara_read_thread_events",
        "synara_read_thread_runtime_events",
        "synara_diagnose_thread",
        "synara_wait_for_threads",
        "synara_create_threads",
        "synara_create_thread",
        "synara_send_message",
        "synara_interrupt_thread",
        "synara_set_thread_title",
        "synara_set_thread_archived",
        "synara_create_automation",
        "synara_list_automations",
        "synara_view_automation",
        "synara_update_automation",
        "synara_cancel_automation",
        "synara_update_automation_memory",
        "synara_report_automation_result",
      ]);
      const createThreadProperties = tools.find((tool) => tool.name === "synara_create_thread")
        ?.inputSchema.properties;
      assert.property(createThreadProperties, "baseRef");
      assert.notProperty(createThreadProperties, "baseBranch");
      assert.notProperty(createThreadProperties, "branchName");

      const createAutomation = tools.find((tool) => tool.name === "synara_create_automation");
      assert.include(createAutomation?.description ?? "", "self-contained brief");
      const createAutomationProperties = createAutomation?.inputSchema.properties as
        | Record<string, { description?: string }>
        | undefined;
      assert.include(
        createAutomationProperties?.name?.description ?? "",
        "3–8 word outcome-oriented",
      );
      assert.include(
        createAutomationProperties?.prompt?.description ?? "",
        "no assumed chat context",
      );
      assert.include(
        createAutomationProperties?.prompt?.description ?? "",
        "notifying the user versus staying silent",
      );
      const updateAutomationMemory = tools.find(
        (tool) => tool.name === "synara_update_automation_memory",
      );
      const reportAutomationResult = tools.find(
        (tool) => tool.name === "synara_report_automation_result",
      );
      assert.include(
        updateAutomationMemory?.description ?? "",
        'manual follow-up such as "continue"',
      );
      assert.include(
        reportAutomationResult?.description ?? "",
        'manual follow-up such as "continue"',
      );

      const updateAutomationProperties = tools.find(
        (tool) => tool.name === "synara_update_automation",
      )?.inputSchema.properties as Record<string, { description?: string }> | undefined;
      assert.equal(
        updateAutomationProperties?.name?.description,
        createAutomationProperties?.name?.description,
      );
      assert.equal(
        updateAutomationProperties?.prompt?.description,
        createAutomationProperties?.prompt?.description,
      );
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("lists only ordinary projects, excluding system-managed containers", () => {
    // ServerConfig.layerTest canonicalizes the home dir via realpath, so the legacy
    // Home row must use the same canonical form for the workspace-root match to hold.
    const homeDir = realpathSync(homedir());
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
      extraProjects: [
        {
          ...makeProjectShell(),
          id: ProjectId.makeUnsafe("project-chat-container"),
          kind: "chat",
          title: "che progetti ci sono in synara",
          workspaceRoot: `${homeDir}/Documents/Synara/2026-03-01/chat`,
        },
        {
          ...makeProjectShell(),
          id: ProjectId.makeUnsafe("project-studio-container"),
          kind: "studio",
          title: "Studio",
          workspaceRoot: `${homeDir}/Documents/Synara/Studio`,
        },
        {
          ...makeProjectShell(),
          id: ProjectId.makeUnsafe("project-legacy-home"),
          kind: "project",
          title: "Home",
          workspaceRoot: homeDir,
        },
      ],
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_list_projects",
        args: {},
      });
      const payload = toolResultJson(response.result);
      const projects = payload.projects as Array<{ projectId: string }>;
      assert.deepEqual(
        projects.map((project) => project.projectId),
        [PROJECT_ID as string],
      );
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("returns provider-specific target option keys before the model catalog", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_capabilities",
        args: {},
      });
      const payload = toolResultJson(response.result);
      const targetConstruction = payload.targetConstruction as Record<
        string,
        Record<string, unknown>
      >;

      assert.equal(targetConstruction.codex?.primaryOptionKey, "reasoningEffort");
      assert.deepEqual(
        (targetConstruction.codex?.exampleTarget as { options?: unknown } | undefined)?.options,
        {
          reasoningEffort: "medium",
        },
      );
      const codexOptionsByModel = targetConstruction.codex?.optionsByModel as
        | Record<string, Array<{ key: string; allowedValues: ReadonlyArray<unknown> }>>
        | undefined;
      assert.deepEqual(
        codexOptionsByModel?.["gpt-5.6-terra"]?.find((option) => option.key === "reasoningEffort")
          ?.allowedValues,
        ["low", "high"],
      );
      assert.equal(targetConstruction.claudeAgent?.primaryOptionKey, "effort");
      assert.deepEqual(
        (targetConstruction.claudeAgent?.exampleTarget as { options?: unknown } | undefined)
          ?.options,
        { effort: "low" },
      );
      const antigravity = targetConstruction.antigravity as {
        providerOptions: Array<{
          key: string;
          valueType: string;
          allowedValues: ReadonlyArray<unknown>;
          allowedValuesSource: string;
        }>;
        exampleTarget: { options: Record<string, unknown> };
        optionsByModel: Record<
          string,
          Array<{
            key: string;
            valueType: string;
            allowedValues: ReadonlyArray<unknown>;
            allowedValuesSource: string;
          }>
        >;
      };
      assert.deepEqual(antigravity.exampleTarget.options, { reasoningEffort: "low" });
      assert.deepEqual(
        antigravity.providerOptions.find((option) => option.key === "reasoningEffort"),
        {
          key: "reasoningEffort",
          valueType: "string",
          allowedValues: [],
          allowedValuesSource: "model-discovery",
        },
      );
      assert.deepEqual(
        antigravity.optionsByModel["Gemini 3.5 Flash"]?.find(
          (option) => option.key === "reasoningEffort",
        )?.allowedValues,
        ["low", "high"],
      );

      for (const construction of Object.values(targetConstruction)) {
        const exampleTarget = construction.exampleTarget;
        if (exampleTarget === null || exampleTarget === undefined) continue;
        assert.deepEqual(Schema.decodeUnknownSync(ModelSelection)(exampleTarget), exampleTarget);
      }

      const serialized = JSON.stringify(payload);
      assert.isBelow(serialized.indexOf('"targetConstruction"'), serialized.indexOf('"providers"'));
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("acknowledges notifications without a body", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.postRaw({
        authorizationHeader: "Bearer token-parent",
        body: { jsonrpc: "2.0", method: "notifications/initialized" },
      });
      assert.equal(response.status, 202);
      assert.isUndefined(response.body);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("lists threads hiding archived ones and marking the caller", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_list_threads",
        args: {},
      });
      const payload = toolResultJson(response.result);
      const threads = payload.threads as Array<Record<string, unknown>>;
      assert.equal(threads.length, 2);
      assert.isUndefined(threads.find((thread) => thread.threadId === "thread-archived"));
      const self = threads.find((thread) => thread.threadId === "thread-parent");
      assert.equal(self?.isSelf, true);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("reports the full matching count when the limit truncates the thread list", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_list_threads",
        args: { limit: 1 },
      });
      const payload = toolResultJson(response.result);
      const threads = payload.threads as Array<Record<string, unknown>>;
      assert.equal(threads.length, 1);
      assert.equal(payload.totalMatching, 2);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect(
    "filters thread discovery by provider, status, title, source, and update window",
    () => {
      const threads = [
        makeThreadShell("thread-parent", {
          title: "Investigate stream gap",
          creationSource: "synara_mcp",
          updatedAt: "2026-03-02T10:00:00.000Z",
          latestTurn: {
            turnId: TurnId.makeUnsafe("turn-running"),
            state: "running",
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: null,
            assistantMessageId: null,
          },
        }),
        makeThreadShell("thread-other", {
          title: "Unrelated task",
          modelSelection: { provider: "claudeAgent", model: "opus-4.8" },
          updatedAt: "2026-02-01T10:00:00.000Z",
        }),
      ];
      const { gatewayLayer, makeHarness } = makeHarnessLayer(threads);
      return Effect.gen(function* () {
        const harness = yield* makeHarness;
        const response = yield* harness.callTool({
          token: "token-parent",
          name: "synara_list_threads",
          args: {
            provider: "codex",
            status: "working",
            titleContains: "STREAM",
            creationSource: "synara_mcp",
            updatedAfter: "2026-03-01T00:00:00.000Z",
            updatedBefore: "2026-03-03T00:00:00.000Z",
          },
        });
        const payload = toolResultJson(response.result);
        assert.equal(payload.totalMatching, 1);
        assert.equal(
          (payload.threads as Array<{ threadId: string }>)[0]?.threadId,
          "thread-parent",
        );
      }).pipe(Effect.provide(gatewayLayer));
    },
  );

  it.effect("pages thread activity with an opaque stable cursor", () => {
    const activities: ReadonlyArray<DiagnosticThreadActivity> = [1, 2, 3].map((sequence) => ({
      activityId: `activity-${sequence}`,
      threadId: "thread-parent",
      turnId: "turn-parent",
      tone: "info",
      kind: "tool",
      summary: `activity ${sequence}`,
      payload: { sequence },
      sequence,
      createdAt: NOW,
    }));
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
      diagnosticActivities: activities,
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const first = toolResultJson(
        (yield* harness.callTool({
          token: "token-parent",
          name: "synara_read_thread_activity",
          args: { threadId: "thread-parent", limit: 1, includeDetails: true },
        })).result,
      );
      assert.equal((first.activities as Array<{ sequence: number }>)[0]?.sequence, 3);
      assert.isString(first.nextCursor);
      const second = toolResultJson(
        (yield* harness.callTool({
          token: "token-parent",
          name: "synara_read_thread_activity",
          args: { threadId: "thread-parent", limit: 1, cursor: first.nextCursor },
        })).result,
      );
      assert.equal((second.activities as Array<{ sequence: number }>)[0]?.sequence, 2);
      assert.deepInclude(second.coverage as Record<string, unknown>, {
        highWaterSequence: 3,
        sourceComplete: true,
      });
      const changedFilter = yield* harness.callTool({
        token: "token-parent",
        name: "synara_read_thread_activity",
        args: {
          threadId: "thread-parent",
          limit: 1,
          kinds: ["error"],
          cursor: first.nextCursor,
        },
      });
      assert.isTrue(isToolError(changedFilter.result));
      assert.include(toolErrorText(changedFilter.result), "not a valid activity cursor");
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("paginates coalesced message updates as one logical event", () => {
    const threadId = ThreadId.makeUnsafe("thread-parent");
    const messageEvents = Array.from({ length: 301 }, (_, index) => {
      const sequence = index + 2;
      return {
        sequence,
        type: "thread.message-sent",
        eventId: EventId.makeUnsafe(`event-message-${sequence}`),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: NOW,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          threadId,
          messageId: MessageId.makeUnsafe("message-streamed"),
          role: "assistant",
          text: `delta-${sequence}`,
          turnId: TurnId.makeUnsafe("turn-parent"),
          streaming: sequence !== 302,
          createdAt: NOW,
          updatedAt: NOW,
        },
      } as OrchestrationEvent;
    });
    const olderEvent = {
      sequence: 1,
      type: "thread.archived",
      eventId: EventId.makeUnsafe("event-archived-1"),
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: NOW,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: { threadId, archivedAt: NOW, updatedAt: NOW },
    } as OrchestrationEvent;
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
      diagnosticEvents: [olderEvent, ...messageEvents],
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const first = toolResultJson(
        (yield* harness.callTool({
          token: "token-parent",
          name: "synara_read_thread_events",
          args: { threadId, limit: 1 },
        })).result,
      );
      assert.deepInclude((first.events as Array<Record<string, unknown>>)[0] ?? {}, {
        sequence: 302,
        coalescedEventCount: 301,
      });
      assert.isString(first.nextCursor);

      const second = toolResultJson(
        (yield* harness.callTool({
          token: "token-parent",
          name: "synara_read_thread_events",
          args: { threadId, limit: 1, cursor: first.nextCursor },
        })).result,
      );
      assert.deepInclude((second.events as Array<Record<string, unknown>>)[0] ?? {}, {
        sequence: 1,
        type: "thread.archived",
      });
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("combines durable events, delivery blockers, and stream incidents in diagnosis", () => {
    const threadId = ThreadId.makeUnsafe("thread-parent");
    const events: ReadonlyArray<OrchestrationEvent> = [
      {
        sequence: 7,
        type: "thread.archived",
        eventId: EventId.makeUnsafe("event-diagnostic-7"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: NOW,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { threadId, archivedAt: NOW, updatedAt: NOW },
      },
    ];
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
      diagnosticEvents: events,
      providerRuntimeEvents: [
        {
          sequence: 9,
          event: {
            type: "runtime.error",
            eventId: EventId.makeUnsafe("runtime-event-diagnostic-9"),
            provider: "codex",
            threadId,
            turnId: TurnId.makeUnsafe("turn-parent"),
            createdAt: NOW,
            payload: { message: "stream failed" },
          },
        },
      ],
      operationalDiagnostics: [
        {
          sequence: 1,
          threadId: "thread-parent",
          source: "server",
          kind: "ws.stream-admission-rejected",
          severity: "warning",
          code: "THREAD_STREAM_CAPACITY_EXCEEDED",
          detail: { reason: "thread-capacity" },
          occurredAt: NOW,
        },
      ],
      providerDeliveryBlockers: [
        {
          consumerName: "provider-command-reactor.v1",
          eventSequence: 7,
          eventId: EventId.makeUnsafe("event-diagnostic-7"),
          eventType: "thread.turn-start-requested",
          occurredAt: NOW,
          threadId,
          state: "dead",
          attemptCount: 3,
          lastError: "provider failed",
          updatedAt: NOW,
          lastReconciliationOutcome: null,
          lastReconciledAt: null,
          lastReconciledBy: null,
          lastReconciliationNote: null,
        },
      ],
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const payload = toolResultJson(
        (yield* harness.callTool({
          token: "token-parent",
          name: "synara_diagnose_thread",
          args: { threadId: "thread-parent" },
        })).result,
      );
      assert.equal((payload.recentEvents as Array<{ sequence: number }>)[0]?.sequence, 7);
      assert.equal((payload.recentRuntimeEvents as Array<{ sequence: number }>)[0]?.sequence, 9);
      assert.lengthOf(payload.providerDeliveryBlockers as Array<unknown>, 1);
      assert.lengthOf(payload.operationalIncidents as Array<unknown>, 1);
      assert.includeMembers(
        (payload.findings as Array<{ code: string }>).map((finding) => finding.code),
        ["provider_delivery_blocked", "THREAD_STREAM_CAPACITY_EXCEEDED"],
      );
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("creates a standalone cross-provider thread and dispatches the initial turn", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_thread",
        args: { requestId: "create-grok", prompt: "analyze the feature", provider: "grok" },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      const payload = toolResultJson(response.result);
      assert.equal(payload.provider, "grok");
      assert.strictEqual("parentThreadId" in payload, false);

      assert.equal(harness.dispatched.length, 3);
      const create = harness.dispatched[0]!;
      assert.equal(create.type, "thread.create");
      if (create.type === "thread.create") {
        // Gateway-created threads are ordinary top-level threads, not subagents.
        assert.strictEqual("parentThreadId" in create, false);
        assert.strictEqual("subagentNickname" in create, false);
        assert.equal(create.modelSelection.provider, "grok");
        // Project and runtime mode default from the calling thread.
        assert.equal(create.projectId, PROJECT_ID);
        assert.equal(create.runtimeMode, "approval-required");
        // Same placeholder title flow as UI threads so the first-turn reactor
        // replaces it with a model-generated title.
        assert.equal(create.title, "analyze the feature");
      }
      const turn = harness.dispatched[1]!;
      assert.equal(turn.type, "thread.turn.start");
      if (turn.type === "thread.turn.start") {
        assert.equal(turn.dispatchOrigin, "agent");
        assert.equal(turn.message.text, "analyze the feature");
      }
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("starts explicit OpenCode and Kilo plan-agent targets in plan mode", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args: {
          requestId: "create-provider-plan-agents",
          threads: [
            {
              prompt: "plan the OpenCode work",
              target: {
                provider: "opencode",
                model: "openai/gpt-5",
                options: { agent: "plan" },
              },
            },
            {
              prompt: "plan the Kilo work",
              target: {
                provider: "kilo",
                model: "kilo/kilo-auto/free",
                options: { agent: "plan" },
              },
            },
          ],
        },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));

      const creates = harness.dispatched.filter((command) => command.type === "thread.create");
      const turns = harness.dispatched.filter((command) => command.type === "thread.turn.start");
      assert.lengthOf(creates, 2);
      assert.lengthOf(turns, 2);
      for (const command of [...creates, ...turns]) {
        assert.equal(command.interactionMode, "plan");
        assert.deepInclude(command.modelSelection ?? {}, {
          options: { agent: "plan" },
        });
      }
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("creates a detached worktree when environment=worktree", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_thread",
        args: {
          requestId: "create-worktree",
          prompt: "refactor module X",
          provider: "claudeAgent",
          environment: "worktree",
        },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      const payload = toolResultJson(response.result);
      assert.isNull(payload.branch);
      assert.equal(payload.worktreePath, harness.worktreeCreates[0]?.path);
      assert.equal(harness.worktreeCreates[0]?.ref, "0123456789abcdef0123456789abcdef01234567");
      const create = harness.dispatched[0]!;
      if (create.type === "thread.create") {
        assert.equal(create.envMode, "worktree");
        assert.isNull(create.branch);
        assert.equal(create.associatedWorktreeRef, "0123456789abcdef0123456789abcdef01234567");
      }
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("resolves an explicit HEAD from the caller's linked worktree", () => {
    const isolatedParent = makeThreadShell("thread-parent", {
      envMode: "worktree",
      branch: null,
      worktreePath: "/tmp/caller-worktree",
      associatedWorktreePath: "/tmp/caller-worktree",
      associatedWorktreeBranch: null,
      associatedWorktreeRef: "0123456789abcdef0123456789abcdef01234567",
    });
    const { gatewayLayer, makeHarness } = makeHarnessLayer([isolatedParent]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_thread",
        args: {
          requestId: "explicit-head-from-caller-worktree",
          prompt: "continue from this checkout",
          provider: "codex",
          environment: "worktree",
          baseRef: "HEAD",
        },
      });

      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      const resolution = harness.gitExecutions.find(
        (entry) => entry.operation === "AgentGateway.resolveWorktreeRef",
      );
      assert.equal(resolution?.cwd, "/tmp/caller-worktree");
      assert.equal(harness.worktreeCreates[0]?.copyChangesFrom, "/tmp/caller-worktree");
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("fetches a GitHub pull-request head without creating a local branch", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_thread",
        args: {
          requestId: "github-pr-head",
          prompt: "review the pull request",
          provider: "codex",
          environment: "worktree",
          baseRef: "https://github.com/example/repo/pull/425",
        },
      });

      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      assert.deepEqual(harness.fetchedPullRequests, [425]);
      assert.deepEqual(harness.fetchedPullRequestRepositories, ["example/repo"]);
      assert.equal(harness.worktreeCreates[0]?.ref, "fedcba9876543210fedcba9876543210fedcba98");
      assert.equal(harness.worktreeCreates[0]?.newBranch, undefined);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("resolves local refs containing pull path segments as Git revisions", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_thread",
        args: {
          requestId: "local-pull-path-ref",
          prompt: "continue from the local ref",
          provider: "codex",
          environment: "worktree",
          baseRef: "feature/pull/425",
        },
      });

      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      assert.deepEqual(harness.fetchedPullRequests, []);
      assert.deepEqual(
        harness.gitExecutions.find((entry) => entry.operation === "AgentGateway.resolveWorktreeRef")
          ?.args,
        ["rev-parse", "--verify", "--end-of-options", "feature/pull/425^{commit}"],
      );
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("allows one exact plan in a new active turn even when unrelated threads exist", () => {
    const crowded = [
      makeThreadShell("thread-parent"),
      ...Array.from({ length: 12 }, (_, index) => makeThreadShell(`thread-other-${index}`)),
    ];
    const { gatewayLayer, makeHarness } = makeHarnessLayer(crowded);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_thread",
        args: { requestId: "create-crowded", prompt: "one more", provider: "codex" },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      assert.equal(harness.dispatched.length, 3);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("compensates deterministic interrupted operations during gateway startup", () => {
    const interrupted: AgentGatewayOperationRecord = {
      operationId: "gateway:create:restart",
      callerThreadId: "thread-parent",
      callerTurnId: "turn-parent-active",
      operationKind: "create_threads",
      requestId: "restart-request",
      fingerprint: "restart-fingerprint",
      requestedCount: 1,
      planJson: JSON.stringify([
        {
          workspaceRoot: "/tmp/demo",
          environment: "local",
          newBranch: null,
          plannedWorktreePath: null,
          ownershipPreflightPassed: true,
          ids: {
            threadId: "agent:restart-child",
            compensateCommandId: "agent:restart-child:compensate-delete",
          },
        },
      ]),
      status: "dispatching",
      resultJson: null,
      errorJson: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const { gatewayLayer, makeHarness } = makeHarnessLayer(
      [
        ...baseThreads,
        makeThreadShell("agent:restart-child", {
          creationSource: "synara_mcp",
          sourceThreadId: ThreadId.makeUnsafe("thread-parent"),
          sourceTurnId: TurnId.makeUnsafe("turn-parent-active"),
          gatewayOperationId: "gateway:create:restart",
          gatewayOperationIndex: 0,
        }),
      ],
      [],
      { interruptedOperations: [interrupted] },
    );
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      assert.deepEqual(
        harness.dispatched.filter((command) => command.type === "thread.delete"),
        [
          {
            type: "thread.delete",
            commandId: "agent:restart-child:compensate-delete",
            threadId: "agent:restart-child",
          },
        ],
      );
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.create").length,
        0,
      );
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("does not compensate a reserved operation that never began dispatch", () => {
    const reserved: AgentGatewayOperationRecord = {
      operationId: "gateway:create:reserved",
      callerThreadId: "thread-parent",
      callerTurnId: "turn-parent-active",
      operationKind: "create_threads",
      requestId: "reserved-request",
      fingerprint: "reserved-fingerprint",
      requestedCount: 1,
      planJson: JSON.stringify([
        {
          workspaceRoot: "/tmp/demo",
          environment: "worktree",
          newBranch: "user/pre-existing",
          plannedWorktreePath: "/tmp/user-pre-existing",
          ownershipPreflightPassed: false,
          ids: {
            threadId: "agent:reserved-child",
            compensateCommandId: "agent:reserved-child:compensate-delete",
          },
        },
      ]),
      status: "reserved",
      resultJson: null,
      errorJson: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
      interruptedOperations: [reserved],
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      assert.equal(harness.dispatched.length, 0);
      assert.deepEqual(harness.worktreeRemoves, []);
      assert.deepEqual(harness.branchDeletes, []);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect(
    "does not remove worktree resources from the crash window before ownership was recorded",
    () => {
      const interrupted: AgentGatewayOperationRecord = {
        operationId: "gateway:create:unrecorded-worktree",
        callerThreadId: "thread-parent",
        callerTurnId: "turn-parent-active",
        operationKind: "create_threads",
        requestId: "unrecorded-worktree-request",
        fingerprint: "unrecorded-worktree-fingerprint",
        requestedCount: 1,
        planJson: JSON.stringify([
          {
            workspaceRoot: "/tmp/demo",
            environment: "worktree",
            newBranch: "agent/unrelated-after-crash",
            plannedWorktreePath: "/tmp/unrelated-after-crash",
            ownershipPreflightPassed: true,
            ids: {
              threadId: "agent:unrecorded-worktree-child",
              compensateCommandId: "agent:unrecorded-worktree-child:compensate-delete",
            },
          },
        ]),
        status: "dispatching",
        resultJson: null,
        errorJson: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
        interruptedOperations: [interrupted],
        existingWorktrees: {
          "agent/unrelated-after-crash": "/tmp/unrelated-after-crash",
        },
      });
      return Effect.gen(function* () {
        const harness = yield* makeHarness;
        assert.deepEqual(harness.worktreeRemoves, []);
        assert.deepEqual(harness.branchDeletes, []);
        assert.equal(harness.getOperationStatus("turn-parent-active"), "compensating");
      }).pipe(Effect.provide(gatewayLayer));
    },
  );

  it.effect(
    "refuses recorded cleanup when git registers the branch at a different worktree",
    () => {
      const plannedPath = process.cwd();
      const interrupted: AgentGatewayOperationRecord = {
        operationId: "gateway:create:mismatched-registration",
        callerThreadId: "thread-parent",
        callerTurnId: "turn-parent-active",
        operationKind: "create_threads",
        requestId: "mismatched-registration-request",
        fingerprint: "mismatched-registration-fingerprint",
        requestedCount: 1,
        planJson: JSON.stringify([
          {
            workspaceRoot: "/tmp/demo",
            environment: "worktree",
            newBranch: "agent/recorded-but-replaced",
            plannedWorktreePath: plannedPath,
            ownershipPreflightPassed: true,
            worktreeOwnership: {
              operationId: "gateway:create:mismatched-registration",
              path: plannedPath,
              branch: "agent/recorded-but-replaced",
              token: "ownership-mismatched-registration",
              gitDir: "/tmp/git-admin/mismatched-registration",
              head: "head:agent/recorded-but-replaced",
              recordedAt: NOW,
            },
            ids: {
              threadId: "agent:mismatched-registration-child",
              compensateCommandId: "agent:mismatched-registration-child:compensate-delete",
            },
          },
        ]),
        status: "dispatching",
        resultJson: null,
        errorJson: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
        interruptedOperations: [interrupted],
        existingWorktrees: {
          "agent/recorded-but-replaced": "/tmp/different-registration",
        },
      });
      return Effect.gen(function* () {
        const harness = yield* makeHarness;
        assert.deepEqual(harness.worktreeRemoves, []);
        assert.deepEqual(harness.branchDeletes, []);
        assert.equal(harness.getOperationStatus("turn-parent-active"), "compensating");
      }).pipe(Effect.provide(gatewayLayer));
    },
  );

  it.effect("refuses a same-path same-branch replacement without the ownership token", () => {
    const plannedPath = process.cwd();
    const interrupted: AgentGatewayOperationRecord = {
      operationId: "gateway:create:same-path-replacement",
      callerThreadId: "thread-parent",
      callerTurnId: "turn-parent-active",
      operationKind: "create_threads",
      requestId: "same-path-replacement-request",
      fingerprint: "same-path-replacement-fingerprint",
      requestedCount: 1,
      planJson: JSON.stringify([
        {
          workspaceRoot: "/tmp/demo",
          environment: "worktree",
          newBranch: "agent/same-path-replacement",
          plannedWorktreePath: plannedPath,
          ownershipPreflightPassed: true,
          worktreeOwnership: {
            operationId: "gateway:create:same-path-replacement",
            path: plannedPath,
            branch: "agent/same-path-replacement",
            token: "ownership-original-worktree",
            gitDir: "/tmp/git-admin/original-worktree",
            head: "head:agent/same-path-replacement",
            recordedAt: NOW,
          },
          ids: {
            threadId: "agent:same-path-replacement-child",
            compensateCommandId: "agent:same-path-replacement-child:compensate-delete",
          },
        },
      ]),
      status: "dispatching",
      resultJson: null,
      errorJson: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
      interruptedOperations: [interrupted],
      existingWorktrees: { "agent/same-path-replacement": plannedPath },
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      assert.deepEqual(harness.worktreeRemoves, []);
      assert.deepEqual(harness.branchDeletes, []);
      assert.equal(harness.getOperationStatus("turn-parent-active"), "compensating");
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("keeps recovery pending instead of deleting a reused branch with no worktree", () => {
    const interrupted: AgentGatewayOperationRecord = {
      operationId: "gateway:create:branch-cleanup",
      callerThreadId: "thread-parent",
      callerTurnId: "turn-parent-active",
      operationKind: "create_threads",
      requestId: "branch-cleanup-request",
      fingerprint: "branch-cleanup-fingerprint",
      requestedCount: 1,
      planJson: JSON.stringify([
        {
          workspaceRoot: "/tmp/demo",
          environment: "worktree",
          newBranch: "agent/owned-branch",
          plannedWorktreePath: "/tmp/missing-owned-worktree",
          ownershipPreflightPassed: true,
          worktreeOwnership: {
            operationId: "gateway:create:branch-cleanup",
            path: "/tmp/missing-owned-worktree",
            branch: "agent/owned-branch",
            token: "ownership-missing-worktree",
            gitDir: "/tmp/git-admin/missing-worktree",
            head: "head:agent/owned-branch",
            recordedAt: NOW,
          },
          ids: {
            threadId: "agent:branch-cleanup-child",
            compensateCommandId: "agent:branch-cleanup-child:compensate-delete",
          },
        },
      ]),
      status: "dispatching",
      resultJson: null,
      errorJson: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
      interruptedOperations: [interrupted],
      existingBranches: ["agent/owned-branch"],
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      assert.equal(harness.branchDeletes.length, 0);
      assert.equal(harness.worktreeRemoves.length, 0);
      assert.equal(harness.getOperationStatus("turn-parent-active"), "compensating");
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("removes only a clean worktree carrying the persisted ownership token", () => {
    const plannedPath = process.cwd();
    const interrupted: AgentGatewayOperationRecord = {
      operationId: "gateway:create:verified-owned-worktree",
      callerThreadId: "thread-parent",
      callerTurnId: "turn-parent-active",
      operationKind: "create_threads",
      requestId: "verified-owned-worktree-request",
      fingerprint: "verified-owned-worktree-fingerprint",
      requestedCount: 1,
      planJson: JSON.stringify([
        {
          workspaceRoot: "/tmp/demo",
          environment: "worktree",
          newBranch: "agent/verified-owned-worktree",
          plannedWorktreePath: plannedPath,
          ownershipPreflightPassed: true,
          worktreeOwnership: {
            operationId: "gateway:create:verified-owned-worktree",
            path: plannedPath,
            branch: "agent/verified-owned-worktree",
            token: "ownership-verified-owned-worktree",
            gitDir: "/tmp/git-admin/verified-owned-worktree",
            head: "head:agent/verified-owned-worktree",
            recordedAt: NOW,
          },
          ids: {
            threadId: "agent:verified-owned-worktree-child",
            compensateCommandId: "agent:verified-owned-worktree-child:compensate-delete",
          },
        },
      ]),
      status: "dispatching",
      resultJson: null,
      errorJson: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
      interruptedOperations: [interrupted],
      existingWorktrees: { "agent/verified-owned-worktree": plannedPath },
      verifiedOwnershipTokens: ["ownership-verified-owned-worktree"],
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      assert.deepEqual(
        harness.worktreeRemoves.map(({ path }) => path),
        [plannedPath],
      );
      assert.deepEqual(
        harness.branchDeletes.map(({ branch }) => branch),
        ["agent/verified-owned-worktree"],
      );
      assert.equal(harness.getOperationStatus("turn-parent-active"), "failed");
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("recovers a detached worktree without deleting any branch", () => {
    const plannedPath = process.cwd();
    const interrupted: AgentGatewayOperationRecord = {
      operationId: "gateway:create:detached-recovery",
      callerThreadId: "thread-parent",
      callerTurnId: "turn-parent-active",
      operationKind: "create_threads",
      requestId: "detached-recovery-request",
      fingerprint: "detached-recovery-fingerprint",
      requestedCount: 1,
      planJson: JSON.stringify([
        {
          workspaceRoot: "/tmp/demo",
          environment: "worktree",
          worktreeRef: "0123456789abcdef",
          newBranch: null,
          plannedWorktreePath: plannedPath,
          ownershipPreflightPassed: true,
          worktreeOwnership: {
            operationId: "gateway:create:detached-recovery",
            path: plannedPath,
            branch: null,
            token: "ownership-detached-recovery",
            gitDir: "/tmp/git-admin/detached-recovery",
            head: "0123456789abcdef",
            recordedAt: NOW,
          },
          ids: {
            threadId: "agent:detached-recovery-child",
            compensateCommandId: "agent:detached-recovery-child:compensate-delete",
          },
        },
      ]),
      status: "dispatching",
      resultJson: null,
      errorJson: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
      interruptedOperations: [interrupted],
      verifiedOwnershipTokens: ["ownership-detached-recovery"],
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      assert.deepEqual(
        harness.worktreeRemoves.map(({ path }) => path),
        [plannedPath],
      );
      assert.deepEqual(harness.branchDeletes, []);
      assert.equal(harness.getOperationStatus("turn-parent-active"), "failed");
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects deprecated branchName before reserving or creating resources", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
      existingBranches: ["agent/user-owned"],
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args: {
          requestId: "pre-existing-branch",
          threads: [
            {
              prompt: "must not reuse it",
              target: { provider: "codex", model: "gpt-5.5" },
              environment: "worktree",
              branchName: "agent/user-owned",
            },
          ],
        },
      });
      assert.isTrue(isToolError(response.result));
      assert.include(toolErrorText(response.result), '"branchName" is no longer supported');
      assert.equal(harness.dispatched.length, 0);
      assert.equal(harness.worktreeCreates.length, 0);
      assert.equal(harness.worktreeRemoves.length, 0);
      assert.equal(harness.branchDeletes.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects detached creation after the caller turn completed", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      makeThreadShell("thread-parent", {
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-parent-complete"),
          state: "completed",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: NOW,
          assistantMessageId: null,
        },
      }),
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args: {
          requestId: "detached-attempt",
          threads: [
            {
              prompt: "create too late",
              target: { provider: "codex", model: "gpt-5.5" },
            },
          ],
        },
      });
      assert.isTrue(isToolError(response.result));
      assert.equal(
        (toolResultJson(response.result).error as { code: string }).code,
        "caller_turn_inactive",
      );
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("compensates a child started while its ingress turn is interrupted", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
      advanceParentTurnAfterDispatch: {
        commandType: "thread.turn.start",
        turnId: "turn-parent-active",
        state: "interrupted",
      },
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.postRaw({
        authorizationHeader: "Bearer token-parent",
        body: [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "synara_create_threads",
              arguments: {
                requestId: "turn-a-plan",
                threads: [
                  {
                    prompt: "worker from turn A",
                    target: { provider: "codex", model: "gpt-5.5" },
                    environment: "worktree",
                  },
                ],
              },
            },
          },
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "synara_create_threads",
              arguments: {
                requestId: "must-not-use-turn-b",
                threads: [
                  {
                    prompt: "late worker",
                    target: { provider: "codex", model: "gpt-5.5" },
                  },
                ],
              },
            },
          },
        ],
      });

      const results = response.body as Array<{ result?: Record<string, unknown> }>;
      assert.equal(response.status, 200);
      assert.equal(
        (toolResultJson(results[0]?.result).error as { code: string }).code,
        "operation_failed",
      );
      assert.equal(
        (toolResultJson(results[1]?.result).error as { code: string }).code,
        "caller_turn_inactive",
      );
      assert.equal(harness.getOperationStatus("turn-parent-active"), "failed");
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.create").length,
        1,
      );
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.turn.start").length,
        1,
      );
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.delete").length,
        1,
      );
      assert.equal(harness.worktreeCreates.length, 1);
      assert.equal(harness.worktreeRemoves.length, 1);
      assert.equal(harness.branchDeletes.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects every destructive tool after the caller turn completes", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      makeThreadShell("thread-parent", {
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-parent-complete"),
          state: "completed",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: NOW,
          assistantMessageId: null,
        },
      }),
      makeThreadShell("thread-child"),
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const attempts = [
        {
          name: "synara_create_threads",
          args: {
            requestId: "late-batch",
            threads: [{ prompt: "late", target: { provider: "codex", model: "gpt-5.5" } }],
          },
        },
        {
          name: "synara_create_thread",
          args: { requestId: "late-single", prompt: "late", provider: "codex" },
        },
        {
          name: "synara_send_message",
          args: { threadId: "thread-child", message: "late" },
        },
        { name: "synara_interrupt_thread", args: { threadId: "thread-child" } },
        {
          name: "synara_set_thread_title",
          args: { threadId: "thread-child", title: "Late rename" },
        },
        {
          name: "synara_set_thread_archived",
          args: { threadId: "thread-child", archived: true },
        },
        {
          name: "synara_create_automation",
          args: { name: "late monitor", prompt: "late" },
        },
        {
          name: "synara_cancel_automation",
          args: { automationId: "automation-1" },
        },
      ];

      for (const attempt of attempts) {
        const response = yield* harness.callTool({ token: "token-parent", ...attempt });
        assert.equal(
          (toolResultJson(response.result).error as { code: string }).code,
          "caller_turn_inactive",
          attempt.name,
        );
      }
      assert.equal(harness.dispatched.length, 0);
      assert.deepEqual(harness.automationCreates, []);
      assert.deepEqual(harness.automationUpdates, []);
      assert.deepEqual(harness.automationDeletes, []);

      const read = yield* harness.callTool({
        token: "token-parent",
        name: "synara_list_threads",
        args: {},
      });
      assert.isFalse(isToolError(read.result), toolErrorText(read.result));
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("replays an identical exact batch without creating more threads", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const args = {
        requestId: "two-workers",
        threads: [
          { prompt: "worker one", target: { provider: "codex", model: "gpt-5.5" } },
          {
            prompt: "worker two",
            target: { provider: "claudeAgent", model: "claude-sonnet-5" },
          },
        ],
      };
      const first = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args,
      });
      harness.setProviderStatuses([
        {
          provider: "codex",
          status: "error",
          available: false,
          authStatus: "unauthenticated",
          checkedAt: NOW,
          message: "temporarily unavailable after dispatch",
        },
        {
          provider: "claudeAgent",
          status: "error",
          available: false,
          authStatus: "unauthenticated",
          checkedAt: NOW,
          message: "temporarily unavailable after dispatch",
        },
      ]);
      const replay = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args,
      });
      assert.isFalse(isToolError(first.result), toolErrorText(first.result));
      assert.isFalse(isToolError(replay.result), toolErrorText(replay.result));
      assert.deepEqual(
        toolResultJson(replay.result).threadIds,
        toolResultJson(first.result).threadIds,
      );
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.create").length,
        2,
      );
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.turn.start").length,
        2,
      );
      const creationRecaps = harness.dispatched.filter(
        (command) =>
          command.type === "thread.activity.append" &&
          command.activity.kind === "synara.threads.created",
      );
      assert.equal(creationRecaps.length, 1);
      const creationRecap = creationRecaps[0];
      assert.equal(creationRecap?.type, "thread.activity.append");
      if (creationRecap?.type === "thread.activity.append") {
        assert.equal(creationRecap.threadId, ThreadId.makeUnsafe("thread-parent"));
        assert.equal(creationRecap.activity.turnId, TurnId.makeUnsafe("turn-parent-active"));
        assert.deepInclude(creationRecap.activity.payload as Record<string, unknown>, {
          source: "synara_mcp",
          requestedCount: 2,
          createdCount: 2,
        });
      }
      const conflict = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args: {
          ...args,
          threads: [
            {
              prompt: "changed payload",
              target: { provider: "codex", model: "made-up-model" },
            },
          ],
        },
      });
      assert.equal(
        (toolResultJson(conflict.result).error as { code: string }).code,
        "idempotency_conflict",
      );
      const operationId = toolResultJson(first.result).operationId as string;
      const creates = harness.dispatched.filter((command) => command.type === "thread.create");
      assert.deepEqual(
        creates.map((command) => ({
          creationSource: command.creationSource,
          sourceThreadId: command.sourceThreadId,
          sourceTurnId: command.sourceTurnId,
          gatewayOperationId: command.gatewayOperationId,
          gatewayOperationIndex: command.gatewayOperationIndex,
          parentThreadId: command.parentThreadId,
        })),
        [0, 1].map((index) => ({
          creationSource: "synara_mcp" as const,
          sourceThreadId: ThreadId.makeUnsafe("thread-parent"),
          sourceTurnId: TurnId.makeUnsafe("turn-parent-active"),
          gatewayOperationId: operationId,
          gatewayOperationIndex: index,
          parentThreadId: undefined,
        })),
      );
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("coalesces concurrent identical creation calls onto one operation", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
      dispatchDelayMs: 15,
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const call = () =>
        harness.callTool({
          token: "token-parent",
          name: "synara_create_threads",
          args: {
            requestId: "concurrent-exact-plan",
            threads: [
              {
                prompt: "one exact worker",
                target: { provider: "codex", model: "gpt-5.5" },
                environment: "worktree",
              },
            ],
          },
        });
      const fibers = yield* Effect.forEach([call(), call()], (effect) =>
        effect.pipe(Effect.forkChild),
      );
      yield* TestClock.adjust("1 second");
      const responses = yield* Effect.forEach(fibers, (fiber) => Fiber.join(fiber));
      const first = responses[0]!;
      const second = responses[1]!;
      assert.isFalse(isToolError(first.result), toolErrorText(first.result));
      assert.isFalse(isToolError(second.result), toolErrorText(second.result));
      assert.deepEqual(toolResultJson(first.result), toolResultJson(second.result));
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.create").length,
        1,
      );
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.turn.start").length,
        1,
      );
      assert.equal(harness.worktreeCreates.length, 1);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("locks a second distinct creation plan in the same caller turn", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const create = (requestId: string, prompt: string) =>
        harness.callTool({
          token: "token-parent",
          name: "synara_create_threads",
          args: {
            requestId,
            threads: [{ prompt, target: { provider: "codex", model: "gpt-5.5" } }],
          },
        });
      yield* create("first-plan", "first");
      const second = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args: {
          requestId: "second-plan",
          threads: [
            {
              prompt: "invalid second plan",
              target: { provider: "codex", model: "made-up-model" },
            },
          ],
        },
      });
      assert.isTrue(isToolError(second.result));
      assert.equal(
        (toolResultJson(second.result).error as { code: string }).code,
        "creation_plan_locked",
      );
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.create").length,
        1,
      );
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects guessed Terra Low slugs before any dispatch", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args: {
          requestId: "bad-terra",
          threads: [
            {
              prompt: "inspect repo",
              target: { provider: "codex", model: "gpt-5.6-terra-low" },
            },
          ],
        },
      });
      assert.isTrue(isToolError(response.result));
      assert.equal(
        (toolResultJson(response.result).error as { code: string }).code,
        "model_unavailable",
      );
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects an unavailable or unauthenticated provider before dispatch", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
      providerStatuses: [
        {
          provider: "claudeAgent",
          status: "error",
          available: false,
          authStatus: "unauthenticated",
          checkedAt: NOW,
          message: "Claude is not authenticated.",
        },
      ],
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args: {
          requestId: "unavailable-provider",
          threads: [
            {
              prompt: "must not dispatch",
              target: { provider: "claudeAgent", model: "claude-sonnet-5" },
            },
          ],
        },
      });
      assert.equal(
        (toolResultJson(response.result).error as { code: string }).code,
        "provider_unavailable",
      );
      assert.equal(harness.dispatched.length, 0);
      assert.equal(harness.worktreeCreates.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("persists canonical Terra Low as model plus reasoning option", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args: {
          requestId: "terra-low",
          threads: [
            {
              prompt: "inspect repo",
              target: {
                provider: "codex",
                model: "gpt-5.6-terra",
                options: { reasoningEffort: "low" },
              },
            },
          ],
        },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      const create = harness.dispatched.find((command) => command.type === "thread.create");
      assert.equal(create?.type, "thread.create");
      if (create?.type === "thread.create") {
        assert.deepEqual(create.modelSelection, {
          provider: "codex",
          model: "gpt-5.6-terra",
          options: { reasoningEffort: "low" },
        });
      }
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("preflights the whole batch so one invalid target creates nothing", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args: {
          requestId: "atomic-preflight",
          threads: [
            { prompt: "valid", target: { provider: "codex", model: "gpt-5.5" } },
            {
              prompt: "invalid",
              target: { provider: "claudeAgent", model: "made-up-claude" },
            },
          ],
        },
      });
      assert.isTrue(isToolError(response.result));
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect(
    "safely removes a just-created worktree when its ownership marker cannot persist",
    () => {
      const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
        failRecordWorktreeOwnership: true,
      });
      return Effect.gen(function* () {
        const harness = yield* makeHarness;
        const response = yield* harness.callTool({
          token: "token-parent",
          name: "synara_create_threads",
          args: {
            requestId: "ownership-marker-failure",
            threads: [
              {
                prompt: "must not leak a worktree",
                target: { provider: "codex", model: "gpt-5.5" },
                environment: "worktree",
              },
            ],
          },
        });

        assert.equal(
          (toolResultJson(response.result).error as { code: string }).code,
          "operation_failed",
        );
        assert.equal(harness.worktreeCreates.length, 1);
        assert.equal(harness.worktreeRemoves.length, 1);
        assert.equal(harness.branchDeletes.length, 0);
        assert.equal(harness.dispatched.length, 0);
        assert.equal(harness.getOperationStatus("turn-parent-active"), "failed");
      }).pipe(Effect.provide(gatewayLayer));
    },
  );

  it.effect("keeps markerless creation retryable when provisional cleanup also fails", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
      failRecordWorktreeOwnership: true,
      failRemoveWorktree: true,
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args: {
          requestId: "ownership-marker-and-cleanup-failure",
          threads: [
            {
              prompt: "retain cleanup evidence",
              target: { provider: "codex", model: "gpt-5.5" },
              environment: "worktree",
            },
          ],
        },
      });

      const payload = toolResultJson(response.result);
      assert.equal((payload.error as { code: string }).code, "operation_failed");
      assert.equal(
        (payload.error as { details: { compensationPending: boolean } }).details
          .compensationPending,
        true,
      );
      assert.equal(harness.worktreeCreates.length, 1);
      assert.equal(harness.worktreeRemoves.length, 1);
      assert.equal(harness.branchDeletes.length, 0);
      assert.equal(harness.getOperationStatus("turn-parent-active"), "compensating");
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("claims and terminalizes a reservation before observing request interruption", () => {
    const reservationCreated = Deferred.makeUnsafe<void>();
    const releaseReservation = Deferred.makeUnsafe<void>();
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
      pauseAfterReservation: {
        entered: reservationCreated,
        release: releaseReservation,
      },
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const requestFiber = yield* harness
        .callTool({
          token: "token-parent",
          name: "synara_create_threads",
          args: {
            requestId: "interrupt-after-reservation",
            threads: [
              {
                prompt: "must not strand a reserved operation",
                target: { provider: "codex", model: "gpt-5.5" },
              },
            ],
          },
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(reservationCreated);
      const interruptFiber = yield* Fiber.interrupt(requestFiber).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(releaseReservation, undefined);
      yield* Fiber.join(interruptFiber);

      const exit = yield* Fiber.await(requestFiber);
      assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
      assert.equal(harness.worktreeCreates.length, 0);
      assert.equal(harness.dispatched.length, 0);
      assert.equal(harness.getOperationStatus("turn-parent-active"), "failed");
      assert.equal(harness.getOperationErrorCode("turn-parent-active"), "request_interrupted");
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("compensates a worktree when the MCP request fiber is interrupted mid-create", () => {
    const worktreeCreated = Deferred.makeUnsafe<void>();
    const releaseWorktreeCreate = Deferred.makeUnsafe<void>();
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
      pauseAfterWorktreeCreate: {
        entered: worktreeCreated,
        release: releaseWorktreeCreate,
      },
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const requestFiber = yield* harness
        .callTool({
          token: "token-parent",
          name: "synara_create_threads",
          args: {
            requestId: "interrupt-after-worktree-create",
            threads: [
              {
                prompt: "must compensate the interrupted worktree",
                target: { provider: "codex", model: "gpt-5.5" },
                environment: "worktree",
              },
            ],
          },
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(worktreeCreated);
      const interruptFiber = yield* Fiber.interrupt(requestFiber).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(releaseWorktreeCreate, undefined);
      yield* Fiber.join(interruptFiber);

      const exit = yield* Fiber.await(requestFiber);
      assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
      assert.equal(harness.worktreeCreates.length, 1);
      assert.equal(harness.worktreeRemoves.length, 1);
      assert.equal(harness.branchDeletes.length, 0);
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.create").length,
        0,
      );
      assert.equal(harness.getOperationStatus("turn-parent-active"), "failed");
      assert.equal(harness.getOperationErrorCode("turn-parent-active"), "request_interrupted");
    }).pipe(Effect.provide(gatewayLayer));
  });

  // Regression guard: with the setup script inside the uninterruptible creation
  // section, the interrupt below would stall for the script's full 30s runtime
  // and trip the test timeout instead of compensating promptly.
  it.effect("interrupts a long worktree setup script instead of waiting it out", () => {
    const worktreeCreated = Deferred.makeUnsafe<void>();
    const releaseWorktreeCreate = Deferred.makeUnsafe<void>();
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
      pauseAfterWorktreeCreate: {
        entered: worktreeCreated,
        release: releaseWorktreeCreate,
      },
      projectScripts: [
        {
          id: "setup",
          name: "Setup",
          command: 'node -e "setTimeout(() => {}, 30000)"',
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ],
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const requestFiber = yield* harness
        .callTool({
          token: "token-parent",
          name: "synara_create_threads",
          args: {
            requestId: "interrupt-during-setup-script",
            threads: [
              {
                prompt: "must not block interruption on the setup script",
                target: { provider: "codex", model: "gpt-5.5" },
                environment: "worktree",
              },
            ],
          },
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(worktreeCreated);
      const interruptFiber = yield* Fiber.interrupt(requestFiber).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(releaseWorktreeCreate, undefined);
      yield* Fiber.join(interruptFiber);

      const exit = yield* Fiber.await(requestFiber);
      assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
      assert.equal(harness.worktreeCreates.length, 1);
      assert.equal(harness.worktreeRemoves.length, 1);
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.create").length,
        0,
      );
      assert.equal(harness.getOperationStatus("turn-parent-active"), "failed");
      assert.equal(harness.getOperationErrorCode("turn-parent-active"), "request_interrupted");
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("compensates a created thread when its MCP request fiber is interrupted", () => {
    const threadCreated = Deferred.makeUnsafe<void>();
    const releaseThreadCreate = Deferred.makeUnsafe<void>();
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
      pauseAfterDispatch: {
        commandType: "thread.create",
        entered: threadCreated,
        release: releaseThreadCreate,
      },
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const requestFiber = yield* harness
        .callTool({
          token: "token-parent",
          name: "synara_create_threads",
          args: {
            requestId: "interrupt-after-thread-create",
            threads: [
              {
                prompt: "must compensate the interrupted child",
                target: { provider: "codex", model: "gpt-5.5" },
              },
            ],
          },
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(threadCreated);
      const interruptFiber = yield* Fiber.interrupt(requestFiber).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(releaseThreadCreate, undefined);
      yield* Fiber.join(interruptFiber);

      const exit = yield* Fiber.await(requestFiber);
      assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.create").length,
        1,
      );
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.turn.start").length,
        0,
      );
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.delete").length,
        1,
      );
      assert.equal(harness.getOperationStatus("turn-parent-active"), "failed");
      assert.equal(harness.getOperationErrorCode("turn-parent-active"), "request_interrupted");
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("keeps a completed operation committed when its request is interrupted", () => {
    const operationCompleted = Deferred.makeUnsafe<void>();
    const releaseCompletion = Deferred.makeUnsafe<void>();
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
      pauseAfterOperationComplete: {
        entered: operationCompleted,
        release: releaseCompletion,
      },
    });
    const request = {
      token: "token-parent",
      name: "synara_create_threads",
      args: {
        requestId: "interrupt-after-operation-complete",
        threads: [
          {
            prompt: "keep the committed child",
            target: { provider: "codex", model: "gpt-5.5" },
          },
        ],
      },
    } as const;
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const requestFiber = yield* harness.callTool(request).pipe(Effect.forkChild);
      yield* Deferred.await(operationCompleted);
      const interruptFiber = yield* Fiber.interrupt(requestFiber).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(releaseCompletion, undefined);
      yield* Fiber.join(interruptFiber);

      const exit = yield* Fiber.await(requestFiber);
      assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
      assert.equal(harness.getOperationStatus("turn-parent-active"), "completed");
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.create").length,
        1,
      );
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.turn.start").length,
        1,
      );
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.delete").length,
        0,
      );

      const replay = yield* harness.callTool(request);
      assert.equal(toolResultJson(replay.result).createdCount, 1);
      assert.equal(harness.dispatched.length, 2);
      assert.equal(harness.getOperationStatus("turn-parent-active"), "completed");
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("compensates operation-owned threads and worktrees after dispatch failure", () => {
    let turnStarts = 0;
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
      failDispatch: (command) => {
        if (command.type !== "thread.turn.start") return false;
        turnStarts += 1;
        return turnStarts === 2;
      },
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args: {
          requestId: "compensated-batch",
          threads: [
            {
              prompt: "first",
              target: { provider: "codex", model: "gpt-5.5" },
              environment: "worktree",
            },
            {
              prompt: "second",
              target: { provider: "claudeAgent", model: "claude-sonnet-5" },
              environment: "worktree",
            },
          ],
        },
      });
      assert.isTrue(isToolError(response.result));
      assert.equal(
        (toolResultJson(response.result).error as { code: string }).code,
        "operation_failed",
      );
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.create").length,
        2,
      );
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.delete").length,
        2,
      );
      assert.equal(harness.worktreeCreates.length, 2);
      assert.equal(harness.worktreeRemoves.length, 2);
      assert.equal(harness.branchDeletes.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("compensates successful dispatches when the replayable result cannot persist", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
      failOperationComplete: true,
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args: {
          requestId: "completion-persistence-failure",
          threads: [
            {
              prompt: "dispatch then compensate",
              target: { provider: "codex", model: "gpt-5.5" },
            },
          ],
        },
      });
      assert.isTrue(isToolError(response.result));
      assert.equal(
        (toolResultJson(response.result).error as { code: string }).code,
        "operation_failed",
      );
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.create").length,
        1,
      );
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.delete").length,
        1,
      );
      assert.equal(harness.getOperationStatus("turn-parent-active"), "failed");
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("keeps a durable compensating status when cleanup itself fails", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [], {
      failDispatch: (command) =>
        command.type === "thread.turn.start" || command.type === "thread.delete",
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args: {
          requestId: "cleanup-failure",
          threads: [
            {
              prompt: "fail and compensate",
              target: { provider: "codex", model: "gpt-5.5" },
            },
          ],
        },
      });
      const payload = toolResultJson(response.result);
      assert.equal((payload.error as { code: string }).code, "operation_failed");
      assert.equal(
        (payload.error as { details: { compensationPending: boolean } }).details
          .compensationPending,
        true,
      );
      assert.equal(harness.getOperationStatus("turn-parent-active"), "compensating");
      assert.equal(
        harness.dispatched.filter((command) => command.type === "thread.create").length,
        1,
      );
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("waits for two pinned terminal turns without creating replacements", () => {
    const first = makeThreadShell("thread-result-a", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-result-a"),
        state: "completed",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
        assistantMessageId: MessageId.makeUnsafe("message-result-a"),
      },
    });
    const second = makeThreadShell("thread-result-b", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-result-b"),
        state: "completed",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
        assistantMessageId: MessageId.makeUnsafe("message-result-b"),
      },
    });
    const firstDetail: OrchestrationThread = {
      ...makeThreadDetail(first),
      messages: [
        {
          id: MessageId.makeUnsafe("message-result-a"),
          role: "assistant",
          text: "First result",
          turnId: TurnId.makeUnsafe("turn-result-a"),
          streaming: false,
          source: "native",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    };
    const secondDetail: OrchestrationThread = {
      ...makeThreadDetail(second),
      messages: [
        {
          id: MessageId.makeUnsafe("message-result-b"),
          role: "assistant",
          text: "Second result",
          turnId: TurnId.makeUnsafe("turn-result-b"),
          streaming: false,
          source: "native",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    };
    const { gatewayLayer, makeHarness } = makeHarnessLayer(
      [makeThreadShell("thread-parent"), first, second],
      [],
      {
        threadDetails: new Map([
          ["thread-result-a", firstDetail],
          ["thread-result-b", secondDetail],
        ]),
      },
    );
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_wait_for_threads",
        args: { threadIds: ["thread-result-a", "thread-result-b"], timeoutMs: 0 },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      const payload = toolResultJson(response.result);
      assert.equal(payload.allTerminal, true);
      assert.deepEqual(payload.runIds, ["turn-result-a", "turn-result-b"]);
      assert.deepEqual(
        (payload.threads as Array<{ summary: string }>).map((entry) => entry.summary),
        ["First result", "Second result"],
      );
      assert.deepEqual(harness.getWaitReadCounts(), { detailReads: 2, batchTurnReads: 1 });
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("bounds wait summaries and points callers to paginated thread reads", () => {
    const runId = TurnId.makeUnsafe("turn-long-result");
    const messageId = MessageId.makeUnsafe("message-long-result");
    const shell = makeThreadShell("thread-long-result", {
      latestTurn: {
        turnId: runId,
        state: "completed",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
        assistantMessageId: messageId,
      },
    });
    const { gatewayLayer, makeHarness } = makeHarnessLayer(
      [makeThreadShell("thread-parent"), shell],
      [],
      {
        threadDetails: new Map([
          [
            "thread-long-result",
            {
              ...makeThreadDetail(shell),
              messages: [
                {
                  id: messageId,
                  role: "assistant",
                  text: "x".repeat(5_000),
                  turnId: runId,
                  streaming: false,
                  source: "native",
                  createdAt: NOW,
                  updatedAt: NOW,
                },
              ],
            },
          ],
        ]),
      },
    );
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_wait_for_threads",
        args: { threadIds: ["thread-long-result"], timeoutMs: 0 },
      });
      const result = (
        toolResultJson(response.result).threads as Array<Record<string, unknown>>
      )[0]!;
      assert.equal(result.summaryTruncated, true);
      assert.match(result.summary as string, /\[\.\.\. truncated \d+ chars\]$/);
      assert.equal((result.summary as string).length, 2_000);
      assert.deepEqual(result.readThread, {
        tool: "synara_read_thread",
        arguments: { threadId: "thread-long-result" },
      });
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect(
    "checks twenty pending waits with one batched turn read and no transcript loads",
    () => {
      const pending = Array.from({ length: 20 }, (_, index) =>
        makeThreadShell(`thread-pending-${index}`, {
          latestTurn: {
            turnId: TurnId.makeUnsafe(`turn-pending-${index}`),
            state: "running",
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: null,
            assistantMessageId: null,
          },
        }),
      );
      const { gatewayLayer, makeHarness } = makeHarnessLayer([
        makeThreadShell("thread-parent"),
        ...pending,
      ]);
      return Effect.gen(function* () {
        const harness = yield* makeHarness;
        const response = yield* harness.callTool({
          token: "token-parent",
          name: "synara_wait_for_threads",
          args: { threadIds: pending.map((thread) => thread.id), timeoutMs: 0 },
        });
        assert.equal(toolResultJson(response.result).timedOut, true);
        assert.deepEqual(harness.getWaitReadCounts(), { detailReads: 0, batchTurnReads: 1 });
      }).pipe(Effect.provide(gatewayLayer));
    },
  );

  it.effect("fails a long wait when a pinned thread is deleted between polls", () => {
    const running = makeThreadShell("thread-deleted-during-wait", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-deleted-during-wait"),
        state: "running",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      makeThreadShell("thread-parent"),
      running,
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const fiber = yield* harness
        .callTool({
          token: "token-parent",
          name: "synara_wait_for_threads",
          args: { threadIds: ["thread-deleted-during-wait"], timeoutMs: 5_000 },
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.equal(harness.getWaitReadCounts().batchTurnReads, 1);
      harness.deleteThread("thread-deleted-during-wait");
      yield* TestClock.adjust("200 millis");
      const response = yield* Fiber.join(fiber);
      assert.equal(
        (toolResultJson(response.result).error as { code: string }).code,
        "thread_not_found",
      );
      assert.equal(harness.getWaitReadCounts().detailReads, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("replays the original two-agent incident without runaway replacements", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const args = {
        requestId: "repo-summary-pair",
        threads: [
          {
            prompt: "What is this repository about?",
            target: {
              provider: "codex",
              model: "gpt-5.6-terra",
              options: { reasoningEffort: "low" },
            },
          },
          {
            prompt: "What is this repository about?",
            target: { provider: "claudeAgent", model: "claude-sonnet-5" },
          },
        ],
      };
      const created = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args,
      });
      const replay = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args,
      });
      assert.isFalse(isToolError(created.result), toolErrorText(created.result));
      assert.isFalse(isToolError(replay.result), toolErrorText(replay.result));
      const threadIds = toolResultJson(created.result).threadIds as string[];
      assert.deepEqual(toolResultJson(replay.result).threadIds, threadIds);
      assert.equal(threadIds.length, 2);

      threadIds.forEach((threadId, index) => {
        const runId = TurnId.makeUnsafe(`turn-repo-summary-${index}`);
        const messageId = MessageId.makeUnsafe(`message-repo-summary-${index}`);
        const shell = makeThreadShell(threadId, {
          modelSelection:
            index === 0
              ? {
                  provider: "codex",
                  model: "gpt-5.6-terra",
                  options: { reasoningEffort: "low" },
                }
              : { provider: "claudeAgent", model: "claude-sonnet-5" },
          latestTurn: {
            turnId: runId,
            state: "completed",
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: NOW,
            assistantMessageId: messageId,
          },
        });
        harness.setThreadDetail({
          ...makeThreadDetail(shell),
          messages: [
            {
              id: messageId,
              role: "assistant",
              text: index === 0 ? "Terra repository summary" : "Claude repository summary",
              turnId: runId,
              streaming: false,
              source: "native",
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        });
      });

      const waited = yield* harness.callTool({
        token: "token-parent",
        name: "synara_wait_for_threads",
        args: { threadIds, timeoutMs: 0 },
      });
      assert.deepEqual(
        (toolResultJson(waited.result).threads as Array<{ summary: string }>).map(
          ({ summary }) => summary,
        ),
        ["Terra repository summary", "Claude repository summary"],
      );

      harness.setThreadDetail(
        makeThreadDetail(
          makeThreadShell("thread-parent", {
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-parent-active"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: null,
            },
          }),
        ),
      );
      const detachedFallback = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_threads",
        args: {
          requestId: "detached-opencode-fallback",
          threads: [
            {
              prompt: "Try again",
              target: { provider: "opencode", model: "openai/gpt-5" },
            },
          ],
        },
      });
      assert.equal(
        (toolResultJson(detachedFallback.result).error as { code: string }).code,
        "caller_turn_inactive",
      );
      const creates = harness.dispatched.filter((command) => command.type === "thread.create");
      assert.equal(creates.length, 2);
      assert.deepEqual(
        creates.map((command) => command.modelSelection),
        [
          {
            provider: "codex",
            model: "gpt-5.6-terra",
            options: { reasoningEffort: "low" },
          },
          { provider: "claudeAgent", model: "claude-sonnet-5" },
        ],
      );
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("wait reports idle, failure, timeout, and a later-completed pinned run", () => {
    const idle = makeThreadShell("thread-wait-idle");
    const failed = makeThreadShell("thread-wait-failed", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-wait-failed"),
        state: "error",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: NOW,
        assistantMessageId: null,
      },
      session: {
        threadId: ThreadId.makeUnsafe("thread-wait-failed"),
        status: "error",
        providerName: "claudeAgent",
        runtimeMode: "approval-required",
        activeTurnId: null,
        lastError: "Child failed",
        updatedAt: NOW,
      },
    });
    const running = makeThreadShell("thread-wait-running", {
      latestTurn: {
        turnId: TurnId.makeUnsafe("turn-wait-pinned"),
        state: "running",
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: null,
        assistantMessageId: null,
      },
    });
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      makeThreadShell("thread-parent"),
      idle,
      failed,
      running,
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const first = yield* harness.callTool({
        token: "token-parent",
        name: "synara_wait_for_threads",
        args: {
          threadIds: ["thread-wait-idle", "thread-wait-failed", "thread-wait-running"],
          timeoutMs: 0,
        },
      });
      const firstThreads = toolResultJson(first.result).threads as Array<{
        state: string;
        timedOut: boolean;
        error: string | null;
      }>;
      assert.deepEqual(
        firstThreads.map(({ state, timedOut }) => ({ state, timedOut })),
        [
          { state: "idle", timedOut: false },
          { state: "error", timedOut: false },
          { state: "running", timedOut: true },
        ],
      );
      assert.equal(firstThreads[1]?.error, "Child failed");

      harness.setProjectionTurn({
        threadId: "thread-wait-running",
        turnId: "turn-wait-pinned",
        state: "completed",
        assistantMessageId: "message-wait-pinned",
      });
      harness.setThreadDetail({
        ...makeThreadDetail(
          makeThreadShell("thread-wait-running", {
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-wait-later"),
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
            },
          }),
        ),
        messages: [
          {
            id: MessageId.makeUnsafe("message-wait-pinned"),
            role: "assistant",
            text: "Pinned run finished",
            turnId: TurnId.makeUnsafe("turn-wait-pinned"),
            streaming: false,
            source: "native",
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      });
      harness.setThreadDetail(
        makeThreadDetail(
          makeThreadShell("thread-parent", {
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-parent-active"),
              state: "interrupted",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: null,
            },
          }),
        ),
      );
      const second = yield* harness.callTool({
        token: "token-parent",
        name: "synara_wait_for_threads",
        args: {
          threadIds: ["thread-wait-running"],
          runIds: ["turn-wait-pinned"],
          timeoutMs: 0,
        },
      });
      const secondThread = (
        toolResultJson(second.result).threads as Array<{
          state: string;
          summary: string;
        }>
      )[0];
      assert.equal(secondThread?.state, "completed");
      assert.equal(secondThread?.summary, "Pinned run finished");
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("sends a follow-up message with the agent dispatch origin", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      ...baseThreads.filter((thread) => thread.id !== "thread-child"),
      makeThreadShell("thread-child", {
        parentThreadId: ThreadId.makeUnsafe("thread-parent"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-child"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: TurnId.makeUnsafe("turn-live"),
          lastError: null,
          updatedAt: NOW,
        },
      }),
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_send_message",
        args: { threadId: "thread-child", message: "status check please", mode: "steer" },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      const turn = harness.dispatched[0]!;
      assert.equal(turn.type, "thread.turn.start");
      if (turn.type === "thread.turn.start") {
        assert.equal(turn.dispatchOrigin, "agent");
        assert.equal(turn.dispatchMode, "steer");
        assert.equal(turn.threadId, "thread-child");
      }
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("passes an idle steer through so the reactor's live-state guard decides", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_send_message",
        args: { threadId: "thread-child", message: "status check please", mode: "steer" },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      // The projection snapshot can lag the runtime in both directions, so
      // the gateway must not downgrade; the reactor rechecks live state.
      assert.equal(toolResultJson(response.result).dispatched, "steer");
      const turn = harness.dispatched[0]!;
      assert.equal(turn.type, "thread.turn.start");
      if (turn.type === "thread.turn.start") {
        assert.equal(turn.dispatchMode, "steer");
      }
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects sends that would drive a higher-privileged thread", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      ...baseThreads,
      makeThreadShell("thread-full-access", { runtimeMode: "full-access" }),
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_send_message",
        args: { threadId: "thread-full-access", message: "run something dangerous" },
      });
      assert.isTrue(isToolError(response.result));
      assert.include(toolErrorText(response.result), "full-access");
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects interrupts that would drive a higher-privileged thread", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      ...baseThreads,
      makeThreadShell("thread-full-access", { runtimeMode: "full-access" }),
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_interrupt_thread",
        args: { threadId: "thread-full-access" },
      });
      assert.isTrue(isToolError(response.result));
      assert.include(toolErrorText(response.result), "full-access");
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects heartbeats that would target a higher-privileged thread", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      ...baseThreads,
      makeThreadShell("thread-full-access", { runtimeMode: "full-access" }),
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_automation",
        args: {
          name: "escalate",
          prompt: "keep running privileged work",
          targetThreadId: "thread-full-access",
        },
      });
      assert.isTrue(isToolError(response.result));
      assert.include(toolErrorText(response.result), "full-access");
      assert.equal(harness.automationCreates.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects sends from worktree-isolated callers to local-checkout threads", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      makeThreadShell("thread-parent", {
        envMode: "worktree",
        worktreePath: "/tmp/worktrees/caller",
        branch: "agent/caller",
      }),
      makeThreadShell("thread-local"),
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_send_message",
        args: { threadId: "thread-local", message: "edit the main checkout" },
      });
      assert.isTrue(isToolError(response.result));
      assert.include(toolErrorText(response.result), "local");
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects tokens whose caller thread no longer exists", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.postRaw({
        authorizationHeader: "Bearer token-ghost",
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      assert.equal(response.status, 401);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("keeps worktree-isolated callers from spawning local workers", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      makeThreadShell("thread-parent", {
        envMode: "worktree",
        worktreePath: "/tmp/worktrees/caller",
        branch: "agent/caller",
      }),
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;

      const rejected = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_thread",
        args: {
          requestId: "create-local-rejected",
          prompt: "touch the main checkout",
          provider: "codex",
          environment: "local",
        },
      });
      assert.isTrue(isToolError(rejected.result));
      assert.include(toolErrorText(rejected.result), "isolated worktree");
      assert.equal(harness.dispatched.length, 0);

      // Omitting environment defaults to an isolated worktree, not local.
      const defaulted = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_thread",
        args: { requestId: "create-isolated", prompt: "do isolated work", provider: "codex" },
      });
      assert.isFalse(isToolError(defaulted.result), toolErrorText(defaulted.result));
      assert.equal(toolResultJson(defaulted.result).environment, "worktree");
      const create = harness.dispatched[0]!;
      assert.equal(create.type, "thread.create");
      if (create.type === "thread.create") {
        assert.equal(create.envMode, "worktree");
      }
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects runtime-mode escalation beyond the calling thread", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_thread",
        args: {
          requestId: "create-escalated",
          prompt: "escalate please",
          provider: "codex",
          runtimeMode: "full-access",
        },
      });
      assert.isTrue(isToolError(response.result));
      assert.include(toolErrorText(response.result), "approval-required");
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("creates a heartbeat automation on the caller thread by default", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_automation",
        args: { name: "monitor children", prompt: "check the child threads", everyMinutes: 5 },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      assert.equal(harness.automationCreates.length, 1);
      const created = harness.automationCreates[0]!;
      assert.equal(created.mode, "heartbeat");
      assert.equal(created.targetThreadId, "thread-parent");
      assert.deepEqual(created.schedule, { type: "interval", everySeconds: 300 });
      assert.equal(created.maxIterations, 50);
      // Local-checkout targets must carry the matching environment + risk
      // acknowledgement so AutomationService policy checks stay enforced.
      assert.equal(created.worktreeMode, "local");
      assert.deepEqual(created.acknowledgedRisks, ["local-checkout"]);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("creates standalone automations with the additive full schedule shape", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_automation",
        args: {
          name: "Daily review",
          prompt: "Review the project.",
          mode: "standalone",
          schedule: {
            type: "daily",
            timeOfDay: "09:30",
            timezone: "Europe/Rome",
          },
          worktreeMode: "worktree",
          notificationPolicy: "failed-runs-only",
        },
      });

      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      const created = harness.automationCreates[0]!;
      assert.equal(created.mode, "standalone");
      assert.isNull(created.targetThreadId);
      assert.deepEqual(created.schedule, {
        type: "daily",
        timeOfDay: "09:30",
        timezone: "Europe/Rome",
      });
      assert.equal(created.worktreeMode, "worktree");
      assert.equal(created.notificationPolicy, "failed-runs-only");
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects standalone automations targeting another project", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_automation",
        args: {
          name: "Cross-project review",
          prompt: "Review another project.",
          mode: "standalone",
          projectId: "project-other",
        },
      });

      assert.isTrue(isToolError(response.result));
      assert.include(toolErrorText(response.result), "caller's project");
      assert.lengthOf(harness.automationCreates, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect(
    "requires an explicit flag and bounded loop for sub-minute automation schedules",
    () => {
      const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
      return Effect.gen(function* () {
        const harness = yield* makeHarness;
        const rejected = yield* harness.callTool({
          token: "token-parent",
          name: "synara_create_automation",
          args: {
            name: "Fast monitor",
            prompt: "Check quickly.",
            schedule: { type: "interval", everySeconds: 15 },
          },
        });
        assert.isTrue(isToolError(rejected.result));
        assert.include(toolErrorText(rejected.result), "fastInterval");

        const accepted = yield* harness.callTool({
          token: "token-parent",
          name: "synara_create_automation",
          args: {
            name: "Fast monitor",
            prompt: "Check quickly.",
            schedule: { type: "interval", everySeconds: 15 },
            fastInterval: true,
          },
        });
        assert.isFalse(isToolError(accepted.result), toolErrorText(accepted.result));
        const created = harness.automationCreates[0]!;
        assert.equal(created.maxIterations, 10);
        assert.include(created.acknowledgedRisks ?? [], "fast-interval");
        // The default cooldown must not exceed the schedule spacing, or the
        // acknowledged fast interval would silently degrade to cooldown cadence.
        assert.equal(created.heartbeatCooldownSeconds, 15);
      }).pipe(Effect.provide(gatewayLayer));
    },
  );

  it.effect("accepts memory writes without automationId and via the content alias", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const implicit = yield* harness.callTool({
        token: "token-parent",
        name: "synara_update_automation_memory",
        args: { memory: "Iteration 1 complete." },
      });
      const legacy = yield* harness.callTool({
        token: "token-parent",
        name: "synara_update_automation_memory",
        args: { automationId: "automation-1", content: "Legacy payload." },
      });
      const missing = yield* harness.callTool({
        token: "token-parent",
        name: "synara_update_automation_memory",
        args: { automationId: "automation-1" },
      });

      assert.isFalse(isToolError(implicit.result), toolErrorText(implicit.result));
      assert.isFalse(isToolError(legacy.result), toolErrorText(legacy.result));
      assert.isTrue(isToolError(missing.result));
      assert.include(toolErrorText(missing.result), '"memory"');
      assert.deepEqual(harness.automationMemoryUpdates, [
        { automationId: null, content: "Iteration 1 complete." },
        { automationId: "automation-1", content: "Legacy payload." },
      ]);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("persists suggested automations as pending and surfaces a proposal card", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_create_automation",
        args: {
          name: "Suggested monitor",
          prompt: "Watch the build.",
          suggested: true,
        },
      });

      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      const created = harness.automationCreates[0]!;
      assert.isFalse(created.enabled ?? true);
      assert.equal(created.proposalState, "pending");
      const proposal = harness.dispatched.find(
        (command) => command.type === "thread.activity.append",
      );
      assert.equal(proposal?.type, "thread.activity.append");
      if (proposal?.type !== "thread.activity.append") {
        assert.fail("Expected a proposal activity command.");
      }
      assert.equal(proposal.activity.kind, "automation.created");
      assert.equal(proposal.activity.id, "automation-proposal:automation-1");
      assert.equal((proposal.activity.payload as Record<string, unknown>).proposalState, "pending");
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("views run history through the automation-scoped query", () => {
    const definition = makeAutomationDefinition();
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [definition], {
      automationRuns: [
        { id: "target-newest", automationId: definition.id },
        { id: "target-older", automationId: definition.id },
        {
          id: "unrelated",
          automationId: AutomationId.makeUnsafe("automation-unrelated"),
        },
      ],
    });
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_view_automation",
        args: { automationId: definition.id, runLimit: 1 },
      });

      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      assert.deepEqual(toolResultJson(response.result).runs, [
        { id: "target-newest", automationId: definition.id },
      ]);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("disables an automation on cancel", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [
      makeAutomationDefinition(),
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_cancel_automation",
        args: { automationId: "automation-1" },
      });
      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      assert.deepEqual(harness.automationUpdates, [
        { id: AutomationId.makeUnsafe("automation-1"), enabled: false },
      ]);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects automation cancellation when the caller cannot own or drive it", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(
      [
        ...baseThreads,
        makeThreadShell("thread-elevated", { runtimeMode: "full-access" }),
        makeThreadShell("thread-other"),
      ],
      [
        makeAutomationDefinition({
          id: AutomationId.makeUnsafe("automation-elevated"),
          sourceThreadId: ThreadId.makeUnsafe("thread-other"),
          targetThreadId: ThreadId.makeUnsafe("thread-elevated"),
          runtimeMode: "full-access",
          acknowledgedRisks: ["full-access", "local-checkout"],
        }),
      ],
    );
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_cancel_automation",
        args: { automationId: "automation-elevated" },
      });
      assert.isTrue(isToolError(response.result));
      assert.include(toolErrorText(response.result), "full-access");
      assert.deepEqual(harness.automationUpdates, []);
      assert.deepEqual(harness.automationDeletes, []);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects ambiguous partial automation updates", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [
      makeAutomationDefinition(),
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_update_automation",
        args: {
          automationId: "automation-1",
          name: "Only a name",
        },
      });

      assert.isTrue(isToolError(response.result));
      assert.deepEqual(harness.automationUpdates, []);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("applies explicit full-replacement automation updates", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads, [
      makeAutomationDefinition(),
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.callTool({
        token: "token-parent",
        name: "synara_update_automation",
        args: {
          automationId: "automation-1",
          name: "Updated monitor",
          prompt: "Check the children carefully.",
          schedule: { type: "interval", everySeconds: 600 },
          enabled: true,
          maxIterations: null,
          notificationPolicy: "failed-runs-only",
          completionPolicy: { type: "none" },
        },
      });

      assert.isFalse(isToolError(response.result), toolErrorText(response.result));
      assert.deepEqual(harness.automationUpdates[0], {
        id: AutomationId.makeUnsafe("automation-1"),
        name: "Updated monitor",
        prompt: "Check the children carefully.",
        schedule: { type: "interval", everySeconds: 600 },
        enabled: true,
        maxIterations: null,
        notificationPolicy: "failed-runs-only",
        completionPolicy: { type: "none" },
        acknowledgedRisks: ["local-checkout"],
      });
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("archives and renames threads through meta commands", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.callTool({
        token: "token-parent",
        name: "synara_set_thread_title",
        args: { threadId: "thread-child", title: "Renamed worker" },
      });
      yield* harness.callTool({
        token: "token-parent",
        name: "synara_set_thread_archived",
        args: { threadId: "thread-child", archived: true },
      });
      assert.equal(harness.dispatched[0]?.type, "thread.meta.update");
      assert.equal(harness.dispatched[1]?.type, "thread.archive");
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("rejects metadata changes when the caller cannot drive the target thread", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer([
      ...baseThreads,
      makeThreadShell("thread-elevated", { runtimeMode: "full-access" }),
    ]);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;

      const rename = yield* harness.callTool({
        token: "token-parent",
        name: "synara_set_thread_title",
        args: { threadId: "thread-elevated", title: "Hidden work" },
      });
      assert.isTrue(isToolError(rename.result));
      assert.include(toolErrorText(rename.result), "full-access");

      const archive = yield* harness.callTool({
        token: "token-parent",
        name: "synara_set_thread_archived",
        args: { threadId: "thread-elevated", archived: true },
      });
      assert.isTrue(isToolError(archive.result));
      assert.include(toolErrorText(archive.result), "full-access");
      assert.equal(harness.dispatched.length, 0);
    }).pipe(Effect.provide(gatewayLayer));
  });

  it.effect("reports unknown tools as invalid params", () => {
    const { gatewayLayer, makeHarness } = makeHarnessLayer(baseThreads);
    return Effect.gen(function* () {
      const harness = yield* makeHarness;
      const response = yield* harness.postRaw({
        authorizationHeader: "Bearer token-parent",
        body: {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "synara_unknown" },
        },
      });
      const error = (response.body as { error?: { code: number } }).error;
      assert.equal(error?.code, -32602);
    }).pipe(Effect.provide(gatewayLayer));
  });
});

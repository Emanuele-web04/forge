import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationThreadShell,
  type ProviderInteractionMode,
  type ProviderKind,
  type SynaraCreateThreadsInput,
  type SynaraCreateThreadsResult,
} from "@synara/contracts";
import { buildPromptThreadTitleFallback } from "@synara/shared/chatThreads";
import { parseGitHubRepositoryNameWithOwnerFromPullRequestUrl } from "@synara/shared/githubRepository";
import { Cause, Effect, Option, Semaphore } from "effect";

import type { ServerConfigShape } from "../config.ts";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderDiscoveryServiceShape } from "../provider/Services/ProviderDiscoveryService.ts";
import { runWorktreeSetupScript } from "../worktreeSetup.ts";
import type {
  AgentGatewayOperationRecord,
  AgentGatewayOperationRepositoryShape,
} from "./Services/AgentGatewayOperationRepository.ts";
import type {
  ExternalMcpRepositoryShape,
  ExternalMcpOperationRecord,
} from "../externalMcp/Services/ExternalMcpRepository.ts";
import { resolveExternalMcpRuntimePolicy } from "../externalMcp/runtimePolicy.ts";
import {
  canonicalJson,
  gatewayIsoNow,
  makeAgentCreationIds,
  stableGatewayDigest,
} from "./creationUtils.ts";
import { mcpToolResultError, mcpToolResultJson, type McpToolCallResult } from "./protocol.ts";
import {
  AgentGatewayTargetError,
  resolveAgentGatewayTarget,
  type AgentGatewayProviderAvailability,
} from "./targetResolver.ts";
import { ToolInputError, errorText } from "./toolInput.ts";
import { GatewayToolError, gatewayToolErrorResult } from "./toolRuntime.ts";

const CREATION_REPLAY_WAIT_MS = 60_000;

function interactionModeForGatewayTarget(target: ModelSelection): ProviderInteractionMode {
  if (
    (target.provider === "opencode" || target.provider === "kilo") &&
    target.options?.agent === "plan"
  ) {
    return "plan";
  }
  return "default";
}

interface PullRequestSelector {
  readonly number: number;
  readonly repositoryNameWithOwner?: string;
}

function parsePullRequestSelector(ref: string): PullRequestSelector | null {
  const trimmed = ref.trim();
  const shorthandMatch = /^#(\d+)$/u.exec(trimmed);
  const urlMatch = /^https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)(?:[/?#].*)?$/iu.exec(
    trimmed,
  );
  const rawNumber = shorthandMatch?.[1] ?? urlMatch?.[1];
  if (!rawNumber) return null;
  const value = Number(rawNumber);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  const repositoryNameWithOwner = urlMatch
    ? parseGitHubRepositoryNameWithOwnerFromPullRequestUrl(trimmed)
    : null;
  if (urlMatch && !repositoryNameWithOwner) return null;
  return {
    number: value,
    ...(repositoryNameWithOwner ? { repositoryNameWithOwner } : {}),
  };
}

interface CreationCoordinatorDependencies {
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly git: GitCoreShape;
  readonly providerDiscovery: ProviderDiscoveryServiceShape;
  readonly operationRepository: AgentGatewayOperationRepositoryShape;
  readonly externalMcpRepository?: ExternalMcpRepositoryShape;
  readonly serverConfig: ServerConfigShape;
  readonly loadProviderAvailabilities: Effect.Effect<
    ReadonlyMap<ProviderKind, AgentGatewayProviderAvailability>,
    unknown
  >;
  readonly requireThreadShell: (
    threadId: string,
  ) => Effect.Effect<OrchestrationThreadShell, ToolInputError>;
}

export type GatewayCreationContext =
  | {
      readonly kind: "provider-session";
      readonly callerThreadId: string;
      readonly callerTurnId: string | null;
      readonly assertAuthority: () => Effect.Effect<void, GatewayToolError>;
    }
  | {
      readonly kind: "external-client";
      readonly integrationId: string;
      readonly allowedProjectIds: ReadonlySet<string>;
      readonly capabilities: ReadonlySet<string>;
      readonly assertAuthority: () => Effect.Effect<void, GatewayToolError>;
    };

type CreationOperationRecord = AgentGatewayOperationRecord | ExternalMcpOperationRecord;

interface CreationOperationStore {
  readonly getExisting: () => Effect.Effect<CreationOperationRecord | null, Error>;
  readonly getById: (operationId: string) => Effect.Effect<CreationOperationRecord | null, Error>;
  readonly reserve: (input: {
    readonly operationId: string;
    readonly requestId: string;
    readonly fingerprint: string;
    readonly requestedCount: number;
    readonly planJson: string;
    readonly now: string;
  }) => Effect.Effect<
    | {
        readonly kind: "reserved" | "replay" | "idempotency_conflict" | "creation_plan_locked";
        readonly operation: CreationOperationRecord;
      }
    | {
        readonly kind: "concurrency_limited";
        readonly activeCount: number;
        readonly limit: number;
      },
    Error
  >;
  readonly markDispatching: AgentGatewayOperationRepositoryShape["markDispatching"];
  readonly recordWorktreeCreated: AgentGatewayOperationRepositoryShape["recordWorktreeCreated"];
  readonly markCompensating: AgentGatewayOperationRepositoryShape["markCompensating"];
  readonly recordCompensationFailure: AgentGatewayOperationRepositoryShape["recordCompensationFailure"];
  readonly complete: AgentGatewayOperationRepositoryShape["complete"];
  readonly fail: AgentGatewayOperationRepositoryShape["fail"];
  readonly registerTask: (input: {
    readonly operationId: string;
    readonly requestId: string;
    readonly threadId: string;
    readonly projectId: string;
    readonly now: string;
  }) => Effect.Effect<void, Error>;
  readonly markTaskStatus: (
    operationId: string,
    status: "created" | "failed",
  ) => Effect.Effect<void, Error>;
}

/**
 * Build the durable, exactly-once thread-creation coordinator.
 *
 * The coordinator owns its per-caller-turn locks and all git/orchestration
 * compensation state. Keeping that state beside the saga prevents the MCP
 * transport and unrelated tools from becoming accidental recovery owners.
 */
export const makeCreateThreadsHandler = Effect.fn(function* (
  dependencies: CreationCoordinatorDependencies,
) {
  const {
    snapshotQuery,
    orchestrationEngine,
    git,
    providerDiscovery,
    operationRepository,
    externalMcpRepository,
    serverConfig,
    loadProviderAvailabilities,
    requireThreadShell,
  } = dependencies;
  const lockIndex = yield* Semaphore.make(1);
  const locks = new Map<string, { readonly lock: Semaphore.Semaphore; users: number }>();

  const withCreationPlanLock = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      lockIndex.withPermits(1)(
        Effect.gen(function* () {
          const existing = locks.get(key);
          if (existing) {
            existing.users += 1;
            return existing;
          }
          const entry = { lock: yield* Semaphore.make(1), users: 1 };
          locks.set(key, entry);
          return entry;
        }),
      ),
      (entry) => entry.lock.withPermits(1)(effect),
      (entry) =>
        lockIndex.withPermits(1)(
          Effect.sync(() => {
            entry.users -= 1;
            if (entry.users === 0 && locks.get(key) === entry) locks.delete(key);
          }),
        ),
    );

  const awaitCreationReplay = (
    operationStore: CreationOperationStore,
    operationId: string,
    assertAuthority: () => Effect.Effect<void, GatewayToolError>,
  ): Effect.Effect<McpToolCallResult, GatewayToolError | ToolInputError> =>
    Effect.gen(function* () {
      const deadline = Date.now() + CREATION_REPLAY_WAIT_MS;
      let operation = yield* operationStore
        .getById(operationId)
        .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
      while (
        operation !== null &&
        operation.status !== "completed" &&
        operation.status !== "failed" &&
        Date.now() < deadline
      ) {
        yield* assertAuthority();
        yield* Effect.sleep(25);
        operation = yield* operationStore
          .getById(operationId)
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
      }
      yield* assertAuthority();
      if (operation?.status === "completed") {
        return mcpToolResultJson(JSON.parse(operation.resultJson ?? "{}"));
      }
      if (operation?.status === "failed") {
        return yield* Effect.fail(
          new GatewayToolError(
            "operation_failed",
            "The original thread-creation operation failed; it will not create replacement threads.",
            {
              operationId,
              error: operation.errorJson ? JSON.parse(operation.errorJson) : null,
            },
          ),
        );
      }
      return yield* Effect.fail(
        new GatewayToolError(
          "operation_failed",
          "The original thread-creation operation is still in progress. Retry only with the same request id; Synara will not create replacement threads.",
          { operationId, status: operation?.status ?? "missing" },
        ),
      );
    });

  const appendThreadCreationRecap = (input: {
    readonly callerThreadId: string;
    readonly callerTurnId: string;
    readonly result: SynaraCreateThreadsResult;
  }) => {
    const marker = stableGatewayDigest({
      operationId: input.result.operationId,
      kind: "threads-created-recap",
    });
    const createdAt = gatewayIsoNow();
    const threadLabel = input.result.createdCount === 1 ? "thread" : "threads";
    return orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe(`agent:${marker}:threads-created-recap`),
        threadId: ThreadId.makeUnsafe(input.callerThreadId),
        activity: {
          id: EventId.makeUnsafe(`gateway:${marker}:threads-created-recap`),
          tone: "info",
          kind: "synara.threads.created",
          summary: `Created ${input.result.createdCount} Synara ${threadLabel}`,
          payload: {
            source: "synara_mcp",
            operationId: input.result.operationId,
            requestId: input.result.requestId,
            requestedCount: input.result.requestedCount,
            createdCount: input.result.createdCount,
            threads: JSON.parse(JSON.stringify(input.result.threads)),
          },
          turnId: TurnId.makeUnsafe(input.callerTurnId),
          createdAt,
        },
        createdAt,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("agent gateway could not append thread creation recap", {
            operationId: input.result.operationId,
            callerThreadId: input.callerThreadId,
            error: errorText(error),
          }),
        ),
      );
  };

  const run = (input: typeof SynaraCreateThreadsInput.Type, context: GatewayCreationContext) => {
    return Effect.gen(function* () {
      if (context.kind === "provider-session" && context.callerTurnId === null) {
        return yield* Effect.fail(
          new GatewayToolError(
            "caller_turn_inactive",
            "Thread creation requires an active caller turn.",
          ),
        );
      }
      if (context.kind === "external-client" && input.threads.length !== 1) {
        return yield* Effect.fail(
          new GatewayToolError(
            "creation_limit_exceeded",
            "External MCP integrations may create exactly one task per request.",
          ),
        );
      }
      const callerTurnId = context.kind === "provider-session" ? context.callerTurnId! : null;
      const caller =
        context.kind === "provider-session"
          ? yield* requireThreadShell(context.callerThreadId)
          : null;
      const operationId = `gateway:create:${stableGatewayDigest({
        principalKind: context.kind,
        principalId:
          context.kind === "provider-session" ? context.callerThreadId : context.integrationId,
        ...(callerTurnId ? { callerTurnId } : {}),
        requestId: input.requestId,
      })}`;
      const fingerprint = stableGatewayDigest(input, 64);
      const externalOperationRepository =
        context.kind === "external-client" ? externalMcpRepository : undefined;
      if (context.kind === "external-client" && externalOperationRepository === undefined) {
        return yield* Effect.fail(
          new GatewayToolError(
            "external_mcp_unavailable",
            "External MCP persistence is unavailable.",
          ),
        );
      }
      const operationStore: CreationOperationStore =
        context.kind === "provider-session"
          ? {
              getExisting: () =>
                operationRepository.getByScope({
                  callerThreadId: context.callerThreadId,
                  callerTurnId: context.callerTurnId!,
                  operationKind: "create_threads",
                }),
              getById: operationRepository.getById,
              reserve: (reservation) =>
                operationRepository.reserve({
                  ...reservation,
                  callerThreadId: context.callerThreadId,
                  callerTurnId: context.callerTurnId!,
                  operationKind: "create_threads",
                }),
              markDispatching: operationRepository.markDispatching,
              recordWorktreeCreated: operationRepository.recordWorktreeCreated,
              markCompensating: operationRepository.markCompensating,
              recordCompensationFailure: operationRepository.recordCompensationFailure,
              complete: operationRepository.complete,
              fail: operationRepository.fail,
              registerTask: () => Effect.void,
              markTaskStatus: () => Effect.void,
            }
          : {
              getExisting: () =>
                externalOperationRepository!.getOperationByRequest({
                  integrationId: context.integrationId,
                  requestId: input.requestId,
                }),
              getById: externalOperationRepository!.getOperationById,
              reserve: (reservation) =>
                externalOperationRepository!.reserveOperation({
                  ...reservation,
                  integrationId: context.integrationId,
                  requestedCount: 1,
                }),
              markDispatching: externalOperationRepository!.markOperationDispatching,
              recordWorktreeCreated: externalOperationRepository!.recordOperationWorktreeCreated,
              markCompensating: externalOperationRepository!.markOperationCompensating,
              recordCompensationFailure:
                externalOperationRepository!.recordOperationCompensationFailure,
              complete: externalOperationRepository!.completeOperation,
              fail: externalOperationRepository!.failOperation,
              registerTask: (task) =>
                externalOperationRepository!.registerTask({
                  ...task,
                  integrationId: context.integrationId,
                }),
              markTaskStatus: (operationId, status) =>
                externalOperationRepository!.markTaskStatus({
                  operationId,
                  status,
                  now: gatewayIsoNow(),
                }),
            };
      const existingOperation = yield* operationStore
        .getExisting()
        .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
      if (existingOperation !== null) {
        yield* context.assertAuthority();
        if (
          context.kind === "provider-session" &&
          existingOperation.requestId !== input.requestId
        ) {
          return yield* Effect.fail(
            new GatewayToolError(
              "creation_plan_locked",
              "This caller turn already committed a different thread-creation plan. A new user turn is required for another plan.",
              {
                operationId: existingOperation.operationId,
                requestId: existingOperation.requestId,
                requestedCount: existingOperation.requestedCount,
                status: existingOperation.status,
              },
            ),
          );
        }
        if (existingOperation.fingerprint !== fingerprint) {
          return yield* Effect.fail(
            new GatewayToolError(
              "idempotency_conflict",
              `Request id "${input.requestId}" was already used with a different creation plan.`,
              { operationId: existingOperation.operationId },
            ),
          );
        }
        if (existingOperation.status === "completed") {
          return mcpToolResultJson(JSON.parse(existingOperation.resultJson ?? "{}"));
        }
        if (existingOperation.status === "failed") {
          return yield* Effect.fail(
            new GatewayToolError(
              "operation_failed",
              "The original thread-creation operation failed; it will not create replacement threads.",
              {
                operationId: existingOperation.operationId,
                error: existingOperation.errorJson ? JSON.parse(existingOperation.errorJson) : null,
              },
            ),
          );
        }
        return yield* awaitCreationReplay(
          operationStore,
          existingOperation.operationId,
          context.assertAuthority,
        );
      }
      const deprecatedBranchName = input.threads.find((spec) => spec.branchName !== undefined);
      if (deprecatedBranchName) {
        return yield* Effect.fail(
          new ToolInputError(
            '"branchName" is no longer supported for managed worktrees. Synara creates a detached HEAD; create a branch inside the new thread when the work is ready.',
          ),
        );
      }
      const callerIsolatedInWorktree = caller?.envMode === "worktree";
      const providerAvailabilities = yield* loadProviderAvailabilities;

      const prepared = yield* Effect.forEach(input.threads, (spec, index) =>
        Effect.gen(function* () {
          if (context.kind === "external-client" && spec.projectId === undefined) {
            return yield* Effect.fail(
              new ToolInputError("External MCP task creation requires an explicit projectId."),
            );
          }
          const projectId = ProjectId.makeUnsafe(spec.projectId ?? caller!.projectId);
          if (context.kind === "external-client" && !context.allowedProjectIds.has(projectId)) {
            return yield* Effect.fail(
              new GatewayToolError(
                "capability_denied",
                `This integration is not authorized for project "${projectId}".`,
              ),
            );
          }
          const project = yield* snapshotQuery.getProjectShellById(projectId).pipe(
            Effect.mapError((error) => new ToolInputError(errorText(error))),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(new ToolInputError(`Project "${projectId}" was not found.`)),
                onSome: Effect.succeed,
              }),
            ),
          );
          const target = yield* resolveAgentGatewayTarget({
            target: spec.target,
            discovery: providerDiscovery,
            ...(providerAvailabilities.get(spec.target.provider) !== undefined
              ? { availability: providerAvailabilities.get(spec.target.provider)! }
              : {}),
            cwd: project.workspaceRoot,
          });
          const externalPolicy =
            context.kind === "external-client"
              ? resolveExternalMcpRuntimePolicy({
                  ...(spec.environment ? { requestedEnvironment: spec.environment } : {}),
                  ...(spec.runtimeMode ? { requestedRuntimeMode: spec.runtimeMode } : {}),
                  capabilities: context.capabilities,
                })
              : null;
          const environment =
            externalPolicy?.environment ??
            spec.environment ??
            (callerIsolatedInWorktree ? "worktree" : "local");
          if (environment === "local" && callerIsolatedInWorktree) {
            return yield* Effect.fail(
              new ToolInputError(
                'Your thread runs in an isolated worktree, so created threads cannot use environment "local".',
              ),
            );
          }
          if (
            context.kind === "provider-session" &&
            spec.runtimeMode === "full-access" &&
            caller!.runtimeMode !== "full-access"
          ) {
            return yield* Effect.fail(
              new ToolInputError(
                'Your thread runs in "approval-required" mode, so created threads cannot use "full-access".',
              ),
            );
          }
          const runtimeMode =
            externalPolicy?.runtimeMode ??
            spec.runtimeMode ??
            (context.kind === "external-client" ? "approval-required" : caller!.runtimeMode);
          const title = spec.title ?? buildPromptThreadTitleFallback(spec.prompt);
          let worktreeRef: string | null = null;
          let copyChangesFrom: string | null = null;
          let plannedWorktreePath: string | null = null;
          if (environment === "worktree") {
            if (spec.baseRef && spec.baseBranch && spec.baseRef !== spec.baseBranch) {
              return yield* Effect.fail(
                new ToolInputError("baseRef and its deprecated baseBranch alias must match."),
              );
            }
            const requestedRef = spec.baseRef ?? spec.baseBranch ?? "HEAD";
            // Named refs are shared across linked worktrees, while HEAD is checkout-local.
            // Always resolve same-project requests from the caller's selected checkout so
            // an explicit baseRef:"HEAD" cannot silently jump back to the primary checkout.
            const sourceCwd =
              caller?.projectId === projectId
                ? (caller.worktreePath ?? project.workspaceRoot)
                : project.workspaceRoot;
            const pullRequest = parsePullRequestSelector(requestedRef);
            worktreeRef = yield* (
              pullRequest === null
                ? git.execute({
                    operation: "AgentGateway.resolveWorktreeRef",
                    cwd: sourceCwd,
                    args: ["rev-parse", "--verify", "--end-of-options", `${requestedRef}^{commit}`],
                    timeoutMs: 5_000,
                  })
                : git.withMutation(
                    project.workspaceRoot,
                    git
                      .fetchPullRequestCommit({
                        cwd: project.workspaceRoot,
                        prNumber: pullRequest.number,
                        ...(pullRequest.repositoryNameWithOwner
                          ? { expectedRepositoryNameWithOwner: pullRequest.repositoryNameWithOwner }
                          : {}),
                      })
                      .pipe(Effect.map((ref) => ({ code: 0, stdout: ref, stderr: "" }))),
                  )
            ).pipe(
              Effect.map((result) => result.stdout.trim()),
              Effect.filterOrFail(
                (ref) => ref.length > 0,
                () => new Error("git returned an empty commit id"),
              ),
              Effect.mapError(
                (error) =>
                  new ToolInputError(
                    `Git revision "${requestedRef}" is unavailable. Pass a local ref/commit, #PR, or GitHub pull-request URL. ${errorText(error)}`,
                  ),
              ),
            );
            const sourceHead = yield* git
              .execute({
                operation: "AgentGateway.resolveWorktreeCopySource",
                cwd: sourceCwd,
                args: ["rev-parse", "--verify", "HEAD^{commit}"],
                timeoutMs: 5_000,
              })
              .pipe(
                Effect.map((result) => result.stdout.trim()),
                Effect.mapError((error) => new ToolInputError(errorText(error))),
              );
            copyChangesFrom = sourceHead === worktreeRef ? sourceCwd : null;
            plannedWorktreePath = join(
              serverConfig.worktreesDir,
              stableGatewayDigest({ operationId, index }, 12),
            );
            if (existsSync(plannedWorktreePath)) {
              return yield* Effect.fail(
                new ToolInputError(
                  `Worktree path "${plannedWorktreePath}" already exists. Synara will not reuse or remove a pre-existing path.`,
                ),
              );
            }
          }
          return {
            index,
            spec,
            projectId,
            workspaceRoot: project.workspaceRoot,
            target,
            environment,
            runtimeMode,
            title,
            projectScripts: project.scripts,
            worktreeRef,
            copyChangesFrom,
            newBranch: null,
            plannedWorktreePath,
            ownershipPreflightPassed: true,
            ids: makeAgentCreationIds(operationId, index),
          };
        }),
      );

      const plannedWorktrees = prepared
        .map((entry) => entry.plannedWorktreePath)
        .filter((path): path is string => path !== null);
      if (new Set(plannedWorktrees).size !== plannedWorktrees.length) {
        return yield* Effect.fail(
          new ToolInputError(
            "The creation plan resolves multiple entries to the same generated worktree path.",
          ),
        );
      }

      yield* context.assertAuthority();

      const createdThreads: Array<(typeof prepared)[number]> = [];
      const createdWorktrees: Array<{
        readonly cwd: string;
        readonly path: string;
        readonly branch: string | null;
        proof: {
          readonly token: string;
          readonly gitDir: string;
          readonly branch: string | null;
          readonly head: string;
          readonly stateHash?: string;
        } | null;
      }> = [];

      const compensateClaimedOperation = (cause: Cause.Cause<unknown>) =>
        Effect.gen(function* () {
          const interrupted = Cause.hasInterrupts(cause);
          const failureMessage = interrupted
            ? "The MCP request was interrupted after thread creation dispatch began."
            : errorText(Cause.squash(cause));
          yield* operationStore.markCompensating({ operationId, now: gatewayIsoNow() }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("agent gateway could not persist compensating status", {
                operationId,
                error: errorText(error),
              }),
            ),
          );
          const compensationErrors: string[] = [];
          let compensatedThreadCount = 0;
          let compensatedWorktreeCount = 0;
          yield* Effect.forEach(
            [...createdThreads].reverse(),
            (entry) =>
              orchestrationEngine
                .dispatch({
                  type: "thread.delete",
                  commandId: entry.ids.compensateCommandId,
                  threadId: entry.ids.threadId,
                })
                .pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      compensatedThreadCount += 1;
                    }),
                  ),
                  Effect.catch((error) =>
                    Effect.sync(() =>
                      compensationErrors.push(`thread ${entry.ids.threadId}: ${errorText(error)}`),
                    ),
                  ),
                ),
            { discard: true },
          );
          yield* Effect.forEach(
            [...createdWorktrees].reverse(),
            (worktree) =>
              git
                .withMutation(
                  worktree.cwd,
                  worktree.proof === null
                    ? git
                        .removeWorktree({
                          cwd: worktree.cwd,
                          path: worktree.path,
                          // Ownership was never recorded for this path: creation failed
                          // right after the worktree appeared, or the interruptible setup
                          // script failed or was interrupted. Copied baseline changes and
                          // partial setup output make a non-forced removal fail by
                          // construction.
                          force: true,
                        })
                        .pipe(
                          Effect.flatMap(() =>
                            worktree.branch === null
                              ? Effect.void
                              : git.deleteBranch({
                                  cwd: worktree.cwd,
                                  branch: worktree.branch,
                                  force: false,
                                }),
                          ),
                        )
                    : git
                        .verifyWorktreeOwnership({
                          path: worktree.path,
                          proof: worktree.proof,
                        })
                        .pipe(
                          Effect.flatMap((verification) =>
                            verification.verified
                              ? Effect.void
                              : Effect.fail(
                                  new Error(
                                    `Refusing live compensation: ${verification.reason ?? "ownership verification failed"}.`,
                                  ),
                                ),
                          ),
                          Effect.flatMap(() =>
                            git.removeWorktree({
                              cwd: worktree.cwd,
                              path: worktree.path,
                              force: true,
                            }),
                          ),
                          Effect.flatMap(() =>
                            worktree.branch === null
                              ? Effect.void
                              : git.deleteBranchIfUnchanged({
                                  cwd: worktree.cwd,
                                  branch: worktree.branch,
                                  expectedHead: worktree.proof!.head,
                                }),
                          ),
                        ),
                )
                .pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      compensatedWorktreeCount += 1;
                    }),
                  ),
                  Effect.catch((error) =>
                    Effect.sync(() =>
                      compensationErrors.push(`worktree ${worktree.path}: ${errorText(error)}`),
                    ),
                  ),
                ),
            { discard: true },
          );
          // Do not make a task terminal before cleanup has been attempted. The
          // durable capacity view treats planned/created tasks and non-terminal
          // failed compensation as active, so projector lag and restart cannot
          // briefly admit a replacement while this task may still be running.
          yield* operationStore.markTaskStatus(operationId, "failed").pipe(
            Effect.catch((error) =>
              Effect.logWarning("agent gateway could not mark external task failed", {
                operationId,
                error: errorText(error),
              }),
            ),
          );
          const failure = {
            code: interrupted ? "request_interrupted" : "dispatch_failed",
            message: failureMessage,
            createdThreadCount: createdThreads.length,
            compensatedThreadCount,
            compensatedWorktreeCount,
            compensationErrors,
          };
          if (compensationErrors.length > 0) {
            yield* operationStore
              .recordCompensationFailure({
                operationId,
                errorJson: JSON.stringify(failure),
                now: gatewayIsoNow(),
              })
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning("agent gateway compensation status could not be persisted", {
                    operationId,
                    error: errorText(error),
                  }),
                ),
              );
            yield* Effect.logWarning("agent gateway compensation remains pending", {
              operationId,
              errors: compensationErrors,
            });
            return new GatewayToolError(
              "operation_failed",
              "Synara could not dispatch the exact creation plan and cleanup is still pending. The durable operation remains compensating and will never create replacements.",
              { operationId, ...failure, compensationPending: true },
            );
          }

          const statusFailure = yield* operationStore
            .fail({
              operationId,
              errorJson: JSON.stringify(failure),
              now: gatewayIsoNow(),
            })
            .pipe(
              Effect.match({
                onFailure: (error) => error,
                onSuccess: () => null,
              }),
            );
          if (statusFailure !== null) {
            const statusError = `operation status: ${errorText(statusFailure)}`;
            compensationErrors.push(statusError);
            yield* operationStore
              .recordCompensationFailure({
                operationId,
                errorJson: JSON.stringify(failure),
                now: gatewayIsoNow(),
              })
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning("agent gateway fallback status could not be persisted", {
                    operationId,
                    error: errorText(error),
                  }),
                ),
              );
            return new GatewayToolError(
              "operation_failed",
              "Synara compensated the created resources but could not persist a terminal operation status. The operation remains compensating and will never create replacements.",
              { operationId, ...failure, compensationPending: true },
            );
          }
          return new GatewayToolError(
            "operation_failed",
            "Synara could not dispatch the exact creation plan. Created operation-owned resources were compensated; no replacements were created.",
            { operationId, ...failure },
          );
        });

      let claimedByThisFiber = false;
      const outcome = yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // Reservation and claim form one uninterruptible handshake. Once the
          // durable reservation exists, this fiber either claims it while the
          // compensation boundary is already installed or returns a replay.
          const reservation = yield* operationStore
            .reserve({
              operationId,
              requestId: input.requestId,
              fingerprint,
              requestedCount: prepared.length,
              planJson: canonicalJson(
                prepared.map((entry) => ({
                  index: entry.index,
                  projectId: entry.projectId,
                  workspaceRoot: entry.workspaceRoot,
                  environment: entry.environment,
                  runtimeMode: entry.runtimeMode,
                  worktreeRef: entry.worktreeRef,
                  newBranch: entry.newBranch,
                  plannedWorktreePath: entry.plannedWorktreePath,
                  ownershipPreflightPassed: entry.ownershipPreflightPassed,
                  ids: entry.ids,
                })),
              ),
              now: gatewayIsoNow(),
            })
            .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));

          if (reservation.kind === "idempotency_conflict") {
            return yield* Effect.fail(
              new GatewayToolError(
                "idempotency_conflict",
                `Request id "${input.requestId}" was already used with a different creation plan.`,
                { operationId: reservation.operation.operationId },
              ),
            );
          }
          if (reservation.kind === "concurrency_limited") {
            return yield* Effect.fail(
              new GatewayToolError(
                "concurrency_limited",
                `This integration already has ${reservation.activeCount} active externally created tasks/operations (limit ${reservation.limit}).`,
              ),
            );
          }
          if (reservation.kind === "creation_plan_locked") {
            return yield* Effect.fail(
              new GatewayToolError(
                "creation_plan_locked",
                "This caller turn already committed a different thread-creation plan. A new user turn is required for another plan.",
                {
                  operationId: reservation.operation.operationId,
                  requestId: reservation.operation.requestId,
                  requestedCount: reservation.operation.requestedCount,
                  status: reservation.operation.status,
                },
              ),
            );
          }
          if (reservation.kind === "replay" && reservation.operation.status === "completed") {
            return {
              kind: "replay" as const,
              result: mcpToolResultJson(JSON.parse(reservation.operation.resultJson ?? "{}")),
            };
          }
          if (reservation.kind === "replay" && reservation.operation.status === "failed") {
            return yield* Effect.fail(
              new GatewayToolError(
                "operation_failed",
                "The original thread-creation operation failed; it will not create replacement threads.",
                {
                  operationId: reservation.operation.operationId,
                  error: reservation.operation.errorJson
                    ? JSON.parse(reservation.operation.errorJson)
                    : null,
                },
              ),
            );
          }
          if (reservation.kind === "replay" && reservation.operation.status !== "reserved") {
            return {
              kind: "replay" as const,
              result: yield* restore(
                awaitCreationReplay(operationStore, operationId, context.assertAuthority),
              ),
            };
          }

          const claimed = yield* operationStore
            .markDispatching({ operationId, now: gatewayIsoNow() })
            .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
          if (!claimed) {
            return {
              kind: "replay" as const,
              result: yield* restore(
                awaitCreationReplay(operationStore, operationId, context.assertAuthority),
              ),
            };
          }
          claimedByThisFiber = true;

          yield* Effect.forEach(
            prepared,
            (entry) =>
              operationStore.registerTask({
                operationId,
                requestId: input.requestId,
                threadId: entry.ids.threadId,
                projectId: entry.projectId,
                now: gatewayIsoNow(),
              }),
            { discard: true },
          );

          const results = yield* restore(
            Effect.forEach(
              prepared,
              (entry) =>
                Effect.gen(function* () {
                  yield* context.assertAuthority();
                  let branch: string | null = null;
                  let worktreePath: string | null = null;
                  let associatedWorktreeRef: string | null = null;
                  if (entry.environment === "worktree") {
                    const { created, trackedWorktree } = yield* Effect.uninterruptible(
                      Effect.gen(function* () {
                        const created = yield* git.createDetachedWorktree({
                          cwd: entry.workspaceRoot,
                          ref: entry.worktreeRef!,
                          path: entry.plannedWorktreePath,
                          ...(entry.copyChangesFrom
                            ? { copyChangesFrom: entry.copyChangesFrom }
                            : {}),
                        });
                        const trackedWorktree = {
                          cwd: entry.workspaceRoot,
                          path: created.worktree.path,
                          branch: created.worktree.branch,
                          proof: null as (typeof createdWorktrees)[number]["proof"],
                        };
                        createdWorktrees.push(trackedWorktree);
                        return { created, trackedWorktree };
                      }),
                    );
                    // The setup script can run for minutes, so it must stay
                    // interruptible: the abort signal kills the child process and
                    // the tracked, still-ownerless worktree is compensated away.
                    yield* Effect.tryPromise({
                      try: (signal) =>
                        runWorktreeSetupScript(entry.projectScripts, trackedWorktree.path, signal),
                      catch: (cause) =>
                        new Error(`Worktree setup script failed: ${errorText(cause)}`),
                    });
                    yield* Effect.uninterruptible(
                      Effect.gen(function* () {
                        const proof = yield* git.recordWorktreeOwnership({
                          path: trackedWorktree.path,
                          branch: trackedWorktree.branch,
                          token: randomUUID(),
                        });
                        trackedWorktree.proof = proof;
                        const ownershipRecorded = yield* operationStore.recordWorktreeCreated({
                          operationId,
                          index: entry.index,
                          workspaceRoot: entry.workspaceRoot,
                          path: trackedWorktree.path,
                          branch: trackedWorktree.branch,
                          token: proof.token,
                          gitDir: proof.gitDir,
                          head: proof.head,
                          ...(proof.stateHash ? { stateHash: proof.stateHash } : {}),
                          now: gatewayIsoNow(),
                        });
                        if (!ownershipRecorded) {
                          return yield* Effect.fail(
                            new Error(
                              `Could not persist ownership for created worktree ${trackedWorktree.path}; compensating it before dispatch.`,
                            ),
                          );
                        }
                      }),
                    );
                    branch = created.worktree.branch;
                    worktreePath = created.worktree.path;
                    associatedWorktreeRef = created.worktree.ref;
                  }

                  const interactionMode = interactionModeForGatewayTarget(entry.target);
                  yield* context.assertAuthority();
                  yield* orchestrationEngine
                    .dispatch({
                      type: "thread.create",
                      commandId: entry.ids.threadCreateCommandId,
                      threadId: entry.ids.threadId,
                      projectId: entry.projectId,
                      title: entry.title,
                      modelSelection: entry.target,
                      runtimeMode: entry.runtimeMode,
                      interactionMode,
                      envMode: entry.environment,
                      branch,
                      worktreePath,
                      creationSource:
                        context.kind === "external-client" ? "external_mcp" : "synara_mcp",
                      ...(context.kind === "provider-session"
                        ? {
                            sourceThreadId: ThreadId.makeUnsafe(context.callerThreadId),
                            sourceTurnId: TurnId.makeUnsafe(callerTurnId!),
                          }
                        : {}),
                      gatewayOperationId: operationId,
                      gatewayOperationIndex: entry.index,
                      ...(worktreePath !== null
                        ? {
                            associatedWorktreePath: worktreePath,
                            associatedWorktreeBranch: branch,
                            associatedWorktreeRef,
                          }
                        : {}),
                      createdAt: gatewayIsoNow(),
                    })
                    .pipe(
                      Effect.tap(() => Effect.sync(() => createdThreads.push(entry))),
                      Effect.uninterruptible,
                    );

                  yield* context.assertAuthority();
                  yield* orchestrationEngine.dispatch({
                    type: "thread.turn.start",
                    commandId: entry.ids.turnStartCommandId,
                    threadId: entry.ids.threadId,
                    message: {
                      messageId: entry.ids.messageId,
                      role: "user",
                      text: entry.spec.prompt,
                      attachments: [],
                    },
                    modelSelection: entry.target,
                    dispatchMode: "queue",
                    dispatchOrigin: "agent",
                    runtimeMode: entry.runtimeMode,
                    interactionMode,
                    createdAt: gatewayIsoNow(),
                  });
                  // The dispatch can outlive the caller turn. Recheck after it returns so
                  // a child started in that final race window is compensated as part of
                  // the same durable operation instead of being left detached.
                  yield* context.assertAuthority();

                  yield* operationStore.markTaskStatus(operationId, "created");

                  return {
                    index: entry.index,
                    threadId: entry.ids.threadId,
                    projectId: entry.projectId,
                    title: entry.title,
                    target: entry.target,
                    provider: entry.target.provider,
                    model: entry.target.model,
                    runtimeMode: entry.runtimeMode,
                    environment: entry.environment,
                    branch,
                    worktreePath,
                    status: "task_dispatched" as const,
                  };
                }),
              { concurrency: 1 },
            ),
          );
          const result = {
            operationId,
            requestId: input.requestId,
            requestedCount: input.threads.length,
            createdCount: results.length,
            threadIds: results.map((entry) => entry.threadId),
            threads: results,
          } satisfies SynaraCreateThreadsResult;
          // Once every deterministic dispatch succeeded, durable completion is
          // the commit point. A late client cancellation must not roll back a
          // fully-created operation or strand it between dispatching/completed.
          yield* operationStore.complete({
            operationId,
            resultJson: JSON.stringify(result),
            now: gatewayIsoNow(),
          });
          return { kind: "created" as const, result };
        }).pipe(
          Effect.catchCause((cause) =>
            claimedByThisFiber
              ? compensateClaimedOperation(cause).pipe(
                  Effect.flatMap((compensationError) =>
                    Cause.hasInterrupts(cause) || Cause.hasDies(cause)
                      ? Effect.failCause(cause)
                      : Effect.fail(compensationError),
                  ),
                )
              : Effect.failCause(cause),
          ),
        ),
      );

      if (outcome.kind === "replay") return outcome.result;
      const result = outcome.result;
      if (context.kind === "provider-session") {
        yield* appendThreadCreationRecap({
          callerThreadId: context.callerThreadId,
          callerTurnId: callerTurnId!,
          result,
        });
      }
      return mcpToolResultJson(result);
    }).pipe(
      (effect) =>
        withCreationPlanLock(
          context.kind === "provider-session"
            ? `${context.callerThreadId}\u0000${context.callerTurnId ?? "inactive"}`
            : `${context.integrationId}\u0000${input.requestId}`,
          effect,
        ),
      Effect.catch((error) =>
        Effect.succeed(
          error instanceof GatewayToolError || error instanceof AgentGatewayTargetError
            ? gatewayToolErrorResult(error)
            : mcpToolResultError(errorText(error)),
        ),
      ),
    );
  };

  return run;
});

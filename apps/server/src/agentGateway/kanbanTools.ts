import {
  type OrchestrationThreadShell,
  type TurnDispatchMode,
  SynaraCreateThreadsInput,
  SynaraCreateThreadsResult,
} from "@synara/contracts";
import {
  deriveKanbanColumnV2,
  deriveKanbanAttention,
  KANBAN_COLUMN_V2_LABELS,
  type KanbanAttentionFlag,
  type KanbanColumnV2Key,
  type KanbanThreadDerivationInput,
} from "@synara/shared/kanban";
import { Effect, Option, Schema } from "effect";

import {
  isOrdinaryProjectRow,
  threadHasInFlightTurn,
  type SpaceAssignmentWorkspacePaths,
} from "../orchestration/commandInvariants.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { GatewayCreationContext } from "./creationCoordinator.ts";
import { mcpToolResultError, mcpToolResultJson, type McpToolCallResult } from "./protocol.ts";
import {
  buildModelSelection,
  decodeCreateThreadsInput,
  errorText,
  readStringArg,
  ToolInputError,
} from "./toolInput.ts";
import {
  GatewayToolError,
  gatewayToolErrorResult,
  READ_ONLY_TOOL_ANNOTATIONS,
  type ToolEntry,
  type ToolContext,
} from "./toolRuntime.ts";
import { summarizeThreadShell } from "./threadSummary.ts";

/**
 * Server-side adapter from a durable `OrchestrationThreadShell` into the shared
 * `KanbanThreadDerivationInput`, mirroring the web adapter so columns and flags
 * match the v2 board for the same thread (column parity). The durable shell's
 * `updatedAt` advances on every appended message (no frozen-summary caveat).
 */
function toKanbanThreadDerivationInput(
  thread: OrchestrationThreadShell,
): KanbanThreadDerivationInput {
  const updatedAtMs = Date.parse(thread.updatedAt ?? "");
  const { latestTurn, session } = thread;
  return {
    latestTurn: latestTurn
      ? {
          state: latestTurn.state,
          startedAt: latestTurn.startedAt,
          completedAt: latestTurn.completedAt,
        }
      : null,
    session: session
      ? {
          status: session.status,
          updatedAt: session.updatedAt,
          lastError: session.lastError ?? null,
        }
      : null,
    threadUpdatedAt: thread.updatedAt ?? null,
    lastActivityTimestampMs: Number.isFinite(updatedAtMs) ? updatedAtMs : null,
    hasPendingApprovals: thread.hasPendingApprovals ?? false,
    hasPendingUserInput: thread.hasPendingUserInput ?? false,
  };
}

interface ReadKanbanCard {
  threadId: string;
  title: string;
  provider: string;
  model: string;
  branch: string | null;
  worktreePath: string | null;
  lastKnownPr: {
    number: number;
    title: string;
    url: string;
    baseBranch: string;
    headBranch: string;
    state: "open" | "closed" | "merged";
  } | null;
  summary: ReturnType<typeof summarizeThreadShell>;
  attention: KanbanAttentionFlag[];
  column: KanbanColumnV2Key;
}

/**
 * Hard cap on the cards `synara_read_kanban_board` will materialize and
 * serialize into one MCP response. The board read loads the durable shell
 * snapshot and derives a card for every non-archived thread in JS; without a
 * bound a single workspace with tens of thousands of threads would hydrate
 * them all into one multi-MB JSON blob (memory + latency). When the live card
 * count exceeds this cap the read stops and reports `truncated: true` so a
 * caller can fall back to scoped reads (synara_read_kanban_card) instead.
 */
const MAX_CARDS_PER_BOARD = 500;

function deriveCard(
  thread: OrchestrationThreadShell,
  now: number,
  callerThreadId: string,
): ReadKanbanCard {
  const pr = thread.lastKnownPr ?? null;
  const input = toKanbanThreadDerivationInput(thread);
  return {
    threadId: thread.id,
    title: thread.title,
    provider: thread.modelSelection.provider,
    model: thread.modelSelection.model,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    lastKnownPr: pr,
    summary: summarizeThreadShell(thread, callerThreadId),
    attention: deriveKanbanAttention(input, {
      now,
      needsReview: pr !== null && pr.state === "open",
    }),
    column: deriveKanbanColumnV2(input, { now }),
  };
}

export interface KanbanGatewayHelpers {
  readonly requireThreadShell: (
    threadId: string,
  ) => Effect.Effect<OrchestrationThreadShell, unknown, never>;
  readonly assertCallerMayDriveThread: (
    caller: OrchestrationThreadShell,
    target: OrchestrationThreadShell,
  ) => Effect.Effect<void, unknown, never>;
  /** Exactly-once creation saga for one or more threads (creationCoordinator). */
  readonly runCreateThreads: (
    input: typeof SynaraCreateThreadsInput.Type,
    context: GatewayCreationContext,
  ) => Effect.Effect<McpToolCallResult, never, never>;
  /** Start (or restart) a turn on an existing thread — mirrors sendMessage. */
  readonly startTurn: (input: {
    threadId: string;
    message: string;
    dispatchMode: TurnDispatchMode;
    runtimeMode: OrchestrationThreadShell["runtimeMode"];
    interactionMode: OrchestrationThreadShell["interactionMode"];
  }) => Effect.Effect<unknown, unknown, never>;
  /** Request interruption of a running turn — mirrors interruptThread. */
  readonly interruptTurn: (input: {
    threadId: string;
  }) => Effect.Effect<{ sequence: number }, unknown>;
}

export interface KanbanToolsInput {
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly workspacePaths: SpaceAssignmentWorkspacePaths;
  readonly helpers: KanbanGatewayHelpers;
  readonly now?: () => number;
}

/**
 * Render a failed kanban tool effect as an MCP tool error result.
 * GatewayToolError keeps its machine-readable code and details; every other
 * failure degrades to its message text.
 */
const catchToolError = (error: unknown): Effect.Effect<McpToolCallResult> =>
  Effect.succeed(
    error instanceof GatewayToolError
      ? gatewayToolErrorResult(error)
      : mcpToolResultError(errorText(error)),
  );

/** Trimmed string arg for the audit log; undefined when absent/non-string. */
const auditArg = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

export function makeAgentGatewayKanbanTools(input: KanbanToolsInput): ReadonlyArray<ToolEntry> {
  const { snapshotQuery, workspacePaths, helpers } = input;
  const now = input.now ?? (() => Date.now());
  const {
    requireThreadShell,
    assertCallerMayDriveThread,
    runCreateThreads,
    startTurn,
    interruptTurn,
  } = helpers;

  const MAX_CONCURRENT_KANBAN_WRITES_PER_CALLER = 4;
  const inFlightWrites = new Map<string, number>();

  /**
   * Audit every kanban tool call: structured log with the tool name, the
   * calling session, and the outcome (error vs. success). On success it also
   * surfaces a couple of operationally-useful signals pulled from the MCP
   * result text (board truncation, dispatched column) so board saturation and
   * move patterns are observable without parsing JSON-RPC traffic by hand.
   * Normalized non-secret arguments (threadId, target column, projectId,
   * requestId) are logged alongside so the log answers "who moved what where"
   * without the prompt bodies. The result is returned unchanged.
   */
  function withKanbanToolAudit(
    toolName: string,
    run: (args: Record<string, unknown>, context: ToolContext) => Effect.Effect<McpToolCallResult>,
  ): (args: Record<string, unknown>, context: ToolContext) => Effect.Effect<McpToolCallResult> {
    return (args, context) =>
      run(args, context).pipe(
        Effect.tap((result) => {
          const textContent = result.content[0];
          const payload = textContent?.type === "text" ? textContent.text : "";
          const truncated = payload.includes('"truncated":true');
          const outcome = result.isError ? "error" : truncated ? "truncated" : "ok";
          const threadId = auditArg(args, "threadId");
          const target = auditArg(args, "target");
          const projectId = auditArg(args, "projectId");
          const requestId = auditArg(args, "requestId");
          return Effect.logInfo("agent_gateway.kanban_tool", {
            tool: toolName,
            callerSessionKey: context.callerSessionKey,
            callerThreadId: context.callerThreadId,
            outcome,
            ...(threadId !== undefined ? { threadId } : {}),
            ...(target !== undefined ? { target } : {}),
            ...(projectId !== undefined ? { projectId } : {}),
            ...(requestId !== undefined ? { requestId } : {}),
          });
        }),
      );
  }

  /**
   * Bound concurrent kanban write dispatches per caller. Acquires a slot
   * before the write runs and releases it on success, failure, or interrupt.
   * Over the cap the call fails fast with a tool error instead of dispatching
   * more provider work.
   */
  function withKanbanWriteConcurrencyGuard(
    run: (args: Record<string, unknown>, context: ToolContext) => Effect.Effect<McpToolCallResult>,
  ): (args: Record<string, unknown>, context: ToolContext) => Effect.Effect<McpToolCallResult> {
    return (args, context) =>
      Effect.gen(function* () {
        const sessionKey = context.callerSessionKey;
        const active = inFlightWrites.get(sessionKey) ?? 0;
        if (active >= MAX_CONCURRENT_KANBAN_WRITES_PER_CALLER) {
          return mcpToolResultError(
            `Too many concurrent kanban write calls (${active}) from this session; wait for in-flight create/move calls to settle.`,
          );
        }
        inFlightWrites.set(sessionKey, active + 1);
        return yield* run(args, context).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              const next = (inFlightWrites.get(sessionKey) ?? 1) - 1;
              if (next <= 0) inFlightWrites.delete(sessionKey);
              else inFlightWrites.set(sessionKey, next);
            }),
          ),
        );
      });
  }

  const readBoard: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "synara_read_kanban_board",
      description:
        "Read the durable Kanban board: projects and their columns (Draft, In Progress, Awaiting you, Done), each card with provider/model, branch/worktree, PR state, a thread summary, and its attention flags. Column and attention derive from the same shared model as the Synara board UI, so a card's column here matches what the board renders; client-only draft/optimistic overlays the UI shows are not included. Attention flags are awaiting-approval, awaiting-input, failed, stuck, needs-review — an Awaiting-you card is waiting on the human (approval or input) and cannot be moved by synara_move_kanban_card.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "Only this project (any by default).",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        title: "Read the Synara kanban board",
        ...READ_ONLY_TOOL_ANNOTATIONS,
      },
    },
    handler: withKanbanToolAudit("synara_read_kanban_board", (args, context) =>
      Effect.gen(function* () {
        const callerShell = yield* requireThreadShell(context.callerThreadId).pipe(
          Effect.mapError((error) => new ToolInputError(errorText(error))),
        );
        const requestedProjectId = readStringArg(args, "projectId");
        const callerProjectId = String(callerShell.projectId);
        if (requestedProjectId !== undefined && requestedProjectId !== callerProjectId) {
          return yield* Effect.fail(
            new ToolInputError(
              `Cannot read board for project "${requestedProjectId}"; use the caller's project "${callerProjectId}".`,
            ),
          );
        }
        const projectId = requestedProjectId ?? callerProjectId;
        const snapshot = yield* snapshotQuery
          .getShellSnapshot()
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        const at = now();
        let emittedCardCount = 0;
        let truncated = false;
        const visibleProjects = snapshot.projects
          .filter((project) => (projectId ? project.id === projectId : true))
          .filter((project) =>
            isOrdinaryProjectRow({
              projectKind: project.kind,
              projectTitle: project.title,
              projectWorkspaceRoot: project.workspaceRoot,
              workspacePaths,
            }),
          );
        const projects: Array<{
          projectId: string;
          name: string;
          columns: Array<{
            key: KanbanColumnV2Key;
            label: string;
            cards: ReadKanbanCard[];
          }>;
        }> = [];
        for (const project of visibleProjects) {
          const cardsBeforeProject = emittedCardCount;
          // Past the board-wide cap, stop emitting project rows entirely: an
          // empty-column project would read as "no cards" — a lie the
          // `truncated` flag exists to prevent.
          if (truncated) break;
          const columnBuckets: Record<KanbanColumnV2Key, ReadKanbanCard[]> = {
            draft: [],
            inProgress: [],
            awaitingYou: [],
            done: [],
          };
          for (const thread of snapshot.threads) {
            if (thread.projectId !== project.id || (thread.archivedAt ?? null) !== null) continue;
            if (emittedCardCount >= MAX_CARDS_PER_BOARD) {
              truncated = true;
              break;
            }
            const card = deriveCard(thread, at, context.callerThreadId);
            columnBuckets[card.column].push(card);
            emittedCardCount += 1;
          }
          // Truncation landed inside this project before it emitted anything:
          // drop the would-be empty row instead of reporting ghost columns.
          if (truncated && emittedCardCount === cardsBeforeProject) break;
          for (const bucket of Object.values(columnBuckets)) {
            bucket.sort((a, b) => (a.summary.updatedAt < b.summary.updatedAt ? 1 : -1));
          }
          projects.push({
            projectId: project.id,
            name: project.title,
            columns: (["draft", "inProgress", "awaitingYou", "done"] as const).map((key) => ({
              key,
              label: KANBAN_COLUMN_V2_LABELS[key],
              cards: columnBuckets[key],
            })),
          });
        }
        return mcpToolResultJson({
          projects,
          asOf: new Date(at).toISOString(),
          callerThreadId: context.callerThreadId,
          truncated,
          ...(truncated
            ? {
                truncatedReason: `Board read capped at ${MAX_CARDS_PER_BOARD} cards; use synara_read_kanban_card for a single thread.`,
              }
            : {}),
        });
      }).pipe(Effect.catch(catchToolError)),
    ),
  };

  const readCard: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "synara_read_kanban_card",
      description:
        "Read a single Kanban card by thread id: its column (Draft, In Progress, Awaiting you, Done), provider/model, branch/worktree, PR state, thread summary, and attention flags. Bounded and cheap — reads one thread shell rather than the whole board, so prefer it to check a single card's state without loading synara_read_kanban_board. Column and attention derive from the same shared model as the board UI.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: {
            type: "string",
            description: "Thread id of the card to read.",
          },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
      annotations: {
        title: "Read a Synara kanban card",
        ...READ_ONLY_TOOL_ANNOTATIONS,
      },
    },
    handler: withKanbanToolAudit("synara_read_kanban_card", (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        const callerShell = yield* requireThreadShell(context.callerThreadId).pipe(
          Effect.mapError((error) => new ToolInputError(errorText(error))),
        );
        const thread = yield* requireThreadShell(threadId).pipe(
          Effect.mapError((error) => new ToolInputError(errorText(error))),
        );
        if (thread.projectId !== callerShell.projectId) {
          return yield* Effect.fail(
            new ToolInputError(
              `Thread "${threadId}" is in a different project. Use synara_read_kanban_board for your own project "${callerShell.projectId}".`,
            ),
          );
        }
        // Mirror the board read's project filter: threads in managed chat or
        // Studio containers (or the legacy home chat row) have no board card,
        // so a scoped read must not materialize one either.
        const snapshot = yield* snapshotQuery
          .getShellSnapshot()
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        const project = snapshot.projects.find((candidate) => candidate.id === thread.projectId);
        if (
          !project ||
          !isOrdinaryProjectRow({
            projectKind: project.kind,
            projectTitle: project.title,
            projectWorkspaceRoot: project.workspaceRoot,
            workspacePaths,
          })
        ) {
          return yield* Effect.fail(
            new ToolInputError(
              `Thread "${threadId}" is not in an ordinary project and has no Kanban card.`,
            ),
          );
        }
        if ((thread.archivedAt ?? null) !== null) {
          return yield* Effect.fail(
            new ToolInputError(`Thread "${threadId}" is archived and has no board card.`),
          );
        }
        const card = deriveCard(thread, now(), context.callerThreadId);
        return mcpToolResultJson({
          card,
          asOf: new Date(now()).toISOString(),
          callerThreadId: context.callerThreadId,
        });
      }).pipe(Effect.catch(catchToolError)),
    ),
  };

  const createTask: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_create_kanban_task",
      description:
        "Create a Kanban task from a title and optional description/prompt: starts a new Synara thread and immediately starts a turn, so the card renders In Progress while the turn is live. Reuse the returned threadId with synara_read_thread or synara_move_kanban_card. requestId is required and retries with the same requestId replay exactly-once.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Task title." },
          description: {
            type: "string",
            description: "Optional task description; used as the first-turn prompt.",
          },
          projectId: {
            type: "string",
            description: "Project to attach the task to.",
          },
          model: {
            type: "string",
            description: "Model slug override (defaults to caller).",
          },
          requestId: {
            type: "string",
            maxLength: 256,
            description: "Idempotency key.",
          },
        },
        required: ["title", "requestId"],
        additionalProperties: false,
      },
      annotations: {
        title: "Create a Kanban task",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    handler: withKanbanToolAudit(
      "synara_create_kanban_task",
      withKanbanWriteConcurrencyGuard((args, context) =>
        Effect.suspend(() =>
          Effect.gen(function* () {
            const caller = context.callerThreadId;
            const title = readStringArg(args, "title", { required: true })!;
            const description = readStringArg(args, "description");
            const projectId = readStringArg(args, "projectId");
            const model = readStringArg(args, "model");
            const requestId = readStringArg(args, "requestId", {
              required: true,
            })!;
            const callerShell = yield* requireThreadShell(caller).pipe(
              Effect.mapError((error) => new ToolInputError(errorText(error))),
            );
            // Provider sessions may only create tasks in their own project.
            if (projectId !== undefined && projectId !== String(callerShell.projectId)) {
              return yield* Effect.fail(
                new ToolInputError(
                  `Cannot create a task in project "${projectId}"; use the caller's own project "${callerShell.projectId}".`,
                ),
              );
            }
            // Default the provider to the caller's own and the model to the
            // caller's own thread model, so an agent never spawns a task on a
            // provider it cannot reason about — or silently on a different
            // model than the one it runs itself.
            const spec: Record<string, unknown> = {
              title,
              prompt: description ?? title,
              target: buildModelSelection(
                context.callerProvider,
                model,
                callerShell.modelSelection.model,
              ),
              projectId: String(callerShell.projectId),
            };
            const result = yield* runCreateThreads(
              decodeCreateThreadsInput({ requestId, threads: [spec] }),
              {
                kind: "provider-session",
                callerThreadId: caller,
                callerTurnId: context.callerTurnId,
                assertAuthority: context.assertCallerTurnActive,
              },
            );
            if (result.isError) return result;
            const content = result.content[0];
            if (content?.type !== "text") {
              return yield* Effect.fail(
                new GatewayToolError(
                  "operation_failed",
                  "synara_create_kanban_task received no JSON payload from the creation saga; the operation may have succeeded — retry with the same requestId (it replays exactly-once) or check the board.",
                ),
              );
            }
            // The creation saga returns a SynaraCreateThreadsResult (`threadIds`
            // / per-thread `threads`, never a top-level `threadId`). Decode it
            // against the shared contract so shape drift fails loudly instead of
            // degrading into an unparseable card view.
            const batch = yield* Effect.try({
              try: () =>
                Schema.decodeUnknownSync(SynaraCreateThreadsResult)(JSON.parse(content.text)),
              catch: (error) =>
                new GatewayToolError(
                  "operation_failed",
                  "synara_create_kanban_task could not decode the creation saga result as SynaraCreateThreadsResult; the operation may have succeeded — retry with the same requestId (it replays exactly-once) or check the board.",
                  { reason: errorText(error) },
                ),
            });
            // Read the first created thread so the create → read → move loop
            // works against the real contract shape. The card view is
            // decoration: a projection that has not caught up yet must not turn
            // an already-successful creation into a tool error.
            const createdThreadId = batch.threads[0]?.threadId ?? batch.threadIds[0];
            if (!createdThreadId) return result;
            const threadShell = yield* requireThreadShell(createdThreadId).pipe(Effect.option);
            const createdCard = Option.isSome(threadShell)
              ? (() => {
                  const thread = threadShell.value;
                  const cardView = deriveCard(thread, now(), context.callerThreadId);
                  return {
                    threadId: thread.id,
                    title: thread.title,
                    column: cardView.column,
                    attention: cardView.attention,
                  };
                })()
              : {
                  threadId: createdThreadId,
                  title,
                  column: "inProgress" as const,
                  attention: [],
                };
            return mcpToolResultJson({
              operationId: batch.operationId,
              threadId: createdThreadId,
              title: createdCard.title,
              status: "task_dispatched",
              card: {
                threadId: createdCard.threadId,
                title: createdCard.title,
                column: createdCard.column,
                attention: createdCard.attention,
              },
            });
          }).pipe(Effect.catch(catchToolError)),
        ),
      ),
    ),
  };

  const moveCard: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_move_kanban_card",
      description:
        'Move a Kanban card between the actionable columns. target "inProgress" starts (or resumes) work on the thread, optionally with a message; target "done" requests that a running turn settle (falls back to interrupting it). A card already in the requested column reports a no-op (alreadyInProgress / alreadyDone). Awaiting-you is a human-attention state: target "inProgress" reports a no-op with awaitingYou=true, and target "done" is prohibited.',
      inputSchema: {
        type: "object",
        properties: {
          threadId: {
            type: "string",
            description: "Thread id of the card to move.",
          },
          target: { type: "string", enum: ["inProgress", "done"] },
          message: {
            type: "string",
            description:
              "Prompt/message for the started turn. Required when restarting a settled thread (a card outside In Progress with a completed turn).",
          },
        },
        required: ["threadId", "target"],
        additionalProperties: false,
      },
      annotations: {
        title: "Move a Kanban card",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    handler: withKanbanToolAudit(
      "synara_move_kanban_card",
      withKanbanWriteConcurrencyGuard((args, context) =>
        Effect.suspend(() =>
          Effect.gen(function* () {
            const threadId = readStringArg(args, "threadId", {
              required: true,
            })!;
            const target = readStringArg(args, "target", { required: true })!;
            if (target !== "inProgress" && target !== "done") {
              return yield* Effect.fail(
                new ToolInputError(`Argument "target" must be "inProgress" or "done".`),
              );
            }
            const message = readStringArg(args, "message") ?? null;
            const caller = yield* requireThreadShell(context.callerThreadId).pipe(
              Effect.mapError((error) => new ToolInputError(errorText(error))),
            );
            const card = yield* requireThreadShell(threadId).pipe(
              Effect.mapError((error) => new ToolInputError(errorText(error))),
            );
            if (card.projectId !== caller.projectId) {
              return yield* Effect.fail(
                new ToolInputError(
                  `Thread "${threadId}" is in a different project. Only your own project "${caller.projectId}" can be driven.`,
                ),
              );
            }
            yield* assertCallerMayDriveThread(caller, card);
            if ((card.archivedAt ?? null) !== null) {
              return yield* Effect.fail(
                new ToolInputError(`Thread "${threadId}" is archived and has no board card.`),
              );
            }
            const at = now();
            const cardView = deriveCard(card, at, context.callerThreadId);
            const currentColumn = cardView.column;
            const cardPayload = (column: string) => ({
              threadId,
              column,
              attention: cardView.attention,
            });
            if (target === "inProgress") {
              if (currentColumn === "awaitingYou") {
                // Awaiting-you is human attention: starting a turn here would
                // stomp it, so we report a no-op with the attention flag rather
                // than silently succeeding or failing.
                return mcpToolResultJson({
                  threadId,
                  target,
                  alreadyInProgress: true,
                  awaitingYou: true,
                  card: cardPayload(currentColumn),
                });
              }
              if (currentColumn === "inProgress") {
                // Already in the requested column: an idempotent no-op, not a
                // silent success for a refused move.
                return mcpToolResultJson({
                  threadId,
                  target,
                  alreadyInProgress: true,
                  card: cardPayload(currentColumn),
                });
              }
              const requiredMessage = message ?? (card.latestTurn ? null : "Continue this task.");
              if (!requiredMessage) {
                return yield* Effect.fail(
                  new ToolInputError(
                    'Argument "message" is required to restart a settled thread into a new turn.',
                  ),
                );
              }
              yield* startTurn({
                threadId,
                message: requiredMessage,
                dispatchMode: "queue",
                runtimeMode: card.runtimeMode,
                interactionMode: card.interactionMode,
              }).pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
              return mcpToolResultJson({
                threadId,
                target,
                turnStarted: true,
                card: cardPayload("inProgress"),
              });
            }
            // target === "done"
            if (currentColumn === "awaitingYou") {
              return yield* Effect.fail(
                new ToolInputError(
                  'Awaiting-you cards cannot be force-moved. Use a human response or target "inProgress".',
                ),
              );
            }
            if (currentColumn === "done") {
              // Already in the requested column: an idempotent no-op.
              return mcpToolResultJson({
                threadId,
                target,
                alreadyDone: true,
                card: cardPayload(currentColumn),
              });
            }
            if (!threadHasInFlightTurn(card)) {
              // "done" settles a running turn; a card with no in-flight turn
              // (a draft, or a stale in-progress view) cannot be completed, so
              // the impossible transition fails loudly instead of no-op'ing.
              return yield* Effect.fail(
                new GatewayToolError(
                  "operation_failed",
                  `Card "${threadId}" has no in-flight turn to settle; only a running card can be moved to Done.`,
                  { threadId, target, column: currentColumn },
                ),
              );
            }
            const dispatched = yield* interruptTurn({ threadId }).pipe(
              Effect.mapError((error) => new ToolInputError(errorText(error))),
            );
            return mcpToolResultJson({
              threadId,
              target,
              interruptRequested: true,
              eventSequence: dispatched.sequence,
              card: cardPayload(currentColumn),
            });
          }).pipe(Effect.catch(catchToolError)),
        ),
      ),
    ),
  };

  return [readBoard, readCard, createTask, moveCard];
}

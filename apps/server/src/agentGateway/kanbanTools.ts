import {
  type OrchestrationThreadShell,
  type TurnDispatchMode,
  type SynaraCreateThreadsInput,
} from "@synara/contracts";
import {
  deriveKanbanColumnV2,
  deriveKanbanAttention,
  KANBAN_COLUMN_V2_LABELS,
  type KanbanAttentionFlag,
  type KanbanColumnV2Key,
  type KanbanThreadDerivationInput,
} from "@synara/shared/kanban";
import { Effect } from "effect";

import {
  isOrdinaryProjectRow,
  type SpaceAssignmentWorkspacePaths,
} from "../orchestration/commandInvariants.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { GatewayCreationContext } from "./creationCoordinator.ts";
import { gatewayIsoNow as isoNow } from "./creationUtils.ts";
import { mcpToolResultError, mcpToolResultJson, type McpToolCallResult } from "./protocol.ts";
import {
  buildModelSelection,
  decodeCreateThreadsInput,
  errorText,
  readStringArg,
  ToolInputError,
} from "./toolInput.ts";
import { READ_ONLY_TOOL_ANNOTATIONS, type ToolEntry, type ToolContext } from "./toolRuntime.ts";
import { summarizeThreadShell } from "./threadSummary.ts";

/**
 * Server-side adapter from a durable `OrchestrationThreadShell` into the shared
 * `KanbanThreadDerivationInput`. Mirrors the web adapter in
 * `apps/web/src/components/kanban/kanban.logic.ts` so the read tool's columns and
 * attention flags match the v2 board for the same thread (column parity).
 *
 * The server reads the durable shell directly, so there is no frozen-summary
 * caveat (see the web adapter's streaming freeze note); the shell `updatedAt`
 * advances on every appended message.
 */
function toKanbanThreadDerivationInput(
  thread: OrchestrationThreadShell,
): KanbanThreadDerivationInput {
  const updatedAtMs = Date.parse(thread.updatedAt ?? "");
  return {
    latestTurn: thread.latestTurn
      ? {
          state: thread.latestTurn.state,
          startedAt: thread.latestTurn.startedAt,
          completedAt: thread.latestTurn.completedAt,
        }
      : null,
    session: thread.session
      ? {
          status: thread.session.status,
          updatedAt: thread.session.updatedAt,
          lastError: thread.session.lastError ?? null,
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

function deriveCard(thread: OrchestrationThreadShell, now: number): ReadKanbanCard {
  const pr = thread.lastKnownPr ?? null;
  const input = toKanbanThreadDerivationInput(thread);
  const column = deriveKanbanColumnV2(input, { now });
  const attention = deriveKanbanAttention(input, {
    now,
    needsReview: pr !== null && pr.state === "open",
  });
  return {
    threadId: thread.id,
    title: thread.title,
    provider: thread.modelSelection.provider,
    model: thread.modelSelection.model,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    lastKnownPr: pr
      ? {
          number: pr.number,
          title: pr.title,
          url: pr.url,
          baseBranch: pr.baseBranch,
          headBranch: pr.headBranch,
          state: pr.state,
        }
      : null,
    summary: summarizeThreadShell(thread, thread.id),
    attention,
    column,
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

  /**
   * Per-caller in-flight cap on kanban write tools (create/move). Each is a
   * turn dispatch that spins up provider work; without a bound one agent could
   * fan out unbounded concurrent dispatches from a single turn. The guard is
   * per process-local session (an agent runs in one server process), rejects
   * over the cap with a visible error rather than queuing, and is best-effort:
   * a caller that keeps retrying after rejection still advances its own turn.
   */
  const MAX_CONCURRENT_KANBAN_WRITES_PER_CALLER = 4;
  const inFlightWrites = new Map<string, number>();

  /**
   * Audit every kanban tool call: structured log with the tool name, the
   * calling session, and the outcome (error vs. success). On success it also
   * surfaces a couple of operationally-useful signals pulled from the MCP
   * result text (board truncation, dispatched column) so board saturation and
   * move patterns are observable without parsing JSON-RPC traffic by hand.
   * The result is returned unchanged.
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
          return Effect.logInfo("agent_gateway.kanban_tool", {
            tool: toolName,
            callerSessionKey: context.callerSessionKey,
            callerThreadId: context.callerThreadId,
            outcome,
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
          projectId: { type: "string", description: "Only this project (any by default)." },
        },
        additionalProperties: false,
      },
      annotations: { title: "Read the Synara kanban board", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: withKanbanToolAudit("synara_read_kanban_board", (args, context) =>
      Effect.gen(function* () {
        const projectId = readStringArg(args, "projectId");
        const snapshot = yield* snapshotQuery
          .getShellSnapshot()
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        const at = now();
        let emittedCardCount = 0;
        let truncated = false;
        const projects = snapshot.projects
          .filter((project) => (projectId ? project.id === projectId : true))
          .filter((project) =>
            isOrdinaryProjectRow({
              projectKind: project.kind,
              projectTitle: project.title,
              projectWorkspaceRoot: project.workspaceRoot,
              workspacePaths,
            }),
          )
          .map((project) => {
            const columnBuckets: Record<KanbanColumnV2Key, ReadKanbanCard[]> = {
              draft: [],
              inProgress: [],
              awaitingYou: [],
              done: [],
            };
            for (const thread of snapshot.threads) {
              if (thread.projectId !== project.id) continue;
              if ((thread.archivedAt ?? null) !== null) continue;
              // Stop materializing once the board-wide cap is reached: the
              // response stays bounded and the `truncated` flag tells the
              // caller the board is incomplete (scoped reads are the fallback).
              if (emittedCardCount >= MAX_CARDS_PER_BOARD) {
                truncated = true;
                break;
              }
              const card = deriveCard(thread, at);
              columnBuckets[card.column].push(card);
              emittedCardCount += 1;
            }
            for (const bucket of Object.values(columnBuckets)) {
              bucket.sort((a, b) => (a.summary.updatedAt < b.summary.updatedAt ? 1 : -1));
            }
            return {
              projectId: project.id,
              name: project.title,
              columns: (["draft", "inProgress", "awaitingYou", "done"] as const).map((key) => ({
                key,
                label: KANBAN_COLUMN_V2_LABELS[key],
                cards: columnBuckets[key],
              })),
            };
          });
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
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
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
          threadId: { type: "string", description: "Thread id of the card to read." },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
      annotations: { title: "Read a Synara kanban card", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: withKanbanToolAudit("synara_read_kanban_card", (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        const thread = yield* requireThreadShell(threadId).pipe(
          Effect.mapError((error) => new ToolInputError(errorText(error))),
        );
        if ((thread.archivedAt ?? null) !== null) {
          return yield* Effect.fail(
            new ToolInputError(`Thread "${threadId}" is archived and has no board card.`),
          );
        }
        const card = deriveCard(thread, now());
        return mcpToolResultJson({
          card,
          asOf: new Date(now()).toISOString(),
          callerThreadId: context.callerThreadId,
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
    ),
  };

  const createTask: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_create_kanban_task",
      description:
        "Create a Kanban task from a title and optional description/prompt: starts a new Synara thread and immediately starts a turn, so the card renders In Progress while the turn is live. Reuse the returned threadId with synara_read_thread or synara_move_kanban_card. Retries of the same requestId replay exactly-once, so keep requestId stable across retries.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Task title." },
          description: {
            type: "string",
            description: "Optional task description; used as the first-turn prompt.",
          },
          projectId: { type: "string", description: "Project to attach the task to." },
          model: { type: "string", description: "Model slug override (defaults to caller)." },
          requestId: { type: "string", maxLength: 256, description: "Idempotency key." },
        },
        required: ["title"],
        additionalProperties: false,
      },
      annotations: {
        title: "Create a Kanban task",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    handler: withKanbanWriteConcurrencyGuard(
      withKanbanToolAudit("synara_create_kanban_task", (args, context) =>
        Effect.suspend(() =>
          Effect.gen(function* () {
            const caller = context.callerThreadId;
            const title = readStringArg(args, "title", { required: true })!;
            const description = readStringArg(args, "description");
            const projectId = readStringArg(args, "projectId");
            const model = readStringArg(args, "model");
            const requestId =
              readStringArg(args, "requestId") ?? `kanban-task:${caller}:${isoNow()}`;
            // Default the provider/model to the caller's own so an agent never
            // spawns a task on a provider it cannot reason about.
            const spec: Record<string, unknown> = {
              title,
              prompt: description ?? title,
              target: buildModelSelection(context.callerProvider, model),
              ...(projectId ? { projectId } : {}),
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
            const batch = JSON.parse(content?.type === "text" ? content.text : "{}") as {
              operationId?: string;
              threadIds?: string[];
              threads?: Array<{ threadId?: string }>;
            };
            // The creation saga returns `threadIds` / per-thread `threads`, never a
            // top-level `threadId`; read the first created thread so the create →
            // read → move loop works against the real contract shape.
            const createdThreadId = batch.threads?.[0]?.threadId ?? batch.threadIds?.[0];
            if (!createdThreadId) return result;
            const thread = yield* requireThreadShell(createdThreadId).pipe(
              Effect.mapError((error) => new ToolInputError(errorText(error))),
            );
            const cardView = deriveCard(thread, now());
            return mcpToolResultJson({
              operationId: batch.operationId,
              threadId: thread.id,
              title: thread.title,
              status: "task_dispatched",
              card: {
                threadId: thread.id,
                title: thread.title,
                column: cardView.column,
                attention: cardView.attention,
              },
            });
          }),
        ).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
      ),
    ),
  };

  const moveCard: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_move_kanban_card",
      description:
        'Move a Kanban card between the actionable columns. target "inProgress" starts (or resumes) work on the thread, optionally with a message; target "done" requests that a running turn settle (falls back to interrupting it). Awaiting you is human-attention state and cannot be targeted; a card there reports alreadyInProgress with awaitingYou: true.',
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Thread id of the card to move." },
          target: { type: "string", enum: ["inProgress", "done"] },
          message: {
            type: "string",
            description:
              "Prompt/message for the started turn. Required when restarting a settled thread (a card outside In Progress with a completed turn).",
          },
          requestId: { type: "string", maxLength: 256, description: "Idempotency key." },
        },
        required: ["threadId", "target"],
        additionalProperties: false,
      },
      annotations: {
        title: "Move a Kanban card",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: withKanbanWriteConcurrencyGuard(
      withKanbanToolAudit("synara_move_kanban_card", (args, context) =>
        Effect.suspend(() =>
          Effect.gen(function* () {
            const threadId = readStringArg(args, "threadId", { required: true })!;
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
            yield* assertCallerMayDriveThread(caller, card);
            if ((card.archivedAt ?? null) !== null) {
              return yield* Effect.fail(
                new ToolInputError(`Thread "${threadId}" is archived and has no board card.`),
              );
            }
            const at = now();
            const cardView = deriveCard(card, at);
            const currentColumn = cardView.column;
            if (target === "inProgress") {
              if (currentColumn === "inProgress" || currentColumn === "awaitingYou") {
                // Already working (or human-attention-blocked): no new dispatch.
                // Return the current attention flags so a caller that targeted an
                // awaiting-you card can see the human-attention reason it stayed put.
                return mcpToolResultJson({
                  threadId,
                  target,
                  alreadyInProgress: true,
                  awaitingYou: currentColumn === "awaitingYou",
                  card: {
                    threadId,
                    column: currentColumn,
                    attention: cardView.attention,
                  },
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
                card: {
                  threadId,
                  column: "inProgress",
                  attention: cardView.attention,
                },
              });
            }
            // target === "done"
            if (currentColumn !== "inProgress" && currentColumn !== "awaitingYou") {
              return mcpToolResultJson({
                threadId,
                target,
                alreadyDone: true,
                card: { threadId, column: currentColumn, attention: cardView.attention },
              });
            }
            const hadLiveTurn =
              card.session?.activeTurnId !== null || card.latestTurn?.state === "running";
            if (!hadLiveTurn) {
              return mcpToolResultJson({
                threadId,
                target,
                alreadyDone: true,
                card: { threadId, column: currentColumn, attention: cardView.attention },
              });
            }
            const dispatched = yield* interruptTurn({ threadId }).pipe(
              Effect.mapError((error) => new ToolInputError(errorText(error))),
            );
            return mcpToolResultJson({
              threadId,
              target,
              interruptRequested: true,
              eventSequence: dispatched.sequence,
              card: {
                threadId,
                column: currentColumn,
                attention: cardView.attention,
              },
            });
          }),
        ).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
      ),
    ),
  };

  return [readBoard, readCard, createTask, moveCard];
}

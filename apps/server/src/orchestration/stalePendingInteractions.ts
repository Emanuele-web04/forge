/**
 * stalePendingInteractions - one settlement shape for human requests whose
 * provider callback is provably gone.
 *
 * Approvals and structured user-input requests are answered through an
 * in-memory provider callback. That callback dies with its runtime (turn end,
 * session exit, process exit), while the durable
 * `projection_pending_interactions` row survives. An unsettled row with no
 * live callback is a question the UI keeps showing and no answer can ever
 * reach, so every code path that learns a callback is gone reports the row the
 * same way: a `provider.*.respond.failed` activity carrying the canonical stale
 * detail. The projection recognises that detail and moves the row to
 * `uncertain`, which drops the pending counts and clears the question card.
 *
 * Callers: {@link module:startupTurnReconciliation} (process boundary) and the
 * runtime-event settlement in `Layers/ProviderRuntimeIngestion.ts`
 * (turn/session boundary).
 *
 * @module stalePendingInteractions
 */
import type { CommandId, OrchestrationCommand, ThreadId } from "@synara/contracts";
import { EventId } from "@synara/contracts";
import {
  buildStalePendingRequestFailureDetail,
  type PendingThreadRequestKind,
} from "@synara/shared/threadSummary";

import type { ProjectionPendingInteraction } from "../persistence/Services/ProjectionPendingInteractions.ts";

export type ThreadActivityAppendCommand = Extract<
  OrchestrationCommand,
  { readonly type: "thread.activity.append" }
>;

/**
 * True when a durable interaction row still expects an answer.
 *
 * `confirmed` rows were answered. `uncertain` rows were already reported as
 * unanswerable, so re-reporting them would append a duplicate failure activity
 * on every settlement signal. Everything else (`pending`, `retryable`, and a
 * `responding` claim whose response never landed) is still holding a question
 * open.
 */
export function isUnsettledPendingInteraction(
  row: Pick<ProjectionPendingInteraction, "status">,
): boolean {
  return row.status !== "confirmed" && row.status !== "uncertain";
}

export function pendingInteractionRequestKind(
  interactionKind: ProjectionPendingInteraction["interactionKind"],
): PendingThreadRequestKind {
  return interactionKind === "approval" ? "approval" : "user-input";
}

/**
 * Builds the activity command that settles one unanswerable request.
 *
 * `lifecycleGeneration` is optional and scopes the settlement to a single
 * runtime generation of the request. Omit it when nothing about the thread is
 * answerable any more (process restart): a generation-less settlement closes
 * every open instance of the request id in the timeline summary, whereas a
 * mismatched generation would leave the question card up.
 */
export function buildStalePendingRequestSettlementCommand(input: {
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly requestKind: PendingThreadRequestKind;
  readonly requestId: string;
  readonly lifecycleGeneration?: string | null;
  readonly now: string;
}): ThreadActivityAppendCommand {
  const isApproval = input.requestKind === "approval";
  return {
    type: "thread.activity.append",
    commandId: input.commandId,
    threadId: input.threadId,
    activity: {
      id: EventId.makeUnsafe(input.commandId),
      tone: "error",
      kind: isApproval ? "provider.approval.respond.failed" : "provider.user-input.respond.failed",
      summary: isApproval
        ? "Provider approval response failed"
        : "Provider user input response failed",
      payload: {
        detail: buildStalePendingRequestFailureDetail(input.requestKind, input.requestId),
        requestId: input.requestId,
        ...(input.lifecycleGeneration ? { lifecycleGeneration: input.lifecycleGeneration } : {}),
      },
      turnId: null,
      createdAt: input.now,
    },
    createdAt: input.now,
  };
}

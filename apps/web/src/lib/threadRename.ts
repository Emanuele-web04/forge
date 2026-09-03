// Purpose: Share the thread-title rename flow between header and sidebar surfaces,
// including draft-thread promotion when a title is edited before the first send.
// The promotion path mirrors the first-send flow, but routes through the shared
// idempotent helper so concurrent draft promotion callers do not surface duplicate
// `thread.create` invariant failures as user-visible toasts.

import {
  type ModelSelection,
  type OrchestrationThreadPullRequest,
  type OrchestrationRegenerateThreadTitleResult,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@synara/contracts";
import { type DraftThreadEnvMode } from "../composerDraftStore";
import { readNativeApi } from "../nativeApi";
import type { Thread } from "../types";
import { promoteThreadCreate } from "./threadCreatePromotion";
import { newCommandId } from "./utils";

type ThreadRenameOutcome = "empty" | "unchanged" | "unavailable" | "renamed";
export type ThreadTitleRegenerationOutcome =
  | OrchestrationRegenerateThreadTitleResult
  | { readonly status: "unavailable"; readonly title: null };

type DraftThreadRenameSource = Pick<
  Thread,
  | "projectId"
  | "modelSelection"
  | "runtimeMode"
  | "interactionMode"
  | "envMode"
  | "branch"
  | "worktreePath"
  | "workingDirectory"
  | "lastKnownPr"
  | "createdAt"
>;

export function buildDraftThreadRenameCreateInput(thread: DraftThreadRenameSource) {
  return {
    projectId: thread.projectId,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    envMode: thread.envMode ?? "local",
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    workingDirectory: thread.workingDirectory ?? null,
    ...(thread.lastKnownPr !== undefined ? { lastKnownPr: thread.lastKnownPr } : {}),
    createdAt: thread.createdAt,
  } satisfies {
    projectId: ProjectId;
    modelSelection: ModelSelection;
    runtimeMode: RuntimeMode;
    interactionMode: ProviderInteractionMode;
    envMode: DraftThreadEnvMode;
    branch: string | null;
    worktreePath: string | null;
    workingDirectory: string | null;
    lastKnownPr?: OrchestrationThreadPullRequest | null;
    createdAt: string;
  };
}

export async function dispatchThreadTitleRegeneration(
  threadId: ThreadId,
): Promise<ThreadTitleRegenerationOutcome> {
  const api = readNativeApi();
  if (!api) {
    return { status: "unavailable", title: null };
  }
  return api.orchestration.regenerateThreadTitle({ threadId });
}

export async function dispatchThreadRename(input: {
  threadId: ThreadId;
  newTitle: string;
  unchangedTitles: readonly string[];
  createIfMissing?:
    | {
        projectId: ProjectId;
        modelSelection: ModelSelection;
        runtimeMode: RuntimeMode;
        interactionMode: ProviderInteractionMode;
        envMode: DraftThreadEnvMode;
        branch: string | null;
        worktreePath: string | null;
        workingDirectory: string | null;
        lastKnownPr?: OrchestrationThreadPullRequest | null;
        createdAt: string;
      }
    | undefined;
}): Promise<ThreadRenameOutcome> {
  const trimmed = input.newTitle.trim();
  if (trimmed.length === 0) {
    return "empty";
  }
  if (input.unchangedTitles.includes(trimmed)) {
    return "unchanged";
  }

  const api = readNativeApi();
  if (!api) {
    return "unavailable";
  }

  if (input.createIfMissing) {
    const promotionResult = await promoteThreadCreate(
      {
        type: "thread.create",
        commandId: newCommandId(),
        threadId: input.threadId,
        projectId: input.createIfMissing.projectId,
        title: trimmed,
        modelSelection: input.createIfMissing.modelSelection,
        runtimeMode: input.createIfMissing.runtimeMode,
        interactionMode: input.createIfMissing.interactionMode,
        envMode: input.createIfMissing.envMode,
        branch: input.createIfMissing.branch,
        worktreePath: input.createIfMissing.worktreePath,
        workingDirectory: input.createIfMissing.workingDirectory,
        ...(input.createIfMissing.lastKnownPr !== undefined
          ? { lastKnownPr: input.createIfMissing.lastKnownPr }
          : {}),
        createdAt: input.createIfMissing.createdAt,
      },
      api,
    );
    if (promotionResult === "exists") {
      await api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId: input.threadId,
        title: trimmed,
      });
    }
  } else {
    await api.orchestration.dispatchCommand({
      type: "thread.meta.update",
      commandId: newCommandId(),
      threadId: input.threadId,
      title: trimmed,
    });
  }

  return "renamed";
}

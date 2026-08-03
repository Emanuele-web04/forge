import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  resolveWorktreeHandoffIntent,
  resolveWorktreeHandoffWorkspaceMetadata,
} from "@synara/shared/worktreeHandoff";
import { useCallback, useState } from "react";
import { gitHandoffThreadMutationOptions } from "~/lib/gitReactQuery";
import { buildSuggestedWorktreeName } from "../components/ChatView.logic";
import { toastManager } from "../components/ui/toast";
import { newCommandId } from "../lib/utils";
import {
  setupProjectScript,
  type ProjectScriptRunOptions,
  type ProjectScriptRunResult,
} from "../projectScripts";
import { useStore } from "../store";
import type { Project, ProjectScript, Thread } from "../types";

/** Success toast for one handoff. Module scope: its ternaries live outside the caller's `try`. */
function reportThreadHandoffSuccess(
  targetMode: "local" | "worktree",
  result: { conflictsDetected: boolean; message?: string | null },
): void {
  toastManager.add({
    type: result.conflictsDetected ? "warning" : "success",
    title:
      targetMode === "worktree" ? "Thread handed off to worktree" : "Thread handed off to local",
    ...(result.message ? { description: result.message } : {}),
  });
}

export function useThreadWorkspaceHandoff(input: {
  activeProject: Project | undefined;
  activeThread: Thread | undefined;
  activeRootBranch: string | null;
  activeThreadAssociatedWorktree: {
    associatedWorktreePath: string | null;
    associatedWorktreeBranch: string | null;
    associatedWorktreeRef: string | null;
  };
  isServerThread: boolean;
  stopActiveThreadSession: () => Promise<void>;
  runProjectScript: (
    script: ProjectScript,
    options?: ProjectScriptRunOptions,
  ) => Promise<ProjectScriptRunResult | null>;
}) {
  const queryClient = useQueryClient();
  const setThreadWorkspace = useStore((store) => store.setThreadWorkspace);
  const handoffThreadMutation = useMutation(
    gitHandoffThreadMutationOptions({ cwd: input.activeProject?.cwd ?? null, queryClient }),
  );
  const [worktreeHandoffDialogOpen, setWorktreeHandoffDialogOpen] = useState(false);
  const [worktreeHandoffName, setWorktreeHandoffName] = useState("");

  const handoffThread = useCallback(
    async (targetMode: "local" | "worktree", options?: { preferredWorktreeName?: string }) => {
      if (
        !input.activeProject ||
        !input.activeThread ||
        !input.isServerThread ||
        handoffThreadMutation.isPending
      ) {
        return false;
      }

      // The whole payload is resolved before the `try`: React Compiler cannot lower `??` inside a
      // try block, and this hook backs the local/worktree switch on every thread.
      const handoffPayload = {
        commandId: newCommandId(),
        threadId: input.activeThread.id,
        targetMode,
        currentBranch: input.activeThread.branch ?? null,
        worktreePath: input.activeThread.worktreePath ?? null,
        associatedWorktreePath: input.activeThreadAssociatedWorktree.associatedWorktreePath,
        associatedWorktreeBranch: input.activeThreadAssociatedWorktree.associatedWorktreeBranch,
        associatedWorktreeRef: input.activeThreadAssociatedWorktree.associatedWorktreeRef,
        preferredLocalBranch: input.activeRootBranch ?? input.activeThread.branch ?? null,
        preferredWorktreeBaseBranch:
          input.activeRootBranch ??
          input.activeThreadAssociatedWorktree.associatedWorktreeBranch ??
          input.activeThread.branch ??
          null,
        preferredNewWorktreeName: options?.preferredWorktreeName ?? null,
      };

      try {
        await input.stopActiveThreadSession();
        const result = await handoffThreadMutation.mutateAsync(handoffPayload);
        // The RPC returns only after the Git result and metadata command are
        // durable. Apply that result locally as well so cwd-bound surfaces
        // (file preview, explorer, terminal) do not wait for the asynchronous
        // domain-event round trip and briefly keep targeting the old checkout.
        setThreadWorkspace(input.activeThread.id, resolveWorktreeHandoffWorkspaceMetadata(result));

        // Nested `if`s rather than `&&`, and the toast assembled outside: every value block —
        // `&&`, `??`, a ternary, a conditional spread — is one React Compiler refuses to lower
        // inside a `try`, and one is enough to drop the whole hook's memoization.
        if (targetMode === "worktree") {
          const worktreePath = result.worktreePath;
          if (worktreePath) {
            const setupScript = setupProjectScript(input.activeProject.scripts);
            if (setupScript) {
              await input.runProjectScript(setupScript, {
                cwd: worktreePath,
                worktreePath,
                rememberAsLastInvoked: false,
              });
            }
          }
        }

        reportThreadHandoffSuccess(targetMode, result);
        return true;
      } catch (error) {
        toastManager.add({
          type: "error",
          title:
            targetMode === "worktree"
              ? "Could not hand off to worktree"
              : "Could not hand off to local",
          description:
            error instanceof Error ? error.message : "An error occurred during the handoff.",
        });
        return false;
      }
    },
    [handoffThreadMutation, input, setThreadWorkspace],
  );

  const onHandoffToWorktree = useCallback(() => {
    if (!input.activeThread) {
      return;
    }

    const worktreeIntent = resolveWorktreeHandoffIntent({
      associatedWorktreePath: input.activeThreadAssociatedWorktree.associatedWorktreePath,
      associatedWorktreeBranch: input.activeThreadAssociatedWorktree.associatedWorktreeBranch,
      associatedWorktreeRef: input.activeThreadAssociatedWorktree.associatedWorktreeRef,
      preferredWorktreeBaseBranch: input.activeRootBranch,
      currentBranch: input.activeThread.branch ?? null,
    });
    if (worktreeIntent?.kind === "reuse-associated") {
      void handoffThread("worktree");
      return;
    }

    setWorktreeHandoffName(
      buildSuggestedWorktreeName({
        associatedWorktreeBranch:
          input.activeThreadAssociatedWorktree.associatedWorktreeBranch ??
          input.activeThread.branch ??
          null,
        title: input.activeThread.title,
      }),
    );
    setWorktreeHandoffDialogOpen(true);
  }, [handoffThread, input]);

  const confirmWorktreeHandoff = useCallback(async () => {
    const normalizedWorktreeName = buildSuggestedWorktreeName({
      associatedWorktreeBranch: worktreeHandoffName,
    });
    setWorktreeHandoffName(normalizedWorktreeName);
    const succeeded = await handoffThread("worktree", {
      preferredWorktreeName: normalizedWorktreeName,
    });
    if (succeeded) {
      setWorktreeHandoffDialogOpen(false);
    }
  }, [handoffThread, worktreeHandoffName]);

  const onHandoffToLocal = useCallback(async () => {
    await handoffThread("local");
  }, [handoffThread]);

  return {
    handoffBusy: handoffThreadMutation.isPending,
    worktreeHandoffDialogOpen,
    setWorktreeHandoffDialogOpen,
    worktreeHandoffName,
    setWorktreeHandoffName,
    onHandoffToWorktree,
    onHandoffToLocal,
    confirmWorktreeHandoff,
  };
}

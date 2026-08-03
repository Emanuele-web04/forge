// FILE: useSidebarThreadActions.ts
// Purpose: Owns Sidebar thread pinning, archive/undo, deletion, and project-batch actions.
// Layer: Web Sidebar controller hook
// Exports: useSidebarThreadActions

import { type ProjectId, ThreadId } from "@synara/contracts";
import { pluralize } from "@synara/shared/text";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AppSettings } from "../appSettings";
import { useComposerDraftStore } from "../composerDraftStore";
import { showConfirmDialogFallback } from "../confirmDialogFallback";
import {
  getFallbackThreadIdAfterDelete,
  derivePinnedThreadIdsForSidebar,
  isLatestPinnedThreadMutation,
} from "../components/Sidebar.logic";
import { toastManager } from "../components/ui/toast";
import { deleteActiveThreadFromClient } from "../lib/activeThreadDelete";
import { reconcileDeletedThreadsFromClient } from "../lib/deletedThreadClientReconciliation";
import { gitRemoveWorktreeMutationOptions } from "../lib/gitReactQuery";
import {
  archiveThreadFromClient,
  isThreadAlreadyUnarchivedError,
  unarchiveThreadFromClient,
} from "../lib/threadArchive";
import {
  createOptimisticSettledMutation,
  recordOptimisticSettledMutationSequence,
  reconcileOptimisticSettledMutation,
  setThreadSettledFromClient,
  type OptimisticSettledMutation,
} from "../lib/threadSettle";
import { newCommandId, randomUUID } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { usePinnedThreadsStore } from "../pinnedThreadsStore";
import { reconcileOptimisticPinState } from "../pinning.logic";
import {
  resolveSplitViewFocusedThreadId,
  resolveSplitViewPaneIdForThread,
  type SplitView,
  useSplitViewStore,
} from "../splitViewStore";
import { useStore } from "../store";
import { useTemporaryThreadStore } from "../temporaryThreadStore";
import { getThreadFromState } from "../threadDerivation";
import { useThreadSelectionStore } from "../threadSelectionStore";
import type { Project, SidebarThreadSummary } from "../types";

const ARCHIVE_UNDO_TOAST_DURATION_MS = 8000;
/**
 * How long a confirmed settle override may outlive its projection push. Well
 * past normal push latency: the expiry is a last resort against a lost or
 * reordered push, not part of the happy path, where reconciliation clears the
 * override as soon as the projection agrees.
 */
const SETTLE_OVERRIDE_MAX_LIFETIME_MS = 15_000;

/**
 * Unarchives a thread, treating "it was already unarchived" as success.
 *
 * The undo toast can fire after the thread came back some other way (a second client, a replayed
 * command), and that race is not an error worth showing. Kept at module scope because React Compiler
 * cannot lower a `throw` inside a `try`/`catch`, and inlining this would cost the whole sidebar
 * actions hook its compilation.
 */
async function unarchiveThreadIgnoringAlreadyRestored(threadId: ThreadId): Promise<void> {
  try {
    const api = readNativeApi();
    if (!api) throw new Error("Unable to connect to the app server.");
    await unarchiveThreadFromClient(api.orchestration, threadId);
  } catch (error) {
    if (!isThreadAlreadyUnarchivedError(error, threadId)) throw error;
  }
}

interface DeleteProjectThreadsOptions {
  readonly confirmMessage?: string | null;
  readonly showEmptyToast?: boolean;
  readonly showResultToast?: boolean;
  readonly worktreeCleanupMode?: "prompt" | "skip";
}

export function useSidebarThreadActions(input: {
  readonly activeSplitView: SplitView | null | undefined;
  readonly appSettings: Pick<
    AppSettings,
    "confirmThreadArchive" | "confirmThreadDelete" | "sidebarThreadSortOrder"
  >;
  readonly clearTerminalState: (threadId: ThreadId) => void;
  readonly handleNewChat: (options?: { fresh?: boolean }) => Promise<unknown>;
  readonly projectById: ReadonlyMap<ProjectId, Project>;
  readonly routeSplitViewId: string | null;
  readonly routeThreadId: ThreadId | null;
  readonly sidebarThreads: readonly SidebarThreadSummary[];
  readonly sidebarTreeThreads: readonly SidebarThreadSummary[];
  readonly sidebarThreadSummaryById: Readonly<Record<string, SidebarThreadSummary>>;
  readonly threadsHydrated: boolean;
}) {
  const {
    activeSplitView,
    appSettings,
    clearTerminalState,
    handleNewChat,
    projectById,
    routeSplitViewId,
    routeThreadId,
    sidebarThreads,
    sidebarTreeThreads,
    sidebarThreadSummaryById,
    threadsHydrated,
  } = input;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const removeWorktreeMutation = useMutation(gitRemoveWorktreeMutationOptions({ queryClient }));
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearDraftThread);
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const persistedPinnedThreadIds = usePinnedThreadsStore((store) => store.pinnedThreadIds);
  const pinThreadLocally = usePinnedThreadsStore((store) => store.pinThread);
  const unpinThread = usePinnedThreadsStore((store) => store.unpinThread);
  const prunePinnedThreads = usePinnedThreadsStore((store) => store.prunePinnedThreads);
  const removeThreadFromSplitViews = useSplitViewStore((store) => store.removeThreadFromSplitViews);
  const clearTemporaryThread = useTemporaryThreadStore((store) => store.clearTemporaryThread);
  const removeFromSelection = useThreadSelectionStore((store) => store.removeFromSelection);

  const archivePendingThreadIdsRef = useRef<Set<ThreadId>>(new Set());
  const archiveUndoPendingThreadIdsRef = useRef<Set<ThreadId>>(new Set());
  const legacyPinMigrationThreadIdsRef = useRef(new Set<ThreadId>());
  const optimisticPinnedStateByThreadIdRef = useRef(new Map<ThreadId, boolean>());
  const latestPinnedMutationVersionByThreadIdRef = useRef(new Map<ThreadId, number>());
  const latestSettledMutationVersionByThreadIdRef = useRef(new Map<ThreadId, number>());
  const settleOverrideExpiryTimeoutsRef = useRef(new Map<ThreadId, number>());
  const sidebarThreadSummaryByIdRef = useRef(sidebarThreadSummaryById);
  const [optimisticPinnedStateByThreadId, setOptimisticPinnedStateByThreadId] = useState<
    ReadonlyMap<ThreadId, boolean>
  >(() => new Map());

  useEffect(() => {
    sidebarThreadSummaryByIdRef.current = sidebarThreadSummaryById;
  }, [sidebarThreadSummaryById]);

  const pinnedThreadIds = useMemo(
    () =>
      derivePinnedThreadIdsForSidebar({
        threads: sidebarTreeThreads,
        persistedPinnedThreadIds,
        optimisticPinnedStateByThreadId,
      }),
    [optimisticPinnedStateByThreadId, persistedPinnedThreadIds, sidebarTreeThreads],
  );
  const pinnedThreadIdSet = useMemo(() => new Set(pinnedThreadIds), [pinnedThreadIds]);

  const setOptimisticThreadPinned = useCallback((threadId: ThreadId, isPinned: boolean) => {
    optimisticPinnedStateByThreadIdRef.current.set(threadId, isPinned);
    setOptimisticPinnedStateByThreadId((current) => {
      if (current.get(threadId) === isPinned) return current;
      const next = new Map(current);
      next.set(threadId, isPinned);
      return next;
    });
  }, []);
  const clearOptimisticThreadPinned = useCallback((threadId: ThreadId) => {
    optimisticPinnedStateByThreadIdRef.current.delete(threadId);
    setOptimisticPinnedStateByThreadId((current) => {
      if (!current.has(threadId)) return current;
      const next = new Map(current);
      next.delete(threadId);
      return next;
    });
  }, []);
  const dispatchThreadPinnedState = useCallback(async (threadId: ThreadId, isPinned: boolean) => {
    const api = readNativeApi();
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "thread.meta.update",
      commandId: newCommandId(),
      threadId,
      isPinned,
    });
  }, []);
  const setThreadPinned = useCallback(
    async (threadId: ThreadId, isPinned: boolean) => {
      const api = readNativeApi();
      if (!api) return;
      const requestVersion =
        (latestPinnedMutationVersionByThreadIdRef.current.get(threadId) ?? 0) + 1;
      latestPinnedMutationVersionByThreadIdRef.current.set(threadId, requestVersion);

      setOptimisticThreadPinned(threadId, isPinned);
      if (isPinned) {
        pinThreadLocally(threadId);
      } else {
        unpinThread(threadId);
      }

      try {
        await dispatchThreadPinnedState(threadId, isPinned);
      } catch (error) {
        if (
          !isLatestPinnedThreadMutation({
            threadId,
            requestVersion,
            latestMutationVersionByThreadId: latestPinnedMutationVersionByThreadIdRef.current,
          })
        ) {
          return;
        }
        const confirmedPinned = sidebarThreadSummaryByIdRef.current[threadId]?.isPinned === true;
        if (confirmedPinned) {
          pinThreadLocally(threadId);
        } else {
          unpinThread(threadId);
        }
        clearOptimisticThreadPinned(threadId);
        throw error;
      }
    },
    [
      clearOptimisticThreadPinned,
      dispatchThreadPinnedState,
      pinThreadLocally,
      setOptimisticThreadPinned,
      unpinThread,
    ],
  );
  const toggleThreadPinned = useCallback(
    (threadId: ThreadId) => {
      const isPinned = pinnedThreadIdSet.has(threadId);
      void setThreadPinned(threadId, !isPinned).catch((error) => {
        console.error("Failed to update pinned thread state", { threadId, error });
        toastManager.add({
          type: "error",
          title: isPinned ? "Unable to unpin thread" : "Unable to pin thread",
        });
      });
    },
    [pinnedThreadIdSet, setThreadPinned],
  );

  const [optimisticSettledMutationByThreadId, setOptimisticSettledMutationByThreadId] = useState<
    ReadonlyMap<ThreadId, OptimisticSettledMutation>
  >(() => new Map());

  const clearOptimisticThreadSettled = useCallback((threadId: ThreadId) => {
    setOptimisticSettledMutationByThreadId((current) => {
      if (!current.has(threadId)) return current;
      const next = new Map(current);
      next.delete(threadId);
      return next;
    });
  }, []);

  const setThreadSettled = useCallback(
    async (threadId: ThreadId, isSettled: boolean) => {
      const api = readNativeApi();
      if (!api) throw new Error("Unable to connect to the app server.");
      const requestVersion =
        (latestSettledMutationVersionByThreadIdRef.current.get(threadId) ?? 0) + 1;
      latestSettledMutationVersionByThreadIdRef.current.set(threadId, requestVersion);
      const isLatestRequest = () =>
        latestSettledMutationVersionByThreadIdRef.current.get(threadId) === requestVersion;

      const previousExpiry = settleOverrideExpiryTimeoutsRef.current.get(threadId);
      if (previousExpiry !== undefined) {
        window.clearTimeout(previousExpiry);
        settleOverrideExpiryTimeoutsRef.current.delete(threadId);
      }
      const serverSettledAtDispatch =
        (sidebarThreadSummaryByIdRef.current[threadId]?.settledAt ?? null) !== null;
      setOptimisticSettledMutationByThreadId((current) => {
        const next = new Map(current);
        next.set(
          threadId,
          createOptimisticSettledMutation({
            desiredSettled: isSettled,
            serverSettledAtDispatch,
          }),
        );
        return next;
      });
      try {
        const commandSequence = await setThreadSettledFromClient(
          api.orchestration,
          threadId,
          isSettled,
        );
        if (isLatestRequest()) {
          setOptimisticSettledMutationByThreadId((current) => {
            const mutation = current.get(threadId);
            if (!mutation) return current;
            const next = new Map(current);
            next.set(threadId, recordOptimisticSettledMutationSequence(mutation, commandSequence));
            return next;
          });
        }
      } catch (error) {
        // A newer toggle owns the override now; dropping it here would revert to
        // a state the user has already moved on from.
        if (isLatestRequest()) clearOptimisticThreadSettled(threadId);
        throw error;
      }
      // The command is durable, so the override only bridges the gap until the
      // projection push lands. Expiring it keeps a lost or reordered push from
      // pinning the row to a stale state forever.
      if (!isLatestRequest()) return;
      const expiry = window.setTimeout(() => {
        settleOverrideExpiryTimeoutsRef.current.delete(threadId);
        if (isLatestRequest()) clearOptimisticThreadSettled(threadId);
      }, SETTLE_OVERRIDE_MAX_LIFETIME_MS);
      settleOverrideExpiryTimeoutsRef.current.set(threadId, expiry);
    },
    [clearOptimisticThreadSettled],
  );

  const setThreadSettledWithToast = useCallback(
    (threadId: ThreadId, isSettled: boolean) => {
      void setThreadSettled(threadId, isSettled).catch((error) => {
        console.error("Failed to update settled thread state", { threadId, error });
        toastManager.add({
          type: "error",
          title: isSettled ? "Unable to mark thread as done" : "Unable to undo done",
        });
      });
    },
    [setThreadSettled],
  );

  // Drop optimistic settle entries once the server-confirmed state agrees, so
  // later pushes from other clients are no longer masked by a stale override.
  useEffect(() => {
    if (optimisticSettledMutationByThreadId.size === 0) return;
    let settle: number | undefined;
    const scheduleReconciliation = () => {
      if (settle !== undefined) window.clearTimeout(settle);
      settle = window.setTimeout(() => {
        settle = undefined;
        const projectionSequence = useStore.getState().shellSnapshotSequence ?? 0;
        setOptimisticSettledMutationByThreadId((current) => {
          let next: Map<ThreadId, OptimisticSettledMutation> | null = null;
          for (const [threadId, mutation] of current) {
            const serverThread = sidebarThreadSummaryByIdRef.current[threadId];
            if (!serverThread) {
              if (next === null) next = new Map(current);
              next.delete(threadId);
              continue;
            }
            const reconciliation = reconcileOptimisticSettledMutation(
              mutation,
              (serverThread.settledAt ?? null) !== null,
              projectionSequence,
            );
            if (reconciliation.acknowledged) {
              if (next === null) next = new Map(current);
              next.delete(threadId);
              const expiry = settleOverrideExpiryTimeoutsRef.current.get(threadId);
              if (expiry !== undefined) window.clearTimeout(expiry);
              settleOverrideExpiryTimeoutsRef.current.delete(threadId);
            } else if (reconciliation.mutation !== mutation) {
              if (next === null) next = new Map(current);
              next.set(threadId, reconciliation.mutation);
            }
          }
          return next ?? current;
        });
      }, 0);
    };
    scheduleReconciliation();
    const unsubscribe = useStore.subscribe((state, previousState) => {
      if (state.shellSnapshotSequence !== previousState.shellSnapshotSequence) {
        scheduleReconciliation();
      }
    });
    return () => {
      unsubscribe();
      if (settle !== undefined) window.clearTimeout(settle);
    };
  }, [sidebarThreads, optimisticSettledMutationByThreadId]);

  const optimisticSettledStateByThreadId = useMemo(
    () =>
      new Map(
        Array.from(
          optimisticSettledMutationByThreadId,
          ([threadId, mutation]) => [threadId, mutation.desiredSettled] as const,
        ),
      ),
    [optimisticSettledMutationByThreadId],
  );

  useEffect(() => {
    const expiryTimeouts = settleOverrideExpiryTimeoutsRef.current;
    return () => {
      for (const timeout of expiryTimeouts.values()) window.clearTimeout(timeout);
      expiryTimeouts.clear();
    };
  }, []);

  useEffect(() => {
    if (optimisticPinnedStateByThreadId.size === 0) return;
    const serverPinnedStateByThreadId = new Map(
      sidebarThreads.map((thread) => [thread.id, thread.isPinned === true] as const),
    );
    const settle = window.setTimeout(() => {
      setOptimisticPinnedStateByThreadId((current) => {
        const reconciled = reconcileOptimisticPinState({
          optimisticPinnedStateById: current,
          serverPinnedStateById: serverPinnedStateByThreadId,
        });
        for (const threadId of reconciled.settledIds) {
          optimisticPinnedStateByThreadIdRef.current.delete(threadId);
        }
        return reconciled.optimisticPinnedStateById;
      });
    }, 0);
    return () => window.clearTimeout(settle);
  }, [sidebarThreads, optimisticPinnedStateByThreadId]);

  useEffect(() => {
    if (!threadsHydrated) return;
    prunePinnedThreads(sidebarThreads.map((thread) => thread.id));
  }, [sidebarThreads, threadsHydrated, prunePinnedThreads]);

  useEffect(() => {
    if (!threadsHydrated || persistedPinnedThreadIds.length === 0) return;
    const threadsById = new Map(sidebarThreads.map((thread) => [thread.id, thread] as const));
    for (const threadId of persistedPinnedThreadIds) {
      const thread = threadsById.get(threadId);
      if (
        !thread ||
        thread.isPinned === true ||
        optimisticPinnedStateByThreadIdRef.current.has(threadId) ||
        legacyPinMigrationThreadIdsRef.current.has(threadId)
      ) {
        continue;
      }
      legacyPinMigrationThreadIdsRef.current.add(threadId);
      void dispatchThreadPinnedState(threadId, true)
        .catch((error) => {
          console.error("Failed to migrate pinned thread state", { threadId, error });
        })
        .finally(() => {
          legacyPinMigrationThreadIdsRef.current.delete(threadId);
        });
    }
  }, [dispatchThreadPinnedState, sidebarThreads, threadsHydrated, persistedPinnedThreadIds]);

  const deleteThread = useCallback(
    async (
      threadId: ThreadId,
      opts: {
        deletedThreadIds?: ReadonlySet<ThreadId>;
        reconcileDeletedThread?: boolean;
        worktreeCleanupMode?: "prompt" | "skip";
      } = {},
    ): Promise<void> => {
      await deleteActiveThreadFromClient({
        threadId,
        ...(opts.deletedThreadIds !== undefined ? { deletedThreadIds: opts.deletedThreadIds } : {}),
        ...(opts.reconcileDeletedThread !== undefined
          ? { reconcileDeletedThread: opts.reconcileDeletedThread }
          : {}),
        ...(opts.worktreeCleanupMode !== undefined
          ? { worktreeCleanupMode: opts.worktreeCleanupMode }
          : {}),
        prepareForDelete: () => ({
          shouldNavigateToFallback: routeThreadId === threadId,
          fallbackThreadId: getFallbackThreadIdAfterDelete({
            threads: sidebarThreads,
            deletedThreadId: threadId,
            deletedThreadIds: opts.deletedThreadIds ?? new Set<ThreadId>(),
            sortOrder: appSettings.sidebarThreadSortOrder,
          }),
          deletedPaneInActiveSplit: activeSplitView
            ? resolveSplitViewPaneIdForThread(activeSplitView, threadId)
            : null,
        }),
        onDeleted: ({ thread, prepared }) => {
          unpinThread(threadId);
          clearComposerDraftForThread(threadId);
          clearProjectDraftThreadById(thread.projectId, thread.id);
          clearTerminalState(threadId);
          removeThreadFromSplitViews(threadId);
          clearTemporaryThread(threadId);

          if (routeSplitViewId && prepared?.deletedPaneInActiveSplit) {
            const nextActiveSplitView =
              useSplitViewStore.getState().splitViewsById[routeSplitViewId] ?? null;
            const nextFocusedThreadId = nextActiveSplitView
              ? resolveSplitViewFocusedThreadId(nextActiveSplitView)
              : null;
            if (nextActiveSplitView && nextFocusedThreadId) {
              void navigate({
                to: "/$threadId",
                params: { threadId: nextFocusedThreadId },
                replace: true,
                search: () => ({ splitViewId: nextActiveSplitView.id }),
              });
            } else if (prepared.shouldNavigateToFallback && prepared.fallbackThreadId) {
              void navigate({
                to: "/$threadId",
                params: { threadId: prepared.fallbackThreadId },
                replace: true,
              });
            } else if (prepared.shouldNavigateToFallback) {
              void handleNewChat({ fresh: true });
            }
          } else if (prepared?.shouldNavigateToFallback) {
            if (prepared.fallbackThreadId) {
              void navigate({
                to: "/$threadId",
                params: { threadId: prepared.fallbackThreadId },
                replace: true,
              });
            } else {
              void handleNewChat({ fresh: true });
            }
          }
        },
        removeWorktree: (worktree) => removeWorktreeMutation.mutateAsync(worktree),
      });
    },
    [
      activeSplitView,
      appSettings.sidebarThreadSortOrder,
      clearComposerDraftForThread,
      clearProjectDraftThreadById,
      clearTemporaryThread,
      clearTerminalState,
      handleNewChat,
      navigate,
      removeThreadFromSplitViews,
      removeWorktreeMutation,
      routeSplitViewId,
      routeThreadId,
      sidebarThreads,
      unpinThread,
    ],
  );

  const confirmAndDeleteThread = useCallback(
    async (threadId: ThreadId) => {
      const thread = sidebarThreadSummaryById[threadId];
      if (!thread) return;
      if (appSettings.confirmThreadDelete) {
        const api = readNativeApi();
        const confirmationMessage = [
          `Delete thread "${thread.title}"?`,
          "This permanently clears conversation history for this thread.",
        ].join("\n");
        const confirmed = api
          ? await api.dialogs.confirm(confirmationMessage)
          : await showConfirmDialogFallback(confirmationMessage);
        if (!confirmed) return;
      }
      await deleteThread(threadId);
    },
    [deleteThread, appSettings.confirmThreadDelete, sidebarThreadSummaryById],
  );

  const archiveThread = useCallback(
    async (threadId: ThreadId): Promise<boolean> => {
      const api = readNativeApi();
      if (!api) return false;
      const thread = getThreadFromState(useStore.getState(), threadId);
      if (!thread) return false;
      const pendingThreadIds = archivePendingThreadIdsRef.current;
      if (pendingThreadIds.has(threadId)) return false;

      pendingThreadIds.add(threadId);
      const runArchive = async (): Promise<boolean> => {
        await archiveThreadFromClient(api.orchestration, threadId);
        if (routeThreadId === threadId) {
          const fallbackThreadId = getFallbackThreadIdAfterDelete({
            threads: sidebarThreads,
            deletedThreadId: threadId,
            deletedThreadIds: new Set<ThreadId>(),
            sortOrder: appSettings.sidebarThreadSortOrder,
          });
          if (fallbackThreadId) {
            await navigate({
              to: "/$threadId",
              params: { threadId: fallbackThreadId },
              replace: true,
            });
          } else {
            await handleNewChat({ fresh: true });
          }
        }
        return true;
      };
      return runArchive().finally(() => {
        pendingThreadIds.delete(threadId);
      });
    },
    [appSettings.sidebarThreadSortOrder, handleNewChat, routeThreadId, sidebarThreads, navigate],
  );

  const restoreArchivedThreadFromToast = useCallback(
    async (restoreInput: {
      threadId: ThreadId;
      returnToThreadOnUndo: boolean;
    }): Promise<boolean> => {
      const pendingThreadIds = archiveUndoPendingThreadIdsRef.current;
      if (pendingThreadIds.has(restoreInput.threadId)) return false;
      pendingThreadIds.add(restoreInput.threadId);
      const runRestore = async (): Promise<boolean> => {
        try {
          const currentThread = getThreadFromState(useStore.getState(), restoreInput.threadId);
          if (!currentThread) {
            toastManager.add({
              type: "error",
              title: "Could not restore thread",
              description: "The thread no longer exists.",
            });
            return false;
          }
          await unarchiveThreadIgnoringAlreadyRestored(restoreInput.threadId);
          if (restoreInput.returnToThreadOnUndo) {
            void navigate({
              to: "/$threadId",
              params: { threadId: restoreInput.threadId },
              replace: true,
            });
          }
          return true;
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Could not restore thread",
            description: error instanceof Error ? error.message : "Unable to restore the thread.",
          });
          return false;
        }
      };
      return runRestore().finally(() => {
        pendingThreadIds.delete(restoreInput.threadId);
      });
    },
    [navigate],
  );

  const showArchiveUndoToast = useCallback(
    (threadId: ThreadId, options?: { returnToThreadOnUndo?: boolean }) => {
      toastManager.add({
        id: `archive-undo:${threadId}:${randomUUID()}`,
        timeout: 0,
        data: {
          allowCrossThreadVisibility: true,
          dismissAfterVisibleMs: ARCHIVE_UNDO_TOAST_DURATION_MS,
          archiveUndo: {
            onUndo: () =>
              restoreArchivedThreadFromToast({
                threadId,
                returnToThreadOnUndo: options?.returnToThreadOnUndo === true,
              }),
            onViewArchived: () => {
              void navigate({ to: "/settings", search: { section: "archived" } });
            },
          },
        },
      });
    },
    [navigate, restoreArchivedThreadFromToast],
  );

  const archiveThreadWithUndo = useCallback(
    async (threadId: ThreadId) => {
      try {
        const returnToThreadOnUndo = routeThreadId === threadId;
        const archived = await archiveThread(threadId);
        if (archived) showArchiveUndoToast(threadId, { returnToThreadOnUndo });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not archive thread",
          description: error instanceof Error ? error.message : "Unable to archive the thread.",
        });
      }
    },
    [archiveThread, routeThreadId, showArchiveUndoToast],
  );

  const confirmAndArchiveThread = useCallback(
    async (threadId: ThreadId) => {
      const thread = sidebarThreadSummaryById[threadId];
      if (!thread) return;
      if (appSettings.confirmThreadArchive) {
        const api = readNativeApi();
        const confirmationMessage = [
          `Archive thread "${thread.title}"?`,
          "Archived threads are hidden from the sidebar but can be restored later.",
        ].join("\n");
        const confirmed = api
          ? await api.dialogs.confirm(confirmationMessage)
          : await showConfirmDialogFallback(confirmationMessage);
        if (!confirmed) return;
      }
      await archiveThreadWithUndo(threadId);
    },
    [archiveThreadWithUndo, appSettings.confirmThreadArchive, sidebarThreadSummaryById],
  );

  const archiveAllThreadsInProject = useCallback(
    async (projectId: ProjectId): Promise<void> => {
      const api = readNativeApi();
      const project = projectById.get(projectId);
      if (!api || !project) return;
      const projectThreads = sidebarThreads.filter(
        (thread) => thread.projectId === projectId && thread.archivedAt == null,
      );
      if (projectThreads.length === 0) {
        toastManager.add({
          type: "info",
          title: "Nothing to archive",
          description: `"${project.name}" has no threads to archive.`,
        });
        return;
      }
      const archiveLines = [
        `Archive ${projectThreads.length} ${pluralize(projectThreads.length, "thread")} in "${project.name}"?`,
        "Archived threads are hidden from the sidebar but can be restored later.",
      ];
      const confirmed = api
        ? await api.dialogs.confirm(archiveLines.join("\n"))
        : await showConfirmDialogFallback(archiveLines.join("\n"));
      if (!confirmed) return;

      let archivedCount = 0;
      let failureCount = 0;
      for (const thread of projectThreads) {
        try {
          if (await archiveThread(thread.id)) archivedCount += 1;
          else failureCount += 1;
        } catch (error) {
          failureCount += 1;
          console.error("Failed to archive thread during bulk archive", {
            threadId: thread.id,
            projectId,
            error,
          });
        }
      }
      removeFromSelection(projectThreads.map((thread) => thread.id));
      if (archivedCount > 0) {
        toastManager.add({
          type: failureCount > 0 ? "warning" : "success",
          title: archivedCount === 1 ? "Thread archived" : `Archived ${archivedCount} threads`,
          description:
            failureCount > 0
              ? `Failed to archive ${failureCount} ${pluralize(failureCount, "thread")}.`
              : `"${project.name}" cleared.`,
        });
      } else if (failureCount > 0) {
        toastManager.add({
          type: "error",
          title: "Failed to archive threads",
          description: `Could not archive ${failureCount} ${pluralize(failureCount, "thread")} in "${project.name}".`,
        });
      }
    },
    [archiveThread, projectById, sidebarThreads, removeFromSelection],
  );

  const deleteProjectThreads = useCallback(
    async (projectId: ProjectId, options?: DeleteProjectThreadsOptions) => {
      const api = readNativeApi();
      const project = projectById.get(projectId);
      if (!api || !project) return null;
      const projectThreads = sidebarThreads.filter((thread) => thread.projectId === projectId);
      if (projectThreads.length === 0) {
        if (options?.showEmptyToast ?? true) {
          toastManager.add({
            type: "info",
            title: "Nothing to delete",
            description: `"${project.name}" has no threads to delete.`,
          });
        }
        return {
          deletedCount: 0,
          failureCount: 0,
          totalCount: 0,
          projectName: project.name,
        };
      }
      const confirmationMessage =
        options?.confirmMessage === undefined
          ? [
              `Delete ${projectThreads.length} ${pluralize(projectThreads.length, "thread")} in "${project.name}"?`,
              "This permanently clears conversation history for these threads.",
            ].join("\n")
          : options.confirmMessage;
      if (confirmationMessage !== null) {
        const confirmed = await api.dialogs.confirm(confirmationMessage);
        if (!confirmed) return null;
      }

      const deletedIds = new Set<ThreadId>(projectThreads.map((thread) => thread.id));
      // Built once, outside the loop's `try`: React Compiler cannot lower a conditional spread
      // inside a try block and would skip this hook entirely.
      const worktreeCleanupOverride = options?.worktreeCleanupMode
        ? { worktreeCleanupMode: options.worktreeCleanupMode }
        : {};
      const successfullyDeletedIds: ThreadId[] = [];
      let deletedCount = 0;
      let failureCount = 0;
      for (const thread of projectThreads) {
        try {
          await deleteThread(thread.id, {
            deletedThreadIds: deletedIds,
            reconcileDeletedThread: false,
            ...worktreeCleanupOverride,
          });
          successfullyDeletedIds.push(thread.id);
          deletedCount += 1;
        } catch (error) {
          failureCount += 1;
          console.error("Failed to delete thread during bulk delete", {
            threadId: thread.id,
            projectId,
            error,
          });
        }
      }
      void reconcileDeletedThreadsFromClient({
        threadIds: successfullyDeletedIds,
        removeDeletedThreadFromClientState: useStore.getState().removeDeletedThreadFromClientState,
      });
      removeFromSelection([...deletedIds]);
      if (options?.showResultToast ?? true) {
        if (deletedCount > 0) {
          toastManager.add({
            type: failureCount > 0 ? "warning" : "success",
            title: deletedCount === 1 ? "Thread deleted" : `Deleted ${deletedCount} threads`,
            description:
              failureCount > 0
                ? `Failed to delete ${failureCount} ${pluralize(failureCount, "thread")}.`
                : `"${project.name}" cleared.`,
          });
        } else if (failureCount > 0) {
          toastManager.add({
            type: "error",
            title: "Failed to delete threads",
            description: `Could not delete ${failureCount} ${pluralize(failureCount, "thread")} in "${project.name}".`,
          });
        }
      }
      return {
        deletedCount,
        failureCount,
        totalCount: projectThreads.length,
        projectName: project.name,
      };
    },
    [deleteThread, projectById, sidebarThreads, removeFromSelection],
  );

  return {
    pinnedThreadIds,
    pinnedThreadIdSet,
    toggleThreadPinned,
    setThreadSettledWithToast,
    settledOverrideByThreadId: optimisticSettledStateByThreadId,
    deleteThread,
    confirmAndDeleteThread,
    archiveThread,
    archiveThreadWithUndo,
    confirmAndArchiveThread,
    archiveAllThreadsInProject,
    deleteProjectThreads,
  } as const;
}

import { type ProjectId, ThreadId } from "@synara/contracts";
import { getDefaultModel } from "@synara/shared/model";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { startTransition } from "react";
import { useAppSettings } from "../appSettings";
import { prefetchModelsForNewThread } from "../lib/providerModelPrefetch";
import { useProviderStatusesForLocalConfig } from "../hooks/useProviderStatusesForLocalConfig";
import {
  hasReconciledServerProviderStatuses,
  serverConfigQueryOptions,
} from "../lib/serverReactQuery";
import {
  type ComposerThreadDraftState,
  type DraftThreadState,
  resolvePreferredComposerModelSelection,
  useComposerDraftStore,
} from "../composerDraftStore";
import {
  buildDraftThreadContextPatch,
  createActiveDraftThreadSnapshot,
  createActiveThreadSnapshot,
  createFreshDraftThreadSeed,
  resolveTerminalThreadCreationState,
  resolveThreadBootstrapPlan,
  type NewThreadOptions,
} from "../lib/threadBootstrap";
import { promoteThreadCreate } from "../lib/threadCreatePromotion";
import {
  draftNavigationSlotKey,
  runDraftNavigationOnce,
  stageDraftNavigation,
} from "../lib/stagedDraftNavigation";
import { newCommandId, newThreadId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useFocusedChatContext } from "../focusedChatContext";
import { useStore } from "../store";
import { useTemporaryThreadStore } from "../temporaryThreadStore";
import { useTerminalStateStore } from "../terminalStateStore";

export interface NewThreadNavigationOptions {
  /**
   * Search params applied when the hook navigates to the created thread.
   * Lets callers keep view-level state (e.g. the editor workspace view)
   * across the route change; default navigation clears all search params.
   */
  search?: (previous: Record<string, unknown>) => Record<string, unknown>;
}

export function useHandleNewThread() {
  const projects = useStore((store) => store.projects);
  const { settings, serverSettings } = useAppSettings();
  const queryClient = useQueryClient();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const serverCwd = serverConfigQuery.data?.cwd ?? null;
  const providerStatuses = useProviderStatusesForLocalConfig();
  const providerStatusesReconciled = hasReconciledServerProviderStatuses(queryClient);
  const navigate = useNavigate();
  const router = useRouter();
  const { activeDraftThread, activeProjectId, activeThread, focusedThreadId, routeThreadId } =
    useFocusedChatContext();
  const openChatThreadPage = useTerminalStateStore((store) => store.openChatThreadPage);
  const openTerminalThreadPage = useTerminalStateStore((store) => store.openTerminalThreadPage);
  const clearTerminalState = useTerminalStateStore((store) => store.clearTerminalState);
  const markTemporaryThread = useTemporaryThreadStore((store) => store.markTemporaryThread);
  const clearTemporaryThread = useTemporaryThreadStore((store) => store.clearTemporaryThread);

  const handleNewThread = (
    projectId: ProjectId,
    options?: NewThreadOptions,
    navigation?: NewThreadNavigationOptions,
  ): Promise<ThreadId | null> => {
    const entryPoint = options?.entryPoint ?? "chat";
    if (entryPoint === "chat") {
      const draftStore = useComposerDraftStore.getState();
      const draftThread = draftStore.getDraftThreadByProjectId(projectId, "chat");
      const draftComposer = draftThread
        ? (draftStore.draftsByThreadId[draftThread.threadId] ?? null)
        : null;
      const project = useStore.getState().projects.find((candidate) => candidate.id === projectId);

      prefetchModelsForNewThread(queryClient, {
        settings,
        serverSettings: serverSettings ?? null,
        hiddenProviders: settings.hiddenProviders,
        providerOverride: options?.provider ?? null,
        draftActiveProvider: draftComposer?.activeProvider ?? null,
        stickyActiveProvider: draftStore.stickyActiveProvider,
        projectDefaultProvider: project?.defaultModelSelection?.provider ?? null,
        projectCwd: project?.cwd ?? null,
        draftWorktreePath: draftThread?.worktreePath ?? null,
        worktreePath: options?.worktreePath ?? null,
        hasExplicitWorktreePath: options?.worktreePath !== undefined,
        fresh: options?.fresh === true,
        envMode: options?.envMode ?? null,
        serverCwd,
        providerStatuses,
        statusesReconciled: providerStatusesReconciled,
        providerOrder: settings.providerOrder,
        includeDroid: true,
      });
    }
    const wantsTemporaryThread = options?.temporary === true;
    const applyProviderOverride = (threadId: ThreadId) => {
      if (!options?.provider) {
        return;
      }
      const defaultModel = getDefaultModel(options.provider);
      if (!defaultModel) {
        return;
      }
      setModelSelection(threadId, {
        provider: options.provider,
        model: defaultModel,
      });
    };
    // Fresh chat drafts carry only sticky-seeded composer state, so resolve the
    // draft model selection against the full precedence (explicit provider >
    // project default > global default > sticky) instead of overwriting the
    // sticky provider with the global default alone.
    const applyResolvedDefault = (threadId: ThreadId) => {
      if (options?.provider) {
        return;
      }
      const draftComposerState =
        useComposerDraftStore.getState().draftsByThreadId[threadId] ?? null;
      const modelSelection = resolvePreferredComposerModelSelection({
        draft: draftComposerState,
        threadModelSelection: null,
        projectModelSelection: projectDefaultModelSelection,
        defaultProvider: settings.defaultProvider,
        fresh: true,
      });
      // A fresh chat draft was seeded with sticky composer state, so the
      // resolved project/global default would otherwise get the sticky model's
      // same-provider options merged back onto it by setModelSelection's option
      // preservation. Drop the resolved provider's sticky-seeded entry first so
      // only the resolved selection lands in the draft. When resolution fell
      // back to the sticky draft selection, that selection already carries its
      // own options.
      useComposerDraftStore.setState((state) => {
        const draft = state.draftsByThreadId[threadId];
        if (!draft) {
          return state;
        }
        const modelSelectionByProvider = { ...draft.modelSelectionByProvider };
        delete modelSelectionByProvider[modelSelection.provider];
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: { ...draft, modelSelectionByProvider },
          },
        };
      });
      setModelSelection(threadId, modelSelection);
    };
    const restoreComposerDraft = (
      threadId: ThreadId,
      draftState: ComposerThreadDraftState | null,
    ) => {
      if (!draftState) {
        return;
      }
      useComposerDraftStore.setState((state) => {
        if (state.draftsByThreadId[threadId] === draftState) {
          return state;
        }
        return {
          draftsByThreadId: {
            ...state.draftsByThreadId,
            [threadId]: draftState,
          },
        };
      });
    };
    const activateThreadEntryPoint = (threadId: ThreadId) => {
      if (entryPoint === "terminal") {
        openTerminalThreadPage(threadId, { terminalOnly: true });
        return;
      }
      openChatThreadPage(threadId);
    };
    const {
      getDraftThread,
      getDraftThreadByProjectId,
      applyStickyState,
      clearDraftThread,
      registerDraftThread,
      setDraftThreadContext,
      setProjectDraftThreadId,
      setModelSelection,
    } = useComposerDraftStore.getState();
    const shouldForceFreshThread = options?.fresh === true;

    const storedDraftThreadCandidate = getDraftThreadByProjectId(projectId, entryPoint);
    const latestActiveDraftThreadCandidate: DraftThreadState | null = focusedThreadId
      ? getDraftThread(focusedThreadId)
      : null;
    const storedDraftThread =
      !shouldForceFreshThread &&
      !wantsTemporaryThread &&
      storedDraftThreadCandidate?.isTemporary !== true
        ? storedDraftThreadCandidate
        : null;
    const latestActiveDraftThread: DraftThreadState | null =
      !shouldForceFreshThread &&
      !wantsTemporaryThread &&
      latestActiveDraftThreadCandidate?.isTemporary !== true
        ? latestActiveDraftThreadCandidate
        : null;
    const bootstrapPlan = resolveThreadBootstrapPlan({
      storedDraftThread,
      latestActiveDraftThread,
      entryPoint,
      projectId,
      routeThreadId: focusedThreadId,
    });
    // A fresh bootstrap (explicit options.fresh or a plan with no reusable draft)
    // means the new draft's composer state is only sticky-seeded carry-over, so
    // resolve its model selection against explicit thread/project/default
    // providers instead of that stale sticky provider.
    const freshBootstrap = options?.fresh === true || bootstrapPlan.kind === "fresh";
    // Read from the store at call time so post-sync sidebar flows can use the latest project defaults.
    const projectDefaultModelSelection =
      useStore.getState().projects.find((project) => project.id === projectId)
        ?.defaultModelSelection ?? null;
    const activeThreadSnapshot = createActiveThreadSnapshot(activeThread, projectId);
    const activeDraftThreadSnapshot = createActiveDraftThreadSnapshot(activeDraftThread, projectId);
    const resolveCreationState = (
      targetThreadId: ThreadId,
      draftThread: DraftThreadState | null,
      creationOptions: NewThreadOptions | undefined,
    ) =>
      resolveTerminalThreadCreationState({
        activeDraftThread: activeDraftThreadSnapshot,
        activeThread: activeThreadSnapshot,
        defaultProvider: options?.provider ?? settings.defaultProvider,
        draftComposerState:
          useComposerDraftStore.getState().draftsByThreadId[targetThreadId] ?? null,
        draftThread,
        fresh: freshBootstrap,
        options: creationOptions,
        projectDefaultModelSelection,
        projectId,
      });
    // Terminal-first threads need a real orchestration thread immediately so
    // the sidebar can render them as durable rows instead of draft-only routes.
    const createTerminalThread = async (
      threadId: ThreadId,
      creationState: ReturnType<typeof resolveCreationState>,
    ): Promise<void> => {
      const api = readNativeApi();
      if (!api) {
        return;
      }
      await promoteThreadCreate(
        {
          type: "thread.create",
          commandId: newCommandId(),
          threadId,
          projectId,
          title: "New terminal",
          modelSelection: creationState.modelSelection,
          runtimeMode: creationState.runtimeMode,
          interactionMode: creationState.interactionMode,
          envMode: creationState.envMode,
          branch: creationState.branch,
          worktreePath: creationState.worktreePath,
          workingDirectory: creationState.workingDirectory,
          lastKnownPr: creationState.lastKnownPr,
          createdAt: new Date().toISOString(),
        },
        api,
      );
    };
    if (bootstrapPlan.kind === "stored") {
      return (async (): Promise<ThreadId> => {
        if (wantsTemporaryThread) {
          markTemporaryThread(bootstrapPlan.threadId);
        }
        const preservedComposerDraft =
          useComposerDraftStore.getState().draftsByThreadId[bootstrapPlan.threadId] ?? null;
        let resolvedStoredDraftThread: DraftThreadState | null = bootstrapPlan.draftThread;
        const shouldPreserveStoredTerminalContext =
          entryPoint === "terminal" && bootstrapPlan.draftThread.entryPoint === "terminal";
        const draftContextPatch = shouldPreserveStoredTerminalContext
          ? null
          : buildDraftThreadContextPatch(entryPoint, options);
        const creationOptions = shouldPreserveStoredTerminalContext ? undefined : options;
        if (draftContextPatch) {
          setDraftThreadContext(bootstrapPlan.threadId, draftContextPatch);
          resolvedStoredDraftThread = getDraftThread(bootstrapPlan.threadId);
        }
        applyProviderOverride(bootstrapPlan.threadId);
        setProjectDraftThreadId(projectId, bootstrapPlan.threadId, { entryPoint });
        restoreComposerDraft(bootstrapPlan.threadId, preservedComposerDraft);
        activateThreadEntryPoint(bootstrapPlan.threadId);
        if (focusedThreadId === bootstrapPlan.threadId) {
          if (entryPoint === "terminal") {
            await createTerminalThread(
              bootstrapPlan.threadId,
              resolveCreationState(
                bootstrapPlan.threadId,
                resolvedStoredDraftThread,
                creationOptions,
              ),
            );
          }
          return bootstrapPlan.threadId;
        }
        await navigate({
          to: "/$threadId",
          params: { threadId: bootstrapPlan.threadId },
          ...(navigation?.search ? { search: navigation.search } : {}),
        });
        restoreComposerDraft(bootstrapPlan.threadId, preservedComposerDraft);
        if (entryPoint === "terminal") {
          await createTerminalThread(
            bootstrapPlan.threadId,
            resolveCreationState(
              bootstrapPlan.threadId,
              resolvedStoredDraftThread,
              creationOptions,
            ),
          );
        }
        return bootstrapPlan.threadId;
      })();
    }

    if (bootstrapPlan.kind === "route") {
      return (async (): Promise<ThreadId> => {
        if (wantsTemporaryThread) {
          markTemporaryThread(bootstrapPlan.threadId);
        }
        const preservedComposerDraft =
          useComposerDraftStore.getState().draftsByThreadId[bootstrapPlan.threadId] ?? null;
        let resolvedActiveDraftThread: DraftThreadState | null = bootstrapPlan.draftThread;
        const draftContextPatch = buildDraftThreadContextPatch(entryPoint, options);
        if (draftContextPatch) {
          setDraftThreadContext(bootstrapPlan.threadId, draftContextPatch);
          resolvedActiveDraftThread = getDraftThread(bootstrapPlan.threadId);
        }
        applyProviderOverride(bootstrapPlan.threadId);
        setProjectDraftThreadId(projectId, bootstrapPlan.threadId, { entryPoint });
        restoreComposerDraft(bootstrapPlan.threadId, preservedComposerDraft);
        activateThreadEntryPoint(bootstrapPlan.threadId);
        if (entryPoint === "terminal") {
          await createTerminalThread(
            bootstrapPlan.threadId,
            resolveCreationState(bootstrapPlan.threadId, resolvedActiveDraftThread, options),
          );
        }
        return bootstrapPlan.threadId;
      })();
    }

    return runDraftNavigationOnce(draftNavigationSlotKey(projectId, entryPoint), async () => {
      const threadId = newThreadId();
      if (wantsTemporaryThread) {
        markTemporaryThread(threadId);
      }
      const createdAt = new Date().toISOString();
      const draftSeed = createFreshDraftThreadSeed({ createdAt, entryPoint, options });
      const committed = await stageDraftNavigation({
        // Keep the previous routed draft alive while the destination loads. Replacing the
        // project's primary slot earlier makes the route guard redirect the old URL to Home.
        stage: () => {
          registerDraftThread(threadId, { projectId, ...draftSeed });
          activateThreadEntryPoint(threadId);
          applyStickyState(threadId);
          applyProviderOverride(threadId);
          applyResolvedDefault(threadId);
        },
        // Mark the draft-landing navigation as a transition so the new route
        // subtree renders interruptibly and the browser can paint the chat
        // mount loader immediately instead of freezing on the synchronous commit.
        navigate: () =>
          new Promise<void>((resolve, reject) => {
            startTransition(() => {
              navigate({
                to: "/$threadId",
                params: { threadId },
                ...(navigation?.search ? { search: navigation.search } : {}),
              }).then(resolve, reject);
            });
          }),
        // TanStack resolves an older navigate() promise when a newer navigation supersedes it.
        // Verify the committed route before deleting the previous project draft.
        isDestinationActive: () => router.state.location.pathname === `/${threadId}`,
        finalize: () => setProjectDraftThreadId(projectId, threadId, draftSeed),
        rollback: () => {
          clearDraftThread(threadId);
          clearTerminalState(threadId);
          if (wantsTemporaryThread) {
            clearTemporaryThread(threadId);
          }
        },
      });
      if (!committed) {
        return null;
      }
      if (entryPoint === "terminal") {
        await createTerminalThread(
          threadId,
          resolveCreationState(threadId, getDraftThread(threadId), options),
        );
      }
      return threadId;
    });
  };

  return {
    activeDraftThread,
    activeProjectId,
    activeThread,
    activeContextThreadId: focusedThreadId,
    handleNewThread,
    projects,
    routeThreadId,
  };
}

// FILE: _chat.$threadId.tsx
// Purpose: Resolve the active thread route into either a single chat surface or a persisted split view.
// Layer: Route container

import { type ProjectId, ThreadId } from "@synara/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  type EmptyRouteRestoreRecoveryState,
  shouldHoldMissingThreadRouteFallback,
  shouldStartMissingThreadRouteRecovery,
} from "../chatRouteRestore";
import {
  refreshEmptyRouteRestoreSnapshot,
  waitForEmptyRouteRestoreFallbackDelay,
} from "../chatRouteRecovery";
import {
  reclaimUnreachableDetachedDraftThreads,
  useComposerDraftStore,
} from "../composerDraftStore";
import { parseDiffRouteSearch, stripDiffSearchParams } from "../diffRouteSearch";
import { readNativeApi } from "../nativeApi";
import { isSplitRoute } from "../splitViewRoute";
import { collectSplitViewThreadIds, selectSplitView, useSplitViewStore } from "../splitViewStore";
import { useStore } from "../store";
import { createThreadExistsSelector, createThreadProjectIdSelector } from "../storeSelectors";
import { SingleChatSurface } from "../components/chat/SingleChatSurface";
import { SplitChatSurface } from "../components/chat/SplitChatSurface";
import { resolveSingleProjectId } from "./-chatThreadRoute.logic";

function ChatThreadRouteView() {
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const hasKnownServerThreads = useStore((store) => (store.threadIds?.length ?? 0) > 0);
  const threadId = Route.useParams({
    select: (params) => ThreadId.makeUnsafe(params.threadId),
  });
  const search = Route.useSearch();
  const threadProjectIdSelector = createThreadProjectIdSelector(threadId);
  const threadExistsSelector = createThreadExistsSelector(threadId);
  const threadProjectId: ProjectId | null = useStore(threadProjectIdSelector);
  const threadExists = useStore(threadExistsSelector);
  const draftThreadState = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[threadId] ?? null,
  );
  const draftThreadExists = draftThreadState !== null;
  const routeThreadExists = threadExists || draftThreadExists;
  const splitView = useSplitViewStore(
    useMemo(() => selectSplitView(search.splitViewId ?? null), [search.splitViewId]),
  );
  const splitViewsHydrated = useSplitViewStore((store) => store.hasHydrated);
  const activeProjectId = resolveSingleProjectId({
    threadProjectId,
    draftProjectId: draftThreadState?.projectId ?? null,
  });
  const navigate = useNavigate();
  const [missingThreadRecoveryState, setMissingThreadRecoveryState] =
    useState<EmptyRouteRestoreRecoveryState>("idle");
  const mountedRef = useRef(true);
  const missingThreadRecoveryRunRef = useRef(0);
  // Synchronous re-entry guard: the "pending" transition below is deferred (async
  // setState), so this ref keeps the recovery from starting twice in the interim.
  // It is cleared synchronously whenever an episode is invalidated (new thread
  // route, or the thread appearing).
  const recoveryStartedRef = useRef(false);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    // Invalidate any in-flight recovery and start a fresh episode for the new
    // thread route. The run bump + guard reset are synchronous (so a stale async
    // completion cannot stamp "done"); the state reset is deferred async setState.
    missingThreadRecoveryRunRef.current += 1;
    recoveryStartedRef.current = false;
    const timer = window.setTimeout(() => setMissingThreadRecoveryState("idle"), 0);
    return () => window.clearTimeout(timer);
  }, [threadId]);

  useEffect(() => {
    if (routeThreadExists && missingThreadRecoveryState !== "idle") {
      missingThreadRecoveryRunRef.current += 1;
      recoveryStartedRef.current = false;
      const timer = window.setTimeout(() => setMissingThreadRecoveryState("idle"), 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [missingThreadRecoveryState, routeThreadExists]);

  useEffect(() => {
    return () => {
      // Detached drafts (preserveProjectDraft flows such as bug-report
      // drafting) never claim a project slot, so once their route unmounts
      // nothing links back to them. The check is deferred so strict-mode
      // remounts and staged navigations cannot reclaim a still-displayed
      // draft — by the time it runs, the location has settled.
      window.setTimeout(() => {
        const displayedThreadIds = collectSplitViewThreadIds();
        const routedThreadId = window.location.pathname.match(/^\/([^/?#]+)/)?.[1];
        if (routedThreadId) {
          displayedThreadIds.add(ThreadId.makeUnsafe(decodeURIComponent(routedThreadId)));
        }
        reclaimUnreachableDetachedDraftThreads(displayedThreadIds);
      }, 0);
    };
  }, [threadId]);

  useEffect(() => {
    if (!threadsHydrated || !splitViewsHydrated) {
      return;
    }

    if (!routeThreadExists) {
      if (
        shouldStartMissingThreadRouteRecovery({
          hasKnownServerThreads,
          recoveryState: missingThreadRecoveryState,
          routeThreadExists,
        }) &&
        !recoveryStartedRef.current
      ) {
        recoveryStartedRef.current = true;
        const recoveryRun = (missingThreadRecoveryRunRef.current += 1);
        // Defer the "pending" mark (async setState); the ref guard above prevents a
        // second start before it lands, and the run check skips it if the episode
        // was invalidated in the meantime.
        const pendingTimer = window.setTimeout(() => {
          if (missingThreadRecoveryRunRef.current === recoveryRun) {
            setMissingThreadRecoveryState("pending");
          }
        }, 0);
        void Promise.all([
          refreshEmptyRouteRestoreSnapshot(readNativeApi()).catch(() => false),
          waitForEmptyRouteRestoreFallbackDelay(),
        ]).finally(() => {
          window.clearTimeout(pendingTimer);
          if (mountedRef.current && missingThreadRecoveryRunRef.current === recoveryRun) {
            setMissingThreadRecoveryState("done");
          }
        });
        return;
      }

      if (
        shouldHoldMissingThreadRouteFallback({
          hasKnownServerThreads,
          recoveryState: missingThreadRecoveryState,
          routeThreadExists,
        })
      ) {
        return;
      }
    }

    if (isSplitRoute(search)) {
      if (!splitView) {
        void navigate({
          to: "/$threadId",
          params: { threadId },
          replace: true,
          search: (previous) => ({
            ...stripDiffSearchParams(previous),
            splitViewId: undefined,
          }),
        });
      }
      return;
    }

    if (!routeThreadExists) {
      void navigate({ to: "/", replace: true });
    }
  }, [
    hasKnownServerThreads,
    missingThreadRecoveryState,
    navigate,
    routeThreadExists,
    search,
    splitView,
    splitViewsHydrated,
    threadId,
    threadsHydrated,
  ]);

  if (
    !threadsHydrated ||
    !splitViewsHydrated ||
    shouldHoldMissingThreadRouteFallback({
      hasKnownServerThreads,
      recoveryState: missingThreadRecoveryState,
      routeThreadExists,
    })
  ) {
    return null;
  }

  if (splitView && search.splitViewId) {
    return <SplitChatSurface splitViewId={search.splitViewId} routeThreadId={threadId} />;
  }

  if (!routeThreadExists) {
    return null;
  }

  return <SingleChatSurface threadId={threadId} search={search} projectId={activeProjectId} />;
}

export const Route = createFileRoute("/_chat/$threadId")({
  validateSearch: (search) => parseDiffRouteSearch(search),
  component: ChatThreadRouteView,
});

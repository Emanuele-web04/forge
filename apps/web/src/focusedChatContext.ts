// FILE: focusedChatContext.ts
// Purpose: Resolves the currently focused chat context across single and split chat surfaces.
// Layer: Route-aware UI helpers
// Exports: hook used by shortcut, discovery, and thread creation flows

import { ThreadId, type ThreadId as ThreadIdType } from "@synara/contracts";
import { useMemo } from "react";
import { useParams } from "@tanstack/react-router";
import { type DraftThreadState, useComposerDraftStore } from "./composerDraftStore";
import { useDiffRouteSearch } from "./hooks/useDiffRouteSearch";
import {
  resolveSplitViewFocusedPaneThreadId,
  selectSplitView,
  type SplitView,
  useSplitViewStore,
} from "./splitViewStore";
import { useStore } from "./store";
import { createProjectSelector, createThreadSelector } from "./storeSelectors";
import type { Project, Thread } from "./types";

export interface FocusedChatContext {
  routeThreadId: ThreadIdType | null;
  splitView: SplitView | null;
  focusedThreadId: ThreadIdType | null;
  activeThread: Thread | null;
  activeDraftThread: DraftThreadState | null;
  activeProject: Project | null;
  activeProjectId: Project["id"] | null;
}

export function useFocusedChatContext(): FocusedChatContext {
  const draftThreadsByThreadId = useComposerDraftStore((store) => store.draftThreadsByThreadId);
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const routeSearch = useDiffRouteSearch();
  const activeSplitView = useSplitViewStore(
    useMemo(() => selectSplitView(routeSearch.splitViewId ?? null), [routeSearch.splitViewId]),
  );
  const focusedThreadId = activeSplitView
    ? resolveSplitViewFocusedPaneThreadId(activeSplitView)
    : routeThreadId;
  const activeThread = useStore(
    useMemo(() => createThreadSelector(focusedThreadId), [focusedThreadId]),
  );
  const activeDraftThread =
    focusedThreadId !== null ? (draftThreadsByThreadId[focusedThreadId] ?? null) : null;
  const activeProjectId =
    activeDraftThread?.projectId ??
    activeThread?.projectId ??
    activeSplitView?.ownerProjectId ??
    null;
  const activeProject = useStore(
    useMemo(() => createProjectSelector(activeProjectId), [activeProjectId]),
  );

  return {
    routeThreadId,
    splitView: activeSplitView,
    focusedThreadId,
    activeThread: activeThread ?? null,
    activeDraftThread,
    activeProject: activeProject ?? null,
    activeProjectId,
  };
}

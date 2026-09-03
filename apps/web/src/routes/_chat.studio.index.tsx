// FILE: _chat.studio.index.tsx
// Purpose: Landing for the Studio surface — restore the latest Studio chat or its draft, falling
//          back to creating a fresh Studio chat. Reuses the shared restore/create route surface so
//          Studio gets the same empty-bootstrap-snapshot recovery machinery as the home route
//          (a hard refresh or deep link can otherwise land on a briefly-empty snapshot and create
//          a duplicate Studio thread).
// Layer: Routing
// Depends on: Studio project lookup, the shared restore/create route surface, and the Studio
//             new-chat hook.

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useAppSettings } from "../appSettings";
import {
  RestoreOrCreateChatRoute,
  type RestoreRouteResolver,
} from "../components/RestoreOrCreateChatRoute";
import { sortThreadsForSidebar } from "../components/Sidebar.logic";
import { readSidebarUiState } from "../components/Sidebar.uiState";
import { resolveRestorableThreadRoute } from "../chatRouteRestore";
import { SplashScreen } from "../components/SplashScreen";
import { useComposerDraftStore } from "../composerDraftStore";
import { useHandleNewStudioChat } from "../hooks/useHandleNewStudioChat";
import { collectStudioProjectIds, findStudioDraftThreadId } from "../lib/studioProjects";
import { EMPTY_THREAD_IDS, useStore } from "../store";
import { useWorkspacePathsStore } from "../workspacePathsStore";

// How long the splash below waits for the welcome's Studio root before surfacing an error —
// generous next to a normal welcome round-trip, mirroring the home route's eventual error+retry.
const WORKSPACE_PATHS_TIMEOUT_MS = 10_000;

function StudioIndexRouteView() {
  const { settings: appSettings } = useAppSettings();
  const { handleNewStudioChat } = useHandleNewStudioChat();
  const threadIds = useStore((state) => state.threadIds ?? EMPTY_THREAD_IDS);
  const projects = useStore((state) => state.projects);
  const sidebarThreadSummaryById = useStore((state) => state.sidebarThreadSummaryById);
  const draftThreadsByThreadId = useComposerDraftStore((state) => state.draftThreadsByThreadId);
  const projectDraftThreadIdByProjectId = useComposerDraftStore(
    (state) => state.projectDraftThreadIdByProjectId,
  );
  const homeDir = useWorkspacePathsStore((state) => state.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((state) => state.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspacePathsStore((state) => state.studioWorkspaceRoot);

  const studioProjectIds = collectStudioProjectIds(projects, {
    homeDir,
    chatWorkspaceRoot,
    studioWorkspaceRoot,
  });
  // The container's stored draft (if any). It's a valid remembered-route target below, and when
  // nothing is remembered it wins over the latest thread: the resolver defers to
  // `createFreshChat`, whose `handleNewStudioChat` reopens the stored draft.
  const studioDraftThreadId = findStudioDraftThreadId({
    studioProjectIds,
    projectDraftThreadIdByProjectId,
    draftThreadsByThreadId,
  });
  // Studio threads (sidebar summaries) backing both the remembered-route scope and the
  // latest-thread fallback below. Archived chats are excluded — the sidebar hides them, so the
  // landing must not resurrect one; an archived-only Studio opens the draft or a fresh chat.
  const studioThreadSummaries = threadIds.flatMap((threadId) => {
    const summary = sidebarThreadSummaryById[threadId];
    return summary &&
      (summary.archivedAt ?? null) === null &&
      !summary.sidechatSourceThreadId &&
      studioProjectIds.has(summary.projectId)
      ? [summary]
      : [];
  });
  // The most recent Studio chat (if any), used to restore the surface instead of always opening
  // a brand-new draft.
  const latestStudioThreadId =
    sortThreadsForSidebar(studioThreadSummaries, appSettings.sidebarThreadSortOrder)[0]?.id ?? null;

  // Same landing policy as the Studio segment switch and settings back: remembered route first
  // (scoped to Studio threads plus the stored draft), then the stored draft, then the latest
  // Studio chat — so a refresh or deep link on /studio returns to the chat you last had open.
  const resolveRestoreRoute: RestoreRouteResolver = ({ availableSplitViewIds }) => {
    const availableThreadIds = new Set<string>(studioThreadSummaries.map((thread) => thread.id));
    if (studioDraftThreadId) {
      availableThreadIds.add(studioDraftThreadId);
    }
    const rememberedRoute = resolveRestorableThreadRoute({
      lastThreadRoute: readSidebarUiState().lastThreadRoute,
      availableThreadIds,
      availableSplitViewIds,
    });
    if (rememberedRoute) {
      return rememberedRoute;
    }
    if (studioDraftThreadId || !latestStudioThreadId) {
      return null;
    }
    return { threadId: latestStudioThreadId };
  };

  // Deliberately NOT `{ fresh: true }` (unlike the "/" route): when the resolver returns null
  // because a Studio draft exists, handleNewStudioChat reopens that stored draft instead of
  // minting a new one per visit — a fresh draft each landing would litter the hidden container.
  const createFreshChat = () => handleNewStudioChat();

  // A hidden Studio tab must never start the restore/create flow: a direct /studio link would
  // otherwise race the sidebar's hidden-section redirect and could mint a hidden Studio draft.
  const navigate = useNavigate();
  const studioSectionVisible = appSettings.showStudioSection;
  useEffect(() => {
    if (!studioSectionVisible) {
      void navigate({ to: "/", replace: true });
    }
  }, [navigate, studioSectionVisible]);

  // Don't wait on the splash below forever: if the welcome never delivers a Studio root
  // (connection trouble, or a server that doesn't report one), surface an error with a retry
  // that re-arms the wait — matching how the home route eventually surfaces failures.
  const [pathsWaitTimedOut, setPathsWaitTimedOut] = useState(false);
  useEffect(() => {
    if (studioWorkspaceRoot || pathsWaitTimedOut) {
      return;
    }
    const timer = window.setTimeout(() => setPathsWaitTimedOut(true), WORKSPACE_PATHS_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [pathsWaitTimedOut, studioWorkspaceRoot]);

  if (!studioSectionVisible) {
    return <SplashScreen />;
  }

  // The resolver and `handleNewStudioChat` both read the server welcome's workspace paths.
  // The shared restore/create machinery only guards against an empty *thread* snapshot, so hold
  // the splash until the welcome arrives — otherwise a snapshot that hydrates first would make
  // the resolver miss existing Studio threads and the fallback create fail against a null root.
  if (!studioWorkspaceRoot) {
    return (
      <SplashScreen
        errorMessage={
          pathsWaitTimedOut
            ? "Studio is taking too long to load — the server has not reported its Studio folder yet."
            : null
        }
        onRetry={pathsWaitTimedOut ? () => setPathsWaitTimedOut(false) : null}
      />
    );
  }

  return (
    <RestoreOrCreateChatRoute
      resolveRestoreRoute={resolveRestoreRoute}
      createFreshChat={createFreshChat}
    />
  );
}

export const Route = createFileRoute("/_chat/studio/")({
  component: StudioIndexRouteView,
});

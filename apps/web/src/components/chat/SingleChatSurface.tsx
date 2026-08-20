import type { FileDiffMetadata } from "@pierre/diffs/react";
import { isWorkspaceRelativePathSafe } from "@synara/shared/path";
import type { ProjectId, ThreadId, TurnId } from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  lazy,
  type ReactNode,
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useAppSettings } from "../../appSettings";
import { useComposerDraftStore } from "../../composerDraftStore";
import type { DiffRouteSearch } from "../../diffRouteSearch";
import { stripDiffSearchParams } from "../../diffRouteSearch";
import { readEditorViewState, storeEditorViewState } from "../../editorViewState";
import { basenameOfPath } from "../../file-icons";
import { useBrowserPanelDesktopBridge } from "../../hooks/useBrowserPanelDesktopBridge";
import { useDockPaneRuntimeActivation } from "../../hooks/useDockPaneRuntimeActivation";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useDeviceEventBridge } from "../../hooks/useDeviceEventBridge";
import { useDeviceSupport } from "../../hooks/useDeviceSupport";
import { useRepoDiffTotals } from "../../hooks/useRepoDiffTotals";
import {
  addChatFileComment,
  appendChatFileReference,
  appendComposerPromptText,
  buildWhyLinesPrompt,
  type ChatFileReference,
} from "../../lib/chatReferences";
import {
  dockSidechatPaneScopeId,
  EDITOR_CHAT_PANE_SCOPE_ID,
  SINGLE_CHAT_PANE_SCOPE_ID,
} from "../../lib/chatPaneScope";
import type { DockPaneRuntimeMode } from "../../lib/dockPaneActivation";
import type { FileCommentSelection } from "../../lib/fileComments";
import { gitBranchesQueryOptions } from "../../lib/gitReactQuery";
import { canComposerHandlePanelWidth } from "../../lib/panelResize";
import { projectListDirectoriesQueryOptions } from "../../lib/projectReactQuery";
import { waitForSidechatCreator } from "../../lib/sidechatCreatorRegistry";
import {
  clearSidechatPaneRetention,
  getSidechatPaneRetentionVersion,
  sidechatPaneRetentionRemainingMs,
  subscribeSidechatPaneRetention,
} from "../../lib/sidechatCreation";
import {
  prefetchWorkspaceFile,
  resolveDockFileOpenTarget,
  resolveWorkspaceFileOpenTarget,
  WorkspaceFileOpenerContext,
  type WorkspaceFileOpener,
} from "../../lib/workspaceFileOpener";
import { requestExplorerReveal } from "../../explorerRevealRequestStore";
import { selectRightDockState, useRightDockStore } from "../../rightDockStore";
import {
  resolveActivePane,
  findMissingSidechatPaneIds,
  type RightDockPane,
  type RightDockPaneKind,
} from "../../rightDockStore.logic";
import {
  type SplitDirection,
  type SplitDropSide,
  type SplitViewPanePanelState,
  useSplitViewStore,
} from "../../splitViewStore";
import { useStore } from "../../store";
import {
  createProjectSelector,
  createSidebarThreadSummariesSelector,
  createThreadWorkspaceMetadataSelector,
} from "../../storeSelectors";
import { sortThreadsForSidebar } from "../Sidebar.logic";
import { ChatPaneDropOverlay } from "../chat-drop-overlay/ChatPaneDropOverlay";
import {
  ChatMountLoader,
  DeferredChatView,
  LazyBrowserPanel,
  LazyDevicePanel,
  LazyDiffPanel,
  noopChatSurfaceAction,
} from "./ChatThreadSurfacePrimitives";
import { PanelStateMessage } from "./PanelStateMessage";
import { RightDock } from "./RightDock";
import { getRightDockPaneMeta, resolveRightDockLauncherItems } from "./rightDockPaneMeta";
import {
  CHAT_BACKGROUND_CLASS_NAME,
  CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME,
  CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME,
} from "./composerPickerStyles";
import { routeSingleBrowserPanelOpenRequest } from "./browserPanelOpenRequest";
import { routeSingleDevicePaneOpenRequest } from "./devicePaneOpenRequest";
import {
  pullRequestDetailInputFromPane,
  pullRequestPaneTabLabel,
} from "../pullRequest/pullRequestDetail.logic";
import { usePullRequestPaneStateIcon } from "../pullRequest/usePullRequestPaneStateIcon";
import { RouteInsetSurface } from "../RouteInsetSurface";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { WorkspaceSearchPalette, type WorkspaceSearchPaletteMode } from "../WorkspaceSearchPalette";
import {
  collectParentDirectoryPaths,
  resolveFilePreviewWorkspaceRoot,
  resolveRoutePanelBootstrap,
  stripEditorViewSearchParams,
} from "../../routes/-chatThreadRoute.logic";
import { cn } from "~/lib/utils";

const PullRequestDockPane = lazy(() => import("../pullRequest/PullRequestDockPane"));
const EditorWorkspaceView = lazy(() =>
  import("../EditorWorkspaceView").then((module) => ({
    default: module.EditorWorkspaceView,
  })),
);
const DockTerminalPane = lazy(() => import("./DockTerminalPane"));
const GitPanel = lazy(() => import("./GitPanel"));
const DockExplorerPane = lazy(() =>
  import("./DockExplorerPane").then((module) => ({
    default: module.DockExplorerPane,
  })),
);
const DockFilePane = lazy(() =>
  import("./DockFilePane").then((module) => ({
    default: module.DockFilePane,
  })),
);

const DIFF_INLINE_DEFAULT_WIDTH = "max(28rem, calc(50vw - 8rem))";
const SINGLE_PANEL_MIN_WIDTH = 26 * 16;

const allowAnySplitDirection = (_direction: SplitDirection) => true;

function shouldAcceptDockWidth({
  nextWidth,
  wrapper,
}: {
  nextWidth: number;
  wrapper: HTMLElement;
}) {
  const previousSidebarWidth = wrapper.style.getPropertyValue("--sidebar-width");
  return canComposerHandlePanelWidth({
    nextWidth,
    // The dock coexists only with the single-pane chat, but dock sidechat
    // panes mount their own composer forms — scope the probe so it always
    // measures the main composer instead of "first form in the document".
    paneScopeId: SINGLE_CHAT_PANE_SCOPE_ID,
    applyWidth: (width) => {
      wrapper.style.setProperty("--sidebar-width", `${width}px`);
    },
    resetWidth: () => {
      if (previousSidebarWidth.length > 0) {
        wrapper.style.setProperty("--sidebar-width", previousSidebarWidth);
      } else {
        wrapper.style.removeProperty("--sidebar-width");
      }
    },
  });
}

function RightDockPanePlaceholder(props: { kind: RightDockPaneKind }) {
  const { label } = getRightDockPaneMeta(props.kind);
  return <PanelStateMessage>{label} panel is coming soon.</PanelStateMessage>;
}

// Embedded dock chats (side chats) manage their own panels through the dock, so the
// nested ChatView always renders with a closed, inert panel state.
const DOCK_EMBEDDED_PANEL_STATE: SplitViewPanePanelState = {
  panel: null,
  diffTurnId: null,
  diffFilePath: null,
  hasOpenedPanel: false,
  lastOpenPanel: "browser",
};

export function SingleChatSurface(props: {
  threadId: ThreadId;
  search: DiffRouteSearch;
  projectId: ProjectId | null;
}) {
  const navigate = useNavigate();
  const createSplitView = useSplitViewStore((store) => store.createFromThread);
  const createSplitViewFromDrop = useSplitViewStore((store) => store.createFromDrop);
  const dockState = useRightDockStore(
    useMemo(() => selectRightDockState(props.threadId), [props.threadId]),
  );
  const openPane = useRightDockStore((store) => store.openPane);
  const toggleSingletonPane = useRightDockStore((store) => store.toggleSingletonPane);
  const closePane = useRightDockStore((store) => store.closePane);
  const setActivePane = useRightDockStore((store) => store.setActivePane);
  const setDockOpen = useRightDockStore((store) => store.setDockOpen);
  const updatePane = useRightDockStore((store) => store.updatePane);
  const activeProject = useStore(
    useMemo(() => createProjectSelector(props.projectId), [props.projectId]),
  );
  const threadWorkspaceMetadata = useStore(
    useMemo(() => createThreadWorkspaceMetadataSelector(props.threadId), [props.threadId]),
  );
  const draftThread = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[props.threadId] ?? null,
  );
  // A registered-but-unpromoted draft is the freeze case: landing a brand-new
  // chat commits the whole ChatView subtree synchronously. Defer that mount
  // behind the chat mount loader so the paint is never blocked. Opening an
  // existing thread keeps today's immediate mount (no draft -> no loader).
  const isBrandNewDraftThread = draftThread !== null;
  // File preview must follow the same runtime cwd as chat markdown, diffs, and git:
  // worktree-backed threads resolve links against their materialized worktree.
  const workspaceRoot = resolveFilePreviewWorkspaceRoot({
    projectCwd: activeProject?.cwd ?? null,
    threadEnvMode: threadWorkspaceMetadata.envMode ?? draftThread?.envMode ?? null,
    threadWorktreePath: threadWorkspaceMetadata.worktreePath ?? draftThread?.worktreePath ?? null,
    threadWorkingDirectory:
      threadWorkspaceMetadata.workingDirectory ?? draftThread?.workingDirectory ?? null,
  });
  const dockGitRepositoryQuery = useQuery(gitBranchesQueryOptions(workspaceRoot));
  const hasGitRepository = dockGitRepositoryQuery.data?.isRepo === true;
  const dockDiffTotals = useRepoDiffTotals({
    gitCwd: workspaceRoot,
    isGitRepo: hasGitRepository,
  });
  const hasDeviceSupport = useDeviceSupport();
  const dockLauncherItems = resolveRightDockLauncherItems({
    hasWorkspace: workspaceRoot !== null,
    hasGitRepository,
    hasReview: dockDiffTotals.fileCount > 0,
    hasDeviceSupport,
  });
  const availableDockPaneKinds = dockLauncherItems.map(({ kind }) => kind);
  const projects = useStore((store) => store.projects);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const { settings: appSettings } = useAppSettings();
  const { handleNewThread } = useHandleNewThread();
  const queryClient = useQueryClient();
  const lastAppliedRoutePanelSearchKeyRef = useRef<string | null>(null);
  const [editorExpandedDirectories, setEditorExpandedDirectories] = useState<ReadonlySet<string>>(
    () => new Set(readEditorViewState(props.threadId)?.expandedDirectories ?? []),
  );
  const [editorCenterMode, setEditorCenterMode] = useState<"file" | "diff">(() =>
    props.search.editorFilePath
      ? "file"
      : (readEditorViewState(props.threadId)?.centerMode ?? "diff"),
  );
  // This route component is reused across thread navigations; reload the
  // persisted editor view state when the thread changes.
  const editorViewStateThreadIdRef = useRef(props.threadId);
  useEffect(() => {
    if (editorViewStateThreadIdRef.current === props.threadId) {
      return;
    }
    editorViewStateThreadIdRef.current = props.threadId;
    const persisted = readEditorViewState(props.threadId);
    // Re-seed editor view state from storage asynchronously so the reset is not a
    // synchronous setState in the effect body; both setters are user-mutable
    // elsewhere, so deriving here would mean stamping the thread key in every one.
    const timer = window.setTimeout(() => {
      setEditorExpandedDirectories(new Set(persisted?.expandedDirectories ?? []));
      setEditorCenterMode(props.search.editorFilePath ? "file" : (persisted?.centerMode ?? "diff"));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [props.search.editorFilePath, props.threadId]);
  const editorViewActive = props.search.view === "editor";
  useEffect(() => {
    if (!editorViewActive) {
      return;
    }
    storeEditorViewState(props.threadId, {
      expandedDirectories: [...editorExpandedDirectories],
      centerMode: editorCenterMode,
    });
  }, [editorCenterMode, editorExpandedDirectories, editorViewActive, props.threadId]);
  const [editorDiffPanelState, setEditorDiffPanelState] = useState<
    Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">
  >({
    panel: "diff",
    diffTurnId: props.search.diffTurnId ?? null,
    diffFilePath: props.search.diffFilePath ?? null,
  });
  const [editorDiffFiles, setEditorDiffFiles] = useState<ReadonlyArray<FileDiffMetadata>>([]);
  const [editorDiffFilesLoading, setEditorDiffFilesLoading] = useState(false);
  const [editorDiffOptionsControl, setEditorDiffOptionsControl] = useState<ReactNode | null>(null);
  const [searchPaletteOpen, setSearchPaletteOpen] = useState(false);
  const [searchPaletteMode, setSearchPaletteMode] = useState<WorkspaceSearchPaletteMode>("files");

  const activePane = resolveActivePane(dockState);
  const {
    activePaneRuntimeMode,
    requestActivePaneLive: requestActiveDockPaneLive,
    requestImmediateHydration: requestImmediateDockHydration,
  } = useDockPaneRuntimeActivation({
    threadId: props.threadId,
    activePane,
  });

  // Bridge the dock's active browser/diff pane back into the panelState shape the
  // chat shell still consumes (diff badge, toggle pressed state, transcript gating).
  const chatPanelState: SplitViewPanePanelState = {
    panel:
      activePane && (activePane.kind === "browser" || activePane.kind === "diff")
        ? activePane.kind
        : null,
    diffTurnId: activePane?.kind === "diff" ? activePane.diffTurnId : null,
    diffFilePath: activePane?.kind === "diff" ? activePane.diffFilePath : null,
    hasOpenedPanel: dockState.panes.length > 0,
    lastOpenPanel: "browser",
  };

  const handleToggleDiff = () => {
    requestImmediateDockHydration("diff");
    toggleSingletonPane(props.threadId, { kind: "diff" });
  };
  const handleToggleBrowser = () => {
    requestImmediateDockHydration("browser");
    toggleSingletonPane(props.threadId, { kind: "browser" });
  };
  const handleToggleDevice = () => {
    requestImmediateDockHydration("device");
    toggleSingletonPane(props.threadId, { kind: "device" });
  };
  const handleToggleRightDock = () => {
    setDockOpen(props.threadId, !dockState.open);
  };
  const handleOpenBrowserUrl = () => {
    requestImmediateDockHydration("browser");
    openPane(props.threadId, { kind: "browser" });
  };
  const handleOpenTurnDiff = (turnId: TurnId, filePath?: string) => {
    requestImmediateDockHydration("diff");
    openPane(props.threadId, {
      kind: "diff",
      diffTurnId: turnId,
      diffFilePath: filePath ?? null,
    });
  };

  // Stable identities: these feed memoized result rows in the search palette,
  // so recreating them per render would defeat the rows' React.memo bailout.
  const handleOpenWorkspaceSearchFile = useCallback(
    (relativePath: string) => {
      requestImmediateDockHydration("file");
      openPane(props.threadId, { kind: "file", filePath: relativePath });
    },
    [requestImmediateDockHydration, openPane, props.threadId],
  );

  const handleOpenWorkspaceSearchDirectory = useCallback(
    (relativePath: string) => {
      requestImmediateDockHydration("explorer");
      openPane(props.threadId, { kind: "explorer" });
      requestExplorerReveal(props.threadId, relativePath);
    },
    [requestImmediateDockHydration, openPane, props.threadId],
  );

  // Ctrl/Cmd+P opens the file-name search palette; Ctrl/Cmd+Shift+F opens the
  // snippet (content) search. Registered with capture so it wins over page-level
  // defaults (print, browser find) while the chat surface is mounted.
  useEffect(() => {
    // Editor view returns before rendering the palette, so leave its shortcuts
    // available to the editor instead of swallowing them invisibly.
    if (editorViewActive) return;

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.repeat || event.altKey) return;
      const isPrimaryModifier = event.ctrlKey || event.metaKey;
      if (!isPrimaryModifier) return;
      const key = event.key.toLowerCase();
      if (key !== "p" && key !== "f") return;
      if (key === "f" && !event.shiftKey) return;
      if (key === "p" && event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      setSearchPaletteMode(key === "p" ? "files" : "snippets");
      setSearchPaletteOpen(true);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [editorViewActive]);

  const handleOpenEditorView = () => {
    void navigate({
      to: "/$threadId",
      params: { threadId: props.threadId },
      search: (previous) => ({
        ...stripDiffSearchParams(previous),
        view: "editor",
        ...(props.search.editorFilePath ? { editorFilePath: props.search.editorFilePath } : {}),
      }),
    });
  };

  const handleCloseEditorView = () => {
    void navigate({
      to: "/$threadId",
      params: { threadId: props.threadId },
      search: (previous) => stripEditorViewSearchParams(stripDiffSearchParams(previous)),
    });
  };

  const handleSelectEditorFile = (filePath: string) => {
    setEditorCenterMode("file");
    void navigate({
      to: "/$threadId",
      params: { threadId: props.threadId },
      replace: true,
      search: (previous) => ({
        ...stripDiffSearchParams(previous),
        view: "editor",
        editorFilePath: filePath,
      }),
    });
  };

  const handleToggleEditorDirectory = (directoryPath: string) => {
    setEditorExpandedDirectories((previous) => {
      const next = new Set(previous);
      if (next.has(directoryPath)) {
        next.delete(directoryPath);
      } else {
        next.add(directoryPath);
      }
      return next;
    });
  };

  const handleEditorToggleDiff = () => {
    setEditorCenterMode((current) =>
      current === "diff" && props.search.editorFilePath ? "file" : "diff",
    );
  };

  const handleEditorOpenTurnDiff = (turnId: TurnId, filePath?: string) => {
    setEditorCenterMode("diff");
    setEditorDiffPanelState({
      panel: "diff",
      diffTurnId: turnId,
      diffFilePath: filePath ?? null,
    });
  };

  const handleUpdateEditorDiffPanelState = (
    patch: Partial<Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">>,
  ) => {
    setEditorDiffPanelState((previous) => ({
      panel: "diff",
      diffTurnId: "diffTurnId" in patch ? (patch.diffTurnId ?? null) : previous.diffTurnId,
      diffFilePath: "diffFilePath" in patch ? (patch.diffFilePath ?? null) : previous.diffFilePath,
    }));
  };
  const handleEditorDiffFilesChange = (
    files: ReadonlyArray<FileDiffMetadata>,
    isLoading: boolean,
  ) => {
    setEditorDiffFiles(files);
    setEditorDiffFilesLoading(isLoading);
  };
  const handleSelectEditorDiffFile = (filePath: string) => {
    setEditorCenterMode("diff");
    setEditorDiffPanelState((previous) => ({
      ...previous,
      panel: "diff",
      diffFilePath: filePath,
    }));
  };
  const handleEditorDiffOptionsChange = (control: ReactNode | null) => {
    setEditorDiffOptionsControl(control);
  };
  const handleReferenceInChat = (reference: ChatFileReference) => {
    appendChatFileReference(props.threadId, reference);
  };
  const handleAskWhyInChat = (reference: ChatFileReference) => {
    appendComposerPromptText(props.threadId, buildWhyLinesPrompt(reference));
  };
  const handleCommentInChat = (comment: FileCommentSelection) => {
    addChatFileComment(props.threadId, comment);
  };

  // Hover warm-up shared by both surfaces' file openers: file contents land in
  // the React Query cache and the matching Shiki highlighter loads, so the
  // preview paints instantly on click.
  const prefetchOpenerFile = (path: string) => {
    if (!workspaceRoot) {
      return;
    }
    const relativePath = resolveWorkspaceFileOpenTarget(path, workspaceRoot);
    if (relativePath) {
      prefetchWorkspaceFile(queryClient, workspaceRoot, relativePath);
    }
  };
  // Chat surface: file references open in the right-dock file pane. References
  // outside the workspace report unhandled so chips fall back to the external
  // editor.
  const dockFileOpener: WorkspaceFileOpener = {
    openFile: (path) => {
      // In-workspace references map to relative paths for the file-read RPC;
      // binary previews in a session's scratch workspace (outside the chat
      // workspace) open by absolute path through the local-image route.
      const targetPath = resolveDockFileOpenTarget(path, workspaceRoot);
      if (!targetPath) {
        return false;
      }
      requestImmediateDockHydration("file");
      openPane(props.threadId, { kind: "file", filePath: targetPath });
      return true;
    },
    prefetchFile: prefetchOpenerFile,
  };
  // Editor surface: the center file pane is already the file viewer, so file
  // references select into it instead of opening a dock pane.
  const editorFileOpener: WorkspaceFileOpener = {
    openFile: (path) => {
      if (!workspaceRoot) {
        return false;
      }
      const relativePath = resolveWorkspaceFileOpenTarget(path, workspaceRoot);
      if (!relativePath) {
        return false;
      }
      handleSelectEditorFile(relativePath);
      return true;
    },
    prefetchFile: prefetchOpenerFile,
  };

  const handleSplitSurface = () => {
    if (!props.projectId) return;
    const splitViewId = createSplitView({
      sourceThreadId: props.threadId,
      ownerProjectId: props.projectId,
    });
    startTransition(() => {
      void navigate({
        to: "/$threadId",
        params: { threadId: props.threadId },
        replace: true,
        search: () => ({ splitViewId }),
      });
    });
  };

  const handleDropThread = (payload: {
    threadId: ThreadId;
    direction: SplitDirection;
    side: SplitDropSide;
  }) => {
    if (!props.projectId) return;
    if (payload.threadId === props.threadId) return;
    const splitViewId = createSplitViewFromDrop({
      sourceThreadId: props.threadId,
      ownerProjectId: props.projectId,
      droppedThreadId: payload.threadId,
      direction: payload.direction,
      side: payload.side,
    });
    startTransition(() => {
      void navigate({
        to: "/$threadId",
        params: { threadId: payload.threadId },
        replace: true,
        search: () => ({ splitViewId }),
      });
    });
  };

  useEffect(() => {
    const { nextAppliedSearchKey, panelPatch } = resolveRoutePanelBootstrap({
      scopeId: props.threadId,
      search: props.search,
      lastAppliedSearchKey: lastAppliedRoutePanelSearchKeyRef.current,
    });

    lastAppliedRoutePanelSearchKeyRef.current = nextAppliedSearchKey;
    if (!panelPatch) {
      return;
    }

    if (panelPatch.panel === "browser") {
      requestImmediateDockHydration("browser");
      openPane(props.threadId, { kind: "browser" });
    } else if (panelPatch.panel === "diff") {
      requestImmediateDockHydration("diff");
      openPane(props.threadId, {
        kind: "diff",
        diffTurnId: panelPatch.diffTurnId ?? null,
        diffFilePath: panelPatch.diffFilePath ?? null,
      });
    } else {
      setDockOpen(props.threadId, false);
    }
    void navigate({
      to: "/$threadId",
      params: { threadId: props.threadId },
      replace: true,
      search: (previous) => stripDiffSearchParams(previous),
    });
  }, [
    navigate,
    openPane,
    props.search,
    props.threadId,
    requestImmediateDockHydration,
    setDockOpen,
  ]);

  useBrowserPanelDesktopBridge({
    onToggle: () => {
      requestImmediateDockHydration("browser");
      toggleSingletonPane(props.threadId, { kind: "browser" });
    },
    onOpen: (requestedThreadId) => {
      routeSingleBrowserPanelOpenRequest({
        currentThreadId: props.threadId,
        requestedThreadId,
        requestImmediateBrowserHydration: () => requestImmediateDockHydration("browser"),
        openBrowserPane: (threadId) => openPane(threadId, { kind: "browser" }),
      });
    },
  });

  useDeviceEventBridge({
    onOpenPaneRequested: hasDeviceSupport
      ? (event) => {
          routeSingleDevicePaneOpenRequest({
            currentThreadId: props.threadId,
            requestedThreadId: event.threadId,
            requestImmediateDeviceHydration: () => requestImmediateDockHydration("device"),
            openDevicePane: (threadId) => openPane(threadId, { kind: "device" }),
            navigateToThread: (threadId) => {
              void navigate({
                to: "/$threadId",
                params: { threadId },
                replace: true,
              });
            },
          });
        }
      : null,
  });

  const excludedThreadIds = new Set<ThreadId>([props.threadId]);

  // Sidechat tab labels only need thread titles, so subscribe to the coarse
  // sidebar-summary selector (turn-level changes) instead of the full thread
  // selector, which re-emits on every streaming token of any thread and would
  // otherwise re-render the entire chat surface + right dock + active pane.
  const threadSummaries = useStore(useMemo(() => createSidebarThreadSummariesSelector(), []));
  const sidechatPaneRetentionVersion = useSyncExternalStore(
    subscribeSidechatPaneRetention,
    getSidechatPaneRetentionVersion,
    getSidechatPaneRetentionVersion,
  );
  useEffect(() => {
    if (!threadsHydrated) {
      return;
    }
    const existingThreadIds = new Set(threadSummaries.map((thread) => thread.id));
    for (const pane of dockState.panes) {
      if (pane.kind === "sidechat" && pane.threadId && existingThreadIds.has(pane.threadId)) {
        clearSidechatPaneRetention(pane.threadId);
      }
    }
    const missingPaneIds = findMissingSidechatPaneIds(dockState, existingThreadIds);
    if (missingPaneIds.length === 0) {
      return;
    }

    const timerIds: number[] = [];
    for (const paneId of missingPaneIds) {
      const pane = dockState.panes.find((candidate) => candidate.id === paneId);
      const remainingGraceMs = pane?.threadId ? sidechatPaneRetentionRemainingMs(pane.threadId) : 0;
      if (remainingGraceMs === null) {
        continue;
      }
      if (remainingGraceMs <= 0) {
        if (pane?.threadId) {
          clearSidechatPaneRetention(pane.threadId);
        }
        closePane(props.threadId, paneId);
        continue;
      }
      timerIds.push(
        window.setTimeout(() => {
          if (pane?.threadId) {
            clearSidechatPaneRetention(pane.threadId);
          }
          closePane(props.threadId, paneId);
        }, remainingGraceMs),
      );
    }
    return () => {
      for (const timerId of timerIds) {
        window.clearTimeout(timerId);
      }
    };
  }, [
    closePane,
    dockState,
    props.threadId,
    sidechatPaneRetentionVersion,
    threadSummaries,
    threadsHydrated,
  ]);
  const editorProjectOptions = projects.flatMap((project) =>
    project.kind === "project" ? [{ id: project.id, name: project.name }] : [],
  );
  const openEditorProject = async (projectId: ProjectId) => {
    const latestThread = sortThreadsForSidebar(
      threadSummaries.filter((thread) => thread.projectId === projectId),
      appSettings.sidebarThreadSortOrder,
    )[0];

    if (latestThread) {
      await navigate({
        to: "/$threadId",
        params: { threadId: latestThread.id },
        search: (previous) => ({
          ...stripEditorViewSearchParams(stripDiffSearchParams(previous)),
          view: "editor",
        }),
      });
      return;
    }

    await handleNewThread(
      projectId,
      {
        envMode: appSettings.defaultThreadEnvMode,
      },
      {
        search: (previous) => ({
          ...stripEditorViewSearchParams(stripDiffSearchParams(previous)),
          view: "editor",
        }),
      },
    );
  };
  const handleSelectEditorProject = (projectId: ProjectId) => {
    void openEditorProject(projectId).catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Unable to open project",
        description: error instanceof Error ? error.message : "The project could not be opened.",
      });
    });
  };
  const hasNamedFilePane = dockState.panes.some(
    (pane) => pane.kind === "file" && pane.filePath !== null,
  );
  const hasNumberedPullRequestPane = dockState.panes.some(
    (pane) => pane.kind === "pullRequest" && pane.pullRequestNumber !== null,
  );
  let paneLabelOverrides: Record<string, string | undefined> | undefined;
  if (hasNamedFilePane || hasNumberedPullRequestPane) {
    const overrides: Record<string, string | undefined> = {};
    for (const pane of dockState.panes) {
      if (pane.kind === "file" && pane.filePath) {
        overrides[pane.id] = basenameOfPath(pane.filePath);
      } else if (pane.kind === "pullRequest" && pane.pullRequestNumber !== null) {
        overrides[pane.id] = pullRequestPaneTabLabel(pane.pullRequestNumber);
      }
    }
    paneLabelOverrides = overrides;
  }

  // The pull request pane is a singleton, so at most one tab needs the live state glyph.
  const pullRequestPane = dockState.panes.find(
    (pane) => pane.kind === "pullRequest" && pullRequestDetailInputFromPane(pane) !== null,
  );
  const pullRequestPaneStateIcon = usePullRequestPaneStateIcon(
    pullRequestPane ? pullRequestDetailInputFromPane(pullRequestPane) : null,
  );
  const paneIconOverrides =
    pullRequestPane && pullRequestPaneStateIcon
      ? { [pullRequestPane.id]: pullRequestPaneStateIcon }
      : undefined;

  const handleAddDockPane = (kind: RightDockPaneKind) => {
    requestImmediateDockHydration(kind);
    if (kind === "sidechat") {
      // Sidechat spawns a thread; reuse the composer's /side flow (correct model
      // selection) published via the registry instead of opening an empty pane.
      void waitForSidechatCreator(props.threadId)
        .then((createSidechat) => {
          if (!createSidechat) {
            toastManager.add({
              type: "warning",
              title: "Side chat is unavailable",
              description: "Open a server-backed main thread before starting a Side chat.",
            });
            return;
          }
          return createSidechat();
        })
        .catch((error) => {
          toastManager.add({
            type: "error",
            title: "Could not start Side chat",
            description:
              error instanceof Error
                ? error.message
                : "An error occurred while creating Side chat.",
          });
        });
      return;
    }
    openPane(props.threadId, { kind });
  };

  const renderDockPane = (
    pane: RightDockPane,
    context: { runtimeMode: DockPaneRuntimeMode; isActive: boolean; isVisible: boolean },
  ): ReactNode => {
    switch (pane.kind) {
      case "browser":
        return (
          <Suspense fallback={<PanelStateMessage>Loading browser...</PanelStateMessage>}>
            <LazyBrowserPanel
              mode="sidebar"
              threadId={props.threadId}
              onClosePanel={() => closePane(props.threadId, pane.id)}
              runtimeMode={context.runtimeMode}
              onRequestLive={requestActiveDockPaneLive}
            />
          </Suspense>
        );
      case "device":
        return (
          <Suspense fallback={<PanelStateMessage>Loading simulator...</PanelStateMessage>}>
            <LazyDevicePanel
              mode="sidebar"
              threadId={props.threadId}
              onClosePanel={() => closePane(props.threadId, pane.id)}
              runtimeMode={context.runtimeMode}
              isVisible={context.isVisible}
              onRequestLive={requestActiveDockPaneLive}
            />
          </Suspense>
        );
      case "pullRequest":
        return (
          <Suspense fallback={<PanelStateMessage>Loading pull request...</PanelStateMessage>}>
            <PullRequestDockPane
              pane={pane}
              pollingEnabled={context.isVisible}
              onClose={() => closePane(props.threadId, pane.id)}
              onSelectPullRequest={(number) =>
                updatePane(props.threadId, pane.id, {
                  pullRequestNumber: number,
                  pullRequestInitialTab: "summary",
                })
              }
            />
          </Suspense>
        );
      case "diff":
        return (
          <LazyDiffPanel
            mode="sidebar"
            threadId={props.threadId}
            panelState={{
              panel: "diff",
              diffTurnId: pane.diffTurnId,
              diffFilePath: pane.diffFilePath,
            }}
            onUpdatePanelState={(patch) =>
              updatePane(props.threadId, pane.id, {
                diffTurnId: patch.diffTurnId ?? null,
                diffFilePath: patch.diffFilePath ?? null,
              })
            }
            onClosePanel={() => closePane(props.threadId, pane.id)}
            liveRefreshEnabled={context.isActive && dockState.open}
            queriesEnabled={context.isActive && dockState.open}
          />
        );
      case "terminal":
        if (context.runtimeMode === "preview") {
          return <PanelStateMessage>Terminal is sleeping. Restoring shortly.</PanelStateMessage>;
        }
        // Kept mounted across tab switches; visibility toggles the xterm runtime
        // instead of detaching/reattaching it (avoids the open-lag + fit flicker).
        // Also sleep it while the dock is collapsed: a closed dock keeps the pane
        // mounted (offcanvas is CSS-only), so without this the off-screen terminal
        // would keep WebGL + resize observers alive for nothing.
        return (
          <Suspense fallback={<PanelStateMessage>Loading terminal...</PanelStateMessage>}>
            <DockTerminalPane
              hostThreadId={props.threadId}
              projectId={props.projectId}
              isActive={context.isActive && dockState.open}
              onClosePanel={() => closePane(props.threadId, pane.id)}
            />
          </Suspense>
        );
      case "git":
        return (
          <Suspense fallback={<PanelStateMessage>Loading Git...</PanelStateMessage>}>
            <GitPanel
              hostThreadId={props.threadId}
              projectId={props.projectId}
              onClose={() => closePane(props.threadId, pane.id)}
            />
          </Suspense>
        );
      case "explorer":
        return (
          <Suspense fallback={<PanelStateMessage>Loading explorer...</PanelStateMessage>}>
            <DockExplorerPane
              threadId={props.threadId}
              workspaceRoot={workspaceRoot}
              onReferenceInChat={handleReferenceInChat}
              onAskWhyInChat={handleAskWhyInChat}
              onCommentInChat={handleCommentInChat}
            />
          </Suspense>
        );
      case "file":
        return (
          <Suspense fallback={<PanelStateMessage>Loading file...</PanelStateMessage>}>
            <DockFilePane
              workspaceRoot={workspaceRoot}
              filePath={pane.filePath}
              onReferenceInChat={handleReferenceInChat}
              onAskWhyInChat={handleAskWhyInChat}
              onCommentInChat={handleCommentInChat}
            />
          </Suspense>
        );
      case "sidechat":
        if (!pane.threadId) {
          return <RightDockPanePlaceholder kind="sidechat" />;
        }
        if (!threadSummaries.some((thread) => thread.id === pane.threadId)) {
          return <PanelStateMessage>Loading side chat...</PanelStateMessage>;
        }
        if (context.runtimeMode === "preview") {
          return null;
        }
        return (
          <DeferredChatView
            threadId={pane.threadId}
            paneScopeId={dockSidechatPaneScopeId(pane.id)}
            deferMount={false}
            surfaceMode="split"
            isFocusedPane={false}
            panelState={DOCK_EMBEDDED_PANEL_STATE}
            onToggleDiff={noopChatSurfaceAction}
            onToggleBrowser={noopChatSurfaceAction}
            onOpenBrowserUrl={noopChatSurfaceAction}
            onOpenTurnDiff={noopChatSurfaceAction}
            onCloseThreadPane={() => closePane(props.threadId, pane.id)}
          />
        );
      default:
        return <RightDockPanePlaceholder kind={pane.kind} />;
    }
  };

  const handleSelectDockPane = (paneId: string) => {
    requestImmediateDockHydration(dockState.panes.find((pane) => pane.id === paneId)?.kind);
    setActivePane(props.threadId, paneId);
  };

  // The editor file path arrives via the URL, so an attacker-crafted link can
  // carry traversal segments ("../../etc"). Treat unsafe values as no selection
  // so neither the ancestor prefetch nor the preview ever queries them.
  const rawEditorFilePath = props.search.editorFilePath ?? null;
  const selectedEditorFilePath =
    rawEditorFilePath !== null && isWorkspaceRelativePathSafe(rawEditorFilePath)
      ? rawEditorFilePath
      : null;
  useEffect(() => {
    if (!selectedEditorFilePath) {
      return;
    }

    const parentPaths = collectParentDirectoryPaths(selectedEditorFilePath);
    if (parentPaths.length === 0) {
      return;
    }

    // Prefetch every ancestor listing in parallel: the explorer renders one
    // directory level at a time, so without this each depth waits for the
    // previous level's response (a per-level request waterfall).
    if (workspaceRoot) {
      for (const parentPath of parentPaths) {
        void queryClient.prefetchQuery(
          projectListDirectoriesQueryOptions({
            cwd: workspaceRoot,
            relativePath: parentPath,
            includeFiles: true,
          }),
        );
      }
    }

    // Auto-expand the ancestors a tick later so this is not a synchronous setState
    // in the effect body; the functional update still merges with any user toggles.
    const expandTimer = window.setTimeout(() => {
      setEditorExpandedDirectories((previous) => {
        let changed = false;
        const next = new Set(previous);
        for (const parentPath of parentPaths) {
          if (!next.has(parentPath)) {
            next.add(parentPath);
            changed = true;
          }
        }
        return changed ? next : previous;
      });
    }, 0);
    return () => window.clearTimeout(expandTimer);
  }, [workspaceRoot, queryClient, selectedEditorFilePath]);

  const editorChatPanelState: SplitViewPanePanelState = {
    panel: editorCenterMode === "diff" ? "diff" : null,
    diffTurnId: editorDiffPanelState.diffTurnId,
    diffFilePath: editorDiffPanelState.diffFilePath,
    hasOpenedPanel: true,
    lastOpenPanel: "browser",
  };

  if (props.search.view === "editor") {
    return (
      <WorkspaceFileOpenerContext.Provider value={editorFileOpener}>
        <div
          className={cn(CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME, CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME)}
        >
          <Suspense fallback={<ChatMountLoader />}>
            <EditorWorkspaceView
              workspaceRoot={workspaceRoot}
              projectName={activeProject?.name ?? null}
              currentProjectId={activeProject?.id ?? null}
              projectOptions={editorProjectOptions}
              selectedFilePath={selectedEditorFilePath}
              expandedDirectories={editorExpandedDirectories}
              centerMode={editorCenterMode}
              diffFiles={editorDiffFiles}
              diffFilesLoading={editorDiffFilesLoading}
              selectedDiffFilePath={editorDiffPanelState.diffFilePath ?? null}
              diffOptionsControl={editorDiffOptionsControl}
              onSelectDiffFile={handleSelectEditorDiffFile}
              onSelectFile={handleSelectEditorFile}
              onToggleDirectory={handleToggleEditorDirectory}
              onCenterModeChange={setEditorCenterMode}
              onExitEditorView={handleCloseEditorView}
              onReferenceInChat={handleReferenceInChat}
              onAskWhyInChat={handleAskWhyInChat}
              onCommentInChat={handleCommentInChat}
              onSelectProject={handleSelectEditorProject}
              diffPanel={
                <LazyDiffPanel
                  mode="sidebar"
                  threadId={props.threadId}
                  panelState={editorDiffPanelState}
                  onUpdatePanelState={handleUpdateEditorDiffPanelState}
                  liveRefreshEnabled={editorCenterMode === "diff"}
                  // Keep diff data warm while browsing files so switching to the
                  // diff tab renders instantly instead of cold-fetching.
                  queriesEnabled
                  hideHeader
                  onRenderableFilesChange={handleEditorDiffFilesChange}
                  onEditorDiffOptionsChange={handleEditorDiffOptionsChange}
                />
              }
              chatPanel={
                <SidebarInset
                  className="min-h-0 min-w-0 overflow-hidden overscroll-y-none text-foreground"
                  surfaceClassName={CHAT_BACKGROUND_CLASS_NAME}
                >
                  <DeferredChatView
                    threadId={props.threadId}
                    paneScopeId={EDITOR_CHAT_PANE_SCOPE_ID}
                    deferMount={false}
                    surfaceMode="split"
                    presentationMode="editor"
                    isFocusedPane
                    panelState={editorChatPanelState}
                    onToggleDiff={handleEditorToggleDiff}
                    onToggleBrowser={noopChatSurfaceAction}
                    onOpenBrowserUrl={noopChatSurfaceAction}
                    onOpenTurnDiff={handleEditorOpenTurnDiff}
                  />
                </SidebarInset>
              }
            />
          </Suspense>
        </div>
      </WorkspaceFileOpenerContext.Provider>
    );
  }

  return (
    <WorkspaceFileOpenerContext.Provider value={dockFileOpener}>
      <div
        className={cn(CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME, CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME)}
      >
        <ChatPaneDropOverlay
          canDropInDirection={allowAnySplitDirection}
          excludedThreadIds={excludedThreadIds}
          onDrop={handleDropThread}
          className="flex h-full min-h-0 min-w-0 flex-1"
        >
          <RouteInsetSurface surfaceClassName={CHAT_BACKGROUND_CLASS_NAME}>
            <DeferredChatView
              threadId={props.threadId}
              paneScopeId={SINGLE_CHAT_PANE_SCOPE_ID}
              deferMount={isBrandNewDraftThread}
              surfaceMode="single"
              isFocusedPane
              panelState={chatPanelState}
              onToggleDiff={handleToggleDiff}
              onToggleRightDock={handleToggleRightDock}
              onToggleBrowser={handleToggleBrowser}
              {...(hasDeviceSupport ? { onToggleDevice: handleToggleDevice } : {})}
              onOpenBrowserUrl={handleOpenBrowserUrl}
              onOpenTurnDiff={handleOpenTurnDiff}
              onSplitSurface={handleSplitSurface}
              viewModeAction={{
                label: "Editor view",
                active: false,
                onClick: handleOpenEditorView,
              }}
            />
          </RouteInsetSurface>
        </ChatPaneDropOverlay>
        <RightDock
          state={dockState}
          minWidth={SINGLE_PANEL_MIN_WIDTH}
          defaultWidth={DIFF_INLINE_DEFAULT_WIDTH}
          shouldAcceptWidth={shouldAcceptDockWidth}
          addMenuKinds={availableDockPaneKinds}
          launcherItems={dockLauncherItems}
          motionKey={props.threadId}
          activePaneRuntimeMode={activePaneRuntimeMode}
          {...(paneLabelOverrides ? { paneLabelOverrides } : {})}
          {...(paneIconOverrides ? { paneIconOverrides } : {})}
          onSelectPane={handleSelectDockPane}
          onClosePane={(paneId) => closePane(props.threadId, paneId)}
          onCollapse={() => setDockOpen(props.threadId, false)}
          onOpenChange={(open) => setDockOpen(props.threadId, open)}
          onAddPane={handleAddDockPane}
          renderPane={renderDockPane}
        />
        <WorkspaceSearchPalette
          open={searchPaletteOpen}
          mode={searchPaletteMode}
          onOpenChange={setSearchPaletteOpen}
          cwd={workspaceRoot}
          onOpenFile={handleOpenWorkspaceSearchFile}
          onOpenDirectory={handleOpenWorkspaceSearchDirectory}
        />
      </div>
    </WorkspaceFileOpenerContext.Provider>
  );
}

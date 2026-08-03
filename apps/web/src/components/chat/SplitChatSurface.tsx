import { type ProjectId, type ProviderKind, type ThreadId, type TurnId } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  startTransition,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Schema } from "effect";

import { ProviderIcon } from "../ProviderIcon";
import { ChatPaneDropOverlay } from "../chat-drop-overlay/ChatPaneDropOverlay";
import { PanelStateMessage } from "./PanelStateMessage";
import {
  ChatMountLoader,
  DeferredChatView,
  LazyBrowserPanel,
  LazyDiffPanel,
  noopChatSurfaceAction,
} from "./ChatThreadSurfacePrimitives";
import { useBrowserPanelDesktopBridge } from "../../hooks/useBrowserPanelDesktopBridge";
import { useDeviceEventBridge } from "../../hooks/useDeviceEventBridge";
import { useHandleNewChat } from "../../hooks/useHandleNewChat";
import type { ChatRightPanel } from "../../diffRouteSearch";
import { stripDiffSearchParams } from "../../diffRouteSearch";
import {
  canComposerHandlePanelWidth,
  createPanelResizeOverlay,
  removePanelResizeOverlay,
} from "../../lib/panelResize";
import { splitViewPaneScopeId } from "../../lib/chatPaneScope";
import { resolveActiveSplitView } from "../../splitViewRoute";
import { canSubdividePane, collectLeaves, findLeafPaneById } from "../../splitView.logic";
import {
  resolveSplitViewFocusedThreadId,
  resolveSplitViewPaneIdForThread,
  resolveSplitViewThreadIds,
  selectSplitView,
  type LeafPane,
  type Pane,
  type PaneId,
  type SplitDirection,
  type SplitDropSide,
  type SplitView,
  type SplitViewId,
  type SplitViewPanePanelState,
  useSplitViewStore,
} from "../../splitViewStore";
import { useStore } from "../../store";
import { createAllThreadsSelector } from "../../storeSelectors";
import {
  normalizeSingleSearchFromPane,
  resolveSplitPaneCloseDecision,
  resolveSplitPaneMaximizeDecision,
  resolveThreadPickerTitle,
  resolveToggledChatPanelPatch,
} from "../../routes/-chatThreadRoute.logic";
import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { SidebarInset } from "../ui/sidebar";
import {
  CHAT_BACKGROUND_CLASS_NAME,
  CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME,
  CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME,
} from "./composerPickerStyles";
import { routeSplitBrowserPanelOpenRequest } from "./browserPanelOpenRequest";
import { cn } from "~/lib/utils";

const SPLIT_PANE_PANEL_DEFAULT_WIDTH_PX = 22 * 16;
const BROWSER_SPLIT_PANE_PANEL_DEFAULT_WIDTH_PX = 30 * 16;
const SPLIT_PANE_CHAT_MIN_WIDTH = 20 * 16;
const SINGLE_PANEL_MIN_WIDTH = 26 * 16;
const BROWSER_PANEL_MIN_WIDTH = 21 * 16;
const RIGHT_PANEL_SIDEBAR_WIDTH_STORAGE_KEY = "chat_right_panel_width";
const SPLIT_RATIO_MIN = 0.25;
const SPLIT_RATIO_MAX = 0.75;

function clampSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, value));
}

// Split panes cannot reuse the desktop Sidebar primitive because it positions the panel
// against the viewport. This embedded shell keeps browser/diff content anchored to the pane.
function SplitPaneEmbeddedPanel(props: {
  splitViewId: SplitViewId;
  paneId: PaneId;
  paneScopeId: string;
  panelOpen: boolean;
  panel: ChatRightPanel | null | undefined;
  threadId: ThreadId | null;
  onClosePanel: () => void;
  panelState: Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">;
  isFocused: boolean;
  onUpdatePanelState: (
    patch: Partial<Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">>,
  ) => void;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelWidthStorageKey =
    props.panel === "browser" ? "browser" : props.panel === "diff" ? "diff" : "panel";
  const storageKey = `${RIGHT_PANEL_SIDEBAR_WIDTH_STORAGE_KEY}:${props.splitViewId}:${props.paneId}:${panelWidthStorageKey}`;
  const defaultPanelWidth =
    props.panel === "browser"
      ? BROWSER_SPLIT_PANE_PANEL_DEFAULT_WIDTH_PX
      : SPLIT_PANE_PANEL_DEFAULT_WIDTH_PX;
  const minPanelWidth =
    props.panel === "browser" ? BROWSER_PANEL_MIN_WIDTH : SINGLE_PANEL_MIN_WIDTH;
  // Keyed by storageKey so switching panel/pane re-reads the persisted width by
  // deriving during render instead of resetting from an effect. Resizes stamp the
  // current key; a stale key re-reads localStorage for the new panel's value.
  const [panelWidthState, setPanelWidthState] = useState<{ key: string; value: number }>(() => ({
    key: storageKey,
    value: getLocalStorageItem(storageKey, Schema.Finite) ?? defaultPanelWidth,
  }));
  const panelWidth =
    panelWidthState.key === storageKey
      ? panelWidthState.value
      : (getLocalStorageItem(storageKey, Schema.Finite) ?? defaultPanelWidth);

  const shouldAcceptEmbeddedWidth = (nextWidth: number) => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return true;
    return canComposerHandlePanelWidth({
      nextWidth,
      paneScopeId: props.paneScopeId,
      applyWidth: (width) => {
        wrapper.style.width = `${width}px`;
      },
      resetWidth: () => {
        wrapper.style.width = `${panelWidth}px`;
      },
    });
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const wrapper = wrapperRef.current;
    const parent = wrapper?.parentElement;
    if (!wrapper || !parent) return;

    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = wrapper.getBoundingClientRect().width;
    const maxWidth = Math.max(minPanelWidth, parent.clientWidth - SPLIT_PANE_CHAT_MIN_WIDTH);
    const resizeOverlay = createPanelResizeOverlay();

    const onPointerMove = (moveEvent: PointerEvent) => {
      const delta = startX - moveEvent.clientX;
      const nextWidth = Math.max(minPanelWidth, Math.min(maxWidth, startWidth + delta));
      if (!shouldAcceptEmbeddedWidth(nextWidth)) {
        return;
      }
      setPanelWidthState({ key: storageKey, value: nextWidth });
      setLocalStorageItem(storageKey, nextWidth, Schema.Finite);
    };

    const onPointerUp = () => {
      removePanelResizeOverlay(resizeOverlay);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      resizeOverlay.removeEventListener("pointermove", onPointerMove);
      resizeOverlay.removeEventListener("pointerup", onPointerUp);
      resizeOverlay.removeEventListener("pointercancel", onPointerUp);
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    resizeOverlay.addEventListener("pointermove", onPointerMove);
    resizeOverlay.addEventListener("pointerup", onPointerUp);
    resizeOverlay.addEventListener("pointercancel", onPointerUp);
  };

  if (!props.panelOpen || !props.threadId) {
    return null;
  }

  return (
    <div
      ref={wrapperRef}
      data-native-browser-surface={props.panel === "browser" ? "true" : undefined}
      className="relative flex h-full min-h-0 min-w-0 flex-none border-l border-[var(--app-surface-divider)] bg-card text-foreground"
      style={
        {
          width: `${panelWidth}px`,
          maxWidth: `calc(100% - ${SPLIT_PANE_CHAT_MIN_WIDTH}px)`,
          minWidth: minPanelWidth,
        } as CSSProperties
      }
    >
      <div
        className="absolute inset-y-0 left-0 z-20 w-2 -translate-x-1/2 cursor-col-resize bg-transparent before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-[var(--app-surface-divider)]"
        onPointerDown={startResize}
      />
      {props.panel === "browser" ? (
        <Suspense fallback={<PanelStateMessage>Loading browser...</PanelStateMessage>}>
          <LazyBrowserPanel
            mode="sidebar"
            threadId={props.threadId}
            onClosePanel={props.onClosePanel}
          />
        </Suspense>
      ) : (
        <LazyDiffPanel
          mode="sidebar"
          threadId={props.threadId}
          onClosePanel={props.onClosePanel}
          panelState={props.panelState}
          liveRefreshEnabled={props.isFocused}
          onUpdatePanelState={props.onUpdatePanelState}
        />
      )}
    </div>
  );
}

function SplitPaneEmptyState(props: {
  isFocused: boolean;
  onFocus: () => void;
  threads: readonly {
    id: ThreadId;
    title: string | null;
    projectId: ProjectId;
    modelSelection: { provider: ProviderKind };
  }[];
  projects: readonly { id: ProjectId; name: string }[];
  excludedThreadIds: ReadonlySet<ThreadId>;
  onSelectThread: (threadId: ThreadId) => void;
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col items-center px-6 pt-16",
        CHAT_BACKGROUND_CLASS_NAME,
        props.isFocused ? "ring-2 ring-inset ring-primary/70" : "",
      )}
      onMouseDown={props.onFocus}
    >
      <div className="w-full max-w-sm space-y-4">
        <p className="text-center text-sm font-medium text-foreground/70">Select a chat</p>
        <div className="max-h-[60vh] space-y-1 overflow-y-auto">
          {props.threads.map((thread) => {
            const isUsed = props.excludedThreadIds.has(thread.id);
            const projectName =
              props.projects.find((p) => p.id === thread.projectId)?.name ?? "Project";
            return (
              <button
                key={thread.id}
                type="button"
                disabled={isUsed}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                  isUsed
                    ? "cursor-default border-border/30 opacity-35"
                    : "border-[color:var(--color-border-light)] hover:bg-[var(--sidebar-accent)]",
                )}
                onClick={() => {
                  if (!isUsed) props.onSelectThread(thread.id);
                }}
              >
                <ProviderIcon
                  provider={thread.modelSelection.provider}
                  className="size-4 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">
                    {resolveThreadPickerTitle(thread.title)}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{projectName}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SplitDivider(props: {
  splitNodeId: PaneId;
  direction: SplitDirection;
  onSetRatio: (nodeId: PaneId, ratio: number) => void;
}) {
  const { onSetRatio, splitNodeId, direction } = props;
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const parent = target.parentElement as HTMLElement | null;
    if (!parent) return;
    event.preventDefault();
    const rect = parent.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const computeRatio = (clientX: number, clientY: number) =>
      clampSplitRatio(
        direction === "horizontal"
          ? (clientX - rect.left) / rect.width
          : (clientY - rect.top) / rect.height,
      );

    let latestRatio = computeRatio(event.clientX, event.clientY);
    let frameId = 0;
    const previousParentPosition = parent.style.position;
    const previousBodyCursor = document.body.style.cursor;
    const previousBodyUserSelect = document.body.style.userSelect;
    if (getComputedStyle(parent).position === "static") {
      parent.style.position = "relative";
    }
    const resizeGuide = document.createElement("div");
    resizeGuide.setAttribute("data-split-resize-guide", "true");
    Object.assign(resizeGuide.style, {
      position: "absolute",
      zIndex: "50",
      pointerEvents: "none",
      borderRadius: "999px",
      background: "var(--info)",
      opacity: "0.75",
      boxShadow: "0 0 0 1px color-mix(in srgb, var(--info) 70%, transparent)",
    });
    if (direction === "horizontal") {
      Object.assign(resizeGuide.style, {
        top: "0",
        bottom: "0",
        left: "0",
        width: "2px",
      });
    } else {
      Object.assign(resizeGuide.style, {
        top: "0",
        left: "0",
        right: "0",
        height: "2px",
      });
    }
    parent.append(resizeGuide);

    const applyGuide = () => {
      frameId = 0;
      const offsetPx =
        direction === "horizontal" ? rect.width * latestRatio : rect.height * latestRatio;
      resizeGuide.style.transform =
        direction === "horizontal"
          ? `translateX(${Math.round(offsetPx)}px)`
          : `translateY(${Math.round(offsetPx)}px)`;
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      latestRatio = computeRatio(moveEvent.clientX, moveEvent.clientY);
      if (frameId === 0) {
        frameId = window.requestAnimationFrame(applyGuide);
      }
    };
    const onPointerUp = () => {
      if (frameId !== 0) {
        window.cancelAnimationFrame(frameId);
        applyGuide();
      }
      document.body.style.userSelect = previousBodyUserSelect;
      document.body.style.cursor = previousBodyCursor;
      parent.style.position = previousParentPosition;
      resizeGuide.remove();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      onSetRatio(splitNodeId, latestRatio);
    };

    document.body.style.userSelect = "none";
    document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";
    applyGuide();
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  };

  return (
    <div
      data-split-divider="true"
      data-split-node-id={splitNodeId}
      data-split-direction={direction}
      className={cn(
        "relative z-10 shrink-0 bg-border/70",
        direction === "horizontal"
          ? "w-px cursor-col-resize before:absolute before:inset-y-0 before:-left-1 before:w-2 before:bg-transparent"
          : "h-px cursor-row-resize before:absolute before:inset-x-0 before:-top-1 before:h-2 before:bg-transparent",
      )}
      onPointerDown={handlePointerDown}
    />
  );
}

function PaneRenderer(props: {
  pane: Pane;
  splitView: SplitView;
  renderLeaf: (input: { leaf: LeafPane }) => ReactNode;
  onSetRatio: (nodeId: PaneId, ratio: number) => void;
}) {
  if (props.pane.kind === "leaf") {
    return <>{props.renderLeaf({ leaf: props.pane })}</>;
  }
  const node = props.pane;
  const isRow = node.direction === "horizontal";
  const firstBasis = `${node.ratio * 100}%`;
  return (
    <div
      data-split-container="true"
      data-split-direction={node.direction}
      className={cn("flex min-h-0 min-w-0 flex-1 overflow-hidden", isRow ? "flex-row" : "flex-col")}
    >
      <div
        className="flex min-h-0 min-w-0 overflow-hidden"
        style={{ flexBasis: firstBasis, flexGrow: 0, flexShrink: 1 }}
      >
        <PaneRenderer
          pane={node.first}
          splitView={props.splitView}
          renderLeaf={props.renderLeaf}
          onSetRatio={props.onSetRatio}
        />
      </div>
      <SplitDivider
        splitNodeId={node.id}
        direction={node.direction}
        onSetRatio={props.onSetRatio}
      />
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <PaneRenderer
          pane={node.second}
          splitView={props.splitView}
          renderLeaf={props.renderLeaf}
          onSetRatio={props.onSetRatio}
        />
      </div>
    </div>
  );
}

function SplitPaneSurface(props: {
  splitView: SplitView;
  paneId: PaneId;
  threadId: ThreadId | null;
  panelState: SplitViewPanePanelState;
  isFocused: boolean;
  deferChatMount: boolean;
  canDropInDirection: (direction: SplitDirection) => boolean;
  excludedThreadIds: ReadonlySet<ThreadId>;
  threads: readonly {
    id: ThreadId;
    title: string | null;
    projectId: ProjectId;
    modelSelection: { provider: ProviderKind };
  }[];
  projects: readonly { id: ProjectId; name: string }[];
  onFocus: () => void;
  onToggleDiff: () => void;
  onToggleBrowser: () => void;
  onOpenBrowserUrl: (url: string) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onClosePanel: () => void;
  onUpdatePanelState: (
    patch: Partial<Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">>,
  ) => void;
  onMaximize: () => void;
  onCloseThreadPane: () => void;
  onChooseThread: () => void;
  onSelectThread: (threadId: ThreadId) => void;
  onChatMounted: () => void;
  onDropThread: (payload: {
    droppedThreadId: ThreadId;
    direction: SplitDirection;
    side: SplitDropSide;
  }) => void;
}) {
  const paneScopeId = splitViewPaneScopeId(props.splitView.id, props.paneId);
  const panelOpen = props.panelState.panel !== null;
  const shouldRenderPanelContent = panelOpen || props.panelState.hasOpenedPanel;

  const onDropThread = props.onDropThread;
  const handleDrop = (payload: {
    threadId: ThreadId;
    direction: SplitDirection;
    side: SplitDropSide;
  }) => {
    onDropThread({
      droppedThreadId: payload.threadId,
      direction: payload.direction,
      side: payload.side,
    });
  };

  return (
    <div
      className={cn(
        "group relative flex min-h-0 min-w-0 flex-1 [contain:layout_style_paint]",
        CHAT_BACKGROUND_CLASS_NAME,
      )}
    >
      <ChatPaneDropOverlay
        paneScopeId={paneScopeId}
        canDropInDirection={props.canDropInDirection}
        excludedThreadIds={props.excludedThreadIds}
        onDrop={handleDrop}
        className="flex min-h-0 min-w-0 flex-1"
      >
        <SidebarInset
          className={cn(
            "min-h-0 min-w-0 overflow-hidden overscroll-y-none text-foreground transition-shadow",
            props.isFocused ? "ring-2 ring-inset ring-primary/70" : "",
          )}
          surfaceClassName={CHAT_BACKGROUND_CLASS_NAME}
          onMouseDown={props.onFocus}
        >
          {props.threadId ? (
            <DeferredChatView
              threadId={props.threadId}
              paneScopeId={paneScopeId}
              deferMount={props.deferChatMount}
              surfaceMode="split"
              isFocusedPane={props.isFocused}
              panelState={props.panelState}
              onToggleDiff={props.onToggleDiff}
              onToggleBrowser={props.onToggleBrowser}
              onOpenBrowserUrl={props.onOpenBrowserUrl}
              onOpenTurnDiff={props.onOpenTurnDiff}
              onMaximize={props.onMaximize}
              onChangeThread={props.onChooseThread}
              onCloseThreadPane={props.onCloseThreadPane}
              onMounted={props.onChatMounted}
            />
          ) : (
            <SplitPaneEmptyState
              isFocused={props.isFocused}
              onFocus={props.onFocus}
              threads={props.threads}
              projects={props.projects}
              excludedThreadIds={props.excludedThreadIds}
              onSelectThread={props.onSelectThread}
            />
          )}
        </SidebarInset>
      </ChatPaneDropOverlay>
      <SplitPaneEmbeddedPanel
        splitViewId={props.splitView.id}
        paneId={props.paneId}
        paneScopeId={paneScopeId}
        panelOpen={panelOpen && shouldRenderPanelContent}
        panel={props.panelState.panel}
        threadId={props.threadId}
        onClosePanel={props.onClosePanel}
        panelState={props.panelState}
        isFocused={props.isFocused}
        onUpdatePanelState={props.onUpdatePanelState}
      />
      {props.isFocused ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-[0.9px] z-20 border border-[color-mix(in_srgb,var(--info)_45%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--info)_12%,transparent)] transition-opacity duration-150"
        />
      ) : null}
      {!props.isFocused ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-10 bg-foreground/[0.060] transition-opacity duration-150"
        />
      ) : null}
    </div>
  );
}

export function SplitChatSurface(props: { splitViewId: SplitViewId; routeThreadId: ThreadId }) {
  const navigate = useNavigate();
  const { handleNewChat } = useHandleNewChat();
  const selectAllThreads = createAllThreadsSelector();
  const threads = useStore(selectAllThreads);
  const projects = useStore((store) => store.projects);
  const splitView = useSplitViewStore(
    useMemo(() => selectSplitView(props.splitViewId), [props.splitViewId]),
  );
  const setFocusedPane = useSplitViewStore((store) => store.setFocusedPane);
  const setRatioForNode = useSplitViewStore((store) => store.setRatioForNode);
  const setPanePanelState = useSplitViewStore((store) => store.setPanePanelState);
  const replacePaneThread = useSplitViewStore((store) => store.replacePaneThread);
  const dropThreadOnPane = useSplitViewStore((store) => store.dropThreadOnPane);
  const removeSplitView = useSplitViewStore((store) => store.removeSplitView);
  const removePaneFromSplitView = useSplitViewStore((store) => store.removePaneFromSplitView);
  const [threadPickerPaneId, setThreadPickerPaneId] = useState<PaneId | null>(null);
  const { splitView: activeSplitView, routePaneId } = resolveActiveSplitView({
    splitView,
    routeThreadId: props.routeThreadId,
  });

  useEffect(() => {
    if (!activeSplitView) {
      void navigate({
        to: "/$threadId",
        params: { threadId: props.routeThreadId },
        replace: true,
        search: (previous) => ({
          ...stripDiffSearchParams(previous),
          splitViewId: undefined,
        }),
      });
      return;
    }

    // Single-leaf split views collapse back to the single chat surface.
    const leaves = collectLeaves(activeSplitView.root);
    if (leaves.length <= 1) {
      const onlyThreadId = leaves[0]?.threadId ?? null;
      removeSplitView(activeSplitView.id);
      const fallbackThreadId = onlyThreadId ?? props.routeThreadId;
      if (!fallbackThreadId) {
        void handleNewChat({ fresh: true });
        return;
      }
      void navigate({
        to: "/$threadId",
        params: { threadId: fallbackThreadId },
        replace: true,
        search: (previous) => ({
          ...stripDiffSearchParams(previous),
          splitViewId: undefined,
        }),
      });
      return;
    }

    // If the route threadId targets a non-focused pane, switch focus to that pane.
    const focusedLeaf = findLeafPaneById(activeSplitView.root, activeSplitView.focusedPaneId);
    if (
      routePaneId &&
      routePaneId !== activeSplitView.focusedPaneId &&
      focusedLeaf?.threadId !== null &&
      focusedLeaf?.threadId !== undefined
    ) {
      setFocusedPane(activeSplitView.id, routePaneId);
      return;
    }

    // Sync the route threadId with the focused leaf's thread.
    const normalizedFocusedThreadId = resolveSplitViewFocusedThreadId(activeSplitView);
    if (normalizedFocusedThreadId && props.routeThreadId !== normalizedFocusedThreadId) {
      void navigate({
        to: "/$threadId",
        params: { threadId: normalizedFocusedThreadId },
        replace: true,
        search: (previous) => ({
          ...stripDiffSearchParams(previous),
          splitViewId: activeSplitView.id,
        }),
      });
    }
  }, [
    activeSplitView,
    handleNewChat,
    navigate,
    props.routeThreadId,
    removeSplitView,
    routePaneId,
    setFocusedPane,
  ]);

  const setPaneFocus = (paneId: PaneId) => {
    if (!activeSplitView) return;
    const leaf = findLeafPaneById(activeSplitView.root, paneId);
    const nextThreadId = leaf?.threadId ?? resolveSplitViewFocusedThreadId(activeSplitView);
    setFocusedPane(activeSplitView.id, paneId);
    if (!nextThreadId || nextThreadId === props.routeThreadId) {
      return;
    }
    void navigate({
      to: "/$threadId",
      params: { threadId: nextThreadId },
      replace: true,
      search: (previous) => ({
        ...stripDiffSearchParams(previous),
        splitViewId: activeSplitView.id,
      }),
    });
  };

  const updatePanePanelState = (
    paneId: PaneId,
    patch: Partial<Pick<SplitViewPanePanelState, "panel" | "diffTurnId" | "diffFilePath">>,
  ) => {
    if (!activeSplitView) return;
    const leaf = findLeafPaneById(activeSplitView.root, paneId);
    if (!leaf) return;
    const nextPanel = patch.panel ?? leaf.panel.panel;
    setPanePanelState(activeSplitView.id, paneId, {
      ...patch,
      hasOpenedPanel: leaf.panel.hasOpenedPanel || nextPanel !== null,
      lastOpenPanel:
        patch.panel === "browser" || patch.panel === "diff"
          ? patch.panel
          : leaf.panel.lastOpenPanel,
    });
  };

  const togglePanePanel = (paneId: PaneId, panel: ChatRightPanel) => {
    if (!activeSplitView) return;
    const leaf = findLeafPaneById(activeSplitView.root, paneId);
    if (!leaf?.threadId) {
      return;
    }
    updatePanePanelState(paneId, resolveToggledChatPanelPatch(leaf.panel, panel));
  };

  useBrowserPanelDesktopBridge({
    onToggle: activeSplitView
      ? () => togglePanePanel(activeSplitView.focusedPaneId, "browser")
      : null,
    onOpen: activeSplitView
      ? (requestedThreadId) => {
          routeSplitBrowserPanelOpenRequest({
            splitView: activeSplitView,
            requestedThreadId,
            focusPane: (paneId) => setFocusedPane(activeSplitView.id, paneId),
            replacePaneThread: (paneId, threadId) =>
              replacePaneThread(activeSplitView.id, paneId, threadId),
            openBrowserPanel: (paneId) =>
              setPanePanelState(activeSplitView.id, paneId, {
                panel: "browser",
                diffTurnId: null,
                diffFilePath: null,
                hasOpenedPanel: true,
                lastOpenPanel: "browser",
              }),
            navigateToThread: (threadId) => {
              void navigate({
                to: "/$threadId",
                params: { threadId },
                replace: true,
                search: () => ({ splitViewId: activeSplitView.id }),
              });
            },
          });
        }
      : null,
  });

  // Split view has no device panel yet: ChatRightPanel is browser|diff, so
  // there is nowhere to open one. The bridge still runs with a null open
  // handler because its other half keeps device state fresh, which the pane on
  // a single-surface tab and the composer screenshot both read.
  useDeviceEventBridge({ onOpenPaneRequested: null });

  const closePanePanel = (paneId: PaneId) => {
    updatePanePanelState(paneId, { panel: null });
  };

  const openPaneTurnDiff = (paneId: PaneId, turnId: TurnId, filePath?: string) => {
    updatePanePanelState(paneId, {
      panel: "diff",
      diffTurnId: turnId,
      diffFilePath: filePath ?? null,
    });
  };

  const maximizeFocusedPane = () => {
    if (!activeSplitView) return;
    const focusedLeaf = findLeafPaneById(activeSplitView.root, activeSplitView.focusedPaneId);
    const decision = resolveSplitPaneMaximizeDecision({
      splitViewId: activeSplitView.id,
      focusedThreadId: focusedLeaf?.threadId ?? null,
      focusedPanelState: focusedLeaf?.panel ?? null,
    });

    if (decision) {
      removeSplitView(decision.splitViewIdToRemove);
      void navigate({
        to: "/$threadId",
        params: { threadId: decision.threadId },
        replace: true,
        search: () =>
          decision.panelState ? normalizeSingleSearchFromPane(decision.panelState) : {},
      });
      return;
    }

    removeSplitView(activeSplitView.id);
    void handleNewChat({ fresh: true });
  };

  const closePaneThread = (paneId: PaneId) => {
    if (!activeSplitView) return;
    const closingLeaf = findLeafPaneById(activeSplitView.root, paneId);
    const closingThread = closingLeaf?.threadId
      ? threads.find((thread) => thread.id === closingLeaf.threadId)
      : null;

    if (closingThread?.sidechatSourceThreadId) {
      const decision = resolveSplitPaneCloseDecision({
        splitViewId: activeSplitView.id,
        sourceThreadId: activeSplitView.sourceThreadId,
        closingThreadId: closingLeaf?.threadId ?? null,
        closingSidechatSourceThreadId: closingThread.sidechatSourceThreadId,
        nextFocusedThreadId: null,
        nextLeafCount: 0,
      });
      if (decision.kind !== "single-thread") return;
      void navigate({
        to: "/$threadId",
        params: { threadId: decision.threadId },
        replace: true,
        search: (previous) => ({
          ...stripDiffSearchParams(previous),
          splitViewId: undefined,
        }),
      }).then(() => {
        removeSplitView(decision.splitViewIdToRemove);
      });
      return;
    }

    const closed = removePaneFromSplitView({
      splitViewId: activeSplitView.id,
      paneId,
    });
    if (!closed) return;

    const nextSplitView = useSplitViewStore.getState().splitViewsById[activeSplitView.id];
    const nextThreadId = nextSplitView ? resolveSplitViewFocusedThreadId(nextSplitView) : null;
    const decision = resolveSplitPaneCloseDecision({
      splitViewId: activeSplitView.id,
      sourceThreadId: activeSplitView.sourceThreadId,
      closingThreadId: closingLeaf?.threadId ?? null,
      closingSidechatSourceThreadId: null,
      nextFocusedThreadId: nextThreadId,
      nextLeafCount: nextSplitView ? collectLeaves(nextSplitView.root).length : 0,
    });

    if (decision.kind === "single-thread") {
      removeSplitView(decision.splitViewIdToRemove);
      void navigate({
        to: "/$threadId",
        params: { threadId: decision.threadId },
        replace: true,
        search: (previous) => ({
          ...stripDiffSearchParams(previous),
          splitViewId: undefined,
        }),
      });
      return;
    }

    if (decision.kind === "split-thread") {
      void navigate({
        to: "/$threadId",
        params: { threadId: decision.threadId },
        replace: true,
        search: (previous) => ({
          ...stripDiffSearchParams(previous),
          splitViewId: decision.splitViewId,
        }),
      });
      return;
    }

    void handleNewChat({ fresh: true });
  };

  const handleSetRatio = (nodeId: PaneId, ratio: number) => {
    if (!activeSplitView) return;
    setRatioForNode(activeSplitView.id, nodeId, ratio);
  };

  const handleDropThreadOnPane = (
    paneId: PaneId,
    payload: {
      droppedThreadId: ThreadId;
      direction: SplitDirection;
      side: SplitDropSide;
    },
  ) => {
    if (!activeSplitView) return;
    const ok = dropThreadOnPane({
      splitViewId: activeSplitView.id,
      targetPaneId: paneId,
      direction: payload.direction,
      side: payload.side,
      threadId: payload.droppedThreadId,
    });
    if (!ok) return;
    startTransition(() => {
      void navigate({
        to: "/$threadId",
        params: { threadId: payload.droppedThreadId },
        replace: true,
        search: () => ({ splitViewId: activeSplitView.id }),
      });
    });
  };

  const selectableThreads = threads.toSorted(
    (left, right) =>
      Date.parse(right.updatedAt ?? right.createdAt) - Date.parse(left.updatedAt ?? left.createdAt),
  );
  const splitThreadIds = new Set(activeSplitView ? resolveSplitViewThreadIds(activeSplitView) : []);

  if (!activeSplitView) {
    return <ChatMountLoader />;
  }

  const chooseThreadForPane = (threadId: ThreadId, paneOverride?: PaneId) => {
    const paneId = paneOverride ?? threadPickerPaneId;
    if (!paneId) {
      return;
    }
    setThreadPickerPaneId(null);

    const existingPaneIdForThread = resolveSplitViewPaneIdForThread(activeSplitView, threadId);
    if (existingPaneIdForThread && existingPaneIdForThread !== paneId) {
      setPaneFocus(existingPaneIdForThread);
      return;
    }

    const leaf = findLeafPaneById(activeSplitView.root, paneId);
    setFocusedPane(activeSplitView.id, paneId);
    if (leaf && leaf.threadId !== threadId) {
      replacePaneThread(activeSplitView.id, paneId, threadId);
      setPanePanelState(activeSplitView.id, paneId, {
        diffTurnId: null,
        diffFilePath: null,
      });
    }

    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
      search: (previous) => ({
        ...stripDiffSearchParams(previous),
        splitViewId: activeSplitView.id,
      }),
    });
  };

  const renderLeaf = ({ leaf }: { leaf: LeafPane }): ReactNode => {
    const isFocused = leaf.id === activeSplitView.focusedPaneId;
    const excluded = new Set<ThreadId>(splitThreadIds);
    return (
      <SplitPaneSurface
        key={leaf.id}
        splitView={activeSplitView}
        paneId={leaf.id}
        threadId={leaf.threadId}
        panelState={leaf.panel}
        isFocused={isFocused}
        deferChatMount={false}
        canDropInDirection={(direction) =>
          canSubdividePane(activeSplitView.root, leaf.id, direction)
        }
        excludedThreadIds={excluded}
        threads={selectableThreads}
        projects={projects}
        onFocus={() => setPaneFocus(leaf.id)}
        onToggleDiff={() => togglePanePanel(leaf.id, "diff")}
        onToggleBrowser={() => togglePanePanel(leaf.id, "browser")}
        onOpenBrowserUrl={() => updatePanePanelState(leaf.id, { panel: "browser" })}
        onOpenTurnDiff={(turnId, filePath) => openPaneTurnDiff(leaf.id, turnId, filePath)}
        onClosePanel={() => closePanePanel(leaf.id)}
        onUpdatePanelState={(patch) => updatePanePanelState(leaf.id, patch)}
        onMaximize={maximizeFocusedPane}
        onCloseThreadPane={() => closePaneThread(leaf.id)}
        onChooseThread={() => {
          setPaneFocus(leaf.id);
          setThreadPickerPaneId(leaf.id);
        }}
        onSelectThread={(threadId) => chooseThreadForPane(threadId, leaf.id)}
        onChatMounted={noopChatSurfaceAction}
        onDropThread={(payload) => handleDropThreadOnPane(leaf.id, payload)}
      />
    );
  };

  const pickerLeaf = threadPickerPaneId
    ? findLeafPaneById(activeSplitView.root, threadPickerPaneId)
    : null;

  return (
    <>
      <div
        className={cn(CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME, CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME)}
      >
        <PaneRenderer
          pane={activeSplitView.root}
          splitView={activeSplitView}
          renderLeaf={renderLeaf}
          onSetRatio={handleSetRatio}
        />
      </div>
      <Dialog
        open={threadPickerPaneId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setThreadPickerPaneId(null);
          }
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader className="items-center text-center">
            <DialogTitle>Choose Chat</DialogTitle>
            <DialogDescription className="max-w-sm text-center">
              Pick which chat should appear in the focused split pane.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <div className="max-h-[56vh] space-y-1 overflow-y-auto">
              {selectableThreads.map((thread) => {
                const projectName =
                  projects.find((project) => project.id === thread.projectId)?.name ?? "Project";
                const isSelected = pickerLeaf?.threadId === thread.id;
                return (
                  <button
                    key={thread.id}
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
                      isSelected
                        ? "border-[color:var(--color-border)] bg-[var(--sidebar-accent)]"
                        : "border-[color:var(--color-border-light)] hover:bg-[var(--sidebar-accent)]",
                    )}
                    onClick={() => chooseThreadForPane(thread.id)}
                  >
                    <ProviderIcon
                      provider={thread.modelSelection.provider}
                      className="size-4 shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-foreground">
                        {resolveThreadPickerTitle(thread.title)}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">{projectName}</div>
                    </div>
                  </button>
                );
              })}
            </div>
            <DialogFooter variant="bare">
              <Button type="button" variant="outline" onClick={() => setThreadPickerPaneId(null)}>
                Cancel
              </Button>
            </DialogFooter>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}

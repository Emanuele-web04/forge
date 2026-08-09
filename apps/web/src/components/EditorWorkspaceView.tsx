// FILE: EditorWorkspaceView.tsx
// Purpose: Read-only editor-style thread surface with file explorer, workspace
//          file search, file/diff preview, and chat.
// Layer: Chat route presentation

import type { ProjectId } from "@synara/contracts";
import type { FileDiffMetadata } from "@pierre/diffs/react";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  ChangesIcon,
  ChatBubbleIcon,
  ChevronDownIcon,
  DiffIcon,
  FoldersIcon,
  PanelRightCloseIcon,
  SearchIcon,
} from "~/lib/icons";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import {
  buildFileDiffRenderKey,
  resolveFileDiffPath,
  splitRepoRelativePath,
  summarizeFileDiffStats,
} from "~/lib/diffRendering";
import { showFileReferenceContextMenu } from "~/lib/fileReferenceContextMenu";
import type { ChatFileReference } from "~/lib/chatReferences";
import type { FileCommentSelection } from "~/lib/fileComments";
import { cn } from "~/lib/utils";
import { useTheme } from "~/hooks/useTheme";
import { Skeleton } from "./ui/skeleton";
import {
  ChatHeaderButton,
  ChatHeaderIconButton,
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
} from "./chat/chatHeaderControls";
import { EXPLORER_ROW_PROPS, useExplorerListNavigation } from "./chat/explorerListNavigation";
import { FileEntryIcon } from "./chat/FileEntryIcon";
import { fileRowClassName } from "./chat/fileRowStyles";
import { DiffStat } from "./chat/DiffStatLabel";
import { PanelStateMessage } from "./chat/PanelStateMessage";
import {
  ExplorerActivityBarButton,
  setFileReferenceDragData,
  WorkspaceFilesSidebar,
  WorkspaceSearchSidebar,
} from "./chat/workspaceExplorer";
import { ProjectMenuPicker, type ProjectMenuPickerOption } from "./ProjectMenuPicker";
import { WorkspaceFilePreview } from "./WorkspaceFilePreview";

type EditorCenterMode = "file" | "diff";
type EditorActivityBarItem = EditorCenterMode | "search";

const EDITOR_CHAT_PANE_STORAGE_KEY = "synara.editor.chatPaneWidth";
const EDITOR_SIDEBAR_VISIBLE_STORAGE_KEY = "synara.editor.sidebarVisible";
const EDITOR_CHAT_PANE_VISIBLE_STORAGE_KEY = "synara.editor.chatPaneVisible";
const EDITOR_CHAT_PANE_DEFAULT_WIDTH = 384;
const EDITOR_CHAT_PANE_MIN_WIDTH = 320;
const EDITOR_CHAT_PANE_MAX_WIDTH = 600;
const EDITOR_CHAT_PANE_KEYBOARD_STEP = 24;

interface EditorWorkspaceViewProps {
  workspaceRoot: string | null;
  projectName: string | null;
  currentProjectId?: ProjectId | null;
  projectOptions?: ReadonlyArray<ProjectMenuPickerOption>;
  selectedFilePath: string | null;
  expandedDirectories: ReadonlySet<string>;
  centerMode: EditorCenterMode;
  diffFiles: ReadonlyArray<FileDiffMetadata>;
  diffFilesLoading?: boolean;
  selectedDiffFilePath: string | null;
  diffOptionsControl?: ReactNode;
  diffPanel: ReactNode;
  chatPanel: ReactNode;
  onSelectFile: (path: string) => void;
  onSelectDiffFile: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  onCenterModeChange: (mode: EditorCenterMode) => void;
  onExitEditorView: () => void;
  onReferenceInChat?: (reference: ChatFileReference) => void;
  onAskWhyInChat?: (reference: ChatFileReference) => void;
  onCommentInChat?: (comment: FileCommentSelection) => void;
  onSelectProject?: (projectId: ProjectId) => void;
}

function clampEditorChatPaneWidth(width: number): number {
  return Math.min(
    EDITOR_CHAT_PANE_MAX_WIDTH,
    Math.max(EDITOR_CHAT_PANE_MIN_WIDTH, Math.round(width)),
  );
}

function readStoredEditorChatPaneWidth(): number {
  if (typeof window === "undefined") {
    return EDITOR_CHAT_PANE_DEFAULT_WIDTH;
  }

  try {
    const rawValue = window.localStorage.getItem(EDITOR_CHAT_PANE_STORAGE_KEY);
    const parsed = rawValue === null ? Number.NaN : Number.parseFloat(rawValue);
    return Number.isFinite(parsed)
      ? clampEditorChatPaneWidth(parsed)
      : EDITOR_CHAT_PANE_DEFAULT_WIDTH;
  } catch {
    return EDITOR_CHAT_PANE_DEFAULT_WIDTH;
  }
}

function storeEditorChatPaneWidth(width: number): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      EDITOR_CHAT_PANE_STORAGE_KEY,
      String(clampEditorChatPaneWidth(width)),
    );
  } catch {
    // Best-effort preference persistence only.
  }
}

function readStoredEditorVisibility(key: string): boolean {
  if (typeof window === "undefined") {
    return true;
  }
  try {
    return window.localStorage.getItem(key) !== "false";
  } catch {
    return true;
  }
}

function storeEditorVisibility(key: string, visible: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(key, String(visible));
  } catch {
    // Best-effort preference persistence only.
  }
}

interface EditorChatPaneResizeState {
  pointerId: number;
  startX: number;
  startWidth: number;
  pendingWidth: number;
  rafId: number | null;
  restoreBodyCursor: string;
  restoreBodyUserSelect: string;
  onPointerMove: (event: PointerEvent) => void;
  onPointerEnd: (event: PointerEvent) => void;
}

function DiffFileRow(props: {
  fileDiff: FileDiffMetadata;
  selected: boolean;
  resolvedTheme: "light" | "dark";
  onSelectFile: (path: string) => void;
  onFileContextMenu: (filePath: string, position: { x: number; y: number }) => void;
}) {
  const filePath = resolveFileDiffPath(props.fileDiff);
  const { dir, name } = splitRepoRelativePath(filePath);
  const stat = summarizeFileDiffStats([props.fileDiff]);

  return (
    <button
      {...EXPLORER_ROW_PROPS}
      type="button"
      className={fileRowClassName(props.selected, "h-8 px-2")}
      title={filePath}
      draggable
      onDragStart={(event) => {
        setFileReferenceDragData(event.dataTransfer, filePath);
      }}
      onClick={() => props.onSelectFile(filePath)}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onFileContextMenu(filePath, { x: event.clientX, y: event.clientY });
      }}
    >
      <FileEntryIcon
        pathValue={filePath}
        kind="file"
        theme={props.resolvedTheme}
        className="size-3.5 shrink-0"
      />
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 items-baseline gap-1.5 overflow-hidden">
          <span className="shrink-0 truncate font-medium">{name}</span>
          {dir ? (
            <span className="min-w-0 truncate text-[11px] text-muted-foreground/55">{dir}</span>
          ) : null}
        </div>
      </div>
      <DiffStat
        additions={stat.additions}
        deletions={stat.deletions}
        className="shrink-0 text-[10px] tabular-nums"
      />
    </button>
  );
}

const DIFF_FILE_SKELETON_ROW_WIDTHS = ["w-10/12", "w-7/12", "w-9/12", "w-6/12", "w-8/12"];

function DiffFilesLoadingRows() {
  return (
    <div className="space-y-1 px-1 py-1" role="status" aria-label="Loading changed files...">
      {DIFF_FILE_SKELETON_ROW_WIDTHS.map((width) => (
        <div key={width} className="flex h-8 items-center gap-1.5 px-2">
          <Skeleton className="size-3.5 shrink-0 rounded-sm" />
          <Skeleton className={cn("h-3 rounded-full", width)} />
          <Skeleton className="ml-auto h-3 w-9 shrink-0 rounded-full" />
        </div>
      ))}
    </div>
  );
}

function DiffFilesSidebar(props: {
  files: ReadonlyArray<FileDiffMetadata>;
  isLoading: boolean;
  selectedFilePath: string | null;
  optionsControl?: ReactNode;
  onSelectFile: (path: string) => void;
  onReferenceInChat: ((reference: ChatFileReference) => void) | undefined;
  onAskWhyInChat: ((reference: ChatFileReference) => void) | undefined;
}) {
  const { resolvedTheme } = useTheme();
  const { onAskWhyInChat, onReferenceInChat } = props;
  const handleListKeyDown = useExplorerListNavigation();
  const totals = summarizeFileDiffStats(props.files);
  const hasDiffStats = totals.additions > 0 || totals.deletions > 0;
  const showLoadingRows = props.isLoading && props.files.length === 0;
  const handleFileContextMenu = (filePath: string, position: { x: number; y: number }) => {
    void showFileReferenceContextMenu({
      path: filePath,
      position,
      onReferenceInChat,
      onAskWhyInChat,
    });
  };

  return (
    <aside className="flex min-h-[11rem] w-full shrink-0 flex-col border-b border-border/65 bg-[var(--color-background-surface)] lg:h-full lg:w-56 lg:border-b-0 lg:border-r">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/65 px-3">
        <DiffIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground/86">
          Changed files
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {props.files.length > 0 ? (
            <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground tabular-nums">
              {props.files.length}
            </span>
          ) : null}
          {props.optionsControl}
        </div>
      </div>
      {hasDiffStats ? (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/45 px-3">
          <DiffStat
            additions={totals.additions}
            deletions={totals.deletions}
            className="text-[11px] tabular-nums"
          />
        </div>
      ) : null}
      {/* Keyboard nav lives on the scrolling list, not the whole aside, so the
          header's actions menu stays out of arrow-key scope (the search sidebars
          attach at the aside because their only header control is a text input). */}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-auto px-1 py-1",
          !showLoadingRows && props.files.length === 0 && "flex flex-col",
        )}
        onKeyDown={handleListKeyDown}
      >
        {showLoadingRows ? (
          <DiffFilesLoadingRows />
        ) : props.files.length === 0 ? (
          <PanelStateMessage density="compact" fill="flex">
            <p>No files in this diff.</p>
          </PanelStateMessage>
        ) : (
          props.files.map((fileDiff) => {
            const filePath = resolveFileDiffPath(fileDiff);
            return (
              <DiffFileRow
                key={buildFileDiffRenderKey(fileDiff)}
                fileDiff={fileDiff}
                resolvedTheme={resolvedTheme}
                selected={props.selectedFilePath === filePath}
                onSelectFile={props.onSelectFile}
                onFileContextMenu={handleFileContextMenu}
              />
            );
          })
        )}
      </div>
    </aside>
  );
}

function EditorActivityBar(props: {
  centerMode: EditorCenterMode;
  searchActive: boolean;
  sidebarVisible: boolean;
  onSelectItem: (item: EditorActivityBarItem) => void;
}) {
  const filesActive = props.sidebarVisible && !props.searchActive && props.centerMode === "file";
  const diffActive = props.sidebarVisible && !props.searchActive && props.centerMode === "diff";
  const searchActive = props.sidebarVisible && props.searchActive;
  return (
    <nav
      className="flex w-12 shrink-0 flex-col items-center border-r border-border/65 bg-[var(--color-background-surface)]"
      aria-label="Editor activity bar"
    >
      <ExplorerActivityBarButton
        label={filesActive ? "Hide files sidebar" : "Files"}
        active={filesActive}
        onClick={() => props.onSelectItem("file")}
      >
        <FoldersIcon className="size-5" />
      </ExplorerActivityBarButton>
      <ExplorerActivityBarButton
        label={diffActive ? "Hide diff sidebar" : "Diff"}
        active={diffActive}
        onClick={() => props.onSelectItem("diff")}
      >
        <ChangesIcon className="size-5" />
      </ExplorerActivityBarButton>
      <ExplorerActivityBarButton
        label={searchActive ? "Hide search sidebar" : "Search files"}
        active={searchActive}
        onClick={() => props.onSelectItem("search")}
      >
        <SearchIcon className="size-5" />
      </ExplorerActivityBarButton>
    </nav>
  );
}

export function EditorWorkspaceView(props: EditorWorkspaceViewProps) {
  // The editor header sits flush against the window's left edge whenever the
  // global sidebar is collapsed, so it has to clear the macOS traffic lights the
  // same way every other chat-surface header does.
  const trafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  const [chatPaneWidth, setChatPaneWidth] = useState(readStoredEditorChatPaneWidth);
  const chatPaneResizeStateRef = useRef<EditorChatPaneResizeState | null>(null);
  // Both side surfaces can be hidden so the main content takes the full width:
  // re-clicking the active activity-bar item collapses the sidebar (VS Code
  // style), and the header chat toggle hides the chat pane (kept mounted so
  // the chat runtime survives).
  const [sidebarVisible, setSidebarVisible] = useState(() =>
    readStoredEditorVisibility(EDITOR_SIDEBAR_VISIBLE_STORAGE_KEY),
  );
  const [chatPaneVisible, setChatPaneVisible] = useState(() =>
    readStoredEditorVisibility(EDITOR_CHAT_PANE_VISIBLE_STORAGE_KEY),
  );
  // The search pane replaces the explorer/diff sidebar without touching the
  // center mode, so picking a result simply opens it in the file preview. The
  // query lives here so it survives toggling between sidebar panes.
  const [searchPaneActive, setSearchPaneActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const desktopTopBarWindowControlsGutterClassName =
    useDesktopTopBarWindowControlsGutterClassName();
  const { centerMode, onCenterModeChange } = props;
  const handleActivityBarSelectItem = (item: EditorActivityBarItem) => {
    const itemActive =
      sidebarVisible &&
      (item === "search" ? searchPaneActive : !searchPaneActive && centerMode === item);
    if (itemActive) {
      setSidebarVisible(false);
      storeEditorVisibility(EDITOR_SIDEBAR_VISIBLE_STORAGE_KEY, false);
      return;
    }
    if (!sidebarVisible) {
      setSidebarVisible(true);
      storeEditorVisibility(EDITOR_SIDEBAR_VISIBLE_STORAGE_KEY, true);
    }
    if (item === "search") {
      setSearchPaneActive(true);
      return;
    }
    setSearchPaneActive(false);
    onCenterModeChange(item);
  };
  const toggleChatPaneVisible = () => {
    setChatPaneVisible((previous) => {
      const next = !previous;
      storeEditorVisibility(EDITOR_CHAT_PANE_VISIBLE_STORAGE_KEY, next);
      return next;
    });
  };

  const stopChatPaneResize = () => {
    const resizeState = chatPaneResizeStateRef.current;
    if (!resizeState || typeof window === "undefined") {
      return;
    }

    if (resizeState.rafId !== null) {
      window.cancelAnimationFrame(resizeState.rafId);
      resizeState.rafId = null;
    }

    window.removeEventListener("pointermove", resizeState.onPointerMove);
    window.removeEventListener("pointerup", resizeState.onPointerEnd);
    window.removeEventListener("pointercancel", resizeState.onPointerEnd);
    document.body.style.cursor = resizeState.restoreBodyCursor;
    document.body.style.userSelect = resizeState.restoreBodyUserSelect;
    setChatPaneWidth(resizeState.pendingWidth);
    storeEditorChatPaneWidth(resizeState.pendingWidth);
    chatPaneResizeStateRef.current = null;
  };

  useEffect(() => stopChatPaneResize, [stopChatPaneResize]);

  const handleChatPaneResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || typeof window === "undefined") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    stopChatPaneResize();

    const resizeState: EditorChatPaneResizeState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: chatPaneWidth,
      pendingWidth: chatPaneWidth,
      rafId: null,
      restoreBodyCursor: document.body.style.cursor,
      restoreBodyUserSelect: document.body.style.userSelect,
      onPointerMove: () => undefined,
      onPointerEnd: () => undefined,
    };

    resizeState.onPointerMove = (moveEvent) => {
      if (moveEvent.pointerId !== resizeState.pointerId) {
        return;
      }

      resizeState.pendingWidth = clampEditorChatPaneWidth(
        resizeState.startWidth + resizeState.startX - moveEvent.clientX,
      );

      if (resizeState.rafId !== null) {
        return;
      }

      resizeState.rafId = window.requestAnimationFrame(() => {
        resizeState.rafId = null;
        setChatPaneWidth(resizeState.pendingWidth);
      });
    };

    resizeState.onPointerEnd = (endEvent) => {
      if (endEvent.pointerId !== resizeState.pointerId) {
        return;
      }
      stopChatPaneResize();
    };

    chatPaneResizeStateRef.current = resizeState;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", resizeState.onPointerMove);
    window.addEventListener("pointerup", resizeState.onPointerEnd);
    window.addEventListener("pointercancel", resizeState.onPointerEnd);
  };

  const handleChatPaneResizeDoubleClick = () => {
    setChatPaneWidth(EDITOR_CHAT_PANE_DEFAULT_WIDTH);
    storeEditorChatPaneWidth(EDITOR_CHAT_PANE_DEFAULT_WIDTH);
  };

  const handleChatPaneResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number | null = null;

    if (event.key === "ArrowLeft") {
      nextWidth = chatPaneWidth + EDITOR_CHAT_PANE_KEYBOARD_STEP;
    } else if (event.key === "ArrowRight") {
      nextWidth = chatPaneWidth - EDITOR_CHAT_PANE_KEYBOARD_STEP;
    } else if (event.key === "Home") {
      nextWidth = EDITOR_CHAT_PANE_MIN_WIDTH;
    } else if (event.key === "End") {
      nextWidth = EDITOR_CHAT_PANE_MAX_WIDTH;
    }

    if (nextWidth === null) {
      return;
    }

    event.preventDefault();
    const clampedWidth = clampEditorChatPaneWidth(nextWidth);
    setChatPaneWidth(clampedWidth);
    storeEditorChatPaneWidth(clampedWidth);
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-background-root)] text-foreground">
      <div
        className={cn(
          "flex shrink-0 items-center gap-2 px-2 sm:px-3",
          CHAT_SURFACE_HEADER_HEIGHT_CLASS,
          CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
          desktopTopBarWindowControlsGutterClassName,
        )}
      >
        <div
          className={cn("flex min-w-0 flex-1 items-center gap-1.5", trafficLightGutterClassName)}
        >
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[13px] font-medium text-foreground">
              {props.projectName ?? "Workspace"}
            </span>
            <span className="hidden truncate text-[11px] text-muted-foreground/70 sm:inline">
              {props.workspaceRoot ?? "No workspace"}
            </span>
          </div>
          {props.onSelectProject && (props.projectOptions?.length ?? 0) > 0 ? (
            <ProjectMenuPicker
              projectOptions={props.projectOptions ?? []}
              selectedProjectId={props.currentProjectId ?? null}
              onProjectIdChange={props.onSelectProject}
              trigger={
                <ChatHeaderIconButton
                  type="button"
                  tone="plain"
                  label="Switch project"
                  title="Switch project"
                  className="size-6"
                >
                  <ChevronDownIcon className="size-3.5" />
                </ChatHeaderIconButton>
              }
            />
          ) : null}
        </div>
        <ChatHeaderButton
          type="button"
          tone="outline"
          aria-pressed={chatPaneVisible}
          title={chatPaneVisible ? "Hide chat panel" : "Show chat panel"}
          className="gap-1.5"
          onClick={toggleChatPaneVisible}
        >
          <PanelRightCloseIcon className="size-3.5" />
          <span className="sr-only">{chatPaneVisible ? "Hide chat panel" : "Show chat panel"}</span>
        </ChatHeaderButton>
        <ChatHeaderButton
          type="button"
          tone="outline"
          aria-pressed={true}
          title="Switch to chat view"
          className="w-[5.5rem] gap-1.5"
          onClick={props.onExitEditorView}
        >
          <ChatBubbleIcon className="size-3.5" />
          <span className="truncate font-normal">Chat</span>
        </ChatHeaderButton>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <EditorActivityBar
          centerMode={props.centerMode}
          searchActive={searchPaneActive}
          sidebarVisible={sidebarVisible}
          onSelectItem={handleActivityBarSelectItem}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden lg:flex-row">
          {!sidebarVisible ? null : searchPaneActive ? (
            <WorkspaceSearchSidebar
              workspaceRoot={props.workspaceRoot}
              query={searchQuery}
              onQueryChange={setSearchQuery}
              selectedFilePath={props.selectedFilePath}
              onSelectFile={props.onSelectFile}
              onReferenceInChat={props.onReferenceInChat}
            />
          ) : props.centerMode === "diff" ? (
            <DiffFilesSidebar
              files={props.diffFiles}
              isLoading={props.diffFilesLoading ?? false}
              selectedFilePath={props.selectedDiffFilePath}
              optionsControl={props.diffOptionsControl}
              onSelectFile={props.onSelectDiffFile}
              onReferenceInChat={props.onReferenceInChat}
              onAskWhyInChat={props.onAskWhyInChat}
            />
          ) : (
            <WorkspaceFilesSidebar
              workspaceRoot={props.workspaceRoot}
              selectedFilePath={props.selectedFilePath}
              expandedDirectories={props.expandedDirectories}
              onSelectFile={props.onSelectFile}
              onToggleDirectory={props.onToggleDirectory}
              onReferenceInChat={props.onReferenceInChat}
            />
          )}
          <main className="flex min-h-[16rem] min-w-0 flex-1 border-b border-border/65 lg:h-full lg:border-b-0">
            {/* Keep the diff panel mounted while browsing files: unmounting it
                drops the parsed patch, diff worker pool, and query subscriptions,
                which made every Files -> Diff switch a cold multi-second reload. */}
            <div className={cn("min-h-0 min-w-0 flex-1", props.centerMode !== "diff" && "hidden")}>
              {props.diffPanel}
            </div>
            {props.centerMode === "file" ? (
              <div className="flex min-h-0 min-w-0 flex-1">
                <WorkspaceFilePreview
                  workspaceRoot={props.workspaceRoot}
                  filePath={props.selectedFilePath}
                  editable
                  onReferenceInChat={props.onReferenceInChat}
                  onAskWhyInChat={props.onAskWhyInChat}
                  onCommentInChat={props.onCommentInChat}
                />
              </div>
            ) : null}
          </main>
          <div
            role="separator"
            aria-label="Resize chat panel"
            aria-orientation="vertical"
            aria-valuemin={EDITOR_CHAT_PANE_MIN_WIDTH}
            aria-valuemax={EDITOR_CHAT_PANE_MAX_WIDTH}
            aria-valuenow={chatPaneWidth}
            tabIndex={0}
            title="Drag to resize chat panel"
            className={cn(
              "group relative z-10 w-0 shrink-0 cursor-col-resize outline-none",
              chatPaneVisible ? "hidden lg:block" : "hidden",
            )}
            onPointerDown={handleChatPaneResizePointerDown}
            onDoubleClick={handleChatPaneResizeDoubleClick}
            onKeyDown={handleChatPaneResizeKeyDown}
          >
            <span
              className="absolute inset-y-0 left-[-3px] w-1.5 cursor-col-resize bg-transparent transition-colors group-hover:bg-[var(--color-background-button-secondary-hover)] group-focus-visible:bg-[var(--color-background-button-secondary-hover)]"
              aria-hidden="true"
            />
            <span
              className="pointer-events-none absolute inset-y-0 left-0 w-px bg-[var(--app-surface-divider)] transition-colors group-hover:bg-[var(--color-text-accent)] group-focus-visible:bg-[var(--color-text-accent)]"
              aria-hidden="true"
            />
          </div>
          {/* Hidden (not unmounted) so the chat runtime and composer focus
              state survive toggling the pane. */}
          <aside
            className={cn(
              "min-h-[18rem] w-full shrink-0 bg-[var(--color-background-surface)] lg:h-full lg:w-[var(--editor-chat-pane-width)]",
              chatPaneVisible ? "flex" : "hidden",
            )}
            style={
              {
                "--editor-chat-pane-width": `${chatPaneWidth}px`,
              } as CSSProperties
            }
          >
            {props.chatPanel}
          </aside>
        </div>
      </div>
    </div>
  );
}

export default EditorWorkspaceView;

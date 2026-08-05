// FILE: ThreadTerminalDrawer.tsx
// Purpose: Hosts the terminal drawer/workspace chrome and each xterm viewport for a thread.
// Layer: Chat terminal workspace UI
// Depends on: xterm addons, native terminal APIs, and terminal workspace state from ChatView.

import "@xterm/xterm/css/xterm.css";
import { SearchAddon } from "@xterm/addon-search";
import {
  Plus,
  SquareSplitHorizontal,
  SquareSplitVertical,
  Trash2,
  TriangleAlertIcon,
} from "~/lib/icons";
import { type ThreadId } from "@synara/contracts";
import { type TerminalActivityState, type TerminalCliKind } from "@synara/shared/terminalThreads";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { readNativeApi } from "~/nativeApi";
import {
  MAX_TERMINALS_PER_GROUP,
  type ThreadTerminalGroup,
  type ThreadTerminalPresentationMode,
} from "../types";
import { cn } from "~/lib/utils";
import {
  type TerminalChromeActionItem,
  TerminalSidebar,
  TerminalWorkspaceTabBar,
} from "./terminal/TerminalChrome";
import { resolveThreadTerminalLayout } from "./terminal/TerminalLayout";
import {
  resolveTerminalSelectionActionPosition,
  resolveTerminalSelectionContextMenuItems,
  shouldHandleTerminalSelectionMouseUp,
  terminalSelectionActionDelayForClickCount,
} from "./terminal/terminalSelectionActions";
import {
  buildTerminalRuntimeKey,
  terminalRuntimeRegistry,
} from "./terminal/terminalRuntimeRegistry";
import type {
  TerminalRuntimeConfig,
  TerminalRuntimeStatus,
  TerminalRuntimeViewState,
} from "./terminal/terminalRuntimeTypes";
import TerminalViewportPane from "./terminal/TerminalViewportPane";
import { useTerminalDrawerHeight } from "./terminal/useTerminalDrawerHeight";
import { TerminalSearch } from "./TerminalSearch";
import { TerminalScrollToBottom } from "./TerminalScrollToBottom";

function serializeRuntimeEnv(runtimeEnv: Record<string, string> | undefined): string {
  if (!runtimeEnv) return "";
  const entries = Object.entries(runtimeEnv);
  if (entries.length === 0) return "";
  entries.sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(entries);
}

function runtimeEnvFromSerialized(
  serializedRuntimeEnv: string,
): Record<string, string> | undefined {
  if (!serializedRuntimeEnv) return undefined;
  const entries = JSON.parse(serializedRuntimeEnv) as Array<[string, string]>;
  return Object.fromEntries(entries);
}

function getTerminalSelectionRect(mountElement: HTMLElement): DOMRect | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const commonAncestor = range.commonAncestorContainer;
  const selectionRoot =
    commonAncestor instanceof Element ? commonAncestor : commonAncestor.parentElement;
  if (!(selectionRoot instanceof Element) || !mountElement.contains(selectionRoot)) {
    return null;
  }

  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  );
  if (rects.length > 0) {
    return rects[rects.length - 1] ?? null;
  }

  const boundingRect = range.getBoundingClientRect();
  return boundingRect.width > 0 || boundingRect.height > 0 ? boundingRect : null;
}

function TerminalRuntimeStatusOverlay({ status }: { status: TerminalRuntimeStatus }) {
  if (status !== "error") return null;

  return (
    <div
      className={cn(
        "pointer-events-none absolute left-1 top-1 z-10 inline-flex h-6 max-w-[calc(100%-0.5rem)] items-center gap-1.5 rounded border px-2 text-[11px] leading-none shadow-sm backdrop-blur",
        "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      <TriangleAlertIcon className="size-3" />
      <span className="truncate">Error</span>
    </div>
  );
}

interface TerminalViewportProps {
  threadId: ThreadId;
  terminalId: string;
  terminalLabel: string;
  terminalCliKind?: TerminalCliKind | null;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  onSessionExited: () => void;
  onTerminalMetadataChange: (
    terminalId: string,
    metadata: { cliKind: TerminalCliKind | null; label: string },
  ) => void;
  onTerminalActivityChange: (
    terminalId: string,
    activity: { hasRunningSubprocess: boolean; agentState: TerminalActivityState | null },
  ) => void;
  onAddTerminalContext?: ((selection: TerminalContextSelection) => void) | undefined;
  focusRequestId: number;
  autoFocus: boolean;
  isVisible: boolean;
}

function TerminalViewport({
  threadId,
  terminalId,
  terminalLabel,
  terminalCliKind: terminalCliKindProp,
  cwd,
  runtimeEnv,
  onSessionExited,
  onTerminalMetadataChange,
  onTerminalActivityChange,
  onAddTerminalContext,
  focusRequestId,
  autoFocus,
  isVisible,
}: TerminalViewportProps) {
  const terminalCliKind = terminalCliKindProp ?? null;
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const onAddTerminalContextRef = useRef(onAddTerminalContext);
  const terminalLabelRef = useRef(terminalLabel);
  const selectionPointerRef = useRef<{ x: number; y: number } | null>(null);
  const selectionGestureActiveRef = useRef(false);
  const selectionActionRequestIdRef = useRef(0);
  const selectionActionOpenRef = useRef(false);
  const selectionActionTimerRef = useRef<number | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [terminalInstance, setTerminalInstance] = useState<Terminal | null>(null);
  const [searchAddonInstance, setSearchAddonInstance] = useState<SearchAddon | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<TerminalRuntimeStatus>("connecting");
  const runtimeStatusMountedRef = useRef(false);
  const trimmedCwd = useMemo(() => cwd.trim(), [cwd]);
  const runtimeCwdReady = trimmedCwd.length > 0;
  const runtimeKey = useMemo(
    () => buildTerminalRuntimeKey(threadId, terminalId),
    [terminalId, threadId],
  );
  const runtimeEnvSerialized = useMemo(() => serializeRuntimeEnv(runtimeEnv), [runtimeEnv]);
  const runtimeEnvPayload = useMemo(
    () => runtimeEnvFromSerialized(runtimeEnvSerialized),
    [runtimeEnvSerialized],
  );
  const runtimeConfig = useMemo<TerminalRuntimeConfig>(
    () => ({
      runtimeKey,
      threadId,
      terminalId,
      terminalLabel,
      terminalCliKind,
      cwd,
      ...(runtimeEnvPayload ? { runtimeEnv: runtimeEnvPayload } : {}),
      callbacks: {
        onSessionExited,
        onTerminalMetadataChange,
        onTerminalActivityChange,
        onTerminalRuntimeStatusChange: (changedTerminalId, status) => {
          if (changedTerminalId === terminalId && runtimeStatusMountedRef.current) {
            setRuntimeStatus(status);
          }
        },
      },
    }),
    [
      cwd,
      onSessionExited,
      onTerminalActivityChange,
      onTerminalMetadataChange,
      runtimeEnvPayload,
      runtimeKey,
      terminalCliKind,
      terminalId,
      terminalLabel,
      threadId,
    ],
  );
  const runtimeViewState = useMemo<TerminalRuntimeViewState>(
    () => ({ autoFocus, isVisible }),
    [autoFocus, isVisible],
  );
  const runtimeConfigRef = useRef(runtimeConfig);
  const runtimeViewStateRef = useRef(runtimeViewState);

  useLayoutEffect(() => {
    onAddTerminalContextRef.current = onAddTerminalContext;
  }, [onAddTerminalContext]);

  useEffect(() => {
    runtimeStatusMountedRef.current = true;
    return () => {
      runtimeStatusMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    runtimeConfigRef.current = runtimeConfig;
  }, [runtimeConfig]);

  useEffect(() => {
    runtimeViewStateRef.current = runtimeViewState;
  }, [runtimeViewState]);

  useEffect(() => {
    terminalLabelRef.current = terminalLabel;
  }, [terminalLabel]);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount || !runtimeCwdReady) {
      terminalRef.current = null;
      setTerminalInstance(null);
      setSearchAddonInstance(null);
      setRuntimeStatus("connecting");
      return;
    }
    const attachedRuntime = terminalRuntimeRegistry.attach(
      runtimeConfigRef.current,
      runtimeViewStateRef.current,
      mount,
    );

    terminalRef.current = attachedRuntime.terminal;
    setTerminalInstance(attachedRuntime.terminal);
    setSearchAddonInstance(attachedRuntime.searchAddon);
    setRuntimeStatus(attachedRuntime.runtimeStatus);

    return () => {
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
        selectionActionTimerRef.current = null;
      }
      selectionActionOpenRef.current = false;
      terminalRuntimeRegistry.detach(runtimeKey);
      terminalRef.current = null;
      setTerminalInstance(null);
      setSearchAddonInstance(null);
    };
  }, [runtimeCwdReady, runtimeKey]);

  useEffect(() => {
    if (!runtimeCwdReady) return;
    terminalRuntimeRegistry.syncConfig(runtimeKey, runtimeConfig);
  }, [runtimeConfig, runtimeCwdReady, runtimeKey]);

  useEffect(() => {
    if (!runtimeCwdReady) return;
    terminalRuntimeRegistry.setViewState(runtimeKey, runtimeViewState);
  }, [runtimeCwdReady, runtimeKey, runtimeViewState]);

  useEffect(() => {
    if (!autoFocus || !runtimeCwdReady) return;
    terminalRuntimeRegistry.focus(runtimeKey);
  }, [autoFocus, focusRequestId, runtimeCwdReady, runtimeKey]);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() === "f" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        setSearchOpen(true);
      }
    };

    mount.addEventListener("keydown", handleKeyDown, true);
    return () => {
      mount.removeEventListener("keydown", handleKeyDown, true);
    };
  }, []);

  const clearSelectionAction = useCallback(() => {
    selectionActionRequestIdRef.current += 1;
    if (selectionActionTimerRef.current !== null) {
      window.clearTimeout(selectionActionTimerRef.current);
      selectionActionTimerRef.current = null;
    }
  }, []);

  const readSelectionAction = useCallback((): {
    position: { x: number; y: number };
    selection: TerminalContextSelection;
  } | null => {
    const activeTerminal = terminalRef.current;
    const mountElement = containerRef.current;
    if (!activeTerminal || !mountElement || !activeTerminal.hasSelection()) {
      return null;
    }
    const selectionText = activeTerminal.getSelection();
    const selectionPosition = activeTerminal.getSelectionPosition();
    const normalizedText = selectionText.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
    if (!selectionPosition || normalizedText.length === 0) {
      return null;
    }
    const lineStart = selectionPosition.start.y + 1;
    const lineCount = normalizedText.split("\n").length;
    const lineEnd = Math.max(lineStart, lineStart + lineCount - 1);
    const bounds = mountElement.getBoundingClientRect();
    const selectionRect = getTerminalSelectionRect(mountElement);
    const position = resolveTerminalSelectionActionPosition({
      bounds,
      selectionRect:
        selectionRect === null
          ? null
          : { right: selectionRect.right, bottom: selectionRect.bottom },
      pointer: selectionPointerRef.current,
    });
    return {
      position,
      selection: {
        terminalId,
        terminalLabel: terminalLabelRef.current,
        lineStart,
        lineEnd,
        text: normalizedText,
      },
    };
  }, [terminalId]);

  const showSelectionAction = useCallback(() => {
    if (selectionActionOpenRef.current) {
      return;
    }
    const contextMenuItems = resolveTerminalSelectionContextMenuItems(
      onAddTerminalContextRef.current !== undefined,
    );
    if (contextMenuItems.length === 0) {
      clearSelectionAction();
      return;
    }
    const nextAction = readSelectionAction();
    if (!nextAction) {
      clearSelectionAction();
      return;
    }
    const api = readNativeApi();
    if (!api) return;
    const requestId = ++selectionActionRequestIdRef.current;
    selectionActionOpenRef.current = true;
    // Promise chain instead of async/try-finally: React Compiler does not yet
    // support try/finally, and it would skip optimizing this whole component.
    void api.contextMenu
      .show(contextMenuItems, nextAction.position)
      .then((clicked) => {
        if (requestId !== selectionActionRequestIdRef.current || clicked !== "add-to-chat") {
          return;
        }
        const addTerminalContext = onAddTerminalContextRef.current;
        if (!addTerminalContext) {
          return;
        }
        addTerminalContext(nextAction.selection);
        terminalRef.current?.clearSelection();
        terminalRuntimeRegistry.focus(runtimeKey);
      })
      .finally(() => {
        selectionActionOpenRef.current = false;
      });
  }, [clearSelectionAction, readSelectionAction, runtimeKey]);

  useEffect(() => {
    const terminal = terminalInstance;
    const mount = containerRef.current;
    if (!terminal || !mount) return;

    const selectionDisposable = terminal.onSelectionChange(() => {
      if (terminal.hasSelection()) {
        return;
      }
      clearSelectionAction();
    });

    const handleMouseUp = (event: MouseEvent) => {
      const shouldHandle = shouldHandleTerminalSelectionMouseUp(
        selectionGestureActiveRef.current,
        event.button,
      );
      selectionGestureActiveRef.current = false;
      if (!shouldHandle) {
        return;
      }
      selectionPointerRef.current = { x: event.clientX, y: event.clientY };
      const delay = terminalSelectionActionDelayForClickCount(event.detail);
      selectionActionTimerRef.current = window.setTimeout(() => {
        selectionActionTimerRef.current = null;
        window.requestAnimationFrame(() => {
          void showSelectionAction();
        });
      }, delay);
    };

    const handlePointerDown = (event: PointerEvent) => {
      clearSelectionAction();
      selectionGestureActiveRef.current = event.button === 0;
    };

    window.addEventListener("mouseup", handleMouseUp);
    mount.addEventListener("pointerdown", handlePointerDown);
    return () => {
      selectionDisposable.dispose();
      window.removeEventListener("mouseup", handleMouseUp);
      mount.removeEventListener("pointerdown", handlePointerDown);
      clearSelectionAction();
      selectionGestureActiveRef.current = false;
    };
  }, [clearSelectionAction, showSelectionAction, terminalInstance]);

  return (
    <div className="h-full min-h-0 w-full bg-[var(--color-background-surface)] p-3">
      <div className="relative h-full min-h-0 w-full overflow-hidden">
        <TerminalSearch
          searchAddon={searchAddonInstance}
          isOpen={searchOpen}
          onClose={() => {
            setSearchOpen(false);
            terminalRuntimeRegistry.focus(runtimeKey);
          }}
        />
        <TerminalRuntimeStatusOverlay status={runtimeStatus} />
        <TerminalScrollToBottom terminal={terminalInstance} />
        <div ref={containerRef} className="h-full w-full" />
      </div>
    </div>
  );
}

interface ThreadTerminalDrawerProps {
  threadId: ThreadId;
  cwd: string;
  runtimeEnv?: Record<string, string>;
  height: number;
  presentationMode: ThreadTerminalPresentationMode;
  isVisible?: boolean;
  terminalIds: string[];
  terminalLabelsById: Record<string, string>;
  terminalTitleOverridesById: Record<string, string>;
  terminalCliKindsById: Record<string, TerminalCliKind>;
  terminalAttentionStatesById: Record<string, "attention" | "review">;
  runningTerminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
  focusRequestId: number;
  onSplitTerminal: () => void;
  onSplitTerminalDown: () => void;
  onNewTerminal: () => void;
  onNewTerminalTab: (terminalId: string) => void;
  onMoveTerminalToGroup: (terminalId: string) => void;
  splitShortcutLabel?: string | undefined;
  splitDownShortcutLabel?: string | undefined;
  newShortcutLabel?: string | undefined;
  closeShortcutLabel?: string | undefined;
  workspaceCloseShortcutLabel?: string | undefined;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  onTerminalSessionExited: (terminalId: string) => void;
  onCloseTerminalGroup: (groupId: string) => void;
  onHeightChange: (height: number) => void;
  onResizeTerminalSplit: (groupId: string, splitId: string, weights: number[]) => void;
  onTerminalMetadataChange: (
    terminalId: string,
    metadata: { cliKind: TerminalCliKind | null; label: string },
  ) => void;
  onTerminalActivityChange: (
    terminalId: string,
    activity: { hasRunningSubprocess: boolean; agentState: TerminalActivityState | null },
  ) => void;
  onAddTerminalContext?: ((selection: TerminalContextSelection) => void) | undefined;
  onTogglePresentationMode?: (() => void) | undefined;
  onTogglePanel?: (() => void) | undefined;
  isPanelOpen?: boolean | undefined;
}

export default function ThreadTerminalDrawer({
  threadId,
  cwd,
  runtimeEnv,
  height,
  presentationMode,
  isVisible: isVisibleProp,
  terminalIds,
  terminalLabelsById,
  terminalTitleOverridesById,
  terminalCliKindsById,
  terminalAttentionStatesById,
  runningTerminalIds,
  activeTerminalId,
  terminalGroups,
  activeTerminalGroupId,
  focusRequestId,
  onSplitTerminal,
  onSplitTerminalDown,
  onNewTerminal,
  onNewTerminalTab,
  onMoveTerminalToGroup,
  splitShortcutLabel,
  splitDownShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  workspaceCloseShortcutLabel,
  onActiveTerminalChange,
  onCloseTerminal,
  onTerminalSessionExited,
  onCloseTerminalGroup,
  onHeightChange,
  onResizeTerminalSplit,
  onTerminalMetadataChange,
  onTerminalActivityChange,
  onAddTerminalContext,
  onTogglePresentationMode,
  onTogglePanel,
  isPanelOpen,
}: ThreadTerminalDrawerProps) {
  const isVisible = isVisibleProp ?? true;
  const isWorkspaceMode = presentationMode === "workspace";
  const previousRuntimeKeysRef = useRef<Set<string>>(new Set());
  const { drawerHeight, handleResizePointerDown, handleResizePointerMove, handleResizePointerEnd } =
    useTerminalDrawerHeight({
      height,
      onHeightChange,
      resetKey: threadId,
    });

  const {
    normalizedTerminalIds,
    resolvedActiveTerminalId,
    resolvedActiveGroupId,
    resolvedTerminalGroups,
    activeGroupLayout,
    hasTerminalSidebar,
    showGroupHeaders,
    hasReachedSplitLimit,
    terminalVisualIdentityById,
  } = useMemo(
    () =>
      resolveThreadTerminalLayout({
        activeTerminalGroupId,
        activeTerminalId,
        runningTerminalIds,
        terminalAttentionStatesById,
        terminalCliKindsById,
        terminalGroups,
        terminalIds,
        terminalLabelsById,
        terminalTitleOverridesById,
      }),
    [
      activeTerminalGroupId,
      activeTerminalId,
      runningTerminalIds,
      terminalAttentionStatesById,
      terminalCliKindsById,
      terminalGroups,
      terminalIds,
      terminalLabelsById,
      terminalTitleOverridesById,
    ],
  );

  useEffect(() => {
    const nextRuntimeKeySet = new Set(
      normalizedTerminalIds.map((terminalId) => buildTerminalRuntimeKey(threadId, terminalId)),
    );
    for (const previousRuntimeKey of previousRuntimeKeysRef.current) {
      if (nextRuntimeKeySet.has(previousRuntimeKey)) {
        continue;
      }
      terminalRuntimeRegistry.dispose(previousRuntimeKey);
    }
    previousRuntimeKeysRef.current = nextRuntimeKeySet;
  }, [normalizedTerminalIds, threadId]);

  const splitTerminalActionLabel = hasReachedSplitLimit
    ? `Split Terminal (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : splitShortcutLabel
      ? `Split Right (${splitShortcutLabel})`
      : "Split Right";
  const splitTerminalDownActionLabel = hasReachedSplitLimit
    ? `Split Down (max ${MAX_TERMINALS_PER_GROUP} per group)`
    : splitDownShortcutLabel
      ? `Split Down (${splitDownShortcutLabel})`
      : "Split Down";
  const newTerminalActionLabel = newShortcutLabel
    ? `New Terminal (${newShortcutLabel})`
    : "New Terminal";
  const resolvedCloseShortcutLabel = isWorkspaceMode
    ? (workspaceCloseShortcutLabel ?? closeShortcutLabel)
    : closeShortcutLabel;
  const closeTerminalActionLabel = resolvedCloseShortcutLabel
    ? `Close Terminal (${resolvedCloseShortcutLabel})`
    : "Close Terminal";
  const onSplitTerminalAction = useCallback(() => {
    if (hasReachedSplitLimit) return;
    onSplitTerminal();
  }, [hasReachedSplitLimit, onSplitTerminal]);
  const onSplitTerminalDownAction = useCallback(() => {
    if (hasReachedSplitLimit) return;
    onSplitTerminalDown();
  }, [hasReachedSplitLimit, onSplitTerminalDown]);
  const onNewTerminalAction = useCallback(() => {
    onNewTerminal();
  }, [onNewTerminal]);

  const terminalChromeActions: TerminalChromeActionItem[] = [
    {
      label: splitTerminalActionLabel,
      onClick: onSplitTerminalAction,
      disabled: hasReachedSplitLimit,
      children: <SquareSplitHorizontal className="size-3.25" />,
    },
    {
      label: splitTerminalDownActionLabel,
      onClick: onSplitTerminalDownAction,
      disabled: hasReachedSplitLimit,
      children: <SquareSplitVertical className="size-3.25" />,
    },
    {
      label: newTerminalActionLabel,
      onClick: onNewTerminalAction,
      children: <Plus className="size-3.25" />,
    },
    {
      label: closeTerminalActionLabel,
      onClick: () => onCloseTerminal(resolvedActiveTerminalId),
      children: <Trash2 className="size-3.25" />,
    },
  ];
  const showTerminalGroupTabs = resolvedTerminalGroups.length > 1;
  const topTabBarActions = terminalChromeActions;

  return (
    <aside
      className={cn(
        "thread-terminal-drawer relative flex w-full min-w-0 flex-col overflow-hidden bg-[var(--color-background-surface)]",
        isWorkspaceMode ? "h-full min-h-0" : "shrink-0 border-t border-border/70",
      )}
      style={isWorkspaceMode ? undefined : { height: `${drawerHeight}px` }}
    >
      {!isWorkspaceMode ? (
        <div
          className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize"
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerEnd}
          onPointerCancel={handleResizePointerEnd}
        />
      ) : null}

      {showTerminalGroupTabs ? (
        <TerminalWorkspaceTabBar
          terminalGroups={resolvedTerminalGroups}
          activeGroupId={resolvedActiveGroupId}
          terminalVisualIdentityById={terminalVisualIdentityById}
          actions={topTabBarActions}
          onActiveGroupChange={(groupId) => {
            const nextGroup = resolvedTerminalGroups.find((group) => group.id === groupId);
            if (!nextGroup) return;
            onActiveTerminalChange(nextGroup.activeTerminalId);
          }}
          onCloseGroup={onCloseTerminalGroup}
        />
      ) : null}

      <div className="min-h-0 w-full flex-1">
        <div
          className={cn(
            "flex h-full min-h-0",
            hasTerminalSidebar && !isWorkspaceMode ? "gap-1.5" : "",
          )}
        >
          <div className="min-w-0 flex-1 h-full">
            <TerminalViewportPane
              groupId={resolvedActiveGroupId}
              layout={activeGroupLayout}
              resolvedActiveTerminalId={resolvedActiveTerminalId}
              terminalVisualIdentityById={terminalVisualIdentityById}
              onActiveTerminalChange={onActiveTerminalChange}
              onResizeSplit={onResizeTerminalSplit}
              onSplitTerminalRight={
                hasReachedSplitLimit
                  ? undefined
                  : (terminalId) => {
                      onActiveTerminalChange(terminalId);
                      onSplitTerminal();
                    }
              }
              onSplitTerminalDown={
                hasReachedSplitLimit
                  ? undefined
                  : (terminalId) => {
                      onActiveTerminalChange(terminalId);
                      onSplitTerminalDown();
                    }
              }
              onNewTerminalTab={
                hasReachedSplitLimit
                  ? undefined
                  : (terminalId) => {
                      onNewTerminalTab(terminalId);
                    }
              }
              onMoveTerminalToGroup={isWorkspaceMode ? onMoveTerminalToGroup : undefined}
              onCloseTerminal={onCloseTerminal}
              presentationMode={presentationMode}
              onTogglePresentationMode={onTogglePresentationMode}
              onTogglePanel={onTogglePanel}
              isPanelOpen={isPanelOpen}
              renderViewport={(terminalId, options) => (
                <TerminalViewport
                  key={terminalId}
                  threadId={threadId}
                  terminalId={terminalId}
                  terminalLabel={terminalVisualIdentityById.get(terminalId)?.title ?? "Terminal"}
                  terminalCliKind={terminalVisualIdentityById.get(terminalId)?.cliKind ?? null}
                  cwd={cwd}
                  {...(runtimeEnv ? { runtimeEnv } : {})}
                  onSessionExited={() => onTerminalSessionExited(terminalId)}
                  onTerminalMetadataChange={onTerminalMetadataChange}
                  onTerminalActivityChange={onTerminalActivityChange}
                  onAddTerminalContext={onAddTerminalContext}
                  focusRequestId={focusRequestId}
                  autoFocus={options.autoFocus}
                  isVisible={isVisible && options.isVisible}
                />
              )}
            />
          </div>

          {hasTerminalSidebar && !isWorkspaceMode ? (
            <TerminalSidebar
              terminalIds={normalizedTerminalIds}
              terminalGroups={resolvedTerminalGroups}
              activeTerminalId={resolvedActiveTerminalId}
              activeGroupId={resolvedActiveGroupId}
              showGroupHeaders={showGroupHeaders}
              closeShortcutLabel={resolvedCloseShortcutLabel}
              terminalVisualIdentityById={terminalVisualIdentityById}
              actions={terminalChromeActions}
              onActiveTerminalChange={onActiveTerminalChange}
              onCloseTerminal={onCloseTerminal}
            />
          ) : null}
        </div>
      </div>
    </aside>
  );
}

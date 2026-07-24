// FILE: WorkspaceView.tsx
// Purpose: Render a dedicated terminal-only workspace page backed by a synthetic terminal scope.
// Layer: Workspace route surface

import { Plus, SettingsIcon } from "~/lib/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Button } from "~/components/ui/button";
import { RouteInsetSurface } from "./RouteInsetSurface";
import { SidebarHeaderNavigationControls } from "~/components/SidebarHeaderNavigationControls";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { useTerminalSurfaceController } from "~/hooks/useTerminalSurfaceController";
import { cn } from "~/lib/utils";
import { resolveTerminalNewAction } from "~/lib/terminalNewAction";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import {
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  CHAT_SURFACE_HEADER_PADDING_X_CLASS,
} from "./chat/chatHeaderControls";
import { CHAT_BACKGROUND_CLASS_NAME } from "./chat/composerPickerStyles";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import WorkspaceSettingsSheet from "./WorkspaceSettingsSheet";
import { onServerWelcome } from "~/wsNativeApi";
import { useWorkspaceStore, workspaceThreadId } from "~/workspaceStore";
import {
  DEFAULT_WORKSPACE_LAYOUT_PRESET_ID,
  ensureTerminalIdsForPreset,
  type WorkspaceLayoutPresetId,
} from "~/workspaceTerminalLayoutPresets";
import { randomTerminalId } from "./terminal/terminalSession";

export default function WorkspaceView({ workspaceId }: { workspaceId: string }) {
  const desktopTopBarTrafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  const desktopTopBarWindowControlsGutterClassName =
    useDesktopTopBarWindowControlsGutterClassName();
  const workspace = useWorkspaceStore((state) =>
    state.workspacePages.find((entry) => entry.id === workspaceId),
  );
  const homeDir = useWorkspaceStore((state) => state.homeDir);
  const ensureWorkspacePage = useWorkspaceStore((state) => state.ensureWorkspacePage);
  const renameWorkspace = useWorkspaceStore((state) => state.renameWorkspace);
  const setWorkspaceLayoutPreset = useWorkspaceStore((state) => state.setWorkspaceLayoutPreset);
  const setServerWorkspacePaths = useWorkspaceStore((state) => state.setServerWorkspacePaths);
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const threadId = workspaceThreadId(workspaceId);
  const terminal = useTerminalSurfaceController(threadId);
  const {
    terminalState,
    focusRequestId,
    bumpFocusRequest,
    openTerminalThreadPage,
    applyWorkspaceLayoutPreset,
    newTerminalGroup,
    splitRight,
    splitDown,
    createTerminalTab,
    moveTerminalToNewGroup,
    activateTerminal,
    closeTerminal,
    closeTerminalGroup,
    setTerminalHeight,
    resizeTerminalSplit,
    setTerminalMetadata,
    setTerminalActivity,
  } = terminal;
  const bootstrappedWorkspaceRef = useRef(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Draft keyed to the title it was seeded from: an external rename derives
  // straight back to the fresh title with no state-syncing effect.
  const [draftTitleState, setDraftTitleState] = useState<{ base: string; value: string } | null>(
    null,
  );
  const baseTitle = workspace?.title ?? "Workspace";
  const draftTitle =
    draftTitleState !== null && draftTitleState.base === baseTitle
      ? draftTitleState.value
      : baseTitle;
  const setDraftTitle = (value: string) => setDraftTitleState({ base: baseTitle, value });
  const workspaceLayoutPresetId = workspace?.layoutPresetId ?? DEFAULT_WORKSPACE_LAYOUT_PRESET_ID;

  useEffect(() => {
    ensureWorkspacePage(workspaceId);
  }, [ensureWorkspacePage, workspaceId]);

  useEffect(
    () =>
      onServerWelcome((payload) =>
        setServerWorkspacePaths({
          homeDir: payload.homeDir,
          chatWorkspaceRoot: payload.chatWorkspaceRoot,
          studioWorkspaceRoot: payload.studioWorkspaceRoot,
        }),
      ),
    [setServerWorkspacePaths],
  );

  useEffect(() => {
    if (!serverConfigQuery.data?.homeDir) {
      return;
    }
    setServerWorkspacePaths({
      homeDir: serverConfigQuery.data.homeDir,
      chatWorkspaceRoot: serverConfigQuery.data.chatWorkspaceRoot,
      studioWorkspaceRoot: serverConfigQuery.data.studioWorkspaceRoot,
    });
  }, [
    serverConfigQuery.data?.chatWorkspaceRoot,
    serverConfigQuery.data?.homeDir,
    serverConfigQuery.data?.studioWorkspaceRoot,
    setServerWorkspacePaths,
  ]);

  useEffect(() => {
    if (!renaming) {
      return;
    }
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renaming]);

  useEffect(() => {
    bootstrappedWorkspaceRef.current = false;
  }, [workspaceId]);

  useEffect(() => {
    if (bootstrappedWorkspaceRef.current || !homeDir || terminalState.terminalOpen) {
      return;
    }
    bootstrappedWorkspaceRef.current = true;
    const nextTerminalIds = ensureTerminalIdsForPreset(
      terminalState.terminalIds,
      workspaceLayoutPresetId,
      randomTerminalId,
    );
    applyWorkspaceLayoutPreset(threadId, workspaceLayoutPresetId, nextTerminalIds);
    openTerminalThreadPage(threadId, { terminalOnly: true });
  }, [
    applyWorkspaceLayoutPreset,
    homeDir,
    openTerminalThreadPage,
    terminalState.terminalIds,
    terminalState.terminalOpen,
    threadId,
    workspaceLayoutPresetId,
  ]);

  const commitRename = () => {
    if (!workspace) {
      setRenaming(false);
      return;
    }
    renameWorkspace(workspace.id, draftTitle);
    setRenaming(false);
  };

  const restoreTerminalWorkspace = useCallback(
    (presetId: WorkspaceLayoutPresetId = workspaceLayoutPresetId) => {
      const nextTerminalIds = ensureTerminalIdsForPreset(
        terminalState.terminalIds,
        presetId,
        randomTerminalId,
      );
      applyWorkspaceLayoutPreset(threadId, presetId, nextTerminalIds);
      openTerminalThreadPage(threadId, { terminalOnly: true });
      bumpFocusRequest();
    },
    [
      applyWorkspaceLayoutPreset,
      bumpFocusRequest,
      openTerminalThreadPage,
      terminalState.terminalIds,
      threadId,
      workspaceLayoutPresetId,
    ],
  );

  const applyWorkspacePresetSelection = (presetId: WorkspaceLayoutPresetId) => {
    if (!workspace) {
      return;
    }
    setWorkspaceLayoutPreset(workspace.id, presetId);
    const nextTerminalIds = ensureTerminalIdsForPreset(
      terminalState.terminalIds,
      presetId,
      randomTerminalId,
    );
    applyWorkspaceLayoutPreset(threadId, presetId, nextTerminalIds);
    openTerminalThreadPage(threadId, { terminalOnly: true });
    bumpFocusRequest();
  };

  const createWorkspaceTerminal = () => {
    if (!terminalState.terminalOpen) {
      restoreTerminalWorkspace();
      return;
    }
    newTerminalGroup();
  };

  const createWorkspaceTerminalFromShortcut = () => {
    const action = resolveTerminalNewAction({
      terminalOpen: terminalState.terminalOpen,
      activeTerminalId: terminalState.activeTerminalId,
      activeTerminalGroupId: terminalState.activeTerminalGroupId,
      terminalGroups: terminalState.terminalGroups,
    });

    if (action.kind === "new-group") {
      createWorkspaceTerminal();
      return;
    }

    createTerminalTab(action.targetTerminalId);
  };

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action !== "new-terminal-tab") return;
      createWorkspaceTerminalFromShortcut();
    });

    return () => {
      unsubscribe?.();
    };
  }, [createWorkspaceTerminalFromShortcut]);

  const terminalDrawerProps = {
    threadId,
    cwd: homeDir ?? "",
    height: terminalState.terminalHeight,
    terminalIds: terminalState.terminalIds,
    terminalLabelsById: terminalState.terminalLabelsById,
    terminalTitleOverridesById: terminalState.terminalTitleOverridesById,
    terminalCliKindsById: terminalState.terminalCliKindsById,
    terminalAttentionStatesById: terminalState.terminalAttentionStatesById ?? {},
    runningTerminalIds: terminalState.runningTerminalIds,
    activeTerminalId: terminalState.activeTerminalId,
    terminalGroups: terminalState.terminalGroups,
    activeTerminalGroupId: terminalState.activeTerminalGroupId,
    focusRequestId,
    onSplitTerminal: splitRight,
    onSplitTerminalDown: splitDown,
    onNewTerminal: createWorkspaceTerminal,
    onNewTerminalTab: createTerminalTab,
    onMoveTerminalToGroup: moveTerminalToNewGroup,
    onActiveTerminalChange: activateTerminal,
    onCloseTerminal: closeTerminal,
    onCloseTerminalGroup: closeTerminalGroup,
    onHeightChange: setTerminalHeight,
    onSessionExited: terminal.onSessionExited,
    onResizeTerminalSplit: resizeTerminalSplit,
    onTerminalMetadataChange: setTerminalMetadata,
    onTerminalActivityChange: setTerminalActivity,
    onAddTerminalContext: () => {},
  };

  return (
    <RouteInsetSurface>
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          CHAT_BACKGROUND_CLASS_NAME,
        )}
      >
        <header
          className={cn(
            CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
            CHAT_SURFACE_HEADER_PADDING_X_CLASS,
            "drag-region",
            desktopTopBarTrafficLightGutterClassName,
            desktopTopBarWindowControlsGutterClassName,
          )}
        >
          <div className={cn("flex items-center gap-2 sm:gap-3", CHAT_SURFACE_HEADER_HEIGHT_CLASS)}>
            <SidebarHeaderNavigationControls />
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {renaming ? (
                <input
                  ref={renameInputRef}
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitRename();
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setDraftTitle(workspace?.title ?? "Workspace");
                      setRenaming(false);
                    }
                  }}
                  className="h-7 max-w-[16rem] rounded-md border border-border bg-background px-2 text-sm font-medium outline-none focus:border-ring"
                />
              ) : (
                <h2
                  className="max-w-[clamp(16rem,50vw,40rem)] cursor-default truncate text-sm font-medium text-foreground"
                  title="Double-click to rename"
                  onDoubleClick={() => setRenaming(true)}
                >
                  {workspace?.title ?? "Workspace"}
                </h2>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5 [-webkit-app-region:no-drag]">
              <Button
                size="xs"
                variant="outline"
                className="gap-1.5"
                onClick={createWorkspaceTerminal}
              >
                <Plus className="size-3" />
                <span className="hidden sm:inline">Terminal</span>
              </Button>
              <Button
                size="icon-xs"
                variant="outline"
                onClick={() => setSettingsOpen(true)}
                aria-label="Workspace settings"
              >
                <SettingsIcon className="size-3" />
              </Button>
            </div>
          </div>
        </header>

        <div className="min-h-0 min-w-0 flex-1">
          {!homeDir ? (
            <div className="flex h-full items-center justify-center px-6">
              <div className="max-w-sm text-center">
                <div className="text-sm font-medium text-foreground/85">Loading workspace</div>
                <div className="mt-1 text-sm text-muted-foreground">
                  Waiting for the renderer to resolve your home directory.
                </div>
              </div>
            </div>
          ) : terminalState.terminalOpen ? (
            <ThreadTerminalDrawer
              key={`${workspaceId}-workspace`}
              {...terminalDrawerProps}
              presentationMode="workspace"
              isVisible
            />
          ) : (
            <div className="flex h-full items-center justify-center px-6">
              <div className="max-w-sm rounded-3xl border border-border/70 bg-card/40 p-6 text-center shadow-sm">
                <div className="text-base font-medium text-foreground/88">
                  This workspace has no open terminals
                </div>
                <div className="mt-2 text-sm leading-6 text-muted-foreground">
                  Open a fresh terminal rooted in your home directory and start from there.
                </div>
                <div className="mt-5">
                  <Button onClick={() => restoreTerminalWorkspace()}>
                    <Plus className="size-4" />
                    New terminal
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      <WorkspaceSettingsSheet
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        selectedPresetId={workspaceLayoutPresetId}
        onSelectPreset={applyWorkspacePresetSelection}
        workspaceTitle={workspace?.title ?? "Workspace"}
      />
    </RouteInsetSurface>
  );
}

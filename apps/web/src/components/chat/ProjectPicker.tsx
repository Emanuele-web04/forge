// FILE: ProjectPicker.tsx
// Purpose: Folder selector beneath the new-chat composer that groups active folders and home
//          folders while always creating chats as rows inside the shared Chats container.
// Layer: Chat / empty-state entrypoint

import {
  Fragment,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from "react";
import { type ProjectDirectoryEntry, type ProjectId, type SpaceId } from "@synara/contracts";
import { readNativeApi } from "../../nativeApi";
import { useStore } from "../../store";
import { createSidebarDisplayThreadsSelector } from "../../storeSelectors";
import { PlusIcon, XIcon } from "~/lib/icons";
import { getLocalFoldersGroupLabel } from "~/lib/localFoldersGroupLabel";
import { groupItemsBySpace, spaceDisplayName } from "~/lib/spaceGrouping";
import { cn } from "~/lib/utils";
import { FolderClosed } from "../FolderClosed";
import { SpaceIcon } from "../SpaceIcon";
import { PickerTriggerButton } from "./PickerTriggerButton";
import { PickerPanelShell } from "./PickerPanelShell";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSeparator,
  ComboboxTrigger,
} from "../ui/combobox";
import { useWorkspaceStore } from "../../workspaceStore";
import { useSpacesUiStore } from "../../spacesUiStore";

interface ProjectPickerProps {
  align?: "start" | "center" | "end";
  side?: "top" | "bottom";
  selectionMode?: "workspace-root" | "project";
  showResetToHome?: boolean;
  selectedProjectId?: ProjectId | null;
  selectedWorkspaceRoot?: string | null;
  onSelectProject?: ((projectId: ProjectId) => void | Promise<void>) | undefined;
  onSelectWorkspaceRoot?: ((workspaceRoot: string) => void) | undefined;
  onCreateProjectFromPath?: ((workspaceRoot: string) => void | Promise<void>) | undefined;
  onResetToHome?: (() => void | Promise<void>) | undefined;
  /** Class override for the trigger button (e.g. tighter height in the composer tray). */
  triggerClassName?: string;
  /**
   * Replaces the default PickerTriggerButton with a custom trigger element (e.g. the inline
   * project name in the new-chat heading). The element receives the combobox trigger props.
   */
  renderTrigger?: ReactElement<Record<string, unknown>>;
  /** Copy overrides for folder-tagging contexts (e.g. Studio) where picking never creates a project. */
  emptyTriggerLabel?: string;
  addActionLabel?: string;
  resetActionLabel?: string;
  searchPlaceholder?: string;
}

interface ActiveFolderOption {
  projectId: ProjectId | null;
  spaceId: SpaceId | null;
  spaceName: string;
  cwd: string;
  primaryLabel: string;
  secondaryLabel: string | null;
}

function basenameOfPath(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  const basename = separatorIndex === -1 ? normalized : normalized.slice(separatorIndex + 1);
  return basename.length > 0 ? basename : null;
}

function directorySearchHaystack(entry: ProjectDirectoryEntry): string {
  return [entry.name, entry.path].join(" ").toLowerCase();
}

function joinDirectoryPath(rootPath: string, relativePath: string): string {
  if (!relativePath) return rootPath;
  const separator = rootPath.includes("\\") ? "\\" : "/";
  const normalizedRoot = rootPath.endsWith(separator) ? rootPath.slice(0, -1) : rootPath;
  const normalizedRelative = relativePath.split(/[\\/]+/).join(separator);
  return `${normalizedRoot}${separator}${normalizedRelative}`;
}

function getNavigatorPlatform(): string {
  const navigatorLike = globalThis.navigator as
    | (Navigator & { userAgentData?: { platform?: string } })
    | undefined;
  return [navigatorLike?.platform, navigatorLike?.userAgentData?.platform]
    .filter(Boolean)
    .join(" ");
}

export const ProjectPicker = memo(function ProjectPicker({
  align = "start",
  side = "bottom",
  selectionMode = "workspace-root",
  showResetToHome = false,
  selectedProjectId = null,
  selectedWorkspaceRoot = null,
  onSelectProject,
  onSelectWorkspaceRoot,
  onCreateProjectFromPath,
  onResetToHome,
  triggerClassName,
  renderTrigger,
  emptyTriggerLabel = "Work in a project",
  addActionLabel,
  resetActionLabel = "Don't work in a project",
  searchPlaceholder = "Search projects",
}: ProjectPickerProps) {
  const projects = useStore((state) => state.projects);
  const spaces = useStore((state) => state.spaces);
  const sidebarThreads = useStore(useMemo(() => createSidebarDisplayThreadsSelector(), []));
  const activeSpaceId = useSpacesUiStore((state) => state.activeSpaceId);
  const homeDir = useWorkspaceStore((state) => state.homeDir);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [isPicking, setIsPicking] = useState(false);
  const [isLoadingDirectories, setIsLoadingDirectories] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [directoryEntries, setDirectoryEntries] = useState<readonly ProjectDirectoryEntry[]>([]);
  const isProjectSelectionMode = selectionMode === "project";

  // Manual memoization kept: this file does not compile under React Compiler (see compile-report).
  const activeFolderOptions = useMemo(() => {
    const seen = new Set<string>();
    const nextOptions: ActiveFolderOption[] = [];
    const projectById = new Map(projects.map((project) => [project.id, project] as const));
    const getSpaceName = (spaceId: SpaceId | null) => spaceDisplayName(spaceId, spaces);

    for (const project of projects.filter((project) => project.kind === "project")) {
      const folderName = basenameOfPath(project.cwd) ?? project.folderName ?? project.name;
      if (!folderName || folderName.startsWith(".") || seen.has(project.cwd)) {
        continue;
      }
      seen.add(project.cwd);
      const primaryLabel = project.localName?.trim() || folderName;
      const secondaryLabel =
        project.localName?.trim() && project.localName.trim() !== folderName ? folderName : null;
      const spaceId = project.spaceId ?? null;
      nextOptions.push({
        projectId: project.id,
        spaceId,
        spaceName: getSpaceName(spaceId),
        cwd: project.cwd,
        primaryLabel,
        secondaryLabel,
      });
    }

    if (!isProjectSelectionMode) {
      for (const thread of sidebarThreads) {
        const workspaceRoot = thread.worktreePath ?? null;
        const folderName = basenameOfPath(workspaceRoot);
        if (
          !workspaceRoot ||
          !folderName ||
          folderName.startsWith(".") ||
          seen.has(workspaceRoot)
        ) {
          continue;
        }
        seen.add(workspaceRoot);
        const spaceId = projectById.get(thread.projectId)?.spaceId ?? null;
        nextOptions.push({
          projectId: null,
          spaceId,
          spaceName: getSpaceName(spaceId),
          cwd: workspaceRoot,
          primaryLabel: folderName,
          secondaryLabel: null,
        });
      }
    }

    const selectedFolderName = basenameOfPath(selectedWorkspaceRoot);
    if (
      !isProjectSelectionMode &&
      selectedWorkspaceRoot &&
      selectedFolderName &&
      !selectedFolderName.startsWith(".") &&
      !seen.has(selectedWorkspaceRoot)
    ) {
      nextOptions.unshift({
        projectId: null,
        spaceId: activeSpaceId,
        spaceName: getSpaceName(activeSpaceId),
        cwd: selectedWorkspaceRoot,
        primaryLabel: selectedFolderName,
        secondaryLabel: null,
      });
    }

    return nextOptions;
  }, [
    activeSpaceId,
    isProjectSelectionMode,
    projects,
    selectedWorkspaceRoot,
    sidebarThreads,
    spaces,
  ]);
  const activeFolderPathSet = useMemo(
    () => new Set(activeFolderOptions.map((entry) => entry.cwd)),
    [activeFolderOptions],
  );
  const localFolderOptions = useMemo(() => {
    if (isProjectSelectionMode) return [];
    return directoryEntries
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => ({
        absolutePath: homeDir ? joinDirectoryPath(homeDir, entry.path) : entry.path,
        entry,
      }))
      .filter((entry) => !activeFolderPathSet.has(entry.absolutePath));
  }, [activeFolderPathSet, directoryEntries, homeDir, isProjectSelectionMode]);
  const localFoldersGroupLabel = useMemo(
    () => getLocalFoldersGroupLabel(homeDir, getNavigatorPlatform()),
    [homeDir],
  );

  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const matchingActiveFolderOptions = useMemo(() => {
    if (normalizedQuery.length === 0) return activeFolderOptions;
    return activeFolderOptions.filter((entry) =>
      [entry.primaryLabel, entry.secondaryLabel, entry.spaceName, entry.cwd]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [activeFolderOptions, normalizedQuery]);
  const filteredActiveFolderGroups = useMemo(
    () =>
      groupItemsBySpace({
        items: matchingActiveFolderOptions,
        spaces,
        activeSpaceId,
        spaceIdOf: (option) => option.spaceId,
      }),
    [activeSpaceId, matchingActiveFolderOptions, spaces],
  );
  const filteredActiveFolderOptions = useMemo(
    () => filteredActiveFolderGroups.flatMap((group) => group.items),
    [filteredActiveFolderGroups],
  );
  const filteredLocalFolderOptions = useMemo(() => {
    if (normalizedQuery.length === 0) return localFolderOptions;
    return localFolderOptions.filter(({ entry }) =>
      directorySearchHaystack(entry).includes(normalizedQuery),
    );
  }, [localFolderOptions, normalizedQuery]);

  const selectableDirectoryPaths = useMemo(
    () => [
      ...activeFolderOptions.map((entry) => entry.cwd),
      ...localFolderOptions.map((entry) => entry.absolutePath),
    ],
    [activeFolderOptions, localFolderOptions],
  );
  const filteredDirectoryPaths = useMemo(
    () => [
      ...filteredActiveFolderOptions.map((entry) => entry.cwd),
      ...filteredLocalFolderOptions.map((entry) => entry.absolutePath),
    ],
    [filteredActiveFolderOptions, filteredLocalFolderOptions],
  );
  const selectedFolderOption = useMemo(() => {
    if (isProjectSelectionMode) {
      if (!selectedProjectId) return null;
      return activeFolderOptions.find((entry) => entry.projectId === selectedProjectId) ?? null;
    }
    if (!selectedWorkspaceRoot) return null;
    return (
      activeFolderOptions.find((entry) => entry.cwd === selectedWorkspaceRoot) ??
      localFolderOptions
        .filter(({ absolutePath }) => absolutePath === selectedWorkspaceRoot)
        .map(({ entry, absolutePath }) => ({
          cwd: absolutePath,
          primaryLabel: entry.name,
          secondaryLabel: null,
        }))[0] ??
      null
    );
  }, [
    activeFolderOptions,
    isProjectSelectionMode,
    localFolderOptions,
    selectedProjectId,
    selectedWorkspaceRoot,
  ]);
  const triggerLabel = selectedFolderOption ? (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="min-w-0 truncate text-[var(--color-text-foreground)]">
        {selectedFolderOption.primaryLabel}
      </span>
      {selectedFolderOption.secondaryLabel ? (
        <span className="min-w-0 truncate text-muted-foreground/60 text-xs">
          {selectedFolderOption.secondaryLabel}
        </span>
      ) : null}
    </span>
  ) : (
    emptyTriggerLabel
  );

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setQuery("");
      setErrorMessage(null);
    }
  }, []);

  useEffect(() => {
    if (
      isProjectSelectionMode ||
      !open ||
      !homeDir ||
      directoryEntries.length > 0 ||
      isLoadingDirectories
    ) {
      return;
    }
    // Timeout-0 keeps every state write asynchronous (no wasted pre-paint
    // render), which also keeps this component eligible for React Compiler.
    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      if (cancelled) return;
      const api = readNativeApi();
      if (!api) {
        setErrorMessage("App is still connecting. Try again in a moment.");
        return;
      }

      setIsLoadingDirectories(true);
      setErrorMessage(null);
      void api.projects
        .listDirectories({ cwd: homeDir })
        .then((result) => {
          setDirectoryEntries(
            result.entries.flatMap((entry) =>
              entry.kind === "directory"
                ? [
                    {
                      path: entry.path,
                      name: entry.name,
                      hasChildren: entry.hasChildren ?? false,
                      ...(entry.parentPath ? { parentPath: entry.parentPath } : {}),
                    } satisfies ProjectDirectoryEntry,
                  ]
                : [],
            ),
          );
        })
        .catch((error) => {
          setErrorMessage(error instanceof Error ? error.message : "Unable to load folders.");
        })
        .finally(() => {
          setIsLoadingDirectories(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [directoryEntries.length, homeDir, isLoadingDirectories, isProjectSelectionMode, open]);

  const handleSelectActiveFolder = useCallback(
    (folder: ActiveFolderOption) => {
      try {
        // Existing projects should switch the draft into that project; raw paths stay workspace roots.
        const selection =
          folder.projectId && onSelectProject
            ? onSelectProject(folder.projectId)
            : isProjectSelectionMode
              ? undefined
              : onSelectWorkspaceRoot?.(folder.cwd);
        void Promise.resolve(selection)
          .then(() => {
            setOpen(false);
          })
          .catch((error) => {
            setErrorMessage(error instanceof Error ? error.message : "Unable to select project.");
          });
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Unable to select project.");
      }
    },
    [isProjectSelectionMode, onSelectProject, onSelectWorkspaceRoot],
  );

  const handleAddNewProject = useCallback(async () => {
    if (isPicking) return;
    const api = readNativeApi();
    if (!api) {
      setErrorMessage("App is still connecting. Try again in a moment.");
      return;
    }

    setIsPicking(true);
    setErrorMessage(null);
    try {
      const pickedPath = await api.dialogs.pickFolder();
      if (!pickedPath) {
        setIsPicking(false);
        return;
      }
      if (onCreateProjectFromPath) {
        await onCreateProjectFromPath(pickedPath);
      } else {
        onSelectWorkspaceRoot?.(pickedPath);
      }
      setIsPicking(false);
      setOpen(false);
    } catch (error) {
      setIsPicking(false);
      setErrorMessage(error instanceof Error ? error.message : "Unable to open the folder picker.");
    }
  }, [isPicking, onCreateProjectFromPath, onSelectWorkspaceRoot]);

  const handleResetToHome = useCallback(() => {
    try {
      void Promise.resolve(onResetToHome?.())
        .then(() => {
          setOpen(false);
        })
        .catch((error) => {
          setErrorMessage(error instanceof Error ? error.message : "Unable to update project.");
        });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to update project.");
    }
  }, [onResetToHome]);

  const shouldShowResetToHome = showResetToHome || isProjectSelectionMode;
  const addProjectLabel =
    addActionLabel ?? (isProjectSelectionMode ? "New project" : "Add new project");
  const loadingAddProjectLabel = isProjectSelectionMode
    ? "Adding project..."
    : "Opening folder picker...";

  const renderActiveFolderOption = (folder: ActiveFolderOption, index: number) => {
    const selected = isProjectSelectionMode
      ? folder.projectId === selectedProjectId
      : folder.cwd === selectedWorkspaceRoot;
    return (
      <ComboboxItem
        hideIndicator={!selected}
        key={folder.cwd}
        index={index}
        value={folder.cwd}
        onClick={() => {
          handleSelectActiveFolder(folder);
        }}
        className={cn(
          selected &&
            "bg-[var(--color-background-elevated-secondary)] text-[var(--color-text-foreground)]",
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <FolderClosed className="size-3.5 shrink-0 text-muted-foreground/70" />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-baseline gap-1.5">
              <span className="min-w-0 truncate">{folder.primaryLabel}</span>
              {folder.secondaryLabel ? (
                <span className="min-w-0 truncate text-muted-foreground/60 text-xs">
                  {folder.secondaryLabel}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </ComboboxItem>
    );
  };

  return (
    <Combobox
      items={selectableDirectoryPaths}
      filteredItems={filteredDirectoryPaths}
      autoHighlight
      onOpenChange={handleOpenChange}
      open={open}
    >
      <ComboboxTrigger
        render={
          renderTrigger ?? (
            <PickerTriggerButton
              data-testid={
                isProjectSelectionMode ? "project-picker-trigger" : "workspace-picker-trigger"
              }
              icon={<FolderClosed className="size-3.5" />}
              label={triggerLabel}
              hideChevron
              {...(triggerClassName ? { className: triggerClassName } : {})}
            />
          )
        }
      />
      <ComboboxPopup align={align} side={side} className="p-0">
        <PickerPanelShell
          searchPlaceholder={searchPlaceholder}
          query={query}
          onQueryChange={setQuery}
          footer={
            <>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-[var(--color-background-elevated-secondary)] hover:text-[var(--color-text-foreground)] disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => void handleAddNewProject()}
                disabled={isPicking}
              >
                <PlusIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
                <span className="truncate">
                  {isPicking ? loadingAddProjectLabel : addProjectLabel}
                </span>
              </button>
              {shouldShowResetToHome ? (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-[var(--color-background-elevated-secondary)] hover:text-[var(--color-text-foreground)]"
                  onClick={handleResetToHome}
                >
                  <XIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
                  <span className="truncate">{resetActionLabel}</span>
                </button>
              ) : null}
              {errorMessage ? (
                <div className="px-2 pb-1 text-destructive text-xs">{errorMessage}</div>
              ) : null}
            </>
          }
        >
          <ComboboxEmpty>
            {isLoadingDirectories
              ? "Loading folders…"
              : activeFolderOptions.length === 0 && localFolderOptions.length === 0
                ? "No folders found"
                : "No matches"}
          </ComboboxEmpty>
          <ComboboxList className="max-h-64">
            {filteredActiveFolderGroups.map((group, groupIndex) => {
              const precedingOptionCount = filteredActiveFolderGroups
                .slice(0, groupIndex)
                .reduce((count, candidate) => count + candidate.items.length, 0);
              return (
                <Fragment key={group.key}>
                  {groupIndex > 0 ? <ComboboxSeparator /> : null}
                  <ComboboxGroup>
                    <ComboboxGroupLabel className="flex items-center gap-1.5">
                      <SpaceIcon icon={group.icon} className="size-3 shrink-0" />
                      <span className="min-w-0 truncate">{group.label}</span>
                    </ComboboxGroupLabel>
                    {group.items.map((folder, index) =>
                      renderActiveFolderOption(folder, precedingOptionCount + index),
                    )}
                  </ComboboxGroup>
                </Fragment>
              );
            })}
            {filteredActiveFolderOptions.length > 0 && filteredLocalFolderOptions.length > 0 ? (
              <ComboboxSeparator />
            ) : null}
            {filteredLocalFolderOptions.length > 0 ? (
              <ComboboxGroup>
                <ComboboxGroupLabel>{localFoldersGroupLabel}</ComboboxGroupLabel>
                {filteredLocalFolderOptions.map(({ absolutePath, entry }, index) => (
                  <ComboboxItem
                    hideIndicator={absolutePath !== selectedWorkspaceRoot}
                    key={absolutePath}
                    index={filteredActiveFolderOptions.length + index}
                    value={absolutePath}
                    onClick={() => {
                      onSelectWorkspaceRoot?.(absolutePath);
                      setOpen(false);
                    }}
                    className={cn(
                      absolutePath === selectedWorkspaceRoot &&
                        "bg-[var(--color-background-elevated-secondary)] text-[var(--color-text-foreground)]",
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <FolderClosed className="size-3.5 shrink-0 text-muted-foreground/70" />
                      <span className="truncate">{entry.name}</span>
                    </div>
                  </ComboboxItem>
                ))}
              </ComboboxGroup>
            ) : null}
          </ComboboxList>
        </PickerPanelShell>
      </ComboboxPopup>
    </Combobox>
  );
});

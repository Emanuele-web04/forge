// FILE: CreateProjectDialog.tsx
// Purpose: Single entry point for adding a project — typed path, source folder
//          (drag/drop or native browse), and destination Space.
// Layer: Web UI dialog
// Exports: CreateProjectDialog, CreateProjectSubmitValue

import { type GitHubProjectProvisionProgressEvent, type SpaceId } from "@synara/contracts";
import { parseGitHubRepositoryInput } from "@synara/shared/githubRepository";
import { normalizeProjectDirectoryName } from "@synara/shared/projectDirectoryName";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { isElectron } from "../env";
import {
  isDroppedComposerDirectory,
  resolveDroppedFileAbsolutePath,
} from "../lib/composerDropPaths";
import { VOID_SPACE_KEY, spaceKey, toSpaceIconName } from "../lib/spaceGrouping";
import { createSpace } from "../lib/spaces";
import { readNativeApi } from "../nativeApi";
import { randomUUID } from "../lib/utils";
import { joinProjectPath } from "../lib/projectPaths";
import type { Space } from "../types";
import { useVoidSpace } from "../voidSpaceStore";
import { cn } from "~/lib/utils";

import { FolderClosed } from "./FolderClosed";
import {
  CreateGitHubProjectFields,
  PROJECT_DIALOG_FIELD_CONTROL_CLASS_NAME,
} from "./CreateGitHubProjectFields";
import { ProjectSourceSegmentedPicker } from "./ProjectSourceSegmentedPicker";
import { describeAddProjectError } from "./Sidebar.logic";
import { SpaceEditorDialog, type SpaceEditorValue } from "./SpaceEditorDialog";
import { SpaceIcon } from "./SpaceIcon";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  dialogFieldLabelClassName,
} from "./ui/dialog";
import { ComposerPickerSelectPopup } from "./chat/ComposerPickerMenuPopup";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import { Select, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { CentralIcon } from "~/lib/central-icons";

// Inputs share one fixed height + radius so every control in the dialog reads
// as the same size (mirrors EditProfileDialog's field styling).
function isFileDrag(event: globalThis.DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

type DroppedFolderResult = { readonly path: string } | { readonly error: string };

function resolveDroppedFolder(dataTransfer: DataTransfer): DroppedFolderResult | null {
  const item = Array.from(dataTransfer.items).find((entry) => entry.kind === "file");
  const file = item?.getAsFile() ?? dataTransfer.files[0] ?? null;
  if (!item || !file) return null;
  if (!isDroppedComposerDirectory(item)) {
    return { error: "Drop a folder, not a file." };
  }
  const absolutePath = resolveDroppedFileAbsolutePath(file);
  if (!absolutePath) {
    return { error: "Could not read the folder's path. Use browse or type it instead." };
  }
  return { path: absolutePath };
}

interface CreateLocalProjectSubmitValue {
  readonly source: "local";
  readonly workspaceRoot: string;
  /** Destination Space; `null` is Void (unassigned). */
  readonly spaceId: SpaceId | null;
  /** True when the path was typed/edited by hand, so a missing folder may be created. */
  readonly createIfMissing: boolean;
}

interface CreateGitHubProjectSubmitValue {
  readonly source: "github";
  readonly operationId: string;
  readonly repository: string;
  readonly destinationParent: string;
  readonly directoryName: string;
  readonly spaceId: SpaceId | null;
}

export type CreateProjectSubmitValue =
  | CreateLocalProjectSubmitValue
  | CreateGitHubProjectSubmitValue;

export interface CreateProjectSubmitOptions {
  readonly signal: AbortSignal;
}

export function CreateProjectDialog(props: {
  open: boolean;
  githubProvisioningAvailable: boolean;
  spaces: ReadonlyArray<Space>;
  activeSpaceId: SpaceId | null;
  defaultCloneParent: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (value: CreateProjectSubmitValue, options: CreateProjectSubmitOptions) => Promise<void>;
}) {
  const [source, setSource] = useState<"local" | "github">("local");
  const [path, setPath] = useState("");
  const [repositoryInput, setRepositoryInput] = useState("");
  const [destinationParent, setDestinationParent] = useState("");
  const [directoryName, setDirectoryName] = useState("");
  const [directoryNameEdited, setDirectoryNameEdited] = useState(false);
  const [provisionProgress, setProvisionProgress] = useState<string | null>(null);
  /**
   * The last path delivered verbatim by the native picker or an OS drop. Those
   * folders exist by construction, so only hand-typed (or hand-edited) paths
   * opt into create-if-missing — the same split the old Browse/Type-path pair had.
   */
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const [selectedSpaceKey, setSelectedSpaceKey] = useState<string>(VOID_SPACE_KEY);
  const [spaceEditorOpen, setSpaceEditorOpen] = useState(false);
  /**
   * A space created from this dialog, kept locally until the refreshed shell
   * snapshot delivers it through `props.spaces` — otherwise submitting right
   * after creating would not find the id and silently fall back to Void.
   */
  const [createdSpace, setCreatedSpace] = useState<Space | null>(null);
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const openedRef = useRef(false);
  const submitAbortRef = useRef<AbortController | null>(null);
  const activeOperationIdRef = useRef<string | null>(null);
  const fieldId = useId();
  const pathInputId = `${fieldId}-path`;
  const repositoryInputId = `${fieldId}-repository`;
  const destinationParentInputId = `${fieldId}-destination-parent`;
  const directoryNameInputId = `${fieldId}-directory-name`;
  const submitButtonId = `${fieldId}-submit`;
  const sourceFolderLabelId = `${fieldId}-source-folder`;
  const spaceLabelId = `${fieldId}-space`;
  const errorId = `${fieldId}-error`;

  useEffect(() => {
    // Seed on the closed -> open transition only, mirroring SpaceEditorDialog.
    if (props.open === openedRef.current) return;
    openedRef.current = props.open;
    if (!props.open) return;
    setSource("local");
    setPath("");
    setRepositoryInput("");
    setDestinationParent(props.defaultCloneParent);
    setDirectoryName("");
    setDirectoryNameEdited(false);
    setProvisionProgress(null);
    submitAbortRef.current = null;
    activeOperationIdRef.current = null;
    setPickedPath(null);
    setSelectedSpaceKey(spaceKey(props.activeSpaceId));
    setSpaceEditorOpen(false);
    setCreatedSpace(null);
    setIsPickingFolder(false);
    setIsDropTarget(false);
    setSubmitting(false);
    setFormError(null);
    // Deferred a frame: the dialog moves focus itself on open, so focusing the
    // path field has to happen after that lands or it is immediately undone.
    const frame = requestAnimationFrame(() => document.getElementById(pathInputId)?.focus());
    return () => cancelAnimationFrame(frame);
  }, [pathInputId, props.activeSpaceId, props.defaultCloneParent, props.open]);

  useEffect(() => {
    if (!props.githubProvisioningAvailable && source === "github") {
      setSource("local");
    }
  }, [props.githubProvisioningAvailable, source]);

  const trimmedPath = path.trim();
  const parsedRepository = parseGitHubRepositoryInput(repositoryInput);
  const trimmedDestinationParent = destinationParent.trim();
  const trimmedDirectoryName = directoryName.trim();
  const normalizedDirectoryName = normalizeProjectDirectoryName(directoryName);
  const formErrorMeaning = formError ? describeAddProjectError(formError) : null;
  const spaces =
    createdSpace && !props.spaces.some((space) => space.id === createdSpace.id)
      ? [...props.spaces, createdSpace]
      : props.spaces;
  const voidSpace = useVoidSpace();

  useEffect(() => {
    if (!props.open) return;
    const api = readNativeApi();
    if (!api) return;
    return api.projects.onProvisionProgress((event: GitHubProjectProvisionProgressEvent) => {
      if (event.operationId !== activeOperationIdRef.current) return;
      if (event.kind === "completed") {
        setProvisionProgress("Project added");
        return;
      }
      setProvisionProgress(event.message);
    });
  }, [props.open]);

  const applyPickedFolder = useCallback(
    (picked: string) => {
      setPath(picked);
      setPickedPath(picked);
      setFormError(null);
      // Land focus on the confirm button so a plain Enter finishes the flow.
      requestAnimationFrame(() => document.getElementById(submitButtonId)?.focus());
    },
    [submitButtonId],
  );

  const applyDestinationParent = useCallback(
    (picked: string) => {
      setDestinationParent(picked);
      setFormError(null);
      requestAnimationFrame(() => document.getElementById(directoryNameInputId)?.focus());
    },
    [directoryNameInputId],
  );

  const handleBrowse = async () => {
    if (isPickingFolder || submitting) return;
    const api = readNativeApi();
    if (!api) {
      setFormError("The app server is unavailable.");
      return;
    }
    setIsPickingFolder(true);
    // No try/finally: the React Compiler skips optimizing components that use it.
    try {
      const picked = await api.dialogs.pickFolder();
      if (picked) {
        if (source === "github") applyDestinationParent(picked);
        else applyPickedFolder(picked);
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Unable to open the folder picker.");
    }
    setIsPickingFolder(false);
  };

  // While the dialog is open it is the only interactive surface, so accept a
  // folder drop anywhere in the window (capture phase). A tiny drop zone is
  // easy to miss and a stray drop outside it would otherwise vanish silently.
  useEffect(() => {
    if (!props.open || !isElectron || source !== "local") return;
    let dragDepth = 0;
    const handleDragEnter = (event: globalThis.DragEvent) => {
      if (!isFileDrag(event)) return;
      dragDepth += 1;
      setIsDropTarget(true);
    };
    const handleDragOver = (event: globalThis.DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const handleDragLeave = (event: globalThis.DragEvent) => {
      if (!isFileDrag(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setIsDropTarget(false);
    };
    const handleDrop = (event: globalThis.DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepth = 0;
      setIsDropTarget(false);
      const dropped = event.dataTransfer ? resolveDroppedFolder(event.dataTransfer) : null;
      if (!dropped) return;
      if ("error" in dropped) {
        setFormError(dropped.error);
        return;
      }
      applyPickedFolder(dropped.path);
    };
    window.addEventListener("dragenter", handleDragEnter, true);
    window.addEventListener("dragover", handleDragOver, true);
    window.addEventListener("dragleave", handleDragLeave, true);
    window.addEventListener("drop", handleDrop, true);
    return () => {
      window.removeEventListener("dragenter", handleDragEnter, true);
      window.removeEventListener("dragover", handleDragOver, true);
      window.removeEventListener("dragleave", handleDragLeave, true);
      window.removeEventListener("drop", handleDrop, true);
    };
  }, [applyPickedFolder, props.open, source]);

  const submit = async () => {
    if (submitting) return;
    // The confirm button stays enabled (and white) like the reference dialog;
    // an empty submit explains what is missing instead of being unclickable.
    if (source === "local" && trimmedPath.length === 0) {
      setFormError("Type a folder path, or drop a folder above.");
      return;
    }
    if (source === "github" && !parsedRepository) {
      setFormError("Enter a GitHub repository as owner/repository or a GitHub.com repository URL.");
      return;
    }
    if (source === "github" && !props.githubProvisioningAvailable) {
      setFormError("Update the Synara server before adding a project from GitHub.");
      return;
    }
    if (source === "github" && trimmedDestinationParent.length === 0) {
      setFormError("Choose the parent folder where the repository should be cloned.");
      return;
    }
    if (source === "github" && !normalizedDirectoryName) {
      setFormError(
        "Choose a valid folder name without slashes, reserved device names, or a trailing dot.",
      );
      return;
    }
    setSubmitting(true);
    setFormError(null);
    setProvisionProgress(source === "github" ? "Validating repository" : null);
    const abortController = new AbortController();
    submitAbortRef.current = abortController;
    try {
      const spaceId = spaces.find((space) => space.id === selectedSpaceKey)?.id ?? null;
      if (source === "github") {
        const operationId = randomUUID();
        activeOperationIdRef.current = operationId;
        await props.onSubmit(
          {
            source: "github",
            operationId,
            repository: parsedRepository ?? repositoryInput.trim(),
            destinationParent: trimmedDestinationParent,
            directoryName: normalizedDirectoryName ?? trimmedDirectoryName,
            spaceId,
          },
          { signal: abortController.signal },
        );
      } else {
        await props.onSubmit(
          {
            source: "local",
            workspaceRoot: trimmedPath,
            spaceId,
            createIfMissing: trimmedPath !== pickedPath,
          },
          { signal: abortController.signal },
        );
      }
      submitAbortRef.current = null;
      props.onOpenChange(false);
    } catch (error) {
      submitAbortRef.current = null;
      activeOperationIdRef.current = null;
      setFormError(
        abortController.signal.aborted
          ? source === "github"
            ? "GitHub clone cancelled. You can retry safely."
            : "Project creation cancelled."
          : error instanceof Error
            ? error.message
            : "An error occurred while adding the project.",
      );
      setProvisionProgress(null);
      setSubmitting(false);
    }
  };

  const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void submit();
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) submitAbortRef.current?.abort();
    props.onOpenChange(open);
  };

  // The space is created right away (same command the sidebar uses) and picked
  // as the destination, so one Create click ships the project into it.
  const handleCreateSpace = async (value: SpaceEditorValue) => {
    const api = readNativeApi();
    if (!api) throw new Error("The app server is unavailable.");
    const icon = toSpaceIconName(value.icon);
    const { spaceId } = await createSpace({ api, name: value.name, icon });
    const createdAt = new Date().toISOString();
    setCreatedSpace({
      id: spaceId,
      name: value.name,
      icon,
      sortOrder: Number.MAX_SAFE_INTEGER,
      createdAt,
      updatedAt: createdAt,
    });
    setSelectedSpaceKey(spaceId);
  };

  const selectedSpace = spaces.find((space) => space.id === selectedSpaceKey) ?? null;
  // Only echo the drop/browse result while the path field still matches it;
  // hand-editing the path afterwards puts the box back in its idle state.
  const pickedFolderName =
    pickedPath !== null && trimmedPath === pickedPath
      ? (pickedPath.split(/[/\\]/).filter(Boolean).at(-1) ?? pickedPath)
      : null;
  const finalClonePath = joinProjectPath(trimmedDestinationParent, trimmedDirectoryName);

  return (
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      <DialogPopup>
        <DialogHeader className="px-5 pt-5">
          <DialogTitle>Create project</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-4 px-5">
          <ProjectSourceSegmentedPicker
            className="mt-4"
            value={source}
            disabled={submitting}
            githubAvailable={props.githubProvisioningAvailable}
            onValueChange={(nextSource) => {
              setSource(nextSource);
              setFormError(null);
              setProvisionProgress(null);
              requestAnimationFrame(() =>
                document
                  .getElementById(nextSource === "local" ? pathInputId : repositoryInputId)
                  ?.focus(),
              );
            }}
          />

          {source === "local" ? (
            <>
              <InputGroup className={PROJECT_DIALOG_FIELD_CONTROL_CLASS_NAME}>
                <InputGroupAddon className="w-10 self-stretch border-e border-foreground/12 ps-0">
                  <FolderClosed className="size-4 text-muted-foreground/70" aria-hidden="true" />
                </InputGroupAddon>
                <InputGroupInput
                  id={pathInputId}
                  value={path}
                  aria-label="Project folder path"
                  aria-invalid={formError ? true : undefined}
                  {...(formError ? { "aria-describedby": errorId } : {})}
                  placeholder="/path/to/project"
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  onChange={(event) => {
                    setPath(event.target.value);
                    setFormError(null);
                  }}
                  onKeyDown={submitOnEnter}
                />
              </InputGroup>

              {isElectron ? (
                <div className="space-y-2">
                  <span
                    id={sourceFolderLabelId}
                    className={cn(
                      "block",
                      dialogFieldLabelClassName,
                      "text-[length:var(--app-font-size-ui,12px)] text-foreground",
                    )}
                  >
                    Source folder
                  </span>
                  <button
                    type="button"
                    aria-labelledby={sourceFolderLabelId}
                    disabled={isPickingFolder || submitting}
                    className={cn(
                      "flex min-h-12 w-full cursor-pointer items-center gap-2.5 rounded-xl border border-foreground/12 px-3.5 text-start text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground)] transition-colors outline-none hover:bg-foreground/4 focus-visible:border-foreground/30 disabled:opacity-50",
                      isDropTarget &&
                        "border-[color:var(--color-border-focus)] bg-foreground/6 text-[var(--color-text-foreground)]",
                    )}
                    onClick={() => void handleBrowse()}
                  >
                    <CentralIcon name="folder-add-left" className="size-4.5" aria-hidden="true" />
                    {isPickingFolder ? (
                      "Opening the folder picker…"
                    ) : pickedFolderName ? (
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{pickedFolderName}</span>
                        <span className="truncate text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/70">
                          {pickedPath}
                        </span>
                      </span>
                    ) : (
                      "Drop a folder here, or browse"
                    )}
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <CreateGitHubProjectFields
              repositoryInputId={repositoryInputId}
              destinationParentInputId={destinationParentInputId}
              directoryNameInputId={directoryNameInputId}
              errorId={errorId}
              repositoryInput={repositoryInput}
              destinationParent={destinationParent}
              directoryName={directoryName}
              finalClonePath={finalClonePath}
              formError={formError}
              provisionProgress={provisionProgress}
              isElectron={isElectron}
              isPickingFolder={isPickingFolder}
              submitting={submitting}
              onRepositoryChange={(nextInput) => {
                setRepositoryInput(nextInput);
                const nextRepository = parseGitHubRepositoryInput(nextInput);
                if (nextRepository && !directoryNameEdited) {
                  setDirectoryName(nextRepository.split("/").at(-1) ?? "");
                }
                setFormError(null);
              }}
              onDestinationParentChange={(nextParent) => {
                setDestinationParent(nextParent);
                setFormError(null);
              }}
              onDirectoryNameChange={(nextName) => {
                setDirectoryName(nextName);
                setDirectoryNameEdited(true);
                setFormError(null);
              }}
              onBrowse={() => void handleBrowse()}
              onSubmitKeyDown={submitOnEnter}
            />
          )}

          <div className="space-y-2">
            <span
              id={spaceLabelId}
              className={cn(
                "block",
                dialogFieldLabelClassName,
                "text-[length:var(--app-font-size-ui,12px)] text-foreground",
              )}
            >
              Space
            </span>
            <div className="flex items-center gap-2">
              <Select
                value={selectedSpaceKey}
                onValueChange={(next) => {
                  if (typeof next === "string") setSelectedSpaceKey(next);
                }}
              >
                <SelectTrigger
                  aria-labelledby={spaceLabelId}
                  className={cn(PROJECT_DIALOG_FIELD_CONTROL_CLASS_NAME, "min-w-0 flex-1")}
                >
                  <SelectValue>
                    <span className="flex items-center gap-2">
                      <SpaceIcon
                        icon={selectedSpace?.icon ?? voidSpace.icon}
                        className="size-3.5"
                      />
                      {selectedSpace?.name ?? voidSpace.name}
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <ComposerPickerSelectPopup align="start">
                  <SelectItem value={VOID_SPACE_KEY}>
                    <span className="flex items-center gap-2">
                      <SpaceIcon icon={voidSpace.icon} className="size-3.5" />
                      {voidSpace.name}
                    </span>
                  </SelectItem>
                  {spaces.map((space) => (
                    <SelectItem key={space.id} value={space.id}>
                      <span className="flex items-center gap-2">
                        <SpaceIcon icon={space.icon} className="size-3.5" />
                        {space.name}
                      </span>
                    </SelectItem>
                  ))}
                </ComposerPickerSelectPopup>
              </Select>
              <Button
                variant="outline"
                size="icon"
                aria-label="New space"
                disabled={submitting}
                className={cn(PROJECT_DIALOG_FIELD_CONTROL_CLASS_NAME, "w-9 shrink-0 sm:h-9")}
                onClick={() => setSpaceEditorOpen(true)}
              >
                <CentralIcon name="plus-medium" className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </div>

          {formError ? (
            <div id={errorId} role="alert" className="space-y-1">
              <p className="text-[length:var(--app-font-size-ui-xs,10px)] text-destructive">
                {formError}
              </p>
              {formErrorMeaning ? (
                <p className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/70">
                  {formErrorMeaning}
                </p>
              ) : null}
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter className="px-5 pb-5">
          <Button
            variant="ghost"
            shape="capsule"
            className="px-4 text-[length:var(--app-font-size-ui-lg,13px)] sm:text-[length:var(--app-font-size-ui-lg,13px)]"
            onClick={() => handleOpenChange(false)}
            disabled={submitting && source === "local"}
          >
            {submitting && source === "github" ? "Cancel clone" : "Cancel"}
          </Button>
          <Button
            id={submitButtonId}
            variant="prominent"
            className="px-4 text-[length:var(--app-font-size-ui-lg,13px)] transition-opacity hover:scale-100 sm:text-[length:var(--app-font-size-ui-lg,13px)]"
            onClick={() => void submit()}
            disabled={submitting}
          >
            {submitting
              ? source === "github"
                ? "Cloning…"
                : "Creating…"
              : source === "github"
                ? "Clone and add"
                : "Create project"}
          </Button>
        </DialogFooter>
        <SpaceEditorDialog
          open={spaceEditorOpen}
          mode="create"
          existingNames={[...spaces.map((space) => space.name), voidSpace.name]}
          onOpenChange={setSpaceEditorOpen}
          onSubmit={handleCreateSpace}
        />
      </DialogPopup>
    </Dialog>
  );
}

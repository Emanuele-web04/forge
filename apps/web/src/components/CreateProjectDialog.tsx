// FILE: CreateProjectDialog.tsx
// Purpose: Single entry point for adding a project — typed path, source folder
//          (drag/drop or native browse), optional SSH host, and destination Space.
// Layer: Web UI dialog
// Exports: CreateProjectDialog, CreateProjectSubmitValue

import {
  type ProjectProbeRemoteResult,
  type ProjectRemote,
  type ProjectRemoteLauncher,
  type SpaceId,
} from "@synara/contracts";
import { describeRejectedRemoteLauncher, parseShellWords } from "@synara/shared/sshRemote";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { isElectron } from "../env";
import {
  isDroppedComposerDirectory,
  resolveDroppedFileAbsolutePath,
} from "../lib/composerDropPaths";
import { VOID_SPACE_ICON, VOID_SPACE_KEY, VOID_SPACE_NAME, spaceKey } from "../lib/spaceGrouping";
import { createSpace } from "../lib/spaces";
import { readNativeApi } from "../nativeApi";
import type { Space } from "../types";
import { cn } from "~/lib/utils";

import { FolderClosed } from "./FolderClosed";
import { describeAddProjectError } from "./Sidebar.logic";
import { SpaceEditorDialog, type SpaceEditorValue } from "./SpaceEditorDialog";
import { SpaceIcon } from "./SpaceIcon";
import { Button } from "./ui/button";
import { DisclosureChevron } from "./ui/DisclosureChevron";
import { DisclosureRegion } from "./ui/DisclosureRegion";
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
const fieldControlClassName = "h-9 rounded-lg border-foreground/12";

function isFileDrag(event: globalThis.DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

type ProjectLocation = "local" | "ssh";

type LauncherKind = ProjectRemoteLauncher["kind"];
type ContainerEngine = Extract<ProjectRemoteLauncher, { kind: "container" }>["engine"];

const LAUNCHER_LABELS: Record<LauncherKind, string> = {
  direct: "Directly",
  "login-shell": "A login shell",
  container: "A container",
  command: "A custom command",
};

const CONTAINER_ENGINE_LABELS: Record<ContainerEngine, string> = {
  docker: "docker exec",
  podman: "podman exec",
  "docker-compose": "docker compose exec",
};

interface LauncherFormState {
  readonly kind: LauncherKind;
  readonly loginShell: string;
  readonly containerEngine: ContainerEngine;
  readonly containerTarget: string;
  readonly containerUser: string;
  readonly containerShell: string;
  readonly command: string;
}

const EMPTY_LAUNCHER_FORM: LauncherFormState = {
  kind: "direct",
  loginShell: "",
  containerEngine: "docker",
  containerTarget: "",
  containerUser: "",
  containerShell: "",
  command: "",
};

const trimmedOrNull = (value: string): string | null => value.trim() || null;

function buildLauncher(form: LauncherFormState): ProjectRemoteLauncher {
  switch (form.kind) {
    case "direct":
      return { kind: "direct" };
    case "login-shell":
      return { kind: "login-shell", shell: trimmedOrNull(form.loginShell) };
    case "container":
      return {
        kind: "container",
        engine: form.containerEngine,
        target: form.containerTarget.trim(),
        user: trimmedOrNull(form.containerUser),
        shell: trimmedOrNull(form.containerShell),
      };
    case "command":
      return {
        kind: "command",
        args: parseShellWords(form.command),
        shell: null,
      };
  }
}

/** Configuration-time explanation, so a broken launcher never becomes a hung session. */
function describeLauncherProblem(form: LauncherFormState): string | null {
  if (form.kind === "container" && form.containerTarget.trim().length === 0) {
    return form.containerEngine === "docker-compose"
      ? "Type the compose service to run in."
      : "Type the container to run in.";
  }
  return describeRejectedRemoteLauncher(buildLauncher(form));
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

export interface CreateProjectSubmitValue {
  readonly workspaceRoot: string;
  /** Destination Space; `null` is Void (unassigned). */
  readonly spaceId: SpaceId | null;
  /** True when the path was typed/edited by hand, so a missing folder may be created. */
  readonly createIfMissing: boolean;
  /** SSH target when the workspace lives on another machine; `null` for this one. */
  readonly remote: ProjectRemote | null;
}

export function CreateProjectDialog(props: {
  open: boolean;
  spaces: ReadonlyArray<Space>;
  activeSpaceId: SpaceId | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (value: CreateProjectSubmitValue) => Promise<void>;
}) {
  const [path, setPath] = useState("");
  /**
   * The last path delivered verbatim by the native picker or an OS drop. Those
   * folders exist by construction, so only hand-typed (or hand-edited) paths
   * opt into create-if-missing — the same split the old Browse/Type-path pair had.
   */
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const [location, setLocation] = useState<ProjectLocation>("local");
  const [sshHost, setSshHost] = useState("");
  const [sshArgs, setSshArgs] = useState("");
  const [shellInit, setShellInit] = useState("");
  const [remoteBinaryPath, setRemoteBinaryPath] = useState("");
  const [launcherForm, setLauncherForm] = useState<LauncherFormState>(EMPTY_LAUNCHER_FORM);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  // Kept with the inputs it was produced for: a result is only ever shown while it still
  // describes what the form currently says, so editing a field cannot leave a stale "ready".
  const [probe, setProbe] = useState<{
    readonly signature: string;
    readonly result: ProjectProbeRemoteResult;
  } | null>(null);
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
  const fieldId = useId();
  const pathInputId = `${fieldId}-path`;
  const submitButtonId = `${fieldId}-submit`;
  const sourceFolderLabelId = `${fieldId}-source-folder`;
  const locationLabelId = `${fieldId}-location`;
  const sshHostInputId = `${fieldId}-ssh-host`;
  const launcherLabelId = `${fieldId}-launcher`;
  const spaceLabelId = `${fieldId}-space`;
  const errorId = `${fieldId}-error`;

  useEffect(() => {
    // Seed on the closed -> open transition only, mirroring SpaceEditorDialog.
    if (props.open === openedRef.current) return;
    openedRef.current = props.open;
    if (!props.open) return;
    setPath("");
    setPickedPath(null);
    setLocation("local");
    setSshHost("");
    setSshArgs("");
    setShellInit("");
    setRemoteBinaryPath("");
    setLauncherForm(EMPTY_LAUNCHER_FORM);
    setAdvancedOpen(false);
    setChecking(false);
    setProbe(null);
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
  }, [pathInputId, props.activeSpaceId, props.open]);

  const trimmedPath = path.trim();
  const isRemote = location === "ssh";
  const trimmedSshHost = sshHost.trim();
  const launcherProblem = isRemote ? describeLauncherProblem(launcherForm) : null;
  const probeSignature = JSON.stringify([
    trimmedPath,
    trimmedSshHost,
    sshArgs,
    shellInit,
    remoteBinaryPath,
    launcherForm,
  ]);
  const probeResult = probe?.signature === probeSignature ? probe.result : null;
  const buildRemote = (): ProjectRemote => ({
    kind: "ssh",
    host: trimmedSshHost,
    sshArgs: parseShellWords(sshArgs),
    shellInit: shellInit.trim() || null,
    binaryPath: remoteBinaryPath.trim() || null,
    launcher: buildLauncher(launcherForm),
  });

  // Runs the command a session would run, so the dialog can answer the one question the
  // user cannot answer from here: does this host, path, and launcher combination work.
  const checkConnection = async () => {
    if (checking || trimmedPath.length === 0 || trimmedSshHost.length === 0) {
      setFormError(
        trimmedSshHost.length === 0
          ? "Type the SSH host to connect to."
          : "Type the project folder path on the host.",
      );
      return;
    }
    if (launcherProblem) {
      setFormError(launcherProblem);
      return;
    }
    const api = readNativeApi();
    if (!api) {
      setFormError("The app server is unavailable.");
      return;
    }
    setChecking(true);
    setFormError(null);
    setProbe(null);
    try {
      const result = await api.projects.probeRemote({
        remote: buildRemote(),
        workspaceRoot: trimmedPath,
      });
      setProbe({ signature: probeSignature, result });
      // The probe found the agent only through a login shell: apply that rather than
      // leaving the user to map the finding onto a setting.
      if (result.suggestedLauncher?.kind === "login-shell") {
        setLauncherForm((form) => ({ ...form, kind: "login-shell" }));
        setAdvancedOpen(true);
      }
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Could not reach the host.");
    }
    setChecking(false);
  };
  const formErrorMeaning = formError ? describeAddProjectError(formError) : null;
  const spaces =
    createdSpace && !props.spaces.some((space) => space.id === createdSpace.id)
      ? [...props.spaces, createdSpace]
      : props.spaces;

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
      if (picked) applyPickedFolder(picked);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Unable to open the folder picker.");
    }
    setIsPickingFolder(false);
  };

  // While the dialog is open it is the only interactive surface, so accept a
  // folder drop anywhere in the window (capture phase). A tiny drop zone is
  // easy to miss and a stray drop outside it would otherwise vanish silently.
  useEffect(() => {
    if (!props.open || !isElectron) return;
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
  }, [applyPickedFolder, props.open]);

  const submit = async () => {
    if (submitting) return;
    // The confirm button stays enabled (and white) like the reference dialog;
    // an empty submit explains what is missing instead of being unclickable.
    if (trimmedPath.length === 0) {
      setFormError(
        isRemote
          ? "Type the project folder path on the host."
          : "Type a folder path, or drop a folder above.",
      );
      return;
    }
    if (isRemote && trimmedSshHost.length === 0) {
      setFormError("Type the SSH host to connect to.");
      return;
    }
    if (launcherProblem) {
      setFormError(launcherProblem);
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      await props.onSubmit({
        workspaceRoot: trimmedPath,
        spaceId: spaces.find((space) => space.id === selectedSpaceKey)?.id ?? null,
        // A remote folder is never scaffolded from here: Synara has no filesystem access
        // on the host, so the path is taken as given.
        createIfMissing: !isRemote && trimmedPath !== pickedPath,
        remote: isRemote ? buildRemote() : null,
      });
      props.onOpenChange(false);
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : "An error occurred while adding the project.",
      );
      setSubmitting(false);
    }
  };

  const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void submit();
  };

  // The space is created right away (same command the sidebar uses) and picked
  // as the destination, so one Create click ships the project into it.
  const handleCreateSpace = async (value: SpaceEditorValue) => {
    const api = readNativeApi();
    if (!api) throw new Error("The app server is unavailable.");
    const { spaceId } = await createSpace({ api, name: value.name, icon: value.icon });
    const createdAt = new Date().toISOString();
    setCreatedSpace({
      id: spaceId,
      name: value.name,
      icon: value.icon,
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

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup>
        <DialogHeader className="px-5 pt-5">
          <DialogTitle>Create project</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-4 px-5">
          <InputGroup className={cn(fieldControlClassName, "mt-4")}>
            <InputGroupAddon className="w-10 self-stretch border-e border-foreground/12 ps-0">
              <FolderClosed className="size-4 text-muted-foreground/70" aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              id={pathInputId}
              value={path}
              aria-label={isRemote ? "Project folder path on the host" : "Project folder path"}
              aria-invalid={formError ? true : undefined}
              {...(formError ? { "aria-describedby": errorId } : {})}
              placeholder={isRemote ? "/srv/app" : "/path/to/project"}
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

          {isElectron && !isRemote ? (
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

          <div className="space-y-2">
            <span
              id={locationLabelId}
              className={cn(
                "block",
                dialogFieldLabelClassName,
                "text-[length:var(--app-font-size-ui,12px)] text-foreground",
              )}
            >
              Location
            </span>
            <Select
              value={location}
              onValueChange={(next) => {
                if (next !== "local" && next !== "ssh") return;
                setLocation(next);
                setFormError(null);
              }}
            >
              <SelectTrigger
                aria-labelledby={locationLabelId}
                className={cn(fieldControlClassName, "w-full")}
              >
                <SelectValue>
                  {location === "ssh" ? "Remote over SSH" : "This computer"}
                </SelectValue>
              </SelectTrigger>
              <ComposerPickerSelectPopup align="start">
                <SelectItem value="local">This computer</SelectItem>
                <SelectItem value="ssh">Remote over SSH</SelectItem>
              </ComposerPickerSelectPopup>
            </Select>
          </div>

          <DisclosureRegion open={isRemote}>
            <div className="space-y-4 pt-0.5">
              <div className="space-y-2">
                <label
                  htmlFor={sshHostInputId}
                  className={cn(
                    "block",
                    dialogFieldLabelClassName,
                    "text-[length:var(--app-font-size-ui,12px)] text-foreground",
                  )}
                >
                  SSH host
                </label>
                <InputGroup className={fieldControlClassName}>
                  <InputGroupInput
                    id={sshHostInputId}
                    value={sshHost}
                    placeholder="deploy@build-box"
                    spellCheck={false}
                    autoCorrect="off"
                    autoCapitalize="off"
                    onChange={(event) => {
                      setSshHost(event.target.value);
                      setFormError(null);
                    }}
                    onKeyDown={submitOnEnter}
                  />
                </InputGroup>
                <p className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/70">
                  Any ssh destination — a <code>~/.ssh/config</code> alias keeps your port, key, and
                  jump hosts exactly as your terminal uses them.
                </p>
              </div>

              <div className="space-y-2">
                <Button
                  variant="outline"
                  className={cn(fieldControlClassName, "w-full")}
                  disabled={checking || submitting}
                  onClick={() => void checkConnection()}
                >
                  {checking ? "Checking…" : "Check connection"}
                </Button>
                {probeResult ? (
                  <div
                    role="status"
                    className={cn(
                      "space-y-1 rounded-lg border px-3 py-2",
                      probeResult.status === "ok"
                        ? "border-foreground/12"
                        : "border-destructive/40",
                    )}
                  >
                    <p
                      className={cn(
                        "text-[length:var(--app-font-size-ui-xs,10px)]",
                        probeResult.status === "ok" ? "text-foreground" : "text-destructive",
                      )}
                    >
                      {probeResult.summary}
                    </p>
                    {probeResult.detail ? (
                      <pre className="max-h-24 overflow-auto text-[length:var(--app-font-size-ui-xs,10px)] whitespace-pre-wrap text-muted-foreground/70">
                        {probeResult.detail}
                      </pre>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="space-y-2">
                <button
                  type="button"
                  aria-expanded={advancedOpen}
                  className="flex cursor-pointer items-center gap-1.5 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground transition-colors outline-none hover:text-foreground"
                  onClick={() => setAdvancedOpen((open) => !open)}
                >
                  <DisclosureChevron open={advancedOpen} className="size-3.5" />
                  Advanced
                </button>
                <DisclosureRegion open={advancedOpen}>
                  <div className="space-y-3 pt-1">
                    <div className="space-y-2">
                      <span
                        id={launcherLabelId}
                        className="block text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/70"
                      >
                        Run the agent through
                      </span>
                      <Select
                        value={launcherForm.kind}
                        onValueChange={(next) => {
                          if (typeof next !== "string") return;
                          setLauncherForm((form) => ({ ...form, kind: next as LauncherKind }));
                          setFormError(null);
                        }}
                      >
                        <SelectTrigger
                          aria-labelledby={launcherLabelId}
                          className={cn(fieldControlClassName, "w-full")}
                        >
                          <SelectValue>{LAUNCHER_LABELS[launcherForm.kind]}</SelectValue>
                        </SelectTrigger>
                        <ComposerPickerSelectPopup align="start">
                          {(Object.keys(LAUNCHER_LABELS) as LauncherKind[]).map((kind) => (
                            <SelectItem key={kind} value={kind}>
                              {LAUNCHER_LABELS[kind]}
                            </SelectItem>
                          ))}
                        </ComposerPickerSelectPopup>
                      </Select>
                    </div>

                    <DisclosureRegion open={launcherForm.kind !== "direct"}>
                      {launcherForm.kind === "login-shell" ? (
                        <InputGroup className={fieldControlClassName}>
                          <InputGroupInput
                            value={launcherForm.loginShell}
                            aria-label="Login shell on the host"
                            placeholder="Login shell (default: bash)"
                            spellCheck={false}
                            autoCorrect="off"
                            autoCapitalize="off"
                            onChange={(event) =>
                              setLauncherForm((form) => ({
                                ...form,
                                loginShell: event.target.value,
                              }))
                            }
                          />
                        </InputGroup>
                      ) : launcherForm.kind === "container" ? (
                        <div className="space-y-3">
                          <Select
                            value={launcherForm.containerEngine}
                            onValueChange={(next) => {
                              if (typeof next !== "string") return;
                              setLauncherForm((form) => ({
                                ...form,
                                containerEngine: next as ContainerEngine,
                              }));
                            }}
                          >
                            <SelectTrigger
                              aria-label="Container engine"
                              className={cn(fieldControlClassName, "w-full")}
                            >
                              <SelectValue>
                                {CONTAINER_ENGINE_LABELS[launcherForm.containerEngine]}
                              </SelectValue>
                            </SelectTrigger>
                            <ComposerPickerSelectPopup align="start">
                              {(Object.keys(CONTAINER_ENGINE_LABELS) as ContainerEngine[]).map(
                                (engine) => (
                                  <SelectItem key={engine} value={engine}>
                                    {CONTAINER_ENGINE_LABELS[engine]}
                                  </SelectItem>
                                ),
                              )}
                            </ComposerPickerSelectPopup>
                          </Select>
                          <InputGroup className={fieldControlClassName}>
                            <InputGroupInput
                              value={launcherForm.containerTarget}
                              aria-label={
                                launcherForm.containerEngine === "docker-compose"
                                  ? "Compose service"
                                  : "Container name"
                              }
                              placeholder={
                                launcherForm.containerEngine === "docker-compose"
                                  ? "Compose service, e.g. app"
                                  : "Container, e.g. web"
                              }
                              spellCheck={false}
                              autoCorrect="off"
                              autoCapitalize="off"
                              onChange={(event) => {
                                setLauncherForm((form) => ({
                                  ...form,
                                  containerTarget: event.target.value,
                                }));
                                setFormError(null);
                              }}
                            />
                          </InputGroup>
                          <InputGroup className={fieldControlClassName}>
                            <InputGroupInput
                              value={launcherForm.containerUser}
                              aria-label="User inside the container"
                              placeholder="User inside the container (optional)"
                              spellCheck={false}
                              autoCorrect="off"
                              autoCapitalize="off"
                              onChange={(event) =>
                                setLauncherForm((form) => ({
                                  ...form,
                                  containerUser: event.target.value,
                                }))
                              }
                            />
                          </InputGroup>
                        </div>
                      ) : (
                        <div className="space-y-1.5">
                          <InputGroup className={fieldControlClassName}>
                            <InputGroupInput
                              value={launcherForm.command}
                              aria-label="Custom command to run the agent through"
                              placeholder="e.g. mise exec --"
                              spellCheck={false}
                              autoCorrect="off"
                              autoCapitalize="off"
                              onChange={(event) => {
                                setLauncherForm((form) => ({
                                  ...form,
                                  command: event.target.value,
                                }));
                                setFormError(null);
                              }}
                            />
                          </InputGroup>
                          <p className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/70">
                            Runs in place and is handed the project command, like{" "}
                            <code>nix develop -c</code> or <code>direnv exec .</code>. Terminal
                            multiplexers cannot be used — see below.
                          </p>
                        </div>
                      )}
                    </DisclosureRegion>

                    {launcherProblem ? (
                      <p className="text-[length:var(--app-font-size-ui-xs,10px)] text-destructive">
                        {launcherProblem}
                      </p>
                    ) : null}

                    <InputGroup className={fieldControlClassName}>
                      <InputGroupInput
                        value={sshArgs}
                        aria-label="Extra ssh arguments"
                        placeholder="Extra ssh arguments, e.g. -p 2222 -J bastion"
                        spellCheck={false}
                        autoCorrect="off"
                        autoCapitalize="off"
                        onChange={(event) => setSshArgs(event.target.value)}
                      />
                    </InputGroup>
                    <InputGroup className={fieldControlClassName}>
                      <InputGroupInput
                        value={shellInit}
                        aria-label="Remote shell setup command"
                        placeholder="Shell setup, e.g. source ~/.nvm/nvm.sh"
                        spellCheck={false}
                        autoCorrect="off"
                        autoCapitalize="off"
                        onChange={(event) => setShellInit(event.target.value)}
                      />
                    </InputGroup>
                    <InputGroup className={fieldControlClassName}>
                      <InputGroupInput
                        value={remoteBinaryPath}
                        aria-label="Claude binary path on the host"
                        placeholder="Claude binary on the host, e.g. /usr/local/bin/claude"
                        spellCheck={false}
                        autoCorrect="off"
                        autoCapitalize="off"
                        onChange={(event) => setRemoteBinaryPath(event.target.value)}
                      />
                    </InputGroup>
                  </div>
                </DisclosureRegion>
              </div>
            </div>
          </DisclosureRegion>

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
                  className={cn(fieldControlClassName, "min-w-0 flex-1")}
                >
                  <SelectValue>
                    <span className="flex items-center gap-2">
                      <SpaceIcon
                        icon={selectedSpace?.icon ?? VOID_SPACE_ICON}
                        className="size-3.5"
                      />
                      {selectedSpace?.name ?? VOID_SPACE_NAME}
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <ComposerPickerSelectPopup align="start">
                  <SelectItem value={VOID_SPACE_KEY}>
                    <span className="flex items-center gap-2">
                      <SpaceIcon icon={VOID_SPACE_ICON} className="size-3.5" />
                      {VOID_SPACE_NAME}
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
                className={cn(fieldControlClassName, "w-9 shrink-0 sm:h-9")}
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
            onClick={() => props.onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            id={submitButtonId}
            variant="prominent"
            className="px-4 text-[length:var(--app-font-size-ui-lg,13px)] sm:text-[length:var(--app-font-size-ui-lg,13px)]"
            onClick={() => void submit()}
            disabled={submitting}
          >
            {submitting ? "Creating…" : "Create project"}
          </Button>
        </DialogFooter>
        <SpaceEditorDialog
          open={spaceEditorOpen}
          mode="create"
          existingNames={spaces.map((space) => space.name)}
          onOpenChange={setSpaceEditorOpen}
          onSubmit={handleCreateSpace}
        />
      </DialogPopup>
    </Dialog>
  );
}

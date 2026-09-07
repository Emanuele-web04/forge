// FILE: ProjectStep.tsx
// Purpose: First-project step of the welcome tour: drop a folder (anywhere in the window),
//          browse (desktop) or type a path, create the project through the shared
//          create-or-recover flow, and list what was added. Several folders can be added
//          before continuing.
// Layer: Web UI component

import type { ProjectId } from "@synara/contracts";
import { useEffect, useState, type FormEvent } from "react";

import { useAppSettings } from "~/appSettings";
import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { isElectron } from "~/env";
import { useWindowFolderDrop } from "~/hooks/useWindowFolderDrop";
import { CentralIcon } from "~/lib/central-icons";
import { CheckIcon, FolderIcon } from "~/lib/icons";
import { createOrRecoverProjectFromPath } from "~/lib/projectCreation";
import { expandProjectHomePath } from "~/lib/projectPaths";
import { cn } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { useWorkspacePathsStore } from "~/workspacePathsStore";

export interface OnboardingProjectResult {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly created: boolean;
}

const FIELD_CONTROL_CLASS_NAME = "h-9 rounded-lg border-foreground/12";

export function ProjectStep(props: {
  results: ReadonlyArray<OnboardingProjectResult>;
  onResult: (result: OnboardingProjectResult) => void;
  /** Project creation is not abortable; the dialog blocks navigation while it runs. */
  onBusyChange: (busy: boolean) => void;
}) {
  const { settings } = useAppSettings();
  const homeDir = useWorkspacePathsStore((store) => store.homeDir);
  const syncServerShellSnapshot = useStore((store) => store.syncServerShellSnapshot);
  const [path, setPath] = useState("");
  const [picking, setPicking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { onBusyChange } = props;
  const busy = picking || submitting;
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  const addProject = async (rawPath: string) => {
    const api = readNativeApi();
    const workspaceRoot = expandProjectHomePath(rawPath.trim(), homeDir);
    if (!api || workspaceRoot.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await createOrRecoverProjectFromPath({
        api,
        workspaceRoot,
        // Files the project in Void; the sidebar follows it once the tour closes.
        spaceId: null,
        defaultProvider: settings.defaultProvider,
        loadSnapshot: () => api.orchestration.getShellSnapshot().catch(() => null),
      });
      if (result.snapshot) {
        syncServerShellSnapshot(result.snapshot);
      }
      props.onResult({
        projectId: result.projectId,
        workspaceRoot: result.project?.workspaceRoot ?? workspaceRoot,
        created: result.created,
      });
      setPath("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add the project.");
    } finally {
      setSubmitting(false);
    }
  };

  const browse = async () => {
    const api = readNativeApi();
    if (!api) return;
    setPicking(true);
    try {
      const picked = await api.dialogs.pickFolder();
      if (picked) {
        await addProject(picked);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not open the folder picker.");
    } finally {
      setPicking(false);
    }
  };

  const isDropTarget = useWindowFolderDrop({
    enabled: isElectron && !submitting,
    onFolder: (dropped) => void addProject(dropped),
    onError: setError,
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void addProject(path);
  };

  return (
    <div className="flex flex-col gap-4">
      {isElectron ? (
        <button
          type="button"
          disabled={picking || submitting}
          className={cn(
            "flex h-[168px] w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-foreground/18 text-[length:var(--app-font-size-ui-lg,13px)] text-foreground transition-colors outline-none hover:bg-foreground/3 focus-visible:border-foreground/40 disabled:opacity-50 motion-reduce:transition-none",
            isDropTarget && "border-solid border-[color:var(--color-border-focus)] bg-foreground/5",
          )}
          onClick={() => void browse()}
        >
          <CentralIcon
            name="folder-add-left"
            className="size-[22px] text-foreground/70"
            aria-hidden="true"
          />
          {picking ? (
            <span>Opening the folder picker…</span>
          ) : (
            <span>
              Drop a folder here, or{" "}
              <span className="underline decoration-dotted decoration-[1.5px] underline-offset-[5px]">
                browse
              </span>
            </span>
          )}
        </button>
      ) : null}

      <form onSubmit={onSubmit} className="flex items-center gap-2">
        <InputGroup className={cn(FIELD_CONTROL_CLASS_NAME, "min-w-0 flex-1")}>
          <InputGroupAddon className="w-10 self-stretch border-e border-foreground/12 ps-0">
            <FolderIcon className="size-4 text-muted-foreground/70" aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            value={path}
            onChange={(event) => {
              setPath(event.target.value);
              setError(null);
            }}
            placeholder={homeDir ? `${homeDir}/code/my-repo` : "/path/to/repository"}
            aria-label="Project folder path"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            disabled={submitting}
          />
        </InputGroup>
        <Button
          type="submit"
          variant="outline"
          className={cn(FIELD_CONTROL_CLASS_NAME, "shrink-0 px-4")}
          disabled={submitting || path.trim().length === 0}
        >
          Add
        </Button>
      </form>

      {error ? (
        <p role="alert" className="text-[length:var(--app-font-size-ui,12px)] text-destructive">
          {error}
        </p>
      ) : null}

      {props.results.length > 0 ? (
        <ul className="flex flex-col gap-1.5" aria-label="Added projects">
          {props.results.map((result) => (
            <li
              key={result.projectId}
              className="flex h-10 items-center gap-3 rounded-lg bg-foreground/3 px-3.5"
            >
              <FolderIcon className="size-[15px] shrink-0 text-foreground/70" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,12px)] text-foreground">
                {result.workspaceRoot}
              </span>
              <span
                className={cn(
                  "flex items-center gap-1.5 text-[length:var(--app-font-size-ui-sm,11px)]",
                  result.created ? "text-success" : "text-muted-foreground",
                )}
              >
                <CheckIcon className="size-3" aria-hidden />
                {result.created ? "Added" : "Already linked"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

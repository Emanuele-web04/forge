// FILE: ProjectStep.tsx
// Purpose: First-project step of the welcome tour: browse (desktop) or type a folder path,
//          create the project through the shared create-or-recover flow, and list what was
//          added. Multiple folders can be added before continuing.
// Layer: Web UI component

import type { ProjectId } from "@synara/contracts";
import { useState, type FormEvent } from "react";

import { useAppSettings } from "~/appSettings";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { isElectron } from "~/env";
import { FolderOpenIcon } from "~/lib/icons";
import { createOrRecoverProjectFromPath } from "~/lib/projectCreation";
import { expandProjectHomePath } from "~/lib/projectPaths";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { useWorkspacePathsStore } from "~/workspacePathsStore";

export interface OnboardingProjectResult {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly created: boolean;
}

export function ProjectStep(props: {
  results: ReadonlyArray<OnboardingProjectResult>;
  onResult: (result: OnboardingProjectResult) => void;
}) {
  const { settings } = useAppSettings();
  const homeDir = useWorkspacePathsStore((store) => store.homeDir);
  const syncServerShellSnapshot = useStore((store) => store.syncServerShellSnapshot);
  const [path, setPath] = useState("");
  const [picking, setPicking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    } finally {
      setPicking(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void addProject(path);
  };

  return (
    <div className="space-y-4">
      <form onSubmit={onSubmit} className="flex items-center gap-2">
        <Input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder={homeDir ? `${homeDir}/code/my-repo` : "/path/to/repository"}
          aria-label="Project folder path"
          disabled={submitting}
          className="flex-1"
        />
        {isElectron ? (
          <Button
            type="button"
            variant="outline"
            disabled={picking || submitting}
            onClick={() => void browse()}
          >
            <FolderOpenIcon className="size-4" aria-hidden />
            Browse
          </Button>
        ) : null}
        <Button type="submit" disabled={submitting || path.trim().length === 0}>
          Add
        </Button>
      </form>

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      {props.results.length > 0 ? (
        <ul className="space-y-1" aria-label="Added projects">
          {props.results.map((result) => (
            <li
              key={result.projectId}
              className="flex items-center gap-3 rounded-lg border border-border/70 bg-muted/20 px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {result.workspaceRoot}
              </span>
              <Badge variant={result.created ? "success" : "outline"}>
                {result.created ? "Added" : "Already linked"}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}

      <p className="text-xs text-muted-foreground">
        A project is the folder Synara works with. A Git repository is strongly recommended: it
        unlocks branches, worktrees, diffs, commits, pushes, and pull requests. You can add more
        projects or clone one from GitHub later from the sidebar.
      </p>
    </div>
  );
}

import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { ProviderIcon } from "~/components/ProviderIcon";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Skeleton } from "~/components/ui/skeleton";
import { formatRelativeTime } from "~/lib/relativeTime";
import { useStore } from "~/store";
import { useWorkspacePathsStore } from "~/workspacePathsStore";
import { projectCandidatesQueryOptions } from "../discoveryQueries";
import { shortenSessionCwd } from "../externalSessionPicker.logic";
import { toggleSelection } from "../logic";
import type { BulkProjectImportResult } from "../bulkProjectImport";

export function ImportProjectsStep(props: {
  selection: ReadonlySet<string>;
  onSelectionChange: (selection: ReadonlySet<string>) => void;
  results: ReadonlyArray<BulkProjectImportResult>;
  isImporting: boolean;
}) {
  const candidatesQuery = useQuery(projectCandidatesQueryOptions());
  const homeDir = useWorkspacePathsStore((store) => store.homeDir);
  const projects = useStore((store) => store.projects);

  const candidates = candidatesQuery.data?.candidates ?? [];
  const initializedSelectionRef = useRef(false);
  const { isSuccess } = candidatesQuery;
  const { onSelectionChange } = props;
  useEffect(() => {
    if (initializedSelectionRef.current || !isSuccess) {
      return;
    }
    initializedSelectionRef.current = true;
    onSelectionChange(
      new Set(
        candidates
          .filter((candidate) => candidate.existingProjectId === null)
          .map((candidate) => candidate.workspaceRoot),
      ),
    );
  }, [candidates, isSuccess, onSelectionChange]);

  if (candidatesQuery.isPending) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (candidatesQuery.isError) {
    return (
      <div className="space-y-2 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2">
        <p className="text-sm text-destructive">Could not scan for existing project folders.</p>
        <Button size="sm" variant="outline" onClick={() => void candidatesQuery.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  if (candidates.length === 0) {
    return (
      <p className="rounded-md border border-border/70 bg-muted/40 px-3 py-3 text-sm text-muted-foreground">
        No project folders found in your agent CLI history. You can add projects later from the
        sidebar.
      </p>
    );
  }

  const resultByRoot = new Map(props.results.map((result) => [result.workspaceRoot, result]));
  const selectableCount = candidates.filter(
    (candidate) => candidate.existingProjectId === null,
  ).length;

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Folders your agent CLIs have worked in. Selected folders become Synara projects.
      </p>
      <div className="max-h-80 space-y-1 overflow-y-auto pr-1">
        {candidates.map((candidate) => {
          const alreadyProject =
            candidate.existingProjectId !== null ||
            projects.some((project) => project.cwd === candidate.workspaceRoot);
          const result = resultByRoot.get(candidate.workspaceRoot);
          const isSelected = props.selection.has(candidate.workspaceRoot);
          return (
            <button
              key={candidate.workspaceRoot}
              type="button"
              disabled={alreadyProject || props.isImporting}
              onClick={() =>
                props.onSelectionChange(toggleSelection(props.selection, candidate.workspaceRoot))
              }
              className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Checkbox
                checked={alreadyProject || isSelected}
                disabled={alreadyProject || props.isImporting}
                tabIndex={-1}
                className="pointer-events-none shrink-0"
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm text-foreground">
                  {shortenSessionCwd(candidate.workspaceRoot, homeDir)}
                </span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    {candidate.providers.map((provider) => (
                      <ProviderIcon key={provider} provider={provider} className="size-3.5" />
                    ))}
                  </span>
                  <span>
                    {candidate.sessionCount} {candidate.sessionCount === 1 ? "session" : "sessions"}
                  </span>
                  <span>{formatRelativeTime(candidate.lastActiveAt)}</span>
                </span>
              </span>
              {alreadyProject ? <Badge variant="outline">Added</Badge> : null}
              {result?.status === "created" ? <Badge variant="success">Imported</Badge> : null}
              {result?.status === "failed" ? <Badge variant="error">Failed</Badge> : null}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        {props.selection.size} of {selectableCount} selected
      </p>
    </div>
  );
}

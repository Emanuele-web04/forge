// FILE: ComposerWorkspaceStatus.tsx
// Purpose: Summarizes the active chat workspace in the composer's top-right corner.

import type { ThreadEnvironmentMode } from "@synara/contracts";

import { CentralIcon } from "../../lib/central-icons";
import { GitBranchIcon, WorktreeIcon } from "../../lib/icons";
import { resolveThreadEnvironmentPresentation } from "../../lib/threadEnvironment";

export function ComposerWorkspaceStatus({
  envMode,
  worktreePath,
  branch,
}: {
  envMode?: ThreadEnvironmentMode | null;
  worktreePath?: string | null;
  branch?: string | null;
}) {
  const environment = resolveThreadEnvironmentPresentation({ envMode, worktreePath });
  const environmentLabel = environment.shortLabel;
  const titleEnvironmentLabel = environment.mode === "local" ? "Local checkout" : "Worktree";
  const title = branch ? `${titleEnvironmentLabel} · ${branch}` : titleEnvironmentLabel;

  return (
    <div
      data-testid="composer-workspace-status"
      className="inline-flex min-w-0 max-w-[min(70%,28rem)] items-center gap-1.5 rounded-full border border-[color:var(--surface-border)] bg-[var(--color-background-elevated-secondary)]/70 px-2 py-1 text-[length:var(--app-font-size-ui-sm,11px)] leading-none font-normal text-[var(--color-text-foreground-secondary)]"
      title={title}
      aria-label={title}
    >
      {environment.mode === "worktree" ? (
        <WorktreeIcon className="size-3 shrink-0" />
      ) : (
        <CentralIcon name="macbook-air" className="size-3 shrink-0" />
      )}
      <span className="shrink-0">{environmentLabel}</span>
      {branch ? (
        <>
          <span aria-hidden="true" className="opacity-45">
            ·
          </span>
          <GitBranchIcon className="size-3 shrink-0 opacity-70" />
          <span className="min-w-0 truncate">{branch}</span>
        </>
      ) : null}
    </div>
  );
}

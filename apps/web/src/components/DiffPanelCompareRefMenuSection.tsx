import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { gitBranchesQueryOptions, gitRecentCommitsQueryOptions } from "~/lib/gitReactQuery";
import { GitBranchIcon, GitCommitIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { buildDiffPanelCompareRefValue, parseDiffPanelCompareRefValue } from "./DiffPanel.logic";
import { Input } from "./ui/input";
import { MenuGroup, MenuGroupLabel, MenuRadioGroup, MenuRadioItem } from "./ui/menu";

const COMPARE_REF_BRANCH_LIMIT = 8;
const COMPARE_REF_COMMIT_LIMIT = 8;
const COMPARE_REF_SUBJECT_MAX_LENGTH = 42;

const COMPARE_REF_MENU_NAVIGATION_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "Home",
  "End",
  "PageDown",
  "PageUp",
  "Escape",
]);

function truncateCommitSubject(subject: string): string {
  const trimmed = subject.trim();
  if (trimmed.length === 0) {
    return "(no subject)";
  }
  return trimmed.length > COMPARE_REF_SUBJECT_MAX_LENGTH
    ? `${trimmed.slice(0, COMPARE_REF_SUBJECT_MAX_LENGTH - 1)}…`
    : trimmed;
}

export function DiffPanelCompareRefMenuSection(props: {
  cwd: string | null;
  open: boolean;
  compareRef: string | null;
  scopeIsRef: boolean;
  iconClassName: string;
  onSelectCompareRef: (ref: string) => void;
}) {
  const [refDraft, setRefDraft] = useState("");
  const branchesQuery = useQuery({
    ...gitBranchesQueryOptions(props.cwd),
    enabled: props.open && props.cwd !== null,
  });
  const recentCommitsQuery = useQuery(
    gitRecentCommitsQueryOptions({
      cwd: props.cwd,
      limit: COMPARE_REF_COMMIT_LIMIT,
      enabled: props.open,
    }),
  );

  const branches = (branchesQuery.data?.branches ?? [])
    .filter((branch) => !branch.current)
    .slice(0, COMPARE_REF_BRANCH_LIMIT);
  const commits = recentCommitsQuery.data?.commits ?? [];
  const activeRef = props.scopeIsRef ? (props.compareRef?.trim() ?? "") : "";
  const hasActiveRefRow =
    activeRef.length > 0 &&
    !branches.some((branch) => branch.name === activeRef) &&
    !commits.some((commit) => commit.sha === activeRef);

  const applyRefDraft = () => {
    const ref = refDraft.trim();
    if (ref.length === 0) {
      return;
    }
    setRefDraft("");
    props.onSelectCompareRef(ref);
  };

  return (
    <MenuGroup>
      <MenuGroupLabel>Compare with</MenuGroupLabel>
      <MenuRadioGroup
        value={activeRef.length > 0 ? buildDiffPanelCompareRefValue(activeRef) : ""}
        onValueChange={(value) => {
          const ref = typeof value === "string" ? parseDiffPanelCompareRefValue(value) : null;
          if (ref) {
            props.onSelectCompareRef(ref);
          }
        }}
      >
        {hasActiveRefRow ? (
          <MenuRadioItem value={buildDiffPanelCompareRefValue(activeRef)}>
            <GitCommitIcon className={props.iconClassName} />
            <span className="min-w-0 flex-1 truncate">{activeRef}</span>
          </MenuRadioItem>
        ) : null}
        {branches.map((branch) => (
          <MenuRadioItem key={branch.name} value={buildDiffPanelCompareRefValue(branch.name)}>
            <GitBranchIcon className={props.iconClassName} />
            <span className="min-w-0 flex-1 truncate">{branch.name}</span>
          </MenuRadioItem>
        ))}
        {commits.map((commit) => (
          <MenuRadioItem key={commit.sha} value={buildDiffPanelCompareRefValue(commit.sha)}>
            <GitCommitIcon className={props.iconClassName} />
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
              {commit.shortSha}
            </span>
            <span className="min-w-0 flex-1 truncate text-[11px]">
              {truncateCommitSubject(commit.subject)}
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      <div className="px-2 py-1">
        <Input
          className={cn(
            "rounded-md border-border/60 shadow-none before:hidden",
            "has-focus-visible:border-neutral-500/15 has-focus-visible:ring-0",
            "[&_input]:font-sans [&_input]:text-[11px]",
          )}
          nativeInput
          size="sm"
          type="text"
          placeholder="Branch, tag, or commit"
          value={refDraft}
          onChange={(event) => setRefDraft(event.target.value)}
          onKeyDownCapture={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              applyRefDraft();
              return;
            }
            if (!COMPARE_REF_MENU_NAVIGATION_KEYS.has(event.key)) {
              event.stopPropagation();
            }
          }}
        />
      </div>
    </MenuGroup>
  );
}

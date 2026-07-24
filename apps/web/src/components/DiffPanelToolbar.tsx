// FILE: DiffPanelToolbar.tsx
// Purpose: Unified review toolbar for the diff panel — scope picker, stats, file jump,
//          view options, git actions, and turn selection. Picker chrome matches the
//          Environment panel (EnvironmentRow triggers + ComposerPickerMenuPopup menus).
// Layer: Diff panel UI

import type { FileDiffMetadata } from "@pierre/diffs/react";
import type { ThreadId, TurnId } from "@synara/contracts";
import { FaPlusMinus } from "react-icons/fa6";
import { useState, type ReactNode } from "react";

import GitActionsControl from "~/components/GitActionsControl";
import {
  ChangesIcon,
  Columns2Icon,
  CopyIcon,
  DiffIcon,
  EllipsisIcon,
  FolderIcon,
  FoldersIcon,
  GitBranchIcon,
  GitCommitIcon,
  ListChecksIcon,
  Rows3Icon,
  XIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import type { TimestampFormat } from "~/appSettings";
import type { TurnDiffSummary } from "~/types";
import type { RepoDiffScope } from "~/repoDiffScopeStore";
import { REPO_DIFF_SCOPE_LABELS } from "~/repoDiffScopeStore";
import { formatShortTimestamp } from "~/timestampFormat";
import {
  DIFF_PANEL_PICKER_SCOPE_OPTIONS,
  resolveDiffPanelPickerLabel,
  resolveDiffPanelScopePickerValue,
  type DiffPanelTurnScopeIntent,
  type DiffPanelViewSource,
} from "./DiffPanel.logic";
import { DiffPanelFileJumpMenu } from "./DiffPanelFileJumpMenu";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import { EnvironmentRowBody, EnvironmentRowChevron } from "./chat/environment/EnvironmentRow";
import { DOCK_HEADER_ICON_BUTTON_CLASS, type DiffRenderMode } from "./chat/chatHeaderControls";
import { DiffStat } from "./chat/DiffStatLabel";
import { IconButton } from "./ui/icon-button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "./ui/menu";
const DIFF_PANEL_PICKER_ICON_CLASS_NAME = "size-3.5 shrink-0 text-[var(--color-text-foreground)]";

/** Tighter than EnvironmentRow — dock header has no 16px icon gutter column. */
const DIFF_PANEL_PICKER_TRIGGER_CLASS_NAME = cn(
  "flex h-8 min-w-0 max-w-[min(38%,11rem)] cursor-pointer items-center gap-1.5 rounded-lg py-1 pl-1.5 pr-2 text-left",
  "text-[length:var(--app-font-size-ui,12px)] font-normal text-[var(--color-text-foreground)]",
  "outline-none transition-colors",
  "hover:bg-[var(--color-background-elevated-secondary)]",
  "focus-visible:bg-[var(--color-background-elevated-secondary)]",
);

const DIFF_PANEL_MENU_ICON_CLASS_NAME = "size-3.5 shrink-0 text-muted-foreground";
const INITIAL_VISIBLE_TURN_COUNT = 5;
const TURN_SHOW_MORE_INCREMENT = 20;

const DIFF_PANEL_TOOLBAR_ICON_BUTTON_CLASS_NAME = "text-muted-foreground hover:text-foreground";

function DiffPanelToolbarDivider() {
  return <div aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border/60" />;
}

interface DiffPanelToolbarProps {
  activeCwd: string | null;
  activeThreadId: ThreadId | null;
  viewSource: DiffPanelViewSource;
  turnScopeIntent: DiffPanelTurnScopeIntent;
  scopeFileCounts: Partial<Record<RepoDiffScope, number>>;
  activeStats: { additions: number; deletions: number } | null;
  orderedTurnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  inferredCheckpointTurnCountByTurnId: Record<string, number>;
  selectedTurnId: TurnId | null;
  timestampFormat: TimestampFormat;
  renderableFiles: ReadonlyArray<FileDiffMetadata>;
  selectedFilePath: string | null;
  fileTreeOpen: boolean;
  resolvedTheme: "light" | "dark";
  diffRenderMode: DiffRenderMode;
  diffWordWrap: boolean;
  diffIgnoreWhitespace: boolean;
  diffCopyText: string | null;
  isDiffCopied: boolean;
  allFilesCollapsed: boolean;
  onSelectRepoScope: (scope: RepoDiffScope) => void;
  onSelectAllTurns: () => void;
  onSelectLastTurn: () => void;
  onSelectTurn: (turnId: TurnId | null) => void;
  onSelectFile: (filePath: string) => void;
  onToggleFileTree: () => void;
  onDiffRenderModeChange: (mode: DiffRenderMode) => void;
  onDiffWordWrapChange: (enabled: boolean) => void;
  onDiffIgnoreWhitespaceChange: (enabled: boolean) => void;
  onCopyDiff: () => void;
  onToggleCollapseAll: () => void;
  scopePickerOpen?: boolean;
  onScopePickerOpenChange?: (open: boolean) => void;
  onClosePanel?: () => void;
}

function ScopeCountBadge(props: { count: number | undefined }) {
  if (typeof props.count !== "number" || props.count <= 0) {
    return null;
  }
  return (
    <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground tabular-nums">
      {props.count}
    </span>
  );
}

function resolveScopeMenuIcon(scope: RepoDiffScope | "lastTurn") {
  switch (scope) {
    case "unstaged":
      return <ChangesIcon className={DIFF_PANEL_MENU_ICON_CLASS_NAME} />;
    case "staged":
      return <ListChecksIcon className={DIFF_PANEL_MENU_ICON_CLASS_NAME} />;
    case "branch":
      return <GitBranchIcon className={DIFF_PANEL_MENU_ICON_CLASS_NAME} />;
    case "lastTurn":
      return (
        <span className="inline-flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
          <FaPlusMinus className="size-2.25" />
        </span>
      );
    default:
      return <DiffIcon className={DIFF_PANEL_MENU_ICON_CLASS_NAME} />;
  }
}

function resolveTurnNumber(
  summary: TurnDiffSummary,
  inferredCheckpointTurnCountByTurnId: Record<string, number>,
): string {
  return String(
    summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId] ?? "?",
  );
}

export const DiffPanelToolbar = function DiffPanelToolbar(props: DiffPanelToolbarProps) {
  const [visibleTurnCount, setVisibleTurnCount] = useState(INITIAL_VISIBLE_TURN_COUNT);
  const scopePickerLabel = resolveDiffPanelPickerLabel(props.viewSource, props.turnScopeIntent);

  let scopePickerIcon: ReactNode;
  if (props.viewSource.kind === "turn") {
    scopePickerIcon = <FaPlusMinus className="size-2.5 text-[var(--color-text-foreground)]" />;
  } else {
    scopePickerIcon = <ChangesIcon className={DIFF_PANEL_PICKER_ICON_CLASS_NAME} />;
  }

  const scopePickerCount =
    props.viewSource.kind === "repo" ? props.scopeFileCounts[props.viewSource.scope] : undefined;

  const selectedTurnSummary = props.selectedTurnId
    ? props.orderedTurnDiffSummaries.find((summary) => summary.turnId === props.selectedTurnId)
    : undefined;
  const turnsMenuLabel =
    props.viewSource.kind === "turn" && props.selectedTurnId === null
      ? "All turns"
      : props.viewSource.kind === "turn" && props.selectedTurnId
        ? `Turn ${
            selectedTurnSummary
              ? resolveTurnNumber(selectedTurnSummary, props.inferredCheckpointTurnCountByTurnId)
              : (props.inferredCheckpointTurnCountByTurnId[props.selectedTurnId] ?? "?")
          }`
        : "Turns";

  const latestTurnId = props.orderedTurnDiffSummaries[0]?.turnId ?? null;
  const scopePickerValue = resolveDiffPanelScopePickerValue({
    viewSource: props.viewSource,
    latestTurnId,
    turnScopeIntent: props.turnScopeIntent,
  });
  const selectedTurnIndex = props.selectedTurnId
    ? props.orderedTurnDiffSummaries.findIndex((summary) => summary.turnId === props.selectedTurnId)
    : -1;
  const effectiveVisibleTurnCount = Math.max(
    visibleTurnCount,
    selectedTurnIndex >= 0 ? selectedTurnIndex + 1 : 0,
  );
  const visibleTurnSummaries = props.orderedTurnDiffSummaries.slice(0, effectiveVisibleTurnCount);
  const hiddenTurnCount = Math.max(
    0,
    props.orderedTurnDiffSummaries.length - visibleTurnSummaries.length,
  );
  const nextVisibleTurnCount = Math.min(
    props.orderedTurnDiffSummaries.length,
    effectiveVisibleTurnCount + TURN_SHOW_MORE_INCREMENT,
  );

  return (
    <div className="flex h-full w-full min-w-0 items-center gap-2 [-webkit-app-region:no-drag]">
      <Menu
        {...(props.scopePickerOpen !== undefined ? { open: props.scopePickerOpen } : {})}
        onOpenChange={props.onScopePickerOpenChange}
      >
        <MenuTrigger
          render={
            <button
              type="button"
              className={DIFF_PANEL_PICKER_TRIGGER_CLASS_NAME}
              aria-label="Choose diff source"
            />
          }
        >
          <EnvironmentRowBody
            compact
            icon={scopePickerIcon}
            label={<span className="truncate">{scopePickerLabel}</span>}
            trailing={
              <>
                <ScopeCountBadge count={scopePickerCount} />
                <EnvironmentRowChevron />
              </>
            }
          />
        </MenuTrigger>
        <ComposerPickerMenuPopup
          align="start"
          side="bottom"
          sideOffset={6}
          className="w-56 min-w-56"
        >
          <MenuGroup>
            <MenuGroupLabel>Diff source</MenuGroupLabel>
            <MenuRadioGroup
              value={scopePickerValue ?? ""}
              onValueChange={(value) => {
                if (value === "allTurns") {
                  props.onSelectAllTurns();
                  return;
                }
                if (value === "lastTurn") {
                  props.onSelectLastTurn();
                  return;
                }
                if (
                  value === "workingTree" ||
                  value === "unstaged" ||
                  value === "staged" ||
                  value === "branch"
                ) {
                  props.onSelectRepoScope(value);
                }
              }}
            >
              {DIFF_PANEL_PICKER_SCOPE_OPTIONS.map((scope) => (
                <MenuRadioItem key={scope} value={scope}>
                  {resolveScopeMenuIcon(scope)}
                  <span className="min-w-0 flex-1 truncate">{REPO_DIFF_SCOPE_LABELS[scope]}</span>
                  <ScopeCountBadge count={props.scopeFileCounts[scope]} />
                </MenuRadioItem>
              ))}
              <MenuRadioItem value="allTurns">
                <GitCommitIcon className={DIFF_PANEL_MENU_ICON_CLASS_NAME} />
                <span className="min-w-0 flex-1 truncate">All turns</span>
              </MenuRadioItem>
              <MenuRadioItem value="lastTurn">
                {resolveScopeMenuIcon("lastTurn")}
                <span className="min-w-0 flex-1 truncate">Last turn</span>
              </MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        </ComposerPickerMenuPopup>
      </Menu>

      {props.activeStats ? (
        <DiffStat
          additions={props.activeStats.additions}
          deletions={props.activeStats.deletions}
          className="shrink-0 text-[11px] font-medium"
        />
      ) : null}

      <div className="ml-auto flex min-w-0 items-center gap-1.5">
        <div className="flex items-center gap-1">
          <Menu>
            <MenuTrigger
              render={
                <IconButton
                  variant="ghost"
                  size="icon-xs"
                  className={DIFF_PANEL_TOOLBAR_ICON_BUTTON_CLASS_NAME}
                  label="Diff view options"
                  title="Diff view options"
                >
                  <EllipsisIcon className="size-3.5" />
                </IconButton>
              }
            />
            <ComposerPickerMenuPopup
              align="end"
              side="bottom"
              sideOffset={6}
              className="w-60 min-w-60"
            >
              <MenuGroup>
                <MenuGroupLabel>View</MenuGroupLabel>
                <MenuRadioGroup
                  value={props.diffRenderMode}
                  onValueChange={(value) => {
                    if (value === "stacked" || value === "split") {
                      props.onDiffRenderModeChange(value);
                    }
                  }}
                >
                  <MenuRadioItem value="stacked">
                    <Rows3Icon className={DIFF_PANEL_PICKER_ICON_CLASS_NAME} />
                    <span>Stacked</span>
                  </MenuRadioItem>
                  <MenuRadioItem value="split">
                    <Columns2Icon className={DIFF_PANEL_PICKER_ICON_CLASS_NAME} />
                    <span>Split</span>
                  </MenuRadioItem>
                </MenuRadioGroup>
                <MenuCheckboxItem
                  checked={props.diffIgnoreWhitespace}
                  variant="switch"
                  onCheckedChange={(checked) => {
                    props.onDiffIgnoreWhitespaceChange(checked === true);
                  }}
                >
                  Ignore whitespace-only changes
                </MenuCheckboxItem>
                <MenuCheckboxItem
                  checked={props.diffWordWrap}
                  variant="switch"
                  onCheckedChange={(checked) => {
                    props.onDiffWordWrapChange(checked === true);
                  }}
                >
                  Wrap long lines
                </MenuCheckboxItem>
                {props.diffCopyText ? (
                  <MenuItem
                    onClick={() => {
                      props.onCopyDiff();
                    }}
                  >
                    <CopyIcon className={DIFF_PANEL_MENU_ICON_CLASS_NAME} />
                    <span>{props.isDiffCopied ? "Copied diff" : "Copy diff"}</span>
                  </MenuItem>
                ) : null}
                {props.renderableFiles.length > 0 ? (
                  <MenuItem
                    onClick={() => {
                      props.onToggleCollapseAll();
                    }}
                  >
                    <FolderIcon className={DIFF_PANEL_MENU_ICON_CLASS_NAME} />
                    <span>
                      {props.allFilesCollapsed ? "Expand all files" : "Collapse all files"}
                    </span>
                  </MenuItem>
                ) : null}
              </MenuGroup>
            </ComposerPickerMenuPopup>
          </Menu>

          <DiffPanelFileJumpMenu
            renderableFiles={props.renderableFiles}
            selectedFilePath={props.selectedFilePath}
            resolvedTheme={props.resolvedTheme}
            onSelectFile={props.onSelectFile}
          />

          <IconButton
            variant="ghost"
            size="icon-xs"
            className={cn(
              DIFF_PANEL_TOOLBAR_ICON_BUTTON_CLASS_NAME,
              props.fileTreeOpen &&
                "bg-[var(--color-background-button-secondary)] text-foreground hover:text-foreground",
            )}
            aria-pressed={props.fileTreeOpen}
            label={props.fileTreeOpen ? "Hide file tree" : "Show file tree"}
            title={props.fileTreeOpen ? "Hide file tree" : "Show file tree"}
            onClick={props.onToggleFileTree}
          >
            <FoldersIcon className="size-3.5" />
          </IconButton>
        </div>

        <DiffPanelToolbarDivider />

        {props.activeCwd ? (
          <GitActionsControl
            gitCwd={props.activeCwd}
            activeThreadId={props.activeThreadId}
            hideQuickActionLabel
          />
        ) : null}

        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                className={cn(DIFF_PANEL_PICKER_TRIGGER_CLASS_NAME, "max-w-[min(32%,9.5rem)]")}
                aria-label="Choose turn diff"
              />
            }
          >
            <EnvironmentRowBody
              compact
              icon={<FaPlusMinus className="size-2.5 text-[var(--color-text-foreground)]" />}
              label={<span className="truncate">{turnsMenuLabel}</span>}
              trailing={<EnvironmentRowChevron />}
            />
          </MenuTrigger>
          <ComposerPickerMenuPopup
            align="end"
            side="bottom"
            sideOffset={6}
            className="w-60 min-w-60"
          >
            <MenuGroup>
              <MenuGroupLabel>Turns</MenuGroupLabel>
              <MenuRadioGroup
                value={props.selectedTurnId ?? "all-turns"}
                onValueChange={(value) => {
                  if (value === "all-turns") {
                    props.onSelectTurn(null);
                    return;
                  }
                  props.onSelectTurn(value as TurnId);
                }}
              >
                <MenuRadioItem value="all-turns">
                  <GitCommitIcon className={DIFF_PANEL_MENU_ICON_CLASS_NAME} />
                  <span className="min-w-0 flex-1 truncate">All turns</span>
                </MenuRadioItem>
                {visibleTurnSummaries.map((summary) => (
                  <MenuRadioItem key={summary.turnId} value={summary.turnId}>
                    <FaPlusMinus className="size-2.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">
                      Turn {resolveTurnNumber(summary, props.inferredCheckpointTurnCountByTurnId)}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                      {formatShortTimestamp(summary.completedAt, props.timestampFormat)}
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
              {hiddenTurnCount > 0 ? (
                <button
                  type="button"
                  className={cn(
                    "mx-1 mt-1 flex h-8 w-[calc(100%-0.5rem)] cursor-pointer items-center justify-center rounded-md px-2 text-[11px]",
                    "text-muted-foreground transition-colors hover:bg-[var(--color-background-elevated-secondary)] hover:text-foreground",
                  )}
                  onClick={() => setVisibleTurnCount(nextVisibleTurnCount)}
                >
                  Show {Math.min(TURN_SHOW_MORE_INCREMENT, hiddenTurnCount)} more
                </button>
              ) : null}
            </MenuGroup>
          </ComposerPickerMenuPopup>
        </Menu>

        {props.onClosePanel ? (
          <>
            <DiffPanelToolbarDivider />
            <IconButton
              variant="chrome"
              size="icon-xs"
              label="Close file view"
              className={DOCK_HEADER_ICON_BUTTON_CLASS}
              onClick={(event) => {
                event.stopPropagation();
                props.onClosePanel?.();
              }}
            >
              <XIcon className="size-3.5" />
            </IconButton>
          </>
        ) : null}
      </div>
    </div>
  );
};

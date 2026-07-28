// FILE: WorkflowRunCard.tsx
// Purpose: Workflow run panel stacked above the composer (Claude dynamic
// workflows): workflow name/description header with running counts and
// pause/stop actions, a clickable phase rail (auto-follows the current phase
// until the user picks one) whose right pane shows only the selected phase's
// agents, and one expandable row per agent (status dot, label, model, effort,
// tokens, elapsed) whose inline detail adds tool calls, the prompt, and recent
// tool activity. Settled runs keep the card with the persisted script
// path/runId and a resume action.
// Layer: Chat composer UI
// Exports: WorkflowRunCard

import type { ThreadId } from "@synara/contracts";
import { getModelCapabilities } from "@synara/shared/model";
import { pluralize } from "@synara/shared/text";
import { useState } from "react";

import { formatContextWindowTokens } from "~/lib/contextWindow";
import {
  subagentStatusDotClassName,
  subagentStatusTextToneClassName,
} from "~/lib/subagentPresentation";
import {
  CheckIcon,
  CopyIcon,
  LoaderIcon,
  PanelCollapseIcon,
  PanelExpandIcon,
  PauseIcon,
  PlayIcon,
  StopIcon,
  WorkflowIcon,
  XIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { formatClockDuration } from "../../session-logic";
import { Button } from "../ui/button";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import {
  workflowElapsedMs,
  type WorkflowAgentRow,
  type WorkflowRunState,
} from "./WorkflowRunCard.logic";
import {
  ComposerStackedPanelHeaderRow,
  ComposerStackedPanelRowLabel,
  ComposerStackedPanelRowMain,
} from "./ComposerStackedPanelContent";
import { ComposerStackedPanel } from "./ComposerStackedPanel";
import {
  COMPOSER_STACKED_PANEL_BODY_PADDING_CLASS_NAME,
  COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME,
  COMPOSER_STACKED_PANEL_ICON_CLASS_NAME,
  COMPOSER_STACKED_PANEL_SCROLL_REGION_CLASS_NAME,
} from "./composerStackedPanelStyles";

interface WorkflowRunCardProps {
  workflowRun: WorkflowRunState;
  nowMs: number;
  compact: boolean;
  onCompactChange: (compact: boolean) => void;
  onOpenThread: (threadId: ThreadId) => void;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
  onDismiss: () => void;
  attachedToPrevious?: boolean;
}

function settledWorkflowPresentation(workflowRun: WorkflowRunState): {
  label: string;
  toneClassName: string;
} {
  if (workflowRun.pausedByUser) {
    return { label: "Paused", toneClassName: "text-amber-300/80" };
  }
  switch (workflowRun.status) {
    case "paused":
      return { label: "Paused", toneClassName: "text-amber-300/80" };
    case "failed":
      return { label: "Failed", toneClassName: "text-rose-300/85" };
    case "stopped":
      return { label: "Stopped", toneClassName: "text-amber-300/80" };
    default:
      return { label: "Completed", toneClassName: "text-emerald-300/75" };
  }
}

function agentRowMeta(agent: WorkflowAgentRow, nowMs: number): string | null {
  const elapsedMs = workflowElapsedMs(agent, nowMs);
  const parts = [
    agent.totalTokens !== null ? `${formatContextWindowTokens(agent.totalTokens)} tokens` : null,
    elapsedMs !== null ? formatClockDuration(elapsedMs) : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function agentContextWindowTokens(agent: WorkflowAgentRow): number | undefined {
  if (!agent.model) {
    return undefined;
  }
  const contextWindowTokens = getModelCapabilities("claudeAgent", agent.model).contextWindowTokens;
  return typeof contextWindowTokens === "number" && contextWindowTokens > 0
    ? contextWindowTokens
    : undefined;
}

function agentDetailStatsLine(agent: WorkflowAgentRow, nowMs: number): string | null {
  const elapsedMs = workflowElapsedMs(agent, nowMs);
  const parts = [
    agent.totalTokens !== null ? `${formatContextWindowTokens(agent.totalTokens)} tokens` : null,
    agent.toolCalls !== null
      ? `${agent.toolCalls} ${pluralize(agent.toolCalls, "tool call")}`
      : null,
    elapsedMs !== null ? formatClockDuration(elapsedMs) : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function WorkflowAgentDetail({
  agent,
  nowMs,
  onOpenThread,
}: {
  agent: WorkflowAgentRow;
  nowMs: number;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const [promptOpen, setPromptOpen] = useState(false);
  const contextWindowTokens = agentContextWindowTokens(agent);
  const identityLine = [
    agent.statusLabel,
    agent.modelLabel,
    agent.effortLabel ? `${agent.effortLabel} effort` : null,
    contextWindowTokens !== undefined
      ? `${formatContextWindowTokens(contextWindowTokens)} window`
      : null,
  ]
    .filter((part): part is string => part !== null && part !== undefined)
    .join(" · ");
  const statsLine = agentDetailStatsLine(agent, nowMs);
  const { threadId } = agent;

  return (
    <div
      data-testid="workflow-agent-detail"
      className="mb-1 ml-[14px] space-y-1.5 rounded-md border border-border/40 bg-muted/20 px-2 py-1.5"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/70">
          {identityLine}
        </span>
        {threadId ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-5 shrink-0 px-1.5 text-[10px] text-muted-foreground/70"
            onClick={() => onOpenThread(threadId)}
          >
            Open thread
          </Button>
        ) : null}
      </div>
      {statsLine ? (
        <div className="text-[11px] tabular-nums text-muted-foreground/55">{statsLine}</div>
      ) : null}
      {agent.promptPreview ? (
        <div>
          <button
            type="button"
            className="flex w-full min-w-0 items-center gap-1 text-left"
            aria-expanded={promptOpen}
            onClick={() => setPromptOpen((open) => !open)}
          >
            <DisclosureChevron open={promptOpen} className="shrink-0" />
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/45">
              Prompt
            </span>
          </button>
          {promptOpen ? null : (
            <div className="line-clamp-2 whitespace-pre-wrap font-mono text-[11px] leading-4 text-muted-foreground/65">
              {agent.promptPreview}
            </div>
          )}
          <DisclosureRegion open={promptOpen}>
            <div className="whitespace-pre-wrap font-mono text-[11px] leading-4 text-muted-foreground/65">
              {agent.promptPreview}
            </div>
          </DisclosureRegion>
        </div>
      ) : null}
      {agent.recentToolNames.length > 0 ? (
        <div className="min-w-0 truncate text-[11px] text-muted-foreground/55">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/45">
            Recent
          </span>{" "}
          <span className="font-mono">{agent.recentToolNames.join(" · ")}</span>
        </div>
      ) : null}
    </div>
  );
}

function WorkflowAgentRowView({
  agent,
  nowMs,
  expanded,
  onToggle,
  onOpenThread,
}: {
  agent: WorkflowAgentRow;
  nowMs: number;
  expanded: boolean;
  onToggle: () => void;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const meta = agentRowMeta(agent, nowMs);

  return (
    <div>
      <button
        type="button"
        data-testid="workflow-agent-row"
        className="group -mx-1 flex w-[calc(100%+0.5rem)] min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-[var(--color-background-button-secondary-hover)]"
        title={agent.description}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            subagentStatusDotClassName(agent.statusKind),
          )}
        />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground/85">
          {agent.description}
          {agent.subagentType ? (
            <span className="ml-1 text-[11px] font-normal text-muted-foreground/55">
              ({agent.subagentType})
            </span>
          ) : null}
          {agent.modelLabel ? (
            <span className="ml-1.5 text-[11px] font-normal text-muted-foreground/45">
              {agent.modelLabel}
            </span>
          ) : null}
          {agent.effortLabel ? (
            <span className="ml-1 text-[11px] font-normal text-muted-foreground/35">
              {agent.effortLabel}
            </span>
          ) : null}
        </span>
        {meta ? (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">{meta}</span>
        ) : null}
        <span
          className={cn("shrink-0 text-[11px]", subagentStatusTextToneClassName(agent.statusKind))}
        >
          {agent.statusLabel}
        </span>
        <DisclosureChevron
          open={expanded}
          className={cn(
            "shrink-0 text-muted-foreground/40 transition-opacity",
            !expanded && "opacity-0 group-focus-visible:opacity-100 group-hover:opacity-100",
          )}
        />
      </button>
      <DisclosureRegion open={expanded}>
        <WorkflowAgentDetail agent={agent} nowMs={nowMs} onOpenThread={onOpenThread} />
      </DisclosureRegion>
    </div>
  );
}

export function WorkflowRunCard({
  workflowRun,
  nowMs,
  compact,
  onCompactChange,
  onOpenThread,
  onStop,
  onPause,
  onResume,
  onDismiss,
  attachedToPrevious: attachedToPreviousProp,
}: WorkflowRunCardProps) {
  const attachedToPrevious = attachedToPreviousProp ?? false;
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  // Default view lists every phase's agents (grouped); a pill click narrows to
  // one phase, clicking it again returns to the full list.
  const [filterPhaseTitle, setFilterPhaseTitle] = useState<string | null>(null);
  const [expandedAgentIds, setExpandedAgentIds] = useState<ReadonlySet<string>>(new Set());
  const toggleAgentExpanded = (taskId: string) => {
    setExpandedAgentIds((previous) => {
      const next = new Set(previous);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  };
  const totalCount = workflowRun.agents.length;
  const startedAtMs = Date.parse(workflowRun.startedAt);
  const elapsedLabel =
    workflowRun.settled || Number.isNaN(startedAtMs)
      ? null
      : formatClockDuration(Math.max(0, nowMs - startedAtMs));
  const countLabel =
    totalCount > 0
      ? workflowRun.runningCount > 0
        ? `${workflowRun.runningCount} of ${totalCount} ${pluralize(totalCount, "agent")} running`
        : `${totalCount} ${pluralize(totalCount, "agent")}`
      : workflowRun.settled
        ? null
        : "Starting agents";
  const settledPresentation = workflowRun.settled ? settledWorkflowPresentation(workflowRun) : null;
  const canResume =
    workflowRun.settled && workflowRun.runId !== null && workflowRun.scriptPath !== null;
  const savedLine = workflowRun.settled
    ? [workflowRun.scriptPath, workflowRun.runId].filter((part) => part !== null).join(" · ")
    : "";
  const phaseGroups = workflowRun.phases?.map((phase) => ({
    phase,
    agents: workflowRun.agents.filter((agent) => agent.phase === phase.title),
  }));
  // A single phase carries no navigation value: skip the pills and captions
  // and list every agent flat. With several phases everything stays visible,
  // grouped under small captions, and the pills act as optional filters.
  const showPhasePills = (phaseGroups?.length ?? 0) > 1;
  const selectedPhaseTitle =
    filterPhaseTitle !== null && phaseGroups?.some(({ phase }) => phase.title === filterPhaseTitle)
      ? filterPhaseTitle
      : null;
  const visibleGroups =
    showPhasePills && phaseGroups
      ? phaseGroups.filter(
          ({ phase, agents }) =>
            (selectedPhaseTitle === null || phase.title === selectedPhaseTitle) &&
            agents.length > 0,
        )
      : null;
  const selectPhase = (title: string) => {
    setFilterPhaseTitle((previous) => (previous === title ? null : title));
  };

  return (
    <ComposerStackedPanel
      passthroughSideMargins
      attachedToPrevious={attachedToPrevious}
      data-testid="workflow-run-card"
    >
      <ComposerStackedPanelHeaderRow>
        <ComposerStackedPanelRowMain title={workflowRun.description ?? undefined}>
          {compact && workflowRun.runningCount > 0 ? (
            <LoaderIcon className={cn(COMPOSER_STACKED_PANEL_ICON_CLASS_NAME, "animate-spin")} />
          ) : (
            <WorkflowIcon className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
          )}
          <ComposerStackedPanelRowLabel tone="meta">
            <span className="font-medium text-foreground/80">{workflowRun.name}</span>
            {settledPresentation ? (
              <span className={cn("ml-1.5", settledPresentation.toneClassName)}>
                {settledPresentation.label}
              </span>
            ) : null}
            {countLabel ? <span className="ml-1.5">{countLabel}</span> : null}
            {elapsedLabel ? <span className="ml-1.5 tabular-nums">{elapsedLabel}</span> : null}
          </ComposerStackedPanelRowLabel>
        </ComposerStackedPanelRowMain>
        <div className="flex shrink-0 items-center gap-0.5">
          {workflowRun.settled ? (
            <>
              {canResume ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className={COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME}
                  onClick={onResume}
                  aria-label="Resume workflow"
                  title="Resume workflow"
                >
                  <PlayIcon className="size-3" />
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className={COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME}
                onClick={onDismiss}
                aria-label="Dismiss workflow panel"
                title="Dismiss workflow panel"
              >
                <XIcon className="size-3" />
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className={COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME}
                onClick={onPause}
                aria-label="Pause workflow"
                title="Pause workflow (resume replays completed agents from cache)"
              >
                <PauseIcon className="size-3" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className={COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME}
                onClick={onStop}
                aria-label="Stop workflow"
                title="Stop workflow"
              >
                <StopIcon className="size-3" />
              </Button>
            </>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME}
            onClick={() => onCompactChange(!compact)}
            aria-label={compact ? "Expand workflow panel" : "Collapse workflow panel"}
            title={compact ? "Expand workflow panel" : "Collapse workflow panel"}
          >
            {compact ? (
              <PanelExpandIcon className="size-3" />
            ) : (
              <PanelCollapseIcon className="size-3" />
            )}
          </Button>
        </div>
      </ComposerStackedPanelHeaderRow>

      <DisclosureRegion open={!compact && (workflowRun.agents.length > 0 || savedLine.length > 0)}>
        <div className={COMPOSER_STACKED_PANEL_BODY_PADDING_CLASS_NAME}>
          {showPhasePills ? (
            <div
              data-testid="workflow-phase-rail"
              className="-ml-2 flex min-w-0 flex-wrap items-center gap-1 pb-1"
            >
              {phaseGroups!.map(({ phase }) => (
                <button
                  key={phase.title}
                  type="button"
                  data-testid="workflow-phase-rail-item"
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] transition-colors",
                    phase.title === selectedPhaseTitle
                      ? "bg-[var(--color-background-button-secondary)] text-foreground/85"
                      : "text-muted-foreground/60 hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground/70",
                  )}
                  title={phase.detail ?? undefined}
                  aria-pressed={phase.title === selectedPhaseTitle}
                  onClick={() => selectPhase(phase.title)}
                >
                  <span className={cn("truncate", phase.isCurrent && "font-medium")}>
                    {phase.title}
                  </span>
                  {phase.totalCount > 0 ? (
                    <span className="tabular-nums opacity-60">
                      {phase.doneCount}/{phase.totalCount}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
          <div
            className={cn("space-y-0", COMPOSER_STACKED_PANEL_SCROLL_REGION_CLASS_NAME)}
            data-testid="workflow-phase-group"
          >
            {visibleGroups ? (
              visibleGroups.length > 0 ? (
                visibleGroups.map(({ phase, agents }) => (
                  <div key={phase.title}>
                    <div className="pt-1 text-[10px] font-medium text-muted-foreground/50">
                      {phase.title}
                    </div>
                    {agents.map((agent) => (
                      <WorkflowAgentRowView
                        key={agent.taskId}
                        agent={agent}
                        nowMs={nowMs}
                        expanded={expandedAgentIds.has(agent.taskId)}
                        onToggle={() => toggleAgentExpanded(agent.taskId)}
                        onOpenThread={onOpenThread}
                      />
                    ))}
                  </div>
                ))
              ) : (
                <div className="py-1 text-[11px] text-muted-foreground/45">No agents yet</div>
              )
            ) : workflowRun.agents.length > 0 ? (
              workflowRun.agents.map((agent) => (
                <WorkflowAgentRowView
                  key={agent.taskId}
                  agent={agent}
                  nowMs={nowMs}
                  expanded={expandedAgentIds.has(agent.taskId)}
                  onToggle={() => toggleAgentExpanded(agent.taskId)}
                  onOpenThread={onOpenThread}
                />
              ))
            ) : (
              <div className="py-1 text-[11px] text-muted-foreground/45">No agents yet</div>
            )}
          </div>
          {savedLine.length > 0 ? (
            <div
              data-testid="workflow-saved-line"
              className="mt-0.5 flex min-w-0 items-center gap-1.5"
            >
              <span className="shrink-0 text-[11px] text-muted-foreground/50">Saved</span>
              <span
                className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/45"
                title={savedLine}
              >
                {workflowRun.runId ?? workflowRun.scriptPath}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className={COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME}
                onClick={() => copyToClipboard(savedLine, undefined)}
                aria-label="Copy script path and run id"
                title={savedLine}
              >
                {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
              </Button>
            </div>
          ) : null}
        </div>
      </DisclosureRegion>
    </ComposerStackedPanel>
  );
}

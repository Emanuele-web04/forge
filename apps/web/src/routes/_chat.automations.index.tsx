import { type AutomationDefinition, type AutomationRun } from "@synara/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";

import { getProviderStartOptions, useAppSettings } from "~/appSettings";
import {
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  CHAT_SURFACE_HEADER_PADDING_X_CLASS,
} from "~/components/chat/chatHeaderControls";
import { CHAT_BACKGROUND_CLASS_NAME } from "~/components/chat/composerPickerStyles";
import { SidebarHeaderNavigationControls } from "~/components/SidebarHeaderNavigationControls";
import { Button } from "~/components/ui/button";
import { RouteInsetSurface } from "~/components/RouteInsetSurface";
import {
  hasBlockingAutomationDraftWarnings,
  updateAutomationDraftWarningAcknowledgement,
  type AutomationDraftWarning,
  type AutomationDraftWarningId,
} from "~/lib/automationDraft";
import { automationLifecycleState } from "~/lib/automationStatus";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { CentralIcon } from "~/lib/central-icons";
import { cn } from "~/lib/utils";
import { ELEVATED_HOVER_SURFACE_CLASS_NAME } from "~/surfaceStyles";
import { ensureNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { createAllThreadsSelector } from "~/storeSelectors";
import {
  type AutomationFormState,
  AutomationDialog,
  acknowledgedRiskIdsForFormWarnings,
  automationAttentionLabel,
  automationListRowIcon,
  buildAutomationFormWarnings,
  createInputFromForm,
  formatCadenceLong,
  formatNextRun,
  formFromDefinition,
  isFormSubmittable,
  isLiveRun,
  isRowInteractiveEventTarget,
  isUnresolvedTriageResult,
  projectModelSelection,
  runStatusLabel,
  useAutomations,
} from "./-automations.shared";

export const Route = createFileRoute("/_chat/automations/")({
  component: AutomationsRouteView,
});

const selectAllThreads = createAllThreadsSelector();

/** Unread successful result the user has not opened yet — surfaced as quiet row meta. */
function hasUnreadResult(run: AutomationRun | null): boolean {
  return run?.status === "succeeded" && isUnresolvedTriageResult(run.result);
}

/**
 * Minimal automation list row: a leading status glyph, a two-line title/detail stack,
 * and optional right-aligned meta plus a hover delete. `dimmed` mutes the title for
 * paused rows.
 */
function AutomationListRow({
  onClick,
  leading,
  title,
  detail,
  meta,
  onDelete,
  dimmed: dimmedProp,
}: {
  readonly onClick: () => void;
  readonly leading: ReactNode;
  readonly title: string;
  readonly detail: string;
  readonly meta?: ReactNode;
  readonly onDelete?: () => void;
  readonly dimmed?: boolean;
}) {
  const dimmed = dimmedProp ?? false;
  return (
    // A div with role="button" (not a real <button>) so inline controls like the hover delete
    // can be nested buttons; the keydown guard lets those controls handle their own events
    // without also firing the row's navigation.
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (isRowInteractiveEventTarget(event.target, event.currentTarget)) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
      className={cn(
        "group flex w-full cursor-pointer items-start gap-2.5 rounded-md px-2 py-2.5 text-left",
        ELEVATED_HOVER_SURFACE_CLASS_NAME,
      )}
    >
      <span className="mt-0.5 flex shrink-0">{leading}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn(
            "truncate text-[0.8125rem]",
            dimmed ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {title}
        </span>
        <span
          className={cn(
            "truncate text-xs",
            dimmed ? "text-muted-foreground/60" : "text-muted-foreground",
          )}
        >
          {detail}
        </span>
      </span>
      {meta == null ? null : (
        <span className="shrink-0 self-center text-xs tabular-nums text-muted-foreground">
          {meta}
        </span>
      )}
      {onDelete ? (
        <button
          type="button"
          aria-label="Delete automation"
          title="Delete"
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
          className="shrink-0 self-center rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        >
          <CentralIcon name="trash-can-simple" className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

const AUTOMATION_STATUS_FILTERS = ["all", "active", "paused"] as const;
type AutomationStatusFilter = (typeof AUTOMATION_STATUS_FILTERS)[number];

/**
 * Second line of an automation row: the spelled-out cadence, then the live run status
 * while a run is in flight, the next-run countdown while the automation is active, or
 * "Done" once a one-shot has fired. When the latest run ended badly the warning
 * ("Last run failed", …) is appended so the amber glyph always has words next to it;
 * a warned one-shot skips the redundant "Done".
 */
function rowSubtitle(
  definition: AutomationDefinition,
  latestRun: AutomationRun | null,
  now: number,
): string {
  const segments = [formatCadenceLong(definition.schedule)];
  if (isLiveRun(latestRun)) {
    segments.push(runStatusLabel(latestRun.status));
    return segments.join(" · ");
  }
  const attention = latestRun === null ? null : automationAttentionLabel(latestRun);
  if (definition.enabled) {
    const nextRun = formatNextRun(definition.nextRunAt, now);
    if (nextRun) segments.push(`Next run ${nextRun}`);
  } else {
    const stopped = stoppedReasonLabel(definition);
    if (stopped) {
      segments.push(stopped);
      return segments.join(" · ");
    }
    if (attention === null && automationLifecycleState(definition) === "done") {
      segments.push("Done");
    }
  }
  if (attention) segments.push(attention);
  return segments.join(" · ");
}

// Why the server stopped an automation on its own. "schedule" and "user" return null:
// the row already reads "Done" / renders dimmed as paused for those.
function stoppedReasonLabel(definition: AutomationDefinition): string | null {
  switch (definition.disabledReason) {
    case "failures":
      return definition.consecutiveFailureCount === 1
        ? "Stopped after a failed run"
        : `Stopped after ${definition.consecutiveFailureCount} failed runs`;
    case "max-iterations":
      return "Stopped at run limit";
    case "completion":
      return "Stop condition met";
    default:
      return null;
  }
}

function AutomationsRouteView() {
  const navigate = useNavigate();
  const { settings } = useAppSettings();
  const desktopTopBarTrafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  const desktopTopBarWindowControlsGutterClassName =
    useDesktopTopBarWindowControlsGutterClassName();
  const projects = useStore((state) => state.projects);
  const threads = useStore(selectAllThreads);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogWarnings, setDialogWarnings] = useState<readonly AutomationDraftWarning[]>([]);
  const [acknowledgedWarningIds, setAcknowledgedWarningIds] = useState<
    ReadonlySet<AutomationDraftWarningId>
  >(() => new Set());
  const [statusFilter, setStatusFilter] = useState<AutomationStatusFilter>("all");
  // Coarse clock for the "Next run in …" countdowns; nothing else in the row is time-derived.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const fallbackProjectId = projects[0]?.id ?? "";
  const [form, setForm] = useState<AutomationFormState>(() =>
    formFromDefinition(null, fallbackProjectId, projectModelSelection(projects, fallbackProjectId)),
  );

  const { data, isLoading, refetch, createMutation, deleteMutation, runsByAutomationId } =
    useAutomations((threadId) => void navigate({ to: "/$threadId", params: { threadId } }));
  const providerOptionsForDispatch = getProviderStartOptions(settings);

  const updateDialogForm = (nextForm: AutomationFormState) => {
    setForm(nextForm);
    setDialogWarnings(buildAutomationFormWarnings(nextForm));
  };

  const toggleWarning = (id: AutomationDraftWarningId, checked: boolean) => {
    setAcknowledgedWarningIds((current) =>
      updateAutomationDraftWarningAcknowledgement(current, id, checked),
    );
  };

  const openCreateDialog = () => {
    const nextForm = formFromDefinition(
      null,
      fallbackProjectId,
      projectModelSelection(projects, fallbackProjectId),
    );
    setForm(nextForm);
    setDialogWarnings(buildAutomationFormWarnings(nextForm));
    setAcknowledgedWarningIds(new Set());
    setDialogOpen(true);
  };

  const submitForm = () => {
    if (!isFormSubmittable(form)) return;
    if (hasBlockingAutomationDraftWarnings(dialogWarnings, acknowledgedWarningIds)) return;
    const acknowledgedRisks = acknowledgedRiskIdsForFormWarnings(
      dialogWarnings,
      acknowledgedWarningIds,
    );
    createMutation.mutate(
      createInputFromForm(form, providerOptionsForDispatch, acknowledgedRisks),
      {
        onSuccess: () => setDialogOpen(false),
      },
    );
  };

  const deleteDefinition = async (definition: AutomationDefinition) => {
    const confirmed = await ensureNativeApi().dialogs.confirm(`Delete "${definition.name}"?`);
    if (!confirmed) return;
    deleteMutation.mutate(definition);
  };

  const active = data.definitions.filter((definition) => definition.enabled);
  const paused = data.definitions.filter((definition) => !definition.enabled);
  const filteredDefinitions =
    statusFilter === "active"
      ? active
      : statusFilter === "paused"
        ? paused
        : [...active, ...paused];

  const renderRow = (definition: AutomationDefinition) => {
    const latestRun: AutomationRun | null = runsByAutomationId.get(definition.id)?.[0] ?? null;
    return (
      <AutomationListRow
        key={definition.id}
        dimmed={!definition.enabled}
        onClick={() =>
          void navigate({
            to: "/automations/$automationId",
            params: { automationId: definition.id },
          })
        }
        leading={(() => {
          const icon = automationListRowIcon(definition, latestRun);
          return <CentralIcon name={icon.name} className={icon.className} />;
        })()}
        title={definition.name}
        detail={rowSubtitle(definition, latestRun, now)}
        meta={hasUnreadResult(latestRun) ? "New result" : undefined}
        onDelete={() => void deleteDefinition(definition)}
      />
    );
  };

  const renderStatusFilter = () => (
    <div className="flex items-center gap-1 px-2">
      {AUTOMATION_STATUS_FILTERS.map((value) => (
        <button
          key={value}
          type="button"
          onClick={() => setStatusFilter(value)}
          className={cn(
            "rounded-lg px-2.5 py-1 text-xs font-medium capitalize transition-colors",
            statusFilter === value
              ? "bg-[var(--color-background-elevated-secondary)] text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {value}
        </button>
      ))}
    </div>
  );

  const renderAutomationList = () => (
    <section className="flex flex-col gap-2">
      {renderStatusFilter()}
      {filteredDefinitions.length === 0 ? (
        <div className="px-2 py-4 text-xs text-muted-foreground">
          {statusFilter === "paused" ? "No paused automations." : "No active automations."}
        </div>
      ) : (
        <div className="flex flex-col">{filteredDefinitions.map(renderRow)}</div>
      )}
    </section>
  );

  return (
    <RouteInsetSurface>
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          CHAT_BACKGROUND_CLASS_NAME,
        )}
      >
        <header
          className={cn(
            CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
            CHAT_SURFACE_HEADER_PADDING_X_CLASS,
            "drag-region",
            desktopTopBarTrafficLightGutterClassName,
            desktopTopBarWindowControlsGutterClassName,
          )}
        >
          <div className={cn("flex items-center gap-2 sm:gap-3", CHAT_SURFACE_HEADER_HEIGHT_CLASS)}>
            <SidebarHeaderNavigationControls />
            <div className="min-w-0 flex-1" />
            <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Refresh"
                title="Refresh"
                onClick={() => void refetch()}
              >
                <CentralIcon name="arrow-rotate-clockwise" className="size-4" />
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={openCreateDialog}
                disabled={projects.length === 0}
              >
                <CentralIcon name="plus-small" className="size-4" />
                New automation
              </Button>
            </div>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 pb-12 pt-8">
            <h1 className="px-2 font-heading text-2xl font-semibold tracking-tight text-foreground">
              Automations
            </h1>
            {isLoading ? (
              <div className="py-16 text-center text-sm text-muted-foreground">
                Loading automations...
              </div>
            ) : data.definitions.length === 0 ? (
              <div className="flex flex-col items-center gap-1 py-16 text-center">
                <p className="text-sm font-medium text-foreground">No automations yet</p>
                <p className="max-w-xs text-xs text-muted-foreground">
                  Schedule a prompt to run on its own, or wake an existing thread on a loop.
                </p>
              </div>
            ) : (
              renderAutomationList()
            )}
          </div>
        </main>
      </div>

      <AutomationDialog
        open={dialogOpen}
        form={form}
        projects={projects}
        threads={threads}
        warnings={dialogWarnings}
        acknowledgedWarningIds={acknowledgedWarningIds}
        onToggleWarning={toggleWarning}
        onOpenChange={setDialogOpen}
        onFormChange={updateDialogForm}
        onSubmit={submitForm}
        busy={createMutation.isPending}
      />
    </RouteInsetSurface>
  );
}

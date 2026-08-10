import {
  type AutomationDefinition,
  type AutomationRun,
  type AutomationUpdateInput,
  type AutomationWorktreeMode,
  type ModelSelection,
  type ProviderOptionDescriptor,
} from "@synara/contracts";
import {
  automationContinuationThreadId,
  automationRequiresTargetThread,
} from "@synara/shared/automationMode";
import {
  getModelCapabilities,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@synara/shared/model";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { getProviderStartOptions, useAppSettings } from "~/appSettings";
import { AutomationProposalActions } from "~/components/automation/AutomationProposalActions";
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
  automationApprovalGaps,
  hasBlockingAutomationDraftWarnings,
  updateAutomationDraftWarningAcknowledgement,
  warningIdsForAcknowledgedRisks,
  type AutomationDraftWarning,
  type AutomationDraftWarningId,
} from "~/lib/automationDraft";
import {
  completionPolicyFromStopWhen,
  stopWhenFromCompletionPolicy,
} from "@synara/shared/automationCompletionPolicy";
import { automationLifecycleState, canPauseAutomation } from "~/lib/automationStatus";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { CentralIcon } from "~/lib/central-icons";
import { cn } from "~/lib/utils";
import {
  buildModelSelectionForTarget,
  buildNextProviderOptions,
  buildProviderOptionPatch,
  type ProviderOptions,
} from "~/providerModelOptions";
import { ensureNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { createAllThreadsSelector } from "~/storeSelectors";
import {
  type AutomationFormState,
  AutomationApprovalBanner,
  AutomationDialog,
  AutomationModelPicker,
  acknowledgedRiskIdsForFormWarnings,
  buildAutomationFormWarnings,
  canCancelAutomationRun,
  datetimeLocalFromIso,
  formatRelativeTime,
  formFromDefinition,
  isoFromDatetimeLocal,
  isRowInteractiveEventTarget,
  isTriageRun,
  isFormSubmittable,
  maxIterationOptions,
  providerOptionsForAutomationEdit,
  providerOptionsForAutomationModelSelection,
  runResultSummary,
  runResultTitle,
  runStatusLabel,
  RunStatusIndicator,
  SCHEDULE_KIND_OPTIONS,
  scheduleFromKind,
  scheduleKindFromSchedule,
  updateWeeklyScheduleDay,
  updateWeeklyScheduleTime,
  updateInputFromForm,
  useAutomations,
  weekdayLabel,
} from "./-automations.shared";
import { resolveThreadPickerTitle } from "./-chatThreadRoute.logic";

export const Route = createFileRoute("/_chat/automations/$automationId")({
  component: AutomationDetailView,
});

const selectAllThreads = createAllThreadsSelector();

function lastFinishedRun(runs: readonly AutomationRun[]): AutomationRun | null {
  return runs.find((run) => run.finishedAt != null || run.startedAt != null) ?? null;
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

const RUN_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});
const RUN_DATE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

// Reference-style absolute timestamp: "Today at 09:00", "Tomorrow at 12:30", "5 May 2026, 09:05".
function formatRunTimestamp(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const time = RUN_TIME_FORMATTER.format(date);
  const dayDelta = Math.round((startOfDay(date) - startOfDay(new Date())) / 86_400_000);
  if (dayDelta === 0) return `Today at ${time}`;
  if (dayDelta === 1) return `Tomorrow at ${time}`;
  if (dayDelta === -1) return `Yesterday at ${time}`;
  return RUN_DATE_TIME_FORMATTER.format(date);
}

// Presentation for the Status pill: maps the shared lifecycle state to a label and dot color.
// The state decision lives in ~/lib/automationStatus so this pill and the list never drift.
function automationStatusDisplay(definition: AutomationDefinition): {
  readonly label: string;
  readonly dotClassName: string;
} {
  switch (automationLifecycleState(definition)) {
    case "active":
      return { label: "Active", dotClassName: "bg-emerald-500" };
    case "paused":
      return { label: "Paused", dotClassName: "bg-amber-500" };
    case "scheduled":
      return { label: "Scheduled", dotClassName: "bg-sky-500" };
    case "done":
      return { label: "Done", dotClassName: "bg-muted-foreground" };
  }
}

type SelectOption = { readonly value: string; readonly label: string };

const MODE_LABELS: Record<AutomationDefinition["mode"], string> = {
  standalone: "Standalone",
  heartbeat: "Heartbeat",
  dedicated: "Dedicated thread",
};

const WORKTREE_OPTIONS: readonly SelectOption[] = [
  { value: "auto", label: "Auto" },
  { value: "local", label: "Local" },
  { value: "worktree", label: "Worktree" },
];

function worktreeModeLabel(mode: AutomationWorktreeMode): string {
  return WORKTREE_OPTIONS.find((option) => option.value === mode)?.label ?? mode;
}

const INTERVAL_PRESETS: readonly SelectOption[] = [
  { value: "900", label: "Every 15 min" },
  { value: "1800", label: "Every 30 min" },
  { value: "3600", label: "Every hour" },
  { value: "7200", label: "Every 2 hours" },
  { value: "21600", label: "Every 6 hours" },
  { value: "43200", label: "Every 12 hours" },
  { value: "86400", label: "Every 24 hours" },
];

function intervalOptions(current: number): readonly SelectOption[] {
  if (INTERVAL_PRESETS.some((option) => option.value === String(current))) {
    return INTERVAL_PRESETS;
  }
  const label =
    current >= 60 && current % 60 === 0 ? `Every ${current / 60} min` : `Every ${current} sec`;
  return [{ value: String(current), label }, ...INTERVAL_PRESETS];
}

function AutomationDetailView() {
  const { automationId } = Route.useParams();
  const navigate = useNavigate();
  const { settings } = useAppSettings();
  const desktopTopBarTrafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  const desktopTopBarWindowControlsGutterClassName =
    useDesktopTopBarWindowControlsGutterClassName();
  const projects = useStore((state) => state.projects);
  const threads = useStore(selectAllThreads);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<AutomationFormState | null>(null);
  const [dialogWarnings, setDialogWarnings] = useState<readonly AutomationDraftWarning[]>([]);
  const [acknowledgedWarningIds, setAcknowledgedWarningIds] = useState<
    ReadonlySet<AutomationDraftWarningId>
  >(() => new Set());

  const {
    data,
    updateMutation,
    deleteMutation,
    runNowMutation,
    cancelRunMutation,
    markRunReadMutation,
    archiveRunMutation,
    runsByAutomationId,
    // Running an automation keeps the user on this info page; the live run surfaces in
    // "Previous runs" (click a run there to open its thread), matching the reference UX.
  } = useAutomations();

  const definition = data.definitions.find((candidate) => candidate.id === automationId) ?? null;
  const runs = runsByAutomationId.get(automationId) ?? [];
  const memoryQuery = useQuery({
    queryKey: ["automation-memory", automationId],
    queryFn: () =>
      definition
        ? ensureNativeApi().automation.getMemory({ automationId: definition.id })
        : Promise.resolve(null),
    enabled: definition !== null,
  });
  const streamedMemory =
    (data.memories ?? []).find((candidate) => candidate.automationId === automationId) ?? null;
  const memory = streamedMemory ?? memoryQuery.data ?? null;
  const providerOptionsForDispatch = getProviderStartOptions(settings);

  if (!definition) {
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
              CHAT_SURFACE_HEADER_PADDING_X_CLASS,
              CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
              "drag-region",
              desktopTopBarTrafficLightGutterClassName,
              desktopTopBarWindowControlsGutterClassName,
            )}
          >
            <div
              className={cn("flex items-center gap-2 sm:gap-3", CHAT_SURFACE_HEADER_HEIGHT_CLASS)}
            >
              <SidebarHeaderNavigationControls />
              <h1 className="truncate font-heading text-sm font-medium">Automations</h1>
            </div>
          </header>
          <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            Automation not found.
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void navigate({ to: "/automations" })}
            >
              Back to automations
            </Button>
          </main>
        </div>
      </RouteInsetSurface>
    );
  }

  const project = projects.find((candidate) => candidate.id === definition.projectId);
  const continuationThreadId = automationContinuationThreadId(definition);
  const continuedThread = threads.find((candidate) => candidate.id === continuationThreadId);
  // Heartbeat inherits its thread's environment, so it never picks one. A dedicated
  // automation still picks freely until its first run claims a thread: after that every
  // run reuses that thread, so its project and checkout are fixed.
  const ownsItsEnvironment = !automationRequiresTargetThread(definition.mode);
  const canChooseEnvironment = ownsItsEnvironment && continuationThreadId === null;
  const sourceThread = definition.sourceThreadId
    ? threads.find((candidate) => candidate.id === definition.sourceThreadId)
    : null;
  const lastRun = lastFinishedRun(runs);
  const schedule = definition.schedule;
  const status = automationStatusDisplay(definition);
  const stopWhen = stopWhenFromCompletionPolicy(definition.completionPolicy ?? { type: "none" });
  const pendingProposal = definition.proposalState === "pending";

  const patch = (input: Omit<AutomationUpdateInput, "id">) =>
    updateMutation.mutate({ id: definition.id, ...input });

  // One-time risk approval surfaced at the top of the panel when an already-created
  // automation still needs it (e.g. created via the API). Persists on the automation.
  const approvalGaps = automationApprovalGaps({
    schedule: definition.schedule,
    enabled: definition.enabled,
    maxIterations: definition.maxIterations,
    mode: definition.mode,
    runtimeMode: definition.runtimeMode,
    worktreeMode: definition.worktreeMode,
    prompt: definition.prompt,
    acknowledgedRisks: definition.acknowledgedRisks,
  });
  const approveAutomationRisks = () =>
    // Records consent and any server-required fast-loop cap. Pause/resume stays separate so
    // approving never silently re-enables an automation the user deliberately paused.
    updateMutation.mutateAsync({
      id: definition.id,
      acknowledgedRisks: approvalGaps.acknowledgedRisks,
      ...(approvalGaps.maxIterations !== undefined
        ? { maxIterations: approvalGaps.maxIterations }
        : {}),
    });
  const handleApproveAndRunNow = async () => {
    try {
      await approveAutomationRisks();
    } catch {
      return; // update failed; the mutation already surfaced the error toast
    }
    runNowMutation.mutate(definition);
  };
  const approvalBusy = updateMutation.isPending || runNowMutation.isPending;

  // Applying a new model selection (model swap or a capability tweak) refreshes the saved
  // provider start options the same way the model picker does, then patches both at once.
  const applyModelSelection = (nextModelSelection: ModelSelection) => {
    const providerOptions = providerOptionsForAutomationModelSelection(
      definition,
      nextModelSelection,
      providerOptionsForDispatch,
    );
    patch({
      modelSelection: nextModelSelection,
      ...(providerOptions ? { providerOptions } : {}),
    });
  };

  const openEditDialog = (overrides: Partial<AutomationFormState> = {}) => {
    const nextForm = {
      ...formFromDefinition(definition, project?.id ?? projects[0]?.id ?? ""),
      ...overrides,
    };
    setForm(nextForm);
    setDialogWarnings(buildAutomationFormWarnings(nextForm));
    setAcknowledgedWarningIds(warningIdsForAcknowledgedRisks(definition.acknowledgedRisks));
    setDialogOpen(true);
  };

  const updateDialogForm = (nextForm: AutomationFormState) => {
    setForm(nextForm);
    setDialogWarnings(buildAutomationFormWarnings(nextForm));
  };

  const toggleWarning = (id: AutomationDraftWarningId, checked: boolean) => {
    setAcknowledgedWarningIds((current) =>
      updateAutomationDraftWarningAcknowledgement(current, id, checked),
    );
  };

  const submitForm = () => {
    if (!form || !isFormSubmittable(form)) return;
    if (hasBlockingAutomationDraftWarnings(dialogWarnings, acknowledgedWarningIds)) return;
    const acknowledgedRisks = acknowledgedRiskIdsForFormWarnings(
      dialogWarnings,
      acknowledgedWarningIds,
    );
    updateMutation.mutate(
      updateInputFromForm(
        definition,
        form,
        providerOptionsForAutomationEdit(definition, form, providerOptionsForDispatch),
        acknowledgedRisks,
      ),
      {
        onSuccess: () => setDialogOpen(false),
      },
    );
  };

  const togglePause = () => {
    updateMutation.mutate({ id: definition.id, enabled: !definition.enabled });
  };

  const deleteDefinition = async () => {
    const confirmed = await ensureNativeApi().dialogs.confirm(`Delete "${definition.name}"?`);
    if (!confirmed) return;
    deleteMutation.mutate(definition, {
      onSuccess: () => void navigate({ to: "/automations" }),
    });
  };

  return (
    <RouteInsetSurface>
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-row overflow-hidden",
          CHAT_BACKGROUND_CLASS_NAME,
        )}
      >
        {/* Left column: breadcrumb header + the prompt. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <header
            className={cn(
              CHAT_SURFACE_HEADER_PADDING_X_CLASS,
              CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
              "drag-region",
              desktopTopBarTrafficLightGutterClassName,
            )}
          >
            <div
              className={cn("flex items-center gap-2 sm:gap-3", CHAT_SURFACE_HEADER_HEIGHT_CLASS)}
            >
              <SidebarHeaderNavigationControls />
              <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm [-webkit-app-region:no-drag]">
                <button
                  type="button"
                  onClick={() => void navigate({ to: "/automations" })}
                  className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                >
                  Automations
                </button>
                <CentralIcon
                  name="chevron-right-small"
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
                <span className="truncate font-heading font-medium">{definition.name}</span>
              </div>
            </div>
          </header>

          <main className="min-h-0 flex-1 overflow-y-auto px-6 py-8 sm:px-8">
            <div className="max-w-3xl space-y-4">
              <h1 className="font-heading text-2xl font-normal text-foreground">
                {definition.name}
              </h1>
              <p className="whitespace-pre-wrap text-[0.9375rem] leading-relaxed text-muted-foreground">
                {definition.prompt}
              </p>
              {pendingProposal ? (
                <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-[var(--color-background-elevated-primary)] p-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">Suggested automation</p>
                    <p className="text-xs text-muted-foreground">
                      Accept it before it can run, or dismiss it to archive the suggestion.
                    </p>
                  </div>
                  <AutomationProposalActions
                    automationId={definition.id}
                    onResolved={(resolution) => {
                      if (resolution === "dismissed") {
                        void navigate({ to: "/automations" });
                      }
                    }}
                  />
                </div>
              ) : null}
            </div>
          </main>
        </div>

        {/* Right column: action header + details panel. The header carries the shared bottom
            hairline (horizontal), and the body below carries the vertical seam — so the vertical
            line starts at the header's bottom edge instead of running up through it. Both use the
            same --app-surface-divider token and meet cleanly at the corner. */}
        <div className="flex min-h-0 w-80 shrink-0 flex-col overflow-hidden">
          <header
            className={cn(
              CHAT_SURFACE_HEADER_PADDING_X_CLASS,
              CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
              "drag-region",
              desktopTopBarWindowControlsGutterClassName,
            )}
          >
            <div
              className={cn(
                "flex items-center justify-end gap-2 sm:gap-3",
                CHAT_SURFACE_HEADER_HEIGHT_CLASS,
              )}
            >
              <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
                {!pendingProposal && canPauseAutomation(definition) ? (
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={definition.enabled ? "Pause" : "Resume"}
                    title={definition.enabled ? "Pause" : "Resume"}
                    onClick={togglePause}
                  >
                    <CentralIcon name={definition.enabled ? "pause" : "play"} className="size-4" />
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Delete"
                  title="Delete"
                  onClick={() => void deleteDefinition()}
                >
                  <CentralIcon name="trash-can-simple" className="size-4" />
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="ml-1.5"
                  disabled={
                    runNowMutation.isPending ||
                    pendingProposal ||
                    // Stay disabled while an approval update is in flight: the cache merges
                    // acknowledgedRisks optimistically, so warnings clears before the server
                    // persists and a run dispatched in that window hits the old definition.
                    updateMutation.isPending ||
                    approvalGaps.runBlockingWarnings.length > 0
                  }
                  title={
                    pendingProposal
                      ? "Accept the automation proposal first"
                      : approvalGaps.runBlockingWarnings.length > 0
                        ? "Approve the automation first"
                        : undefined
                  }
                  onClick={() => runNowMutation.mutate(definition)}
                >
                  <CentralIcon name="play" className="size-4" />
                  Run now
                </Button>
              </div>
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto border-l border-[var(--app-surface-divider)]">
            <div className="flex flex-col gap-6 px-4 py-8">
              <AutomationApprovalBanner
                warnings={approvalGaps.warnings}
                busy={approvalBusy}
                // Swallow the rejection here; the mutation's onError already toasts. Without
                // this, void-ing the rejected promise would surface an unhandled rejection.
                onApprove={() => void approveAutomationRisks().catch(() => undefined)}
                onApproveAndRun={() => void handleApproveAndRunNow()}
              />
              <DetailGroup title="Status">
                <DetailRow label="Status">
                  <StatusValue>
                    <span className={cn("size-1.5 rounded-full", status.dotClassName)} />
                    {status.label}
                  </StatusValue>
                </DetailRow>
                <DetailRow label="Next run">
                  {definition.enabled && definition.nextRunAt ? (
                    <StatusValue tone="muted">
                      {formatRunTimestamp(definition.nextRunAt)}
                    </StatusValue>
                  ) : (
                    "—"
                  )}
                </DetailRow>
                <DetailRow label="Last ran">
                  {lastRun ? (
                    <StatusValue tone="muted">
                      {formatRunTimestamp(lastRun.finishedAt ?? lastRun.startedAt)}
                    </StatusValue>
                  ) : (
                    "—"
                  )}
                </DetailRow>
              </DetailGroup>

              <DetailGroup title="Details">
                {!ownsItsEnvironment ? (
                  <DetailRow label="Runs in">Thread</DetailRow>
                ) : !canChooseEnvironment ? (
                  <DetailRow label="Runs in">
                    {worktreeModeLabel(definition.worktreeMode)}
                  </DetailRow>
                ) : (
                  <EditRow
                    label={
                      <>
                        Runs in
                        <CentralIcon
                          name="info-simple"
                          className="size-3 text-muted-foreground/60"
                          aria-label="Where the automation runs: a worktree, a local checkout, or auto"
                        />
                      </>
                    }
                  >
                    <InlineSelect
                      value={definition.worktreeMode}
                      options={WORKTREE_OPTIONS}
                      onChange={(value) => {
                        if (
                          (value === "local" || value === "auto") &&
                          !definition.acknowledgedRisks.includes("local-checkout")
                        ) {
                          openEditDialog({ worktreeMode: value as AutomationWorktreeMode });
                          return;
                        }
                        patch({ worktreeMode: value as AutomationWorktreeMode });
                      }}
                    />
                  </EditRow>
                )}
                {!canChooseEnvironment ? (
                  <DetailRow label="Project">{project?.name ?? "Unknown project"}</DetailRow>
                ) : (
                  <EditRow label="Project">
                    <InlineSelect
                      value={definition.projectId}
                      options={projects.map((entry) => ({ value: entry.id, label: entry.name }))}
                      onChange={(value) =>
                        patch({ projectId: value as AutomationDefinition["projectId"] })
                      }
                    />
                  </EditRow>
                )}
                {definition.sourceThreadId ? (
                  <DetailRow label="Created from">
                    {sourceThread ? (
                      <button
                        type="button"
                        onClick={() =>
                          void navigate({
                            to: "/$threadId",
                            params: { threadId: sourceThread.id },
                          })
                        }
                        className="min-w-0 truncate text-right text-foreground transition-colors hover:text-primary"
                      >
                        {resolveThreadPickerTitle(sourceThread.title)}
                      </button>
                    ) : (
                      "Thread unavailable"
                    )}
                  </DetailRow>
                ) : null}
                <EditRow label="Repeats">
                  <InlineSelect
                    value={scheduleKindFromSchedule(schedule)}
                    options={SCHEDULE_KIND_OPTIONS}
                    onChange={(value) =>
                      patch({
                        schedule: scheduleFromKind(
                          value as (typeof SCHEDULE_KIND_OPTIONS)[number]["value"],
                          schedule,
                        ),
                      })
                    }
                  />
                </EditRow>
                {schedule.type === "interval" && schedule.everySeconds !== 3600 ? (
                  <EditRow label="Every">
                    <InlineSelect
                      value={String(schedule.everySeconds)}
                      options={intervalOptions(schedule.everySeconds)}
                      onChange={(value) =>
                        patch({
                          schedule: { type: "interval", everySeconds: Number.parseInt(value, 10) },
                        })
                      }
                    />
                  </EditRow>
                ) : null}
                {schedule.type === "once" ? (
                  <EditRow label="Run at">
                    <input
                      type="datetime-local"
                      value={datetimeLocalFromIso(schedule.runAt)}
                      onChange={(event) =>
                        event.target.value
                          ? patch({
                              schedule: {
                                type: "once",
                                runAt: isoFromDatetimeLocal(event.target.value),
                              },
                            })
                          : undefined
                      }
                      className={INLINE_CONTROL_CLASS}
                    />
                  </EditRow>
                ) : null}
                {schedule.type === "cron" ? (
                  <EditRow label="Cron">
                    <InlineCommitTextInput
                      value={schedule.expression}
                      onCommit={(value) =>
                        patch({
                          schedule: {
                            type: "cron",
                            expression: value,
                            timezone: schedule.timezone,
                          },
                        })
                      }
                      className="font-mono"
                    />
                  </EditRow>
                ) : null}
                {schedule.type === "daily" || schedule.type === "weekdays" ? (
                  <EditRow label="Time">
                    <InlineTime
                      value={schedule.timeOfDay}
                      onChange={(value) =>
                        value ? patch({ schedule: { ...schedule, timeOfDay: value } }) : undefined
                      }
                    />
                  </EditRow>
                ) : null}
                {schedule.type === "weekly" ? (
                  <>
                    <EditRow label="Day">
                      <InlineSelect
                        value={String(schedule.dayOfWeek)}
                        options={[0, 1, 2, 3, 4, 5, 6].map((day) => ({
                          value: String(day),
                          label: weekdayLabel(day),
                        }))}
                        onChange={(value) =>
                          patch({
                            schedule: updateWeeklyScheduleDay(schedule, Number.parseInt(value, 10)),
                          })
                        }
                      />
                    </EditRow>
                    <EditRow label="Time">
                      <InlineTime
                        value={schedule.timeOfDay}
                        onChange={(value) =>
                          value
                            ? patch({
                                schedule: updateWeeklyScheduleTime(schedule, value),
                              })
                            : undefined
                        }
                      />
                    </EditRow>
                  </>
                ) : null}
                {(schedule.type === "daily" ||
                  schedule.type === "weekdays" ||
                  schedule.type === "weekly" ||
                  schedule.type === "cron") &&
                schedule.timezone ? (
                  <EditRow label="Timezone">
                    <InlineCommitTextInput
                      value={schedule.timezone}
                      onCommit={(value) => patch({ schedule: { ...schedule, timezone: value } })}
                    />
                  </EditRow>
                ) : null}
                <EditRow label="Model">
                  <AutomationModelPicker
                    value={definition.modelSelection}
                    projectCwd={project?.cwd ?? null}
                    onChange={applyModelSelection}
                  />
                </EditRow>
                <ModelOptionRows
                  modelSelection={definition.modelSelection}
                  onChange={applyModelSelection}
                />
                <DetailRow label="Mode">{MODE_LABELS[definition.mode]}</DetailRow>
                <EditRow label="Notify">
                  <InlineSelect
                    value={definition.notificationPolicy ?? "all"}
                    options={[
                      { value: "all", label: "All runs" },
                      { value: "failed-runs-only", label: "Failed runs only" },
                    ]}
                    onChange={(value) =>
                      patch({
                        notificationPolicy:
                          value === "failed-runs-only" ? "failed-runs-only" : "all",
                      })
                    }
                  />
                </EditRow>
                <EditRow label="Stop when">
                  <InlineCommitTextInput
                    value={stopWhen}
                    placeholder="Never"
                    onCommit={(value) =>
                      patch({
                        completionPolicy: completionPolicyFromStopWhen(value),
                      })
                    }
                  />
                </EditRow>
                <EditRow label="Max iterations">
                  <InlineSelect
                    value={definition.maxIterations == null ? "" : String(definition.maxIterations)}
                    options={maxIterationOptions(definition.maxIterations)}
                    onChange={(value) =>
                      patch({ maxIterations: value === "" ? null : Number.parseInt(value, 10) })
                    }
                  />
                </EditRow>
                {continuationThreadId !== null ? (
                  <DetailRow label="Thread">
                    {continuedThread ? (
                      <button
                        type="button"
                        onClick={() =>
                          void navigate({
                            to: "/$threadId",
                            params: { threadId: continuedThread.id },
                          })
                        }
                        className="min-w-0 truncate text-right text-foreground transition-colors hover:text-primary"
                      >
                        {resolveThreadPickerTitle(continuedThread.title)}
                      </button>
                    ) : (
                      "Thread unavailable"
                    )}
                  </DetailRow>
                ) : null}
              </DetailGroup>

              <DetailGroup title="Memory">
                <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-foreground/[0.035] px-2.5 py-2 font-mono text-[0.6875rem] leading-relaxed text-muted-foreground">
                  {memory?.content || "No persistent memory yet."}
                </div>
              </DetailGroup>

              <DetailGroup title="Previous runs">
                {runs.length === 0 ? (
                  <div className="px-1.5 py-1 text-xs text-muted-foreground">No runs yet.</div>
                ) : (
                  <div className="flex flex-col gap-0.5">
                    {runs.map((run) => (
                      <RunRow
                        key={run.id}
                        run={run}
                        onOpen={(threadId) =>
                          void navigate({ to: "/$threadId", params: { threadId } })
                        }
                        onCancel={() => cancelRunMutation.mutate(run)}
                        onMarkRead={(unread) => markRunReadMutation.mutate({ run, unread })}
                        onArchive={(archived) => archiveRunMutation.mutate({ run, archived })}
                      />
                    ))}
                  </div>
                )}
              </DetailGroup>
            </div>
          </div>
        </div>
      </div>

      {form ? (
        <AutomationDialog
          open={dialogOpen}
          editing
          form={form}
          projects={projects}
          threads={threads}
          warnings={dialogWarnings}
          acknowledgedWarningIds={acknowledgedWarningIds}
          onToggleWarning={toggleWarning}
          onOpenChange={setDialogOpen}
          onFormChange={updateDialogForm}
          onSubmit={submitForm}
          busy={updateMutation.isPending}
        />
      ) : null}
    </RouteInsetSurface>
  );
}

function DetailGroup({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="space-y-0.5">
      <h2 className="px-1.5 pb-1 text-xs font-medium text-muted-foreground/70">{title}</h2>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

function DetailRow({
  label,
  children,
}: {
  readonly label: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md px-1.5 py-1.5 text-xs">
      <span className="flex shrink-0 items-center gap-1 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-foreground">{children}</span>
    </div>
  );
}

// Read-only Status group values (Active/Next run/Last ran). The reference renders these as
// plain right-aligned text — the status as foreground, timestamps muted — with no chip behind
// them, so the value column stays quiet and flush to the right.
function StatusValue({
  tone: toneProp,
  children,
}: {
  readonly tone?: "default" | "muted";
  readonly children: React.ReactNode;
}) {
  const tone = toneProp ?? "default";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5",
        tone === "muted" ? "text-muted-foreground" : "text-foreground",
      )}
    >
      {children}
    </span>
  );
}

function EditRow({
  label,
  children,
}: {
  readonly label: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md py-px pl-1.5 pr-0.5 text-xs transition-colors hover:bg-foreground/[0.04]">
      <span className="flex shrink-0 items-center gap-1 text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

const INLINE_CONTROL_CLASS =
  "cursor-pointer rounded-md bg-transparent px-2 py-1.5 text-right text-xs text-foreground outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring";

function InlineSelect({
  value,
  options,
  onChange,
}: {
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="relative flex min-w-0 items-center">
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(INLINE_CONTROL_CLASS, "max-w-[11rem] appearance-none truncate pr-5")}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <CentralIcon
        name="chevron-down-small"
        className="pointer-events-none absolute right-1 size-3 text-muted-foreground"
      />
    </div>
  );
}

function InlineToggle({
  value,
  onChange,
}: {
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={cn(INLINE_CONTROL_CLASS, "min-w-[3rem]")}
    >
      {value ? "On" : "Off"}
    </button>
  );
}

/**
 * Inline edit rows for the selected model's capabilities — reasoning effort, fast mode,
 * thinking, context window, etc. The knobs are derived from the provider's capability
 * descriptors, so each provider surfaces exactly the controls it supports (and none when it
 * supports nothing). Changing a value reuses the same model-selection patch path as the
 * model picker, keeping provider start options in sync.
 */
function ModelOptionRows({
  modelSelection,
  onChange,
}: {
  readonly modelSelection: ModelSelection;
  readonly onChange: (next: ModelSelection) => void;
}) {
  const { provider, model } = modelSelection;
  const caps = getModelCapabilities(provider, model);
  const descriptors = getProviderOptionDescriptors({
    provider,
    caps,
    selections: modelSelection.options as Record<string, unknown> | undefined,
  });
  if (descriptors.length === 0) {
    return null;
  }

  const setOption = (descriptor: ProviderOptionDescriptor, value: string | boolean) => {
    const optionPatch = buildProviderOptionPatch(provider, descriptor.id, value);
    const nextOptions = buildNextProviderOptions(
      provider,
      modelSelection.options as ProviderOptions | undefined,
      optionPatch,
    );
    onChange(
      buildModelSelectionForTarget({
        target: {
          provider,
          profileId: modelSelection.profileId,
        },
        model,
        options: nextOptions,
        supportsAutoMode:
          modelSelection.provider === "claudeAgent"
            ? modelSelection.supportsAutoMode
            : undefined,
      }),
    );
  };

  return (
    <>
      {descriptors.map((descriptor) => {
        if (descriptor.type === "boolean") {
          return (
            <EditRow key={descriptor.id} label={descriptor.label}>
              <InlineToggle
                value={getProviderOptionCurrentValue(descriptor) === true}
                onChange={(checked) => setOption(descriptor, checked)}
              />
            </EditRow>
          );
        }
        const current = getProviderOptionCurrentValue(descriptor);
        return (
          <EditRow key={descriptor.id} label={descriptor.label}>
            <InlineSelect
              value={typeof current === "string" ? current : ""}
              options={descriptor.options.map((option) => ({
                value: option.id,
                label: option.label,
              }))}
              onChange={(value) => setOption(descriptor, value)}
            />
          </EditRow>
        );
      })}
    </>
  );
}

function InlineTime({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <input
      type="time"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={INLINE_CONTROL_CLASS}
    />
  );
}

// Keeps free-text schedule fields editable while intermediate cron/timezone text is invalid.
function InlineCommitTextInput({
  value,
  onCommit,
  className,
  placeholder,
}: {
  readonly value: string;
  readonly onCommit: (value: string) => void;
  readonly className?: string;
  readonly placeholder?: string;
}) {
  // Draft keyed to the value it was seeded from: an external change derives
  // straight back to the fresh value with no state-syncing effect.
  const [draftState, setDraftState] = useState<{ base: string; value: string } | null>(null);
  const draft = draftState !== null && draftState.base === value ? draftState.value : value;
  const setDraft = (next: string) => setDraftState({ base: value, value: next });

  const commitDraft = () => {
    if (draft !== value) {
      onCommit(draft);
    }
  };

  return (
    <input
      value={draft}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commitDraft}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
      className={cn(INLINE_CONTROL_CLASS, className)}
    />
  );
}

function RunRow({
  run,
  onOpen,
  onCancel,
  onMarkRead,
  onArchive,
}: {
  readonly run: AutomationRun;
  readonly onOpen: (threadId: NonNullable<AutomationRun["threadId"]>) => void;
  readonly onCancel: () => void;
  readonly onMarkRead: (unread: boolean) => void;
  readonly onArchive: (archived: boolean) => void;
}) {
  const active = canCancelAutomationRun(run);
  const archived = run.result?.archivedAt !== null && run.result?.archivedAt !== undefined;
  const triageActionable = run.result !== null || isTriageRun(run);
  const unread = run.result ? run.result.unread : triageActionable;
  const openable = run.threadId != null;
  const open = () => {
    if (run.threadId) {
      onOpen(run.threadId as NonNullable<AutomationRun["threadId"]>);
    }
  };
  const resultTitle = runResultTitle(run);
  return (
    // The whole row opens its thread (the run's chat history); inline actions stop
    // propagation so they don't also navigate.
    <div
      role={openable ? "button" : undefined}
      tabIndex={openable ? 0 : undefined}
      onClick={openable ? open : undefined}
      onKeyDown={
        openable
          ? (event) => {
              if (isRowInteractiveEventTarget(event.target, event.currentTarget)) {
                return;
              }
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                open();
              }
            }
          : undefined
      }
      className={cn(
        "group flex items-center gap-2 rounded-md px-1.5 py-1.5 text-xs transition-colors",
        openable ? "cursor-pointer hover:bg-foreground/[0.03]" : undefined,
      )}
    >
      <RunStatusIndicator status={run.status} />
      <div className="min-w-0 flex-1 truncate">
        <span className="text-foreground/90">{runStatusLabel(run.status)}</span>
        {resultTitle ? <span className="text-foreground/90"> · {resultTitle}</span> : null}
        <span className="text-muted-foreground"> · {runResultSummary(run)}</span>
      </div>
      {triageActionable ? (
        <div className="flex shrink-0 items-center gap-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onMarkRead(!unread);
            }}
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            {unread ? "Read" : "Unread"}
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onArchive(!archived);
            }}
            title={
              run.permissionSnapshot.worktreeMode === "local"
                ? undefined
                : "Archiving does not remove generated worktrees or branches."
            }
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            {archived ? "Unarchive" : "Archive"}
          </button>
        </div>
      ) : null}
      {active ? (
        <Button
          type="button"
          size="icon-chip"
          variant="ghost"
          aria-label="Cancel run"
          onClick={(event) => {
            event.stopPropagation();
            onCancel();
          }}
        >
          <CentralIcon name="stop" className="size-3.5" />
        </Button>
      ) : null}
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {formatRelativeTime(run.finishedAt ?? run.startedAt ?? run.scheduledFor)}
      </span>
    </div>
  );
}

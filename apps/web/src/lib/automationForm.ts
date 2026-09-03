// FILE: automationForm.ts
// Purpose: Owns automation form state, schedule conversion, and API payload helpers.
// Layer: Web lib (pure form/domain helpers)
// Exports: form builders, schedule formatters, warning adapters, and payload mappers.

import {
  AUTOMATION_NAME_MAX_LENGTH,
  AUTOMATION_PROMPT_MAX_LENGTH,
  DEFAULT_AUTOMATION_FAST_INTERVAL_MAX_ITERATIONS,
  DEFAULT_AUTOMATION_MINIMUM_INTERVAL_SECONDS,
} from "@synara/contracts";
import type {
  AutomationCreateInput,
  AutomationDefinition,
  AutomationMode,
  AutomationNotificationPolicy,
  AutomationSchedule,
  AutomationWorktreeMode,
  ModelSelection,
  ProjectId,
  ProviderStartOptions,
  RuntimeMode,
  ThreadId,
} from "@synara/contracts";

import {
  completionPolicyFromStopWhen,
  stopWhenFromCompletionPolicy,
} from "@synara/shared/automationCompletionPolicy";
import {
  automationContinuationThreadId,
  automationRequiresTargetThread,
} from "@synara/shared/automationMode";
import {
  acknowledgedRiskIdsForDraft,
  buildAutomationDraftWarnings,
  type AutomationDraftWarning,
  type AutomationDraftWarningId,
} from "./automationDraft";
import {
  DEFAULT_AUTOMATION_FAILURE_POLICY_VALUE,
  automationFailurePolicyValue,
  stopAfterConsecutiveFailuresFromPolicyValue,
  type AutomationFailurePolicyValue,
} from "./automationFailurePolicy";

export const defaultModelSelection: ModelSelection = {
  provider: "codex",
  model: "gpt-5-codex",
};

export const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const LEGACY_WALL_CLOCK_TIMEZONE = "UTC";

// --- Schedule form shape ----------------------------------------------------

/** UI-level cadence options shown in the schedule picker (each maps onto an AutomationSchedule). */
export type ScheduleKind =
  | "manual"
  | "once"
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  | "custom"
  | "cron";

export type IntervalUnit = "seconds" | "minutes";

export const SCHEDULE_KIND_OPTIONS: readonly { value: ScheduleKind; label: string }[] = [
  { value: "manual", label: "Manual" },
  { value: "once", label: "Once" },
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
  { value: "custom", label: "Custom" },
  { value: "cron", label: "Cron" },
];

export type AutomationFormState = {
  readonly name: string;
  readonly projectId: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly scheduleKind: ScheduleKind;
  readonly intervalAmount: string;
  readonly intervalUnit: IntervalUnit;
  readonly timeOfDay: string;
  readonly dayOfWeek: string;
  readonly onceRunAt: string;
  readonly cronExpression: string;
  readonly timezone: string;
  readonly runtimeMode: RuntimeMode;
  readonly worktreeMode: AutomationWorktreeMode;
  readonly modelSelection: ModelSelection;
  readonly mode: AutomationMode;
  readonly notificationPolicy: AutomationNotificationPolicy;
  readonly targetThreadId: string;
  readonly maxIterations: string;
  readonly stopAfterFailures: AutomationFailurePolicyValue;
  readonly stopWhen: string;
};

export type AutomationProjectModelSelectionSource = {
  readonly id: string;
  readonly defaultModelSelection?: ModelSelection | null;
};

function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function scheduleTimezone(schedule: AutomationSchedule, fallbackTimezone: string): string {
  return (
    (schedule.type === "daily" ||
    schedule.type === "weekly" ||
    schedule.type === "weekdays" ||
    schedule.type === "cron"
      ? schedule.timezone
      : undefined) ?? fallbackTimezone
  );
}

// --- Schedule conversion and labels ----------------------------------------

/** Pick the schedule option that represents a stored schedule (interval 1h reads as "Hourly"). */
export function scheduleKindFromSchedule(schedule: AutomationSchedule): ScheduleKind {
  switch (schedule.type) {
    case "daily":
      return "daily";
    case "weekdays":
      return "weekdays";
    case "weekly":
      return "weekly";
    case "interval":
      return schedule.everySeconds === 3600 ? "hourly" : "custom";
    case "manual":
      return "manual";
    case "once":
      return "once";
    case "cron":
      return "cron";
  }
}

/** Build a schedule for the chosen kind, reusing time/day/interval from `current` where it applies. */
export function scheduleFromKind(
  kind: ScheduleKind,
  current: AutomationSchedule,
  fallbackTimezone: string = localTimezone(),
): AutomationSchedule {
  const timeOfDay =
    current.type === "daily" || current.type === "weekly" || current.type === "weekdays"
      ? current.timeOfDay
      : "09:00";
  const timezone = scheduleTimezone(current, fallbackTimezone);
  switch (kind) {
    case "manual":
      return { type: "manual" };
    case "once":
      return { type: "once", runAt: new Date(Date.now() + 15 * 60_000).toISOString() };
    case "hourly":
      return { type: "interval", everySeconds: 3600 };
    case "custom":
      return {
        type: "interval",
        everySeconds:
          current.type === "interval" && current.everySeconds !== 3600
            ? current.everySeconds
            : 1800,
      };
    case "daily":
      return { type: "daily", timeOfDay, timezone };
    case "weekdays":
      return { type: "weekdays", timeOfDay, timezone };
    case "weekly":
      return {
        type: "weekly",
        dayOfWeek: current.type === "weekly" ? current.dayOfWeek : 1,
        timeOfDay,
        timezone,
      };
    case "cron":
      return {
        type: "cron",
        expression: current.type === "cron" ? current.expression : "0 9 * * *",
        timezone,
      };
  }
}

export function datetimeLocalFromIso(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offsetMs = date.getTimezoneOffset() * 60_000;
  const localIso = new Date(date.getTime() - offsetMs).toISOString();
  return localIso.slice(0, date.getSeconds() === 0 && date.getMilliseconds() === 0 ? 16 : 19);
}

export function isoFromDatetimeLocal(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? new Date(Date.now() + 15 * 60_000).toISOString()
    : date.toISOString();
}

export function updateWeeklyScheduleDay(
  schedule: Extract<AutomationSchedule, { type: "weekly" }>,
  dayOfWeek: number,
): AutomationSchedule {
  return { ...schedule, dayOfWeek };
}

export function updateWeeklyScheduleTime(
  schedule: Extract<AutomationSchedule, { type: "weekly" }>,
  timeOfDay: string,
): AutomationSchedule {
  return { ...schedule, timeOfDay };
}

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function formatDateTime(value: string | null): string {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return DATE_TIME_FORMATTER.format(date);
}

function timezoneSuffix(schedule: AutomationSchedule): string {
  if (
    (schedule.type === "daily" ||
      schedule.type === "weekdays" ||
      schedule.type === "weekly" ||
      schedule.type === "cron") &&
    schedule.timezone
  ) {
    return ` ${schedule.timezone}`;
  }
  return " UTC";
}

function formatIntervalSchedule(seconds: number): string {
  return seconds % 60 === 0 ? `Every ${seconds / 60} min` : `Every ${seconds} sec`;
}

function formatIntervalCadence(seconds: number): string {
  if (seconds === 3600) return "Hourly";
  if (seconds % 3600 === 0) return `Every ${seconds / 3600}h`;
  if (seconds % 60 === 0) return `Every ${seconds / 60}m`;
  return `Every ${seconds}s`;
}

export function formatSchedule(schedule: AutomationSchedule): string {
  switch (schedule.type) {
    case "manual":
      return "Manual";
    case "once":
      return `Once ${formatDateTime(schedule.runAt)}`;
    case "interval":
      return formatIntervalSchedule(schedule.everySeconds);
    case "daily":
      return `Daily ${schedule.timeOfDay}${timezoneSuffix(schedule)}`;
    case "weekdays":
      return `Weekdays ${schedule.timeOfDay}${timezoneSuffix(schedule)}`;
    case "weekly":
      return `Weekly ${weekdayLabel(schedule.dayOfWeek)} ${schedule.timeOfDay}${timezoneSuffix(schedule)}`;
    case "cron":
      return `Cron ${schedule.expression} ${schedule.timezone}`;
  }
}

/** "09:00" -> "9:00": drops the leading zero on the hour for friendlier cadence labels. */
export function formatClockTime(timeOfDay: string): string {
  const [hours, minutes] = timeOfDay.split(":");
  const hour = Number.parseInt(hours ?? "", 10);
  if (Number.isNaN(hour)) return timeOfDay;
  return `${hour}:${minutes ?? "00"}`;
}

export function formatCadence(schedule: AutomationSchedule): string {
  switch (schedule.type) {
    case "manual":
      return "Manual";
    case "once":
      return formatDateTime(schedule.runAt);
    case "interval":
      return formatIntervalCadence(schedule.everySeconds);
    case "daily":
      return `Daily at ${formatClockTime(schedule.timeOfDay)}`;
    case "weekdays":
      return `Weekdays at ${formatClockTime(schedule.timeOfDay)}`;
    case "weekly":
      return `${weekdayLabel(schedule.dayOfWeek)} at ${formatClockTime(schedule.timeOfDay)}`;
    case "cron":
      return `Cron ${schedule.expression}`;
  }
}

function formatIntervalCadenceLong(seconds: number): string {
  if (seconds === 3600) return "Hourly";
  if (seconds % 3600 === 0) return `Every ${seconds / 3600} hours`;
  if (seconds === 60) return "Every minute";
  if (seconds % 60 === 0) return `Every ${seconds / 60} minutes`;
  return seconds === 1 ? "Every second" : `Every ${seconds} seconds`;
}

/** Like {@link formatCadence} but with interval units spelled out ("Every 5 minutes"). */
export function formatCadenceLong(schedule: AutomationSchedule): string {
  return schedule.type === "interval"
    ? formatIntervalCadenceLong(schedule.everySeconds)
    : formatCadence(schedule);
}

/**
 * Countdown phrase for an upcoming run: "now", "in 5 minutes", "in 9 hours", "in 3 days".
 * A past-due `nextRunAt` (scheduler catching up) also reads "now". Null when unscheduled
 * or unparseable so callers can drop the segment entirely.
 */
export function formatNextRun(nextRunAt: string | null, now: number = Date.now()): string | null {
  if (!nextRunAt) return null;
  const time = new Date(nextRunAt).getTime();
  if (Number.isNaN(time)) return null;
  const seconds = Math.round((time - now) / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "in 1 minute" : `in ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "in 1 hour" : `in ${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? "in 1 day" : `in ${days} days`;
}

export function weekdayLabel(value: number): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][value] ?? "Sun";
}

// --- Thread automation lookups ---------------------------------------------
// Automations that continue a thread are the only kind bound to one; both the
// Environment panel and the sidebar surface them keyed by that thread, whether the
// user chose it (heartbeat) or the automation created it for itself (dedicated).

const byAutomationName = (left: AutomationDefinition, right: AutomationDefinition): number =>
  left.name.localeCompare(right.name);

/** Automations continuing a single thread, sorted by name. */
export function automationsForThread(
  definitions: readonly AutomationDefinition[],
  threadId: ThreadId,
): AutomationDefinition[] {
  return definitions
    .filter((definition) => automationContinuationThreadId(definition) === threadId)
    .toSorted(byAutomationName);
}

/** All thread-bound automations grouped by the thread they continue (each list sorted by name). */
export function groupAutomationsByContinuedThread(
  definitions: readonly AutomationDefinition[],
): Map<ThreadId, AutomationDefinition[]> {
  const byThreadId = new Map<ThreadId, AutomationDefinition[]>();
  for (const definition of definitions) {
    const continuationThreadId = automationContinuationThreadId(definition);
    if (!continuationThreadId) {
      continue;
    }
    const existing = byThreadId.get(continuationThreadId);
    if (existing) {
      existing.push(definition);
    } else {
      byThreadId.set(continuationThreadId, [definition]);
    }
  }
  for (const [threadId, automations] of byThreadId) {
    byThreadId.set(threadId, automations.toSorted(byAutomationName));
  }
  return byThreadId;
}

// --- Interval presets --------------------------------------------------------
// Single preset list for every interval picker (creation dialog and detail page)
// so cadence options and labels never diverge between surfaces.

export const AUTOMATION_INTERVAL_PRESET_SECONDS: readonly number[] = [
  900, 1800, 3600, 7200, 21600, 43200, 86400,
];

export function formatIntervalPresetLabel(seconds: number): string {
  if (seconds === 3600) return "Every hour";
  if (seconds % 3600 === 0) return `Every ${seconds / 3600} hours`;
  if (seconds >= 60 && seconds % 60 === 0) return `Every ${seconds / 60} min`;
  return `Every ${seconds} sec`;
}

/**
 * Options for an interval cadence picker. A stored non-preset interval is prepended so the
 * current value always renders as itself. The dialog omits the hourly preset because
 * "Hourly" is its own ScheduleKind there; the detail page includes it.
 */
export function automationIntervalPresetOptions({
  currentSeconds,
  includeHourly,
}: {
  readonly currentSeconds?: number | undefined;
  readonly includeHourly: boolean;
}): readonly { readonly value: string; readonly label: string }[] {
  const presetSeconds = includeHourly
    ? AUTOMATION_INTERVAL_PRESET_SECONDS
    : AUTOMATION_INTERVAL_PRESET_SECONDS.filter((seconds) => seconds !== 3600);
  const presets = presetSeconds.map((seconds) => ({
    value: String(seconds),
    label: formatIntervalPresetLabel(seconds),
  }));
  if (currentSeconds === undefined || presetSeconds.includes(currentSeconds)) {
    return presets;
  }
  return [
    { value: String(currentSeconds), label: formatIntervalPresetLabel(currentSeconds) },
    ...presets,
  ];
}

// --- Form state and API payloads -------------------------------------------

export function intervalFormPartsFromSeconds(everySeconds: number): {
  readonly amount: string;
  readonly unit: IntervalUnit;
} {
  return everySeconds >= 60 && everySeconds % 60 === 0
    ? { amount: String(everySeconds / 60), unit: "minutes" }
    : { amount: String(everySeconds), unit: "seconds" };
}

export function formFromDefinition(
  definition: AutomationDefinition | null,
  fallbackProjectId: string,
  fallbackModelSelection: ModelSelection = defaultModelSelection,
): AutomationFormState {
  // New automations default to a daily schedule; existing definitions keep their saved cadence.
  const schedule = definition?.schedule ?? { type: "daily" as const, timeOfDay: "09:00" };
  const timezone = scheduleTimezone(
    schedule,
    definition ? LEGACY_WALL_CLOCK_TIMEZONE : localTimezone(),
  );
  return {
    name: definition?.name ?? "",
    projectId: definition?.projectId ?? fallbackProjectId,
    prompt: definition?.prompt ?? "",
    enabled: definition?.enabled ?? true,
    scheduleKind: scheduleKindFromSchedule(schedule),
    intervalAmount:
      schedule.type === "interval" && schedule.everySeconds !== 3600
        ? intervalFormPartsFromSeconds(schedule.everySeconds).amount
        : "30",
    intervalUnit:
      schedule.type === "interval" && schedule.everySeconds !== 3600
        ? intervalFormPartsFromSeconds(schedule.everySeconds).unit
        : "minutes",
    timeOfDay:
      schedule.type === "daily" || schedule.type === "weekly" || schedule.type === "weekdays"
        ? schedule.timeOfDay
        : "09:00",
    dayOfWeek: schedule.type === "weekly" ? String(schedule.dayOfWeek) : "1",
    onceRunAt:
      schedule.type === "once"
        ? datetimeLocalFromIso(schedule.runAt)
        : datetimeLocalFromIso(new Date(Date.now() + 15 * 60_000).toISOString()),
    cronExpression: schedule.type === "cron" ? schedule.expression : "0 9 * * *",
    timezone,
    runtimeMode: definition?.runtimeMode ?? "approval-required",
    worktreeMode: definition?.worktreeMode ?? "auto",
    modelSelection: definition?.modelSelection ?? fallbackModelSelection,
    mode: definition?.mode ?? "standalone",
    notificationPolicy: definition?.notificationPolicy ?? "all",
    targetThreadId: definition?.targetThreadId ?? "",
    maxIterations: definition?.maxIterations != null ? String(definition.maxIterations) : "",
    stopAfterFailures: definition
      ? automationFailurePolicyValue(definition.stopAfterConsecutiveFailures)
      : DEFAULT_AUTOMATION_FAILURE_POLICY_VALUE,
    stopWhen: definition
      ? stopWhenFromCompletionPolicy(definition.completionPolicy ?? { type: "none" })
      : "",
  };
}

export function applyScheduleToForm(
  form: AutomationFormState,
  schedule: AutomationSchedule,
  fallbackTimezone: string = localTimezone(),
): AutomationFormState {
  const timezone = scheduleTimezone(schedule, fallbackTimezone);
  return {
    ...form,
    scheduleKind: scheduleKindFromSchedule(schedule),
    intervalAmount:
      schedule.type === "interval" && schedule.everySeconds !== 3600
        ? intervalFormPartsFromSeconds(schedule.everySeconds).amount
        : form.intervalAmount,
    intervalUnit:
      schedule.type === "interval" && schedule.everySeconds !== 3600
        ? intervalFormPartsFromSeconds(schedule.everySeconds).unit
        : form.intervalUnit,
    timeOfDay:
      schedule.type === "daily" || schedule.type === "weekly" || schedule.type === "weekdays"
        ? schedule.timeOfDay
        : form.timeOfDay,
    dayOfWeek: schedule.type === "weekly" ? String(schedule.dayOfWeek) : form.dayOfWeek,
    onceRunAt: schedule.type === "once" ? datetimeLocalFromIso(schedule.runAt) : form.onceRunAt,
    cronExpression: schedule.type === "cron" ? schedule.expression : form.cronExpression,
    timezone,
  };
}

export function scheduleFromForm(form: AutomationFormState): AutomationSchedule {
  const timezone = form.timezone.trim();
  switch (form.scheduleKind) {
    case "hourly":
      return { type: "interval", everySeconds: 3600 };
    case "manual":
      return { type: "manual" };
    case "once":
      return { type: "once", runAt: isoFromDatetimeLocal(form.onceRunAt) };
    case "custom": {
      const amount = Math.max(1, Number.parseInt(form.intervalAmount, 10) || 1);
      return {
        type: "interval",
        everySeconds: form.intervalUnit === "seconds" ? amount : amount * 60,
      };
    }
    case "daily":
      return { type: "daily", timeOfDay: form.timeOfDay, timezone };
    case "weekdays":
      return { type: "weekdays", timeOfDay: form.timeOfDay, timezone };
    case "weekly": {
      const dayOfWeek = Math.min(6, Math.max(0, Number.parseInt(form.dayOfWeek, 10) || 0));
      return { type: "weekly", dayOfWeek, timeOfDay: form.timeOfDay, timezone };
    }
    case "cron":
      return {
        type: "cron",
        expression: form.cronExpression.trim() || "0 9 * * *",
        timezone,
      };
  }
}

function maxIterationsFromForm(form: Pick<AutomationFormState, "maxIterations">): number | null {
  const trimmed = form.maxIterations.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return parsed > 0 ? parsed : null;
}

export function automationFastIntervalLimitMessage(form: AutomationFormState): string | null {
  const schedule = scheduleFromForm(form);
  const maxIterations = maxIterationsFromForm(form);
  if (
    schedule.type === "interval" &&
    schedule.everySeconds < DEFAULT_AUTOMATION_MINIMUM_INTERVAL_SECONDS &&
    (maxIterations === null || maxIterations > DEFAULT_AUTOMATION_FAST_INTERVAL_MAX_ITERATIONS)
  ) {
    return `Intervals under one minute need max iterations set to ${DEFAULT_AUTOMATION_FAST_INTERVAL_MAX_ITERATIONS} runs or fewer.`;
  }
  return null;
}

export function projectModelSelection(
  projects: readonly AutomationProjectModelSelectionSource[],
  projectId: string,
): ModelSelection {
  return (
    projects.find((project) => project.id === projectId)?.defaultModelSelection ??
    defaultModelSelection
  );
}

function modelSelectionsMatch(left: ModelSelection, right: ModelSelection): boolean {
  const leftOptions = "options" in left ? left.options : undefined;
  const rightOptions = "options" in right ? right.options : undefined;
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    JSON.stringify(leftOptions ?? null) === JSON.stringify(rightOptions ?? null)
  );
}

function modelIdentityMatches(left: ModelSelection, right: ModelSelection): boolean {
  return left.provider === right.provider && left.model === right.model;
}

// Automation edits keep saved provider start options unless the provider/model identity changes.
export function providerOptionsForAutomationModelSelection(
  definition: Pick<AutomationDefinition, "modelSelection" | "providerOptions">,
  nextModelSelection: ModelSelection,
  currentProviderOptions?: ProviderStartOptions,
): ProviderStartOptions | undefined {
  return modelIdentityMatches(definition.modelSelection, nextModelSelection)
    ? definition.providerOptions
    : (currentProviderOptions ?? {});
}

export function modelSelectionForProjectChange(
  projects: readonly AutomationProjectModelSelectionSource[],
  currentProjectId: string,
  nextProjectId: string,
  currentModelSelection: ModelSelection,
): ModelSelection {
  const currentDefaultModelSelection = projectModelSelection(projects, currentProjectId);
  const nextDefaultModelSelection = projectModelSelection(projects, nextProjectId);
  return modelSelectionsMatch(currentModelSelection, currentDefaultModelSelection)
    ? nextDefaultModelSelection
    : currentModelSelection;
}

export function createInputFromForm(
  form: AutomationFormState,
  providerOptions?: ProviderStartOptions,
  acknowledgedRisks?: AutomationCreateInput["acknowledgedRisks"],
  sourceThreadId?: ThreadId | null,
): AutomationCreateInput {
  const maxIterations = maxIterationsFromForm(form);
  const stopWhen = form.stopWhen.trim();
  return {
    name: form.name.trim(),
    projectId: form.projectId as ProjectId,
    ...(sourceThreadId !== undefined ? { sourceThreadId } : {}),
    prompt: form.prompt.trim(),
    schedule: scheduleFromForm(form),
    enabled: form.enabled,
    modelSelection: form.modelSelection,
    runtimeMode: form.runtimeMode,
    interactionMode: "default",
    worktreeMode: form.worktreeMode,
    ...(providerOptions ? { providerOptions } : {}),
    mode: form.mode,
    notificationPolicy: form.notificationPolicy,
    // Only heartbeat carries a thread the user picked; a dedicated automation is given
    // its own thread by the server after its first run.
    targetThreadId: automationRequiresTargetThread(form.mode)
      ? (form.targetThreadId as ThreadId)
      : null,
    maxIterations,
    stopAfterConsecutiveFailures: stopAfterConsecutiveFailuresFromPolicyValue(
      form.stopAfterFailures,
    ),
    completionPolicy: completionPolicyFromStopWhen(stopWhen),
    ...(acknowledgedRisks ? { acknowledgedRisks } : {}),
  };
}

export function buildAutomationFormWarnings(form: AutomationFormState) {
  return buildAutomationDraftWarnings({
    schedule: scheduleFromForm(form),
    mode: form.mode,
    runtimeMode: form.runtimeMode,
    worktreeMode: form.worktreeMode,
    hasEphemeralContext: false,
    generatedConfidence: null,
    generatedNeedsConfirmation: false,
    prompt: form.prompt,
  });
}

export function acknowledgedRiskIdsForFormWarnings(
  warnings: readonly AutomationDraftWarning[],
  acknowledgedWarningIds: ReadonlySet<AutomationDraftWarningId>,
) {
  return acknowledgedRiskIdsForDraft(warnings, acknowledgedWarningIds);
}

// --- Validation ---------------------------------------------------------------

/** Error for an automation name draft, or null when saveable. */
export function automationNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Add a name";
  if (trimmed.length > AUTOMATION_NAME_MAX_LENGTH) {
    return `Name must be ${AUTOMATION_NAME_MAX_LENGTH} characters or fewer`;
  }
  return null;
}

// One token per cron field: digits, `*`, lists, ranges, steps. Deliberately structural —
// range semantics (minute 0-59, month 1-12, …) stay with the server's parser, so this can't
// drift from it; it only stops obviously incomplete input from becoming a doomed request.
const CRON_FIELD_PATTERN = /^[\d*,/-]+$/;

/** Error for a cron expression draft, or null when it is worth sending to the server. */
export function automationCronExpressionError(expression: string): string | null {
  const fields = expression.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5 || !fields.every((field) => CRON_FIELD_PATTERN.test(field))) {
    return "Use a 5-field cron expression (minute hour day month weekday)";
  }
  return null;
}

/** Error for a schedule timezone draft, or null when it names a real IANA timezone. */
export function automationTimezoneError(timezone: string): string | null {
  const trimmed = timezone.trim();
  if (!trimmed) return "Add a timezone";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
  } catch {
    return "Unknown timezone";
  }
  return null;
}

/** Error for an automation prompt draft, or null when saveable. */
export function automationPromptError(prompt: string): string | null {
  const trimmed = prompt.trim();
  if (!trimmed) return "Add a prompt";
  if (trimmed.length > AUTOMATION_PROMPT_MAX_LENGTH) {
    return `Prompt must be ${AUTOMATION_PROMPT_MAX_LENGTH.toLocaleString("en-US")} characters or fewer`;
  }
  return null;
}

/**
 * Why the form can't be submitted right now, as user-facing copy — or null when
 * submittable. Rendered beside the dialog's Save button so a disabled Save is never
 * a silent dead end.
 */
export function automationFormSubmitBlockReason(
  form: AutomationFormState,
  warnings: readonly AutomationDraftWarning[],
  acknowledgedWarningIds: ReadonlySet<AutomationDraftWarningId>,
): string | null {
  const nameError = automationNameError(form.name);
  if (nameError) return nameError;
  const promptError = automationPromptError(form.prompt);
  if (promptError) return promptError;
  if (!form.projectId) return "Pick a project";
  if (automationRequiresTargetThread(form.mode) && !form.targetThreadId) {
    return "Pick a target thread";
  }
  const fastIntervalMessage = automationFastIntervalLimitMessage(form);
  if (fastIntervalMessage) return fastIntervalMessage;
  if (
    form.scheduleKind === "custom" &&
    (!form.intervalAmount.trim() || Number.parseInt(form.intervalAmount, 10) <= 0)
  ) {
    return "Set a valid interval";
  }
  if (form.scheduleKind === "cron" && !form.cronExpression.trim()) return "Add a cron expression";
  if (form.scheduleKind === "once" && !form.onceRunAt.trim()) return "Pick a run time";
  if (
    (form.scheduleKind === "daily" ||
      form.scheduleKind === "weekdays" ||
      form.scheduleKind === "cron" ||
      form.scheduleKind === "weekly") &&
    !form.timezone.trim()
  ) {
    return "Add a timezone";
  }
  if (
    (form.scheduleKind === "daily" ||
      form.scheduleKind === "weekdays" ||
      form.scheduleKind === "weekly") &&
    !TIME_OF_DAY_PATTERN.test(form.timeOfDay)
  ) {
    return "Set a valid time";
  }
  if (
    warnings.some(
      (warning) => warning.requiresAcknowledgement && !acknowledgedWarningIds.has(warning.id),
    )
  ) {
    return "Acknowledge the flagged risks first";
  }
  return null;
}

export function isFormSubmittable(form: AutomationFormState): boolean {
  return automationFormSubmitBlockReason(form, [], new Set()) === null;
}

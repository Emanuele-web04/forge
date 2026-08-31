import {
  type AutomationCreateInput,
  type AutomationDefinition,
  type AutomationId,
  type AutomationListResult,
  type AutomationMemory,
  type AutomationMode,
  type AutomationNotificationPolicy,
  type AutomationRun,
  type AutomationRunResult,
  type AutomationStreamEvent,
  type AutomationUpdateInput,
  type AutomationWorktreeMode,
  type ModelSelection,
  type ProviderKind,
  type RuntimeMode,
  type ThreadId,
} from "@synara/contracts";
import { automationRequiresTargetThread } from "@synara/shared/automationMode";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import { useAppSettings } from "~/appSettings";
import type { Thread } from "~/types";
import {
  ComposerPickerMenuPopup,
  ComposerPickerMenuSubPopup,
} from "~/components/chat/ComposerPickerMenuPopup";
import { ProviderModelPicker } from "~/components/chat/ProviderModelPicker";
import { RUNTIME_AUTO_ICON_ACCENT_CLASS_NAME } from "~/components/chat/composerPickerStyles";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Dialog, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { TimePicker } from "~/components/ui/time-picker";
import { toastManager } from "~/components/ui/toast";
import type { AutomationDraftWarning, AutomationDraftWarningId } from "~/lib/automationDraft";
import {
  acknowledgedRiskIdsForFormWarnings,
  applyScheduleToForm,
  automationFastIntervalLimitMessage,
  automationFormSubmitBlockReason,
  automationIntervalPresetOptions,
  buildAutomationFormWarnings,
  createInputFromForm,
  datetimeLocalFromIso,
  defaultModelSelection,
  formatCadence,
  formatCadenceLong,
  formatClockTime,
  formatDateTime,
  formatNextRun,
  formatSchedule,
  formFromDefinition,
  groupAutomationsByContinuedThread,
  automationsForThread,
  intervalFormPartsFromSeconds,
  isFormSubmittable,
  isoFromDatetimeLocal,
  modelSelectionForProjectChange,
  projectModelSelection,
  providerOptionsForAutomationModelSelection,
  scheduleFromForm,
  scheduleFromKind,
  scheduleKindFromSchedule,
  SCHEDULE_KIND_OPTIONS,
  TIME_OF_DAY_PATTERN,
  updateWeeklyScheduleDay,
  updateWeeklyScheduleTime,
  weekdayLabel,
  type AutomationFormState,
  type IntervalUnit,
  type ScheduleKind,
} from "~/lib/automationForm";
import {
  automationFailurePolicyOptions,
  type AutomationFailurePolicyValue,
} from "~/lib/automationFailurePolicy";
import { SkillCubeIcon, WorktreeIcon } from "~/lib/icons";
import { CentralIcon } from "~/lib/central-icons";
import { resolveRuntimeModelDescriptor } from "~/components/chat/runtimeModelCapabilities";
import { resolveProviderDiscoveryCwd } from "~/lib/providerDiscovery";
import {
  normalizeRuntimeModeForProvider,
  providerModelSupportsAutoRuntimeMode,
  providerSupportsAutoRuntimeMode,
} from "~/lib/runtimeMode";
import { findProviderStatus } from "~/lib/providerAvailability";
import { cn } from "~/lib/utils";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { ensureNativeApi } from "~/nativeApi";
import { buildModelSelection } from "~/providerModelOptions";
import { useProviderModelCatalog } from "~/hooks/useProviderModelCatalog";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { useStore } from "~/store";
import { resolveThreadPickerTitle } from "./-chatThreadRoute.logic";

export const automationQueryKey = ["automations"] as const;
export const EMPTY_AUTOMATION_LIST: AutomationListResult = {
  definitions: [],
  runs: [],
  memories: [],
};
const AUTOMATION_DEFINITION_UPDATE_SCOPE = {
  id: "automation-definition-updates",
} as const;

export function automationTargetThreads<
  TThread extends Pick<Thread, "projectId" | "sidechatSourceThreadId">,
>(threads: readonly TThread[], projectId: string): readonly TThread[] {
  return threads.filter(
    (thread) => thread.projectId === projectId && !thread.sidechatSourceThreadId,
  );
}

export function automationDefinitionUpdateMutationOptions(
  mutationFn: (input: AutomationUpdateInput) => Promise<AutomationDefinition>,
) {
  return { scope: AUTOMATION_DEFINITION_UPDATE_SCOPE, mutationFn };
}

export {
  acknowledgedRiskIdsForFormWarnings,
  applyScheduleToForm,
  automationFastIntervalLimitMessage,
  automationFormSubmitBlockReason,
  automationIntervalPresetOptions,
  buildAutomationFormWarnings,
  createInputFromForm,
  datetimeLocalFromIso,
  defaultModelSelection,
  formatCadence,
  formatCadenceLong,
  formatClockTime,
  formatDateTime,
  formatNextRun,
  formatSchedule,
  formFromDefinition,
  groupAutomationsByContinuedThread,
  automationsForThread,
  isFormSubmittable,
  isoFromDatetimeLocal,
  modelSelectionForProjectChange,
  projectModelSelection,
  providerOptionsForAutomationModelSelection,
  scheduleFromForm,
  scheduleFromKind,
  scheduleKindFromSchedule,
  SCHEDULE_KIND_OPTIONS,
  TIME_OF_DAY_PATTERN,
  updateWeeklyScheduleDay,
  updateWeeklyScheduleTime,
  weekdayLabel,
  type AutomationFormState,
  type IntervalUnit,
  type ScheduleKind,
};

/** Starter prompts surfaced behind the composer's "Use template" button. */
export const AUTOMATION_TEMPLATES: readonly {
  readonly label: string;
  readonly name: string;
  readonly prompt: string;
}[] = [
  {
    label: "Triage new crashes",
    name: "Triage crashes",
    prompt: "Look for new crashes in $sentry and open a fix PR for the most impactful one.",
  },
  {
    label: "Update dependencies",
    name: "Update dependencies",
    prompt:
      "Check for outdated dependencies, bump the safe minor and patch versions, then run the tests.",
  },
  {
    label: "Daily standup summary",
    name: "Daily summary",
    prompt:
      "Summarize what changed on the main branch in the last 24 hours as a short standup update.",
  },
];

export function formatRelativeTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w`;
  return `${Math.floor(days / 30)}mo`;
}

export function runStatusVariant(
  status: AutomationRun["status"],
): "success" | "warning" | "error" | "info" | "outline" {
  switch (status) {
    case "succeeded":
      return "success";
    case "failed":
    case "cancelled":
    case "interrupted":
      return "error";
    case "waiting-for-approval":
    case "skipped":
      return "warning";
    case "running":
    case "claimed":
    case "pending":
      return "info";
  }
}

/** Status-colored dot/icon class for a single run, shared by the detail history and triage rows. */
export function runStatusDotClassName(status: AutomationRun["status"]): string {
  switch (runStatusVariant(status)) {
    case "success":
      return "text-emerald-500";
    case "error":
      return "text-destructive";
    case "warning":
      return "text-amber-500";
    case "info":
      return "text-blue-500";
    case "outline":
      return "text-muted-foreground/50";
  }
}

/**
 * True when a click/keydown originated from an interactive control nested inside a clickable
 * row (delete button, link, input, etc.) rather than the row surface itself. Row components use
 * it to let inner controls handle their own events without also triggering the row's action.
 */
export function isRowInteractiveEventTarget(
  target: EventTarget | null,
  currentTarget: HTMLElement,
): boolean {
  if (!(target instanceof HTMLElement) || target === currentTarget) {
    return false;
  }
  return Boolean(target.closest("button,a,input,textarea,select,[contenteditable='true']"));
}

/**
 * Leading status glyph for a single run row: a quiet check for success, otherwise a
 * status-colored dot. Shared by the detail history and the list triage rows so both
 * surfaces read identically.
 */
export function RunStatusIndicator({
  status,
  className,
}: {
  readonly status: AutomationRun["status"];
  readonly className?: string;
}) {
  if (runStatusVariant(status) === "success") {
    return (
      <CentralIcon
        name="circle-check"
        className={cn("size-3.5 shrink-0 text-muted-foreground/70", className)}
      />
    );
  }
  return (
    <span
      className={cn(
        "flex size-3.5 shrink-0 items-center justify-center",
        runStatusDotClassName(status),
        className,
      )}
    >
      <span className="block size-1.5 rounded-full bg-current" />
    </span>
  );
}

export function isTriageRun(run: AutomationRun): boolean {
  if (run.status === "waiting-for-approval") {
    return true;
  }
  if (run.result) {
    return run.finishedAt !== null && isUnresolvedTriageResult(run.result);
  }
  return run.status === "failed" || run.status === "cancelled" || run.status === "interrupted";
}

export function isUnresolvedTriageResult(result: AutomationRunResult | null): boolean {
  return Boolean(result && result.unread && result.archivedAt === null);
}

export function unresolvedTriageRuns(runs: readonly AutomationRun[]): AutomationRun[] {
  return runs.filter((run) => isTriageRun(run));
}

export function allVisibleTriageRuns(runs: readonly AutomationRun[]): AutomationRun[] {
  return runs.filter((run) => {
    if (run.result) {
      return run.finishedAt !== null && run.result.archivedAt === null;
    }
    return isTriageRun(run);
  });
}

export function automationAttentionCount(runs: readonly AutomationRun[]): number {
  return unresolvedTriageRuns(runs).length;
}

export function runStatusLabel(status: AutomationRun["status"]): string {
  switch (status) {
    case "pending":
      return "Queued";
    case "claimed":
      return "Starting";
    case "running":
      return "Running";
    case "waiting-for-approval":
      return "Waiting for approval";
    case "succeeded":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
    case "skipped":
      return "Skipped";
  }
}

export function runResultSummary(run: AutomationRun): string {
  if (run.result?.summary) return run.result.summary;
  if (run.error) return run.error;
  switch (run.result?.outcome) {
    case "findings":
      return "Found something to review";
    case "no-findings":
      return "No findings";
    case "changed-files":
      return "Changed files";
    case "needs-attention":
      return "Needs attention";
    case "unknown":
      return run.threadId ? "Completed; open the thread for the reply" : "Completed";
    case undefined:
      return runStatusLabel(run.status);
  }
}

export function runResultTitle(run: AutomationRun): string | null {
  const title = run.result?.title?.trim();
  return title ? title : null;
}

export function canCancelAutomationRun(run: AutomationRun): boolean {
  return (
    run.status === "pending" ||
    run.status === "claimed" ||
    run.status === "running" ||
    run.status === "waiting-for-approval"
  );
}

/**
 * Plain-language warning for a latest run that needs the user's attention, or null when
 * the run ended normally (or is still progressing). Drives the amber glyph and the
 * subtitle warning segment on automation list rows.
 */
export function automationAttentionLabel(run: AutomationRun): string | null {
  switch (run.status) {
    case "waiting-for-approval":
      return "Waiting for approval";
    case "failed":
      return "Last run failed";
    case "cancelled":
      return "Last run cancelled";
    case "interrupted":
      return "Last run interrupted";
    default:
      return null;
  }
}

type LiveAutomationRun = AutomationRun & {
  readonly status: "pending" | "claimed" | "running" | "waiting-for-approval";
};

export function isLiveRun(run: AutomationRun | null): run is LiveAutomationRun {
  return (
    run?.status === "pending" ||
    run?.status === "claimed" ||
    run?.status === "running" ||
    run?.status === "waiting-for-approval"
  );
}

/**
 * Icon + tint for an automation list row's leading status glyph.
 * - Live runs spin with a circular loading glyph.
 * - Completed successful runs show a checkmark circle.
 * - Failed/cancelled/interrupted runs keep the warning exclamation.
 * - Scheduled (enabled with a future next run) shows a clock.
 * - Paused automations show a pause glyph.
 */
export function automationListRowIcon(
  definition: AutomationDefinition,
  latestRun: AutomationRun | null,
): { readonly name: string; readonly className: string } {
  // Pausing prevents future dispatches but does not cancel an in-flight run, so the
  // active run state must take precedence over the definition's enabled flag.
  if (isLiveRun(latestRun)) {
    return {
      name: "loading-circle",
      className: "size-4 animate-spin text-blue-500 motion-reduce:animate-none",
    };
  }
  if (!definition.enabled) {
    // Auto-disabled after consecutive failures is a problem to look at, not a pause the
    // user chose — keep the warning glyph so the row doesn't read as intentionally idle.
    if (definition.disabledReason === "failures") {
      return { name: "exclamation-circle", className: "size-4 text-amber-500" };
    }
    return { name: "pause", className: "size-4 text-muted-foreground/40" };
  }
  if (latestRun?.status === "succeeded") {
    return { name: "circle-check", className: "size-4 text-green-500" };
  }
  if (latestRun && automationAttentionLabel(latestRun) !== null) {
    return { name: "exclamation-circle", className: "size-4 text-amber-500" };
  }
  if (definition.nextRunAt) {
    return { name: "clock", className: "size-4 text-foreground/70" };
  }
  return { name: "circle-placeholder-on", className: "size-4 text-foreground/70" };
}

/**
 * Tint for the list row's leading status glyph: dimmed when paused, blue while a run is
 * live, amber when the latest run needs attention, otherwise neutral.
 */
export function automationStatusDotClass(
  definition: AutomationDefinition,
  latestRun: AutomationRun | null,
): string {
  if (!definition.enabled) return "text-muted-foreground/40";
  if (
    latestRun?.status === "running" ||
    latestRun?.status === "pending" ||
    latestRun?.status === "claimed"
  ) {
    return "text-blue-500";
  }
  if (latestRun && automationAttentionLabel(latestRun) !== null) return "text-amber-500";
  return "text-foreground/70";
}

const deletedAutomationIdsInCache = new Set<string>();

function isNewerTimestamp(candidate: string, existing: string): boolean {
  return candidate.localeCompare(existing) > 0;
}

// Snapshots are reconciliation data, so equal timestamps keep the live cache winner.
function isSameOrNewerTimestamp(candidate: string, existing: string): boolean {
  return candidate.localeCompare(existing) >= 0;
}

function mergeDefinitionsByUpdatedAt(
  snapshotDefinitions: readonly AutomationDefinition[],
  previousDefinitions: readonly AutomationDefinition[],
): AutomationDefinition[] {
  const previousById = new Map(
    previousDefinitions.map((definition) => [definition.id, definition]),
  );
  const seen = new Set<string>();
  const definitions: AutomationDefinition[] = [];
  for (const snapshotDefinition of snapshotDefinitions) {
    if (deletedAutomationIdsInCache.has(snapshotDefinition.id)) {
      continue;
    }
    seen.add(snapshotDefinition.id);
    const previousDefinition = previousById.get(snapshotDefinition.id);
    definitions.push(
      previousDefinition &&
        isSameOrNewerTimestamp(previousDefinition.updatedAt, snapshotDefinition.updatedAt)
        ? previousDefinition
        : snapshotDefinition,
    );
  }
  return definitions;
}

function upsertDefinitionByUpdatedAt(
  definitions: readonly AutomationDefinition[],
  incoming: AutomationDefinition,
): AutomationDefinition[] {
  const existing = definitions.find((definition) => definition.id === incoming.id);
  if (existing && isNewerTimestamp(existing.updatedAt, incoming.updatedAt)) {
    return [...definitions];
  }
  return existing
    ? definitions.map((definition) => (definition.id === incoming.id ? incoming : definition))
    : [incoming, ...definitions];
}

function mergeRunsByUpdatedAt(
  snapshotRuns: readonly AutomationRun[],
  previousRuns: readonly AutomationRun[],
  visibleAutomationIds?: ReadonlySet<AutomationId>,
): AutomationRun[] {
  const previousById = new Map(previousRuns.map((run) => [run.id, run]));
  const runs: AutomationRun[] = [];
  for (const snapshotRun of snapshotRuns) {
    if (
      deletedAutomationIdsInCache.has(snapshotRun.automationId) ||
      (visibleAutomationIds && !visibleAutomationIds.has(snapshotRun.automationId))
    ) {
      continue;
    }
    const previousRun = previousById.get(snapshotRun.id);
    runs.push(
      previousRun && isSameOrNewerTimestamp(previousRun.updatedAt, snapshotRun.updatedAt)
        ? previousRun
        : snapshotRun,
    );
  }
  return runs;
}

function upsertRunByUpdatedAt(
  runs: readonly AutomationRun[],
  incoming: AutomationRun,
): AutomationRun[] {
  const existing = runs.find((run) => run.id === incoming.id);
  if (existing && isNewerTimestamp(existing.updatedAt, incoming.updatedAt)) {
    return [...runs];
  }
  return existing
    ? runs.map((run) => (run.id === incoming.id ? incoming : run))
    : [incoming, ...runs];
}

function mergeMemoriesByUpdatedAt(
  snapshotMemories: readonly AutomationMemory[],
  previousMemories: readonly AutomationMemory[],
  visibleAutomationIds: ReadonlySet<AutomationId>,
): AutomationMemory[] {
  const previousByAutomationId = new Map(
    previousMemories.map((memory) => [memory.automationId, memory]),
  );
  const seen = new Set<AutomationId>();
  const memories: AutomationMemory[] = [];
  for (const snapshotMemory of snapshotMemories) {
    if (!visibleAutomationIds.has(snapshotMemory.automationId)) {
      continue;
    }
    seen.add(snapshotMemory.automationId);
    const previousMemory = previousByAutomationId.get(snapshotMemory.automationId);
    memories.push(
      previousMemory && isSameOrNewerTimestamp(previousMemory.updatedAt, snapshotMemory.updatedAt)
        ? previousMemory
        : snapshotMemory,
    );
  }
  for (const previousMemory of previousMemories) {
    if (
      !seen.has(previousMemory.automationId) &&
      visibleAutomationIds.has(previousMemory.automationId)
    ) {
      memories.push(previousMemory);
    }
  }
  return memories;
}

function upsertMemoryByUpdatedAt(
  memories: readonly AutomationMemory[],
  incoming: AutomationMemory,
): AutomationMemory[] {
  const existing = memories.find((memory) => memory.automationId === incoming.automationId);
  if (existing && isNewerTimestamp(existing.updatedAt, incoming.updatedAt)) {
    return [...memories];
  }
  return existing
    ? memories.map((memory) => (memory.automationId === incoming.automationId ? incoming : memory))
    : [incoming, ...memories];
}

export function applyAutomationEvent(
  prev: AutomationListResult | undefined,
  event: AutomationStreamEvent,
): AutomationListResult {
  const base = prev ?? EMPTY_AUTOMATION_LIST;
  switch (event.type) {
    case "snapshot": {
      const definitions = mergeDefinitionsByUpdatedAt(event.definitions, base.definitions);
      const visibleAutomationIds = new Set(definitions.map((definition) => definition.id));
      return {
        definitions,
        runs: mergeRunsByUpdatedAt(event.runs, base.runs, visibleAutomationIds),
        memories: mergeMemoriesByUpdatedAt(
          event.memories ?? [],
          base.memories ?? [],
          visibleAutomationIds,
        ),
      };
    }
    case "definition-upserted": {
      if (deletedAutomationIdsInCache.has(event.definition.id)) {
        return base;
      }
      deletedAutomationIdsInCache.delete(event.definition.id);
      const definitions = upsertDefinitionByUpdatedAt(base.definitions, event.definition);
      return { definitions, runs: base.runs, memories: base.memories ?? [] };
    }
    case "definition-deleted":
      deletedAutomationIdsInCache.add(event.automationId);
      return {
        definitions: base.definitions.filter((definition) => definition.id !== event.automationId),
        runs: base.runs.filter((run) => run.automationId !== event.automationId),
        memories: (base.memories ?? []).filter(
          (memory) => memory.automationId !== event.automationId,
        ),
      };
    case "run-upserted": {
      if (deletedAutomationIdsInCache.has(event.run.automationId)) {
        return base;
      }
      const runs = upsertRunByUpdatedAt(base.runs, event.run);
      return { definitions: base.definitions, runs, memories: base.memories ?? [] };
    }
    case "memory-upserted": {
      const currentMemories = base.memories ?? [];
      const memories = upsertMemoryByUpdatedAt(currentMemories, event.memory);
      return { definitions: base.definitions, runs: base.runs, memories };
    }
  }
}

/**
 * Roll back only the fields a failed update patched. Restoring the whole pre-mutation list
 * snapshot would also clobber everything that landed after it — a second inline edit's
 * optimistic merge, stream upserts — so the failed patch's keys are restored from the
 * pre-merge definition into the definition as it exists in the cache *now*. Input keys the
 * definition never had (legacy aliases) are removed rather than restored.
 */
export function rollbackAutomationDefinitionPatch(
  list: AutomationListResult,
  input: AutomationUpdateInput,
  previousDefinition: AutomationDefinition,
): AutomationListResult {
  return {
    definitions: list.definitions.map((definition) => {
      if (definition.id !== input.id) return definition;
      const next: Record<string, unknown> = { ...definition };
      for (const key of Object.keys(input)) {
        if (key === "id") continue;
        // A newer optimistic patch or authoritative stream event may already have
        // replaced this field while the failed request was in flight. Only undo the
        // value this mutation itself installed; otherwise an older failure can erase
        // the newer edit.
        if (!Object.is(next[key], (input as unknown as Record<string, unknown>)[key])) {
          continue;
        }
        if (key in previousDefinition) {
          next[key] = (previousDefinition as unknown as Record<string, unknown>)[key];
        } else {
          delete next[key];
        }
      }
      return next as unknown as AutomationDefinition;
    }),
    runs: list.runs,
    memories: list.memories ?? [],
  };
}

export function useAutomations(onRunStarted?: (threadId: ThreadId) => void) {
  const queryClient = useQueryClient();

  const automationsQuery = useQuery({
    queryKey: automationQueryKey,
    queryFn: () => ensureNativeApi().automation.list({}),
  });
  const data = automationsQuery.data ?? EMPTY_AUTOMATION_LIST;

  const createMutation = useMutation({
    mutationFn: (input: AutomationCreateInput) => ensureNativeApi().automation.create(input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: automationQueryKey }),
    onError: (error) => toastManager.add({ type: "error", title: error.message }),
  });
  const updateMutation = useMutation({
    ...automationDefinitionUpdateMutationOptions((input) =>
      ensureNativeApi().automation.update(input),
    ),
    // Optimistically merge the patch so inline edits on the detail page feel instant; the
    // server's authoritative definition (with recomputed nextRunAt) arrives via the stream.
    onMutate: (input) => {
      const previous = queryClient.getQueryData<AutomationListResult>(automationQueryKey);
      const previousDefinition =
        previous?.definitions.find((definition) => definition.id === input.id) ?? null;
      queryClient.setQueryData<AutomationListResult>(automationQueryKey, (prev) => {
        const base = prev ?? EMPTY_AUTOMATION_LIST;
        return {
          definitions: base.definitions.map((definition) =>
            definition.id === input.id
              ? ({ ...definition, ...input } as AutomationDefinition)
              : definition,
          ),
          runs: base.runs,
          memories: base.memories ?? [],
        };
      });
      return { previousDefinition };
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: automationQueryKey }),
    onError: (error, input, context) => {
      // A failed update would otherwise leave its optimistic merge in the cache until the
      // next stream tick. Roll back just this patch's fields — not the whole snapshot, which
      // would also erase concurrent edits' merges (see rollbackAutomationDefinitionPatch).
      const previousDefinition = context?.previousDefinition;
      if (previousDefinition) {
        queryClient.setQueryData<AutomationListResult>(automationQueryKey, (prev) =>
          prev ? rollbackAutomationDefinitionPatch(prev, input, previousDefinition) : prev,
        );
      }
      toastManager.add({ type: "error", title: error.message });
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (definition: AutomationDefinition) =>
      ensureNativeApi().automation.delete({ id: definition.id }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: automationQueryKey }),
    onError: (error) => toastManager.add({ type: "error", title: error.message }),
  });
  const runNowMutation = useMutation({
    mutationFn: (definition: AutomationDefinition) =>
      ensureNativeApi().automation.runNow({ automationId: definition.id }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: automationQueryKey });
      if (result.run.threadId) onRunStarted?.(result.run.threadId);
    },
    onError: (error) => toastManager.add({ type: "error", title: error.message }),
  });
  const cancelRunMutation = useMutation({
    mutationFn: (run: AutomationRun) => ensureNativeApi().automation.cancelRun({ runId: run.id }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: automationQueryKey }),
    onError: (error) => toastManager.add({ type: "error", title: error.message }),
  });
  const markRunReadMutation = useMutation({
    mutationFn: (input: { readonly run: AutomationRun; readonly unread: boolean }) =>
      ensureNativeApi().automation.markRunRead({ runId: input.run.id, unread: input.unread }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: automationQueryKey }),
    onError: (error) => toastManager.add({ type: "error", title: error.message }),
  });
  const archiveRunMutation = useMutation({
    mutationFn: (input: { readonly run: AutomationRun; readonly archived: boolean }) =>
      ensureNativeApi().automation.archiveRun({ runId: input.run.id, archived: input.archived }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: automationQueryKey }),
    onError: (error) => toastManager.add({ type: "error", title: error.message }),
  });

  const runsByAutomationId = new Map<string, AutomationRun[]>();
  for (const run of data.runs) {
    const runs = runsByAutomationId.get(run.automationId) ?? [];
    runs.push(run);
    runsByAutomationId.set(run.automationId, runs);
  }
  for (const runs of runsByAutomationId.values()) {
    runs.sort((left, right) => right.scheduledFor.localeCompare(left.scheduledFor));
  }

  return {
    data,
    isLoading: automationsQuery.isLoading,
    refetch: automationsQuery.refetch,
    createMutation,
    updateMutation,
    deleteMutation,
    runNowMutation,
    cancelRunMutation,
    markRunReadMutation,
    archiveRunMutation,
    runsByAutomationId,
  };
}

/** Subtle labeled pill used in the automation composer toolbar. */
const CHIP_CLASS =
  "gap-1.5 rounded-lg px-2 font-normal text-[var(--color-text-foreground-secondary)]";
type CadenceOption = { readonly value: string; readonly label: string };

/** Heartbeat run-count presets ("" = unlimited). */
const MAX_ITERATION_PRESETS: readonly CadenceOption[] = [
  { value: "", label: "Unlimited" },
  { value: "10", label: "10 runs" },
  { value: "25", label: "25 runs" },
  { value: "50", label: "50 runs" },
  { value: "100", label: "100 runs" },
  { value: "250", label: "250 runs" },
];

function maxIterationLabel(value: string): string {
  return value === "1" ? "1 run" : `${value} runs`;
}

export function maxIterationOptions(
  currentValue: string | number | null | undefined,
): readonly { readonly value: string; readonly label: string }[] {
  const value = currentValue == null ? "" : String(currentValue).trim();
  if (!/^\d+$/.test(value) || MAX_ITERATION_PRESETS.some((preset) => preset.value === value)) {
    return MAX_ITERATION_PRESETS;
  }
  return [{ value, label: maxIterationLabel(value) }, ...MAX_ITERATION_PRESETS];
}

// Shown at the top of an automation's detail panel when saving or manual run actions need
// one-time risk approval.
export function AutomationApprovalBanner({
  warnings,
  busy,
  onApprove,
  onApproveAndRun,
}: {
  readonly warnings: readonly AutomationDraftWarning[];
  readonly busy: boolean;
  readonly onApprove: () => void;
  readonly onApproveAndRun: () => void;
}) {
  if (warnings.length === 0) {
    return null;
  }
  return (
    <Alert variant="warning">
      <AlertTitle>Approval needed</AlertTitle>
      <AlertDescription>
        <span>
          This automation needs your approval once before Synara can save changes. When a warning
          blocks manual runs, Run now stays disabled until you approve it.
        </span>
        <ul className="flex flex-col gap-1.5">
          {warnings.map((warning) => (
            <li key={warning.id} className="text-xs">
              <span className="font-medium text-foreground/90">{warning.title}</span>
              <span className="block">{warning.detail}</span>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onApprove}>
            Approve
          </Button>
          <Button type="button" size="sm" disabled={busy} onClick={onApproveAndRun}>
            Approve &amp; run now
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

export function AutomationModelPicker({
  value,
  projectCwd,
  disabled,
  onChange,
  onAutoModeSupportChange,
}: {
  readonly value: ModelSelection;
  readonly projectCwd: string | null;
  readonly disabled?: boolean;
  readonly onChange: (value: ModelSelection) => void;
  readonly onAutoModeSupportChange?: (supported: boolean) => void;
}) {
  const { settings } = useAppSettings();
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const providerStatuses = useProviderStatusesForLocalConfig();
  const [open, setOpen] = useState(false);
  const modelHintByProvider: Partial<Record<ProviderKind, string | null>> = {
    [value.provider]: value.model,
  };
  const providerModelDiscoveryCwd = resolveProviderDiscoveryCwd({
    activeThreadWorktreePath: null,
    activeProjectCwd: projectCwd,
    serverCwd: serverConfigQuery.data?.cwd ?? null,
  });
  const {
    modelOptionsByProvider,
    loadingModelProviders,
    runtimeModelsByProvider,
    selectedRuntimeModel,
  } = useProviderModelCatalog({
    selectedProvider: value.provider,
    discoveryEnabled: open,
    cwd: providerModelDiscoveryCwd,
    modelHintByProvider,
  });
  const providerStatus = findProviderStatus(providerStatuses, value.provider);
  const persistedRuntimeModel =
    value.provider === "claudeAgent" && typeof value.supportsAutoMode === "boolean"
      ? {
          slug: value.model,
          name: value.model,
          supportsAutoMode: value.supportsAutoMode,
        }
      : undefined;
  const autoModeSupported = providerModelSupportsAutoRuntimeMode(
    value.provider,
    selectedRuntimeModel ?? persistedRuntimeModel,
    providerStatus,
  );
  useEffect(() => {
    onAutoModeSupportChange?.(autoModeSupported);
  }, [autoModeSupported, onAutoModeSupportChange]);

  return (
    <ProviderModelPicker
      compact
      provider={value.provider}
      model={value.model}
      lockedProvider={null}
      providers={providerStatuses}
      modelOptionsByProvider={modelOptionsByProvider}
      loadingModelProviders={loadingModelProviders}
      hiddenProviders={settings.hiddenProviders}
      providerOrder={settings.providerOrder}
      disabled={disabled ?? false}
      open={open}
      onOpenChange={setOpen}
      onProviderModelChange={(provider, model) => {
        const runtimeModel = resolveRuntimeModelDescriptor({
          provider,
          model,
          runtimeModels: runtimeModelsByProvider[provider],
        });
        onChange(buildModelSelection(provider, model, undefined, runtimeModel?.supportsAutoMode));
      }}
    />
  );
}

export function reconcileAutomationFormAutoModeSupport(
  form: AutomationFormState,
  supported: boolean,
): AutomationFormState {
  const modelSelection =
    form.modelSelection.provider === "claudeAgent" &&
    form.modelSelection.supportsAutoMode !== supported
      ? { ...form.modelSelection, supportsAutoMode: supported }
      : form.modelSelection;
  const runtimeMode =
    !supported && form.runtimeMode === "auto" ? "approval-required" : form.runtimeMode;
  return modelSelection !== form.modelSelection || runtimeMode !== form.runtimeMode
    ? { ...form, modelSelection, runtimeMode }
    : form;
}

export function AutomationDialog({
  open,
  form,
  projects,
  threads,
  warnings: warningsProp,
  acknowledgedWarningIds: acknowledgedWarningIdsProp,
  onOpenChange,
  onFormChange,
  onToggleWarning,
  onSubmit,
  busy,
}: {
  readonly open: boolean;
  readonly form: AutomationFormState;
  readonly projects: ReturnType<typeof useStore.getState>["projects"];
  readonly threads: readonly Thread[];
  readonly warnings?: readonly AutomationDraftWarning[];
  readonly acknowledgedWarningIds?: ReadonlySet<AutomationDraftWarningId>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onFormChange: (form: AutomationFormState) => void;
  readonly onToggleWarning?: (id: AutomationDraftWarningId, checked: boolean) => void;
  readonly onSubmit: () => void;
  readonly busy: boolean;
}) {
  const warnings: readonly AutomationDraftWarning[] = warningsProp ?? [];
  const acknowledgedWarningIds: ReadonlySet<AutomationDraftWarningId> =
    acknowledgedWarningIdsProp ?? new Set<AutomationDraftWarningId>();
  const setField = <K extends keyof AutomationFormState>(key: K, value: AutomationFormState[K]) =>
    onFormChange({ ...form, [key]: value });
  const projectThreads = automationTargetThreads(threads, form.projectId);
  const selectedProject = projects.find((project) => project.id === form.projectId);
  const [selectedModelSupportsAuto, setSelectedModelSupportsAuto] = useState(() =>
    form.modelSelection.provider === "claudeAgent"
      ? form.modelSelection.supportsAutoMode !== false
      : providerSupportsAutoRuntimeMode(form.modelSelection.provider),
  );
  const handleAutoModeSupportChange = useCallback(
    (supported: boolean) => {
      setSelectedModelSupportsAuto(supported);
      const reconciled = reconcileAutomationFormAutoModeSupport(form, supported);
      if (reconciled !== form) {
        onFormChange(reconciled);
      }
    },
    [form, onFormChange],
  );
  const schedule = scheduleFromForm(form);
  const fastIntervalLimitMessage = automationFastIntervalLimitMessage(form);
  const submitBlockReason = automationFormSubmitBlockReason(form, warnings, acknowledgedWarningIds);
  const submittable = submitBlockReason === null;
  const maxIterationPresets = maxIterationOptions(form.maxIterations);
  const intervalAmount = Number.parseInt(form.intervalAmount, 10);
  const intervalSeconds = Number.isFinite(intervalAmount)
    ? form.intervalUnit === "seconds"
      ? intervalAmount
      : intervalAmount * 60
    : undefined;
  // "Hourly" is its own ScheduleKind in this dialog, so the interval list skips it.
  const intervalPresetOptions = automationIntervalPresetOptions({
    currentSeconds: intervalSeconds,
    includeHourly: false,
  });

  const chooseProject = (projectId: string) => {
    const targetStillMatches =
      form.targetThreadId.length > 0 &&
      threads.some((thread) => thread.id === form.targetThreadId && thread.projectId === projectId);
    const modelSelection = modelSelectionForProjectChange(
      projects,
      form.projectId,
      projectId,
      form.modelSelection,
    );
    onFormChange({
      ...form,
      projectId,
      modelSelection,
      runtimeMode: normalizeRuntimeModeForProvider(form.runtimeMode, modelSelection.provider),
      targetThreadId: targetStillMatches ? form.targetThreadId : "",
    });
  };

  const applyTemplate = (template: (typeof AUTOMATION_TEMPLATES)[number]) =>
    onFormChange({
      ...form,
      name: form.name.trim() ? form.name : template.name,
      prompt: template.prompt,
    });

  const submit = () => {
    if (busy || !submittable) return;
    onSubmit();
  };
  const handleOpenChange = (nextOpen: boolean) => {
    if (busy && !nextOpen) return;
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup showCloseButton={false} className="max-w-3xl">
        <DialogTitle className="sr-only">New automation</DialogTitle>

        <div className="flex items-start gap-3 px-5 pt-5">
          <input
            value={form.name}
            onChange={(event) => setField("name", event.target.value)}
            placeholder="Automation title"
            aria-label="Automation title"
            autoFocus
            className="min-w-0 flex-1 bg-transparent py-1 font-system-ui text-lg font-medium text-foreground outline-none placeholder:text-muted-foreground/50"
          />
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="About automations"
              title="Automations run this prompt on a schedule and open the result as a thread."
            >
              <CentralIcon name="info-simple" className="size-4" />
            </Button>
            <Menu>
              <MenuTrigger render={<Button variant="outline" size="sm" />}>
                Use template
              </MenuTrigger>
              <ComposerPickerMenuPopup align="end" className="w-52">
                {AUTOMATION_TEMPLATES.map((template) => (
                  <MenuItem key={template.label} onClick={() => applyTemplate(template)}>
                    {template.label}
                  </MenuItem>
                ))}
              </ComposerPickerMenuPopup>
            </Menu>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Close"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              <CentralIcon name="cross-small" className="size-4" />
            </Button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-3">
          <textarea
            value={form.prompt}
            onChange={(event) => setField("prompt", event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="Add prompt e.g. look for crashes in $sentry"
            aria-label="Automation prompt"
            className="min-h-[15rem] w-full flex-1 resize-none overflow-y-auto bg-transparent font-system-ui text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/50"
          />

          {warnings.length > 0 ? (
            <div className="mt-2 flex flex-col gap-1.5 border-t border-border/50 pt-3">
              {warnings.map((warning) => (
                <label
                  key={warning.id}
                  className="flex items-start gap-2 text-xs text-muted-foreground"
                >
                  {warning.requiresAcknowledgement ? (
                    <input
                      type="checkbox"
                      checked={acknowledgedWarningIds.has(warning.id)}
                      onChange={(event) => onToggleWarning?.(warning.id, event.target.checked)}
                      className="mt-0.5"
                    />
                  ) : (
                    <span className="mt-1 size-1.5 shrink-0 rounded-full bg-amber-500" />
                  )}
                  <span className="min-w-0">
                    <span className="font-medium text-foreground">{warning.title}</span>
                    <span className="block">{warning.detail}</span>
                  </span>
                </label>
              ))}
            </div>
          ) : null}
          {fastIntervalLimitMessage ? (
            <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-300">
              {fastIntervalLimitMessage}
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2 px-4 pb-4 pt-1">
          <div className="flex flex-1 flex-wrap items-center gap-0.5">
            {/* Heartbeat runs inherit the target thread's environment; every other mode
                opens its own thread and therefore picks one. */}
            {automationRequiresTargetThread(form.mode) ? null : (
              <Menu>
                <MenuTrigger render={<Button variant="ghost" size="sm" className={CHIP_CLASS} />}>
                  <WorktreeIcon className="size-4" />
                  <span className="capitalize">{form.worktreeMode}</span>
                  <CentralIcon name="chevron-down-small" className="size-3.5 opacity-60" />
                </MenuTrigger>
                <ComposerPickerMenuPopup align="start" className="w-40">
                  <MenuRadioGroup
                    value={form.worktreeMode}
                    onValueChange={(value) =>
                      setField("worktreeMode", value as AutomationWorktreeMode)
                    }
                  >
                    {(["auto", "worktree", "local"] as const).map((value) => (
                      <MenuRadioItem key={value} value={value}>
                        <span className="capitalize">{value}</span>
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </ComposerPickerMenuPopup>
              </Menu>
            )}

            <Menu>
              <MenuTrigger render={<Button variant="ghost" size="sm" className={CHIP_CLASS} />}>
                <CentralIcon name="folder-2" className="size-4" />
                <span className="max-w-[10rem] truncate">
                  {selectedProject?.name ?? "Select project"}
                </span>
                <CentralIcon name="chevron-down-small" className="size-3.5 opacity-60" />
              </MenuTrigger>
              <ComposerPickerMenuPopup align="start" className="w-56">
                <MenuRadioGroup value={form.projectId} onValueChange={chooseProject}>
                  {projects.map((project) => (
                    <MenuRadioItem key={project.id} value={project.id}>
                      <span className="truncate">{project.name}</span>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </ComposerPickerMenuPopup>
            </Menu>

            <AutomationModelPicker
              value={form.modelSelection}
              projectCwd={selectedProject?.cwd ?? null}
              onChange={(value) => {
                onFormChange({
                  ...form,
                  modelSelection: value,
                  runtimeMode: normalizeRuntimeModeForProvider(form.runtimeMode, value.provider),
                });
              }}
              onAutoModeSupportChange={handleAutoModeSupportChange}
            />

            <Menu>
              <MenuTrigger render={<Button variant="ghost" size="sm" className={CHIP_CLASS} />}>
                <CentralIcon name="clock" className="size-4" />
                <span>{formatCadence(schedule)}</span>
                <CentralIcon name="chevron-down-small" className="size-3.5 opacity-60" />
              </MenuTrigger>
              <ComposerPickerMenuPopup align="start" className="w-56">
                <MenuGroup>
                  <MenuGroupLabel>Schedule</MenuGroupLabel>
                  <MenuRadioGroup
                    value={form.scheduleKind}
                    onValueChange={(value) => setField("scheduleKind", value as ScheduleKind)}
                  >
                    {SCHEDULE_KIND_OPTIONS.map((option) => (
                      <MenuRadioItem key={option.value} value={option.value}>
                        {option.label}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuGroup>
                {form.scheduleKind === "custom" ? (
                  <>
                    <MenuSeparator />
                    <MenuGroup>
                      <MenuGroupLabel>Every</MenuGroupLabel>
                      <MenuRadioGroup
                        value={intervalSeconds === undefined ? "" : String(intervalSeconds)}
                        onValueChange={(value) => {
                          const seconds = Number.parseInt(value, 10);
                          if (!Number.isFinite(seconds) || seconds <= 0) return;
                          const parts = intervalFormPartsFromSeconds(seconds);
                          onFormChange({
                            ...form,
                            intervalUnit: parts.unit,
                            intervalAmount: parts.amount,
                          });
                        }}
                      >
                        {intervalPresetOptions.map((preset) => (
                          <MenuRadioItem key={preset.value} value={preset.value}>
                            {preset.label}
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </MenuGroup>
                  </>
                ) : null}
                {form.scheduleKind === "once" ? (
                  <>
                    <MenuSeparator />
                    <MenuGroup>
                      <MenuGroupLabel>Run at</MenuGroupLabel>
                      <div className="px-2 py-1">
                        <input
                          type="datetime-local"
                          step={1}
                          value={form.onceRunAt}
                          onChange={(event) => setField("onceRunAt", event.target.value)}
                          className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        />
                      </div>
                    </MenuGroup>
                  </>
                ) : null}
                {form.scheduleKind === "cron" ? (
                  <>
                    <MenuSeparator />
                    <MenuGroup>
                      <MenuGroupLabel>Cron</MenuGroupLabel>
                      <div className="px-2 py-1">
                        <input
                          value={form.cronExpression}
                          onChange={(event) => setField("cronExpression", event.target.value)}
                          placeholder="0 9 * * *"
                          className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        />
                      </div>
                    </MenuGroup>
                  </>
                ) : null}
                {form.scheduleKind === "weekly" ? (
                  <>
                    <MenuSeparator />
                    <MenuGroup>
                      <MenuGroupLabel>Day</MenuGroupLabel>
                      <MenuRadioGroup
                        value={form.dayOfWeek}
                        onValueChange={(value) => setField("dayOfWeek", value)}
                      >
                        {[0, 1, 2, 3, 4, 5, 6].map((value) => (
                          <MenuRadioItem key={value} value={String(value)}>
                            {weekdayLabel(value)}
                          </MenuRadioItem>
                        ))}
                      </MenuRadioGroup>
                    </MenuGroup>
                  </>
                ) : null}
                {form.scheduleKind === "daily" ||
                form.scheduleKind === "weekdays" ||
                form.scheduleKind === "weekly" ? (
                  <>
                    <MenuSeparator />
                    <MenuSub>
                      <MenuSubTrigger>
                        Time
                        <span className="ml-auto pr-1 tabular-nums text-muted-foreground">
                          {form.timeOfDay}
                        </span>
                      </MenuSubTrigger>
                      <ComposerPickerMenuSubPopup>
                        <div className="p-1">
                          <TimePicker
                            className="w-44"
                            value={form.timeOfDay}
                            onChange={(value) => setField("timeOfDay", value)}
                          />
                        </div>
                      </ComposerPickerMenuSubPopup>
                    </MenuSub>
                  </>
                ) : null}
                {form.scheduleKind === "daily" ||
                form.scheduleKind === "weekdays" ||
                form.scheduleKind === "weekly" ||
                form.scheduleKind === "cron" ? (
                  <>
                    <MenuSeparator />
                    <MenuGroup>
                      <MenuGroupLabel>Timezone</MenuGroupLabel>
                      <div className="px-2 py-1">
                        <input
                          value={form.timezone}
                          onChange={(event) => setField("timezone", event.target.value)}
                          placeholder="Europe/Rome"
                          className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        />
                      </div>
                    </MenuGroup>
                  </>
                ) : null}
              </ComposerPickerMenuPopup>
            </Menu>

            <Menu>
              <MenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Run mode"
                    title="Run mode"
                    className="rounded-lg text-[var(--color-text-foreground-secondary)]"
                  />
                }
              >
                <SkillCubeIcon className="size-4" />
              </MenuTrigger>
              <ComposerPickerMenuPopup align="start" className="w-56">
                <MenuGroup>
                  <MenuGroupLabel>Mode</MenuGroupLabel>
                  <MenuRadioGroup
                    value={form.mode}
                    onValueChange={(value) => setField("mode", value as AutomationMode)}
                  >
                    <MenuRadioItem value="standalone">Standalone</MenuRadioItem>
                    <MenuRadioItem value="dedicated">Dedicated thread</MenuRadioItem>
                    <MenuRadioItem value="heartbeat">Heartbeat</MenuRadioItem>
                  </MenuRadioGroup>
                </MenuGroup>
                {/* Only heartbeat continues a thread the user picks; a dedicated automation
                    creates and keeps its own. */}
                {automationRequiresTargetThread(form.mode) ? (
                  <>
                    <MenuSeparator />
                    <MenuGroup>
                      <MenuGroupLabel>Target thread</MenuGroupLabel>
                      {projectThreads.length === 0 ? (
                        <MenuItem disabled>No threads in this project</MenuItem>
                      ) : (
                        <MenuRadioGroup
                          value={form.targetThreadId}
                          onValueChange={(value) => setField("targetThreadId", value)}
                        >
                          {projectThreads.map((thread) => (
                            <MenuRadioItem key={thread.id} value={thread.id}>
                              <span className="truncate">
                                {resolveThreadPickerTitle(thread.title)}
                              </span>
                            </MenuRadioItem>
                          ))}
                        </MenuRadioGroup>
                      )}
                    </MenuGroup>
                  </>
                ) : null}
                <MenuSeparator />
                <MenuGroup>
                  <MenuGroupLabel>Stop when</MenuGroupLabel>
                  <div className="px-2 py-1">
                    <input
                      value={form.stopWhen}
                      onChange={(event) => setField("stopWhen", event.target.value)}
                      placeholder="PR is ready to merge"
                      className="w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    />
                  </div>
                </MenuGroup>
                <MenuSeparator />
                <MenuGroup>
                  <MenuGroupLabel>On failure</MenuGroupLabel>
                  <MenuRadioGroup
                    value={form.stopAfterFailures}
                    onValueChange={(value) =>
                      setField("stopAfterFailures", value as AutomationFailurePolicyValue)
                    }
                  >
                    {automationFailurePolicyOptions(form.stopAfterFailures).map((option) => (
                      <MenuRadioItem key={option.value} value={option.value}>
                        {option.label}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuGroup>
                <MenuSeparator />
                <MenuGroup>
                  <MenuGroupLabel>Max iterations</MenuGroupLabel>
                  <MenuRadioGroup
                    value={form.maxIterations}
                    onValueChange={(value) => setField("maxIterations", value)}
                  >
                    {maxIterationPresets.map((preset) => (
                      <MenuRadioItem key={preset.value || "unlimited"} value={preset.value}>
                        {preset.label}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuGroup>
                <MenuSeparator />
                <MenuGroup>
                  <MenuGroupLabel>Notify</MenuGroupLabel>
                  <MenuRadioGroup
                    value={form.notificationPolicy}
                    onValueChange={(value) =>
                      setField("notificationPolicy", value as AutomationNotificationPolicy)
                    }
                  >
                    <MenuRadioItem value="all">All runs</MenuRadioItem>
                    <MenuRadioItem value="failed-runs-only">Failed runs only</MenuRadioItem>
                  </MenuRadioGroup>
                </MenuGroup>
              </ComposerPickerMenuPopup>
            </Menu>

            <Menu>
              <MenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Permissions"
                    title="Permissions"
                    className="rounded-lg text-[var(--color-text-foreground-secondary)]"
                  />
                }
              >
                <CentralIcon
                  name={
                    form.runtimeMode === "auto"
                      ? "shield-code"
                      : form.runtimeMode === "full-access"
                        ? "shield-access"
                        : "brain"
                  }
                  className={cn(
                    "size-4",
                    form.runtimeMode === "auto" && RUNTIME_AUTO_ICON_ACCENT_CLASS_NAME,
                  )}
                />
              </MenuTrigger>
              <ComposerPickerMenuPopup align="start" className="w-48">
                <MenuRadioGroup
                  value={form.runtimeMode}
                  onValueChange={(value) => setField("runtimeMode", value as RuntimeMode)}
                >
                  <MenuRadioItem value="approval-required">Approval required</MenuRadioItem>
                  {selectedModelSupportsAuto ? (
                    <MenuRadioItem value="auto">
                      <CentralIcon
                        name="shield-code"
                        className={cn("size-4", RUNTIME_AUTO_ICON_ACCENT_CLASS_NAME)}
                      />
                      Auto
                    </MenuRadioItem>
                  ) : null}
                  <MenuRadioItem value="full-access">Full access</MenuRadioItem>
                </MenuRadioGroup>
              </ComposerPickerMenuPopup>
            </Menu>
          </div>

          <div className="flex min-w-0 shrink-0 items-center gap-2">
            {submitBlockReason ? (
              <span className="min-w-0 truncate text-xs text-muted-foreground" role="status">
                {submitBlockReason}
              </span>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={submit}
              disabled={busy || !submittable}
              title={submitBlockReason ?? undefined}
            >
              Create
            </Button>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

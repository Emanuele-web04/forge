// FILE: -automations.shared.test.tsx
// Purpose: Verifies pure automation UI helpers for schedule and triage behavior.
// Layer: Web route helper test
// Depends on: -automations.shared exported helper functions.

import {
  AutomationId,
  AutomationRunId,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  DEFAULT_AUTOMATION_STOP_CONFIDENCE_THRESHOLD,
  type AutomationDefinition,
  type AutomationRun,
  type ProviderStartOptions,
} from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import {
  applyScheduleToForm,
  allVisibleTriageRuns,
  applyAutomationEvent,
  automationDefinitionUpdateMutationOptions,
  automationAttentionCount,
  automationAttentionLabel,
  automationFastIntervalLimitMessage,
  automationListRowIcon,
  automationTargetThreads,
  canCancelAutomationRun,
  createInputFromForm,
  datetimeLocalFromIso,
  formatCadence,
  formatCadenceLong,
  formatNextRun,
  formatSchedule,
  formFromDefinition,
  isoFromDatetimeLocal,
  isFormSubmittable,
  isTriageRun,
  maxIterationOptions,
  modelSelectionForProjectChange,
  providerOptionsForAutomationModelSelection,
  reconcileAutomationFormAutoModeSupport,
  rollbackAutomationDefinitionPatch,
  runResultSummary,
  runResultTitle,
  scheduleKindFromSchedule,
  scheduleFromForm,
  updateWeeklyScheduleDay,
  updateWeeklyScheduleTime,
  unresolvedTriageRuns,
} from "./-automations.shared";

describe("automation definition update ordering", () => {
  it("serializes successful edits in submission order", async () => {
    const queryClient = new QueryClient();
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const buildMutation = (name: string, gate?: Promise<void>) =>
      queryClient.getMutationCache().build(queryClient, {
        ...automationDefinitionUpdateMutationOptions(async () => {
          calls.push(`${name}:start`);
          await gate;
          calls.push(`${name}:finish`);
          return {} as AutomationDefinition;
        }),
      });
    const first = buildMutation("first", firstGate);
    const second = buildMutation("second");

    const input = { id: automationId("automation-ordered-edits") };
    const firstRequest = first.execute(input);
    const secondRequest = second.execute(input);
    await vi.waitFor(() => expect(calls).toEqual(["first:start"]));
    releaseFirst();
    await Promise.all([firstRequest, secondRequest]);

    expect(calls).toEqual(["first:start", "first:finish", "second:start", "second:finish"]);
  });
});

const runId = (value: string) => AutomationRunId.makeUnsafe(value);
const automationId = (value: string) => AutomationId.makeUnsafe(value);
const projectId = (value: string) => ProjectId.makeUnsafe(value);
const threadId = (value: string) => ThreadId.makeUnsafe(value);
const commandId = (value: string) => CommandId.makeUnsafe(value);
const messageId = (value: string) => MessageId.makeUnsafe(value);

describe("automationTargetThreads", () => {
  it("excludes parent-linked side chats from heartbeat target choices", () => {
    const project = projectId("project-1");
    const parent = { projectId: project, sidechatSourceThreadId: null, title: "Parent" };
    const sidechat = {
      projectId: project,
      sidechatSourceThreadId: threadId("thread-parent"),
      title: "Side chat",
    };

    expect(automationTargetThreads([sidechat, parent], project)).toEqual([parent]);
  });
});

describe("reconcileAutomationFormAutoModeSupport", () => {
  it("persists refreshed Claude capability before an Auto automation is submitted", () => {
    const form = {
      ...formFromDefinition(null, "project-1"),
      modelSelection: {
        provider: "claudeAgent" as const,
        model: "sonnet",
        supportsAutoMode: false,
      },
      runtimeMode: "approval-required" as const,
    };

    expect(reconcileAutomationFormAutoModeSupport(form, true)).toMatchObject({
      modelSelection: {
        provider: "claudeAgent",
        model: "sonnet",
        supportsAutoMode: true,
      },
      runtimeMode: "approval-required",
    });
  });

  it("downgrades an Auto automation when refreshed capability is unavailable", () => {
    const form = {
      ...formFromDefinition(null, "project-1"),
      modelSelection: {
        provider: "claudeAgent" as const,
        model: "sonnet",
        supportsAutoMode: true,
      },
      runtimeMode: "auto" as const,
    };

    expect(reconcileAutomationFormAutoModeSupport(form, false)).toMatchObject({
      modelSelection: {
        provider: "claudeAgent",
        model: "sonnet",
        supportsAutoMode: false,
      },
      runtimeMode: "approval-required",
    });
  });
});

const baseRun: AutomationRun = {
  id: runId("run-1"),
  automationId: automationId("automation-1"),
  projectId: projectId("project-1"),
  threadId: threadId("thread-1"),
  turnId: null,
  trigger: { type: "scheduled" },
  status: "succeeded",
  scheduledFor: "2026-06-19T10:00:00.000Z",
  claimedBy: null,
  claimedAt: null,
  leaseExpiresAt: null,
  startedAt: "2026-06-19T10:00:00.000Z",
  finishedAt: "2026-06-19T10:01:00.000Z",
  threadCreateCommandId: commandId("cmd-thread-create"),
  turnStartCommandId: commandId("cmd-turn-start"),
  messageId: messageId("message-1"),
  error: null,
  result: {
    outcome: "unknown",
    summary: "Review run output.",
    unread: true,
    archivedAt: null,
  },
  permissionSnapshot: {
    provider: "codex",
    modelSelection: { provider: "codex", model: "gpt-5-codex" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    worktreeMode: "auto",
    allowedCapabilities: ["send-turn"],
    createdAt: "2026-06-19T10:00:00.000Z",
  },
  createdAt: "2026-06-19T10:00:00.000Z",
  updatedAt: "2026-06-19T10:01:00.000Z",
};

const baseDefinition: AutomationDefinition = {
  id: automationId("automation-1"),
  projectId: projectId("project-1"),
  sourceThreadId: null,
  name: "Check status",
  prompt: "Check status.",
  schedule: { type: "interval", everySeconds: 3600 },
  enabled: true,
  nextRunAt: "2026-06-19T11:00:00.000Z",
  modelSelection: { provider: "codex", model: "gpt-5-codex" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  worktreeMode: "auto",
  mode: "standalone",
  targetThreadId: null,
  maxIterations: null,
  stopAfterConsecutiveFailures: 3,
  consecutiveFailureCount: 0,
  disabledReason: null,
  disabledAt: null,
  completionPolicy: { type: "none" },
  completionPolicyVersion: 1,
  completionPolicyUpdatedAt: "2026-06-19T10:00:00.000Z",
  minimumIntervalSeconds: 60,
  maxRuntimeSeconds: 3600,
  retryPolicy: { type: "none" },
  misfirePolicy: "coalesce",
  acknowledgedRisks: [],
  iterationCount: 0,
  createdAt: "2026-06-19T10:00:00.000Z",
  updatedAt: "2026-06-19T10:00:00.000Z",
  archivedAt: null,
};

function runWith(overrides: Partial<AutomationRun>): AutomationRun {
  return { ...baseRun, ...overrides };
}

function definitionWith(overrides: Partial<AutomationDefinition>): AutomationDefinition {
  return { ...baseDefinition, ...overrides };
}

describe("automation shared route helpers", () => {
  it("preserves manual and new schedule kinds", () => {
    expect(scheduleKindFromSchedule({ type: "manual" })).toBe("manual");
    expect(scheduleKindFromSchedule({ type: "once", runAt: "2026-06-19T10:15:00.000Z" })).toBe(
      "once",
    );
    expect(
      scheduleKindFromSchedule({
        type: "cron",
        expression: "0 9 * * *",
        timezone: "Europe/Rome",
      }),
    ).toBe("cron");
  });

  it("spells out interval cadences in the long form", () => {
    expect(formatCadenceLong({ type: "interval", everySeconds: 300 })).toBe("Every 5 minutes");
    expect(formatCadenceLong({ type: "interval", everySeconds: 60 })).toBe("Every minute");
    expect(formatCadenceLong({ type: "interval", everySeconds: 3600 })).toBe("Hourly");
    expect(formatCadenceLong({ type: "interval", everySeconds: 7200 })).toBe("Every 2 hours");
    expect(formatCadenceLong({ type: "interval", everySeconds: 90 })).toBe("Every 90 seconds");
    expect(formatCadenceLong({ type: "daily", timeOfDay: "09:00", timezone: "Europe/Rome" })).toBe(
      "Daily at 9:00",
    );
  });

  it("phrases the next-run countdown with pluralized units", () => {
    const now = Date.parse("2026-06-19T00:00:00.000Z");
    expect(formatNextRun("2026-06-19T00:00:30.000Z", now)).toBe("now");
    expect(formatNextRun("2026-06-18T23:00:00.000Z", now)).toBe("now");
    expect(formatNextRun("2026-06-19T00:01:30.000Z", now)).toBe("in 2 minutes");
    expect(formatNextRun("2026-06-19T00:59:00.000Z", now)).toBe("in 59 minutes");
    expect(formatNextRun("2026-06-19T09:00:00.000Z", now)).toBe("in 9 hours");
    expect(formatNextRun("2026-06-22T00:00:00.000Z", now)).toBe("in 3 days");
    expect(formatNextRun(null, now)).toBeNull();
    expect(formatNextRun("not-a-date", now)).toBeNull();
  });

  it("labels only badly-ended or approval-blocked runs as needing attention", () => {
    expect(automationAttentionLabel(runWith({ status: "failed" }))).toBe("Last run failed");
    expect(automationAttentionLabel(runWith({ status: "cancelled" }))).toBe("Last run cancelled");
    expect(automationAttentionLabel(runWith({ status: "interrupted" }))).toBe(
      "Last run interrupted",
    );
    expect(automationAttentionLabel(runWith({ status: "waiting-for-approval" }))).toBe(
      "Waiting for approval",
    );
    expect(automationAttentionLabel(runWith({ status: "succeeded" }))).toBeNull();
    expect(automationAttentionLabel(runWith({ status: "running" }))).toBeNull();
    expect(automationAttentionLabel(runWith({ status: "skipped" }))).toBeNull();
  });

  it.each([
    ["pending", false],
    ["claimed", false],
    ["running", false],
    ["waiting-for-approval", false],
    ["pending", true],
    ["claimed", true],
    ["running", true],
    ["waiting-for-approval", true],
  ] as const)("shows a live icon for %s runs when enabled is %s", (status, enabled) => {
    expect(automationListRowIcon(definitionWith({ enabled }), runWith({ status })).name).toBe(
      "loading-circle",
    );
  });

  it.each([
    {
      label: "paused without a live run",
      definition: definitionWith({ enabled: false }),
      run: runWith({ status: "succeeded" }),
      icon: "pause",
    },
    {
      label: "successful",
      definition: baseDefinition,
      run: runWith({ status: "succeeded" }),
      icon: "circle-check",
    },
    {
      label: "failed",
      definition: baseDefinition,
      run: runWith({ status: "failed" }),
      icon: "exclamation-circle",
    },
    {
      label: "cancelled",
      definition: baseDefinition,
      run: runWith({ status: "cancelled" }),
      icon: "exclamation-circle",
    },
    {
      label: "interrupted",
      definition: baseDefinition,
      run: runWith({ status: "interrupted" }),
      icon: "exclamation-circle",
    },
    {
      label: "scheduled without a run",
      definition: baseDefinition,
      run: null,
      icon: "clock",
    },
    {
      label: "idle without a next run",
      definition: definitionWith({ nextRunAt: null }),
      run: null,
      icon: "circle-placeholder-on",
    },
  ])("maps $label automation rows to $icon", ({ definition, run, icon }) => {
    expect(automationListRowIcon(definition, run).name).toBe(icon);
  });

  it("counts only unread unarchived triage runs", () => {
    const unresolved = runWith({ id: runId("run-unresolved") });
    const read = runWith({
      id: runId("run-read"),
      result: { ...baseRun.result!, unread: false },
    });
    const archived = runWith({
      id: runId("run-archived"),
      result: { ...baseRun.result!, archivedAt: "2026-06-19T10:05:00.000Z" },
    });
    const noResult = runWith({ id: runId("run-no-result"), result: null });
    const failedWithoutResult = runWith({
      id: runId("run-failed-no-result"),
      status: "failed",
      result: null,
    });

    const runs = [unresolved, read, archived, noResult, failedWithoutResult];

    expect(unresolvedTriageRuns(runs).map((run) => run.id)).toEqual([
      "run-unresolved",
      "run-failed-no-result",
    ]);
    expect(automationAttentionCount(runs)).toBe(2);
    expect(allVisibleTriageRuns(runs).map((run) => run.id)).toEqual([
      "run-unresolved",
      "run-read",
      "run-failed-no-result",
    ]);
  });

  it("keeps silent successful runs in history without counting them for attention", () => {
    const silent = runWith({
      id: runId("run-silent"),
      result: {
        ...baseRun.result!,
        decision: "silent",
        unread: false,
      },
    });

    expect(unresolvedTriageRuns([silent])).toEqual([]);
    expect(automationAttentionCount([silent])).toBe(0);
    expect(allVisibleTriageRuns([silent])).toEqual([silent]);
  });

  it("does not surface a reported result before its run finishes", () => {
    const running = runWith({
      status: "running",
      finishedAt: null,
      result: {
        ...baseRun.result!,
        decision: "notify",
        unread: true,
      },
    });

    expect(isTriageRun(running)).toBe(false);
    expect(unresolvedTriageRuns([running])).toEqual([]);
    expect(allVisibleTriageRuns([running])).toEqual([]);
  });

  it("allows cancelling active and waiting runs only", () => {
    expect(canCancelAutomationRun(runWith({ status: "pending" }))).toBe(true);
    expect(canCancelAutomationRun(runWith({ status: "running" }))).toBe(true);
    expect(canCancelAutomationRun(runWith({ status: "waiting-for-approval" }))).toBe(true);
    expect(canCancelAutomationRun(runWith({ status: "succeeded" }))).toBe(false);
    expect(canCancelAutomationRun(runWith({ status: "cancelled" }))).toBe(false);
  });

  it("uses human labels for resultless and unknown-result runs", () => {
    expect(runResultSummary(runWith({ result: null, status: "waiting-for-approval" }))).toBe(
      "Waiting for approval",
    );
    expect(
      runResultSummary(
        runWith({
          result: { ...baseRun.result!, summary: null, outcome: "unknown" },
          status: "succeeded",
        }),
      ),
    ).toBe("Completed; open the thread for the reply");
  });

  it("exposes the structured automation result title", () => {
    expect(
      runResultTitle(
        runWith({
          result: {
            ...baseRun.result!,
            title: "Dependency updates available",
          },
        }),
      ),
    ).toBe("Dependency updates available");
    expect(runResultTitle(runWith({ result: { ...baseRun.result!, title: "  " } }))).toBeNull();
  });

  it("round-trips one-shot datetimes through datetime-local values", () => {
    const runAt = "2026-06-19T10:00:00.000Z";

    expect(isoFromDatetimeLocal(datetimeLocalFromIso(runAt))).toBe(runAt);
  });

  it("preserves one-shot datetime seconds through datetime-local values", () => {
    const runAt = "2026-06-19T10:00:15.000Z";

    expect(isoFromDatetimeLocal(datetimeLocalFromIso(runAt))).toBe(runAt);
  });

  it("preserves sub-minute custom intervals through the form state", () => {
    const form = applyScheduleToForm(formFromDefinition(null, "project-1"), {
      type: "interval",
      everySeconds: 15,
    });

    expect(form.intervalAmount).toBe("15");
    expect(form.intervalUnit).toBe("seconds");
    expect(scheduleFromForm(form)).toEqual({ type: "interval", everySeconds: 15 });
  });

  it("preserves non-minute interval cadences through the form state", () => {
    const form = applyScheduleToForm(formFromDefinition(null, "project-1"), {
      type: "interval",
      everySeconds: 90,
    });

    expect(form.intervalAmount).toBe("90");
    expect(form.intervalUnit).toBe("seconds");
    expect(scheduleFromForm(form)).toEqual({ type: "interval", everySeconds: 90 });
  });

  it("labels non-minute interval cadences without rounding", () => {
    const schedule = { type: "interval", everySeconds: 90 } as const;

    expect(formatSchedule(schedule)).toBe("Every 90 sec");
    expect(formatCadence(schedule)).toBe("Every 90s");
  });

  it("requires a hard iteration cap for sub-minute interval forms", () => {
    const form = {
      ...applyScheduleToForm(formFromDefinition(null, "project-1"), {
        type: "interval",
        everySeconds: 15,
      }),
      name: "Say hi",
      prompt: "Say hi.",
    };
    const cappedForm = { ...form, maxIterations: "10" };

    expect(automationFastIntervalLimitMessage(form)).toBe(
      "Intervals under one minute need max iterations set to 10 runs or fewer.",
    );
    expect(isFormSubmittable(form)).toBe(false);
    expect(automationFastIntervalLimitMessage(cappedForm)).toBeNull();
    expect(isFormSubmittable(cappedForm)).toBe(true);
  });

  it("keeps custom max-iteration caps visible in picker options", () => {
    expect(maxIterationOptions("3")[0]).toEqual({ value: "3", label: "3 runs" });
    expect(maxIterationOptions(10)[0]).toEqual({ value: "", label: "Unlimited" });
  });

  it("refreshes the default model when the current model came from the old project", () => {
    const projects = [
      {
        id: projectId("project-old"),
        defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
      },
      {
        id: projectId("project-new"),
        defaultModelSelection: { provider: "claudeAgent", model: "sonnet" },
      },
    ] as Parameters<typeof modelSelectionForProjectChange>[0];

    expect(
      modelSelectionForProjectChange(projects, "project-old", "project-new", {
        provider: "codex",
        model: "gpt-5-codex",
      }),
    ).toEqual({ provider: "claudeAgent", model: "sonnet" });
  });

  it("preserves an explicitly chosen model when switching projects", () => {
    const projects = [
      {
        id: projectId("project-old"),
        defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
      },
      {
        id: projectId("project-new"),
        defaultModelSelection: { provider: "claudeAgent", model: "sonnet" },
      },
    ] as Parameters<typeof modelSelectionForProjectChange>[0];

    expect(
      modelSelectionForProjectChange(projects, "project-old", "project-new", {
        provider: "cursor",
        model: "cursor-default",
      }),
    ).toEqual({ provider: "cursor", model: "cursor-default" });
  });

  it("preserves timezone when changing weekly day and time", () => {
    const schedule = {
      type: "weekly",
      dayOfWeek: 1,
      timeOfDay: "09:30",
      timezone: "Europe/Rome",
    } as const;

    expect(updateWeeklyScheduleDay(schedule, 5)).toEqual({
      type: "weekly",
      dayOfWeek: 5,
      timeOfDay: "09:30",
      timezone: "Europe/Rome",
    });
    expect(updateWeeklyScheduleTime(schedule, "14:45")).toEqual({
      type: "weekly",
      dayOfWeek: 1,
      timeOfDay: "14:45",
      timezone: "Europe/Rome",
    });
  });

  it("preserves legacy UTC semantics for stored wall-clock schedules without timezone", () => {
    const form = formFromDefinition(
      definitionWith({
        schedule: { type: "daily", timeOfDay: "09:00" },
      }),
      "project-1",
    );

    expect(form.timezone).toBe("UTC");
    expect(scheduleFromForm(form)).toEqual({
      type: "daily",
      timeOfDay: "09:00",
      timezone: "UTC",
    });
  });

  it("requires timezone text for timezone-based schedules", () => {
    const form = {
      ...formFromDefinition(null, "project-1"),
      name: "Check status",
      prompt: "Check status",
      timezone: "",
    };

    expect(isFormSubmittable(form)).toBe(false);
    expect(isFormSubmittable({ ...form, timezone: "UTC" })).toBe(true);
  });

  it("serializes heartbeat stop clauses as completion policies", () => {
    const form = {
      ...formFromDefinition(null, "project-1"),
      name: "Watch PR",
      prompt: "Check the PR.",
      mode: "heartbeat" as const,
      targetThreadId: "thread-1",
      stopWhen: "the PR is ready to merge",
    };

    expect(createInputFromForm(form).completionPolicy).toEqual({
      type: "ai-evaluated",
      stopWhen: "the PR is ready to merge",
      confidenceThreshold: DEFAULT_AUTOMATION_STOP_CONFIDENCE_THRESHOLD,
    });
  });

  it("serializes standalone max iterations when chat parsing supplies a run limit", () => {
    const form = {
      ...formFromDefinition(null, "project-1"),
      name: "Say hi",
      prompt: "Say hi.",
      mode: "standalone" as const,
      maxIterations: "3",
    };

    expect(createInputFromForm(form)).toMatchObject({
      mode: "standalone",
      maxIterations: 3,
      completionPolicy: { type: "none" },
    });
  });

  it("round-trips the notification policy through form payloads", () => {
    const form = {
      ...formFromDefinition(
        definitionWith({ notificationPolicy: "failed-runs-only" }),
        "project-1",
      ),
      name: "Notify on failure",
      prompt: "Check the build.",
    };

    expect(form.notificationPolicy).toBe("failed-runs-only");
    expect(createInputFromForm(form).notificationPolicy).toBe("failed-runs-only");
  });

  it("serializes composer source thread provenance on create inputs", () => {
    const form = {
      ...formFromDefinition(null, "project-1"),
      name: "Say hi",
      prompt: "Say hi.",
    };

    expect(
      createInputFromForm(form, undefined, undefined, threadId("thread-source")),
    ).toMatchObject({
      sourceThreadId: "thread-source",
    });
  });

  it("preserves saved provider options when editing without changing models", () => {
    const savedProviderOptions: ProviderStartOptions = {
      opencode: { binaryPath: "/old/opencode", serverUrl: "http://old.example" },
    };
    const currentProviderOptions: ProviderStartOptions = {
      opencode: { binaryPath: "/new/opencode", serverUrl: "http://new.example" },
    };
    const definition = definitionWith({
      modelSelection: { provider: "opencode", model: "openai/gpt-5" },
      providerOptions: savedProviderOptions,
    });
    const form = formFromDefinition(definition, "project-1");

    expect(
      providerOptionsForAutomationModelSelection(
        definition,
        form.modelSelection,
        currentProviderOptions,
      ),
    ).toEqual(savedProviderOptions);
  });

  it("uses current provider options when an automation edit changes models", () => {
    const savedProviderOptions: ProviderStartOptions = {
      opencode: { binaryPath: "/old/opencode", serverUrl: "http://old.example" },
    };
    const currentProviderOptions: ProviderStartOptions = {
      cursor: { binaryPath: "/current/cursor", apiEndpoint: "http://cursor.example" },
    };
    const definition = definitionWith({
      modelSelection: { provider: "opencode", model: "openai/gpt-5" },
      providerOptions: savedProviderOptions,
    });
    const nextModelSelection = { provider: "cursor" as const, model: "composer-2" };

    expect(
      providerOptionsForAutomationModelSelection(
        definition,
        nextModelSelection,
        currentProviderOptions,
      ),
    ).toEqual(currentProviderOptions);
  });

  it("preserves saved provider options when only model capability options change", () => {
    const savedProviderOptions: ProviderStartOptions = {
      codex: { binaryPath: "/old/codex", homePath: "/old/home" },
    };
    const currentProviderOptions: ProviderStartOptions = {
      codex: { binaryPath: "/new/codex", homePath: "/new/home" },
    };
    const definition = definitionWith({
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
        options: { reasoningEffort: "medium" },
      },
      providerOptions: savedProviderOptions,
    });

    expect(
      providerOptionsForAutomationModelSelection(
        definition,
        {
          provider: "codex",
          model: "gpt-5-codex",
          options: { reasoningEffort: "high" },
        },
        currentProviderOptions,
      ),
    ).toEqual(savedProviderOptions);
  });

  it("clears stale provider options when an automation edit changes models without current options", () => {
    const definition = definitionWith({
      modelSelection: { provider: "opencode", model: "openai/gpt-5" },
      providerOptions: {
        opencode: { binaryPath: "/old/opencode", serverUrl: "http://old.example" },
      },
    });

    expect(
      providerOptionsForAutomationModelSelection(definition, {
        provider: "cursor",
        model: "composer-2",
      }),
    ).toEqual({});
  });

  it("keeps a newer run update when an older automation snapshot arrives later", () => {
    const staleRun = runWith({
      id: runId("run-cache-race"),
      result: { ...baseRun.result!, unread: true },
      updatedAt: "2026-06-19T10:01:00.000Z",
    });
    const newerRun = runWith({
      ...staleRun,
      result: { ...baseRun.result!, unread: false },
      updatedAt: "2026-06-19T10:02:00.000Z",
    });

    const afterLiveUpdate = applyAutomationEvent(
      { definitions: [baseDefinition], runs: [staleRun] },
      { type: "run-upserted", run: newerRun },
    );
    const afterLateSnapshot = applyAutomationEvent(afterLiveUpdate, {
      type: "snapshot",
      definitions: [baseDefinition],
      runs: [staleRun],
    });

    expect(afterLateSnapshot.runs.find((run) => run.id === newerRun.id)?.result?.unread).toBe(
      false,
    );
  });

  it("keeps a newer run update when an older live event arrives later", () => {
    const staleRun = runWith({
      id: runId("run-live-cache-race"),
      result: { ...baseRun.result!, unread: true },
      updatedAt: "2026-06-19T10:01:00.000Z",
    });
    const newerRun = runWith({
      ...staleRun,
      result: { ...baseRun.result!, unread: false },
      updatedAt: "2026-06-19T10:02:00.000Z",
    });

    const afterLateLiveEvent = applyAutomationEvent(
      { definitions: [baseDefinition], runs: [newerRun] },
      { type: "run-upserted", run: staleRun },
    );

    expect(afterLateLiveEvent.runs.find((run) => run.id === newerRun.id)?.result?.unread).toBe(
      false,
    );
  });

  it("applies equal-timestamp live run updates", () => {
    const firstRun = runWith({
      id: runId("run-live-cache-equal"),
      result: { ...baseRun.result!, unread: true, archivedAt: null },
      updatedAt: "2026-06-19T10:02:00.000Z",
    });
    const followUpRun = runWith({
      ...firstRun,
      result: { ...baseRun.result!, unread: false, archivedAt: "2026-06-19T10:02:00.000Z" },
    });

    const afterLiveEvent = applyAutomationEvent(
      { definitions: [baseDefinition], runs: [firstRun] },
      { type: "run-upserted", run: followUpRun },
    );

    expect(afterLiveEvent.runs.find((run) => run.id === followUpRun.id)?.result).toMatchObject({
      unread: false,
      archivedAt: "2026-06-19T10:02:00.000Z",
    });
  });

  it("keeps cached run state when an equal-timestamp snapshot arrives later", () => {
    const firstRun = runWith({
      id: runId("run-snapshot-cache-equal"),
      result: { ...baseRun.result!, unread: true, archivedAt: null },
      updatedAt: "2026-06-19T10:02:00.000Z",
    });
    const snapshotRun = runWith({
      ...firstRun,
      result: { ...baseRun.result!, unread: false, archivedAt: "2026-06-19T10:02:00.000Z" },
    });

    const afterSnapshot = applyAutomationEvent(
      { definitions: [baseDefinition], runs: [firstRun] },
      { type: "snapshot", definitions: [baseDefinition], runs: [snapshotRun] },
    );

    expect(afterSnapshot.runs.find((run) => run.id === snapshotRun.id)?.result).toMatchObject({
      unread: true,
      archivedAt: null,
    });
  });

  it("keeps a newer definition update when an older live event arrives later", () => {
    const staleDefinition = definitionWith({
      id: automationId("automation-live-cache-race"),
      name: "Old name",
      updatedAt: "2026-06-19T10:01:00.000Z",
    });
    const newerDefinition = definitionWith({
      ...staleDefinition,
      name: "New name",
      updatedAt: "2026-06-19T10:02:00.000Z",
    });

    const afterLateLiveEvent = applyAutomationEvent(
      { definitions: [newerDefinition], runs: [] },
      { type: "definition-upserted", definition: staleDefinition },
    );

    expect(
      afterLateLiveEvent.definitions.find((definition) => definition.id === newerDefinition.id)
        ?.name,
    ).toBe("New name");
  });

  it("keeps cached definition state when an equal-timestamp snapshot arrives later", () => {
    const cachedDefinition = definitionWith({
      id: automationId("automation-snapshot-cache-equal"),
      name: "Updated name",
      updatedAt: "2026-06-19T10:02:00.000Z",
    });
    const snapshotDefinition = definitionWith({
      ...cachedDefinition,
      name: "Older snapshot name",
    });

    const afterSnapshot = applyAutomationEvent(
      { definitions: [cachedDefinition], runs: [] },
      { type: "snapshot", definitions: [snapshotDefinition], runs: [] },
    );

    expect(
      afterSnapshot.definitions.find((definition) => definition.id === cachedDefinition.id)?.name,
    ).toBe("Updated name");
  });

  it("does not resurrect a deleted automation from a late snapshot", () => {
    const deletedDefinition = definitionWith({
      id: automationId("automation-deleted-cache-race"),
    });
    const deletedRun = runWith({
      id: runId("run-deleted-cache-race"),
      automationId: deletedDefinition.id,
    });

    const afterDelete = applyAutomationEvent(
      { definitions: [deletedDefinition], runs: [deletedRun] },
      { type: "definition-deleted", automationId: deletedDefinition.id },
    );
    const afterLateSnapshot = applyAutomationEvent(afterDelete, {
      type: "snapshot",
      definitions: [deletedDefinition],
      runs: [deletedRun],
    });

    expect(afterLateSnapshot.definitions).toEqual([]);
    expect(afterLateSnapshot.runs).toEqual([]);
  });

  it("drops definitions and runs that disappear from a reconnect snapshot", () => {
    const deletedDefinition = definitionWith({
      id: automationId("automation-missed-delete"),
    });
    const deletedRun = runWith({
      id: runId("run-missed-delete"),
      automationId: deletedDefinition.id,
    });

    const afterReconnectSnapshot = applyAutomationEvent(
      { definitions: [deletedDefinition], runs: [deletedRun] },
      {
        type: "snapshot",
        definitions: [],
        runs: [],
      },
    );

    expect(afterReconnectSnapshot.definitions).toEqual([]);
    expect(afterReconnectSnapshot.runs).toEqual([]);
  });

  it("drops runs that disappear from a reconnect snapshot for an existing definition", () => {
    const definition = definitionWith({
      id: automationId("automation-existing-definition"),
    });
    const deletedRun = runWith({
      id: runId("run-missed-delete-existing-definition"),
      automationId: definition.id,
    });

    const afterReconnectSnapshot = applyAutomationEvent(
      { definitions: [definition], runs: [deletedRun] },
      {
        type: "snapshot",
        definitions: [definition],
        runs: [],
      },
    );

    expect(afterReconnectSnapshot.definitions).toEqual([definition]);
    expect(afterReconnectSnapshot.runs).toEqual([]);
  });

  it("keeps newer live memory when an older snapshot arrives later", () => {
    const staleMemory = {
      automationId: baseDefinition.id,
      content: "Older persisted context.",
      updatedAt: "2026-06-19T10:02:00.000Z",
    };
    const newerMemory = {
      ...staleMemory,
      content: "Newest live context.",
      updatedAt: "2026-06-19T10:03:00.000Z",
    };
    const afterLiveUpdate = applyAutomationEvent(
      { definitions: [baseDefinition], runs: [], memories: [staleMemory] },
      { type: "memory-upserted", memory: newerMemory },
    );

    const afterLateSnapshot = applyAutomationEvent(afterLiveUpdate, {
      type: "snapshot",
      definitions: [baseDefinition],
      runs: [],
      memories: [staleMemory],
    });

    expect(afterLateSnapshot.memories).toEqual([newerMemory]);
  });

  it("keeps live memory omitted by a snapshot while its automation remains visible", () => {
    const liveMemory = {
      automationId: baseDefinition.id,
      content: "Memory written after the snapshot query began.",
      updatedAt: "2026-06-19T10:03:00.000Z",
    };

    const afterLateSnapshot = applyAutomationEvent(
      { definitions: [baseDefinition], runs: [], memories: [liveMemory] },
      {
        type: "snapshot",
        definitions: [baseDefinition],
        runs: [],
        memories: [],
      },
    );

    expect(afterLateSnapshot.memories).toEqual([liveMemory]);
  });

  it("applies persistent-memory stream updates without requiring a new snapshot", () => {
    const memory = {
      automationId: baseDefinition.id,
      content: "Remember the latest successful SHA.",
      updatedAt: "2026-06-19T10:03:00.000Z",
    };

    const updated = applyAutomationEvent(
      { definitions: [baseDefinition], runs: [], memories: [] },
      { type: "memory-upserted", memory },
    );

    expect(updated.memories).toEqual([memory]);
  });
});

describe("rollbackAutomationDefinitionPatch", () => {
  it("restores only the failed patch's fields, keeping a concurrent edit's merge intact", () => {
    // The name patch failed while a prompt patch (still in flight) had already merged
    // optimistically. Rolling back the name must not also revert the prompt.
    const current = {
      definitions: [definitionWith({ name: "Optimistic name", prompt: "Optimistic prompt." })],
      runs: [],
      memories: [],
    };

    const rolledBack = rollbackAutomationDefinitionPatch(
      current,
      { id: baseDefinition.id, name: "Optimistic name" },
      baseDefinition,
    );

    expect(rolledBack.definitions[0]).toMatchObject({
      name: baseDefinition.name,
      prompt: "Optimistic prompt.",
    });
  });

  it("does not overwrite a newer edit to the same field when an older patch fails", () => {
    const current = {
      definitions: [definitionWith({ name: "Newest name" })],
      runs: [],
      memories: [],
    };

    const rolledBack = rollbackAutomationDefinitionPatch(
      current,
      { id: baseDefinition.id, name: "Older optimistic name" },
      baseDefinition,
    );

    expect(rolledBack.definitions[0]?.name).toBe("Newest name");
  });

  it("removes input-only keys the definition never had instead of restoring them", () => {
    const merged = {
      ...definitionWith({}),
      stopOnError: true,
    } as AutomationDefinition;
    const current = { definitions: [merged], runs: [], memories: [] };

    const rolledBack = rollbackAutomationDefinitionPatch(
      current,
      { id: baseDefinition.id, stopOnError: true },
      baseDefinition,
    );

    expect("stopOnError" in rolledBack.definitions[0]!).toBe(false);
  });

  it("leaves other definitions untouched", () => {
    const other = definitionWith({ id: automationId("automation-2"), name: "Other" });
    const current = {
      definitions: [definitionWith({ name: "Optimistic name" }), other],
      runs: [],
      memories: [],
    };

    const rolledBack = rollbackAutomationDefinitionPatch(
      current,
      { id: baseDefinition.id, name: "Optimistic name" },
      baseDefinition,
    );

    expect(rolledBack.definitions[1]).toBe(other);
  });
});

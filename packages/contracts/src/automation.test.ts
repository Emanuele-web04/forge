import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  AutomationCreateInput,
  AutomationDefinition,
  AutomationCompletionPolicy,
  AutomationRun,
  AutomationRunResult,
  AutomationSchedule,
  AutomationRunStatus,
  AutomationStreamEvent,
  DEFAULT_AUTOMATION_RUNTIME_MODE,
  DEFAULT_AUTOMATION_STOP_CONFIDENCE_THRESHOLD,
} from "./automation";

const decode = <S extends Schema.Top>(
  schema: S,
  input: unknown,
): Effect.Effect<Schema.Schema.Type<S>, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(schema as never)(input) as Effect.Effect<
    Schema.Schema.Type<S>,
    Schema.SchemaError,
    never
  >;

it.effect("defaults automation runtime mode to approval-required", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(AutomationCreateInput, {
      name: "Nightly maintenance",
      projectId: "project-1",
      prompt: "Check for stale dependencies.",
      schedule: { type: "manual" },
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
    });

    assert.strictEqual(DEFAULT_AUTOMATION_RUNTIME_MODE, "approval-required");
    assert.strictEqual(parsed.runtimeMode, "approval-required");
    assert.strictEqual(parsed.minimumIntervalSeconds, 60);
    assert.strictEqual(parsed.maxRuntimeSeconds, 60 * 60);
    assert.deepStrictEqual(parsed.retryPolicy, { type: "none" });
    assert.strictEqual(parsed.misfirePolicy, "coalesce");
    assert.deepStrictEqual(parsed.completionPolicy, { type: "none" });
    assert.deepStrictEqual(parsed.acknowledgedRisks, []);
    assert.isNull(parsed.proposalState);
    assert.strictEqual(parsed.notificationPolicy, "all");
    assert.strictEqual(parsed.heartbeatCooldownSeconds, 60);
  }),
);

it.effect("rejects debug interaction mode for automations", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decode(AutomationCreateInput, {
        name: "Debug recurring failures",
        projectId: "project-1",
        prompt: "Investigate the latest failure.",
        schedule: { type: "manual" },
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: "debug",
      }),
    );

    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("decodes legacy automation definitions without completion policies", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(AutomationDefinition, {
      id: "automation-legacy",
      projectId: "project-1",
      sourceThreadId: null,
      name: "Legacy automation",
      prompt: "Check the PR.",
      schedule: { type: "manual" },
      enabled: true,
      nextRunAt: null,
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      worktreeMode: "auto",
      mode: "heartbeat",
      targetThreadId: "thread-1",
      maxIterations: null,
      stopOnError: true,
      minimumIntervalSeconds: 60,
      maxRuntimeSeconds: 3600,
      retryPolicy: { type: "none" },
      misfirePolicy: "coalesce",
      acknowledgedRisks: [],
      iterationCount: 0,
      createdAt: "2026-06-16T10:00:00.000Z",
      updatedAt: "2026-06-16T10:00:00.000Z",
      archivedAt: null,
    });

    assert.deepStrictEqual(parsed.completionPolicy, { type: "none" });
    assert.strictEqual(parsed.completionPolicyVersion, 0);
    assert.strictEqual(parsed.completionPolicyUpdatedAt, "1970-01-01T00:00:00.000Z");
    assert.isNull(parsed.proposalState);
    assert.strictEqual(parsed.notificationPolicy, "all");
    assert.strictEqual(parsed.heartbeatCooldownSeconds, 60);
  }),
);

it.effect("accepts AI-evaluated automation completion policies", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(AutomationCompletionPolicy, {
      type: "ai-evaluated",
      stopWhen: "the PR is ready to merge",
      confidenceThreshold: DEFAULT_AUTOMATION_STOP_CONFIDENCE_THRESHOLD,
    });

    assert.strictEqual(parsed.type, "ai-evaluated");
    if (parsed.type !== "ai-evaluated") {
      assert.fail("Expected AI-evaluated completion policy.");
    }
    assert.strictEqual(parsed.confidenceThreshold, DEFAULT_AUTOMATION_STOP_CONFIDENCE_THRESHOLD);
  }),
);

it.effect("accepts automation runs with immutable permission snapshots", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(AutomationRun, {
      id: "run-1",
      automationId: "automation-1",
      projectId: "project-1",
      threadId: "thread-1",
      trigger: { type: "manual" },
      status: "running",
      scheduledFor: "2026-06-16T10:00:00.000Z",
      claimedBy: "server-1",
      claimedAt: "2026-06-16T10:00:01.000Z",
      leaseExpiresAt: "2026-06-16T10:01:01.000Z",
      startedAt: "2026-06-16T10:00:02.000Z",
      finishedAt: null,
      threadCreateCommandId: "automation:run-1:thread-create",
      turnStartCommandId: "automation:run-1:turn-start",
      messageId: "automation:run-1:message",
      error: null,
      result: null,
      permissionSnapshot: {
        provider: "codex",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        completionPolicyVersion: 7,
        iterationNumber: 3,
        runtimeMode: "approval-required",
        interactionMode: "default",
        worktreeMode: "worktree",
        allowedCapabilities: ["send-turn"],
        createdAt: "2026-06-16T10:00:00.000Z",
      },
      createdAt: "2026-06-16T10:00:00.000Z",
      updatedAt: "2026-06-16T10:00:02.000Z",
    });

    assert.strictEqual(parsed.permissionSnapshot.runtimeMode, "approval-required");
    assert.strictEqual(parsed.permissionSnapshot.completionPolicyVersion, 7);
    assert.strictEqual(parsed.permissionSnapshot.iterationNumber, 3);
    assert.strictEqual(parsed.status, "running");
    assert.isNull(parsed.deferredUntil);
  }),
);

it.effect("accepts one-shot automation schedules", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(AutomationSchedule, {
      type: "once",
      runAt: "2026-06-19T10:00:15.000Z",
    });

    assert.strictEqual(parsed.type, "once");
  }),
);

it.effect("rejects invalid one-shot timestamps", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decode(AutomationSchedule, {
        type: "once",
        runAt: "tomorrow",
      }),
    );

    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("accepts legacy UTC and timezone-aware wall-clock schedules", () =>
  Effect.gen(function* () {
    const legacy = yield* decode(AutomationSchedule, {
      type: "daily",
      timeOfDay: "09:00",
    });
    const timezoneAware = yield* decode(AutomationSchedule, {
      type: "weekly",
      dayOfWeek: 1,
      timeOfDay: "09:00",
      timezone: "Europe/Rome",
    });
    const cron = yield* decode(AutomationSchedule, {
      type: "cron",
      expression: "0 9 * * *",
      timezone: "Europe/Rome",
    });

    assert.strictEqual(legacy.type, "daily");
    assert.strictEqual(timezoneAware.type, "weekly");
    assert.strictEqual(cron.type, "cron");
  }),
);

it.effect("accepts typed automation run results", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(AutomationRunResult, {
      outcome: "needs-attention",
      summary: "Approval required.",
      severity: "warning",
      unread: true,
      archivedAt: null,
    });

    assert.strictEqual(parsed.outcome, "needs-attention");
    assert.strictEqual(parsed.unread, true);
  }),
);

it.effect("accepts structured automation notify and silent decisions", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(AutomationRunResult, {
      outcome: "unknown",
      title: "Build is healthy",
      summary: "No action is required.",
      decision: "silent",
      unread: false,
      archivedAt: null,
    });

    assert.strictEqual(parsed.title, "Build is healthy");
    assert.strictEqual(parsed.decision, "silent");
    assert.strictEqual(parsed.unread, false);
  }),
);

it.effect("accepts automation run result completion evaluations", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(AutomationRunResult, {
      outcome: "no-findings",
      summary: "Stopped: PR is ready.",
      severity: "info",
      unread: true,
      archivedAt: null,
      completionEvaluation: {
        stopMatched: true,
        confidence: 0.94,
        reason: "The assistant says the PR is ready.",
      },
    });

    assert.strictEqual(parsed.completionEvaluation?.stopMatched, true);
  }),
);

it.effect("rejects invalid automation result outcomes", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decode(AutomationRunResult, {
        outcome: "surprise",
        summary: "Nope",
        unread: true,
        archivedAt: null,
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("rejects unknown automation run status values", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(decode(AutomationRunStatus, "unknown"));
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("accepts automation stream run updates", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(AutomationStreamEvent, {
      type: "run-upserted",
      run: {
        id: "run-1",
        automationId: "automation-1",
        projectId: "project-1",
        threadId: null,
        trigger: { type: "scheduled" },
        status: "pending",
        scheduledFor: "2026-06-16T10:00:00.000Z",
        claimedBy: null,
        claimedAt: null,
        leaseExpiresAt: null,
        startedAt: null,
        finishedAt: null,
        threadCreateCommandId: null,
        turnStartCommandId: null,
        messageId: null,
        error: null,
        result: null,
        permissionSnapshot: {
          provider: "codex",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          worktreeMode: "worktree",
          allowedCapabilities: ["send-turn"],
          createdAt: "2026-06-16T10:00:00.000Z",
        },
        createdAt: "2026-06-16T10:00:00.000Z",
        updatedAt: "2026-06-16T10:00:00.000Z",
      },
    });

    assert.strictEqual(parsed.type, "run-upserted");
  }),
);

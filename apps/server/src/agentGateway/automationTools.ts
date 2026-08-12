import {
  AutomationId,
  AutomationSchedule,
  DEFAULT_AUTOMATION_FAST_INTERVAL_MAX_ITERATIONS,
  DEFAULT_AUTOMATION_HEARTBEAT_COOLDOWN_SECONDS,
  DEFAULT_AUTOMATION_STOP_CONFIDENCE_THRESHOLD,
  ProjectId,
  ThreadId,
  TurnId,
  type AutomationCompletionPolicy,
  type AutomationDefinition,
  type AutomationNotificationPolicy,
  type AutomationSchedule as AutomationScheduleType,
  type AutomationWorktreeMode,
  type OrchestrationThreadShell,
} from "@synara/contracts";
import {
  automationContinuesThread,
  automationRequiresTargetThread,
} from "@synara/shared/automationMode";
import { Effect, Option, Schema } from "effect";

import type { AutomationServiceShape } from "../automation/Services/AutomationService.ts";
import { automationMemoryForEnvelope } from "../automation/runEnvelope.ts";
import { computeAutomationScheduleSpacingSeconds } from "../automation/schedule.ts";
import {
  AUTOMATION_AUTHORING_GUIDANCE,
  AUTOMATION_NAME_AUTHORING_GUIDANCE,
  AUTOMATION_PROMPT_AUTHORING_GUIDANCE,
} from "./automationAuthoringGuidance.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import {
  ToolInputError,
  errorText,
  readBooleanArg,
  readNumberArg,
  readRecordArg,
  readStringArg,
} from "./toolInput.ts";
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  type ToolEntry,
} from "./toolRuntime.ts";

const HEARTBEAT_DEFAULT_INTERVAL_MINUTES = 5;
const HEARTBEAT_DEFAULT_MAX_ITERATIONS = 50;
const AUTOMATION_VIEW_DEFAULT_RUNS = 5;
const AUTOMATION_VIEW_MAX_RUNS = 50;

const SCHEDULE_INPUT_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: {
        type: { const: "interval" },
        everySeconds: { type: "number", minimum: 1 },
      },
      required: ["type", "everySeconds"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        type: { const: "once" },
        runAt: { type: "string", format: "date-time" },
      },
      required: ["type", "runAt"],
      additionalProperties: false,
    },
    ...(["daily", "weekdays"] as const).map((type) => ({
      type: "object",
      properties: {
        type: { const: type },
        timeOfDay: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
        timezone: { type: "string" },
      },
      required: ["type", "timeOfDay"],
      additionalProperties: false,
    })),
    {
      type: "object",
      properties: {
        type: { const: "weekly" },
        dayOfWeek: { type: "number", minimum: 0, maximum: 6 },
        timeOfDay: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" },
        timezone: { type: "string" },
      },
      required: ["type", "dayOfWeek", "timeOfDay"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        type: { const: "cron" },
        expression: { type: "string" },
        timezone: { type: "string" },
      },
      required: ["type", "expression", "timezone"],
      additionalProperties: false,
    },
  ],
} as const;

const COMPLETION_POLICY_INPUT_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: { type: { const: "none" } },
      required: ["type"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        type: { const: "ai-evaluated" },
        stopWhen: { type: "string" },
        confidenceThreshold: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["type", "stopWhen"],
      additionalProperties: false,
    },
  ],
} as const;

interface AutomationToolDependencies {
  readonly automationService: AutomationServiceShape;
  readonly requireThreadShell: (
    threadId: string,
  ) => Effect.Effect<OrchestrationThreadShell, ToolInputError>;
  readonly assertCallerMayDriveThread: (
    caller: OrchestrationThreadShell,
    target: OrchestrationThreadShell,
  ) => Effect.Effect<void, ToolInputError>;
  readonly surfaceAutomationProposal: (input: {
    readonly callerThreadId: ThreadId;
    readonly definition: AutomationDefinition;
  }) => Effect.Effect<void, unknown>;
}

function decodeSchedule(args: Record<string, unknown>): AutomationScheduleType | undefined {
  const raw = readRecordArg(args, "schedule");
  if (!raw) return undefined;
  try {
    const schedule = Schema.decodeUnknownSync(AutomationSchedule)(raw);
    if (schedule.type === "manual") {
      throw new ToolInputError('Agent schedules cannot use type "manual".');
    }
    return schedule;
  } catch (error) {
    if (error instanceof ToolInputError) throw error;
    throw new ToolInputError(`Invalid automation schedule: ${errorText(error)}`);
  }
}

function decodeCompletionPolicy(
  args: Record<string, unknown>,
  required = false,
): AutomationCompletionPolicy | undefined {
  const raw = readRecordArg(args, "completionPolicy");
  if (!raw) {
    if (required) {
      throw new ToolInputError('Missing required argument "completionPolicy".');
    }
    return undefined;
  }
  const type = readStringArg(raw, "type", { required: true });
  if (type === "none") return { type: "none" };
  if (type !== "ai-evaluated") {
    throw new ToolInputError('Argument "completionPolicy.type" must be "none" or "ai-evaluated".');
  }
  return {
    type,
    stopWhen: readStringArg(raw, "stopWhen", { required: true })!,
    confidenceThreshold:
      readNumberArg(raw, "confidenceThreshold") ?? DEFAULT_AUTOMATION_STOP_CONFIDENCE_THRESHOLD,
  };
}

function readNullablePositiveInteger(
  args: Record<string, unknown>,
  name: string,
  options?: { readonly required?: boolean },
): number | null | undefined {
  const raw = args[name];
  if (raw === undefined) {
    if (options?.required) throw new ToolInputError(`Missing required argument "${name}".`);
    return undefined;
  }
  if (raw === null) return null;
  const value = readNumberArg(args, name)!;
  if (!Number.isInteger(value) || value < 1) {
    throw new ToolInputError(`Argument "${name}" must be a positive integer or null.`);
  }
  return value;
}

function readNotificationPolicy(
  args: Record<string, unknown>,
  required = false,
): AutomationNotificationPolicy | undefined {
  const raw = readStringArg(args, "notificationPolicy", { required });
  if (raw === undefined) return undefined;
  if (raw !== "all" && raw !== "failed-runs-only") {
    throw new ToolInputError('Argument "notificationPolicy" must be "all" or "failed-runs-only".');
  }
  return raw;
}

function readWorktreeMode(args: Record<string, unknown>): AutomationWorktreeMode | undefined {
  const raw = readStringArg(args, "worktreeMode");
  if (raw === undefined) return undefined;
  if (raw !== "auto" && raw !== "local" && raw !== "worktree") {
    throw new ToolInputError('Argument "worktreeMode" must be "auto", "local", or "worktree".');
  }
  return raw;
}

function readMode(args: Record<string, unknown>): AutomationDefinition["mode"] {
  // The default stays "heartbeat" for callers written before modes existed.
  const raw = readStringArg(args, "mode") ?? "heartbeat";
  if (raw !== "heartbeat" && raw !== "standalone" && raw !== "dedicated") {
    throw new ToolInputError('Argument "mode" must be "heartbeat", "standalone", or "dedicated".');
  }
  return raw;
}

function readMemoryContent(args: Record<string, unknown>): string {
  // "content" is the legacy name of "memory"; accept both so older callers keep working.
  const value = args.memory ?? args.content;
  if (typeof value !== "string") {
    throw new ToolInputError('Argument "memory" must be a string.');
  }
  return value;
}

function scheduleIsFast(schedule: AutomationScheduleType): boolean {
  const spacing = computeAutomationScheduleSpacingSeconds(schedule, new Date().toISOString());
  return spacing !== null && spacing < 60;
}

export function makeAgentGatewayAutomationTools(
  dependencies: AutomationToolDependencies,
): ReadonlyArray<ToolEntry> {
  const {
    automationService,
    requireThreadShell,
    assertCallerMayDriveThread,
    surfaceAutomationProposal,
  } = dependencies;

  const requireAutomationDefinition = (automationId: string) =>
    automationService.list({ includeArchived: true }).pipe(
      Effect.mapError((error) => new ToolInputError(errorText(error))),
      Effect.flatMap((result) => {
        const definition = result.definitions.find((entry) => entry.id === automationId);
        return definition
          ? Effect.succeed({ definition, listed: result })
          : Effect.fail(new ToolInputError(`Automation "${automationId}" was not found.`));
      }),
    );

  const assertCallerMayManageAutomation = (
    caller: OrchestrationThreadShell,
    definition: AutomationDefinition,
    context: { readonly callerThreadId: string; readonly callerTurnId: string | null },
  ) =>
    Effect.gen(function* () {
      if (definition.sourceThreadId === caller.id) return;
      // A standalone run executes in a per-run thread that matches neither source nor
      // target, so without this branch an automation could never retire itself.
      const callerRun = yield* automationService
        .resolveCallerRun({
          callerThreadId: ThreadId.makeUnsafe(context.callerThreadId),
          callerTurnId: context.callerTurnId ? TurnId.makeUnsafe(context.callerTurnId) : null,
        })
        .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
      if (Option.isSome(callerRun) && callerRun.value.automationId === definition.id) return;
      if (definition.targetThreadId) {
        const target = yield* requireThreadShell(definition.targetThreadId);
        yield* assertCallerMayDriveThread(caller, target);
        return;
      }
      return yield* Effect.fail(
        new ToolInputError(
          `Automation "${definition.id}" was not created by your thread, is not the automation that dispatched your current turn, and has no target thread you can authorize against.`,
        ),
      );
    });

  const createAutomation: ToolEntry = {
    requiredCapability: "automation:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_create_automation",
      description: `Create a heartbeat, standalone, or dedicated Synara automation. ${AUTOMATION_AUTHORING_GUIDANCE} Existing calls remain compatible: omitting mode/schedule creates a heartbeat on your thread using everyMinutes (default 5). Prefer suggested:true unless the user explicitly requested creation.`,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: AUTOMATION_NAME_AUTHORING_GUIDANCE },
          prompt: { type: "string", description: AUTOMATION_PROMPT_AUTHORING_GUIDANCE },
          mode: {
            type: "string",
            enum: ["heartbeat", "standalone", "dedicated"],
            description:
              'Where runs execute. "heartbeat" appends turns to an existing thread and waits for it to be idle — use it to drive that thread forward. "standalone" opens a fresh thread per run. "dedicated" opens one thread the automation owns and reuses it for every run, so the runs build on each other without ever writing into someone else\'s thread.',
          },
          schedule: SCHEDULE_INPUT_SCHEMA,
          everyMinutes: {
            type: "number",
            description: "Legacy interval shorthand. Cannot be combined with schedule.",
          },
          targetThreadId: {
            type: "string",
            description:
              "Thread a heartbeat automation continues; defaults to the caller. Rejected for the other modes, which create their own thread.",
          },
          projectId: {
            type: "string",
            description:
              "Project for a standalone or dedicated automation; defaults to the caller's.",
          },
          worktreeMode: { type: "string", enum: ["auto", "local", "worktree"] },
          notificationPolicy: {
            type: "string",
            enum: ["all", "failed-runs-only"],
          },
          completionPolicy: {
            ...COMPLETION_POLICY_INPUT_SCHEMA,
            description:
              'Declarative retirement rule, available in every mode. "ai-evaluated" checks stopWhen against each successful run and disables the automation when it matches, so the stop condition does not depend on the run remembering to cancel itself. Defaults to {"type":"none"}.',
          },
          heartbeatCooldownSeconds: {
            type: "number",
            minimum: 0,
            description:
              "Idle seconds required on the continued thread (excluding this automation's own runs) before a heartbeat or dedicated run may start. Defaults to min(60, schedule spacing).",
          },
          maxIterations: { type: "number", minimum: 1 },
          fastInterval: {
            type: "boolean",
            description:
              "Required to acknowledge a sub-minute schedule. Such runs remain capped at 10 iterations.",
          },
          suggested: {
            type: "boolean",
            description:
              "Persist disabled as a pending proposal and surface Accept/Dismiss actions.",
          },
        },
        required: ["name", "prompt"],
        additionalProperties: false,
      },
      annotations: { title: "Create a Synara automation", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const caller = yield* requireThreadShell(context.callerThreadId);
        const name = readStringArg(args, "name", { required: true })!;
        const prompt = readStringArg(args, "prompt", { required: true })!;
        const mode = readMode(args);
        const explicitSchedule = decodeSchedule(args);
        if (explicitSchedule && args.everyMinutes !== undefined) {
          throw new ToolInputError(
            'Arguments "schedule" and "everyMinutes" are mutually exclusive.',
          );
        }
        const everyMinutes = Math.max(
          1,
          readNumberArg(args, "everyMinutes") ?? HEARTBEAT_DEFAULT_INTERVAL_MINUTES,
        );
        const schedule =
          explicitSchedule ??
          ({
            type: "interval",
            everySeconds: Math.round(everyMinutes * 60),
          } as const);
        const fastInterval = readBooleanArg(args, "fastInterval") ?? false;
        const scheduleSpacingSeconds = computeAutomationScheduleSpacingSeconds(
          schedule,
          new Date().toISOString(),
        );
        const fastSchedule = scheduleSpacingSeconds !== null && scheduleSpacingSeconds < 60;
        if (fastSchedule && !fastInterval) {
          throw new ToolInputError(
            'Sub-minute schedules require explicit "fastInterval": true acknowledgement.',
          );
        }
        const explicitMaxIterations = readNullablePositiveInteger(args, "maxIterations");
        const maxIterations =
          explicitMaxIterations ??
          // A run that keeps appending to one thread is a loop, so it gets a default cap;
          // a fresh thread per run is a recurring task and stays unbounded.
          (fastSchedule
            ? DEFAULT_AUTOMATION_FAST_INTERVAL_MAX_ITERATIONS
            : automationContinuesThread(mode)
              ? HEARTBEAT_DEFAULT_MAX_ITERATIONS
              : null);
        const completionPolicy = decodeCompletionPolicy(args) ?? { type: "none" as const };
        const notificationPolicy = readNotificationPolicy(args) ?? "all";
        const suggested = readBooleanArg(args, "suggested") ?? false;
        // A cooldown longer than the schedule spacing would silently degrade the
        // requested cadence to cooldown cadence, so the default is capped at the spacing.
        const defaultCooldownSeconds =
          scheduleSpacingSeconds === null
            ? DEFAULT_AUTOMATION_HEARTBEAT_COOLDOWN_SECONDS
            : Math.min(
                DEFAULT_AUTOMATION_HEARTBEAT_COOLDOWN_SECONDS,
                Math.max(0, Math.floor(scheduleSpacingSeconds)),
              );
        const heartbeatCooldownSeconds =
          readNumberArg(args, "heartbeatCooldownSeconds") ?? defaultCooldownSeconds;
        if (!Number.isInteger(heartbeatCooldownSeconds) || heartbeatCooldownSeconds < 0) {
          throw new ToolInputError(
            'Argument "heartbeatCooldownSeconds" must be a non-negative integer.',
          );
        }

        let projectId: ProjectId;
        let targetThreadId: ThreadId | null;
        let worktreeMode: AutomationWorktreeMode;
        let executionThread: OrchestrationThreadShell;
        // Only heartbeat takes an existing thread. Standalone and dedicated both open their
        // own, so both configure a project and a worktree mode.
        if (automationRequiresTargetThread(mode)) {
          if (args.projectId !== undefined || args.worktreeMode !== undefined) {
            throw new ToolInputError(
              'Arguments "projectId" and "worktreeMode" cannot be combined with mode "heartbeat".',
            );
          }
          const targetId = readStringArg(args, "targetThreadId") ?? context.callerThreadId;
          const target = yield* requireThreadShell(targetId);
          if (target.id !== caller.id) {
            yield* assertCallerMayDriveThread(caller, target);
          }
          projectId = target.projectId;
          targetThreadId = target.id;
          worktreeMode = target.envMode === "worktree" ? "worktree" : "local";
          executionThread = target;
        } else {
          if (args.targetThreadId !== undefined) {
            throw new ToolInputError('Argument "targetThreadId" is heartbeat-only.');
          }
          const requestedProjectId = readStringArg(args, "projectId");
          if (requestedProjectId !== undefined && requestedProjectId !== caller.projectId) {
            throw new ToolInputError(
              `Automations with mode "${mode}" must belong to the caller's project.`,
            );
          }
          projectId = ProjectId.makeUnsafe(requestedProjectId ?? caller.projectId);
          targetThreadId = null;
          const requestedWorktreeMode = readWorktreeMode(args);
          if (caller.envMode === "worktree" && requestedWorktreeMode === "local") {
            throw new ToolInputError(
              "A worktree-isolated caller cannot create an automation on the shared local checkout.",
            );
          }
          worktreeMode =
            requestedWorktreeMode === "auto" && caller.envMode === "worktree"
              ? "worktree"
              : (requestedWorktreeMode ?? (caller.envMode === "worktree" ? "worktree" : "local"));
          executionThread = caller;
        }

        const acknowledgedRisks: Array<"full-access" | "local-checkout" | "fast-interval"> = [];
        if (executionThread.runtimeMode === "full-access") {
          acknowledgedRisks.push("full-access");
        }
        if (
          worktreeMode === "local" ||
          (worktreeMode === "auto" && caller.envMode !== "worktree")
        ) {
          acknowledgedRisks.push("local-checkout");
        }
        if (fastSchedule) acknowledgedRisks.push("fast-interval");

        const definition = yield* automationService
          .create({
            projectId,
            sourceThreadId: ThreadId.makeUnsafe(context.callerThreadId),
            name,
            prompt,
            schedule,
            enabled: !suggested,
            modelSelection: executionThread.modelSelection,
            runtimeMode: executionThread.runtimeMode,
            interactionMode: executionThread.interactionMode === "plan" ? "plan" : "default",
            mode,
            targetThreadId,
            proposalState: suggested ? "pending" : null,
            notificationPolicy,
            heartbeatCooldownSeconds,
            maxIterations,
            stopOnError: true,
            completionPolicy,
            worktreeMode,
            acknowledgedRisks,
          })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        if (suggested) {
          yield* surfaceAutomationProposal({
            callerThreadId: caller.id,
            definition,
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("automation proposal activity could not be surfaced", {
                automationId: definition.id,
                error: errorText(error),
              }),
            ),
          );
        }
        return mcpToolResultJson({
          automationId: definition.id,
          name: definition.name,
          mode: definition.mode,
          schedule: definition.schedule,
          targetThreadId: definition.targetThreadId,
          nextRunAt: definition.nextRunAt,
          maxIterations: definition.maxIterations,
          proposalState: definition.proposalState ?? null,
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const listAutomations: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "synara_list_automations",
      description:
        "List Synara automations (id, name, mode, schedule, target thread, enabled, next run).",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Only automations of this project." },
        },
        additionalProperties: false,
      },
      annotations: { title: "List Synara automations", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args) =>
      Effect.gen(function* () {
        const projectIdArg = readStringArg(args, "projectId");
        const result = yield* automationService
          .list(projectIdArg ? { projectId: ProjectId.makeUnsafe(projectIdArg) } : undefined)
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        return mcpToolResultJson({
          automations: result.definitions.map((definition) => ({
            automationId: definition.id,
            name: definition.name,
            mode: definition.mode,
            schedule: definition.schedule,
            enabled: definition.enabled,
            proposalState: definition.proposalState ?? null,
            targetThreadId: definition.targetThreadId,
            nextRunAt: definition.nextRunAt,
            iterationCount: definition.iterationCount,
            maxIterations: definition.maxIterations,
            notificationPolicy: definition.notificationPolicy ?? "all",
          })),
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const viewAutomation: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "synara_view_automation",
      description:
        "View a complete automation definition, recent runs, next run, and persistent-memory excerpt. Call this immediately before synara_update_automation and resend every unchanged mutable field.",
      inputSchema: {
        type: "object",
        properties: {
          automationId: { type: "string" },
          runLimit: { type: "number", minimum: 1, maximum: AUTOMATION_VIEW_MAX_RUNS },
        },
        required: ["automationId"],
        additionalProperties: false,
      },
      annotations: { title: "View a Synara automation", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const automationId = readStringArg(args, "automationId", { required: true })!;
        const caller = yield* requireThreadShell(context.callerThreadId);
        const { definition } = yield* requireAutomationDefinition(automationId);
        // Automations that run in their own threads are project resources, so any caller in
        // the project may read one. Heartbeat automations write into somebody's thread and
        // stay restricted to callers authorized for that thread.
        const projectScopedRead =
          !automationRequiresTargetThread(definition.mode) &&
          definition.projectId === caller.projectId;
        if (!projectScopedRead) {
          yield* assertCallerMayManageAutomation(caller, definition, context);
        }
        const runLimit = Math.min(
          AUTOMATION_VIEW_MAX_RUNS,
          Math.max(1, Math.round(readNumberArg(args, "runLimit") ?? AUTOMATION_VIEW_DEFAULT_RUNS)),
        );
        const [runs, memory] = yield* Effect.all([
          automationService.listRunsForDefinition({
            automationId: definition.id,
            limit: runLimit,
          }),
          automationService.getMemory(definition.id),
        ]).pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        return mcpToolResultJson({
          definition,
          nextRunAt: definition.nextRunAt,
          runs,
          memoryExcerpt: memory ? automationMemoryForEnvelope(memory.content) : "(empty)",
          memoryUpdatedAt: memory?.updatedAt ?? null,
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const updateAutomation: ToolEntry = {
    requiredCapability: "automation:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_update_automation",
      description: `Fully replace an automation's mutable configuration. ${AUTOMATION_AUTHORING_GUIDANCE} You MUST call synara_view_automation first, then resend name, prompt, schedule, enabled, maxIterations, notificationPolicy, and completionPolicy, including every unchanged field. Partial updates are rejected.`,
      inputSchema: {
        type: "object",
        properties: {
          automationId: { type: "string" },
          name: { type: "string", description: AUTOMATION_NAME_AUTHORING_GUIDANCE },
          prompt: { type: "string", description: AUTOMATION_PROMPT_AUTHORING_GUIDANCE },
          schedule: SCHEDULE_INPUT_SCHEMA,
          enabled: { type: "boolean" },
          maxIterations: { type: ["number", "null"], minimum: 1 },
          notificationPolicy: { type: "string", enum: ["all", "failed-runs-only"] },
          completionPolicy: {
            ...COMPLETION_POLICY_INPUT_SCHEMA,
            description:
              'Declarative retirement rule, available in every mode. "ai-evaluated" checks stopWhen against each successful run and disables the automation when it matches, so the stop condition does not depend on the run remembering to cancel itself. Defaults to {"type":"none"}.',
          },
          fastInterval: { type: "boolean" },
        },
        required: [
          "automationId",
          "name",
          "prompt",
          "schedule",
          "enabled",
          "maxIterations",
          "notificationPolicy",
          "completionPolicy",
        ],
        additionalProperties: false,
      },
      annotations: { title: "Replace a Synara automation", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const automationId = readStringArg(args, "automationId", { required: true })!;
        const caller = yield* requireThreadShell(context.callerThreadId);
        const { definition } = yield* requireAutomationDefinition(automationId);
        yield* assertCallerMayManageAutomation(caller, definition, context);
        if (definition.proposalState === "pending") {
          throw new ToolInputError(
            "Pending proposals must be accepted or dismissed by the user before they can be updated.",
          );
        }
        const schedule = decodeSchedule(args);
        if (!schedule) {
          throw new ToolInputError('Missing required argument "schedule".');
        }
        const completionPolicy = decodeCompletionPolicy(args, true)!;
        const enabled = readBooleanArg(args, "enabled");
        if (enabled === undefined) {
          throw new ToolInputError('Missing required argument "enabled".');
        }
        const fastSchedule = scheduleIsFast(schedule);
        const alreadyAcknowledged = definition.acknowledgedRisks.includes("fast-interval");
        if (fastSchedule && !alreadyAcknowledged && readBooleanArg(args, "fastInterval") !== true) {
          throw new ToolInputError(
            'A newly sub-minute schedule requires explicit "fastInterval": true acknowledgement.',
          );
        }
        const acknowledgedRisks = fastSchedule
          ? Array.from(new Set([...definition.acknowledgedRisks, "fast-interval" as const]))
          : definition.acknowledgedRisks;
        const maxIterations = readNullablePositiveInteger(args, "maxIterations", {
          required: true,
        });
        if (maxIterations === undefined) {
          throw new ToolInputError('Missing required argument "maxIterations".');
        }
        const notificationPolicy = readNotificationPolicy(args, true);
        if (notificationPolicy === undefined) {
          throw new ToolInputError('Missing required argument "notificationPolicy".');
        }
        const updated = yield* automationService
          .update({
            id: AutomationId.makeUnsafe(automationId),
            name: readStringArg(args, "name", { required: true })!,
            prompt: readStringArg(args, "prompt", { required: true })!,
            schedule,
            enabled,
            maxIterations,
            notificationPolicy,
            completionPolicy,
            acknowledgedRisks,
          })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        return mcpToolResultJson({ definition: updated });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const cancelAutomation: ToolEntry = {
    requiredCapability: "automation:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_cancel_automation",
      description:
        'Stop a Synara automation. mode "disable" (default) pauses it and keeps history; "delete" archives it. An automation-dispatched run may always stop its own automation, whatever its mode. Prefer a completionPolicy stop clause for conditions known when the automation is created.',
      inputSchema: {
        type: "object",
        properties: {
          automationId: { type: "string", description: "Automation to stop." },
          mode: { type: "string", enum: ["disable", "delete"], description: "Stop mode." },
        },
        required: ["automationId"],
        additionalProperties: false,
      },
      annotations: { title: "Stop a Synara automation", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const automationId = readStringArg(args, "automationId", { required: true })!;
        const modeArg = readStringArg(args, "mode") ?? "disable";
        if (modeArg !== "disable" && modeArg !== "delete") {
          throw new ToolInputError('Argument "mode" must be "disable" or "delete".');
        }
        const id = AutomationId.makeUnsafe(automationId);
        const caller = yield* requireThreadShell(context.callerThreadId);
        const { definition } = yield* requireAutomationDefinition(automationId);
        yield* assertCallerMayManageAutomation(caller, definition, context);
        if (modeArg === "delete") {
          yield* automationService
            .delete({ id })
            .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        } else {
          yield* automationService
            .update({ id, enabled: false })
            .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        }
        return mcpToolResultJson({ automationId, stopped: true, mode: modeArg });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const updateMemory: ToolEntry = {
    requiredCapability: "automation:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_update_automation_memory",
      description:
        'Fully replace an automation\'s DB-backed persistent memory. Maximum UTF-8 size: 32 KiB. Omit automationId only when the current user message is the automation run envelope. A later manual follow-up such as "continue" is not part of that run and must not call this tool as completion bookkeeping.',
      inputSchema: {
        type: "object",
        properties: {
          memory: {
            type: "string",
            maxLength: 32 * 1_024,
            description: "Complete replacement memory content.",
          },
          automationId: {
            type: "string",
            description:
              "Defaults to the automation that dispatched the current turn; only needed elsewhere.",
          },
          content: {
            type: "string",
            maxLength: 32 * 1_024,
            description: 'Deprecated alias of "memory".',
          },
        },
        required: ["memory"],
        additionalProperties: false,
      },
      annotations: { title: "Update automation memory", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const automationIdArg = readStringArg(args, "automationId");
        const memory = yield* automationService
          .updateMemory({
            automationId: automationIdArg ? AutomationId.makeUnsafe(automationIdArg) : null,
            content: readMemoryContent(args),
            callerThreadId: ThreadId.makeUnsafe(context.callerThreadId),
            callerTurnId: context.callerTurnId ? TurnId.makeUnsafe(context.callerTurnId) : null,
          })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        return mcpToolResultJson({ memory });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const reportResult: ToolEntry = {
    requiredCapability: "automation:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_report_automation_result",
      description:
        'Report the structured result only when the current user message is the automation run envelope. Automation status never carries into a later manual follow-up such as "continue"; never call this tool for that turn. Use decision "silent" only when a successful run needs no user attention. Failures always remain visible.',
      inputSchema: {
        type: "object",
        properties: {
          decision: { type: "string", enum: ["notify", "silent"] },
          title: { type: "string", maxLength: 160 },
          summary: { type: "string", maxLength: 2_000 },
        },
        required: ["decision"],
        additionalProperties: false,
      },
      annotations: { title: "Report automation result", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const decision = readStringArg(args, "decision", { required: true });
        if (decision !== "notify" && decision !== "silent") {
          throw new ToolInputError('Argument "decision" must be "notify" or "silent".');
        }
        const run = yield* automationService
          .reportResult({
            callerThreadId: ThreadId.makeUnsafe(context.callerThreadId),
            callerTurnId: context.callerTurnId ? TurnId.makeUnsafe(context.callerTurnId) : null,
            decision,
            ...(args.title !== undefined
              ? { title: readStringArg(args, "title", { required: true })! }
              : {}),
            ...(args.summary !== undefined
              ? { summary: readStringArg(args, "summary", { required: true })! }
              : {}),
          })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        return mcpToolResultJson({
          automationId: run.automationId,
          runId: run.id,
          decision: run.result?.decision ?? decision,
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  return [
    createAutomation,
    listAutomations,
    viewAutomation,
    updateAutomation,
    cancelAutomation,
    updateMemory,
    reportResult,
  ];
}

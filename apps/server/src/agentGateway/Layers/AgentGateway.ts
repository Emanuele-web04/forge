/**
 * AgentGatewayLive - Synara app-control MCP tool surface.
 *
 * Implements the `synara_*` tools served over `POST /mcp` (streamable HTTP,
 * stateless JSON responses). Every provider session gets this endpoint plus a
 * thread-bound bearer token injected at session start, so any agent running in
 * a Synara thread can list/read/create/steer threads and manage heartbeat
 * automations - the same host-tool pattern the Codex desktop app uses.
 *
 * All tools delegate to existing services (OrchestrationEngine dispatch,
 * ProjectionSnapshotQuery reads, AutomationService, GitCore); no orchestration
 * state lives here.
 *
 * @module agentGateway/Layers/AgentGateway
 */
import { randomUUID } from "node:crypto";

import {
  CommandId,
  SYNARA_GATEWAY_MAX_THREADS_PER_OPERATION,
  MessageId,
  THREAD_GOAL_MAX_CHARS,
  ThreadId,
  type ProviderKind,
  type RuntimeMode,
  type ServerProviderStatus,
  type TurnDispatchMode,
} from "@synara/contracts";
import { runtimeModeEscalatesPrivilege } from "@synara/shared/runtimeMode";
import { Effect, Layer, Option } from "effect";

import { GitCore } from "../../git/Services/GitCore.ts";
import { GitManager } from "../../git/Services/GitManager.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AutomationService } from "../../automation/Services/AutomationService.ts";
import { buildAutomationProposalActivity } from "../../automation/proposalActivity.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationEventDeliveryRepository } from "../../persistence/Services/OrchestrationEventDeliveries.ts";
import { ProviderRuntimeEventRepository } from "../../persistence/Services/ProviderRuntimeEvents.ts";
import { ThreadDiagnosticsQuery } from "../../diagnostics/Services/ThreadDiagnosticsQuery.ts";
import { AgentGateway, type AgentGatewayShape } from "../Services/AgentGateway.ts";
import { AgentGatewayCredentials } from "../Services/AgentGatewayCredentials.ts";
import { AgentGatewayOperationRepository } from "../Services/AgentGatewayOperationRepository.ts";
import { ProviderDiscoveryService } from "../../provider/Services/ProviderDiscoveryService.ts";
import { ProviderHealth } from "../../provider/Services/ProviderHealth.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  AGENT_GATEWAY_TARGET_OPTIONS_DESCRIPTION,
  type AgentGatewayProviderAvailability,
} from "../targetResolver.ts";
import { mcpToolResultError, mcpToolResultJson } from "../protocol.ts";
import { gatewayIsoNow as isoNow } from "../creationUtils.ts";
import {
  MODEL_SELECTION_INPUT_SCHEMA,
  PROVIDER_KINDS,
  ToolInputError,
  buildModelSelection,
  decodeCreateThreadsInput,
  errorText,
  parseProviderKind,
  readBooleanArg,
  readRecordArg,
  readStringArg,
} from "../toolInput.ts";
import { WRITE_TOOL_ANNOTATIONS, type ToolEntry } from "../toolRuntime.ts";
import { makeAgentGatewayMcpTransport } from "../mcpTransport.ts";
import { recoverInterruptedAgentGatewayOperations } from "../startupRecovery.ts";
import { makeCreateThreadsHandler } from "../creationCoordinator.ts";
import { makeAgentGatewayAutomationTools } from "../automationTools.ts";
import { makeAgentGatewayBrowserTools } from "../browserTools.ts";
import { makeAgentGatewayDeviceTools } from "../deviceTools.ts";
import { DeviceService } from "../../device/Services/DeviceService.ts";
import { BrowserAutomationHost } from "../../browserAutomation/Services/BrowserAutomationHost.ts";
import { makeBrowserAutomationHost } from "../../browserAutomation/Layers/BrowserAutomationHost.ts";
import { makeThreadReadTools } from "../threadReadTools.ts";
import { makeThreadDiagnosticTools } from "../threadDiagnosticTools.ts";
import { pruneProjectedArchivedManagedWorktrees } from "../../managedWorktrees.ts";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";

// Providers already receive the versioned host policy exactly once in their
// private prompt. MCP clients prepend initialize.instructions to every exposed
// tool definition, so repeating the full policy here adds tens of thousands of
// context characters per round without adding authority or safety.
const AGENT_GATEWAY_INSTRUCTIONS =
  "Synara tools are thread-scoped. Use browser_* only for Synara's shared in-app browser runtime; follow the provider-delivered <synara_host_context> for full policy.";

function readThreadGoalArg(args: Record<string, unknown>): string {
  if (!("goal" in args)) {
    throw new ToolInputError(`Missing required argument "goal".`);
  }
  const value = args.goal;
  if (value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new ToolInputError(`Argument "goal" must be a string or null.`);
  }
  const goal = value.trim();
  if (goal.length > THREAD_GOAL_MAX_CHARS) {
    throw new ToolInputError(
      `Argument "goal" must be at most ${THREAD_GOAL_MAX_CHARS} characters.`,
    );
  }
  return goal;
}

export const makeAgentGateway = Effect.gen(function* () {
  const credentials = yield* AgentGatewayCredentials;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const automationService = yield* AutomationService;
  const git = yield* GitCore;
  const gitManager = yield* GitManager;
  const providerDiscovery = yield* ProviderDiscoveryService;
  const providerHealth = yield* ProviderHealth;
  const serverSettings = yield* ServerSettingsService;
  const operationRepository = yield* AgentGatewayOperationRepository;
  const projectionTurns = yield* ProjectionTurnRepository;
  const eventStore = yield* OrchestrationEventStore;
  const eventDeliveries = yield* OrchestrationEventDeliveryRepository;
  const providerRuntimeEvents = yield* ProviderRuntimeEventRepository;
  const diagnostics = yield* ThreadDiagnosticsQuery;
  const serverConfig = yield* ServerConfig;
  const browserAutomationHost = Option.getOrElse(
    yield* Effect.serviceOption(BrowserAutomationHost),
    () => makeBrowserAutomationHost({}),
  );
  // Optional and platform-gated: off macOS (and in tests that do not provide
  // it) the agent never sees the device_* tools at all, rather than being
  // offered eleven tools that can only report an unsupported platform.
  const deviceService = Option.getOrUndefined(yield* Effect.serviceOption(DeviceService));
  const loadProviderAvailabilities = Effect.gen(function* () {
    const [settings, statuses] = yield* Effect.all([
      serverSettings.getSettings,
      providerHealth.getStatuses,
    ]);
    const statusByProvider = new Map<ProviderKind, ServerProviderStatus>(
      statuses.map((status) => [status.provider, status]),
    );
    return new Map<ProviderKind, AgentGatewayProviderAvailability>(
      PROVIDER_KINDS.map((provider) => {
        const status = statusByProvider.get(provider);
        return [
          provider,
          {
            enabled: settings.providers[provider].enabled,
            ...(status
              ? {
                  available: status.available,
                  authStatus: status.authStatus,
                  ...(status.message ? { message: status.message } : {}),
                }
              : {}),
          },
        ];
      }),
    );
  });

  yield* recoverInterruptedAgentGatewayOperations({
    operationRepository,
    snapshotQuery,
    orchestrationEngine,
    git,
  });

  const requireThreadShell = (threadId: string) =>
    snapshotQuery.getThreadShellById(ThreadId.makeUnsafe(threadId)).pipe(
      Effect.mapError((error) => new ToolInputError(errorText(error))),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new ToolInputError(`Thread "${threadId}" was not found.`)),
          onSome: (shell) => Effect.succeed(shell),
        }),
      ),
    );

  // Privilege boundary shared by every tool that makes another thread execute
  // work or mutates another thread's state: a caller must not drive a thread
  // that runs with more privileges than the user granted the caller itself —
  // otherwise an approval-required or worktree-isolated agent escalates by proxy.
  const assertCallerMayDriveThread = (
    caller: { readonly runtimeMode: RuntimeMode; readonly envMode?: string | null | undefined },
    target: {
      readonly id: string;
      readonly runtimeMode: RuntimeMode;
      readonly envMode?: string | null | undefined;
    },
  ) =>
    Effect.gen(function* () {
      if (runtimeModeEscalatesPrivilege(caller.runtimeMode, target.runtimeMode)) {
        return yield* Effect.fail(
          new ToolInputError(
            `Thread "${target.id}" runs in "${target.runtimeMode}" mode but your thread runs in "${caller.runtimeMode}"; you cannot drive higher-privileged threads. Ask the user to do this or to elevate your thread.`,
          ),
        );
      }
      if (caller.envMode === "worktree" && (target.envMode ?? "local") === "local") {
        return yield* Effect.fail(
          new ToolInputError(
            `Thread "${target.id}" runs on the shared local checkout but your thread is isolated in a worktree; you cannot drive local-checkout threads. Ask the user to do this from a local thread.`,
          ),
        );
      }
    });

  const readTools = makeThreadReadTools({
    snapshotQuery,
    projectionTurns,
    providerDiscovery,
    loadProviderAvailabilities,
    requireThreadShell,
    workspacePaths: {
      homeDir: serverConfig.homeDir,
      chatWorkspaceRoot: serverConfig.chatWorkspaceRoot,
    },
  });
  const diagnosticTools = makeThreadDiagnosticTools({
    snapshotQuery,
    diagnostics,
    eventStore,
    providerRuntimeEvents,
    eventDeliveries,
    requireThreadShell,
  });

  // --- write tools ----------------------------------------------------------

  const runCreateThreads = yield* makeCreateThreadsHandler({
    snapshotQuery,
    orchestrationEngine,
    git,
    providerDiscovery,
    operationRepository,
    serverConfig,
    loadProviderAvailabilities,
    requireThreadShell,
  });

  const createThreads: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_create_threads",
      description:
        "Create an exact batch of 1–20 standalone Synara threads. Worktree threads start on a Synara-managed temporary branch pinned at baseRef (or the selected checkout's HEAD) and copy local checkout changes plus .worktreeinclude files when the ref is that checkout's HEAD; on the first turn Synara may rename the branch after the prompt and publish it. Validation/preflight failures create nothing and may be corrected with the same requestId; durable retries replay the exact operation.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: {
            type: "string",
            maxLength: 256,
            description: "Stable id for this exact user-requested creation plan.",
          },
          threads: {
            type: "array",
            minItems: 1,
            maxItems: SYNARA_GATEWAY_MAX_THREADS_PER_OPERATION,
            items: {
              type: "object",
              properties: {
                prompt: { type: "string" },
                title: { type: "string" },
                target: {
                  ...MODEL_SELECTION_INPUT_SCHEMA,
                },
                projectId: { type: "string" },
                environment: { type: "string", enum: ["local", "worktree"] },
                baseRef: {
                  type: "string",
                  description:
                    "Local Git revision, #PR, or GitHub pull-request URL the worktree is pinned at. Defaults to the selected checkout's HEAD.",
                },
                runtimeMode: {
                  type: "string",
                  enum: ["approval-required", "full-access"],
                },
              },
              required: ["prompt", "target"],
              additionalProperties: false,
            },
          },
        },
        required: ["requestId", "threads"],
        additionalProperties: false,
      },
      annotations: {
        title: "Create Synara threads",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    handler: (args, context) =>
      runCreateThreads(decodeCreateThreadsInput(args), {
        kind: "provider-session",
        callerThreadId: context.callerThreadId,
        callerTurnId: context.callerTurnId,
        assertAuthority: context.assertCallerTurnActive,
      }),
  };

  const createThread: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_create_thread",
      description:
        "Create exactly one standalone Synara thread. Worktree threads start on a Synara-managed temporary branch pinned at baseRef; on the first turn Synara may rename the branch after the prompt and publish it. For two or more threads use one synara_create_threads call instead.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string", maxLength: 256 },
          prompt: { type: "string" },
          title: { type: "string" },
          target: {
            ...MODEL_SELECTION_INPUT_SCHEMA,
          },
          provider: { type: "string", enum: [...PROVIDER_KINDS] },
          model: { type: "string" },
          options: {
            type: "object",
            description: AGENT_GATEWAY_TARGET_OPTIONS_DESCRIPTION,
          },
          projectId: { type: "string" },
          environment: { type: "string", enum: ["local", "worktree"] },
          baseRef: {
            type: "string",
            description:
              "Local Git revision, #PR, or GitHub pull-request URL the worktree is pinned at. Defaults to the selected checkout's HEAD.",
          },
          runtimeMode: {
            type: "string",
            enum: ["approval-required", "full-access"],
          },
        },
        required: ["requestId", "prompt"],
        additionalProperties: false,
      },
      annotations: {
        title: "Create a Synara thread",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    handler: (args, context) =>
      Effect.suspend(() => {
        const explicitTarget = readRecordArg(args, "target");
        let target: Record<string, unknown>;
        if (explicitTarget) {
          target = explicitTarget;
        } else {
          const provider = parseProviderKind(readStringArg(args, "provider", { required: true })!);
          const modelSelection = buildModelSelection(provider, readStringArg(args, "model"));
          const options = readRecordArg(args, "options");
          target = { ...modelSelection, ...(options ? { options } : {}) };
        }
        const spec: Record<string, unknown> = {
          prompt: readStringArg(args, "prompt", { required: true })!,
          target,
        };
        for (const key of [
          "title",
          "projectId",
          "environment",
          "baseRef",
          "baseBranch",
          "branchName",
          "runtimeMode",
        ]) {
          const value = args[key];
          if (value !== undefined) spec[key] = value;
        }
        return runCreateThreads(
          decodeCreateThreadsInput({
            requestId: readStringArg(args, "requestId", { required: true }),
            threads: [spec],
          }),
          {
            kind: "provider-session",
            callerThreadId: context.callerThreadId,
            callerTurnId: context.callerTurnId,
            assertAuthority: context.assertCallerTurnActive,
          },
        ).pipe(
          Effect.map((result) => {
            if (result.isError) return result;
            const content = result.content[0];
            const batch = JSON.parse(content?.type === "text" ? content.text : "{}") as {
              operationId?: string;
              requestId?: string;
              threads?: Array<Record<string, unknown>>;
            };
            return mcpToolResultJson({
              operationId: batch.operationId,
              requestId: batch.requestId,
              ...(batch.threads?.[0] ?? {}),
            });
          }),
        );
      }).pipe(Effect.catchDefect((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const sendMessage: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_send_message",
      description:
        'Send a Synara follow-up message to an existing thread. mode "queue" (default) waits for the current turn; "steer" redirects a running turn where the provider supports it (otherwise it is queued).',
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Target thread." },
          message: { type: "string", description: "Message text." },
          mode: { type: "string", enum: ["queue", "steer"], description: "Dispatch mode." },
        },
        required: ["threadId", "message"],
        additionalProperties: false,
      },
      annotations: { title: "Send a Synara message", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        const message = readStringArg(args, "message", { required: true })!;
        const modeArg = readStringArg(args, "mode") ?? "queue";
        if (modeArg !== "queue" && modeArg !== "steer") {
          throw new ToolInputError(`Argument "mode" must be "queue" or "steer".`);
        }
        const caller = yield* requireThreadShell(context.callerThreadId);
        const target = yield* requireThreadShell(threadId);
        yield* assertCallerMayDriveThread(caller, target);
        // Pass the requested mode through unchanged: the reactor checks live
        // provider state (authoritative, unlike this projection snapshot) and
        // already downgrades steers whose turn is not actually live.
        const dispatchMode: TurnDispatchMode = modeArg;
        const suffix = randomUUID();
        yield* orchestrationEngine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe(`agent:${suffix}:send`),
            threadId: target.id,
            message: {
              messageId: MessageId.makeUnsafe(`agent:${suffix}:message`),
              role: "user",
              text: message,
              attachments: [],
            },
            dispatchMode,
            dispatchOrigin: "agent",
            runtimeMode: target.runtimeMode,
            interactionMode: target.interactionMode,
            createdAt: isoNow(),
          })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        return mcpToolResultJson({ threadId: target.id, dispatched: dispatchMode });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const interruptThread: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_interrupt_thread",
      description: "Interrupt the running turn of a Synara thread.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Thread whose turn should be interrupted." },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
      annotations: { title: "Interrupt a Synara thread", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        const caller = yield* requireThreadShell(context.callerThreadId);
        const target = yield* requireThreadShell(threadId);
        // Stopping a higher-privileged thread's work is still driving it.
        yield* assertCallerMayDriveThread(caller, target);
        const activeTurnId = target.session?.activeTurnId ?? null;
        const hadActiveTurn = activeTurnId !== null || target.latestTurn?.state === "running";
        const dispatched = yield* orchestrationEngine
          .dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.makeUnsafe(`agent:${randomUUID()}:interrupt`),
            threadId: target.id,
            createdAt: isoNow(),
          })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        // The interrupt is only *requested* here: the provider settles the turn
        // asynchronously. Reporting a constant `interrupted: true` told callers
        // the turn had stopped even when there was no turn to stop.
        return mcpToolResultJson({
          threadId: target.id,
          interruptRequested: true,
          hadActiveTurn,
          activeTurnId,
          eventSequence: dispatched.sequence,
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const setThreadTitle: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_set_thread_title",
      description: "Rename a Synara thread.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Thread to rename." },
          title: { type: "string", description: "New title." },
        },
        required: ["threadId", "title"],
        additionalProperties: false,
      },
      annotations: { title: "Rename a Synara thread", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        const title = readStringArg(args, "title", { required: true })!;
        const caller = yield* requireThreadShell(context.callerThreadId);
        const target = yield* requireThreadShell(threadId);
        yield* assertCallerMayDriveThread(caller, target);
        yield* orchestrationEngine
          .dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe(`agent:${randomUUID()}:rename`),
            threadId: target.id,
            title,
          })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        return mcpToolResultJson({ threadId: target.id, title });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const setThreadPullRequest: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_set_thread_pull_request",
      description:
        "Associate a pull request with a Synara thread. Use this after successfully creating the pull request that represents that thread's own deliverable. Do not associate pull requests that the thread only reviews, references, or discusses. Defaults to your own thread when threadId is omitted.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: {
            type: "string",
            description: "Thread that owns the pull request. Defaults to your own thread.",
          },
          reference: {
            type: "string",
            description: "GitHub pull request URL or number resolvable from the thread repository.",
          },
        },
        required: ["reference"],
        additionalProperties: false,
      },
      annotations: { title: "Associate a pull request", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId") ?? context.callerThreadId;
        const reference = readStringArg(args, "reference", { required: true })!;
        const caller = yield* requireThreadShell(context.callerThreadId);
        const target = yield* requireThreadShell(threadId);
        yield* assertCallerMayDriveThread(caller, target);

        const project = Option.getOrUndefined(
          yield* snapshotQuery
            .getProjectShellById(target.projectId)
            .pipe(Effect.mapError((error) => new ToolInputError(errorText(error)))),
        );
        if (!project) {
          return yield* Effect.fail(
            new ToolInputError(`Project for thread "${threadId}" was not found.`),
          );
        }
        const cwd = resolveThreadWorkspaceCwd({ thread: target, projects: [project] });
        if (!cwd) {
          return yield* Effect.fail(
            new ToolInputError(`Git workspace for thread "${threadId}" is unavailable.`),
          );
        }

        const { pullRequest } = yield* gitManager
          .resolvePullRequest({ cwd, reference })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        yield* orchestrationEngine
          .dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe(`agent:${randomUUID()}:pull-request`),
            threadId: target.id,
            lastKnownPr: pullRequest,
          })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        return mcpToolResultJson({ threadId: target.id, pullRequest });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const setThreadArchived: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_set_thread_archived",
      description:
        "Archive or unarchive a Synara thread. Defaults to your own thread when threadId is omitted.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Thread to archive/unarchive." },
          archived: { type: "boolean", description: "true to archive, false to unarchive." },
        },
        required: ["archived"],
        additionalProperties: false,
      },
      annotations: { title: "Update a Synara thread", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId") ?? context.callerThreadId;
        const archived = readBooleanArg(args, "archived");
        if (archived === undefined) {
          throw new ToolInputError(`Missing required argument "archived".`);
        }
        const caller = yield* requireThreadShell(context.callerThreadId);
        const target = yield* requireThreadShell(threadId);
        yield* assertCallerMayDriveThread(caller, target);
        yield* orchestrationEngine
          .dispatch({
            type: archived ? "thread.archive" : "thread.unarchive",
            commandId: CommandId.makeUnsafe(`agent:${randomUUID()}:archive`),
            threadId: target.id,
          })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        if (archived) {
          yield* Effect.forkDetach(
            pruneProjectedArchivedManagedWorktrees({
              homeDir: serverConfig.homeDir,
              worktreesDir: serverConfig.worktreesDir,
              snapshotQuery,
              git,
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("agent gateway managed worktree retention failed", {
                  cause: String(cause),
                }),
              ),
            ),
          );
        }
        return mcpToolResultJson({ threadId: target.id, archived });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const setThreadGoal: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: "synara_set_thread_goal",
      description:
        "Set a persistent goal for a thread. Only set a goal when the user has explicitly asked for one (for example, 'keep working until X' or 'the goal of this thread is Y') or when dispatching a thread explicitly created to pursue a stated objective. Do NOT infer or invent goals from ordinary tasks or set one as a side effect of normal work. Clearing requires the same explicit user intent. When the active goal's objective has been accomplished, pass achieved: true instead of clearing: Synara records the achievement (with the time it took) and clears the goal. If the same external blocker prevents meaningful progress for three consecutive goal turns, pass blocked: true to pause the goal. Do not mark a goal blocked merely because the work is difficult, incomplete, or would benefit from clarification.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: {
            type: "string",
            description: "Thread to update. Defaults to your own thread when omitted.",
          },
          goal: {
            type: ["string", "null"],
            maxLength: THREAD_GOAL_MAX_CHARS,
            description:
              "Persistent objective. Pass null or an empty string to clear it. Ignored when achieved or blocked is true.",
          },
          achieved: {
            type: "boolean",
            description:
              "Pass true when the active goal's objective has been accomplished. Records a goal achievement and clears the goal.",
          },
          blocked: {
            type: "boolean",
            description:
              "Pass true only after the same external blocker prevents meaningful progress for three consecutive goal turns. Pauses the active goal.",
          },
        },
        required: [],
        additionalProperties: false,
      },
      annotations: { title: "Set a Synara thread goal", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId") ?? context.callerThreadId;
        if ("achieved" in args && typeof args.achieved !== "boolean") {
          return yield* Effect.fail(new ToolInputError(`Argument "achieved" must be a boolean.`));
        }
        if ("blocked" in args && typeof args.blocked !== "boolean") {
          return yield* Effect.fail(new ToolInputError(`Argument "blocked" must be a boolean.`));
        }
        const achieved = args.achieved === true;
        const blocked = args.blocked === true;
        if (achieved && blocked) {
          return yield* Effect.fail(
            new ToolInputError(`Arguments "achieved" and "blocked" are mutually exclusive.`),
          );
        }
        const goal = achieved || blocked ? "" : readThreadGoalArg(args);
        const caller = yield* requireThreadShell(context.callerThreadId);
        const target = yield* requireThreadShell(threadId);
        yield* assertCallerMayDriveThread(caller, target);
        if ((achieved || blocked) && (target.goal ?? "").trim().length === 0) {
          return yield* Effect.fail(
            new ToolInputError(
              `Thread has no active goal to mark ${achieved ? "achieved" : "blocked"}.`,
            ),
          );
        }
        yield* orchestrationEngine
          .dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe(`agent:${randomUUID()}:goal`),
            threadId: target.id,
            ...(achieved ? { goalAchieved: true } : blocked ? { goalPaused: true } : { goal }),
          })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        return mcpToolResultJson(
          achieved
            ? { threadId: target.id, goal: null, achieved: true }
            : blocked
              ? { threadId: target.id, goal: target.goal, blocked: true, paused: true }
              : { threadId: target.id, goal: goal || null },
        );
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const automationTools = makeAgentGatewayAutomationTools({
    automationService,
    requireThreadShell,
    assertCallerMayDriveThread,
    surfaceAutomationProposal: ({ callerThreadId, definition }) => {
      const createdAt = isoNow();
      return orchestrationEngine
        .dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe(`agent:${randomUUID()}:automation-proposal`),
          threadId: callerThreadId,
          activity: buildAutomationProposalActivity({
            definition,
            proposalState: "pending",
          }),
          createdAt,
        })
        .pipe(Effect.asVoid);
    },
  });
  const browserTools = makeAgentGatewayBrowserTools(browserAutomationHost, {
    resolveWorkspaceRoot: (context) =>
      Effect.gen(function* () {
        const thread = yield* requireThreadShell(context.callerThreadId);
        const project = yield* snapshotQuery
          .getProjectShellById(thread.projectId)
          .pipe(Effect.map(Option.getOrNull));
        if (!project) return null;
        return (
          resolveThreadWorkspaceCwd({
            thread,
            projects: [project],
          }) ?? null
        );
      }).pipe(Effect.orElseSucceed(() => null)),
  });

  const tools: ReadonlyArray<ToolEntry> = [
    ...readTools,
    ...diagnosticTools,
    createThreads,
    createThread,
    sendMessage,
    interruptThread,
    setThreadTitle,
    setThreadPullRequest,
    setThreadArchived,
    setThreadGoal,
    ...automationTools,
    ...browserTools,
    ...(deviceService?.supported === true
      ? makeAgentGatewayDeviceTools({ manager: deviceService.manager })
      : []),
  ];
  return {
    handleMcpPost: makeAgentGatewayMcpTransport({
      credentials,
      snapshotQuery,
      tools,
      instructions: AGENT_GATEWAY_INSTRUCTIONS,
      requireThreadShell,
    }),
  } satisfies AgentGatewayShape;
});

export const AgentGatewayLive = Layer.effect(AgentGateway, makeAgentGateway);

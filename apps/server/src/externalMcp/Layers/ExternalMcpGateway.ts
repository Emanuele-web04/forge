import {
  EXTERNAL_MCP_DEFAULT_WAIT_MS,
  EXTERNAL_MCP_MAX_MESSAGE_CHARS,
  EXTERNAL_MCP_MAX_PROMPT_CHARS,
  EXTERNAL_MCP_MAX_WAIT_MS,
  ExternalMcpCreateTaskInput,
  ExternalMcpReadTaskInput,
  ExternalMcpWaitTaskInput,
  ProjectId,
  ThreadId,
  type ExternalMcpCapability,
  type ProviderKind,
  type ServerProviderStatus,
} from "@synara/contracts";
import { Effect, Layer, Option, Schema } from "effect";

import { GitCore } from "../../git/Services/GitCore.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProviderDiscoveryService } from "../../provider/Services/ProviderDiscoveryService.ts";
import { ProviderHealth } from "../../provider/Services/ProviderHealth.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { AgentGatewayOperationRepository } from "../../agentGateway/Services/AgentGatewayOperationRepository.ts";
import { makeCreateThreadsHandler } from "../../agentGateway/creationCoordinator.ts";
import { recoverInterruptedAgentGatewayOperations } from "../../agentGateway/startupRecovery.ts";
import { extractBearerToken } from "../../agentGateway/bearerToken.ts";
import {
  buildMcpInitializeResult,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  jsonRpcError,
  jsonRpcResult,
  mcpToolResultError,
  mcpToolResultJson,
  parseMcpMessage,
  type JsonRpcId,
  type JsonRpcRequest,
  type McpToolCallResult,
} from "../../agentGateway/protocol.ts";
import {
  gatewayToolErrorResult,
  GatewayToolError,
  READ_ONLY_TOOL_ANNOTATIONS,
  type ExternalClientPrincipal,
  type McpToolEntry,
} from "../../agentGateway/toolRuntime.ts";
import {
  AGENT_GATEWAY_TARGET_OPTIONS_DESCRIPTION,
  agentGatewayTargetOptionGuidance,
  loadAgentGatewayProviderCatalog,
  type AgentGatewayProviderAvailability,
} from "../../agentGateway/targetResolver.ts";
import {
  decodeCreateThreadsInput,
  errorText,
  PROVIDER_KINDS,
  ToolInputError,
} from "../../agentGateway/toolInput.ts";
import {
  summarizeThreadDetail,
  summarizeWaitThreadText,
} from "../../agentGateway/threadSummary.ts";
import {
  latestExternalMcpWaitState,
  requestedExternalMcpRunId,
  terminalExternalMcpSessionStateForRun,
  waitForExternalMcpTaskState,
} from "../waitForTask.ts";
import { ExternalMcpRepository } from "../Services/ExternalMcpRepository.ts";
import {
  ExternalMcpError,
  ExternalMcpService,
  type ExternalMcpVerifiedClient,
} from "../Services/ExternalMcpService.ts";
import { makeExternalMcpAuditCompletion } from "../auditCompletion.ts";
import { verifyExternalMcpTransportCredential } from "../credentialVerification.ts";
import {
  buildExternalMcpOverviewNextSteps,
  buildExternalMcpOverviewProjects,
} from "../overview.ts";
import {
  ExternalMcpGateway,
  type ExternalMcpGatewayShape,
} from "../Services/ExternalMcpGateway.ts";

const EXTERNAL_MCP_INSTRUCTIONS =
  "This is Synara's loopback-only external integration. Call synara_overview first to discover the allowed projects (with on-disk paths), provider availability, and granted scopes. Tools are restricted to the integration's allowed projects and scopes. Task creation is one task per stable requestId and defaults to a managed worktree with approval-required execution.";
const MCP_MAX_BATCH_MESSAGES = 50;

interface ExternalToolContext {
  readonly principal: ExternalClientPrincipal;
  readonly client: ExternalMcpVerifiedClient;
  readonly jsonRpcRequestId: JsonRpcId;
  readonly assertActive: () => Effect.Effect<void, GatewayToolError>;
}

type ExternalTool = McpToolEntry<ExternalToolContext, ExternalMcpCapability>;

export function filterExternalMcpTools(
  tools: ReadonlyArray<ExternalTool>,
  capabilities: ReadonlySet<ExternalMcpCapability>,
) {
  return tools.filter((tool) => capabilities.has(tool.requiredCapability));
}

const decodeExternalCreateTask = Schema.decodeUnknownEffect(ExternalMcpCreateTaskInput);
const decodeExternalReadTask = Schema.decodeUnknownEffect(ExternalMcpReadTaskInput);
const decodeExternalWaitTask = Schema.decodeUnknownEffect(ExternalMcpWaitTaskInput);

function externalErrorResult(error: unknown) {
  if (error instanceof GatewayToolError) return gatewayToolErrorResult(error);
  if (error instanceof ExternalMcpError) {
    return gatewayToolErrorResult(new GatewayToolError(error.code, error.message));
  }
  return mcpToolResultError(errorText(error));
}

function readAuditMetadata(tool: string, args: Record<string, unknown>) {
  const stringOrNull = (key: string) =>
    typeof args[key] === "string" ? (args[key] as string) : null;
  return {
    tool,
    requestId: stringOrNull("requestId"),
    projectId: stringOrNull("projectId"),
    runtimeMode:
      stringOrNull("runtimeMode") ?? (tool === "synara_create_task" ? "approval-required" : null),
    environment: stringOrNull("environment") ?? (tool === "synara_create_task" ? "worktree" : null),
  };
}

function createdThreadIds(result: McpToolCallResult) {
  try {
    const content = result.content[0];
    const payload = JSON.parse(content?.type === "text" ? content.text : "{}") as {
      readonly threadId?: unknown;
      readonly threadIds?: unknown;
    };
    if (typeof payload.threadId === "string") return [payload.threadId];
    if (Array.isArray(payload.threadIds)) {
      return payload.threadIds.filter((value): value is string => typeof value === "string");
    }
  } catch {
    // Audit extraction is deliberately best-effort and never stores prompt text.
  }
  return [];
}

export const makeExternalMcpGateway = Effect.gen(function* () {
  const externalMcp = yield* ExternalMcpService;
  const externalRepository = yield* ExternalMcpRepository;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const projectionTurns = yield* ProjectionTurnRepository;
  const providerDiscovery = yield* ProviderDiscoveryService;
  const providerHealth = yield* ProviderHealth;
  const settings = yield* ServerSettingsService;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const git = yield* GitCore;
  const serverConfig = yield* ServerConfig;
  const operationRepository = yield* AgentGatewayOperationRepository;

  yield* recoverInterruptedAgentGatewayOperations({
    operationRepository: {
      listNonTerminal: externalRepository.listNonTerminalOperations,
      markCompensating: externalRepository.markOperationCompensating,
      recordCompensationFailure: externalRepository.recordOperationCompensationFailure,
      fail: externalRepository.failOperationAndTask,
    },
    creationSource: "external_mcp",
    retainOnMissingThreadProjection: true,
    snapshotQuery,
    orchestrationEngine,
    git,
  });

  const loadProviderAvailabilities = Effect.gen(function* () {
    const [serverSettings, statuses] = yield* Effect.all([
      settings.getSettings,
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
            enabled: serverSettings.providers[provider].enabled,
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

  const requireThreadShell = (threadId: string) =>
    snapshotQuery.getThreadShellById(ThreadId.makeUnsafe(threadId)).pipe(
      Effect.mapError((cause) => new ToolInputError(errorText(cause))),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new ToolInputError(`Thread "${threadId}" was not found.`)),
          onSome: Effect.succeed,
        }),
      ),
    );

  const runCreateThreads = yield* makeCreateThreadsHandler({
    snapshotQuery,
    orchestrationEngine,
    git,
    providerDiscovery,
    operationRepository,
    externalMcpRepository: externalRepository,
    serverConfig,
    loadProviderAvailabilities,
    requireThreadShell,
  });

  const capabilitiesTool: ExternalTool = {
    requiredCapability: "projects:read",
    definition: {
      name: "synara_capabilities",
      description:
        "Describe this integration's granted scopes, safe runtime defaults, provider/model targets, and limits for an explicitly allowed project.",
      inputSchema: {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
        additionalProperties: false,
      },
      annotations: { title: "Synara integration capabilities", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const projectId = typeof args.projectId === "string" ? args.projectId : "";
        if (!projectId) throw new ToolInputError('Missing required argument "projectId".');
        yield* externalMcp.assertProject(context.client, projectId);
        const project = yield* snapshotQuery
          .getProjectShellById(ProjectId.makeUnsafe(projectId))
          .pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(new ToolInputError(`Project "${projectId}" was not found.`)),
                onSome: Effect.succeed,
              }),
            ),
          );
        const availabilities = yield* loadProviderAvailabilities;
        const providers = yield* Effect.forEach(PROVIDER_KINDS, (provider) =>
          loadAgentGatewayProviderCatalog({
            provider,
            discovery: providerDiscovery,
            ...(availabilities.get(provider)
              ? { availability: availabilities.get(provider)! }
              : {}),
            cwd: project.workspaceRoot,
          }),
        );
        return mcpToolResultJson({
          integration: {
            integrationId: context.client.integration.integrationId,
            name: context.client.integration.name,
            capabilities: [...context.client.capabilities],
          },
          defaults: { environment: "worktree", runtimeMode: "approval-required" },
          targetConstruction: Object.fromEntries(
            providers.map((provider) => [
              provider.provider,
              {
                modelValueSource: "providers[].models[].slug",
                ...agentGatewayTargetOptionGuidance(provider),
              },
            ]),
          ),
          providers,
          limits: {
            oneTaskPerRequest: true,
            maxPromptChars: EXTERNAL_MCP_MAX_PROMPT_CHARS,
            maxWaitMs: EXTERNAL_MCP_MAX_WAIT_MS,
            callsPerMinute: context.client.integration.rateLimitPerMinute,
            concurrentAgentTasks: context.client.integration.concurrencyLimit,
          },
        });
      }).pipe(Effect.catch((error) => Effect.succeed(externalErrorResult(error)))),
  };

  const projectsTool: ExternalTool = {
    requiredCapability: "projects:read",
    definition: {
      name: "synara_list_allowed_projects",
      description: "List only the Synara projects explicitly granted to this integration.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "List allowed Synara projects", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (_args, context) =>
      snapshotQuery.getShellSnapshot().pipe(
        Effect.map((snapshot) =>
          mcpToolResultJson({
            projects: snapshot.projects
              .filter((project) => context.client.allowedProjectIds.has(project.id))
              .map((project) => ({ projectId: project.id, title: project.title })),
          }),
        ),
        Effect.catch((error) => Effect.succeed(externalErrorResult(error))),
      ),
  };

  const overviewTool: ExternalTool = {
    requiredCapability: "projects:read",
    definition: {
      name: "synara_overview",
      description:
        "Discover everything this integration can use in one call: every allowed Synara project with its on-disk path and activity, provider availability, granted scopes, and safe defaults. Call this first to orient yourself.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "Synara overview", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (_args, context) =>
      Effect.gen(function* () {
        const snapshot = yield* snapshotQuery.getShellSnapshot();
        const availabilities = yield* loadProviderAvailabilities;
        // Thread titles are metadata about tasks the integration did not
        // create, so they stay behind the explicit tasks:read-project scope;
        // counts alone are safe under projects:read.
        const includeThreadMetadata = context.client.capabilities.has("tasks:read-project");
        const projects = buildExternalMcpOverviewProjects({
          projects: snapshot.projects,
          threads: snapshot.threads,
          allowedProjectIds: context.client.allowedProjectIds,
          includeThreadMetadata,
        });
        const nextSteps = buildExternalMcpOverviewNextSteps(context.client.capabilities);
        return mcpToolResultJson({
          integration: {
            integrationId: context.client.integration.integrationId,
            name: context.client.integration.name,
            projectScope: context.client.integration.projectScope,
            capabilities: [...context.client.capabilities],
          },
          projects,
          providers: [...availabilities].map(([provider, availability]) => ({
            provider,
            ...availability,
          })),
          defaults: { environment: "worktree", runtimeMode: "approval-required" },
          limits: {
            oneTaskPerRequest: true,
            maxPromptChars: EXTERNAL_MCP_MAX_PROMPT_CHARS,
            maxWaitMs: EXTERNAL_MCP_MAX_WAIT_MS,
            callsPerMinute: context.client.integration.rateLimitPerMinute,
            concurrentAgentTasks: context.client.integration.concurrencyLimit,
          },
          nextSteps,
        });
      }).pipe(Effect.catch((error) => Effect.succeed(externalErrorResult(error)))),
  };

  const createTaskTool: ExternalTool = {
    requiredCapability: "tasks:create",
    definition: {
      name: "synara_create_task",
      description:
        "Create exactly one Synara task in an explicitly allowed project. requestId is a stable idempotency key and cannot be reused with a different plan. Defaults to a managed worktree and approval-required runtime.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string", maxLength: 256 },
          projectId: { type: "string" },
          provider: { type: "string", enum: [...PROVIDER_KINDS] },
          model: { type: "string" },
          options: { type: "object", description: AGENT_GATEWAY_TARGET_OPTIONS_DESCRIPTION },
          prompt: { type: "string", maxLength: EXTERNAL_MCP_MAX_PROMPT_CHARS },
          title: { type: "string", maxLength: 240 },
          environment: { type: "string", enum: ["worktree", "local"] },
          runtimeMode: { type: "string", enum: ["approval-required", "full-access"] },
          baseRef: { type: "string" },
        },
        required: ["requestId", "projectId", "provider", "model", "prompt"],
        additionalProperties: false,
      },
      annotations: {
        title: "Create one Synara task",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const input = yield* decodeExternalCreateTask(args).pipe(
          Effect.mapError((cause) => new ToolInputError(errorText(cause))),
        );
        yield* externalMcp.assertProject(context.client, input.projectId);
        if (input.environment === "local" && !context.client.capabilities.has("runtime:local")) {
          return yield* Effect.fail(
            new GatewayToolError(
              "capability_denied",
              'Local-checkout execution requires the explicit "runtime:local" scope.',
            ),
          );
        }
        if (
          input.runtimeMode === "full-access" &&
          !context.client.capabilities.has("runtime:full-access")
        ) {
          return yield* Effect.fail(
            new GatewayToolError(
              "capability_denied",
              'Full-access execution requires the explicit "runtime:full-access" scope.',
            ),
          );
        }
        return yield* runCreateThreads(
          decodeCreateThreadsInput({
            requestId: input.requestId,
            threads: [
              {
                projectId: input.projectId,
                prompt: input.prompt,
                ...(input.title ? { title: input.title } : {}),
                target: {
                  provider: input.provider,
                  model: input.model,
                  ...(input.options ? { options: input.options } : {}),
                },
                ...(input.environment ? { environment: input.environment } : {}),
                ...(input.runtimeMode ? { runtimeMode: input.runtimeMode } : {}),
                ...(input.baseRef ? { baseRef: input.baseRef } : {}),
              },
            ],
          }),
          {
            kind: "external-client",
            integrationId: context.client.integration.integrationId,
            allowedProjectIds: context.client.allowedProjectIds,
            capabilities: context.client.capabilities,
            assertAuthority: context.assertActive,
          },
        );
      }).pipe(Effect.catch((error) => Effect.succeed(externalErrorResult(error)))),
  };

  const readTaskTool: ExternalTool = {
    requiredCapability: "tasks:read",
    definition: {
      name: "synara_read_task",
      description:
        "Read one task created by this integration, or an allowed-project task when tasks:read-project was explicitly granted. To read one settled long message losslessly, pass the summary's index, messageId, and messageVersion with messageOffsetChars 0, then follow messagePage.nextOffsetChars with the same identity and version.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string" },
          cursor: { type: "string" },
          messageLimit: { type: "integer", minimum: 1, maximum: 100 },
          maxMessageChars: {
            type: "integer",
            minimum: 50,
            maximum: EXTERNAL_MCP_MAX_MESSAGE_CHARS,
            description: `Characters per message or single-message slice (default 1500, max ${EXTERNAL_MCP_MAX_MESSAGE_CHARS}). The response reports the effective value.`,
          },
          messageIndex: {
            type: "integer",
            minimum: 0,
            description:
              "Current transcript index of one message to read losslessly; messageId and messageVersion detect stale coordinates.",
          },
          messageOffsetChars: {
            type: "integer",
            minimum: 0,
            description:
              "Character offset within messageIndex (default 0); follow messagePage.nextOffsetChars until absent.",
          },
          messageId: {
            type: "string",
            description:
              "Message identity returned in each message summary; required with messageIndex.",
          },
          messageVersion: {
            type: "string",
            description:
              "Opaque version returned in each message summary; required with messageIndex so slices stay bound to one snapshot.",
          },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
      annotations: { title: "Read a permitted Synara task", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const input = yield* decodeExternalReadTask(args).pipe(
          Effect.mapError((cause) => new ToolInputError(errorText(cause))),
        );
        yield* externalMcp.assertTaskRead(context.client, input.threadId);
        const detail = yield* snapshotQuery.getThreadDetailById(input.threadId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(new ToolInputError(`Thread "${input.threadId}" was not found.`)),
              onSome: Effect.succeed,
            }),
          ),
        );
        return mcpToolResultJson(
          summarizeThreadDetail({
            thread: detail,
            cursor: input.cursor,
            messageLimit: input.messageLimit,
            maxMessageChars: input.maxMessageChars,
            messageIndex: input.messageIndex,
            messageOffsetChars: input.messageOffsetChars,
            messageId: input.messageId,
            messageVersion: input.messageVersion,
          }),
        );
      }).pipe(Effect.catch((error) => Effect.succeed(externalErrorResult(error)))),
  };

  const waitTaskTool: ExternalTool = {
    requiredCapability: "tasks:wait",
    definition: {
      name: "synara_wait_for_task",
      description:
        "Long-poll one permitted task. The wait never retries, replaces, cancels, or creates work.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string" },
          runId: { type: ["string", "null"] },
          timeoutMs: { type: "integer", minimum: 0, maximum: EXTERNAL_MCP_MAX_WAIT_MS },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
      annotations: { title: "Wait for a permitted Synara task", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const input = yield* decodeExternalWaitTask(args).pipe(
          Effect.mapError((cause) => new ToolInputError(errorText(cause))),
        );
        yield* externalMcp.assertTaskRead(context.client, input.threadId);
        const initial = yield* requireThreadShell(input.threadId);
        const runId = requestedExternalMcpRunId(input, initial.latestTurn?.turnId ?? null);
        const terminalSessionState = terminalExternalMcpSessionStateForRun(initial, runId);
        const initialState: "idle" | "pending" | "running" | "completed" | "error" | "interrupted" =
          terminalSessionState !== null
            ? terminalSessionState
            : runId === null
              ? "pending"
              : initial.latestTurn?.turnId === runId
                ? initial.latestTurn.state
                : "pending";
        const waited = yield* waitForExternalMcpTaskState({
          threadId: input.threadId,
          runId,
          initialState,
          timeoutMs: input.timeoutMs ?? EXTERNAL_MCP_DEFAULT_WAIT_MS,
          assertActive: context.assertActive,
          projectionTurns,
          resolveLatestTurn: () =>
            requireThreadShell(input.threadId).pipe(Effect.map(latestExternalMcpWaitState)),
        });
        let summary: string | null = null;
        let summaryTruncated = false;
        let failure: string | null = null;
        if (waited.terminal) {
          const detail = yield* snapshotQuery.getThreadDetailById(input.threadId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(new ToolInputError(`Thread "${input.threadId}" was not found.`)),
                onSome: Effect.succeed,
              }),
            ),
          );
          const assistant = waited.runId
            ? detail.messages.findLast(
                (message) => message.role === "assistant" && message.turnId === waited.runId,
              )
            : undefined;
          const summarized = summarizeWaitThreadText(assistant?.text);
          summary = summarized.summary;
          summaryTruncated = summarized.truncated;
          failure = waited.state === "error" ? (detail.session?.lastError ?? "Turn failed.") : null;
        }
        yield* context.assertActive();
        return mcpToolResultJson({
          threadId: input.threadId,
          runId: waited.runId,
          state: waited.state,
          terminal: waited.terminal,
          timedOut: waited.timedOut,
          summary,
          summaryTruncated,
          error: failure,
          readTask: { tool: "synara_read_task", arguments: { threadId: input.threadId } },
        });
      }).pipe(Effect.catch((error) => Effect.succeed(externalErrorResult(error)))),
  };

  const tools: ReadonlyArray<ExternalTool> = [
    overviewTool,
    capabilitiesTool,
    projectsTool,
    createTaskTool,
    waitTaskTool,
    readTaskTool,
  ];
  const toolsByName = new Map(tools.map((tool) => [tool.definition.name, tool]));

  const handleRequest = (
    request: JsonRpcRequest,
    client: ExternalMcpVerifiedClient,
  ): Effect.Effect<Record<string, unknown>> => {
    const auditCompletion = makeExternalMcpAuditCompletion(externalMcp.finishAudit);

    return Effect.gen(function* () {
      yield* externalMcp.assertActive(client.integration.integrationId);
      if (request.method === "initialize") {
        return jsonRpcResult(
          request.id,
          buildMcpInitializeResult({
            requestedProtocolVersion: request.params.protocolVersion,
            serverVersion: "1.0.0",
            instructions: EXTERNAL_MCP_INSTRUCTIONS,
          }),
        );
      }
      if (request.method === "ping") return jsonRpcResult(request.id, {});
      if (request.method === "tools/list") {
        return jsonRpcResult(request.id, {
          tools: filterExternalMcpTools(tools, client.capabilities).map((tool) => tool.definition),
        });
      }
      if (request.method !== "tools/call") {
        return jsonRpcError(
          request.id,
          JSON_RPC_METHOD_NOT_FOUND,
          `Method "${request.method}" is not supported.`,
        );
      }
      const toolName = request.params.name;
      if (typeof toolName !== "string") {
        return jsonRpcError(request.id, JSON_RPC_INVALID_PARAMS, "Missing tool name.");
      }
      const rawArgs = request.params.arguments;
      const args =
        typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {};
      const auditId = yield* externalMcp
        .beginAudit(client, readAuditMetadata(toolName, args))
        .pipe(
          Effect.catch((error) =>
            Effect.succeed(error).pipe(
              Effect.flatMap((auditError) =>
                Effect.fail(
                  new GatewayToolError(
                    auditError.code,
                    auditError.message,
                    auditError.status === 429 ? { retryAfterMs: 1_000 } : undefined,
                  ),
                ),
              ),
            ),
          ),
        );
      auditCompletion.markPending({
        auditId,
        outcome: "error",
        detail: "Tool call ended before audit completion.",
      });
      const tool = toolsByName.get(toolName);
      if (!tool) {
        yield* auditCompletion.complete({
          auditId,
          outcome: "error",
          detail: "Unknown external MCP tool.",
        });
        return jsonRpcError(request.id, JSON_RPC_INVALID_PARAMS, `Unknown tool "${toolName}".`);
      }
      if (!client.capabilities.has(tool.requiredCapability)) {
        yield* auditCompletion.complete({
          auditId,
          outcome: "error",
          detail: `Capability denied: ${tool.requiredCapability}.`,
        });
        return jsonRpcResult(
          request.id,
          externalErrorResult(
            new GatewayToolError(
              "capability_denied",
              `This integration is not authorized for ${tool.requiredCapability}.`,
            ),
          ),
        );
      }
      const assertActive = () =>
        externalMcp
          .assertActive(client.integration.integrationId)
          .pipe(Effect.mapError((error) => new GatewayToolError(error.code, error.message)));
      const context: ExternalToolContext = {
        principal: {
          kind: "external-client",
          integrationId: client.integration.integrationId,
          name: client.integration.name,
        },
        client,
        jsonRpcRequestId: request.id,
        assertActive,
      };
      const result = yield* Effect.suspend(() => tool.handler(args, context)).pipe(
        Effect.catchDefect((defect) => Effect.succeed(mcpToolResultError(errorText(defect)))),
      );
      yield* auditCompletion.complete({
        auditId,
        outcome: result.isError ? "error" : "success",
        createdTaskIds: toolName === "synara_create_task" ? createdThreadIds(result) : [],
        ...(result.isError ? { detail: "Tool call returned an MCP error." } : {}),
      });
      return jsonRpcResult(request.id, result);
    }).pipe(
      Effect.onExit(auditCompletion.retryPending),
      Effect.catch((error) =>
        Effect.succeed(jsonRpcResult(request.id, externalErrorResult(error))),
      ),
    );
  };

  const handleVerifiedPost: ExternalMcpGatewayShape["handleVerifiedPost"] = (requestInput) =>
    Effect.gen(function* () {
      const rawMessages = Array.isArray(requestInput.body)
        ? requestInput.body
        : [requestInput.body];
      if (rawMessages.length === 0 || rawMessages.length > MCP_MAX_BATCH_MESSAGES) {
        return {
          status: 400,
          body: jsonRpcError(
            null,
            JSON_RPC_INVALID_REQUEST,
            rawMessages.length === 0
              ? "Empty JSON-RPC batch."
              : `JSON-RPC batches may contain at most ${MCP_MAX_BATCH_MESSAGES} messages.`,
          ),
        };
      }
      const responses: Array<Record<string, unknown>> = [];
      const ids = new Set<string>();
      for (const raw of rawMessages) {
        const parsed = parseMcpMessage(raw);
        if (parsed.kind === "request") {
          const idKey = `${typeof parsed.request.id}:${String(parsed.request.id)}`;
          if (ids.has(idKey)) {
            return {
              status: 400,
              body: jsonRpcError(
                parsed.request.id,
                JSON_RPC_INVALID_REQUEST,
                `Duplicate JSON-RPC request id ${JSON.stringify(parsed.request.id)} in one batch.`,
              ),
            };
          }
          ids.add(idKey);
          responses.push(yield* handleRequest(parsed.request, requestInput.client));
        } else if (parsed.kind === "invalid") {
          responses.push(
            jsonRpcError(parsed.id, JSON_RPC_INVALID_REQUEST, "Invalid JSON-RPC message."),
          );
        }
      }
      if (responses.length === 0) return { status: 202 };
      return {
        status: 200,
        body: Array.isArray(requestInput.body) ? responses : responses[0],
      };
    });

  const handlePost: ExternalMcpGatewayShape["handlePost"] = (requestInput) =>
    Effect.gen(function* () {
      const token = extractBearerToken(requestInput.authorizationHeader);
      if (!token) {
        return {
          status: 401,
          body: jsonRpcError(
            null,
            JSON_RPC_INVALID_REQUEST,
            "external_credential_invalid: Missing external MCP credential.",
          ),
        };
      }
      const verification = yield* verifyExternalMcpTransportCredential(externalMcp, token);
      if (verification.kind === "invalid") {
        return {
          status: 401,
          body: jsonRpcError(
            null,
            JSON_RPC_INVALID_REQUEST,
            "external_credential_invalid: Missing, expired, revoked, or invalid external MCP credential.",
          ),
        };
      }
      if (verification.kind === "unavailable") {
        return {
          status: 503,
          body: jsonRpcError(
            null,
            -32603,
            "external_service_unavailable: External MCP credential verification is temporarily unavailable.",
          ),
        };
      }
      return yield* handleVerifiedPost({
        client: verification.client,
        body: requestInput.body,
      });
    });

  return { handlePost, handleVerifiedPost } satisfies ExternalMcpGatewayShape;
});

export const ExternalMcpGatewayLive = Layer.effect(ExternalMcpGateway, makeExternalMcpGateway);

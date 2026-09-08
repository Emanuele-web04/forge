import { ThreadId, type OrchestrationThreadShell } from "@synara/contracts";
import { Cause, Deferred, Effect, Exit, Fiber, Option } from "effect";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { AgentGatewayShape } from "./Services/AgentGateway.ts";
import type { AgentGatewayCredentialsShape } from "./Services/AgentGatewayCredentials.ts";
import { extractBearerToken } from "./bearerToken.ts";
import {
  buildMcpInitializeResult,
  jsonRpcError,
  jsonRpcResult,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  mcpToolResultError,
  parseMcpMessage,
  type JsonRpcId,
  type JsonRpcRequest,
} from "./protocol.ts";
import { sanitizeToolInputSchema } from "./sanitizeToolInputSchema.ts";
import {
  filterToolsByCapability,
  GatewayToolError,
  gatewayToolErrorResult,
  type ToolContext,
  type ToolEntry,
} from "./toolRuntime.ts";
import { errorText } from "./toolInput.ts";

const MCP_MAX_BATCH_MESSAGES = 50;

type McpJsonRpcResponse = Record<string, unknown>;

type McpResponseSlot =
  | { readonly kind: "immediate"; readonly response: McpJsonRpcResponse }
  | {
      readonly kind: "request";
      readonly fiber: Fiber.Fiber<McpJsonRpcResponse, never>;
    }
  | { readonly kind: "none" };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function invalidRequestResponse(
  status: number,
  message: string,
  id: JsonRpcId = null,
): { readonly status: number; readonly body: McpJsonRpcResponse } {
  return {
    status,
    body: jsonRpcError(id, JSON_RPC_INVALID_REQUEST, message),
  };
}

function requestIdKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

export function makeAgentGatewayMcpTransport(input: {
  readonly credentials: AgentGatewayCredentialsShape;
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly tools: ReadonlyArray<ToolEntry>;
  readonly instructions: string;
  readonly requireThreadShell: (
    threadId: string,
  ) => Effect.Effect<OrchestrationThreadShell, unknown>;
  // Lets the gateway surface a capability denial to the user (e.g. as a thread
  // activity). Must not fail; the denial response is returned regardless.
  readonly onCapabilityDenied?: (denial: {
    readonly toolName: string;
    readonly requiredCapability: string;
    readonly callerThreadId: string;
    readonly callerTurnId: string | null;
  }) => Effect.Effect<void>;
}): AgentGatewayShape["handleMcpPost"] {
  const toolsByName = new Map(input.tools.map((tool) => [tool.definition.name, tool]));
  const handleRequest = (request: JsonRpcRequest, context: Omit<ToolContext, "jsonRpcRequestId">) =>
    Effect.gen(function* () {
      switch (request.method) {
        case "initialize":
          return jsonRpcResult(
            request.id,
            buildMcpInitializeResult({
              requestedProtocolVersion: request.params.protocolVersion,
              serverVersion: "1.0.0",
              instructions: input.instructions,
            }),
          );
        case "ping":
          return jsonRpcResult(request.id, {});
        case "tools/list":
          return jsonRpcResult(request.id, {
            tools: filterToolsByCapability(input.tools, context.callerCapabilities).map((tool) => ({
              ...tool.definition,
              // SAFETY: ToolEntry.inputSchema is typed Record<string, unknown>; the sanitizer
              // returns a fresh object for object input, so this restores the static type.
              inputSchema: sanitizeToolInputSchema(tool.definition.inputSchema) as Record<
                string,
                unknown
              >,
            })),
          });
        case "tools/call": {
          const toolName = request.params.name;
          if (typeof toolName !== "string") {
            return jsonRpcError(request.id, JSON_RPC_INVALID_PARAMS, "Missing tool name.");
          }
          const tool = toolsByName.get(toolName);
          if (!tool) {
            return jsonRpcError(request.id, JSON_RPC_INVALID_PARAMS, `Unknown tool "${toolName}".`);
          }
          const rawArgs = request.params.arguments;
          const args = asRecord(rawArgs) ?? {};
          const requiredCapability = tool.requiredCapability;
          if (!context.callerCapabilities.has(requiredCapability)) {
            if (input.onCapabilityDenied) {
              yield* input.onCapabilityDenied({
                toolName,
                requiredCapability,
                callerThreadId: context.callerThreadId,
                callerTurnId: context.callerTurnId,
              });
            }
            return jsonRpcResult(
              request.id,
              gatewayToolErrorResult(
                new GatewayToolError(
                  "capability_denied",
                  `This provider session is not authorized for ${requiredCapability}.`,
                  { requiredCapability },
                ),
              ),
            );
          }
          const invocationContext: ToolContext = {
            ...context,
            jsonRpcRequestId: request.id,
          };
          if (tool.requiresActiveTurn) {
            const authorityError = yield* context.assertCallerTurnActive().pipe(
              Effect.match({
                onFailure: (error) => error,
                onSuccess: () => null,
              }),
            );
            if (authorityError !== null) {
              return jsonRpcResult(request.id, gatewayToolErrorResult(authorityError));
            }
          }
          const result = yield* Effect.suspend(() => tool.handler(args, invocationContext)).pipe(
            Effect.catchDefect((defect) => Effect.succeed(mcpToolResultError(errorText(defect)))),
          );
          return jsonRpcResult(request.id, result);
        }
        default:
          return jsonRpcError(
            request.id,
            JSON_RPC_METHOD_NOT_FOUND,
            `Method "${request.method}" is not supported.`,
          );
      }
    });

  return (requestInput) =>
    Effect.gen(function* () {
      const token = extractBearerToken(requestInput.authorizationHeader);
      const callerSession = token ? input.credentials.verifySession(token) : null;
      if (!token || !callerSession) {
        return invalidRequestResponse(
          401,
          "caller_session_inactive: Missing, revoked, or invalid provider-session credential.",
        );
      }
      const callerThreadId = callerSession.threadId;
      const callerThread = yield* input.snapshotQuery
        .getThreadShellById(ThreadId.makeUnsafe(callerThreadId))
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      if (Option.isNone(callerThread)) {
        return invalidRequestResponse(
          401,
          "Bearer token refers to a thread that no longer exists.",
        );
      }
      const liveProvider = callerThread.value.session?.providerName;
      if ((liveProvider ?? callerThread.value.modelSelection.provider) !== callerSession.provider) {
        return invalidRequestResponse(
          401,
          "caller_session_inactive: Provider session no longer owns this thread.",
        );
      }
      const callerWriteAuthority =
        callerThread.value.latestTurn?.state === "running"
          ? input.credentials.bindWriteAuthority(token, callerThread.value.latestTurn.turnId)
          : null;
      const assertCallerTurnActive = () =>
        Effect.gen(function* () {
          if (callerWriteAuthority === null) {
            return yield* Effect.fail(
              new GatewayToolError(
                "caller_turn_inactive",
                "This Synara write was rejected because this credential had no write authority for the exact active turn when the MCP request arrived.",
                {
                  callerThreadId,
                  latestTurnId: callerThread.value.latestTurn?.turnId ?? null,
                },
              ),
            );
          }
          if (!input.credentials.verifyWriteAuthority(callerWriteAuthority)) {
            return yield* Effect.fail(
              new GatewayToolError(
                "caller_session_inactive",
                "This Synara write was rejected because its provider-session authority is no longer active.",
                { callerThreadId },
              ),
            );
          }
          const caller = yield* input
            .requireThreadShell(callerThreadId)
            .pipe(
              Effect.mapError(
                (error) =>
                  new GatewayToolError(
                    "caller_turn_inactive",
                    "This Synara write was rejected because the caller thread could no longer be verified.",
                    { callerThreadId, error: errorText(error) },
                  ),
              ),
            );
          if (
            caller.latestTurn?.state !== "running" ||
            caller.latestTurn.turnId !== callerWriteAuthority.turnId
          ) {
            return yield* Effect.fail(
              new GatewayToolError(
                "caller_turn_inactive",
                "This Synara write was rejected because the turn that received this MCP request is no longer active. In-flight requests cannot inherit authority from a later turn.",
                {
                  callerThreadId,
                  authorizedTurnId: callerWriteAuthority.turnId,
                  latestTurnId: caller.latestTurn?.turnId ?? null,
                  latestTurnState: caller.latestTurn?.state ?? null,
                },
              ),
            );
          }
        });
      const context: Omit<ToolContext, "jsonRpcRequestId"> = {
        principal: {
          kind: "provider-session",
          sessionKey: callerSession.sessionKey,
          threadId: callerThreadId,
          provider: callerSession.provider,
          turnId: callerWriteAuthority?.turnId ?? null,
        },
        callerThreadId,
        // The nickname first: a subagent that has one is known by it, and its
        // title describes the work rather than who is doing it.
        callerThreadLabel: callerThread.value.subagentNickname ?? callerThread.value.title ?? null,
        callerSessionKey: callerSession.sessionKey,
        callerProvider: callerSession.provider,
        callerCapabilities: callerSession.capabilities,
        callerTurnId: callerWriteAuthority?.turnId ?? null,
        assertCallerTurnActive,
      };

      const rawMessages = Array.isArray(requestInput.body)
        ? requestInput.body
        : [requestInput.body];
      if (rawMessages.length === 0) {
        return invalidRequestResponse(400, "Empty JSON-RPC batch.");
      }
      if (rawMessages.length > MCP_MAX_BATCH_MESSAGES) {
        return invalidRequestResponse(
          400,
          `JSON-RPC batches may contain at most ${MCP_MAX_BATCH_MESSAGES} messages.`,
        );
      }
      const parsedMessages = rawMessages.map(parseMcpMessage);
      const requestIds = new Set<string>();
      for (const parsed of parsedMessages) {
        if (parsed.kind !== "request") continue;
        const key = requestIdKey(parsed.request.id);
        if (requestIds.has(key)) {
          return invalidRequestResponse(
            400,
            `Duplicate JSON-RPC request id ${JSON.stringify(parsed.request.id)} in one batch.`,
            parsed.request.id,
          );
        }
        requestIds.add(key);
      }
      const responseSlots: McpResponseSlot[] = [];
      const cancellationRequestIds: Array<string | number> = [];

      // Start every request before awaiting any of them. Apart from avoiding
      // head-of-line blocking for ordinary batches, this guarantees that a
      // cancellation notification in the same batch can see its target even
      // when the notification appears first.
      for (const parsed of parsedMessages) {
        switch (parsed.kind) {
          case "request": {
            const registered = yield* Deferred.make<void>();
            let unregister: () => void = () => undefined;
            let requestStarted = false;
            let cancellationRequested = false;
            const requestEffect = Deferred.await(registered).pipe(
              Effect.andThen(handleRequest(parsed.request, context)),
              Effect.catch((error) =>
                Effect.succeed(
                  jsonRpcResult(parsed.request.id, mcpToolResultError(errorText(error))),
                ),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  unregister();
                }),
              ),
            );
            const fiber = yield* requestEffect.pipe(Effect.forkChild({ startImmediately: true }));
            unregister = input.credentials.registerInFlightRequest({
              sessionKey: callerSession.sessionKey,
              turnId: context.callerTurnId,
              requestId: parsed.request.id,
              cancel: () => {
                cancellationRequested = true;
                if (!requestStarted) return Promise.resolve();
                return new Promise<void>((resolve) => {
                  // Avoid interrupting re-entrantly while an async Effect is
                  // still installing its AbortController finalizer. The fiber
                  // observer is the cleanup barrier returned to Stop.
                  queueMicrotask(() => {
                    if (fiber.pollUnsafe() !== undefined) {
                      resolve();
                      return;
                    }
                    fiber.addObserver(() => resolve());
                    fiber.interruptUnsafe();
                  });
                });
              },
            });
            if (cancellationRequested) {
              // A terminal-turn tombstone cancelled this request during
              // registration. The handler is still fenced behind `registered`,
              // so a direct interruption is safe and no browser work can start.
              fiber.interruptUnsafe();
            } else {
              requestStarted = true;
              yield* Deferred.succeed(registered, undefined);
            }
            responseSlots.push({ kind: "request", fiber });
            break;
          }
          case "notification": {
            if (parsed.notification.method === "notifications/cancelled") {
              const cancelledId = parsed.notification.params.requestId;
              if (typeof cancelledId === "string" || typeof cancelledId === "number") {
                cancellationRequestIds.push(cancelledId);
              }
            }
            responseSlots.push({ kind: "none" });
            break;
          }
          case "response":
            responseSlots.push({ kind: "none" });
            break;
          case "invalid":
            responseSlots.push({
              kind: "immediate",
              response: jsonRpcError(
                parsed.id,
                JSON_RPC_INVALID_REQUEST,
                "Invalid JSON-RPC message.",
              ),
            });
            break;
        }
      }

      for (const cancelledId of cancellationRequestIds) {
        input.credentials.cancelInFlightRequests({
          sessionKey: callerSession.sessionKey,
          requestId: cancelledId,
        });
      }

      const resolvedResponses = yield* Effect.forEach(
        responseSlots,
        (slot) => {
          if (slot.kind === "none") return Effect.succeed(null);
          if (slot.kind === "immediate") return Effect.succeed(slot.response);
          return Fiber.await(slot.fiber).pipe(
            Effect.map((exit) =>
              Exit.match(exit, {
                onFailure: (cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? null
                    : jsonRpcResult(null, mcpToolResultError(Cause.pretty(cause))),
                onSuccess: (response) => response,
              }),
            ),
          );
        },
        { concurrency: "unbounded" },
      );
      const responses = resolvedResponses.filter(
        (response): response is McpJsonRpcResponse => response !== null,
      );
      if (responses.length === 0) return { status: 202 };
      return {
        status: 200,
        body: Array.isArray(requestInput.body) ? responses : responses[0],
      };
    });
}

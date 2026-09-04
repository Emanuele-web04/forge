import {
  MIND_MEMORY_TEXT_MAX_CHARS,
  MindError,
  MindMemoryId,
  ThreadId,
  TurnId,
  type MindConfirmInput,
  type MindConfirmResult,
  type MindForgetInput,
  type MindForgetResult,
  type MindPruneInput,
  type MindPruneResult,
  type MindRecallInput,
  type MindRecallResult,
  type MindRememberInput,
  type MindRememberResult,
} from "@synara/contracts";
import type { OrchestrationThreadShell, ProjectId } from "@synara/contracts";
import { Effect } from "effect";

import { MindService, type MindServiceShape } from "../mind/Services/MindService.ts";
import { mcpToolResultJson } from "./protocol.ts";
import { errorText, readStringArg, ToolInputError } from "./toolInput.ts";
import {
  GatewayToolError,
  gatewayToolErrorResult,
  type ToolContext,
  type ToolEntry,
} from "./toolRuntime.ts";

export { MindService, MIND_MEMORY_TEXT_MAX_CHARS };
export type { MindServiceShape };

export interface AgentGatewayMemoryToolDependencies {
  readonly mindService: MindServiceShape;
  readonly requireThreadShell: (
    threadId: string,
  ) => Effect.Effect<OrchestrationThreadShell, unknown>;
}

function toGatewayToolError(error: unknown): GatewayToolError {
  if (error instanceof GatewayToolError) return error;
  if (error instanceof ToolInputError) {
    return new GatewayToolError("invalid_input", error.message);
  }
  if (error instanceof MindError) {
    return new GatewayToolError(error.code, error.message);
  }
  if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
    return new GatewayToolError(String(error.code), String(error.message));
  }
  return new GatewayToolError("mind_error", errorText(error));
}

function decodeStringArg(
  args: Record<string, unknown>,
  name: string,
  options?: { readonly required?: boolean },
): Effect.Effect<string | undefined, ToolInputError> {
  return Effect.try({
    try: () => readStringArg(args, name, options),
    catch: (error) =>
      error instanceof ToolInputError
        ? error
        : new ToolInputError(
            typeof error === "object" && error !== null && "message" in error
              ? String((error as Error).message)
              : errorText(error),
          ),
  });
}

function resolveProjectId(
  context: ToolContext,
  requireThreadShell: AgentGatewayMemoryToolDependencies["requireThreadShell"],
): Effect.Effect<ProjectId, unknown> {
  return requireThreadShell(context.callerThreadId).pipe(Effect.map((thread) => thread.projectId));
}

function makeRememberInput(
  projectId: ProjectId,
  context: ToolContext,
  text: string,
): MindRememberInput {
  return {
    projectId,
    threadId: ThreadId.makeUnsafe(context.callerThreadId),
    turnId: context.callerTurnId ? TurnId.makeUnsafe(context.callerTurnId) : undefined,
    text,
  };
}

function makeConfirmInput(
  projectId: ProjectId,
  context: ToolContext,
  memoryId: string,
): MindConfirmInput {
  return {
    projectId,
    memoryId: MindMemoryId.makeUnsafe(memoryId),
    turnId: context.callerTurnId ? TurnId.makeUnsafe(context.callerTurnId) : undefined,
  };
}

function makeForgetInput(
  projectId: ProjectId,
  context: ToolContext,
  memoryId: string,
): MindForgetInput {
  return {
    projectId,
    memoryId: MindMemoryId.makeUnsafe(memoryId),
    turnId: context.callerTurnId ? TurnId.makeUnsafe(context.callerTurnId) : undefined,
  };
}

function makeRecallInput(projectId: ProjectId, query: string | undefined): MindRecallInput {
  return {
    projectId,
    ...(query !== undefined ? { query } : {}),
  };
}

function makePruneInput(projectId: ProjectId): MindPruneInput {
  return { projectId };
}

function rememberPayload(result: MindRememberResult) {
  return { memoryId: result.memory.memoryId, status: result.status };
}

function confirmPayload(result: MindConfirmResult) {
  return { memory: result.memory };
}

function forgetPayload(result: MindForgetResult) {
  return { deleted: result.deleted };
}

function prunePayload(result: MindPruneResult) {
  return { deletedIds: result.deletedIds };
}

export function makeAgentGatewayMemoryTools(
  dependencies: AgentGatewayMemoryToolDependencies,
): Record<string, ToolEntry> {
  const { mindService, requireThreadShell } = dependencies;

  const remember: ToolEntry = {
    requiredCapability: "memory:use",
    requiresActiveTurn: true,
    definition: {
      name: "synara_remember",
      description:
        "Remember a durable, project-scoped fact. Repeating the same text in one project reinforces the existing memory.",
      inputSchema: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: `The fact to remember. Max ${MIND_MEMORY_TEXT_MAX_CHARS} characters.`,
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const text = (yield* decodeStringArg(args, "text", { required: true }))!;
        if (text.length > MIND_MEMORY_TEXT_MAX_CHARS) {
          return yield* Effect.fail(
            new ToolInputError(
              `Argument "text" must be at most ${MIND_MEMORY_TEXT_MAX_CHARS} characters.`,
            ),
          );
        }
        const projectId = yield* resolveProjectId(context, requireThreadShell);
        const input = makeRememberInput(projectId, context, text);
        const result = yield* mindService.remember(input);
        return mcpToolResultJson(rememberPayload(result));
      }).pipe(
        Effect.catch((error) => Effect.succeed(gatewayToolErrorResult(toGatewayToolError(error)))),
      ),
  };

  const recallMemories: ToolEntry = {
    requiredCapability: "memory:use",
    requiresActiveTurn: false,
    definition: {
      name: "synara_recall_memories",
      description:
        "Recall up to 8 relevant project memories, optionally filtered by a query. Returns a concise digest.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional search query." },
        },
        additionalProperties: false,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const query = yield* decodeStringArg(args, "query");
        const projectId = yield* resolveProjectId(context, requireThreadShell);
        const input = makeRecallInput(projectId, query);
        const result = yield* mindService.recall(input);
        return mcpToolResultJson(result);
      }).pipe(
        Effect.catch((error) => Effect.succeed(gatewayToolErrorResult(toGatewayToolError(error)))),
      ),
  };

  const confirmMemory: ToolEntry = {
    requiredCapability: "memory:use",
    requiresActiveTurn: true,
    definition: {
      name: "synara_confirm_memory",
      description:
        "Confirm a memory is still accurate, raising its weight by up to 0.15 and resetting decay.",
      inputSchema: {
        type: "object",
        properties: {
          memory_id: { type: "string" },
        },
        required: ["memory_id"],
        additionalProperties: false,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const memoryId = (yield* decodeStringArg(args, "memory_id", { required: true }))!;
        const projectId = yield* resolveProjectId(context, requireThreadShell);
        const input = makeConfirmInput(projectId, context, memoryId);
        const result = yield* mindService.confirm(input);
        return mcpToolResultJson(confirmPayload(result));
      }).pipe(
        Effect.catch((error) => Effect.succeed(gatewayToolErrorResult(toGatewayToolError(error)))),
      ),
  };

  const forgetMemory: ToolEntry = {
    requiredCapability: "memory:use",
    requiresActiveTurn: true,
    definition: {
      name: "synara_forget_memory",
      description: "Permanently remove a memory.",
      inputSchema: {
        type: "object",
        properties: {
          memory_id: { type: "string" },
        },
        required: ["memory_id"],
        additionalProperties: false,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const memoryId = (yield* decodeStringArg(args, "memory_id", { required: true }))!;
        const projectId = yield* resolveProjectId(context, requireThreadShell);
        const input = makeForgetInput(projectId, context, memoryId);
        const result = yield* mindService.forget(input);
        return mcpToolResultJson(forgetPayload(result));
      }).pipe(
        Effect.catch((error) => Effect.succeed(gatewayToolErrorResult(toGatewayToolError(error)))),
      ),
  };

  const pruneMemories: ToolEntry = {
    requiredCapability: "memory:use",
    requiresActiveTurn: true,
    definition: {
      name: "synara_prune_memories",
      description:
        "Remove stale, low-weight, unconfirmed memories from this project. Safe to call automatically.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    handler: (_args, context) =>
      Effect.gen(function* () {
        const projectId = yield* resolveProjectId(context, requireThreadShell);
        const result = yield* mindService.prune(makePruneInput(projectId));
        return mcpToolResultJson(prunePayload(result));
      }).pipe(
        Effect.catch((error) => Effect.succeed(gatewayToolErrorResult(toGatewayToolError(error)))),
      ),
  };

  return {
    synara_remember: remember,
    synara_recall_memories: recallMemories,
    synara_confirm_memory: confirmMemory,
    synara_forget_memory: forgetMemory,
    synara_prune_memories: pruneMemories,
  };
}

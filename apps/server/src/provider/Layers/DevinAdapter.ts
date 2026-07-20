/**
 * DevinAdapterLive — Devin CLI (`devin acp`) via ACP.
 *
 * A thin adapter around `AcpSessionRuntime` that reuses the shared ACP
 * lifecycle, permission, and event-stream plumbing.
 *
 * @module DevinAdapterLive
 */
import * as nodePath from "node:path";

import {
  ApprovalRequestId,
  type DevinModelOptions,
  EventId,
  MODEL_OPTIONS_BY_PROVIDER,
  type ProviderApprovalDecision,
  type ProviderComposerCapabilities,
  type ProviderInteractionMode,
  type ProviderListModelsResult,
  type ProviderModelDescriptor,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
  TurnId,
  type ChatAttachment,
} from "@synara/contracts";
import {
  getModelCapabilities,
  getProviderOptionDescriptors,
  resolveModelSlug,
} from "@synara/shared/model";
import {
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  PubSub,
  Random,
  Scope,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import { buildAcpSynaraMcpServers } from "../../agentGateway/mcpInjection.ts";
import {
  type SynaraHarnessPolicyDeliveryState,
  takeSynaraHarnessPolicyTextPartForProviderSession,
} from "../../agentGateway/harnessPolicy.ts";
import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import {
  acquireAgentGatewaySessionLease,
  startAgentGatewaySessionLeaseExitWatcher,
  type AgentGatewaySessionLease,
} from "../../agentGateway/sessionLease.ts";
import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { loadProviderPromptImageBlocks } from "../promptAttachments.ts";
import {
  ProviderAdapterError,
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  classifyAcpPromptTurnCompletion,
  mapAcpToAdapterError,
  readAcpFailedToolDetail,
  selectAcpFullAccessPermissionOptionId,
  selectAcpPermissionOptionId,
} from "../acp/AcpAdapterSupport.ts";
import {
  acceptAcpPlanUpdate,
  makeAcpThreadLock,
  readAcpUsdCost,
  settleAcpPendingApprovalsAsCancelled,
  settleAcpPendingUserInputsAsEmptyAnswers,
} from "../acp/AcpAdapterSessionSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpTokenUsageEvent,
  makeAcpToolCallEvent,
  stampAcpRuntimeEventLifecycleGeneration,
} from "../acp/AcpCoreRuntimeEvents.ts";
import {
  type AcpPlanUpdate,
  type AcpSessionMode,
  type AcpSessionModeState,
  collectSessionConfigOptionValues,
  findSessionConfigOption,
  parsePermissionRequest,
} from "../acp/AcpRuntimeModel.ts";
import {
  type AcpSessionRuntimeShape,
  flattenSessionConfigSelectOptions,
} from "../acp/AcpSessionRuntime.ts";
import {
  forkAcpTurnIdleWatchdog,
  isAcpTurnProgressEventTag,
  resolveAcpTurnIdleTimeoutMs,
} from "../acp/AcpTurnIdleWatchdog.ts";
import { makeAcpNativeLoggers } from "../acp/AcpNativeLogging.ts";
import {
  elicitationQuestionsFromRequest,
  elicitationResponseFromAnswers,
} from "../acp/AcpElicitationSupport.ts";
import {
  type DevinAcpRuntimeSettings,
  makeDevinAcpRuntime,
  resolveDevinAcpAuthMethodIdForDiscovery,
} from "../acp/DevinAcpSupport.ts";
import { makeEventNdjsonLogger, type EventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import {
  type ProviderThreadSnapshot,
  type ProviderThreadTurnSnapshot,
} from "../Services/ProviderAdapter.ts";
import { DevinAdapter, type DevinAdapterShape } from "../Services/DevinAdapter.ts";

const PROVIDER = "devin" as const;
const DEVIN_RESUME_VERSION = 1 as const;

const DEVIN_TURN_IDLE_TIMEOUT_MS = resolveAcpTurnIdleTimeoutMs({
  envVar: "SYNARA_DEVIN_TURN_IDLE_TIMEOUT_MS",
  defaultMs: 10 * 60 * 1000,
});
const DEVIN_TURN_WATCHDOG_INTERVAL_MS = 5_000;
const DEVIN_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

const ACP_PLAN_MODE_ALIASES = ["plan", "architect"] as const;
const ACP_APPROVAL_MODE_ALIASES = ["ask", "approval", "confirm"] as const;
const ACP_IMPLEMENT_MODE_ALIASES = [
  "code",
  "agent",
  "implement",
  "chat",
  "work",
  "default",
] as const;

const DEVIN_PLAN_MODE_PROMPT_PREFIX = [
  "Devin plan mode is active.",
  "Do not implement or mutate files in this turn.",
  "Do not ask follow-up questions or wait for confirmation; if scope is ambiguous, choose a reasonable default and state the assumption in the plan.",
  "When ready, create the final implementation plan.",
].join("\n");

interface DevinAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface DevinSessionContext extends SynaraHarnessPolicyDeliveryState {
  readonly threadId: ThreadId;
  readonly lifecycleGeneration: string | undefined;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  turns: Array<ProviderThreadTurnSnapshot>;
  assistantItemTurnIds: Map<string, TurnId>;
  activeInteractionMode: ProviderInteractionMode | undefined;
  activeTurnId: TurnId | undefined;
  activeTurnFailedToolDetail: string | undefined;
  activePromptFiber: Fiber.Fiber<void, never> | undefined;
  lastPlanFingerprint: string | undefined;
  lastTurnActivityAt: number | undefined;
  latestSessionCostUsd: number | undefined;
  stopped: boolean;
  gatewaySessionLease: AgentGatewaySessionLease | undefined;
}

function resolveDevinSessionCwd(
  inputCwd: string | undefined,
  serverConfig: ServerConfigShape,
): string | undefined {
  const requestedCwd = inputCwd?.trim();
  if (requestedCwd) {
    return nodePath.resolve(requestedCwd);
  }

  const fallbackCwd = serverConfig.cwd.trim() || serverConfig.homeDir.trim();
  return fallbackCwd ? nodePath.resolve(fallbackCwd) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDevinResume(resumeCursor: unknown): { readonly sessionId: string } | undefined {
  if (!isRecord(resumeCursor)) {
    return undefined;
  }
  const schemaVersion = resumeCursor.schemaVersion;
  const sessionId = resumeCursor.sessionId;
  if (
    schemaVersion !== DEVIN_RESUME_VERSION ||
    typeof sessionId !== "string" ||
    !sessionId.trim()
  ) {
    return undefined;
  }
  return { sessionId: sessionId.trim() };
}

function normalizeModeToken(value: string): string {
  return value.toLowerCase().trim().replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

function tokenizeMode(value: string): ReadonlyArray<string> {
  const normalized = normalizeModeToken(value);
  return normalized.length === 0 ? [] : normalized.split(" ");
}

function findModeByExactNormalizedAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const normalizedAliases = aliases.map(normalizeModeToken);
  return modes.find((mode) => {
    const normalizedId = normalizeModeToken(mode.id);
    const normalizedName = normalizeModeToken(mode.name);
    return normalizedAliases.some((alias) => normalizedId === alias || normalizedName === alias);
  });
}

function findModeByWholeTokenAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const aliasTokens = aliases.flatMap(tokenizeMode);
  return modes.find((mode) => {
    const modeTokens = new Set([...tokenizeMode(mode.id), ...tokenizeMode(mode.name)]);
    return aliasTokens.some((token) => modeTokens.has(token));
  });
}

export function resolveRequestedModeId(input: {
  readonly modeState: AcpSessionModeState | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
}): Effect.Effect<string | undefined, ProviderAdapterValidationError> {
  return Effect.gen(function* () {
    const { modeState, runtimeMode, interactionMode } = input;

    if (interactionMode === "plan" && !modeState) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "resolveRequestedModeId",
        issue: "Plan mode requires the ACP session to expose modes, but none were reported.",
      });
    }

    if (!modeState) {
      return undefined;
    }

    const aliases =
      interactionMode === "plan"
        ? ACP_PLAN_MODE_ALIASES
        : runtimeMode === "approval-required"
          ? ACP_APPROVAL_MODE_ALIASES
          : ACP_IMPLEMENT_MODE_ALIASES;

    // For plan mode, only an exact normalized id or name match is considered a safe
    // boundary; whole-token matching is too permissive for a fail-closed gate.
    const targetMode =
      interactionMode === "plan"
        ? findModeByExactNormalizedAliases(modeState.availableModes, aliases)
        : (findModeByExactNormalizedAliases(modeState.availableModes, aliases) ??
          findModeByWholeTokenAliases(modeState.availableModes, aliases));

    if (!targetMode) {
      const requiredBy =
        interactionMode === "plan" ? "plan interaction mode" : `runtime mode "${runtimeMode}"`;
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "resolveRequestedModeId",
        issue: `Requested ${requiredBy} does not match any available ACP mode. Available modes: ${modeState.availableModes
          .map((mode) => `${mode.id} (${mode.name})`)
          .join(", ")}`,
      });
    }

    return targetMode.id === modeState.currentModeId ? undefined : targetMode.id;
  });
}

export function findModelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | undefined,
): EffectAcpSchema.SessionConfigOption | undefined {
  if (!configOptions) {
    return undefined;
  }
  const normalize = (value: string) => value.trim().toLowerCase().replace(/[-_]/g, "");
  return configOptions.find((option) => {
    const category = option.category?.trim().toLowerCase().replace(/[-_]/g, "");
    if (category === "model" || category === "selectedmodel") return true;
    const idNorm = normalize(option.id);
    return idNorm === "model" || idNorm === "selectedmodel";
  });
}

const DEVIN_OPTION_ALIASES: Record<keyof DevinModelOptions, ReadonlyArray<string>> = {
  reasoningEffort: ["reasoning_effort", "reasoning", "reason", "thought_level"],
  fastMode: ["fast_mode", "fast"],
  thinking: ["thinking"],
  contextWindow: ["context_window", "context"],
  variant: ["variant"],
};

function optionIdOrCategoryMatchesAny(
  option: EffectAcpSchema.SessionConfigOption,
  aliases: ReadonlyArray<string>,
): boolean {
  const normalize = (value: string) => value.trim().toLowerCase().replace(/[-_]/g, "");
  const idNorm = normalize(option.id);
  const categoryNorm = option.category ? normalize(option.category) : "";
  return aliases.some((alias) => {
    const aliasNorm = normalize(alias);
    return idNorm === aliasNorm || categoryNorm === aliasNorm;
  });
}

function findDevinConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | undefined,
  key: keyof DevinModelOptions,
): EffectAcpSchema.SessionConfigOption | undefined {
  if (!configOptions) {
    return undefined;
  }
  return configOptions.find((option) =>
    optionIdOrCategoryMatchesAny(option, DEVIN_OPTION_ALIASES[key]),
  );
}

function normalizeDevinConfigOptionValue(
  value: unknown,
  option: EffectAcpSchema.SessionConfigOption,
): string | boolean | undefined {
  if (option.type === "boolean") {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const lower = value.toLowerCase();
      if (lower === "true" || lower === "1" || lower === "on") return true;
      if (lower === "false" || lower === "0" || lower === "off") return false;
    }
    return undefined;
  }
  if (option.type === "select") {
    const candidates = collectSessionConfigOptionValues(option);
    const str = String(value);
    const canonical = candidates.find(
      (candidate) => String(candidate).toLowerCase() === str.toLowerCase(),
    );
    if (canonical !== undefined) {
      return String(canonical);
    }
    return undefined;
  }
  return undefined;
}

function configOptionCurrentValueMatches(
  configOption: EffectAcpSchema.SessionConfigOption,
  value: string | boolean,
): boolean {
  const currentValue = configOption.currentValue;
  if (configOption.type === "boolean") {
    return currentValue === value;
  }
  if (typeof currentValue !== "string") {
    return false;
  }
  return currentValue.trim() === String(value).trim();
}

export function applyDevinSessionConfiguration(input: {
  readonly runtime: AcpSessionRuntimeShape;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly modelSelection:
    | {
        readonly model: string;
        readonly options?: DevinModelOptions | null | undefined;
      }
    | undefined;
}): Effect.Effect<{ readonly model: string | undefined }, ProviderAdapterError> {
  return Effect.gen(function* () {
    const readConfigOptions = (): Effect.Effect<
      ReadonlyArray<EffectAcpSchema.SessionConfigOption>
    > =>
      input.runtime.getConfigOptions.pipe(
        Effect.timeoutOption(5_000),
        Effect.map(
          Option.getOrElse(() => [] as ReadonlyArray<EffectAcpSchema.SessionConfigOption>),
        ),
        Effect.orElseSucceed(() => [] as ReadonlyArray<EffectAcpSchema.SessionConfigOption>),
      );

    let configOptions = yield* readConfigOptions();
    let confirmedModel: string | undefined;

    if (input.modelSelection) {
      const modelOption = findModelConfigOption(configOptions);
      const allowedModels =
        modelOption?.type === "select" ? collectSessionConfigOptionValues(modelOption) : [];
      const requestedModel = input.modelSelection.model.trim();
      const resolvedModel = resolveModelSlug(requestedModel, PROVIDER) ?? requestedModel;

      const isAllowed = (candidate: string): boolean =>
        allowedModels.length === 0 ||
        allowedModels.some((allowed) => allowed.toLowerCase() === candidate.toLowerCase());

      const targetModel = isAllowed(resolvedModel)
        ? resolvedModel
        : isAllowed(requestedModel)
          ? requestedModel
          : undefined;

      if (targetModel === undefined) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "applyDevinSessionConfiguration",
          issue: `Model "${requestedModel}" is not available. Allowed models: ${allowedModels.join(", ")}`,
        });
      }

      yield* input.runtime.setModel(targetModel).pipe(
        Effect.mapError(
          (error) =>
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "applyDevinSessionConfiguration",
              issue: `setModel("${targetModel}") failed: ${error.message}`,
            }),
        ),
      );

      configOptions = yield* readConfigOptions();
      const finalModelOption = findModelConfigOption(configOptions);
      const modelCurrentValue =
        finalModelOption?.currentValue !== undefined && finalModelOption.currentValue !== null
          ? String(finalModelOption.currentValue)
          : undefined;
      if (modelCurrentValue === undefined || !isAllowed(modelCurrentValue)) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "applyDevinSessionConfiguration",
          issue: `Model "${targetModel}" was not confirmed by the ACP agent. Current model: ${modelCurrentValue ?? "undefined"}`,
        });
      }
      confirmedModel = modelCurrentValue;

      const options = input.modelSelection.options;
      if (options) {
        const optionKeys = [
          "contextWindow",
          "fastMode",
          "thinking",
          "reasoningEffort",
          "variant",
        ] as Array<keyof DevinModelOptions>;
        const appliedOptionValues = new Map<string, string | boolean>();

        for (const key of optionKeys) {
          const rawValue = options[key];
          if (rawValue === undefined || rawValue === null) {
            continue;
          }
          const option = findDevinConfigOption(configOptions, key);
          if (option === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "applyDevinSessionConfiguration",
              issue: `Trait "${key}" is not supported by the current Devin session.`,
            });
          }

          const value = normalizeDevinConfigOptionValue(rawValue, option);
          if (value === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "applyDevinSessionConfiguration",
              issue: `Trait "${key}" value ${JSON.stringify(rawValue)} cannot be applied to option "${option.id}".`,
            });
          }

          if (appliedOptionValues.has(option.id)) {
            const previous = appliedOptionValues.get(option.id)!;
            if (previous !== value) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "applyDevinSessionConfiguration",
                issue: `Conflicting values for option "${option.id}": ${JSON.stringify(previous)} vs ${JSON.stringify(value)}`,
              });
            }
            continue;
          }

          if (option.type === "select") {
            const allowed = collectSessionConfigOptionValues(option);
            if (
              allowed.length > 0 &&
              !allowed.some(
                (allowedValue) =>
                  String(allowedValue).toLowerCase() === String(value).toLowerCase(),
              )
            ) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "applyDevinSessionConfiguration",
                issue: `Value "${String(value)}" is not allowed for "${option.id}". Allowed values: ${allowed.join(", ")}`,
              });
            }
          }

          const response = yield* input.runtime.setConfigOption(option.id, value).pipe(
            Effect.mapError(
              (error) =>
                new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "applyDevinSessionConfiguration",
                  issue: `setConfigOption("${option.id}", ${JSON.stringify(value)}) failed: ${error.message}`,
                }),
            ),
          );
          appliedOptionValues.set(option.id, value);

          const updatedOption = findSessionConfigOption(response.configOptions, option.id);
          if (
            updatedOption === undefined ||
            !configOptionCurrentValueMatches(updatedOption, value)
          ) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "applyDevinSessionConfiguration",
              issue: `setConfigOption("${option.id}", ${JSON.stringify(value)}) was not confirmed by the ACP agent. Current value: ${JSON.stringify(updatedOption?.currentValue)}`,
            });
          }
          configOptions = response.configOptions;
        }
      }
    }

    const modeState = yield* input.runtime.getModeState.pipe(
      Effect.timeoutOption(5_000),
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );

    const requestedModeId = yield* resolveRequestedModeId({
      modeState,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
    });

    if (requestedModeId) {
      yield* input.runtime.setMode(requestedModeId).pipe(
        Effect.mapError(
          (error) =>
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "applyDevinSessionConfiguration",
              issue: `setMode("${requestedModeId}") failed: ${error.message}`,
            }),
        ),
      );

      const modeStateAfter = yield* input.runtime.getModeState.pipe(
        Effect.timeoutOption(5_000),
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      const stillRequired = yield* resolveRequestedModeId({
        modeState: modeStateAfter,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
      }).pipe(
        Effect.mapError(
          (error) =>
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "applyDevinSessionConfiguration",
              issue: `setMode("${requestedModeId}") did not put the session into the requested mode: ${error.message}`,
            }),
        ),
      );
      if (stillRequired !== undefined) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "applyDevinSessionConfiguration",
          issue: `setMode("${requestedModeId}") was not confirmed by the ACP agent. Current mode: ${modeStateAfter?.currentModeId ?? "undefined"}`,
        });
      }
    }

    return { model: confirmedModel };
  });
}

function clearDevinActiveTurn(ctx: DevinSessionContext, turnId: TurnId): boolean {
  if (ctx.activeTurnId !== turnId) {
    return false;
  }

  ctx.activeTurnId = undefined;
  ctx.activeTurnFailedToolDetail = undefined;
  ctx.activePromptFiber = undefined;
  ctx.activeInteractionMode = undefined;
  const { activeTurnId: _activeTurnId, ...session } = ctx.session;
  ctx.session = session as ProviderSession;
  return true;
}

function resolveDevinAssistantItemTurnId(
  ctx: DevinSessionContext,
  itemId: string | undefined,
): TurnId | undefined {
  if (itemId === undefined) {
    return ctx.activeTurnId;
  }
  const existing = ctx.assistantItemTurnIds.get(itemId);
  if (existing) {
    return existing;
  }
  if (ctx.activeTurnId !== undefined) {
    ctx.assistantItemTurnIds.set(itemId, ctx.activeTurnId);
  }
  return ctx.activeTurnId;
}

function completeDevinAssistantItemTurnId(
  ctx: DevinSessionContext,
  itemId: string,
): TurnId | undefined {
  const turnId = ctx.assistantItemTurnIds.get(itemId) ?? ctx.activeTurnId;
  ctx.assistantItemTurnIds.delete(itemId);
  return turnId;
}

function recordDevinSessionCost(
  ctx: DevinSessionContext,
  cost: EffectAcpSchema.Cost | null | undefined,
): void {
  const sessionCostUsd = readAcpUsdCost(cost);
  if (sessionCostUsd === undefined) {
    return;
  }
  ctx.latestSessionCostUsd = sessionCostUsd;
}

function finalizeDevinActiveTurnCost(ctx: DevinSessionContext): {
  readonly cumulativeCostUsd?: number;
} {
  return ctx.latestSessionCostUsd !== undefined
    ? { cumulativeCostUsd: ctx.latestSessionCostUsd }
    : {};
}

function withDevinPlanModePrompt(input: {
  readonly text: string;
  readonly interactionMode?: ProviderInteractionMode;
}): string {
  if (input.interactionMode !== "plan") {
    return input.text;
  }
  return [DEVIN_PLAN_MODE_PROMPT_PREFIX, input.text].join("\n\n");
}

function findModelOptionName(
  modelOption: EffectAcpSchema.SessionConfigOption & { type: "select" },
  value: string,
): string | undefined {
  return flattenSessionConfigSelectOptions(modelOption.options).find((o) => o.value === value)
    ?.name;
}

export function buildDevinProviderModelDescriptors(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | undefined,
): ReadonlyArray<ProviderModelDescriptor> {
  const modelOption = findModelConfigOption(configOptions);
  if (!modelOption || modelOption.type !== "select") {
    return MODEL_OPTIONS_BY_PROVIDER.devin.map((modelDefinition) => {
      const caps = getModelCapabilities(PROVIDER, modelDefinition.slug);
      return {
        slug: modelDefinition.slug,
        name: modelDefinition.name,
        optionDescriptors: getProviderOptionDescriptors({
          provider: PROVIDER,
          caps,
        }),
        supportsFastMode: caps.supportsFastMode,
        supportsThinkingToggle: caps.supportsThinkingToggle,
        contextWindowOptions: caps.contextWindowOptions,
        supportedReasoningEfforts: caps.reasoningEffortLevels,
        defaultReasoningEffort: caps.reasoningEffortLevels.find((o) => o.isDefault)?.value,
      };
    });
  }

  const modelValues = collectSessionConfigOptionValues(modelOption);

  return modelValues.map((slug) => {
    const staticMatch = MODEL_OPTIONS_BY_PROVIDER.devin.find((m) => m.slug === slug);
    const caps = staticMatch ? staticMatch.capabilities : getModelCapabilities(PROVIDER, slug);
    return {
      slug,
      name: staticMatch?.name ?? findModelOptionName(modelOption, slug) ?? slug,
      optionDescriptors: getProviderOptionDescriptors({
        provider: PROVIDER,
        caps,
      }),
      supportsFastMode: caps.supportsFastMode,
      supportsThinkingToggle: caps.supportsThinkingToggle,
      contextWindowOptions: caps.contextWindowOptions,
      supportedReasoningEfforts: caps.reasoningEffortLevels,
      defaultReasoningEffort: caps.reasoningEffortLevels.find((o) => o.isDefault)?.value,
    };
  });
}

function buildDevinPromptParts(input: {
  readonly text: string | undefined;
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly attachmentsDir: string;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly fileSystem: FileSystem.FileSystem;
}): Effect.Effect<Array<EffectAcpSchema.ContentBlock>, ProviderAdapterRequestError> {
  return Effect.gen(function* () {
    const promptText = appendFileAttachmentsPromptBlock({
      text: input.text
        ? withDevinPlanModePrompt({
            text: input.text.trim(),
            ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
          })
        : undefined,
      attachments: input.attachments,
      attachmentsDir: input.attachmentsDir,
      include: "all-files",
    });

    const promptParts: Array<EffectAcpSchema.ContentBlock> = [];
    if (promptText) {
      promptParts.push({ type: "text", text: promptText });
    }

    const imageBlocks = yield* loadProviderPromptImageBlocks({
      attachments: input.attachments,
      attachmentsDir: input.attachmentsDir,
      provider: PROVIDER,
      method: "session/prompt",
      readFile: input.fileSystem.readFile,
    });

    promptParts.push(...(imageBlocks as Array<EffectAcpSchema.ContentBlock>));
    return promptParts;
  });
}

export function makeDevinAdapter(
  devinSettings: DevinAcpRuntimeSettings = {},
  options?: DevinAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const agentGatewayCredentials = Option.getOrUndefined(
      yield* Effect.serviceOption(AgentGatewayCredentials),
    );

    let nativeEventLogger = options?.nativeEventLogger;
    let managedNativeEventLogger: EventNdjsonLogger | undefined;
    if (nativeEventLogger === undefined && options?.nativeEventLogPath !== undefined) {
      managedNativeEventLogger = yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
        stream: "native",
      });
      nativeEventLogger = managedNativeEventLogger;
    }

    const sessions = new Map<ThreadId, DevinSessionContext>();
    const withThreadLock = yield* makeAcpThreadLock();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const offerRuntimeEvent = (
      lifecycleGeneration: string | undefined,
      event: ProviderRuntimeEvent,
    ) =>
      PubSub.publish(
        runtimeEventPubSub,
        stampAcpRuntimeEventLifecycleGeneration(event, lifecycleGeneration),
      ).pipe(Effect.asVoid);

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = new Date().toISOString();
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: crypto.randomUUID(),
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const emitPlanUpdate = (
      ctx: DevinSessionContext,
      payload: AcpPlanUpdate,
      rawPayload: unknown,
      method: string,
    ) =>
      Effect.gen(function* () {
        if (!acceptAcpPlanUpdate(ctx, payload)) return;
        yield* offerRuntimeEvent(
          ctx.lifecycleGeneration,
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source: "acp.jsonrpc",
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = (threadId: ThreadId) => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: DevinSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        ctx.gatewaySessionLease?.release();
        yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const failDevinTurnAsTimedOut = (ctx: DevinSessionContext, turnId: TurnId, idleMs: number) =>
      Effect.gen(function* () {
        const promptFiber = ctx.activePromptFiber;
        if (!clearDevinActiveTurn(ctx, turnId)) return;
        const completedCost = finalizeDevinActiveTurnCost(ctx);
        const idleSeconds = Math.round(idleMs / 1000);
        const detail = `Devin stopped responding (no activity for ${idleSeconds}s); the turn was timed out.`;
        ctx.turns.push({
          id: turnId,
          items: [{ prompt: turnId, timedOut: true, idleMs }],
        });
        ctx.session = {
          ...ctx.session,
          status: "error",
          updatedAt: yield* nowIso,
          lastError: detail,
        };
        yield* Effect.logWarning("devin.acp.turn_idle_timeout", {
          threadId: ctx.threadId,
          turnId,
          idleMs,
        });
        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: {
            state: "failed",
            stopReason: null,
            errorMessage: detail,
            ...completedCost,
          },
        });
        yield* Effect.ignore(ctx.acp.cancel);
        if (promptFiber) {
          yield* Fiber.interrupt(promptFiber);
        }
      });

    const startSession: DevinAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }

          const cwd = resolveDevinSessionCwd(input.cwd, serverConfig);
          if (cwd === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and no server cwd fallback is available.",
            });
          }

          const devinModelSelection =
            input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;

          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;

          const gatewaySessionLease = acquireAgentGatewaySessionLease(
            agentGatewayCredentials,
            input.threadId,
            PROVIDER,
          );

          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred || !gatewaySessionLease
              ? Effect.void
              : Effect.sync(gatewaySessionLease.release),
          );

          let ctx!: DevinSessionContext;
          const resumeSessionId = parseDevinResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          const providerDevinOptions = input.providerOptions?.devin;
          const effectiveDevinSettings: DevinAcpRuntimeSettings = {
            ...(devinSettings.binaryPath !== undefined
              ? { binaryPath: devinSettings.binaryPath }
              : {}),
            ...(providerDevinOptions?.binaryPath !== undefined
              ? { binaryPath: providerDevinOptions.binaryPath }
              : {}),
          };

          const acpToAdapterError = (cause: { readonly message: string }) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: cause.message,
              cause,
            });

          const acp = yield* makeDevinAcpRuntime({
            devinSettings: effectiveDevinSettings,
            childProcessSpawner,
            cwd,
            clientInfo: { name: "Synara", version: "0.0.0" },
            clientCapabilities: { elicitation: { form: {} } },
            ...(resumeSessionId ? { resumeSessionId } : {}),
            ...(agentGatewayCredentials
              ? {
                  buildMcpServers: (initializeResult) =>
                    buildAcpSynaraMcpServers({
                      connection: gatewaySessionLease!.connection,
                      initializeResult,
                      stdioProxy: agentGatewayCredentials.stdioProxy,
                    }),
                }
              : {}),
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(acpToAdapterError),
          );

          yield* startAgentGatewaySessionLeaseExitWatcher(gatewaySessionLease, acp.awaitExit);

          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/request_permission", params);

                if (input.runtimeMode === "full-access" && ctx?.activeInteractionMode !== "plan") {
                  const autoApprovedOptionId = selectAcpFullAccessPermissionOptionId(
                    params.options,
                  );
                  if (autoApprovedOptionId !== undefined) {
                    return {
                      outcome: {
                        outcome: "selected" as const,
                        optionId: autoApprovedOptionId,
                      },
                    };
                  }
                }

                const permissionRequest = parsePermissionRequest(params);
                const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
                const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                pendingApprovals.set(requestId, {
                  decision,
                  kind: permissionRequest.kind,
                });

                yield* offerRuntimeEvent(
                  input.lifecycleGeneration,
                  makeAcpRequestOpenedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    detail: permissionRequest.detail ?? JSON.stringify(params).slice(0, 2000),
                    args: params,
                    source: "acp.jsonrpc",
                    method: "session/request_permission",
                    rawPayload: params,
                  }),
                );

                const resolved = yield* Deferred.await(decision);
                pendingApprovals.delete(requestId);

                yield* offerRuntimeEvent(
                  input.lifecycleGeneration,
                  makeAcpRequestResolvedEvent({
                    stamp: yield* makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    decision: resolved,
                  }),
                );

                if (resolved === "cancel") {
                  return { outcome: { outcome: "cancelled" } as const };
                }

                const selectedOptionId = selectAcpPermissionOptionId(resolved, params.options);
                return selectedOptionId === undefined
                  ? { outcome: { outcome: "cancelled" } as const }
                  : {
                      outcome: {
                        outcome: "selected" as const,
                        optionId: selectedOptionId,
                      },
                    };
              }),
            );

            yield* acp.handleElicitation((params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/elicitation", params);

                if (params.mode === "url") {
                  return {
                    action: { action: "decline" },
                  } satisfies EffectAcpSchema.ElicitationResponse;
                }

                const questions = elicitationQuestionsFromRequest(params);
                const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
                const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
                const answers = yield* Deferred.make<ProviderUserInputAnswers>();
                pendingUserInputs.set(requestId, { answers });

                yield* offerRuntimeEvent(input.lifecycleGeneration, {
                  type: "user-input.requested",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  requestId: runtimeRequestId,
                  payload: { questions },
                  raw: {
                    source: "acp.jsonrpc",
                    method: "session/elicitation",
                    payload: params,
                  },
                });

                const resolved = yield* Deferred.await(answers);
                pendingUserInputs.delete(requestId);

                yield* offerRuntimeEvent(input.lifecycleGeneration, {
                  type: "user-input.resolved",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx?.activeTurnId,
                  requestId: runtimeRequestId,
                  payload: { answers: resolved },
                  raw: {
                    source: "acp.jsonrpc",
                    method: "session/elicitation",
                    payload: params,
                  },
                });

                return elicitationResponseFromAnswers(params, resolved);
              }).pipe(
                Effect.catch(() =>
                  Effect.succeed({
                    action: { action: "decline" },
                  } as EffectAcpSchema.ElicitationResponse),
                ),
              ),
            );

            return yield* acp.start().pipe(Effect.mapError(acpToAdapterError));
          });

          const { model: appliedModel } = yield* applyDevinSessionConfiguration({
            runtime: acp,
            runtimeMode: input.runtimeMode,
            interactionMode: undefined,
            modelSelection: devinModelSelection
              ? { model: devinModelSelection.model, options: devinModelSelection.options }
              : undefined,
          });

          const now = yield* nowIso;

          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: appliedModel,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: DEVIN_RESUME_VERSION,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            lifecycleGeneration: input.lifecycleGeneration,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            assistantItemTurnIds: new Map(),
            activeInteractionMode: undefined,
            activeTurnId: undefined,
            activeTurnFailedToolDetail: undefined,
            activePromptFiber: undefined,
            lastPlanFingerprint: undefined,
            lastTurnActivityAt: undefined,
            latestSessionCostUsd: undefined,
            stopped: false,
            gatewaySessionLease,
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                if (isAcpTurnProgressEventTag(event._tag)) {
                  ctx.lastTurnActivityAt = Date.now();
                }

                switch (event._tag) {
                  case "ModeChanged":
                    return;

                  case "AssistantItemStarted": {
                    const turnId = resolveDevinAssistantItemTurnId(ctx, event.itemId);
                    yield* offerRuntimeEvent(
                      input.lifecycleGeneration,
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  }

                  case "AssistantItemCompleted": {
                    const turnId = completeDevinAssistantItemTurnId(ctx, event.itemId);
                    yield* offerRuntimeEvent(
                      input.lifecycleGeneration,
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  }

                  case "PlanUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* emitPlanUpdate(ctx, event.payload, event.rawPayload, "session/update");
                    return;

                  case "ToolCallUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    {
                      const failedToolDetail = readAcpFailedToolDetail(event.toolCall);
                      if (failedToolDetail !== undefined && ctx.activeTurnId !== undefined) {
                        ctx.activeTurnFailedToolDetail = failedToolDetail;
                      }
                    }
                    yield* offerRuntimeEvent(
                      input.lifecycleGeneration,
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;

                  case "ContentDelta":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    yield* offerRuntimeEvent(
                      input.lifecycleGeneration,
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: resolveDevinAssistantItemTurnId(ctx, event.itemId),
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        ...(event.streamKind ? { streamKind: event.streamKind } : {}),
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;

                  case "UsageUpdated":
                    yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                    recordDevinSessionCost(ctx, event.cost);
                    yield* offerRuntimeEvent(
                      input.lifecycleGeneration,
                      makeAcpTokenUsageEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        usage: event.usage,
                        method: "session/update",
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
          ).pipe(Effect.forkChild);

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent(input.lifecycleGeneration, {
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent(input.lifecycleGeneration, {
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Devin ACP session ready" },
          });
          yield* offerRuntimeEvent(input.lifecycleGeneration, {
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: DevinAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const turnId = TurnId.makeUnsafe(crypto.randomUUID());
        const turnModelSelection =
          input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
        const model = turnModelSelection?.model ?? ctx.session.model;

        const { model: appliedModel } = yield* applyDevinSessionConfiguration({
          runtime: ctx.acp,
          runtimeMode: ctx.session.runtimeMode,
          interactionMode: input.interactionMode,
          modelSelection:
            model === undefined ? undefined : { model, options: turnModelSelection?.options },
        });

        const resolvedModel = appliedModel ?? model;

        const promptParts = yield* buildDevinPromptParts({
          text: input.input,
          attachments: input.attachments,
          attachmentsDir: serverConfig.attachmentsDir,
          interactionMode: input.interactionMode,
          fileSystem,
        });

        if (promptParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }

        const harnessPolicy = takeSynaraHarnessPolicyTextPartForProviderSession(ctx, {
          provider: PROVIDER,
          scopedGatewayConnectionAvailable: agentGatewayCredentials !== undefined,
        });
        if (harnessPolicy) {
          promptParts.unshift(harnessPolicy);
        }

        ctx.activeTurnId = turnId;
        ctx.activeTurnFailedToolDetail = undefined;
        ctx.activeInteractionMode = input.interactionMode;
        ctx.lastPlanFingerprint = undefined;
        ctx.lastTurnActivityAt = Date.now();

        const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
        ctx.session = {
          ...sessionWithoutLastError,
          status: "running",
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
          ...(resolvedModel ? { model: resolvedModel } : {}),
        };

        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { model: resolvedModel },
        });

        const runPrompt = ctx.acp.prompt({ prompt: promptParts }).pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
          ),
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.gen(function* () {
                if (!clearDevinActiveTurn(ctx, turnId)) return;
                const completedCost = finalizeDevinActiveTurnCost(ctx);
                ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, error }] });
                const detail = error.message;
                ctx.session = {
                  ...ctx.session,
                  status: "error",
                  updatedAt: yield* nowIso,
                  model: resolvedModel,
                  lastError: detail,
                };
                yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: {
                    state: "failed",
                    stopReason: null,
                    errorMessage: detail,
                    ...completedCost,
                  },
                });
              }),
            onSuccess: (result) =>
              Effect.gen(function* () {
                const failedToolDetail = ctx.activeTurnFailedToolDetail;
                if (!clearDevinActiveTurn(ctx, turnId)) return;
                const completedCost = finalizeDevinActiveTurnCost(ctx);
                ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
                const { lastError: _lastError2, ...sessionWithoutLastError2 } = ctx.session;
                ctx.session = {
                  ...sessionWithoutLastError2,
                  status: "ready",
                  updatedAt: yield* nowIso,
                  model: resolvedModel,
                };
                const completion = classifyAcpPromptTurnCompletion({
                  stopReason: result.stopReason,
                  ...(failedToolDetail !== undefined ? { failedToolDetail } : {}),
                });
                yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: {
                    state: completion.state,
                    stopReason: result.stopReason ?? null,
                    ...(completion.errorMessage !== undefined
                      ? { errorMessage: completion.errorMessage }
                      : {}),
                    ...(result.usage ? { usage: result.usage } : {}),
                    ...completedCost,
                  },
                });
              }),
          }),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              if (!clearDevinActiveTurn(ctx, turnId)) return;
              const completedCost = finalizeDevinActiveTurnCost(ctx);
              ctx.turns.push({
                id: turnId,
                items: [{ prompt: promptParts, interrupted: true }],
              });
              const { lastError: _lastError3, ...sessionWithoutLastError3 } = ctx.session;
              ctx.session = {
                ...sessionWithoutLastError3,
                status: "ready",
                updatedAt: yield* nowIso,
                model: resolvedModel,
              };
              yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: {
                  state: "cancelled",
                  stopReason: "cancelled",
                  ...completedCost,
                },
              });
            }),
          ),
          Effect.ignoreCause({ log: true }),
          Effect.forkIn(ctx.scope),
        );

        ctx.activePromptFiber = yield* runPrompt;

        yield* forkAcpTurnIdleWatchdog({
          idleTimeoutMs: DEVIN_TURN_IDLE_TIMEOUT_MS,
          checkIntervalMs: DEVIN_TURN_WATCHDOG_INTERVAL_MS,
          scope: ctx.scope,
          isTurnActive: () => ctx.activeTurnId === turnId && !ctx.stopped,
          isAwaitingHuman: () => ctx.pendingApprovals.size > 0 || ctx.pendingUserInputs.size > 0,
          lastActivityAt: () => ctx.lastTurnActivityAt ?? Date.now(),
          touchActivity: () => {
            ctx.lastTurnActivityAt = Date.now();
          },
          onIdleTimeout: (idleMs) => failDevinTurnAsTimedOut(ctx, turnId, idleMs),
        });

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      });

    const interruptTurn: DevinAdapterShape["interruptTurn"] = (
      threadId,
      _turnId,
      _providerThreadId,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        const activePromptFiber = ctx.activePromptFiber;
        yield* Effect.ignore(
          ctx.acp.cancel.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
            ),
          ),
        );
        if (activePromptFiber) {
          yield* Fiber.interrupt(activePromptFiber);
        }
      });

    const respondToRequest: DevinAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: DevinAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/elicitation",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: DevinAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return {
          threadId,
          turns: ctx.turns,
          cwd: ctx.session.cwd ?? null,
        } satisfies ProviderThreadSnapshot;
      });

    const rollbackThread: DevinAdapterShape["rollbackThread"] = (threadId, _numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "Devin does not support conversation rollback.",
        });
      });

    const stopSession: DevinAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: DevinAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: DevinAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const getComposerCapabilities: NonNullable<DevinAdapterShape["getComposerCapabilities"]> = () =>
      Effect.succeed({
        provider: PROVIDER,
        supportsSkillMentions: false,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: false,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        supportsThreadCompaction: false,
        supportsThreadImport: false,
      } satisfies ProviderComposerCapabilities);

    const listModels: NonNullable<DevinAdapterShape["listModels"]> = (input) =>
      Effect.gen(function* () {
        const binaryPath = input.binaryPath?.trim() ?? devinSettings.binaryPath;
        const cwd = input.cwd ?? serverConfig.cwd;

        const discovery = Effect.gen(function* () {
          const runtime = yield* makeDevinAcpRuntime({
            devinSettings: binaryPath ? { binaryPath } : undefined,
            childProcessSpawner,
            cwd,
            clientInfo: { name: "Synara", version: "0.0.0" },
            clientCapabilities: { elicitation: { form: {} } },
            resolveAuthMethodId: resolveDevinAcpAuthMethodIdForDiscovery,
          });
          yield* runtime.start();
          const configOptions = yield* runtime.getConfigOptions;
          return buildDevinProviderModelDescriptors(configOptions);
        }).pipe(Effect.scoped, Effect.timeout(DEVIN_MODEL_DISCOVERY_TIMEOUT_MS));

        const dynamicResult = yield* discovery.pipe(
          Effect.match({
            onFailure: (
              error,
            ): { models: ReadonlyArray<ProviderModelDescriptor>; error?: string } => ({
              models: [],
              error: error instanceof Error ? error.message : "Devin model discovery failed",
            }),
            onSuccess: (
              models,
            ): { models: ReadonlyArray<ProviderModelDescriptor>; error?: string } => ({
              models,
            }),
          }),
        );

        const models =
          dynamicResult.models.length > 0
            ? dynamicResult.models
            : buildDevinProviderModelDescriptors(undefined);

        return {
          models,
          source: dynamicResult.models.length > 0 ? "devin.acp" : "devin.static",
          cached: false,
          error: dynamicResult.error,
        } satisfies ProviderListModelsResult;
      });

    const stopAll: DevinAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, {
        discard: true,
      }).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        conversationRollback: "restart-session",
        supportsRuntimeModelList: true,
      },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      getComposerCapabilities,
      listModels,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies DevinAdapterShape;
  });
}

export const DevinAdapterLive = Layer.effect(DevinAdapter, makeDevinAdapter());

export function makeDevinAdapterLive(
  devinSettings: DevinAcpRuntimeSettings = {},
  options?: DevinAdapterLiveOptions,
) {
  return Layer.effect(DevinAdapter, makeDevinAdapter(devinSettings, options));
}

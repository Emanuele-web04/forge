/**
 * DevinAdapterLive — Devin CLI (`devin acp`) via ACP.
 *
 * A thin adapter around `AcpSessionRuntime` that reuses the shared ACP
 * lifecycle, permission, and event-stream plumbing.
 *
 * @module DevinAdapterLive
 */
import {
  ApprovalRequestId,
  type ChatAttachment,
  type DevinModelOptions,
  EventId,
  MODEL_OPTIONS_BY_PROVIDER,
  type ProviderApprovalDecision,
  type ProviderComposerCapabilities,
  type ProviderInteractionMode,
  ProviderListCommandsInput,
  type ProviderListCommandsResult,
  type ProviderListModelsResult,
  type ProviderModelDescriptor,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type RuntimeMode,
} from "@synara/contracts";
import {
  getDevinStaticModelVariants,
  getModelCapabilities,
  getProviderOptionDescriptors,
  normalizeModelSlug,
  resolveDevinModelVariant,
  trimOrNull,
} from "@synara/shared/model";
import {
  Cause,
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
  Semaphore,
  Scope,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { makeEffectProcessCommand } from "../../platform/effectProcessRuntime.ts";
import type * as Acp from "@agentclientprotocol/sdk";

import {
  type SynaraHarnessPolicyDeliveryState,
  takeSynaraHarnessPolicyTextPartForProviderSession,
} from "../../agentGateway/harnessPolicy.ts";
import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import {
  acquireAgentGatewaySessionLease,
  cancelAgentGatewayTurn,
  startAgentGatewaySessionLeaseExitWatcher,
  type AgentGatewaySessionLease,
  withAgentGatewayTurnCancellation,
} from "../../agentGateway/sessionLease.ts";
import { ServerConfig } from "../../config.ts";
import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
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
  resolveAcpPermissionPolicy,
  selectAcpPermissionOptionId,
} from "../acp/AcpAdapterSupport.ts";
import {
  acceptAcpPlanUpdate,
  clearAcpActiveTurn,
  finalizeAcpActiveTurnCost,
  forkAcpAdapterTurnIdleWatchdog,
  makeAcpThreadLock,
  recordAcpSessionCost,
  resolveAcpSessionCwd,
  resolveAcpTurnInteractionMode,
  scopeAcpRuntimeItemIdForTurn,
  scopeAcpToolCallStateForTurn,
  settleAcpPendingApprovalsAsCancelled,
  settleAcpPendingUserInputsAsEmptyAnswers,
  waitForAcpQueuedTurnEventsDrained,
  withAcpPlanModePrompt,
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
  type AcpToolCallState,
  parsePermissionRequest,
} from "../acp/AcpRuntimeModel.ts";
import {
  redactAcpLogSecrets,
  makeAcpDebugLoggers,
  makeAcpNativeLoggers,
} from "../acp/AcpNativeLogging.ts";
import {
  isAcpTurnProgressEventTag,
  resolveAcpTurnIdleTimeoutMs,
} from "../acp/AcpTurnIdleWatchdog.ts";
import {
  elicitationQuestionsFromRequest,
  elicitationResponseFromAnswers,
  isFormElicitationRequest,
} from "../acp/AcpElicitationSupport.ts";
import {
  hasDevinApiKeyEnv,
  mapDevinAcpCommands,
  makeDevinAcpRuntime,
  resolveDevinBinaryPath,
  runDevinAcpCompactionCommand,
  type DevinAcpRuntimeSettings,
} from "../acp/DevinAcpSupport.ts";
import { createDevinSessionConfig, type DevinSessionConfig } from "../acp/DevinSessionConfig.ts";
import { type AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import { makeEventNdjsonLogger, type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
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
const DEVIN_MODEL_DISCOVERY_CACHE_MS = 5 * 60_000;
const DEVIN_COMMAND_DISCOVERY_TIMEOUT_MS = 15_000;
const DEVIN_COMMAND_DISCOVERY_CACHE_MS = 5 * 60_000;
const DEVIN_DISCOVERY_CACHE_MAX_ENTRIES = 16;
const DEVIN_ACP_TRANSPORT_DEBUG_MARKER = "devin-acp-meta-stripper-v2";
const DEVIN_ACP_LOG_PAYLOAD_LIMIT = 4_000;
const DEVIN_ACP_DEBUG_ENV = "SYNARA_DEVIN_ACP_DEBUG";
const LEGACY_DEVIN_ACP_DEBUG_ENV = "DP_DEVIN_ACP_DEBUG";
// On session/load, Devin can replay old ACP updates after the session reports
// ready; suppression stays active until that stream goes quiet.
const DEVIN_RESUME_REPLAY_QUIET_MS = 200;
// Longest that startSession blocks waiting for the resume replay to settle.
// Suppression stays active past this point; only the startup path is unblocked.
const DEVIN_RESUME_REPLAY_MAX_WAIT_MS = 1_500;
// Absolute cap on replay suppression. A replay still streaming after this long
// is treated as pathological: give up, warn, and unblock turns rather than
// gating the thread forever.
const DEVIN_RESUME_REPLAY_HARD_TIMEOUT_MS = 30_000;
// Backstop for an alive-but-silent devin child: if a turn produces no ACP
// activity for this long, force-fail it instead of showing "Working" forever.
const DEVIN_TURN_SETTLE_DRAIN_MAX_WAIT_MS = 1_000;
const DEVIN_TURN_SETTLE_DRAIN_POLL_MS = 25;
// Reuses the turn idle timeout value as a generous ceiling (compactions stream
// activity well under it); override both with SYNARA_DEVIN_TURN_IDLE_TIMEOUT_MS.
const DEVIN_COMPACT_TIMEOUT_MS = DEVIN_TURN_IDLE_TIMEOUT_MS;
// After a timed-out /compact the cancel is only best-effort: the child may
// still stream stale compaction updates for a moment. Hold new turns for this
// long so those events cannot be attributed to the next active turn.
const DEVIN_COMPACT_ABANDON_QUIET_MS = 5_000;
// Bounded wait for the forked post-timeout cancel to be written before the
// next prompt is dispatched. stdio delivers in order, so once the cancel is
// on the wire it cannot cancel a prompt written after it; a fully wedged
// child never confirms, hence the cap.
const DEVIN_COMPACT_CANCEL_WAIT_MS = 10_000;
// The compaction outcome (failed tool detail) is recorded by the notification
// consumer, which can lag the /compact response; wait for inbound activity to
// go quiet (bounded) before deciding success.
const DEVIN_COMPACT_OUTCOME_QUIET_MS = 200;
const DEVIN_COMPACT_OUTCOME_MAX_WAIT_MS = 2_000;

const ACP_PLAN_MODE_ALIASES = ["plan", "architect"] as const;
const ACP_APPROVAL_MODE_ALIASES = ["accept-edits", "code"] as const;
const ACP_FULL_ACCESS_MODE_ALIASES = ["bypass", "full access"] as const;
const DEVIN_PLAN_MODE_PROMPT_PREFIX = [
  "Devin plan mode is active.",
  "Do not implement or mutate files in this turn.",
  "Do not ask follow-up questions or wait for confirmation; if scope is ambiguous, choose a reasonable default and state the assumption in the plan.",
  "When ready, create the final implementation plan.",
].join("\n");

interface DevinAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly makeAcpRuntime?: typeof makeDevinAcpRuntime;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string;
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
  activeInteractionMode: ProviderInteractionMode | undefined;
  activeTurnId: TurnId | undefined;
  activeTurnHadAssistantContent: boolean;
  readonly activeAssistantItemsWithContent: Set<string>;
  activeTurnFailedToolDetail: string | undefined;
  activePromptFiber: Fiber.Fiber<void, never> | undefined;
  // True once ctx.acp.prompt has returned for the current turn (success or
  // failure). The prompt outcome is then settled; an interrupt that lands
  // while the post-prompt drain is still running must not reclassify the turn
  // as cancelled, so interruptTurn stops interrupting the fiber here and the
  // onInterrupt branch refuses to emit a cancelled completion.
  activePromptResolved: boolean;
  // Id of the most recently settled (cleared) turn, captured at the settle
  // boundary. Preserved until the next turn dispatches so
  // pruneDevinToolCallTurnIds can keep the just-settled turn's tool-call
  // mappings for in-place resolution of trailing ToolCallUpdated events even
  // when the turn already cleared activeTurnId (the dispatch cannot read the
  // settled turn from activeTurnId once it is undefined). Reset at dispatch
  // after pruning so only one previous turn's mappings survive.
  lastSettledTurnId: TurnId | undefined;
  lastPlanFingerprint: string | undefined;
  lastTurnActivityAt: number | undefined;
  // Provider tool-call ids seen during a turn, mapped to that turn. A
  // backlogged consumer can process a queued ToolCallUpdated after the prompt
  // response cleared activeTurnId or after the next turn dispatched; the
  // mapping keeps the event attributed to its originating turn instead of
  // being re-associated with — and allowed to set failure state on — a newer
  // turn. Pruned to the just-settled turn on each dispatch (a straggler can
  // lag by at most one turn on the FIFO session/update stream).
  readonly turnToolCallIds: Map<string, TurnId>;
  // Compared against acp.sessionUpdatesEnqueuedCount to detect when queued
  // session updates have been fully handled by the notification consumer.
  sessionUpdatesProcessed: number;
  // Pending until startSession has completed its post-registration setup.
  // The session is registered first so replay keeps draining, which means
  // sendTurn/compactThread can route to it mid-startup; they await this gate
  // until the remaining startup work has settled. Resolved by
  // stopSessionInternal too, like resumeReplayReady, so a failed startup never
  // strands waiters.
  sessionConfigReady: Deferred.Deferred<void> | undefined;
  resumeReplayReady: Deferred.Deferred<void> | undefined;
  resumeReplayLastSuppressedAt: number | undefined;
  // True while sendTurn is between its compaction check and settling the turn;
  // compactThread reads it so a compaction prompt cannot slip into the gap
  // before ctx.activeTurnId is assigned.
  turnStarting: boolean;
  // Set by interruptTurn while a turn is still starting (no prompt fiber to
  // interrupt yet, e.g. gated on resume replay); startDevinTurn re-checks it
  // before dispatching so a cancelled turn is never prompted.
  pendingTurnInterrupted: boolean;
  compactingThread: boolean;
  // Failed compaction tool-call detail recorded while compactingThread is set;
  // runDevinCompaction reads it so a failed compaction tool call is not
  // persisted as a completed one.
  compactionFailedToolDetail: string | undefined;
  // Epoch-ms until which an abandoned (timed-out) /compact may still stream
  // stale updates; new turns wait it out so they cannot pollute the next turn.
  compactionQuietUntil: number | undefined;
  // Forked best-effort cancel from a timed-out /compact. The next prompt
  // waits (bounded) for it so the cancel is on the wire first — stdio
  // ordering then guarantees it cannot cancel the new turn.
  compactionCancelFiber: Fiber.Fiber<void> | undefined;
  latestSessionCostUsd: number | undefined;
  stopped: boolean;
  gatewaySessionLease: AgentGatewaySessionLease | undefined;
  readonly devinSessionConfig: DevinSessionConfig | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDevinProviderStartOptions(
  providerOptions: unknown,
): { readonly binaryPath?: string } | undefined {
  if (!isRecord(providerOptions) || !isRecord(providerOptions.devin)) {
    return undefined;
  }
  const binaryPath = providerOptions.devin.binaryPath;
  return typeof binaryPath === "string" ? { binaryPath } : {};
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

    if (!modeState) {
      const requiredBy =
        interactionMode === "plan"
          ? "plan interaction mode"
          : runtimeMode === "approval-required"
            ? `runtime mode "${runtimeMode}"`
            : undefined;

      if (requiredBy) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "resolveRequestedModeId",
          issue: `Requested ${requiredBy} requires the ACP session to expose modes, but none were reported.`,
        });
      }

      return undefined;
    }

    const aliases =
      interactionMode === "plan"
        ? ACP_PLAN_MODE_ALIASES
        : runtimeMode === "approval-required"
          ? ACP_APPROVAL_MODE_ALIASES
          : ACP_FULL_ACCESS_MODE_ALIASES;

    // For plan mode, only an exact normalized id or name match is considered
    // safe; whole-token matching is too permissive for a fail-closed gate.
    const targetMode =
      interactionMode === "plan"
        ? findModeByExactNormalizedAliases(modeState.availableModes, aliases)
        : (findModeByExactNormalizedAliases(modeState.availableModes, aliases) ??
          findModeByWholeTokenAliases(modeState.availableModes, aliases));

    if (!targetMode) {
      if (runtimeMode === "full-access" && interactionMode !== "plan") {
        return undefined;
      }
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

export function applyDevinSessionConfiguration(input: {
  readonly runtime: Pick<AcpSessionRuntimeShape, "getModeState" | "setMode">;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
}): Effect.Effect<void, ProviderAdapterError> {
  return Effect.gen(function* () {
    const readModeState = () =>
      input.runtime.getModeState.pipe(
        Effect.timeoutOption(5_000),
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );

    const modeState = yield* readModeState();

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

      const modeStateAfter = yield* readModeState();
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
  });
}

export function scopeDevinRuntimeItemIdForTurn(turnId: TurnId, itemId: string): string {
  return scopeAcpRuntimeItemIdForTurn(PROVIDER, turnId, itemId);
}

// Devin can close a stale assistant segment before any visible text arrives.
export function isRenderableDevinAssistantDelta(input: {
  readonly streamKind?: string | undefined;
  readonly text: string;
}): boolean {
  return input.streamKind !== "reasoning_text" && input.text.trim().length > 0;
}

export function scopeDevinToolCallStateForTurn(
  turnId: TurnId,
  toolCall: AcpToolCallState,
): AcpToolCallState {
  return scopeAcpToolCallStateForTurn(PROVIDER, turnId, toolCall);
}

function setDevinDiscoveryCacheEntry<Result>(
  cache: Map<string, { readonly expiresAt: number; readonly result: Result }>,
  key: string,
  value: { readonly expiresAt: number; readonly result: Result },
): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > DEVIN_DISCOVERY_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    cache.delete(oldestKey);
  }
}

export function makeCachedDevinModelDiscovery<E, R>(input: {
  readonly discoveryLock: Semaphore.Semaphore;
  readonly discover: (binaryPath: string) => Effect.Effect<ProviderListModelsResult, E, R>;
}) {
  const cache = new Map<
    string,
    { readonly expiresAt: number; readonly result: ProviderListModelsResult }
  >();
  return (binaryPath: string, options?: { readonly forceReload?: boolean }) => {
    const resolvedBinaryPath = resolveDevinBinaryPath(binaryPath);
    const cached = cache.get(resolvedBinaryPath);
    if (options?.forceReload !== true && cached && cached.expiresAt > Date.now()) {
      return Effect.succeed({ ...cached.result, cached: true });
    }
    return input.discoveryLock.withPermits(1)(
      Effect.gen(function* () {
        const cached = cache.get(resolvedBinaryPath);
        if (options?.forceReload !== true && cached && cached.expiresAt > Date.now()) {
          return { ...cached.result, cached: true };
        }
        const result = yield* input.discover(resolvedBinaryPath);
        if (result.error === undefined) {
          setDevinDiscoveryCacheEntry(cache, resolvedBinaryPath, {
            expiresAt: Date.now() + DEVIN_MODEL_DISCOVERY_CACHE_MS,
            result,
          });
        }
        return result;
      }),
    );
  };
}

function collectStreamAsString<E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> {
  return collectUint8StreamText({ stream }).pipe(Effect.map(({ text }) => text));
}

function isDevinAcpDebugEnabled(): boolean {
  return (
    process.env[DEVIN_ACP_DEBUG_ENV] === "1" || process.env[LEGACY_DEVIN_ACP_DEBUG_ENV] === "1"
  );
}

function formatDevinModelName(slug: string): string {
  return slug.replace(/[-_/]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

interface DevinModelDescriptorSeed {
  readonly slug: string;
  readonly name?: string;
  readonly description?: string;
  readonly variants?: ReadonlyArray<DevinModelVariantSeed>;
}

interface DevinModelVariantSeed {
  readonly model: string;
  readonly label?: string;
  readonly maxContextTokens?: number;
}

function readDevinModelString(
  model: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string | undefined {
  for (const key of keys) {
    const value = model[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readDevinModelNumber(
  model: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): number | undefined {
  for (const key of keys) {
    const value = model[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return undefined;
}

function parseDevinModelVariant(value: unknown): DevinModelVariantSeed | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const model = readDevinModelString(value, ["model_uid", "modelUid", "uid", "model", "id"]);
  if (!model) {
    return undefined;
  }
  const label = readDevinModelString(value, ["label", "name", "displayName", "title"]);
  const maxContextTokens = readDevinModelNumber(value, [
    "max_context_tokens",
    "maxContextTokens",
    "context_window_tokens",
    "contextWindowTokens",
  ]);
  return {
    model,
    ...(label ? { label } : {}),
    ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
  };
}

function parseDevinModelFamily(
  value: Record<string, unknown>,
): DevinModelDescriptorSeed | undefined {
  const hasVariantIdentity =
    readDevinModelString(value, ["model_uid", "modelUid", "uid"]) !== undefined;
  const slug = readDevinModelString(
    value,
    hasVariantIdentity
      ? ["family_uid", "familyUid", "slug"]
      : ["slug", "family_uid", "familyUid", "id", "model"],
  );
  if (!slug) {
    return undefined;
  }

  const variants = Array.isArray(value.variants)
    ? value.variants
        .map(parseDevinModelVariant)
        .filter((variant): variant is DevinModelVariantSeed => variant !== undefined)
    : [];
  const name = readDevinModelString(value, ["family_label", "name", "label", "displayName"]);
  const description = readDevinModelString(value, ["description", "details"]);
  return {
    slug,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(variants.length > 0 ? { variants } : {}),
  };
}

function collectDevinModelDescriptors(
  value: unknown,
  models: DevinModelDescriptorSeed[],
  seen: Set<unknown>,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectDevinModelDescriptors(entry, models, seen);
    }
    return;
  }
  if (!isRecord(value) || seen.has(value)) {
    return;
  }
  seen.add(value);

  const family = parseDevinModelFamily(value);
  if (family) {
    models.push(family);
    // A family owns its variants. Do not recurse into them as if they were
    // independent model families; doing so loses the effort matrix.
    for (const [key, nested] of Object.entries(value)) {
      if (key === "variants") {
        continue;
      }
      if (Array.isArray(nested) || isRecord(nested)) {
        collectDevinModelDescriptors(nested, models, seen);
      }
    }
    return;
  }

  // Tolerate older/alternate flat lists that contain concrete model UIDs but
  // no family wrapper. They remain selectable even though no controls can be
  // inferred for them.
  const concreteModel = readDevinModelString(value, ["model_uid", "modelUid", "uid"]);
  if (concreteModel) {
    const name = readDevinModelString(value, ["label", "name", "displayName", "title"]);
    models.push({ slug: concreteModel, ...(name ? { name } : {}) });
  }

  for (const nested of Object.values(value)) {
    if (Array.isArray(nested) || isRecord(nested)) {
      collectDevinModelDescriptors(nested, models, seen);
    }
  }
}

export function parseDevinCliModelList(stdout: string): DevinModelDescriptorSeed[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  const candidates = new Set<string>([trimmed]);
  const firstObject = trimmed.search(/[[{]/u);
  const lastObject = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
  if (firstObject >= 0 && lastObject > firstObject) {
    candidates.add(trimmed.slice(firstObject, lastObject + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate.replace(/^\uFEFF/u, ""));
      const models: DevinModelDescriptorSeed[] = [];
      collectDevinModelDescriptors(parsed, models, new Set());
      return models;
    } catch {
      // Try the next tolerant JSON boundary; CLI diagnostics are ignored.
    }
  }
  return [];
}

function formatDevinContextWindow(value: number | undefined, model: string): string | undefined {
  if (value !== undefined) {
    if (value >= 1_000_000 && value % 1_000_000 === 0) {
      return `${value / 1_000_000}m`;
    }
    if (value >= 1_000 && value % 1_000 === 0) {
      return `${value / 1_000}k`;
    }
    return String(value);
  }
  const suffix = model.match(/(?:^|[-_])(\d+(?:\.\d+)?m)(?:$|[-_])/iu)?.[1];
  return suffix?.toLowerCase();
}

function inferDevinReasoningEffort(variant: DevinModelVariantSeed): string | undefined {
  const haystack = `${variant.model} ${variant.label ?? ""}`.toLowerCase().replace(/[_.-]+/gu, " ");
  if (/\b(?:no thinking|none|off)\b/u.test(haystack)) return "none";
  if (/\bminimal\b/u.test(haystack)) return "minimal";
  if (/\blow\b/u.test(haystack)) return "low";
  if (/\bmedium\b/u.test(haystack)) return "medium";
  if (/\bxhigh\b|\bextra high\b/u.test(haystack)) return "xhigh";
  if (/\bhigh\b/u.test(haystack)) return "high";
  if (/\bmax\b/u.test(haystack)) return "max";
  return undefined;
}

function isDevinFastVariant(variant: DevinModelVariantSeed): boolean {
  const haystack = `${variant.model} ${variant.label ?? ""}`.toLowerCase();
  return (
    /\b(?:fast|lightning)\b/u.test(haystack) || /(?:^|[-_])priority(?:$|[-_])/u.test(variant.model)
  );
}

function isDevinThinkingVariant(variant: DevinModelVariantSeed): boolean {
  const haystack = `${variant.model} ${variant.label ?? ""}`.toLowerCase().replace(/[_.-]+/gu, " ");
  return (
    /\bthinking\b/u.test(haystack) &&
    !/\bno thinking\b/u.test(haystack) &&
    inferDevinReasoningEffort(variant) === undefined
  );
}

const DEVIN_EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

const DEVIN_EFFORT_ORDER: ReadonlyArray<string> = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function uniqueStrings(values: ReadonlyArray<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function mergeDevinModelDescriptors(
  groups: ReadonlyArray<ReadonlyArray<DevinModelDescriptorSeed>>,
): Array<ProviderModelDescriptor> {
  const models: ProviderModelDescriptor[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const model of group) {
      const slug = model.slug.trim();
      const key = slug.toLowerCase();
      if (!slug || seen.has(key)) continue;
      seen.add(key);
      const name = model.name?.trim() || formatDevinModelName(slug);
      const rawVariants = model.variants ?? [];
      const effortValues = uniqueStrings(rawVariants.map(inferDevinReasoningEffort)).toSorted(
        (left, right) => DEVIN_EFFORT_ORDER.indexOf(left) - DEVIN_EFFORT_ORDER.indexOf(right),
      );
      const rawContextValues = uniqueStrings(
        rawVariants.map((variant) =>
          formatDevinContextWindow(variant.maxContextTokens, variant.model),
        ),
      );
      const contextWindowValues = rawContextValues.length > 1 ? rawContextValues : [];
      const defaultContextWindow =
        contextWindowValues.length > 0
          ? (rawVariants
              .map((variant) => formatDevinContextWindow(variant.maxContextTokens, variant.model))
              .find((value) => value === undefined) ?? contextWindowValues[0])
          : undefined;
      const hasFastMode = rawVariants.some(isDevinFastVariant);
      const hasThinkingVariant = rawVariants.some(isDevinThinkingVariant);
      const hasPlainThinkingVariant = rawVariants.some(
        (variant) =>
          !isDevinThinkingVariant(variant) && inferDevinReasoningEffort(variant) === undefined,
      );
      const hasThinkingToggle = hasThinkingVariant && hasPlainThinkingVariant;
      const modelVariants = rawVariants.map((variant) => {
        const reasoningEffort = inferDevinReasoningEffort(variant);
        const contextWindow = formatDevinContextWindow(variant.maxContextTokens, variant.model);
        return {
          model: variant.model,
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(contextWindowValues.length > 0 && contextWindow ? { contextWindow } : {}),
          ...(hasFastMode ? { fastMode: isDevinFastVariant(variant) } : {}),
          ...(hasThinkingToggle ? { thinking: isDevinThinkingVariant(variant) } : {}),
        };
      });
      const defaultVariant = rawVariants.find(
        (variant) =>
          !isDevinFastVariant(variant) &&
          !isDevinThinkingVariant(variant) &&
          (contextWindowValues.length === 0 ||
            formatDevinContextWindow(variant.maxContextTokens, variant.model) ===
              defaultContextWindow),
      );
      const defaultReasoningEffort =
        inferDevinReasoningEffort(defaultVariant ?? rawVariants[0] ?? { model: "" }) ??
        effortValues[0];
      const contextWindowOptions = contextWindowValues.map((value) =>
        value === defaultContextWindow
          ? { value, label: value.toUpperCase(), isDefault: true as const }
          : { value, label: value.toUpperCase() },
      );
      models.push({
        slug,
        name,
        ...(model.description ? { description: model.description } : {}),
        ...(effortValues.length > 0
          ? {
              supportedReasoningEfforts: effortValues.map((value) => ({
                value,
                label: DEVIN_EFFORT_LABELS[value] ?? formatDevinModelName(value),
              })),
              ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
            }
          : {}),
        ...(hasFastMode ? { supportsFastMode: true } : {}),
        ...(hasThinkingToggle ? { supportsThinkingToggle: true } : {}),
        ...(contextWindowOptions.length > 1
          ? {
              contextWindowOptions,
              ...(defaultContextWindow ? { defaultContextWindow } : {}),
            }
          : {}),
        ...(modelVariants.length > 0 ? { modelVariants } : {}),
      });
    }
  }
  return models;
}

export function buildDevinStaticModelDescriptors(): ReadonlyArray<ProviderModelDescriptor> {
  return MODEL_OPTIONS_BY_PROVIDER.devin.map((modelDefinition) => {
    const caps = getModelCapabilities(PROVIDER, modelDefinition.slug);
    const modelVariants = getDevinStaticModelVariants(modelDefinition.slug);
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
      ...(modelVariants ? { modelVariants } : {}),
    };
  });
}

export function buildDevinPromptMeta(interactionMode: ProviderInteractionMode): {
  readonly mode: "plan" | "agent";
} {
  // Devin ACP reconciles its native Plan tracker from session/prompt `_meta.mode`.
  // This is idempotent, so reconnects cannot invert the provider state when
  // Synara sends the desired mode again.
  return { mode: interactionMode === "plan" ? "plan" : "agent" };
}

function redactDevinDiscoveryError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return String(redactAcpLogSecrets(message));
}

function acpToAdapterError(threadId: ThreadId) {
  return (cause: { readonly message: string }) =>
    new ProviderAdapterProcessError({
      provider: PROVIDER,
      threadId,
      detail: cause.message,
      cause,
    });
}

function buildDevinPromptParts(input: {
  readonly text: string | undefined;
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly attachmentsDir: string;
  readonly interactionMode: ProviderInteractionMode;
  readonly fileSystem: FileSystem.FileSystem;
}): Effect.Effect<Array<Acp.ContentBlock>, ProviderAdapterRequestError> {
  return Effect.gen(function* () {
    const promptText = appendFileAttachmentsPromptBlock({
      text: input.text
        ? withAcpPlanModePrompt({
            text: input.text.trim(),
            interactionMode: input.interactionMode,
            promptPrefix: DEVIN_PLAN_MODE_PROMPT_PREFIX,
          })
        : undefined,
      attachments: input.attachments,
      attachmentsDir: input.attachmentsDir,
      include: "all-files",
    });

    const promptParts: Array<Acp.ContentBlock> = [];
    if (promptText?.trim()) {
      promptParts.push({ type: "text", text: promptText });
    }

    promptParts.push(
      ...(yield* loadProviderPromptImageBlocks({
        attachments: input.attachments,
        attachmentsDir: input.attachmentsDir,
        provider: PROVIDER,
        method: "session/prompt",
        readFile: input.fileSystem.readFile,
      })),
    );
    return promptParts;
  });
}

// Devin's ACP process accepts a concrete model UID as its `--model` value, not
// a separate effort/context flag. Both web and server resolve current traits
// through the shared resolver. Concrete variants, selection slugs, and explicit
// config remain candidates; reasoning-effort labels are never used as model
// identifiers.
export function resolveDevinEffectiveModel(input: {
  readonly explicitModel: string | undefined;
  readonly selectionModel: string | undefined;
  readonly modelVariant?: string | undefined;
  readonly modelOptions?: DevinModelOptions | undefined;
  readonly runtimeModel?: ProviderModelDescriptor | undefined;
}): string | undefined {
  const modelVariant = resolveDevinModelVariant({
    model: input.selectionModel,
    runtimeModel: input.runtimeModel,
    modelVariant: input.modelOptions?.modelVariant ?? input.modelVariant,
    reasoningEffort: input.modelOptions?.reasoningEffort,
    fastMode: input.modelOptions?.fastMode,
    thinking: input.modelOptions?.thinking,
    contextWindow: input.modelOptions?.contextWindow,
  });
  if (modelVariant) {
    return modelVariant;
  }
  if (input.selectionModel) {
    return input.selectionModel;
  }
  return input.explicitModel;
}

export function resolveDevinStartModel<E, R>(input: {
  readonly explicitModel: string | undefined;
  readonly modelSelection:
    | {
        readonly model: string;
        readonly options?: DevinModelOptions | undefined;
      }
    | undefined;
  readonly discoverModels: () => Effect.Effect<ProviderListModelsResult, E, R>;
}): Effect.Effect<string | undefined, E | ProviderAdapterValidationError, R> {
  const modelSelection = input.modelSelection;
  const options = modelSelection?.options;
  const traitsNeedResolution =
    trimOrNull(options?.reasoningEffort) !== null ||
    options?.fastMode !== undefined ||
    options?.thinking !== undefined ||
    trimOrNull(options?.contextWindow) !== null;
  const resolveVariant = (runtimeModel?: ProviderModelDescriptor) =>
    resolveDevinModelVariant({
      model: modelSelection?.model,
      modelVariant: options?.modelVariant,
      reasoningEffort: options?.reasoningEffort,
      fastMode: options?.fastMode,
      thinking: options?.thinking,
      contextWindow: options?.contextWindow,
      ...(runtimeModel ? { runtimeModel } : {}),
    });
  const resolve = (runtimeModel?: ProviderModelDescriptor) =>
    resolveVariant(runtimeModel) ?? modelSelection?.model ?? input.explicitModel;
  if (!modelSelection || !traitsNeedResolution) {
    return Effect.succeed(resolve());
  }

  return input.discoverModels().pipe(
    Effect.flatMap((result) => {
      const normalizedSelection =
        normalizeModelSlug(modelSelection.model, PROVIDER) ?? modelSelection.model;
      const runtimeModel = result.models.find((candidate) => {
        const normalizedCandidate = normalizeModelSlug(candidate.slug, PROVIDER) ?? candidate.slug;
        return (
          normalizedCandidate === normalizedSelection ||
          candidate.modelVariants?.some((variant) => variant.model === modelSelection.model) ===
            true
        );
      });
      const resolvedModel = resolveVariant(runtimeModel);
      if (resolvedModel !== undefined) {
        return Effect.succeed(resolvedModel);
      }
      return Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "resolveDevinStartModel",
          issue: `Could not resolve the requested traits to a concrete variant for Devin model '${modelSelection.model}'. Refresh models or clear the unsupported trait selection.`,
        }),
      );
    }),
  );
}

// Which turn a ToolCallUpdated belongs to. A tool call already mapped to a
// previous turn keeps that provenance even while a newer turn is active, so a
// trailing update resolves the older turn's row in place instead of being
// re-associated with the current turn. The caller applies current-turn failure
// state only when the resolved turn is the active turn, so a reroute can never
// set the active turn's failed-tool detail. Resume replay stays suppressed.
export function resolveDevinToolCallUpdatedTurnId(input: {
  readonly toolCallId: string;
  readonly activeTurnId: TurnId | undefined;
  readonly resumeReplayReady: boolean;
  readonly toolCallTurnIds: ReadonlyMap<string, TurnId>;
}): TurnId | undefined {
  if (input.resumeReplayReady) {
    return undefined;
  }
  const recordedTurnId = input.toolCallTurnIds.get(input.toolCallId);
  if (recordedTurnId !== undefined && recordedTurnId !== input.activeTurnId) {
    return recordedTurnId;
  }
  return input.activeTurnId;
}

// Prunes tool-call provenance to a single keep turn: a trailing ToolCallUpdated
// can lag by at most one turn (the session/update stream is FIFO), so the
// just-settled turn's mappings survive into the next active turn for in-place
// resolution; anything older is dropped (bounded to one turn of tool-call ids).
export function pruneDevinToolCallTurnIds(
  toolCallTurnIds: Map<string, TurnId>,
  keepTurnId: TurnId | undefined,
): void {
  for (const [toolCallId, mappedTurnId] of toolCallTurnIds) {
    if (mappedTurnId !== keepTurnId) {
      toolCallTurnIds.delete(toolCallId);
    }
  }
}

// Settles the active turn and records it as the last settled turn. Returns
// whether the turn was actually cleared (false when it already settled,
// keeping the call sites idempotent). lastSettledTurnId is what the next
// dispatch prunes tool-call provenance against: clearAcpActiveTurn wipes
// activeTurnId, so the dispatch cannot recover the settled turn from it.
function settleDevinActiveTurn(ctx: DevinSessionContext, turnId: TurnId): boolean {
  if (!clearAcpActiveTurn(ctx, turnId)) {
    return false;
  }
  ctx.lastSettledTurnId = turnId;
  return true;
}

export function closeDevinSessionResources(input: {
  readonly scope: Scope.Closeable;
  readonly config: Pick<DevinSessionConfig, "cleanup"> | undefined;
}) {
  return Effect.gen(function* () {
    yield* Effect.ignore(Scope.close(input.scope, Exit.void));
    if (input.config) {
      yield* Effect.tryPromise(input.config.cleanup).pipe(
        Effect.catch(() => Effect.logWarning("devin.acp.session_config_cleanup_failed")),
      );
    }
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
    const createAcpRuntime = options?.makeAcpRuntime ?? makeDevinAcpRuntime;
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
    const commandDiscoveryCache = new Map<
      string,
      { readonly expiresAt: number; readonly result: ProviderListCommandsResult }
    >();
    const discoveryLock = yield* Semaphore.make(1);
    const withThreadLock = yield* makeAcpThreadLock();
    const runtimeEventPubSub = yield* PubSub.bounded<ProviderRuntimeEvent>(
      PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
    );

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const makeDevinDiscoveryRuntime = (input: {
      readonly binaryPath?: string;
      readonly cwd: string;
    }) =>
      createAcpRuntime({
        devinSettings: {
          ...(devinSettings.binaryPath ? { binaryPath: devinSettings.binaryPath } : {}),
          ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
        },
        childProcessSpawner,
        cwd: input.cwd,
        runtimeMode: "approval-required",
        clientInfo: { name: "Synara Command Discovery", version: "0.0.0" },
      });

    const discoverDevinModelsUncached = (binaryPath: string) => {
      const fallbackResult = {
        models: buildDevinStaticModelDescriptors(),
        source: "devin.static",
        cached: false,
      } satisfies ProviderListModelsResult;

      return Effect.gen(function* () {
        let discoveryError: string | undefined;
        const cliModels = yield* Effect.gen(function* () {
          const childEnv = buildProviderChildEnvironment({ provider: PROVIDER });
          const child = yield* childProcessSpawner.spawn(
            makeEffectProcessCommand(binaryPath, ["models", "list", "--format", "json"], {
              env: childEnv,
            }),
          );
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              collectStreamAsString(child.stdout),
              collectStreamAsString(child.stderr),
              child.exitCode.pipe(Effect.map(Number)),
            ],
            { concurrency: "unbounded" },
          );
          if (exitCode !== 0) {
            discoveryError = redactDevinDiscoveryError(
              stderr.trim() ||
                `Devin model discovery failed because '${binaryPath} models list' exited with code ${exitCode}.`,
            );
            return [];
          }
          return parseDevinCliModelList(stdout);
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              discoveryError = redactDevinDiscoveryError(error);
              return [];
            }),
          ),
        );

        if (cliModels.length === 0 && discoveryError === undefined) {
          discoveryError = `'${binaryPath} models list' returned no models.`;
        }

        const models =
          cliModels.length > 0 ? mergeDevinModelDescriptors([cliModels]) : fallbackResult.models;

        return {
          models,
          source: cliModels.length > 0 ? "devin-cli" : fallbackResult.source,
          cached: false,
          ...(discoveryError !== undefined ? { error: discoveryError } : {}),
        } satisfies ProviderListModelsResult;
      }).pipe(
        Effect.scoped,
        Effect.timeoutOption(DEVIN_MODEL_DISCOVERY_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.succeed({
                ...fallbackResult,
                error: `Timed out after ${Math.round(DEVIN_MODEL_DISCOVERY_TIMEOUT_MS / 1000)}s while discovering Devin models via CLI.`,
              } satisfies ProviderListModelsResult),
            onSome: (result) => Effect.succeed(result),
          }),
        ),
      );
    };
    const discoverDevinModels = makeCachedDevinModelDiscovery({
      discoveryLock,
      discover: discoverDevinModelsUncached,
    });

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
            method: "session/update",
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
        yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, ctx.activeTurnId);
        ctx.gatewaySessionLease?.release();
        yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        if (ctx.sessionConfigReady !== undefined) {
          yield* Deferred.succeed(ctx.sessionConfigReady, undefined);
          ctx.sessionConfigReady = undefined;
        }
        if (ctx.resumeReplayReady !== undefined) {
          yield* Deferred.succeed(ctx.resumeReplayReady, undefined);
          ctx.resumeReplayReady = undefined;
          ctx.resumeReplayLastSuppressedAt = undefined;
        }
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* closeDevinSessionResources({
          scope: ctx.scope,
          config: ctx.devinSessionConfig,
        });
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const waitForDevinQueuedTurnEventsDrained = (ctx: DevinSessionContext) =>
      waitForAcpQueuedTurnEventsDrained({
        sessionUpdatesEnqueuedCount: ctx.acp.sessionUpdatesEnqueuedCount,
        sessionUpdatesProcessed: () => ctx.sessionUpdatesProcessed,
        maxWaitMs: DEVIN_TURN_SETTLE_DRAIN_MAX_WAIT_MS,
        pollMs: DEVIN_TURN_SETTLE_DRAIN_POLL_MS,
      });

    const noteSuppressedDevinRuntimeEvent = (
      ctx: DevinSessionContext,
      eventTag: string,
      reason: "resume-replay" | "orphan-turn-event",
    ) =>
      Effect.gen(function* () {
        if (reason === "resume-replay") {
          ctx.resumeReplayLastSuppressedAt = Date.now();
        }
        if (!isDevinAcpDebugEnabled()) {
          return;
        }
        yield* Effect.logInfo("devin.acp.runtime_event_suppressed", {
          threadId: ctx.threadId,
          turnId: ctx.activeTurnId,
          eventTag,
          reason,
        });
      });

    const activeTurnIdForDevinRuntimeEvent = (ctx: DevinSessionContext, eventTag: string) =>
      Effect.gen(function* () {
        if (ctx.resumeReplayReady !== undefined) {
          yield* noteSuppressedDevinRuntimeEvent(ctx, eventTag, "resume-replay");
          return undefined;
        }
        if (ctx.compactingThread) {
          return undefined;
        }
        if (ctx.activeTurnId === undefined) {
          yield* noteSuppressedDevinRuntimeEvent(ctx, eventTag, "orphan-turn-event");
          return undefined;
        }
        return ctx.activeTurnId;
      });

    const emitDevinContextCompactionRuntimeEvent = (
      ctx: DevinSessionContext,
      input: {
        readonly lifecycle: "item.updated" | "item.completed";
        readonly status: "inProgress" | "completed" | "failed";
        readonly title: string;
        readonly detail?: string;
      },
    ) =>
      Effect.gen(function* () {
        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: input.lifecycle,
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          itemId: RuntimeItemId.makeUnsafe(`devin-compaction:${ctx.threadId}`),
          payload: {
            itemType: "context_compaction",
            status: input.status,
            title: input.title,
            ...(input.detail ? { detail: input.detail } : {}),
          },
        });
      });

    // Waits until the notification consumer has been quiet briefly so state it
    // records from queued events (e.g. compactionFailedToolDetail) is visible
    // before the compaction outcome is decided. Bounded — a chatty session
    // cannot hold the /compact RPC open past the cap.
    const settleDevinCompactionOutcome = (ctx: DevinSessionContext) =>
      Effect.gen(function* () {
        // First drain events that were already enqueued when the /compact
        // response resolved — a backlogged consumer may not have applied a
        // failed compaction tool update yet, and the quiet window below only
        // covers in-transit stragglers, not the existing backlog.
        yield* waitForDevinQueuedTurnEventsDrained(ctx);
        const startedAt = Date.now();
        while (true) {
          const now = Date.now();
          // Seed the quiet measurement from startedAt: a backlogged consumer
          // may not have bumped lastTurnActivityAt yet, so always wait at
          // least one full quiet interval after the prompt response before
          // deciding the outcome.
          const lastActivityAt = Math.max(ctx.lastTurnActivityAt ?? 0, startedAt);
          if (
            now - lastActivityAt >= DEVIN_COMPACT_OUTCOME_QUIET_MS ||
            now - startedAt >= DEVIN_COMPACT_OUTCOME_MAX_WAIT_MS
          ) {
            return;
          }
          yield* Effect.sleep(50);
        }
      });

    // After a timed-out /compact, hold new prompts until the forked cancel is
    // on the wire (bounded — a fully wedged child never confirms) and the
    // stale update stream has had its quiet window. stdio ordering then
    // guarantees the cancel cannot cancel the new prompt, and stragglers
    // cannot be attributed to the new turn.
    const waitForAbandonedDevinCompaction = (ctx: DevinSessionContext) =>
      Effect.gen(function* () {
        const cancelFiber = ctx.compactionCancelFiber;
        if (cancelFiber !== undefined) {
          yield* Fiber.join(cancelFiber).pipe(
            Effect.ignoreCause(),
            Effect.timeoutOption(DEVIN_COMPACT_CANCEL_WAIT_MS),
          );
          ctx.compactionCancelFiber = undefined;
          // The cancel wait can outlive the quiet window armed at the original
          // compaction timeout; restart it from now so stragglers arriving
          // just after the cancel drains are still held off (and dropped).
          if (ctx.compactionQuietUntil !== undefined) {
            ctx.compactionQuietUntil = Math.max(
              ctx.compactionQuietUntil,
              Date.now() + DEVIN_COMPACT_ABANDON_QUIET_MS,
            );
          }
        }
        const compactionQuietUntil = ctx.compactionQuietUntil;
        if (compactionQuietUntil !== undefined) {
          const waitMs = compactionQuietUntil - Date.now();
          if (waitMs > 0) {
            yield* Effect.sleep(waitMs);
          }
          ctx.compactionQuietUntil = undefined;
        }
      });

    // On session/load, Devin can replay old ACP updates after the session is "ready".
    // Keep suppression active until that stream actually goes quiet — clearing it
    // on a fixed timeout lets late historical deltas leak into the first turn as
    // its content. The hard cap only guards against a replay that never settles.
    const settleDevinResumeReplayWhenQuiet = (ctx: DevinSessionContext) =>
      Effect.gen(function* () {
        const ready = ctx.resumeReplayReady;
        if (ready === undefined) {
          return;
        }
        const startedAt = Date.now();
        ctx.resumeReplayLastSuppressedAt = startedAt;
        while (ctx.resumeReplayReady !== undefined) {
          const now = Date.now();
          const lastSuppressedAt = ctx.resumeReplayLastSuppressedAt ?? startedAt;
          const quietForMs = now - lastSuppressedAt;
          const elapsedMs = now - startedAt;
          if (
            quietForMs >= DEVIN_RESUME_REPLAY_QUIET_MS ||
            elapsedMs >= DEVIN_RESUME_REPLAY_HARD_TIMEOUT_MS
          ) {
            const timedOut = elapsedMs >= DEVIN_RESUME_REPLAY_HARD_TIMEOUT_MS;
            ctx.resumeReplayReady = undefined;
            ctx.resumeReplayLastSuppressedAt = undefined;
            if (timedOut) {
              yield* Effect.logWarning("devin.acp.resume_replay_quiet_wait_timeout", {
                threadId: ctx.threadId,
                elapsedMs,
              });
            }
            yield* Deferred.succeed(ready, undefined);
            return;
          }
          yield* Effect.sleep(Math.min(DEVIN_RESUME_REPLAY_QUIET_MS - quietForMs, 50));
        }
        yield* Deferred.succeed(ready, undefined);
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

          const cwd = resolveAcpSessionCwd({
            inputCwd: input.cwd,
            serverCwd: serverConfig.cwd,
            homeDir: serverConfig.homeDir,
          });
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

          const devinSessionConfig = yield* Effect.tryPromise({
            try: async () => {
              if (!gatewaySessionLease || !agentGatewayCredentials) return undefined;
              const bootstrapToken = gatewaySessionLease.issueStdioBootstrapToken?.();
              if (!bootstrapToken)
                throw new Error("Synara gateway bootstrap token was unavailable.");
              return createDevinSessionConfig({
                connection: gatewaySessionLease.connection,
                stdioProxy: agentGatewayCredentials.stdioProxy,
                bootstrapToken,
              });
            },
            catch: (error) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/start",
                detail:
                  error instanceof Error ? error.message : "Failed to install Devin MCP config.",
              }),
          });
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred || !devinSessionConfig
              ? Effect.void
              : Effect.promise(devinSessionConfig.cleanup),
          );

          let ctx!: DevinSessionContext;
          const resumeSessionId = parseDevinResume(input.resumeCursor)?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });
          const acpRuntimeLoggers = makeAcpDebugLoggers({
            base: acpNativeLoggers,
            enabled: isDevinAcpDebugEnabled(),
            provider: PROVIDER,
            marker: DEVIN_ACP_TRANSPORT_DEBUG_MARKER,
            payloadLimit: DEVIN_ACP_LOG_PAYLOAD_LIMIT,
            shouldMirrorIncomingRaw: (payload) => payload.includes("devinShell"),
          });
          const providerDevinOptions = readDevinProviderStartOptions(input.providerOptions);
          const discoveryBinaryPath = resolveDevinBinaryPath(
            providerDevinOptions?.binaryPath?.trim() || devinSettings.binaryPath,
          );
          const effectiveModel = yield* resolveDevinStartModel({
            explicitModel: devinSettings.model,
            modelSelection: devinModelSelection,
            discoverModels: () => discoverDevinModels(discoveryBinaryPath),
          });
          const effectiveDevinSettings: DevinAcpRuntimeSettings = {
            ...(devinSettings.binaryPath !== undefined
              ? { binaryPath: devinSettings.binaryPath }
              : {}),
            ...(effectiveModel !== undefined ? { model: effectiveModel } : {}),
            ...(providerDevinOptions?.binaryPath !== undefined
              ? { binaryPath: providerDevinOptions.binaryPath }
              : {}),
          };

          yield* Effect.logInfo("devin.acp.start", {
            marker: DEVIN_ACP_TRANSPORT_DEBUG_MARKER,
            debugEnv: DEVIN_ACP_DEBUG_ENV,
            threadId: input.threadId,
            cwd,
            resume: resumeSessionId !== undefined,
            model: effectiveDevinSettings.model,
            requestedModel: devinModelSelection?.model,
            modelVariant: devinModelSelection?.options?.modelVariant,
            reasoningEffort: devinModelSelection?.options?.reasoningEffort,
            apiKeyConfigured: hasDevinApiKeyEnv(),
            alwaysApprove: input.runtimeMode === "full-access",
            binaryPath: effectiveDevinSettings.binaryPath ?? "devin",
          });

          const acp = yield* createAcpRuntime({
            devinSettings: effectiveDevinSettings,
            childProcessSpawner,
            cwd,
            runtimeMode: input.runtimeMode,
            clientInfo: { name: "Synara", version: "0.0.0" },
            clientCapabilities: { elicitation: { form: {} } },
            ...(resumeSessionId ? { resumeSessionId } : {}),
            ...(devinSessionConfig ? { sessionConfig: devinSessionConfig } : {}),
            ...acpRuntimeLoggers,
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(acpToAdapterError(input.threadId)),
          );

          yield* startAgentGatewaySessionLeaseExitWatcher(gatewaySessionLease, acp.awaitExit);

          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/request_permission", params);

                const policyOutcome = resolveAcpPermissionPolicy({
                  runtimeMode: input.runtimeMode,
                  interactionMode: ctx?.activeInteractionMode,
                  options: params.options,
                });
                if (policyOutcome !== undefined) {
                  return { outcome: policyOutcome };
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

                if (!isFormElicitationRequest(params)) {
                  return {
                    action: "decline",
                  } satisfies Acp.CreateElicitationResponse;
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
                    action: "decline",
                  } as Acp.CreateElicitationResponse),
                ),
              ),
            );

            return yield* acp.start().pipe(Effect.mapError(acpToAdapterError(input.threadId)));
          });

          const resumeReplayReady =
            resumeSessionId !== undefined ? yield* Deferred.make<void>() : undefined;
          const sessionConfigReady = yield* Deferred.make<void>();
          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            // Keep the logical family slug in the session projection. The
            // concrete variant is a process-start detail; reporting it here
            // would make the reactor compare the family slug to the variant
            // UID and restart Devin on every subsequent turn.
            model: devinModelSelection?.model ?? effectiveDevinSettings.model,
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
            activeInteractionMode: undefined,
            activeTurnId: undefined,
            activeTurnHadAssistantContent: false,
            activeAssistantItemsWithContent: new Set(),
            activeTurnFailedToolDetail: undefined,
            activePromptFiber: undefined,
            activePromptResolved: false,
            lastSettledTurnId: undefined,
            lastPlanFingerprint: undefined,
            lastTurnActivityAt: undefined,
            turnToolCallIds: new Map(),
            sessionUpdatesProcessed: 0,
            sessionConfigReady,
            resumeReplayReady,
            resumeReplayLastSuppressedAt: resumeReplayReady !== undefined ? Date.now() : undefined,
            turnStarting: false,
            pendingTurnInterrupted: false,
            compactingThread: false,
            compactionFailedToolDetail: undefined,
            compactionQuietUntil: undefined,
            compactionCancelFiber: undefined,
            latestSessionCostUsd: undefined,
            stopped: false,
            gatewaySessionLease,
            devinSessionConfig,
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                // Only genuine turn-progress events keep the idle watchdog at
                // bay; mode/config/usage heartbeats must not mask a hung turn.
                if (isAcpTurnProgressEventTag(event._tag)) {
                  ctx.lastTurnActivityAt = Date.now();
                }
                switch (event._tag) {
                  case "ModeChanged":
                    return;

                  case "AssistantItemStarted":
                    {
                      const activeTurnId = yield* activeTurnIdForDevinRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      // Content deltas open the visible message; empty starts only add noise.
                    }
                    return;

                  case "AssistantItemCompleted":
                    {
                      const activeTurnId = yield* activeTurnIdForDevinRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      const scopedItemId = scopeDevinRuntimeItemIdForTurn(
                        activeTurnId,
                        event.itemId,
                      );
                      if (!ctx.activeAssistantItemsWithContent.has(scopedItemId)) {
                        if (isDevinAcpDebugEnabled()) {
                          yield* Effect.logInfo("devin.acp.empty_assistant_item_suppressed", {
                            threadId: ctx.threadId,
                            turnId: activeTurnId,
                            itemId: scopedItemId,
                          });
                        }
                        return;
                      }
                      ctx.activeAssistantItemsWithContent.delete(scopedItemId);
                      yield* offerRuntimeEvent(
                        input.lifecycleGeneration,
                        makeAcpAssistantItemEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId: activeTurnId,
                          itemId: scopedItemId,
                          lifecycle: "item.completed",
                        }),
                      );
                    }
                    return;

                  case "PlanUpdated":
                    {
                      const activeTurnId = yield* activeTurnIdForDevinRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                      yield* emitPlanUpdate(ctx, event.payload, event.rawPayload);
                    }
                    return;

                  case "ToolCallUpdated":
                    {
                      if (ctx.compactingThread) {
                        const failedToolDetail = readAcpFailedToolDetail(event.toolCall);
                        if (failedToolDetail !== undefined) {
                          ctx.compactionFailedToolDetail = failedToolDetail;
                        }
                        return;
                      }
                      // A tool call already mapped to an older turn keeps that
                      // provenance even while a newer turn is active: emit under
                      // the recorded turn so its row resolves in place, and never
                      // let a trailing update mutate the current turn's failure
                      // state. Resume replay stays suppressed like every other
                      // event.
                      const recordedTurnId = resolveDevinToolCallUpdatedTurnId({
                        toolCallId: event.toolCall.toolCallId,
                        activeTurnId: ctx.activeTurnId,
                        resumeReplayReady: ctx.resumeReplayReady !== undefined,
                        toolCallTurnIds: ctx.turnToolCallIds,
                      });
                      if (recordedTurnId !== undefined && recordedTurnId !== ctx.activeTurnId) {
                        yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                        yield* offerRuntimeEvent(
                          input.lifecycleGeneration,
                          makeAcpToolCallEvent({
                            stamp: yield* makeEventStamp(),
                            provider: PROVIDER,
                            threadId: ctx.threadId,
                            turnId: recordedTurnId,
                            toolCall: scopeDevinToolCallStateForTurn(
                              recordedTurnId,
                              event.toolCall,
                            ),
                            rawPayload: event.rawPayload,
                          }),
                        );
                        return;
                      }
                      const activeTurnId = yield* activeTurnIdForDevinRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      ctx.turnToolCallIds.set(event.toolCall.toolCallId, activeTurnId);
                      yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                      const failedToolDetail = readAcpFailedToolDetail(event.toolCall);
                      if (failedToolDetail !== undefined) {
                        ctx.activeTurnFailedToolDetail = failedToolDetail;
                      }
                      yield* offerRuntimeEvent(
                        input.lifecycleGeneration,
                        makeAcpToolCallEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId: activeTurnId,
                          toolCall: scopeDevinToolCallStateForTurn(activeTurnId, event.toolCall),
                          rawPayload: event.rawPayload,
                        }),
                      );
                    }
                    return;

                  case "ContentDelta":
                    {
                      const activeTurnId = yield* activeTurnIdForDevinRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                      const scopedItemId = event.itemId
                        ? scopeDevinRuntimeItemIdForTurn(activeTurnId, event.itemId)
                        : undefined;
                      if (isRenderableDevinAssistantDelta(event)) {
                        ctx.activeTurnHadAssistantContent = true;
                        if (scopedItemId !== undefined) {
                          ctx.activeAssistantItemsWithContent.add(scopedItemId);
                        }
                      }
                      yield* offerRuntimeEvent(
                        input.lifecycleGeneration,
                        makeAcpContentDeltaEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId: activeTurnId,
                          ...(scopedItemId ? { itemId: scopedItemId } : {}),
                          text: event.text,
                          ...(event.streamKind ? { streamKind: event.streamKind } : {}),
                          rawPayload: event.rawPayload,
                        }),
                      );
                    }
                    return;

                  case "UsageUpdated":
                    {
                      const activeTurnId = yield* activeTurnIdForDevinRuntimeEvent(ctx, event._tag);
                      if (activeTurnId === undefined) {
                        return;
                      }
                      yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                      recordAcpSessionCost(ctx, event.cost);
                      yield* offerRuntimeEvent(
                        input.lifecycleGeneration,
                        makeAcpTokenUsageEvent({
                          stamp: yield* makeEventStamp(),
                          provider: PROVIDER,
                          threadId: ctx.threadId,
                          turnId: activeTurnId,
                          usage: event.usage,
                          method: "session/update",
                          rawPayload: event.rawPayload,
                        }),
                      );
                    }
                    return;
                }
              }).pipe(
                // Bump the processed count only after the handler fully ran, so
                // waitForDevinQueuedTurnEventsDrained cannot observe an event as
                // consumed while its state updates are still being applied.
                Effect.ensuring(
                  Effect.sync(() => {
                    ctx.sessionUpdatesProcessed += 1;
                  }),
                ),
              ),
            ),
            // The drain's lifetime is the session's, not the caller's: forking it as
            // a child of the fiber that called startSession kills it as soon as that
            // fiber returns, silently dropping every session/update.
          ).pipe(Effect.forkIn(sessionScope));

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          // Startup finalization runs after the consumer fork so replay emitted
          // while it is in flight keeps draining. The session is already registered,
          // and the start-scope finalizer no longer owns the session scope, so any failure
          // OR interruption of the remaining startup steps must tear the session
          // down explicitly instead of leaking a live child.
          yield* Effect.gen(function* () {
            yield* applyDevinSessionConfiguration({
              runtime: acp,
              runtimeMode: input.runtimeMode,
              interactionMode: undefined,
            });
            // Startup configuration has settled; turns gated on this deferred
            // can now prompt. Devin model options are process-start settings.
            yield* Deferred.succeed(sessionConfigReady, undefined);
            ctx.sessionConfigReady = undefined;

            if (resumeReplayReady !== undefined) {
              // Settle the replay in the background: suppression stays active until
              // the stream is genuinely quiet, while startup only blocks briefly so
              // a long replay cannot hold session startup hostage. sendTurn and
              // compactThread await the deferred, so the first turn stays gated
              // until the replay has actually finished.
              yield* settleDevinResumeReplayWhenQuiet(ctx).pipe(Effect.forkIn(ctx.scope));
              yield* Deferred.await(resumeReplayReady).pipe(
                Effect.timeoutOption(DEVIN_RESUME_REPLAY_MAX_WAIT_MS),
              );
            }

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
          }).pipe(
            Effect.onExit((exit) =>
              Exit.isSuccess(exit) ? Effect.void : Effect.ignore(stopSessionInternal(ctx)),
            ),
          );

          return session;
        }).pipe(Effect.scoped),
      );

    // Idle-progress watchdog escape hatch: force-fail a turn whose devin child
    // is alive but has gone completely silent. Mirrors the prompt-fiber
    // onFailure branch and stays idempotent via settleDevinActiveTurn, so it is
    // a no-op if the turn settled normally first (whichever fires first wins).
    const failDevinTurnAsTimedOut = (ctx: DevinSessionContext, turnId: TurnId, idleMs: number) =>
      Effect.gen(function* () {
        const promptFiber = ctx.activePromptFiber;
        if (ctx.activeTurnId !== turnId) {
          return;
        }
        yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
        if (!settleDevinActiveTurn(ctx, turnId)) {
          return;
        }
        const completedCost = finalizeAcpActiveTurnCost(ctx);
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
        // Best-effort: tell the child to abandon the turn, then unwind the
        // pending prompt fiber (its onInterrupt no-ops, the turn is cleared).
        // The cancel is forked, not awaited — this path only runs because the
        // child went silent, and a hung session/cancel must not block the
        // prompt-fiber interrupt or leak the watchdog fiber.
        yield* Effect.ignore(ctx.acp.cancel).pipe(Effect.forkIn(ctx.scope));
        if (promptFiber) {
          yield* Fiber.interrupt(promptFiber);
        }
      });

    const sendTurn: DevinAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        // compactThread holds the thread lock but sendTurn intentionally does not
        // (turns are long-running); reject instead of racing a second prompt whose
        // events the compaction suppression would silently drop. Setting
        // turnStarting in the same synchronous block as this check closes the
        // reverse gap: startDevinTurn awaits config/attachment work before it
        // assigns ctx.activeTurnId, and compactThread checks turnStarting so a
        // compaction prompt cannot slip into that window.
        if (ctx.compactingThread) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Cannot start a turn while Devin context compaction is in progress.",
          });
        }
        // A second sendTurn entering while another turn is still starting would
        // clear that turn's pendingTurnInterrupted flag (letting a cancelled
        // turn dispatch anyway) and race two ACP prompts; reject it instead.
        if (ctx.turnStarting) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Another Devin turn is still starting for this thread.",
          });
        }
        if (ctx.activeTurnId !== undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Another Devin turn is already active for this thread.",
          });
        }
        ctx.turnStarting = true;
        ctx.pendingTurnInterrupted = false;
        return yield* startDevinTurn(ctx, input).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              ctx.turnStarting = false;
            }),
          ),
        );
      });

    const startDevinTurn = (
      ctx: DevinSessionContext,
      input: Parameters<DevinAdapterShape["sendTurn"]>[0],
    ) =>
      Effect.gen(function* () {
        // Startup registers the session before post-registration setup settles;
        // a turn routed in during that window must wait for setup to finish.
        if (ctx.sessionConfigReady !== undefined) {
          yield* Deferred.await(ctx.sessionConfigReady);
        }
        if (ctx.resumeReplayReady !== undefined) {
          yield* Deferred.await(ctx.resumeReplayReady);
        }
        yield* waitForAbandonedDevinCompaction(ctx);
        // The gates above are resolved by stopSessionInternal too (a failed or
        // stopped startup must not strand waiters); a turn that was blocked on
        // them must fail here instead of emitting lifecycle events for a dead
        // session.
        if (ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        const turnId = TurnId.makeUnsafe(crypto.randomUUID());
        const model =
          input.modelSelection?.provider === PROVIDER ? input.modelSelection.model : undefined;
        const interactionMode = resolveAcpTurnInteractionMode(input.interactionMode);
        // Model selection rides the process-start `--model` flag; only the
        // fail-closed mode gate applies per turn.
        yield* applyDevinSessionConfiguration({
          runtime: ctx.acp,
          runtimeMode: ctx.session.runtimeMode,
          interactionMode,
        });

        const promptParts = yield* buildDevinPromptParts({
          text: input.input,
          attachments: input.attachments,
          attachmentsDir: serverConfig.attachmentsDir,
          interactionMode,
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
          scopedGatewayConnectionAvailable: ctx.devinSessionConfig?.installed === true,
        });
        if (harnessPolicy) {
          promptParts.unshift(harnessPolicy);
        }

        // A stop can land while the pre-prompt work or attachment reads above were
        // in flight; opening the turn now would publish turn.started (and a
        // phantom cancelled completion) for a session that already exited.
        if (ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }
        // Interrupts that landed during the pre-prompt waits (resume replay,
        // mode configuration, attachment reads) are honored by the prompt fiber's
        // dispatch guard below, so the turn completes through the normal
        // cancelled path instead of surfacing as a provider turn-start failure.
        // A trailing ToolCallUpdated can lag by at most one turn (the
        // session/update stream is FIFO), so keep the last settled turn's
        // tool-call mapping for in-place resolution of its stragglers; anything
        // older is dropped (bounded to one turn of tool-call ids). The settled
        // turn is read from lastSettledTurnId (captured at the settle boundary),
        // not activeTurnId, which clearAcpActiveTurn already wiped.
        const keptTurnId = ctx.lastSettledTurnId;
        ctx.lastSettledTurnId = undefined;
        ctx.activeTurnId = turnId;
        ctx.activeTurnHadAssistantContent = false;
        ctx.activeAssistantItemsWithContent.clear();
        ctx.activeTurnFailedToolDetail = undefined;
        // A new turn starts with an unresolved prompt; a late interrupt must be
        // free to cancel it until ctx.acp.prompt actually returns.
        ctx.activePromptResolved = false;
        pruneDevinToolCallTurnIds(ctx.turnToolCallIds, keptTurnId);
        ctx.activeInteractionMode = interactionMode;
        ctx.lastPlanFingerprint = undefined;
        ctx.lastTurnActivityAt = Date.now();

        const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
        ctx.session = {
          ...sessionWithoutLastError,
          status: "running",
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
          ...(model ? { model } : {}),
        };

        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: model ? { model } : {},
        });

        const runPrompt = Effect.suspend(() =>
          // interruptTurn during the pre-prompt waits (resume replay, mode
          // configuration, attachment reads) or between turn.started publishing
          // and this fiber being registered sets pendingTurnInterrupted; honor
          // it (and a concurrent stop) here so a cancelled turn is never
          // prompted. Self-interrupting routes through the onInterrupt branch
          // below, which completes the turn as cancelled rather than as a
          // provider failure.
          ctx.pendingTurnInterrupted || ctx.stopped
            ? Effect.interrupt
            : ctx.acp.prompt({
                prompt: promptParts,
                _meta: buildDevinPromptMeta(interactionMode),
              }),
        ).pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
          ),
          Effect.matchEffect({
            onFailure: (error) =>
              Effect.gen(function* () {
                if (ctx.activeTurnId !== turnId) return;
                ctx.activePromptResolved = true;
                yield* waitForDevinQueuedTurnEventsDrained(ctx);
                yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
                if (!settleDevinActiveTurn(ctx, turnId)) return;
                const completedCost = finalizeAcpActiveTurnCost(ctx);
                ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, error }] });
                const detail = error.message;
                ctx.session = {
                  ...ctx.session,
                  status: "error",
                  updatedAt: yield* nowIso,
                  ...(model ? { model } : {}),
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
                // Transport/prompt failures make the ACP child unusable. Remove
                // it from routing immediately so ProviderService can recover on
                // the next send instead of reusing a dead session forever.
                yield* stopSessionInternal(ctx);
              }),
            onSuccess: (result) =>
              Effect.gen(function* () {
                if (ctx.activeTurnId !== turnId) return;
                ctx.activePromptResolved = true;
                // Drain BEFORE snapshotting turn state: queued events may still
                // set activeTurnFailedToolDetail or assistant-content flags.
                yield* waitForDevinQueuedTurnEventsDrained(ctx);
                const hadAssistantContent = ctx.activeTurnHadAssistantContent;
                const failedToolDetail = ctx.activeTurnFailedToolDetail;
                yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
                if (!settleDevinActiveTurn(ctx, turnId)) return;
                const completedCost = finalizeAcpActiveTurnCost(ctx);
                ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
                const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
                ctx.session = {
                  ...sessionWithoutLastError,
                  status: "ready",
                  updatedAt: yield* nowIso,
                  ...(model ? { model } : {}),
                };
                if (!hadAssistantContent && result.stopReason !== "cancelled") {
                  yield* Effect.logWarning("devin.acp.turn_completed_without_content", {
                    threadId: input.threadId,
                    turnId,
                    stopReason: result.stopReason ?? null,
                    hasUsage: result.usage !== undefined,
                  });
                }
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
              // User interruption leaves a resolved prompt fiber alive. If
              // teardown interrupts it while the turn remains active, settle
              // it here before session.exited. settleDevinActiveTurn makes
              // watchdog and prior-settlement races no-ops.
              if (!settleDevinActiveTurn(ctx, turnId)) return;
              const completedCost = finalizeAcpActiveTurnCost(ctx);
              ctx.turns.push({
                id: turnId,
                items: [{ prompt: promptParts, interrupted: true }],
              });
              const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
              ctx.session = {
                ...sessionWithoutLastError,
                status: "ready",
                updatedAt: yield* nowIso,
                ...(model ? { model } : {}),
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

        // Backstop the forked prompt: if the child goes silent, fail the turn
        // instead of leaving it "Working" forever. Self-terminates when the
        // turn settles; pauses while a human approval is pending.
        yield* forkAcpAdapterTurnIdleWatchdog({
          context: ctx,
          turnId,
          idleTimeoutMs: DEVIN_TURN_IDLE_TIMEOUT_MS,
          checkIntervalMs: DEVIN_TURN_WATCHDOG_INTERVAL_MS,
          onIdleTimeout: (idleMs) => failDevinTurnAsTimedOut(ctx, turnId, idleMs),
        });

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      });

    const interruptTurn: DevinAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (turnId !== undefined && turnId !== ctx.activeTurnId) {
          yield* Effect.logWarning("devin.acp.stale_interrupt_ignored", {
            threadId,
            requestedTurnId: turnId,
            activeTurnId: ctx.activeTurnId,
          });
          return;
        }
        const activeTurnId = turnId ?? ctx.activeTurnId;
        // A turn that is still starting has no prompt fiber to interrupt yet
        // (it may be gated on resume replay); flag it so startDevinTurn aborts
        // before prompting instead of running the cancelled turn anyway.
        if (ctx.turnStarting && ctx.activePromptFiber === undefined) {
          ctx.pendingTurnInterrupted = true;
        }
        yield* withAgentGatewayTurnCancellation(
          ctx.gatewaySessionLease,
          activeTurnId,
          Effect.gen(function* () {
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
            // A resolved prompt is already draining or settling its result.
            // Leave that fiber alive so onInterrupt cannot reclassify it.
            if (activePromptFiber !== undefined && !ctx.activePromptResolved) {
              yield* Fiber.interrupt(activePromptFiber);
            }
          }),
        );
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
          const ctx = sessions.get(threadId);
          if (!ctx) return;
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
        supportsNativeSlashCommandDiscovery: true,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        supportsThreadCompaction: true,
        supportsThreadImport: false,
      } satisfies ProviderComposerCapabilities);

    const listCommands: NonNullable<DevinAdapterShape["listCommands"]> = (
      input: ProviderListCommandsInput,
    ) => {
      const cwd = resolveAcpSessionCwd({
        inputCwd: input.cwd,
        serverCwd: serverConfig.cwd,
        homeDir: serverConfig.homeDir,
      });
      const cacheKey =
        cwd === undefined
          ? undefined
          : `${input.binaryPath?.trim() || devinSettings.binaryPath?.trim() || "devin"}\u0000${cwd}`;
      const cached = cacheKey === undefined ? undefined : commandDiscoveryCache.get(cacheKey);
      // Fast path: serve a fresh cached result without serializing behind the
      // discovery lock.
      if (
        cacheKey !== undefined &&
        input.forceReload !== true &&
        cached &&
        cached.expiresAt > Date.now()
      ) {
        return Effect.succeed({ ...cached.result, cached: true });
      }
      return discoveryLock.withPermits(1)(
        Effect.gen(function* () {
          const cwd = resolveAcpSessionCwd({
            inputCwd: input.cwd,
            serverCwd: serverConfig.cwd,
            homeDir: serverConfig.homeDir,
          });
          if (!cwd) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "listCommands",
              issue: "cwd is required and no server cwd fallback is available.",
            });
          }
          const binaryPath =
            input.binaryPath?.trim() || devinSettings.binaryPath?.trim() || "devin";
          const cacheKey = `${binaryPath}\u0000${cwd}`;
          // Recheck under the lock: a concurrent discovery may have populated
          // the cache while this fiber waited for the permit.
          const cached = commandDiscoveryCache.get(cacheKey);
          if (input.forceReload !== true && cached && cached.expiresAt > Date.now()) {
            return { ...cached.result, cached: true };
          }

          const runtime = yield* makeDevinDiscoveryRuntime({
            ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
            cwd,
          });
          yield* runtime.start();
          let commands = yield* runtime.getAvailableCommands;
          const startedAt = Date.now();
          while (commands.length === 0 && Date.now() - startedAt < 500) {
            yield* Effect.sleep(25);
            commands = yield* runtime.getAvailableCommands;
          }
          const result = {
            commands: mapDevinAcpCommands(commands),
            source: "devin-acp",
            cached: false,
          } satisfies ProviderListCommandsResult;
          setDevinDiscoveryCacheEntry(commandDiscoveryCache, cacheKey, {
            expiresAt: Date.now() + DEVIN_COMMAND_DISCOVERY_CACHE_MS,
            result,
          });
          return result;
        }).pipe(
          Effect.scoped,
          Effect.mapError((cause) =>
            cause instanceof ProviderAdapterValidationError
              ? cause
              : mapAcpToAdapterError(
                  PROVIDER,
                  ThreadId.makeUnsafe("devin-command-discovery"),
                  "command/list",
                  cause,
                ),
          ),
          Effect.timeoutOption(DEVIN_COMMAND_DISCOVERY_TIMEOUT_MS),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "command/list",
                    detail: "Timed out while discovering Devin commands over ACP.",
                  }),
                ),
              onSome: (result) => Effect.succeed(result),
            }),
          ),
        ),
      );
    };

    const compactThread: NonNullable<DevinAdapterShape["compactThread"]> = (threadId) =>
      Effect.gen(function* () {
        // Wait for a settling resume replay before taking the thread lock:
        // stopSession/startSession need that lock, and stopping the session is
        // what resolves the deferred early, so awaiting under the lock would
        // stall stop/restart until the replay quiets or the hard timeout fires.
        const preLockCtx = yield* requireSession(threadId);
        if (preLockCtx.sessionConfigReady !== undefined) {
          yield* Deferred.await(preLockCtx.sessionConfigReady);
        }
        if (preLockCtx.resumeReplayReady !== undefined) {
          yield* Deferred.await(preLockCtx.resumeReplayReady);
        }
        // Claim the compaction slot under the thread lock, but run the
        // (potentially long) /compact prompt outside it: stopSession/restart
        // take the same lock, and a hung compaction must never block
        // stopSessionInternal from cancelling or killing the child.
        const ctx = yield* withThreadLock(threadId, claimDevinCompactionSlot(threadId, preLockCtx));
        return yield* runDevinCompaction(ctx).pipe(
          // compactingThread stays set until this clears it: sendTurn only
          // rejects while the flag is true, so clearing before the
          // completion/thread-state events publish would let a new turn start
          // and then be trailed by stale compaction bookkeeping.
          Effect.ensuring(
            Effect.sync(() => {
              ctx.compactingThread = false;
            }),
          ),
        );
      });

    const claimDevinCompactionSlot = (threadId: ThreadId, preLockCtx: DevinSessionContext) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        // The pre-lock replay wait resolves early when the session is stopped;
        // if a restart won the lock first, this thread id now maps to a fresh
        // session that the original compaction request never targeted.
        if (ctx !== preLockCtx) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "compactThread",
            issue:
              "The Devin session was restarted while waiting to compact; retry once it settles.",
          });
        }
        if (ctx.resumeReplayReady !== undefined) {
          // The session was restarted while waiting above and its new replay
          // window is still settling; reject instead of blocking the lock.
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "compactThread",
            issue: "Cannot compact while the resumed Devin thread is still replaying history.",
          });
        }
        // The prompt runs outside the thread lock, so a concurrent /compact can
        // reach this point while one is already in flight; reject it here.
        if (ctx.compactingThread) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "compactThread",
            issue: "A Devin context compaction is already in progress.",
          });
        }
        // turnStarting covers a sendTurn that is past its compaction check but
        // has not assigned ctx.activeTurnId yet; the check and the flag write
        // below stay in one synchronous block so the two paths cannot interleave.
        if (ctx.activeTurnId !== undefined || ctx.turnStarting) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "compactThread",
            issue: "Cannot compact while a Devin turn is still active.",
          });
        }
        ctx.compactingThread = true;
        ctx.compactionFailedToolDetail = undefined;
        return ctx;
      });

    // Every compaction failure path records the same terminal failed event
    // and surfaces the same request error; only the title/detail differ.
    const failDevinCompaction = (ctx: DevinSessionContext, title: string, detail: string) =>
      Effect.gen(function* () {
        yield* emitDevinContextCompactionRuntimeEvent(ctx, {
          lifecycle: "item.completed",
          status: "failed",
          title,
          detail,
        });
        return yield* Effect.fail(
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/prompt",
            detail,
          }),
        );
      });

    const runDevinCompaction = (ctx: DevinSessionContext) =>
      Effect.gen(function* () {
        // A previous timed-out /compact may still be cancelling; preserve the
        // same ordering requirement as new turns.
        yield* waitForAbandonedDevinCompaction(ctx);
        yield* emitDevinContextCompactionRuntimeEvent(ctx, {
          lifecycle: "item.updated",
          status: "inProgress",
          title: "Compacting context",
        });

        const compactResult = yield* runDevinAcpCompactionCommand(ctx.acp).pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, ctx.threadId, "session/prompt", error),
          ),
          Effect.timeoutOption(DEVIN_COMPACT_TIMEOUT_MS),
          Effect.exit,
        );

        if (Exit.isFailure(compactResult)) {
          // Interruption (session stopping) is not a compaction failure; let it unwind.
          if (Cause.hasInterruptsOnly(compactResult.cause)) {
            return yield* Effect.failCause(compactResult.cause);
          }
          const squashed = Cause.squash(compactResult.cause);
          const detail = squashed instanceof Error ? squashed.message : String(squashed);
          return yield* failDevinCompaction(ctx, "Context compaction failed", detail);
        }

        const promptResponse = Option.getOrUndefined(compactResult.value);
        if (promptResponse === undefined) {
          // Timed out: tell the child to abandon the prompt (best effort) and
          // surface the failure instead of leaving compactingThread wedged.
          // The cancel may take a moment to drain; suppress stragglers so the
          // next turn cannot inherit stale compaction updates. The cancel is
          // forked, not awaited: the child just proved it can go silent, and a
          // hung session/cancel would keep compactingThread set forever.
          ctx.compactionQuietUntil = Date.now() + DEVIN_COMPACT_ABANDON_QUIET_MS;
          ctx.compactionCancelFiber = yield* Effect.ignore(ctx.acp.cancel).pipe(
            Effect.forkIn(ctx.scope),
          );
          const detail = `Devin did not finish context compaction within ${Math.round(DEVIN_COMPACT_TIMEOUT_MS / 1000)}s; the compaction was abandoned.`;
          yield* Effect.logWarning("devin.acp.compact_timeout", {
            threadId: ctx.threadId,
            timeoutMs: DEVIN_COMPACT_TIMEOUT_MS,
          });
          return yield* failDevinCompaction(ctx, "Context compaction timed out", detail);
        }

        // The failed-tool detail below is recorded by the notification
        // consumer, which can lag the prompt response (the update may still
        // sit in the event queue); wait for inbound activity to go quiet
        // before deciding the outcome.
        yield* settleDevinCompactionOutcome(ctx);

        // ACP can answer a /compact prompt successfully with stopReason
        // "cancelled" (user interrupt via session/cancel); that is not a
        // completed compaction and must not be persisted as one.
        if (promptResponse.stopReason === "cancelled") {
          const detail = "Devin context compaction was cancelled before it completed.";
          return yield* failDevinCompaction(ctx, "Context compaction cancelled", detail);
        }

        // A compaction tool call can fail while the /compact prompt itself
        // still resolves successfully; honor the recorded failure instead of
        // persisting the compaction as completed.
        const failedToolDetail = ctx.compactionFailedToolDetail;
        if (failedToolDetail !== undefined) {
          return yield* failDevinCompaction(ctx, "Context compaction failed", failedToolDetail);
        }

        // Success: thread.state.changed is the single terminal signal —
        // ingestion projects it into the "Context compacted manually" row, so
        // emitting an item.completed row here too would duplicate it.
        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "thread.state.changed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: {
            state: "compacted",
            detail: { reason: "provider.compactThread" },
          },
        });
      });

    const listModels: NonNullable<DevinAdapterShape["listModels"]> = (input) =>
      discoverDevinModels(
        resolveDevinBinaryPath(input.binaryPath?.trim() || devinSettings.binaryPath),
      );

    const stopAll: DevinAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, {
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
        sessionModelSwitch: "restart-session",
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
      listCommands,
      compactThread,
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

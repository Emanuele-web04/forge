/**
 * DevinAdapterLive - Devin CLI (`devin acp`) via ACP.
 *
 * @module DevinAdapterLive
 */
import {
  ApprovalRequestId,
  type DevinModelOptions,
  EventId,
  type ProviderComposerCapabilities,
  type ProviderApprovalDecision,
  type ProviderListCommandsInput,
  type ProviderListCommandsResult,
  type ProviderInteractionMode,
  type ProviderListModelsResult,
  type ProviderModelDescriptor,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";
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
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as Acp from "@agentclientprotocol/sdk";

import { buildAcpSynaraMcpServers } from "../../agentGateway/mcpInjection.ts";
import {
  type SynaraHarnessPolicyDeliveryState,
  takeSynaraHarnessPolicyTextPartForProviderSession,
} from "../../agentGateway/harnessPolicy.ts";
import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import { PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY } from "../Services/ProviderAdapter.ts";
import {
  acquireAgentGatewaySessionLease,
  cancelAgentGatewayTurn,
  startAgentGatewaySessionLeaseExitWatcher,
  type AgentGatewaySessionLease,
  withAgentGatewayTurnCancellation,
} from "../../agentGateway/sessionLease.ts";
import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { loadProviderPromptImageBlocks } from "../promptAttachments.ts";
import {
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
  makeAcpThreadLock,
  recordAcpSessionCost,
  resolveAcpSessionCwd,
  resolveAcpTurnInteractionMode,
  scopeAcpRuntimeItemIdForTurn,
  scopeAcpToolCallStateForTurn,
  settleAcpPendingApprovalsAsCancelled,
  settleAcpPendingUserInputsAsEmptyAnswers,
  withAcpPlanModePrompt,
} from "../acp/AcpAdapterSessionSupport.ts";
import { type AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
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
import { type AcpToolCallState, parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeAcpDebugLoggers, makeAcpNativeLoggers } from "../acp/AcpNativeLogging.ts";
import {
  forkAcpTurnIdleWatchdog,
  resolveAcpTurnIdleTimeoutMs,
} from "../acp/AcpTurnIdleWatchdog.ts";
import {
  applyDevinAcpModelSelection,
  getDevinApiKeyEnv,
  hasDevinApiKeyEnv,
  makeDevinAcpRuntime,
  mapDevinAcpCommands,
  runDevinAcpCompactionCommand,
  type DevinAcpRuntimeSettings,
} from "../acp/DevinAcpSupport.ts";
import {
  elicitationQuestionsFromRequest,
  elicitationResponseFromAnswers,
  isFormElicitationRequest,
} from "../acp/AcpElicitationSupport.ts";
import { DevinAdapter, type DevinAdapterShape } from "../Services/DevinAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "devin" as const;

export const takeDevinSynaraHarnessPolicyTextPart = (
  state: SynaraHarnessPolicyDeliveryState,
  scopedGatewayConnectionAvailable: boolean,
) =>
  takeSynaraHarnessPolicyTextPartForProviderSession(state, {
    provider: PROVIDER,
    scopedGatewayConnectionAvailable,
  });
const DEVIN_RESUME_VERSION = 1 as const;
const DEVIN_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const DEVIN_COMMAND_DISCOVERY_TIMEOUT_MS = 15_000;
const DEVIN_COMMAND_DISCOVERY_CACHE_MS = 5 * 60_000;
const DEVIN_DISCOVERY_CACHE_MAX_ENTRIES = 16;
const DEVIN_ACP_TRANSPORT_DEBUG_MARKER = "devin-acp-meta-stripper-v2";
const DEVIN_ACP_LOG_PAYLOAD_LIMIT = 4_000;
const DEVIN_ACP_DEBUG_ENV = "SYNARA_DEVIN_ACP_DEBUG";
const SYNARA_DEVIN_ACP_DEBUG_ENV = "SYNARA_DEVIN_ACP_DEBUG";
const LEGACY_DEVIN_ACP_DEBUG_ENV = "DP_DEVIN_ACP_DEBUG";
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
// Generous by design so legitimate long, quiet tool runs are not killed;
// override with SYNARA_DEVIN_TURN_IDLE_TIMEOUT_MS when a workload needs longer.
const DEVIN_TURN_IDLE_TIMEOUT_MS = resolveAcpTurnIdleTimeoutMs({
  envVar: "SYNARA_DEVIN_TURN_IDLE_TIMEOUT_MS",
  defaultMs: 600_000,
});
const DEVIN_TURN_WATCHDOG_INTERVAL_MS = 15_000;
// Hard cap on a manual /compact prompt. compactingThread rejects every send
// while set, so a Devin child that goes alive-but-silent mid-compaction would
// otherwise wedge the thread indefinitely. Reuses the turn idle timeout value
// as a generous ceiling (compactions stream activity well under it).
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
// A prompt response can resolve while session/update events received during
// the turn still sit in the ACP event queue. The turn stays active (bounded)
// until that backlog drains so late tool updates keep their turn attribution
// instead of falling into the between-turn heuristics. Zero-cost when the
// consumer is keeping up (the queue is already empty).
const DEVIN_TURN_SETTLE_DRAIN_MAX_WAIT_MS = 1_000;
const DEVIN_TURN_SETTLE_DRAIN_POLL_MS = 25;
const DEVIN_PLAN_MODE_PROMPT_PREFIX = [
  "Synara requested Devin's native plan mode.",
  "Do not implement or mutate files in this turn.",
  "Do not ask follow-up questions or wait for confirmation; if scope is ambiguous, choose a reasonable default and state the assumption in the plan.",
  "When ready, create the final implementation plan.",
].join("\n");
const DEVIN_SESSION_META = {
  provider: PROVIDER,
} satisfies Record<string, unknown>;

export function buildDevinTurnPromptText(input: {
  readonly text: string | undefined;
  readonly interactionMode: ProviderInteractionMode;
}): string | undefined {
  if (input.interactionMode === "plan") {
    return withAcpPlanModePrompt({
      text: input.text ?? "",
      interactionMode: "plan",
      promptPrefix: DEVIN_PLAN_MODE_PROMPT_PREFIX,
    });
  }
  return input.text;
}

export function buildDevinPromptMeta(interactionMode: ProviderInteractionMode): {
  readonly mode: "plan" | "agent";
} {
  // Devin ACP reconciles its native Plan tracker from session/prompt `_meta.mode`.
  // This is idempotent, so reconnects cannot invert the provider state when
  // Synara sends the desired mode again.
  return { mode: interactionMode === "plan" ? "plan" : "agent" };
}

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + new TextDecoder().decode(chunk),
  );

function isDevinAcpDebugEnabled(): boolean {
  return (
    process.env[DEVIN_ACP_DEBUG_ENV] === "1" ||
    process.env[SYNARA_DEVIN_ACP_DEBUG_ENV] === "1" ||
    process.env[LEGACY_DEVIN_ACP_DEBUG_ENV] === "1"
  );
}

export interface DevinAdapterLiveOptions {
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

interface DevinSessionContext {
  harnessPolicyDelivered?: boolean;
  readonly gatewaySessionLease?: AgentGatewaySessionLease;
  readonly threadId: ThreadId;
  readonly lifecycleGeneration?: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeInteractionMode: ProviderInteractionMode | undefined;
  activeTurnId: TurnId | undefined;
  activeTurnHadAssistantContent: boolean;
  readonly activeAssistantItemsWithContent: Set<string>;
  activeTurnFailedToolDetail: string | undefined;
  activePromptFiber: Fiber.Fiber<void, never> | undefined;
  // Epoch-ms of the last inbound ACP activity for the active turn; drives the
  // idle-progress watchdog that force-fails a silently hung turn.
  lastTurnActivityAt: number | undefined;
  // Provider tool-call ids seen during the most recent turn, mapped to that
  // turn. A backlogged consumer can process a queued ToolCallUpdated after the
  // prompt response cleared activeTurnId; this keeps the event attributed to
  // its originating turn instead of the between-turn auto-compaction
  // heuristic. Cleared when the next turn dispatches.
  readonly turnToolCallIds: Map<string, TurnId>;
  // Count of ACP session/update events fully handled by the notification
  // consumer. Compared against acp.sessionUpdatesEnqueuedCount to detect when
  // events received before a prompt response have all been processed —
  // in-flight handlers and stream chunk buffering included.
  sessionUpdatesProcessed: number;
  // Pending until startSession has completed its post-registration setup.
  // The session is registered first so replay keeps draining, which means
  // sendTurn/compactThread can route to it mid-startup; they await this gate
  // until the remaining startup work has settled. Resolved by
  // stopSessionInternal too, like
  // resumeReplayReady, so a failed startup never strands waiters.
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
  // runDevinCompaction reads it so a failed compaction whose /compact prompt
  // still resolves successfully is not persisted as compacted (mirrors how
  // normal turns use activeTurnFailedToolDetail).
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
}

function readDevinProviderStartOptions(
  providerOptions: unknown,
): { readonly binaryPath?: string; readonly model?: string } | undefined {
  if (!isRecord(providerOptions) || !isRecord(providerOptions.devin)) {
    return undefined;
  }
  const binaryPath = providerOptions.devin.binaryPath;
  const model = providerOptions.devin.model;
  return {
    ...(typeof binaryPath === "string" ? { binaryPath } : {}),
    ...(typeof model === "string" ? { model } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setDevinDiscoveryCacheEntry(
  cache: Map<string, { readonly expiresAt: number; readonly result: ProviderListCommandsResult }>,
  key: string,
  value: { readonly expiresAt: number; readonly result: ProviderListCommandsResult },
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

// Devin may reuse ACP item ids across resumed history; DP runtime ids must stay turn-local.
export function scopeDevinToolCallStateForTurn(
  turnId: TurnId,
  toolCall: AcpToolCallState,
): AcpToolCallState {
  return scopeAcpToolCallStateForTurn(PROVIDER, turnId, toolCall);
}

function parseDevinResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== DEVIN_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
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
  const name = readDevinModelString(value, [
    "family_label",
    "familyLabel",
    "name",
    "label",
    "displayName",
    "title",
  ]);
  const description = readDevinModelString(value, ["description", "details"]);
  return {
    slug,
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
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
  return /\bfast\b/u.test(haystack) || /(?:^|[-_])priority(?:$|[-_])/u.test(variant.model);
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
): ProviderModelDescriptor[] {
  const models: ProviderModelDescriptor[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const model of group) {
      const slug = model.slug.trim();
      const key = slug.toLowerCase();
      if (!slug || seen.has(key)) {
        continue;
      }
      seen.add(key);
      const name = model.name?.trim() || formatDevinModelName(slug);
      const description = model.description?.trim();
      const rawVariants = model.variants ?? [];
      const effortValues = uniqueStrings(rawVariants.map(inferDevinReasoningEffort)).sort(
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
      const contextWindowOptions = contextWindowValues.map((value) => ({
        value,
        label: value.toUpperCase(),
        ...(value === defaultContextWindow ? { isDefault: true as const } : {}),
      }));
      models.push({
        slug,
        name,
        ...(description ? { description } : {}),
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

const DEVIN_FALLBACK_MODEL_DESCRIPTORS: ReadonlyArray<DevinModelDescriptorSeed> = [
  { slug: "adaptive", name: "Adaptive model selection" },
  { slug: "devin-fast", name: "SWE-1.6 Fast" },
];

function applyRequestedModelSelection<E>(input: {
  readonly runtime: AcpSessionRuntimeShape;
  readonly modelSelection:
    | {
        readonly model: string;
        readonly options?: DevinModelOptions | null | undefined;
      }
    | undefined;
  readonly mapError: (context: {
    readonly cause: import("../acp/AcpErrors.ts").AcpError;
    readonly method: "session/set_config_option";
  }) => E;
}): Effect.Effect<void, E> {
  if (!input.modelSelection) return Effect.void;
  return applyDevinAcpModelSelection({
    runtime: input.runtime,
    model: input.modelSelection.model,
    mapError: ({ cause, method }) => input.mapError({ cause, method }),
  });
}

function resolveDevinSessionCwd(
  inputCwd: string | undefined,
  serverConfig: ServerConfigShape,
): string | undefined {
  return resolveAcpSessionCwd({
    inputCwd,
    serverCwd: serverConfig.cwd,
    homeDir: serverConfig.homeDir,
  });
}

export function makeDevinAdapter(
  devinSettings: DevinAcpRuntimeSettings,
  options?: DevinAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    // Optional so adapter tests can run without the gateway layer; when
    // present, every session gets the synara_* MCP tools.
    const agentGatewayCredentials = Option.getOrUndefined(
      yield* Effect.serviceOption(AgentGatewayCredentials),
    );
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

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

    // Discovery sessions are disposable and never enter the live session directory.
    const makeDevinDiscoveryRuntime = (input: {
      readonly binaryPath?: string;
      readonly cwd: string;
    }) =>
      makeDevinAcpRuntime({
        devinSettings: {
          ...(devinSettings.binaryPath ? { binaryPath: devinSettings.binaryPath } : {}),
          ...(input.binaryPath ? { binaryPath: input.binaryPath } : {}),
        },
        childProcessSpawner,
        cwd: input.cwd,
        runtimeMode: "approval-required",
        clientInfo: { name: "Synara Command Discovery", version: "0.0.0" },
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
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
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

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<DevinSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
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

    // Holds the active-turn window open until session/update events that were
    // already enqueued when the prompt response resolved have been fully
    // handled by the notification consumer, so they settle with their turn
    // attribution (and recorded failed-tool detail) intact. Snapshotting the
    // runtime's enqueued count and waiting for the adapter's processed count
    // to catch up is immune to stream chunk buffering and in-flight handlers,
    // unlike a queue-size probe. Returns immediately when the consumer kept
    // up; bounded so a chatty stream cannot stall settlement past the cap.
    const waitForDevinQueuedTurnEventsDrained = (ctx: DevinSessionContext) =>
      Effect.gen(function* () {
        const target = yield* ctx.acp.sessionUpdatesEnqueuedCount;
        const startedAt = Date.now();
        while (
          ctx.sessionUpdatesProcessed < target &&
          Date.now() - startedAt < DEVIN_TURN_SETTLE_DRAIN_MAX_WAIT_MS
        ) {
          yield* Effect.sleep(DEVIN_TURN_SETTLE_DRAIN_POLL_MS);
        }
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
          const acpRuntimeLoggers = makeAcpDebugLoggers({
            base: acpNativeLoggers,
            enabled: isDevinAcpDebugEnabled(),
            provider: PROVIDER,
            marker: DEVIN_ACP_TRANSPORT_DEBUG_MARKER,
            payloadLimit: DEVIN_ACP_LOG_PAYLOAD_LIMIT,
            shouldMirrorIncomingRaw: (payload) => payload.includes("devinShell"),
          });
          const providerDevinOptions = readDevinProviderStartOptions(input.providerOptions);
          const effectiveDevinSettings: DevinAcpRuntimeSettings = {
            ...(devinSettings.binaryPath !== undefined
              ? { binaryPath: devinSettings.binaryPath }
              : {}),
            ...(devinSettings.model !== undefined ? { model: devinSettings.model } : {}),
            ...(providerDevinOptions?.binaryPath !== undefined
              ? { binaryPath: providerDevinOptions.binaryPath }
              : {}),
            ...(providerDevinOptions?.model !== undefined
              ? { model: providerDevinOptions.model }
              : {}),
            ...(devinModelSelection?.model ? { model: devinModelSelection.model } : {}),
            // Devin's ACP process accepts a concrete model UID, not a separate
            // effort/context flag. The web client resolves runtime selections
            // to this variant before dispatch; keep the abstract effort as a
            // compatibility fallback for older clients.
            ...(devinModelSelection?.options?.modelVariant
              ? { model: devinModelSelection.options.modelVariant }
              : {}),
            ...(!devinModelSelection?.options?.modelVariant &&
            devinModelSelection?.options?.reasoningEffort
              ? { model: devinModelSelection.options.reasoningEffort }
              : {}),
          };
          const apiKeyConfigured = hasDevinApiKeyEnv() && getDevinApiKeyEnv() !== undefined;

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
            apiKeyConfigured,
            alwaysApprove: input.runtimeMode === "full-access",
            binaryPath: effectiveDevinSettings.binaryPath ?? "devin",
          });

          const acp = yield* makeDevinAcpRuntime({
            devinSettings: effectiveDevinSettings,
            childProcessSpawner,
            cwd,
            runtimeMode: input.runtimeMode,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientCapabilities: { elicitation: { form: {} } },
            clientInfo: { name: "Synara", version: "0.0.0" },
            sessionMeta: DEVIN_SESSION_META,
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
            ...acpRuntimeLoggers,
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", cause),
            ),
          );

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
                  if (policyOutcome.outcome === "selected") {
                    if (isDevinAcpDebugEnabled()) {
                      yield* Effect.logInfo("devin.acp.permission_policy_applied", {
                        threadId: input.threadId,
                        turnId: ctx?.activeTurnId,
                        interactionMode: ctx?.activeInteractionMode,
                        optionId: policyOutcome.optionId,
                        options: params.options.map((option) => ({
                          kind: option.kind,
                          optionId: option.optionId,
                        })),
                        toolKind: params.toolCall.kind,
                        toolTitle: params.toolCall.title,
                      });
                    }
                    return { outcome: policyOutcome };
                  }
                  return { outcome: policyOutcome };
                }
                const permissionRequest = parsePermissionRequest(params);
                const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
                const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                pendingApprovals.set(requestId, { decision, kind: permissionRequest.kind });
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
                return {
                  outcome:
                    resolved === "cancel"
                      ? ({ outcome: "cancelled" } as const)
                      : (() => {
                          const selectedOptionId = selectAcpPermissionOptionId(
                            resolved,
                            params.options,
                          );
                          return selectedOptionId === undefined
                            ? ({ outcome: "cancelled" } as const)
                            : ({
                                outcome: "selected" as const,
                                optionId: selectedOptionId,
                              } as const);
                        })(),
                };
              }),
            );
            yield* acp.handleElicitation((params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/elicitation", params);
                if (!isFormElicitationRequest(params)) {
                  return { action: "decline" as const };
                }
                const questions = elicitationQuestionsFromRequest(params);
                if (questions.length === 0) {
                  return { action: "decline" as const };
                }
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
                });
                return elicitationResponseFromAnswers(params, resolved);
              }),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );
          yield* startAgentGatewaySessionLeaseExitWatcher(gatewaySessionLease, acp.awaitExit);

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
            ...(gatewaySessionLease ? { gatewaySessionLease } : {}),
            ...(input.lifecycleGeneration !== undefined
              ? { lifecycleGeneration: input.lifecycleGeneration }
              : {}),
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            lastPlanFingerprint: undefined,
            activeInteractionMode: undefined,
            activeTurnId: undefined,
            activeTurnHadAssistantContent: false,
            activeAssistantItemsWithContent: new Set(),
            activeTurnFailedToolDetail: undefined,
            activePromptFiber: undefined,
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
          };

          const notificationFiber = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                // Any inbound ACP event proves the child is alive and making
                // progress; reset the idle-progress watchdog clock.
                ctx.lastTurnActivityAt = Date.now();
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
                      // Tool-call updates are handled generically. Devin has no
                      // provider-specific compaction or plan-hook protocol, so
                      // only an active turn (or a known late update) receives
                      // a public runtime event.
                      if (ctx.compactingThread) {
                        const failedToolDetail = readAcpFailedToolDetail(event.toolCall);
                        if (failedToolDetail !== undefined) {
                          ctx.compactionFailedToolDetail = failedToolDetail;
                        }
                        return;
                      }
                      const lateTurnId =
                        ctx.resumeReplayReady === undefined && ctx.activeTurnId === undefined
                          ? ctx.turnToolCallIds.get(event.toolCall.toolCallId)
                          : undefined;
                      if (lateTurnId !== undefined) {
                        yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                        yield* offerRuntimeEvent(
                          input.lifecycleGeneration,
                          makeAcpToolCallEvent({
                            stamp: yield* makeEventStamp(),
                            provider: PROVIDER,
                            threadId: ctx.threadId,
                            turnId: lateTurnId,
                            toolCall: scopeDevinToolCallStateForTurn(lateTurnId, event.toolCall),
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

          ctx.notificationFiber = notificationFiber;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          // Startup finalization runs after the consumer fork so replay emitted
          // while it is in flight keeps draining. The session is already registered,
          // and the start-scope finalizer no longer owns the session scope, so any failure
          // OR interruption of the remaining startup steps must tear the session
          // down explicitly instead of leaking a live child.
          yield* Effect.gen(function* () {
            yield* applyRequestedModelSelection({
              runtime: acp,
              modelSelection: devinModelSelection,
              mapError: ({ cause, method }) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
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
    // onFailure branch and stays idempotent via clearAcpActiveTurn, so it is a
    // no-op if the turn settled normally first (whichever fires first wins).
    const failDevinTurnAsTimedOut = (ctx: DevinSessionContext, turnId: TurnId, idleMs: number) =>
      Effect.gen(function* () {
        const promptFiber = ctx.activePromptFiber;
        if (ctx.activeTurnId !== turnId) {
          return;
        }
        yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
        if (!clearAcpActiveTurn(ctx, turnId)) {
          return;
        }
        const completedCost = finalizeAcpActiveTurnCost(ctx);
        const idleSeconds = Math.round(idleMs / 1000);
        const detail = `Devin stopped responding (no activity for ${idleSeconds}s); the turn was timed out.`;
        ctx.turns.push({ id: turnId, items: [{ prompt: turnId, timedOut: true, idleMs }] });
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
        const turnModelSelection =
          input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
        const model = turnModelSelection?.model ?? ctx.session.model;
        const interactionMode = resolveAcpTurnInteractionMode(input.interactionMode);
        yield* applyRequestedModelSelection({
          runtime: ctx.acp,
          modelSelection:
            model === undefined
              ? undefined
              : {
                  model,
                  options: turnModelSelection?.options,
                },
          mapError: ({ cause, method }) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
        });
        const promptParts: Array<Acp.ContentBlock> = [];
        const promptText = appendFileAttachmentsPromptBlock({
          text: buildDevinTurnPromptText({
            text: input.input?.trim(),
            interactionMode,
          }),
          attachments: input.attachments,
          attachmentsDir: serverConfig.attachmentsDir,
          include: "all-files",
        });
        if (promptText) {
          promptParts.push({
            type: "text",
            text: promptText,
          });
        }
        promptParts.push(
          ...(yield* loadProviderPromptImageBlocks({
            attachments: input.attachments,
            attachmentsDir: serverConfig.attachmentsDir,
            provider: PROVIDER,
            method: "session/prompt",
            readFile: fileSystem.readFile,
          })),
        );

        if (promptParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }
        const harnessPolicy = takeDevinSynaraHarnessPolicyTextPart(
          ctx,
          agentGatewayCredentials !== undefined,
        );
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
        // model selection, attachment reads) are honored by the prompt fiber's
        // dispatch guard below, so the turn completes through the normal
        // cancelled path instead of surfacing as a provider turn-start failure.
        ctx.activeTurnId = turnId;
        ctx.activeTurnHadAssistantContent = false;
        ctx.activeAssistantItemsWithContent.clear();
        ctx.activeTurnFailedToolDetail = undefined;
        // Late-event attribution only matters between turns; once a new turn
        // dispatches, stragglers from older turns are stale enough to drop.
        ctx.turnToolCallIds.clear();
        ctx.activeInteractionMode = interactionMode;
        ctx.lastPlanFingerprint = undefined;
        ctx.lastTurnActivityAt = Date.now();
        const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
        ctx.session = {
          ...sessionWithoutLastError,
          status: "running",
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };

        yield* offerRuntimeEvent(ctx.lifecycleGeneration, {
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { ...(model ? { model } : {}) },
        });

        const runPrompt = Effect.suspend(() =>
          // interruptTurn during the pre-prompt waits (resume replay, model
          // selection, attachment reads) or between turn.started publishing and this
          // fiber being registered sets pendingTurnInterrupted; honor it (and a
          // concurrent stop) here so a cancelled turn is never prompted.
          // Self-interrupting routes through the onInterrupt branch below, which
          // completes the turn as cancelled rather than as a provider failure.
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
                yield* waitForDevinQueuedTurnEventsDrained(ctx);
                if (ctx.activeTurnId !== turnId) {
                  return;
                }
                yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
                if (!clearAcpActiveTurn(ctx, turnId)) {
                  return;
                }
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
              }),
            onSuccess: (result) =>
              Effect.gen(function* () {
                // Drain BEFORE snapshotting turn state: queued events may still
                // set activeTurnFailedToolDetail or assistant-content flags.
                yield* waitForDevinQueuedTurnEventsDrained(ctx);
                if (ctx.activeTurnId !== turnId) {
                  return;
                }
                const hadAssistantContent = ctx.activeTurnHadAssistantContent;
                const failedToolDetail = ctx.activeTurnFailedToolDetail;
                yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
                if (!clearAcpActiveTurn(ctx, turnId)) {
                  return;
                }
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
                // ACP PromptResponse.usage is cumulative session spend, not the
                // live context-window occupancy. Preserve it on turn.completed
                // below, but do not synthesize a context-window update from it:
                // doing so makes the meter grow across turns and stay full after
                // compaction. A real usage_update notification remains the only
                // trustworthy source for Devin's context meter.
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
              if (!clearAcpActiveTurn(ctx, turnId)) {
                return;
              }
              const completedCost = finalizeAcpActiveTurnCost(ctx);
              ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, interrupted: true }] });
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
            if (activePromptFiber) {
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
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: DevinAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        const nextLength = Math.max(0, ctx.turns.length - numTurns);
        ctx.turns.splice(nextLength);
        return { threadId, turns: ctx.turns };
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
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));

    const hasSession: DevinAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
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
    ) =>
      discoveryLock.withPermits(1)(
        Effect.gen(function* () {
          const cwd = resolveDevinSessionCwd(input.cwd, serverConfig);
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
          yield* emitDevinContextCompactionRuntimeEvent(ctx, {
            lifecycle: "item.completed",
            status: "failed",
            title: "Context compaction failed",
            detail,
          });
          return yield* Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/prompt",
              detail,
            }),
          );
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
          yield* emitDevinContextCompactionRuntimeEvent(ctx, {
            lifecycle: "item.completed",
            status: "failed",
            title: "Context compaction timed out",
            detail,
          });
          return yield* Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/prompt",
              detail,
            }),
          );
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
          yield* emitDevinContextCompactionRuntimeEvent(ctx, {
            lifecycle: "item.completed",
            status: "failed",
            title: "Context compaction cancelled",
            detail,
          });
          return yield* Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/prompt",
              detail,
            }),
          );
        }

        // A compaction tool call can fail while the /compact prompt itself
        // still resolves successfully; honor the recorded failure instead of
        // persisting the compaction as completed.
        const failedToolDetail = ctx.compactionFailedToolDetail;
        if (failedToolDetail !== undefined) {
          yield* emitDevinContextCompactionRuntimeEvent(ctx, {
            lifecycle: "item.completed",
            status: "failed",
            title: "Context compaction failed",
            detail: failedToolDetail,
          });
          return yield* Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/prompt",
              detail: failedToolDetail,
            }),
          );
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

    const listModels: NonNullable<DevinAdapterShape["listModels"]> = (input) => {
      const binaryPath = input.binaryPath?.trim() || devinSettings.binaryPath || "devin";
      const fallbackResult = {
        models: mergeDevinModelDescriptors([DEVIN_FALLBACK_MODEL_DESCRIPTORS]),
        source: "devin-cli",
        cached: false,
      } satisfies ProviderListModelsResult;

      return Effect.gen(function* () {
        const cliModels = yield* Effect.gen(function* () {
          const childEnv = buildProviderChildEnvironment({ provider: PROVIDER });
          const prepared = prepareWindowsSafeProcess(
            binaryPath,
            ["models", "list", "--format", "json"],
            { env: childEnv },
          );
          const child = yield* childProcessSpawner.spawn(
            ChildProcess.make(prepared.command, prepared.args, {
              shell: prepared.shell,
              ...(prepared.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
              env: childEnv,
            }),
          );
          const [stdout, _stderr, exitCode] = yield* Effect.all(
            [
              collectStreamAsString(child.stdout),
              collectStreamAsString(child.stderr),
              child.exitCode.pipe(Effect.map(Number)),
            ],
            { concurrency: "unbounded" },
          );
          if (exitCode !== 0) {
            return [];
          }
          return parseDevinCliModelList(stdout);
        }).pipe(Effect.catch(() => Effect.succeed([])));

        const models =
          cliModels.length > 0 ? mergeDevinModelDescriptors([cliModels]) : fallbackResult.models;
        return {
          models,
          source: "devin-cli",
          cached: false,
        } satisfies ProviderListModelsResult;
      }).pipe(
        Effect.scoped,
        Effect.timeoutOption(DEVIN_MODEL_DISCOVERY_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(fallbackResult),
            onSome: (result) => Effect.succeed(result),
          }),
        ),
      );
    };

    const stopAll: DevinAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true }).pipe(
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

export const DevinAdapterLive = Layer.effect(DevinAdapter, makeDevinAdapter({}));

export function makeDevinAdapterLive(
  devinSettings: DevinAcpRuntimeSettings = {},
  options?: DevinAdapterLiveOptions,
) {
  return Layer.effect(DevinAdapter, makeDevinAdapter(devinSettings, options));
}

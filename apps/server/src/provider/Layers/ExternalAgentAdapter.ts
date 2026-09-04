/**
 * ExternalAgentAdapterLive - Profile-driven external agent via ACP.
 *
 * Unlike built-in adapters, the spawn command/args/env are not fixed: they come
 * from a resolved `ExternalAgentSessionLaunch` (profile + revision + expanded
 * credential env) handed to `startSession` via
 * `ProviderSessionStartInput.externalAgentLaunch`. The adapter feeds that launch
 * into the shared `AcpSessionRuntime` (which is already parameterized by spawn
 * command/args/env/cwd) and drives the standard ACP handshake + turn loop.
 *
 * @module ExternalAgentAdapterLive
 */
import * as nodePath from "node:path";
import { randomUUID } from "node:crypto";

import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@synara/contracts";
import { prepareWindowsSafeProcess } from "@synara/shared/windowsProcess";
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
} from "../../agentGateway/sessionLease.ts";
import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import type { ExternalAgentSessionLaunch } from "../../externalAgents/AgentProfileService.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { loadProviderPromptImageBlocks } from "../promptAttachments.ts";
import { appendProviderReferencesPromptBlock } from "../promptReferenceProjection.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
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
  buildAcpGatewayMcpServers,
  makeAcpThreadLock,
  recordAcpSessionCost,
  resolveAcpSessionCwd,
  resolveAcpTurnInteractionMode,
  scopeAcpRuntimeItemIdForTurn,
  scopeAcpToolCallStateForTurn,
  settleAcpPendingApprovalsAsCancelled,
  settleAcpPendingUserInputsAsEmptyAnswers,
} from "../acp/AcpAdapterSessionSupport.ts";
import {
  type AcpSessionRuntimeShape,
  type AcpSessionStartupTimeouts,
} from "../acp/AcpSessionRuntime.ts";
import { AcpSessionRuntime } from "../acp/AcpSessionRuntime.ts";
import {
  CliStructuredRuntime,
  type CliRuntimeEvent,
  type CliSessionStartResult,
  type CliStructuredRuntimeShape,
  type CliStructuredTier,
} from "../cli/CliStructuredRuntime.ts";
import { CliConnector, type CliConnectorShape } from "../cli/CliConnector.ts";
import { isCliConnectorKind } from "../cli/CliConnector.ts";
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
import { parsePermissionRequest, type AcpToolCallState } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggers } from "../acp/AcpNativeLogging.ts";
import {
  forkAcpTurnIdleWatchdog,
  resolveAcpTurnIdleTimeoutMs,
} from "../acp/AcpTurnIdleWatchdog.ts";
import { PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY } from "../Services/ProviderAdapter.ts";
import { ExternalAgentAdapter } from "../Services/ExternalAgentAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "external" as const;

export const takeExternalSynaraHarnessPolicyTextPart = (
  state: SynaraHarnessPolicyDeliveryState,
  scopedGatewayConnectionAvailable: boolean,
) =>
  takeSynaraHarnessPolicyTextPartForProviderSession(state, {
    provider: PROVIDER,
    scopedGatewayConnectionAvailable,
  });

// External agents are arbitrary user-configured connectors, so startup budgets
// stay generous (a slow upstream or auth handshake is expected) but bounded so a
// stuck child cannot hold a thread forever.
const EXTERNAL_ACP_STARTUP_TIMEOUTS = {
  initializeMs: 30_000,
  authenticateMs: 30_000,
  sessionSetupMs: 30_000,
  totalMs: 90_000,
} as const satisfies AcpSessionStartupTimeouts;

// Backstop for an alive-but-silent external child. Generous by design so
// legitimate long, quiet tool runs are not killed; override per workload.
const EXTERNAL_TURN_IDLE_TIMEOUT_MS = resolveAcpTurnIdleTimeoutMs({
  envVar: "SYNARA_EXTERNAL_TURN_IDLE_TIMEOUT_MS",
  defaultMs: 600_000,
});
const EXTERNAL_TURN_WATCHDOG_INTERVAL_MS = 15_000;
const EXTERNAL_ACP_REQUEST_TIMEOUT_MS = 30_000;

export interface ExternalAgentAdapterLiveOptions {
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

/**
 * External agent session state machine over the ACP runtime, keyed by threadId.
 * Same shape Cursor uses, parameterized by profileId/revisionId instead of
 * cursor-specific fields. Holds the runtime (ACP or CLI connector), the
 * session, pending approvals/userInputs, turns, and active-turn state.
 *
 * The runtime is a discriminated union: `connectorKind` routes to either the
 * ACP runtime (full ACP handshake, permissions, elicitation, model/mode
 * switching) or the generic CLI connector runtime (structured NDJSON wire
 * protocol or plain-text basic tier). The CLI path is intentionally narrower:
 * no permissions, no elicitation, no session modes, no model switching, no
 * usage. See `mapCliRuntimeEventToProviderEvents` for the honest capability
 * surface it bridges.
 */
interface ExternalAgentSessionContext {
  harnessPolicyDelivered?: boolean;
  readonly gatewaySessionLease?: AgentGatewaySessionLease;
  readonly threadId: ThreadId;
  readonly profileId: string;
  readonly revisionId: string;
  readonly lifecycleGeneration?: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly runtime:
    | { readonly kind: "acp"; readonly acp: AcpSessionRuntimeShape }
    | { readonly kind: "cli"; readonly cli: CliStructuredRuntimeShape; readonly tier: CliStructuredTier };
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly assistantItemTurnIds: Map<string, TurnId>;
  lastPlanFingerprint: string | undefined;
  activeInteractionMode: ProviderInteractionMode | undefined;
  activeTurnId: TurnId | undefined;
  activeTurnHadAssistantContent: boolean;
  readonly activeAssistantItemsWithContent: Set<string>;
  activeTurnFailedToolDetail: string | undefined;
  activePromptFiber: Fiber.Fiber<void, never> | undefined;
  lastTurnActivityAt: number | undefined;
  latestSessionCostUsd: number | undefined;
  /**
   * CLI-only: the deferred the notification fiber completes when the in-flight
   * CLI turn reaches a terminal state (structured: turn.completed/failed/
   * cancelled; basic: stream end / process exit). The turn runner awaits it.
   * Undefined for ACP sessions and between turns.
   */
  cliTurnDeferred: Deferred.Deferred<ExternalCliTurnResult, Error> | undefined;
  stopped: boolean;
}

interface ExternalAgentLaunchSpawn {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

function resolveExternalAssistantItemTurnId(
  ctx: ExternalAgentSessionContext,
  itemId: string | undefined,
): TurnId | undefined {
  if (itemId === undefined) {
    return ctx.activeTurnId;
  }
  const knownTurnId = ctx.assistantItemTurnIds.get(itemId);
  if (knownTurnId !== undefined) {
    return knownTurnId;
  }
  if (ctx.activeTurnId !== undefined) {
    ctx.assistantItemTurnIds.set(itemId, ctx.activeTurnId);
    return ctx.activeTurnId;
  }
  return ctx.assistantItemTurnIds.get(itemId);
}

/**
 * Extracts the spawn spec from a resolved profile launch. Only the `command`
 * connector kind is launchable; `endpoint` connectors are not yet supported
 * (they would need a transport-bridging runtime, not a stdio child).
 */
function resolveExternalLaunchSpawn(input: {
  readonly launch: ExternalAgentSessionLaunch;
  readonly cwd: string;
}): ExternalAgentLaunchSpawn | undefined {
  const { launch } = input;
  if (launch.revision.launch.kind !== "command") {
    return undefined;
  }
  const command = launch.revision.launch.command.trim();
  if (!command) {
    return undefined;
  }
  const args = launch.revision.launch.args ?? [];
  const cwd = launch.revision.launch.cwd?.trim()
    ? nodePath.resolve(launch.revision.launch.cwd.trim())
    : input.cwd;
  return {
    command,
    args,
    cwd,
    env: { ...launch.env },
  };
}

/**
 * The generic CLI connector tier for a launch, or `undefined` when the profile
 * is not a CLI connector kind (ACP/first-party) or the launch is not a command
 * launch. Delegates tier resolution + spawn-input derivation to the
 * CliConnector service so the connector-kind → tier mapping stays single-source.
 */
function resolveExternalCliTier(
  cliConnector: CliConnectorShape,
  launch: ExternalAgentSessionLaunch,
): { readonly tier: CliStructuredTier; readonly spawn: CliStructuredSpawnInput } | undefined {
  const tier = cliConnector.resolveTier({
    connectorKind: launch.revision.connectorKind,
    launch: launch.revision.launch,
  });
  if (tier === undefined) {
    return undefined;
  }
  const spawnInput = cliConnector.spawnInputForLaunch({
    connectorKind: launch.revision.connectorKind,
    launch: launch.revision.launch,
  });
  if (spawnInput === undefined) {
    return undefined;
  }
  return { tier, spawn: spawnInput };
}

/**
 * A minimal spawn input shape for the CLI runtime (command + args + optional
 * cwd). The full launch env is merged in by the adapter at runtime build time.
 */
type CliStructuredSpawnInput = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
};

/**
 * Cancels whichever runtime a session context owns. Both runtimes expose a
 * `cancel` effect; this normalizes over the discriminated runtime union so
 * session teardown stays one code path.
 */
function cancelExternalRuntime(ctx: ExternalAgentSessionContext): Effect.Effect<void, unknown> {
  return ctx.runtime.kind === "acp" ? ctx.runtime.acp.cancel : ctx.runtime.cli.cancel;
}

/**
 * Bridges one CliRuntimeEvent into the provider runtime-event stream. The CLI
 * tiers are intentionally narrower than ACP — this maps only what the wire
 * protocol honestly provides:
 *
 * - structured: turn.started → (no-op; the adapter already emits turn.started on
 *   prompt send), turn.text → content.delta, turn.completed → turn.completed
 *   (state "completed"), turn.failed → turn.completed (state "failed"),
 *   turn.cancelled → turn.completed (state "cancelled"), session.hello and
 *   protocol-error are observed for logging/attribution only.
 * - basic: every stdout `line` → content.delta. The basic tier has no turn
 *   lifecycle protocol; turn completion is driven by process exit / EOF in
 *   the turn runner, not by an event here.
 *
 * Capabilities the CLI path honestly does NOT support (and never claims here):
 * permissions, elicitation, session modes, model switching/discovery, token
 * usage, tool-call events, plan updates, session resume/replay, assistant-item
 * lifecycle. The adapter declines them at the API boundary instead of emulating
 * them. Returns `undefined` when the event is not surfaced as a runtime event
 * (e.g. session.hello, basic lines outside an active turn).
 */
function mapCliRuntimeEventToProviderEvent(input: {
  readonly ctx: ExternalAgentSessionContext;
  readonly event: CliRuntimeEvent;
  readonly makeStamp: () => Effect.Effect<{ readonly eventId: EventId; readonly createdAt: string }>;
}): Effect.Effect<ProviderRuntimeEvent | undefined, never, never> {
  const { ctx, event, makeStamp } = input;
  const activeTurnId = ctx.activeTurnId;
  if (event._tag === "line") {
    if (activeTurnId === undefined) return Effect.succeed(undefined);
    const text = event.line;
    if (text.length === 0) return Effect.succeed(undefined);
    ctx.activeTurnHadAssistantContent = true;
    return Effect.map(makeStamp(), (stamp) => ({
      type: "content.delta",
      ...stamp,
      provider: PROVIDER,
      threadId: ctx.threadId,
      turnId: activeTurnId,
      payload: { streamKind: "assistant_text" as const, delta: text },
    }));
  }
  if (event._tag === "protocol-error") {
    // A framing violation is attributed to the agent. It does not surface as a
    // content delta; the turn runner observes the protocol-error and fails the
    // turn. Logged natively for attribution.
    return Effect.succeed(undefined);
  }
  const structured = event.event;
  if (structured.type === "turn.text") {
    if (activeTurnId === undefined) return Effect.succeed(undefined);
    if (structured.text.length === 0) return Effect.succeed(undefined);
    ctx.activeTurnHadAssistantContent = true;
    return Effect.map(makeStamp(), (stamp) => ({
      type: "content.delta",
      ...stamp,
      provider: PROVIDER,
      threadId: ctx.threadId,
      turnId: activeTurnId,
      payload: { streamKind: "assistant_text" as const, delta: structured.text },
    }));
  }
  // turn.started is already represented by the adapter's own turn.started on
  // prompt send; the CLI's turn.started is an ack we observe but do not
  // re-emit. session.hello, turn.completed/failed/cancelled are terminal and
  // owned by the turn runner (it derives the turn.completed event from them).
  return Effect.succeed(undefined);
}

/**
 * Result of one CLI turn, mirroring the subset of the ACP `PromptResponse` the
 * CLI tiers can honestly provide. `stopReason` follows the ACP vocabulary the
 * adapter already classifies (`end_turn` / `cancelled` / null on failure); usage
 * is never populated because the CLI tiers do not report token usage.
 */
interface ExternalCliTurnResult {
  readonly stopReason: string | null;
}

/**
 * Runs one CLI turn to terminal settlement.
 *
 * Structured: sends `cli.command.turn.start` and awaits the deferred the
 * notification fiber completes on turn.completed/failed/cancelled (or a
 * protocol-error). Because the structured tier is protocol-driven, the turn
 * settles through the wire protocol; if the process exits first, `awaitExit`
 * racing the deferred yields a transport failure.
 *
 * Basic: sends the prompt as a raw input line and awaits the deferred the
 * notification fiber completes when the events stream ends (EOF / process exit).
 * The basic tier has no turn-completion protocol event, so stream end IS the
 * honest turn boundary. The idle watchdog remains the alive-but-silent backstop.
 *
 * Cancellation: `interruptTurn` calls `cli.cancel`, which for structured sends
 * `cli.command.cancel` (and the agent acks with `turn.cancelled` inside the
 * grace window, completing the deferred) and for basic tears down the process
 * (stream end completes the deferred). The fiber interruption of the turn
 * runner alone does not settle the child; `cancel` is what does.
 */
function runExternalCliTurn(input: {
  readonly ctx: ExternalAgentSessionContext;
  readonly turnId: TurnId;
  readonly promptText: string;
  readonly logNative: (
    threadId: ThreadId,
    method: string,
    payload: unknown,
  ) => Effect.Effect<void>;
}): Effect.Effect<ExternalCliTurnResult, Error, never> {
  return Effect.gen(function* () {
    const { ctx, turnId, promptText } = input;
    if (ctx.runtime.kind !== "cli") {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "session/prompt",
        detail: "runExternalCliTurn invoked on a non-CLI session.",
      });
    }
    const cli = ctx.runtime.cli;
    const deferred = yield* Deferred.make<ExternalCliTurnResult, Error>();
    ctx.cliTurnDeferred = deferred;
    const sendCommand =
      ctx.runtime.tier === "structured"
        ? cli.sendCommand({
            type: "cli.command.turn.start",
            turnId: String(turnId),
            prompt: promptText,
          })
        : cli.sendInput(promptText);
    yield* sendCommand.pipe(
      Effect.tapError((error) =>
        Deferred.fail(deferred, error instanceof Error ? error : new Error(String(error))).pipe(
          Effect.asVoid,
        ),
      ),
    );
    // Await settlement. The notification fiber completes the deferred on a
    // terminal event (structured) or stream end (basic). Interruption of this
    // fiber (cancel/idle-timeout) propagates and the deferred is abandoned.
    const result = yield* Deferred.await(deferred);
    return result;
  });
}

/**
 * Forks the CLI notification fiber: the single consumer of the CLI runtime's
 * event stream. It maps non-terminal events to provider runtime events (content
 * deltas) and publishes them, and completes the in-flight turn's deferred when
 * it observes a terminal event (structured) or the stream ends (basic).
 *
 * Stream-end is the honest turn boundary for the basic tier (no protocol
 * terminal event exists). For structured, the terminal events
 * turn.completed/failed/cancelled complete the deferred. A protocol-error
 * fails the deferred attributably.
 */
function forkExternalCliNotificationFiber(input: {
  readonly ctx: ExternalAgentSessionContext;
  readonly sessionScope: Scope.Closeable;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly makeEventStamp: () => Effect.Effect<{ readonly eventId: EventId; readonly createdAt: string }>;
  readonly logNative: (
    threadId: ThreadId,
    method: string,
    payload: unknown,
  ) => Effect.Effect<void>;
  readonly lifecycleGeneration: string | undefined;
}): Effect.Effect<Fiber.Fiber<void, never>, never, never> {
  const { ctx, sessionScope, offerRuntimeEvent, makeEventStamp } = input;
  // This fiber is only forked for CLI sessions; narrow the runtime once. The
  // runtime kind is checked at the call site, so a non-CLI context here is a
  // programmer error surfaced as a defect on the fiber.
  const cliRuntime = ctx.runtime.kind === "cli" ? ctx.runtime.cli : undefined;
  const tier: CliStructuredTier = ctx.runtime.kind === "cli" ? ctx.runtime.tier : "structured";
  if (cliRuntime === undefined) {
    return Effect.die(
      new Error("forkExternalCliNotificationFiber called on a non-CLI session"),
    ) as unknown as Effect.Effect<Fiber.Fiber<void, never>, never, never>;
  }

  // When the events stream ends (EOF / process exit), settle any in-flight
  // turn. For the basic tier this is the honest turn boundary; for the
  // structured tier a clean stream end without a terminal event is unexpected
  // but still settles the turn (completed) so the runner never hangs.
  const settleOnStreamEnd = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      const deferred = ctx.cliTurnDeferred;
      if (deferred !== undefined) {
        ctx.cliTurnDeferred = undefined;
        yield* Deferred.succeed(deferred, { stopReason: "end_turn" }).pipe(
          Effect.asVoid,
          Effect.catchCause(() => Effect.void),
        );
      }
    });

  return Stream.runDrain(
    Stream.mapEffect(cliRuntime.getEvents(), (event) =>
      Effect.gen(function* () {
        ctx.lastTurnActivityAt = Date.now();
        // Terminal / attribution events are handled before content mapping so
        // the deferred is settled from the same single-consumer stream.
        if (event._tag === "protocol-error") {
          yield* input.logNative(ctx.threadId, "cli/protocol-error", {
            detail: event.error.detail,
            line: event.error.line,
          });
          const deferred = ctx.cliTurnDeferred;
          if (deferred !== undefined) {
            ctx.cliTurnDeferred = undefined;
            yield* Deferred.fail(deferred, event.error).pipe(Effect.asVoid, Effect.catchCause(() => Effect.void));
          }
          return;
        }
        if (event._tag === "structured") {
          const structured = event.event;
          if (
            structured.type === "turn.completed" ||
            structured.type === "turn.failed" ||
            structured.type === "turn.cancelled"
          ) {
            const deferred = ctx.cliTurnDeferred;
            if (deferred !== undefined) {
              ctx.cliTurnDeferred = undefined;
              const stopReason =
                structured.type === "turn.completed"
                  ? structured.stopReason
                  : structured.type === "turn.cancelled"
                    ? "cancelled"
                    : null;
              yield* Deferred.succeed(deferred, { stopReason }).pipe(
                Effect.asVoid,
                Effect.catchCause(() => Effect.void),
              );
            }
            // Do not also emit a content delta for terminal events.
            return;
          }
          if (structured.type === "session.hello") {
            // Already observed at start; no runtime event to emit.
            return;
          }
        }
        // Non-terminal event (turn.text, turn.started, or a basic line).
        const mapped = yield* mapCliRuntimeEventToProviderEvent({ ctx, event, makeStamp: makeEventStamp });
        if (mapped !== undefined) {
          yield* offerRuntimeEvent(mapped);
        }
      }),
    ),
  ).pipe(
    // Stream drained to completion (EOF / process exit): settle the in-flight
    // turn. This runs on the success path; the failure path below also settles.
    Effect.ensuring(settleOnStreamEnd()),
    Effect.matchCause({
      onFailure: (cause) =>
        Effect.gen(function* () {
          // A failure (not a clean end) still ends the stream: settle the
          // deferred so the turn runner is never stuck.
          yield* settleOnStreamEnd();
          if (tier === "basic") {
            // Basic stream end is expected behavior, not a failure to warn on.
            return;
          }
          yield* Effect.logWarning("external.cli.notification_stream_failed", {
            threadId: ctx.threadId,
            tier,
            cause: String(cause),
          });
        }),
      onSuccess: () => Effect.void,
    }),
    Effect.forkIn(sessionScope),
  );
}

function externalAcpTimeoutError(method: string): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: `External agent did not respond to ${method} within ${EXTERNAL_ACP_REQUEST_TIMEOUT_MS / 1000}s.`,
  });
}

/**
 * Builds the ACP runtime from a profile launch. Mirrors the per-provider
 * `makeXAcpRuntime` factories, but the spawn command/args/env come from the
 * profile revision instead of a fixed binary lookup.
 */
function makeExternalAgentAcpRuntime(input: {
  readonly spawn: ExternalAgentLaunchSpawn;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly nativeEventLogger: EventNdjsonLogger | undefined;
  readonly threadId: ThreadId;
  readonly gatewaySessionLease: AgentGatewaySessionLease | undefined;
  readonly agentGatewayCredentials:
    | { readonly stdioProxy: import("../../agentGateway/Services/AgentGatewayCredentials.ts").AgentGatewayStdioProxySpawn }
    | undefined;
  readonly resumeSessionId?: string;
}): Effect.Effect<AcpSessionRuntimeShape, Error, Scope.Scope> {
  return Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        spawn: {
          command: input.spawn.command,
          args: [...input.spawn.args],
          cwd: input.spawn.cwd,
          env: input.spawn.env,
        },
        cwd: input.spawn.cwd,
        ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
        clientCapabilities: { elicitation: { form: {} } },
        clientInfo: { name: "Synara", version: "0.0.0" },
        startupTimeouts: EXTERNAL_ACP_STARTUP_TIMEOUTS,
        ...buildAcpGatewayMcpServers({
          gatewaySessionLease: input.gatewaySessionLease,
          agentGatewayCredentials: input.agentGatewayCredentials,
        }),
        ...makeAcpNativeLoggers({
          nativeEventLogger: input.nativeEventLogger,
          provider: PROVIDER,
          threadId: input.threadId,
        }),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return acpContext.get(AcpSessionRuntime);
  });
}

// CLI connector startup/readiness budgets. The generic CLI tiers (KAR-527) are
// simpler than ACP: no authenticate/initialize handshake. A single readiness
// line (basic) or `session.hello` (structured) must arrive within this window.
const EXTERNAL_CLI_STARTUP_TIMEOUT_MS = 30_000;
// Structured-tier cancel-ack grace: an agent that honors `cli.command.cancel`
// gets the grace to ack through the protocol; a non-acking agent is torn down.
const EXTERNAL_CLI_CANCEL_ACK_GRACE_MS = 250;

/**
 * Builds the generic CLI connector runtime for a `cli-structured` or
 * `cli-basic` profile launch. The tier is resolved by the CliConnector
 * service; the spawn input is derived from the resolved command launch.
 */
function makeExternalAgentCliRuntime(input: {
  readonly tier: CliStructuredTier;
  readonly spawn: ExternalAgentLaunchSpawn;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly nativeEventLogger: EventNdjsonLogger | undefined;
  readonly threadId: ThreadId;
}): Effect.Effect<CliStructuredRuntimeShape, Error, Scope.Scope> {
  return Effect.gen(function* () {
    const cliContext = yield* Layer.build(
      CliStructuredRuntime.layer({
        spawn: {
          command: input.spawn.command,
          args: [...input.spawn.args],
          cwd: input.spawn.cwd,
          env: input.spawn.env,
        },
        structured: input.tier === "structured",
        startupTimeoutMs: EXTERNAL_CLI_STARTUP_TIMEOUT_MS,
        cancelAckGraceMs: EXTERNAL_CLI_CANCEL_ACK_GRACE_MS,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return cliContext.get(CliStructuredRuntime);
  });
}

export function makeExternalAgentAdapter(options?: ExternalAgentAdapterLiveOptions) {
  return Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* Effect.service(ServerConfig);
    const agentGatewayCredentials = Option.getOrUndefined(
      yield* Effect.serviceOption(AgentGatewayCredentials),
    );
    // The CLI connector service resolves the tier and spawn input for
    // cli-structured / cli-basic profiles. Optional: an absent service means CLI
    // profiles cannot be dispatched (the ACP path is unaffected).
    const cliConnector = Option.getOrUndefined(yield* Effect.serviceOption(CliConnector));
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const sessions = new Map<ThreadId, ExternalAgentSessionContext>();
    const withThreadLock = yield* makeAcpThreadLock();
    const runtimeEventPubSub = yield* PubSub.bounded<ProviderRuntimeEvent>(
      PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
    );

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
      );

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = new Date().toISOString();
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: randomUUID(),
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

    const stopSessionInternal = (
      ctx: ExternalAgentSessionContext,
      cleanup?: { readonly exitKind?: "error" | "normal"; readonly reason?: string },
    ) =>
      Effect.gen(function* () {
        if (ctx.stopped) {
          return;
        }
        ctx.stopped = true;
        ctx.notificationFiber = undefined;
        yield* settleAcpPendingApprovalsAsCancelled(ctx.pendingApprovals).pipe(Effect.ignore);
        yield* settleAcpPendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs).pipe(Effect.ignore);
        yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, ctx.activeTurnId).pipe(Effect.ignore);
        const { activeTurnId: _activeTurnId, ...sessionWithoutActiveTurn } = ctx.session;
        ctx.session = {
          ...sessionWithoutActiveTurn,
          status: "closed",
          updatedAt: yield* nowIso,
          ...(cleanup?.exitKind === "error" && cleanup.reason
            ? { lastError: cleanup.reason }
            : {}),
        };
        yield* Effect.ignore(cancelExternalRuntime(ctx));
        yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.ignore);
      });

    const requireSession = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx || ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        return ctx;
      });

    const completeAssistantItemTurnId = (ctx: ExternalAgentSessionContext, itemId: string) => {
      const turnId = resolveExternalAssistantItemTurnId(ctx, itemId);
      ctx.assistantItemTurnIds.delete(itemId);
      return turnId;
    };

    const startSession: ExternalAgentAdapter["startSession"] = (input) =>
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
          const launch = input.externalAgentLaunch as ExternalAgentSessionLaunch | undefined;
          if (launch === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue:
                "External agent session start requires a resolved profile launch (externalAgentLaunch).",
            });
          }
          const cwd = resolveAcpSessionCwd({
            inputCwd: input.cwd,
            sessionCwd: launch.revision.launch.kind === "command" ? launch.revision.launch.cwd : undefined,
            serverCwd: serverConfig.cwd,
            homeDir: serverConfig.homeDir ?? "",
          });
          if (cwd === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and no server cwd fallback is available.",
            });
          }
          const spawn = resolveExternalLaunchSpawn({ launch, cwd });
          if (spawn === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `External agent profile '${launch.profile.name}' uses an unsupported launch kind; only command launches are supported.`,
            });
          }

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
          let ctx!: ExternalAgentSessionContext;

          const externalModelSelection =
            input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
          const resumeSessionId = parseExternalResume(input.resumeCursor)?.sessionId;

          const connectorKind = launch.revision.connectorKind;
          const isCliKind = isCliConnectorKind(connectorKind);

          let runtime: ExternalAgentSessionContext["runtime"];
          let sessionResumeCursor: unknown;

          if (isCliKind) {
            if (cliConnector === undefined) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startSession",
                issue:
                  "External agent profile uses a CLI connector kind but the CliConnector service is not available in this runtime.",
              });
            }
            const cliTier = resolveExternalCliTier(cliConnector, launch);
            if (cliTier === undefined) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startSession",
                issue: `External agent profile '${launch.profile.name}' uses a CLI connector kind but the launch could not be resolved to a CLI tier.`,
              });
            }
            const cliSpawn: ExternalAgentLaunchSpawn = {
              command: cliTier.spawn.command,
              args: [...cliTier.spawn.args],
              cwd: cliTier.spawn.cwd && cliTier.spawn.cwd.trim().length > 0
                ? nodePath.resolve(cliTier.spawn.cwd.trim())
                : cwd,
              env: { ...launch.env },
            };
            const cli = yield* makeExternalAgentCliRuntime({
              tier: cliTier.tier,
              spawn: cliSpawn,
              childProcessSpawner,
              nativeEventLogger,
              threadId: input.threadId,
            }).pipe(
              Effect.mapError((cause) =>
                cause instanceof Error
                  ? new ProviderAdapterProcessError({
                      provider: PROVIDER,
                      threadId: input.threadId,
                      detail: `Failed to start external CLI agent '${launch.profile.name}': ${cause.message}`,
                      cause,
                    })
                  : new ProviderAdapterProcessError({
                      provider: PROVIDER,
                      threadId: input.threadId,
                      detail: `Failed to start external CLI agent '${launch.profile.name}': ${String(cause)}`,
                    }),
              ),
            );
            yield* startAgentGatewaySessionLeaseExitWatcher(gatewaySessionLease, cli.awaitExit);
            const cliStarted: CliSessionStartResult = yield* cli
              .start()
              .pipe(
                Effect.timeoutOption(EXTERNAL_ACP_REQUEST_TIMEOUT_MS),
                Effect.flatMap(Option.match({
                  onNone: () => Effect.fail(externalAcpTimeoutError("session/start")),
                  onSome: (value) => Effect.succeed(value),
                })),
                Effect.mapError((cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: `Failed to start external CLI agent '${launch.profile.name}': ${cause instanceof Error ? cause.message : String(cause)}`,
                    ...(cause instanceof Error ? { cause } : {}),
                  }),
                ),
              );
            yield* logNative(input.threadId, "cli/session.hello", {
              tier: cliStarted.tier,
              agentName: cliStarted.agentName,
              capabilityIds: cliStarted.capabilityIds,
            });
            runtime = { kind: "cli", cli, tier: cliStarted.tier };
            // CLI tiers honestly do not expose a resumable native session id;
            // resumeCursor is omitted so a later session/start does not pretend
            // it can resume a CLI process that has exited.
            sessionResumeCursor = undefined;
          } else {
            const acp = yield* makeExternalAgentAcpRuntime({
              spawn,
              childProcessSpawner,
              nativeEventLogger,
              threadId: input.threadId,
              gatewaySessionLease,
              agentGatewayCredentials,
              ...(resumeSessionId ? { resumeSessionId } : {}),
            }).pipe(
              Effect.mapError((cause) =>
                cause instanceof Error
                  ? new ProviderAdapterProcessError({
                      provider: PROVIDER,
                      threadId: input.threadId,
                      detail: `Failed to start external agent '${launch.profile.name}': ${cause.message}`,
                      cause,
                    })
                  : mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", cause),
              ),
            );
            yield* startAgentGatewaySessionLeaseExitWatcher(gatewaySessionLease, acp.awaitExit);

            yield* acp.handleRequestPermission((params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/request_permission", params);
                const policyOutcome = resolveAcpPermissionPolicy({
                  runtimeMode: input.runtimeMode,
                  interactionMode: ctx?.activeInteractionMode,
                  options: params.options,
                });
                if (policyOutcome !== undefined) {
                  return policyOutcome.outcome === "selected"
                    ? { outcome: { outcome: "selected" as const, optionId: policyOutcome.optionId } }
                    : { outcome: { outcome: "cancelled" as const } };
                }
                const permissionRequest = parsePermissionRequest(params);
                const requestId = ApprovalRequestId.makeUnsafe(randomUUID());
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
                if (resolved === "cancel") {
                  return { outcome: { outcome: "cancelled" as const } };
                }
                const selectedOptionId = selectAcpPermissionOptionId(resolved, params.options);
                return selectedOptionId === undefined
                  ? { outcome: { outcome: "cancelled" as const } }
                  : { outcome: { outcome: "selected" as const, optionId: selectedOptionId } };
              }),
            );

            yield* acp.handleElicitation((params) =>
              Effect.gen(function* () {
                yield* logNative(input.threadId, "session/elicitation", params);
                const requestId = ApprovalRequestId.makeUnsafe(randomUUID());
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
                  payload: { params },
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
                // Decline non-form elicitations: external connectors vary widely,
                // so a structured answer is only returned when the request is a
                // form the user answered. Empty answers decline politely.
                return { action: "decline" as const };
              }),
            );

            const startedOption = yield* acp
              .start()
              .pipe(Effect.timeoutOption(EXTERNAL_ACP_REQUEST_TIMEOUT_MS));
            const started = yield* Option.match(startedOption, {
              onNone: () => Effect.fail(externalAcpTimeoutError("session/start")),
              onSome: Effect.succeed,
            });

            if (resumeSessionId !== undefined && started.sessionSetupMethod === "new") {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/resume",
                detail:
                  "External agent could not resume the requested native session and a fresh fallback was refused to avoid losing conversation context.",
              });
            }

            runtime = { kind: "acp", acp };
            sessionResumeCursor = {
              schemaVersion: EXTERNAL_RESUME_VERSION,
              sessionId: started.sessionId,
            };
          }

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: externalModelSelection?.model,
            threadId: input.threadId,
            ...(sessionResumeCursor !== undefined ? { resumeCursor: sessionResumeCursor } : {}),
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            profileId: launch.profile.profileId,
            revisionId: launch.revision.revisionId,
            ...(gatewaySessionLease ? { gatewaySessionLease } : {}),
            ...(input.lifecycleGeneration !== undefined
              ? { lifecycleGeneration: input.lifecycleGeneration }
              : {}),
            session,
            scope: sessionScope,
            runtime,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            assistantItemTurnIds: new Map(),
            lastPlanFingerprint: undefined,
            activeInteractionMode: undefined,
            activeTurnId: undefined,
            activeTurnHadAssistantContent: false,
            activeAssistantItemsWithContent: new Set(),
            activeTurnFailedToolDetail: undefined,
            activePromptFiber: undefined,
            lastTurnActivityAt: undefined,
            latestSessionCostUsd: undefined,
            cliTurnDeferred: undefined,
            stopped: false,
          };

          const notificationFiber =
            ctx.runtime.kind === "cli"
              ? yield* forkExternalCliNotificationFiber({
                  ctx,
                  sessionScope,
                  offerRuntimeEvent: (event: ProviderRuntimeEvent) =>
                    offerRuntimeEvent(ctx.lifecycleGeneration, event),
                  makeEventStamp,
                  logNative,
                  lifecycleGeneration: input.lifecycleGeneration,
                })
              : yield* Stream.runDrain(
                  Stream.mapEffect(ctx.runtime.acp.getEvents(), (event) =>
                    Effect.gen(function* () {
                      ctx.lastTurnActivityAt = Date.now();
                      switch (event._tag) {
                        case "ModeChanged":
                          return;
                        case "AssistantItemStarted":
                          return;
                        case "AssistantItemCompleted": {
                          const activeTurnId = resolveExternalAssistantItemTurnId(ctx, event.itemId);
                          if (activeTurnId === undefined) return;
                          const scopedItemId = scopeAcpRuntimeItemIdForTurn(PROVIDER, activeTurnId, event.itemId);
                          if (!ctx.activeAssistantItemsWithContent.has(scopedItemId)) {
                            return;
                          }
                          ctx.activeAssistantItemsWithContent.delete(scopedItemId);
                          completeAssistantItemTurnId(ctx, event.itemId);
                          yield* offerRuntimeEvent(
                            ctx.lifecycleGeneration,
                            makeAcpAssistantItemEvent({
                              stamp: yield* makeEventStamp(),
                              provider: PROVIDER,
                              threadId: ctx.threadId,
                              turnId: activeTurnId,
                              itemId: scopedItemId,
                              lifecycle: "item.completed",
                            }),
                          );
                          return;
                        }
                        case "ContentDelta": {
                          const activeTurnId = resolveExternalAssistantItemTurnId(ctx, event.itemId);
                          if (activeTurnId === undefined) return;
                          if (event.text.length === 0) return;
                          const itemId = event.itemId
                            ? scopeAcpRuntimeItemIdForTurn(PROVIDER, activeTurnId, event.itemId)
                            : undefined;
                          if (itemId) {
                            ctx.activeAssistantItemsWithContent.add(itemId);
                          }
                          ctx.activeTurnHadAssistantContent = true;
                          yield* offerRuntimeEvent(
                            ctx.lifecycleGeneration,
                            makeAcpContentDeltaEvent({
                              stamp: yield* makeEventStamp(),
                              provider: PROVIDER,
                              threadId: ctx.threadId,
                              turnId: activeTurnId,
                              ...(itemId ? { itemId } : {}),
                              text: event.text,
                              ...(event.streamKind ? { streamKind: event.streamKind } : {}),
                              rawPayload: event.rawPayload,
                            }),
                          );
                          return;
                        }
                        case "PlanUpdated": {
                          const activeTurnId = ctx.activeTurnId;
                          if (activeTurnId === undefined) return;
                          const fingerprint = `${activeTurnId}:${JSON.stringify(event.payload)}`;
                          if (ctx.lastPlanFingerprint === fingerprint) return;
                          ctx.lastPlanFingerprint = fingerprint;
                          yield* offerRuntimeEvent(
                            ctx.lifecycleGeneration,
                            makeAcpPlanUpdatedEvent({
                              stamp: yield* makeEventStamp(),
                              provider: PROVIDER,
                              threadId: ctx.threadId,
                              turnId: activeTurnId,
                              payload: event.payload,
                              source: "acp.jsonrpc",
                              method: "session/update",
                              rawPayload: event.rawPayload,
                            }),
                          );
                          return;
                        }
                        case "ToolCallUpdated": {
                          const activeTurnId = ctx.activeTurnId;
                          if (activeTurnId === undefined) return;
                          const scoped = scopeAcpToolCallStateForTurn(PROVIDER, activeTurnId, event.toolCall);
                          const failedDetail = readAcpFailedToolDetail(event.toolCall);
                          if (failedDetail !== undefined) {
                            ctx.activeTurnFailedToolDetail = failedDetail;
                          }
                          yield* offerRuntimeEvent(
                            ctx.lifecycleGeneration,
                            makeAcpToolCallEvent({
                              stamp: yield* makeEventStamp(),
                              provider: PROVIDER,
                              threadId: ctx.threadId,
                              turnId: activeTurnId,
                              toolCall: scoped,
                              rawPayload: event.rawPayload,
                            }),
                          );
                          return;
                        }
                        case "UsageUpdated": {
                          recordAcpSessionCost(ctx, event.cost);
                          const activeTurnId = ctx.activeTurnId;
                          yield* offerRuntimeEvent(
                            ctx.lifecycleGeneration,
                            makeAcpTokenUsageEvent({
                              stamp: yield* makeEventStamp(),
                              provider: PROVIDER,
                              threadId: ctx.threadId,
                              turnId: activeTurnId,
                              usage: event.usage,
                              rawPayload: event.rawPayload,
                            }),
                          );
                          return;
                        }
                      }
                    }),
                  ),
                ).pipe(
                  Effect.catchAllCause((cause) =>
                    Effect.logWarning("external.acp.notification_stream_failed", {
                      threadId: ctx.threadId,
                      cause: String(cause),
                    }),
                  ),
                  Effect.forkIn(sessionScope),
                );
          ctx.notificationFiber = notificationFiber;
          sessionScopeTransferred = true;
          sessions.set(input.threadId, ctx);
          return ctx.session;
        }),
      );

    const sendTurn: ExternalAgentAdapter["sendTurn"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(input.threadId);
          const runtimeMode = ctx.session.runtimeMode;
          if (runtimeMode === "auto") {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Auto runtime mode is available only to Codex and Claude.",
            });
          }
          const turnId = TurnId.makeUnsafe(randomUUID());
          const turnModelSelection =
            input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
          const model = turnModelSelection?.model ?? ctx.session.model;
          const interactionMode = resolveAcpTurnInteractionMode(input.interactionMode);

          const promptText = appendFileAttachmentsPromptBlock({
            text: appendProviderReferencesPromptBlock({
              text: input.input?.trim() ? input.input.trim() : undefined,
              mentions: input.mentions,
            }),
            attachments: input.attachments,
            attachmentsDir: serverConfig.attachmentsDir,
            include: "all-files",
          });
          const promptParts: Array<Acp.ContentBlock> = [];
          if (promptText) {
            promptParts.push({ type: "text", text: promptText });
          }
          promptParts.push(
            ...(yield* loadProviderPromptImageBlocks({
              attachments: input.attachments,
              attachmentsDir: serverConfig.attachmentsDir,
              provider: PROVIDER,
              method: "session/prompt",
              readFile: (path) => fileSystem.readFile(path),
            })),
          );
          if (promptParts.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }
          // CLI tiers accept only text prompts: image blocks are not part of the
          // wire protocol. Flatten to the prompt text the CLI will receive.
          const cliPromptText = promptParts
            .map((part) => (part.type === "text" ? part.text : ""))
            .filter((text) => text.length > 0)
            .join("\n");
          const harnessPolicy = takeExternalSynaraHarnessPolicyTextPart(
            ctx,
            agentGatewayCredentials !== undefined,
          );
          if (harnessPolicy) {
            promptParts.unshift(harnessPolicy);
          }
          if (ctx.stopped) {
            return yield* new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId: input.threadId,
            });
          }

          ctx.activeTurnId = turnId;
          ctx.activeTurnHadAssistantContent = false;
          ctx.activeAssistantItemsWithContent.clear();
          ctx.activeTurnFailedToolDetail = undefined;
          ctx.assistantItemTurnIds.clear();
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

          // The prompt execution is runtime-kind-aware. ACP drives a single
          // `prompt()` call that resolves with a stop reason. CLI tiers have no
          // equivalent call: structured sends `cli.command.turn.start` and
          // awaits a turn-terminal event; basic sends the prompt as a raw line
          // and settles on process exit / EOF (the idle watchdog is the
          // alive-but-silent backstop). Both return a { stopReason } result the
          // shared completion handler maps to turn.completed.
          const runPrompt =
            ctx.runtime.kind === "cli"
              ? runExternalCliTurn({
                  ctx,
                  turnId,
                  promptText: cliPromptText,
                  logNative,
                }).pipe(
                  Effect.mapError((error) =>
                    mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
                  ),
                )
              : Effect.suspend(() =>
                  ctx.stopped ? Effect.interrupt : ctx.runtime.acp.prompt({ prompt: promptParts }),
                ).pipe(
                  Effect.mapError((error) =>
                    mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
                  ),
                );

          const promptFiber = yield* runPrompt.pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                Effect.gen(function* () {
                  if (ctx.activeTurnId !== turnId) return;
                  yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
                  if (!clearExternalActiveTurn(ctx, turnId)) return;
                  const completedCost = finalizeExternalActiveTurnCost(ctx);
                  ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, error }] });
                  const detail = error.message;
                  const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
                  ctx.session = {
                    ...sessionWithoutLastError,
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
                  yield* stopSessionInternal(ctx, { exitKind: "error", reason: detail });
                }),
              onSuccess: (result) =>
                Effect.gen(function* () {
                  const hadAssistantContent = ctx.activeTurnHadAssistantContent;
                  const failedToolDetail = ctx.activeTurnFailedToolDetail;
                  if (ctx.activeTurnId !== turnId) return;
                  yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, turnId);
                  if (!clearExternalActiveTurn(ctx, turnId)) return;
                  const completedCost = finalizeExternalActiveTurnCost(ctx);
                  ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
                  const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
                  ctx.session = {
                    ...sessionWithoutLastError,
                    status: "ready",
                    updatedAt: yield* nowIso,
                    ...(model ? { model } : {}),
                  };
                  if (!hadAssistantContent && result.stopReason !== "cancelled") {
                    yield* Effect.logWarning("external.acp.turn_completed_without_content", {
                      threadId: input.threadId,
                      turnId,
                      stopReason: result.stopReason ?? null,
                    });
                  }
                  const completion = classifyExternalPromptTurnCompletion({
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
            Effect.forkIn(ctx.scope),
          );
          ctx.activePromptFiber = promptFiber;

          // Idle-progress watchdog: force-fail a silently hung turn so the UI
          // never shows "Working" forever on an alive-but-silent external child.
          yield* forkAcpTurnIdleWatchdog({
            idleTimeoutMs: EXTERNAL_TURN_IDLE_TIMEOUT_MS,
            checkIntervalMs: EXTERNAL_TURN_WATCHDOG_INTERVAL_MS,
            scope: ctx.scope,
            isTurnActive: () => ctx.activeTurnId === turnId && !ctx.stopped,
            isAwaitingHuman: () =>
              ctx.pendingApprovals.size > 0 || ctx.pendingUserInputs.size > 0,
            lastActivityAt: () => ctx.lastTurnActivityAt ?? Date.now(),
            touchActivity: () => {
              ctx.lastTurnActivityAt = Date.now();
            },
            onIdleTimeout: (idleMs) =>
              Effect.gen(function* () {
                if (ctx.activeTurnId !== turnId) return;
                yield* Fiber.interrupt(promptFiber);
                yield* Effect.logWarning("external.acp.turn_idle_timeout", {
                  threadId: input.threadId,
                  turnId,
                  idleMs,
                });
              }),
          });

          return {
            threadId: input.threadId,
            turnId,
            resumeCursor: ctx.session.resumeCursor,
          } satisfies ProviderTurnStartResult;
        }),
      );

    const interruptTurn: ExternalAgentAdapter["interruptTurn"] = (threadId, turnId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx || ctx.stopped) return;
          if (turnId !== undefined && ctx.activeTurnId !== turnId) return;
          const promptFiber = ctx.activePromptFiber;
          if (promptFiber) {
            yield* Fiber.interrupt(promptFiber);
          }
          // For CLI runtimes, interrupting the turn-runner fiber alone does not
          // stop the child: explicitly cancel the CLI so a structured agent
          // gets `cli.command.cancel` (with ack grace) and a basic agent gets
          // process-tree teardown. The shared stopped-flag and session cleanup
          // then settle the turn.
          if (ctx.runtime.kind === "cli") {
            yield* Effect.ignore(cancelExternalRuntime(ctx));
          }
          if (ctx.activeTurnId !== undefined) {
            yield* cancelAgentGatewayTurn(ctx.gatewaySessionLease, ctx.activeTurnId);
            clearExternalActiveTurn(ctx, ctx.activeTurnId);
            const { lastError: _lastError, ...sessionWithoutLastError } = ctx.session;
            ctx.session = {
              ...sessionWithoutLastError,
              status: "ready",
              updatedAt: yield* nowIso,
            };
          }
        }),
      );

    const respondToRequest: ExternalAgentAdapter["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx || ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
        }
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `No pending approval request '${requestId}' for thread '${threadId}'.`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: ExternalAgentAdapter["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx || ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
        }
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/elicitation",
            detail: `No pending user-input request '${requestId}' for thread '${threadId}'.`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const stopSession: ExternalAgentAdapter["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx) return;
          yield* stopSessionInternal(ctx);
          sessions.delete(threadId);
        }),
      );

    const listSessions: ExternalAgentAdapter["listSessions"] = () =>
      Effect.sync(() =>
        Array.from(sessions.values())
          .filter((ctx) => !ctx.stopped)
          .map((ctx) => ctx.session),
      );

    const hasSession: ExternalAgentAdapter["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const readThread: ExternalAgentAdapter["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return {
          threadId,
          turns: ctx.turns.map((turn) => ({ id: turn.id, items: turn.items })),
          ...(ctx.session.cwd ? { cwd: ctx.session.cwd } : {}),
        };
      });

    const rollbackThread: ExternalAgentAdapter["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (numTurns <= 0) {
          return {
            threadId,
            turns: ctx.turns.map((turn) => ({ id: turn.id, items: turn.items })),
            ...(ctx.session.cwd ? { cwd: ctx.session.cwd } : {}),
          };
        }
        // External agents do not support native history rollback; trim the
        // in-memory turn log so the snapshot reflects the requested state. A
        // full rollback requires a session restart, which the caller drives.
        ctx.turns.splice(Math.max(0, ctx.turns.length - numTurns));
        return {
          threadId,
          turns: ctx.turns.map((turn) => ({ id: turn.id, items: turn.items })),
          ...(ctx.session.cwd ? { cwd: ctx.session.cwd } : {}),
        };
      });

    const stopAll: ExternalAgentAdapter["stopAll"] = () =>
      Effect.gen(function* () {
        const threadIds = Array.from(sessions.keys());
        yield* Effect.forEach(threadIds, (threadId) => stopSession(threadId), { discard: true });
      });

    if (managedNativeEventLogger !== undefined) {
      yield* Scope.addFinalizer(() => managedNativeEventLogger.close().pipe(Effect.ignore));
    }

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "restart-session",
        conversationRollback: "restart-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies ExternalAgentAdapter["Type"];
  });
}

const EXTERNAL_RESUME_VERSION = 1 as const;

function parseExternalResume(raw: unknown): { sessionId: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== EXTERNAL_RESUME_VERSION) return undefined;
  if (typeof value.sessionId !== "string" || !value.sessionId.trim()) return undefined;
  return { sessionId: value.sessionId.trim() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

void isRecord;

function clearExternalActiveTurn(
  ctx: ExternalAgentSessionContext,
  turnId: TurnId,
): boolean {
  if (ctx.activeTurnId !== turnId) {
    return false;
  }
  ctx.activeTurnId = undefined;
  ctx.activeTurnHadAssistantContent = false;
  ctx.activeAssistantItemsWithContent.clear();
  ctx.activeTurnFailedToolDetail = undefined;
  ctx.activePromptFiber = undefined;
  ctx.activeInteractionMode = undefined;
  ctx.cliTurnDeferred = undefined;
  const { activeTurnId: _activeTurnId, ...session } = ctx.session;
  ctx.session = session;
  return true;
}

function finalizeExternalActiveTurnCost(ctx: ExternalAgentSessionContext): {
  readonly cumulativeCostUsd?: number;
} {
  return ctx.latestSessionCostUsd !== undefined
    ? { cumulativeCostUsd: ctx.latestSessionCostUsd }
    : {};
}

function classifyExternalPromptTurnCompletion(input: {
  readonly stopReason: string | null | undefined;
  readonly failedToolDetail?: string | undefined;
}): { readonly state: "completed" | "cancelled" | "failed"; readonly errorMessage?: string } {
  return classifyAcpPromptTurnCompletion(input);
}

export const ExternalAgentAdapterLive = Layer.effect(
  ExternalAgentAdapter,
  makeExternalAgentAdapter(),
);

export function makeExternalAgentAdapterLive(
  options?: ExternalAgentAdapterLiveOptions,
) {
  return Layer.effect(ExternalAgentAdapter, makeExternalAgentAdapter(options));
}

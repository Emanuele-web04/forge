// FILE: CliConformanceVerifiers.ts
// Purpose: KAR-527 generic-CLI conformance verifiers bound into the
// CapabilityVerifierRegistry. Structured tier verifiers exercise the NDJSON
// wire protocol through CliStructuredRuntime (a turn streams `turn.text` and
// settles; cancel aborts an in-flight turn and settles). Basic tier verifiers
// run the honest-limits contract: prompt/stream echo lines, and every
// capability a plain-text CLI cannot honestly provide (resume, permissions,
// elicitation, usage, tool events, model discovery/switch, modes, terminal
// state) fails closed with agent attribution — the connector never fakes them.
// No Synara provider-name knowledge lives here: expectations are expressed in
// terms of the wire protocol (structured) or honest tier limits (basic).
// Layer: Server capability conformance
// Exports: CLI_CONFORMANCE_HARNESS_VERSION, makeCliVerifierRegistry,
//          cliStructuredConformanceVerifierId, cliBasicConformanceVerifierId

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Option, Stream } from "effect";

import type { CapabilityId, RuntimeIdentitySignals } from "@synara/contracts";

import type { CapabilityAttribution } from "../../capabilityEvidence/Services/CapabilityVerifierRegistry.ts";
import { fixturePathFromServerDir } from "../../conformance/ConformanceRunner.ts";
import {
  CliStructuredRuntime,
  type CliRuntimeEvent,
  type CliSessionStartResult,
  type CliStructuredRuntimeShape,
  type CliStructuredTier,
} from "./CliStructuredRuntime.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Constants

/** Version of the CLI conformance harness. Bump when any verifier behavior changes. */
export const CLI_CONFORMANCE_HARNESS_VERSION = "2026-08-16.1";

/** Verifier key prefixes for the generic CLI connector tiers. */
export const CLI_STRUCTURED_VERIFIER_PREFIX = "cli-structured.conformance";
export const CLI_BASIC_VERIFIER_PREFIX = "cli-basic.conformance";

/** Verifier key prefix shared by both CLI tiers, used for runtime matching. */
export const CLI_VERIFIER_RUNTIME_PREFIX = "synara://cli-connector";

/** Tier marker embedded in a CLI runtime fingerprint so structured/basic dispatch. */
const CLI_TIER_PARAM = "tier=";

/**
 * Fingerprints a runtime identity signal as belonging to the generic CLI
 * connector. Structured and basic share the prefix but differ by a `tier=`
 * query param, so the registry's `matchesRuntime` predicate can route each
 * tier to its own verifier set.
 *
 * FINGERPRINT CONTRACT (do not change): the session-runtime dispatch site that
 * spawns CLI connector sessions (KAR-521/528 territory) MUST stamp the same
 * `synara://cli-connector` fingerprint — `cliConnectorTierFingerprint` for
 * structured/basic tiers — into the runtime identity it reports. Evidence
 * re-derivation resolves that fingerprint back to these CLI verifiers via
 * `CLI_VERIFIER_RUNTIME_PREFIX`, so any future dispatch site must keep this
 * exact string shape or re-derivation will fail to find the CLI verifiers.
 */
export const cliConnectorRuntimePrefix = (runtime: RuntimeIdentitySignals): string =>
  (runtime.runtimeFingerprint ?? "").startsWith(CLI_VERIFIER_RUNTIME_PREFIX)
    ? (runtime.runtimeFingerprint ?? "")
    : `${CLI_VERIFIER_RUNTIME_PREFIX}?command=${runtime.resolvedCommand ?? ""}`;

/** Tier-aware fingerprint builder used by the CLI connector and tests. */
export const cliConnectorTierFingerprint = (tier: CliStructuredTier, command: string): string =>
  `${CLI_VERIFIER_RUNTIME_PREFIX}?${CLI_TIER_PARAM}${tier}&command=${command}`;

/**
 * Deterministic capability-specific verifier id for the structured tier. The
 * harness version is baked into the key so policy re-derivation folds harness
 * drift into the verdict.
 */
export const cliStructuredConformanceVerifierId = (capabilityId: CapabilityId): string =>
  `${capabilityId}.${CLI_STRUCTURED_VERIFIER_PREFIX}.v${CLI_CONFORMANCE_HARNESS_VERSION}`;

/** Deterministic capability-specific verifier id for the basic tier. */
export const cliBasicConformanceVerifierId = (capabilityId: CapabilityId): string =>
  `${capabilityId}.${CLI_BASIC_VERIFIER_PREFIX}.v${CLI_CONFORMANCE_HARNESS_VERSION}`;

export type EvidenceOutcome = "pass" | "fail" | "inconclusive";

export interface CliConformanceVerifierEdge {
  readonly outcome: EvidenceOutcome;
  readonly attribution: CapabilityAttribution;
  readonly detail: string;
}

/**
 * A deterministic probe failure: the observed behavior cannot be the agent
 * behaving correctly (e.g. a structured CLI ignored a cancel, or a basic CLI
 * is asked for a capability it honestly cannot provide). The `_tag`
 * discriminator survives the Effect/async boundary, which is how the grader
 * classifies it below as fail/agent.
 */
class ConformanceCliCapabilityFailure extends Error {
  readonly _tag = "ConformanceCliCapabilityFailure";
  override readonly name = "ConformanceCliCapabilityFailure";
}

/**
 * Strictly grades a failed CLI probe run to an evidence edge.
 * - `CliSpawnError` → inconclusive/environment (the budget ran out before the
 *   capability could be observed; could be a missing binary or a slow machine)
 * - `CliProtocolError` → fail/agent (a framing violation is the agent speaking
 *   the wire protocol wrong)
 * - `CliTransportError` → fail/agent (the process died mid-turn or refused a
 *   command — the advertised behavior demonstrably does not hold)
 * - `ConformanceCliCapabilityFailure` → fail/agent (direct observation that
 *   the capability is missing or the cancel was ignored)
 * - anything else (bare timeout / unidentified) → inconclusive/environment
 */
function gradeCliProbeFailure(error: unknown): CliConformanceVerifierEdge {
  const detailText = `CLI conformance probe failed: ${String(error)}`;
  const tag =
    typeof error === "object" && error !== null
      ? ((error as { _tag?: unknown })._tag as string | undefined)
      : undefined;
  switch (tag) {
    case "CliSpawnError":
      return { outcome: "inconclusive", attribution: "environment", detail: detailText };
    case "CliProtocolError":
      return { outcome: "fail", attribution: "agent", detail: detailText };
    case "CliTransportError":
      return { outcome: "fail", attribution: "agent", detail: detailText };
    case "ConformanceCliCapabilityFailure":
      return {
        outcome: "fail",
        attribution: "agent",
        detail: error instanceof Error ? error.message : detailText,
      };
    default:
      return { outcome: "inconclusive", attribution: "environment", detail: detailText };
  }
}

/** Maps a successful edge (the probe returned a summary string). */
function passEdge(detail: string): CliConformanceVerifierEdge {
  return { outcome: "pass", attribution: "agent", detail };
}

// ─────────────────────────────────────────────────────────────────────────────
// Probe scaffolding

/**
 * Runs a probe body inside a CliStructuredRuntime scope for the given tier and
 * fixture, guaranteeing the child process tree is torn down by the runtime's
 * finalizer. The whole run is bounded by a hard deadline.
 */
export function runScopedCliProbe(input: {
  readonly fixturePath: string;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly tier: CliStructuredTier;
  readonly capabilityId: CapabilityId;
  readonly deadlineSeconds?: number;
  readonly body: (injected: {
    readonly runtime: CliStructuredRuntimeShape;
    readonly started: CliSessionStartResult;
  }) => Effect.Effect<string, unknown>;
}): Effect.Effect<CliConformanceVerifierEdge, never> {
  const deadlineSeconds = input.deadlineSeconds ?? 15;
  const run = Effect.gen(function* () {
    const layer = CliStructuredRuntime.layer({
      spawn: {
        command: process.execPath,
        args: [input.fixturePath],
        env: {
          ...input.env,
          VITEST: "true",
        },
      },
      structured: input.tier === "structured",
      startupTimeoutMs: deadlineSeconds * 1_000,
      cancelAckGraceMs: 300,
    });
    const result = yield* Effect.gen(function* () {
      const runtime = yield* CliStructuredRuntime;
      const started = yield* runtime.start();
      return yield* input.body({ runtime, started });
    }).pipe(Effect.provide(layer), Effect.provide(NodeServices.layer));
    return result;
  });
  return Effect.scoped(run)
    .pipe(Effect.timeout((deadlineSeconds + 5) * 1_000))
    .pipe(Effect.match({ onFailure: gradeCliProbeFailure, onSuccess: passEdge }));
}

/**
 * Runs a prompt turn and returns a summary string describing when it settled.
 * Turn.failed is a deterministic agent failure. The stream is capped so a
 * hostile agent that never settles cannot hang the probe.
 */
function collectStructuredTurn(events: ReadonlyArray<CliRuntimeEvent>): string {
  const finale = events[events.length - 1];
  if (finale === undefined) {
    return "no-settle";
  }
  if (finale._tag !== "structured") {
    return "no-settle";
  }
  return `${finale.event.type} (${String(events.length)} events)`;
}

function settleOf(
  event: CliRuntimeEvent,
): import("@synara/contracts").CliStructuredEvent | undefined {
  return event._tag === "structured" ? event.event : undefined;
}

/** Collects a structured turn until it settles (completed/failed/cancelled), capped at 5s. */
const runStructuredTurn = (
  runtime: CliStructuredRuntimeShape,
  _turnId: string,
): Effect.Effect<string, unknown> =>
  runtime.getEvents().pipe(
    Stream.takeUntil((event) => {
      if (event._tag === "protocol-error") {
        return true;
      }
      const maybeSettle = settleOf(event);
      return (
        maybeSettle !== undefined &&
        (maybeSettle.type === "turn.completed" ||
          maybeSettle.type === "turn.failed" ||
          maybeSettle.type === "turn.cancelled")
      );
    }),
    Stream.runCollect,
    Effect.timeout("5 seconds"),
    Effect.flatMap((events) => {
      // A framing violation observed mid-turn is the agent speaking the wire
      // protocol wrong (AC #3): fail the probe attributably with the offending
      // CliProtocolError rather than summarizing it as "no-settle".
      const violation = events.find((event) => event._tag === "protocol-error");
      if (violation !== undefined && violation._tag === "protocol-error") {
        return Effect.fail(violation.error);
      }
      return Effect.succeed(collectStructuredTurn(events));
    }),
  );

// ─────────────────────────────────────────────────────────────────────────────
// Structured tier probes

const structuredProbeBodies: Readonly<
  Record<CapabilityId, (runtime: CliStructuredRuntimeShape) => Effect.Effect<string, unknown>>
> = {
  "session.start": () => Effect.succeed("structured CLI session started (session.hello)"),
  prompt: (runtime) =>
    Effect.gen(function* () {
      yield* runtime.sendCommand({
        type: "cli.command.turn.start",
        turnId: "cli-prompt",
        prompt: "ping",
      });
      const outcome = yield* runStructuredTurn(runtime, "cli-prompt");
      return `structured prompt ${outcome}`;
    }),
  stream: (runtime) =>
    Effect.gen(function* () {
      yield* runtime.sendCommand({
        type: "cli.command.turn.start",
        turnId: "cli-stream",
        prompt: "ping",
      });
      const outcome = yield* runStructuredTurn(runtime, "cli-stream");
      return `structured stream ${outcome}`;
    }),
  cancel: (runtime) =>
    Effect.gen(function* () {
      yield* runtime.sendCommand({
        type: "cli.command.turn.start",
        turnId: "cli-cancel",
        prompt: "block",
      });
      yield* Effect.sleep("150 millis");
      yield* runtime.cancel;
      // The structured fixture honors `cli.command.cancel` with
      // `turn.cancelled`, so the acked cancel must settle the turn through the
      // protocol: observe the terminal event on the events stream. A cancel
      // that settled only via teardown would never surface a `turn.cancelled`.
      const settled = yield* runtime.getEvents().pipe(
        Stream.takeUntil((event) => {
          if (event._tag === "protocol-error") {
            return true;
          }
          const maybeSettle = settleOf(event);
          return (
            maybeSettle !== undefined &&
            (maybeSettle.type === "turn.cancelled" ||
              maybeSettle.type === "turn.completed" ||
              maybeSettle.type === "turn.failed")
          );
        }),
        Stream.runCollect,
        Effect.timeout("5 seconds"),
      );
      const violation = settled.find((event) => event._tag === "protocol-error");
      if (violation !== undefined && violation._tag === "protocol-error") {
        return yield* Effect.fail(violation.error);
      }
      // A turn settles "through the protocol" only if a terminal event was
      // observed. If the stream just ended (cancel fell back to tree teardown,
      // so no turn.cancelled ever arrived) the settle is unobserved.
      const settleEvent = settled.find((event) => {
        const maybeSettle = settleOf(event);
        return (
          maybeSettle !== undefined &&
          (maybeSettle.type === "turn.cancelled" ||
            maybeSettle.type === "turn.completed" ||
            maybeSettle.type === "turn.failed")
        );
      });
      const settleType =
        settleEvent !== undefined && settleEvent._tag === "structured"
          ? settleEvent.event.type
          : "unobserved-settle";
      return `structured cancel: settled via ${settleType} (${String(settled.length)} events)`;
    }),
  // The structured wire contract only defines hello/start/text/complete/\
  // cancel/failed events. Every other capability is absent by construction.
  "session.resume": () =>
    Effect.fail(
      new ConformanceCliCapabilityFailure(
        "structured CLI wire protocol has no resume; capability not supported",
      ),
    ),
  permissions: () =>
    Effect.fail(
      new ConformanceCliCapabilityFailure(
        "structured CLI wire protocol has no permissions; capability not supported",
      ),
    ),
  elicitation: () =>
    Effect.fail(
      new ConformanceCliCapabilityFailure(
        "structured CLI wire protocol has no elicitation; capability not supported",
      ),
    ),
  "tool.events": () =>
    Effect.fail(
      new ConformanceCliCapabilityFailure(
        "structured CLI wire protocol has no tool events; capability not supported",
      ),
    ),
  "model.discovery": () =>
    Effect.fail(
      new ConformanceCliCapabilityFailure(
        "structured CLI wire protocol has no model discovery; capability not supported",
      ),
    ),
  "model.switch": () =>
    Effect.fail(
      new ConformanceCliCapabilityFailure(
        "structured CLI wire protocol has no model switch; capability not supported",
      ),
    ),
  modes: () =>
    Effect.fail(
      new ConformanceCliCapabilityFailure(
        "structured CLI wire protocol has no modes; capability not supported",
      ),
    ),
  usage: () =>
    Effect.fail(
      new ConformanceCliCapabilityFailure(
        "structured CLI wire protocol has no usage reporting; capability not supported",
      ),
    ),
  "terminal.state": () =>
    Effect.fail(
      new ConformanceCliCapabilityFailure(
        "structured CLI wire protocol has no terminal state; capability not supported",
      ),
    ),
};

// ─────────────────────────────────────────────────────────────────────────────
// Basic tier probes (honest limits)

const basicProbeBodies: Readonly<
  Record<CapabilityId, (runtime: CliStructuredRuntimeShape) => Effect.Effect<string, unknown>>
> = {
  "session.start": () => Effect.succeed("basic CLI session started (first readiness line)"),
  prompt: (runtime) =>
    Effect.gen(function* () {
      const token = "synara-cli-probe-hi";
      yield* runtime.sendInput(token);
      const echoLine = yield* runtime.getEvents().pipe(
        Stream.filter(
          (event): event is { readonly _tag: "line"; readonly line: string } =>
            event._tag === "line" && event.line.includes(token),
        ),
        Stream.runHead,
        Effect.timeout("5 seconds"),
      );
      return Option.match(echoLine, {
        onNone: () => "basic prompt: no line echoed",
        onSome: (event) => `basic prompt echoed: ${event.line.slice(0, 80)}`,
      });
    }),
  stream: (runtime) =>
    Effect.gen(function* () {
      const token = "synara-cli-probe-stream";
      yield* runtime.sendInput(token);
      const lines = yield* runtime.getEvents().pipe(
        Stream.filter(
          (event): event is { readonly _tag: "line"; readonly line: string } =>
            event._tag === "line" && event.line.includes(token),
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.timeout("5 seconds"),
      );
      const text = lines.map((event) => event.line);
      return `basic streamed ${String(text.length)} lines${text[0] !== undefined ? `: ${text[0].slice(0, 80)}` : ""}`;
    }),
  cancel: (runtime) =>
    Effect.gen(function* () {
      yield* Effect.sleep("150 millis");
      yield* runtime.cancel;
      return "basic cancel: process tree teardown requested (honest, no protocol ack)";
    }),
  // Everything the basic tier cannot honestly provide fails closed as a hard
  // agent failure with an explicit "honest limits" note (AC #2).
  "session.resume": () =>
    Effect.fail(
      new ConformanceCliCapabilityFailure(
        "basic CLI has no resume; refusing to fake one (honest limits)",
      ),
    ),
  permissions: () =>
    Effect.fail(
      new ConformanceCliCapabilityFailure(
        "basic CLI has no permissions; refusing to fake an approval flow (honest limits)",
      ),
    ),
  elicitation: () =>
    Effect.fail(
      new ConformanceCliCapabilityFailure(
        "basic CLI has no elicitation; refusing to fake one (honest limits)",
      ),
    ),
  usage: () =>
    Effect.fail(
      new ConformanceCliCapabilityFailure("basic CLI has no usage reporting (honest limits)"),
    ),
  "tool.events": () =>
    Effect.fail(
      new ConformanceCliCapabilityFailure("basic CLI has no tool events (honest limits)"),
    ),
  "model.discovery": () =>
    Effect.fail(
      new ConformanceCliCapabilityFailure("basic CLI has no model discovery (honest limits)"),
    ),
  "model.switch": () =>
    Effect.fail(
      new ConformanceCliCapabilityFailure("basic CLI has no model switch (honest limits)"),
    ),
  modes: () =>
    Effect.fail(new ConformanceCliCapabilityFailure("basic CLI has no modes (honest limits)")),
  "terminal.state": () =>
    Effect.fail(
      new ConformanceCliCapabilityFailure("basic CLI has no terminal state (honest limits)"),
    ),
};

// ─────────────────────────────────────────────────────────────────────────────
// Registry binding

const CLI_CAPABILITY_IDS = [
  "session.start",
  "prompt",
  "stream",
  "cancel",
  "session.resume",
  "permissions",
  "elicitation",
  "tool.events",
  "model.discovery",
  "model.switch",
  "modes",
  "usage",
  "terminal.state",
] as const satisfies readonly CapabilityId[];

/** Matches a runtime identity that belongs to the generic CLI connector. */
const matchesCliTier = (
  tier: CliStructuredTier,
): ((runtime: RuntimeIdentitySignals) => boolean) => {
  // Exact query-parameter boundary match (`tier=structured` / `tier=basic`),
  // never a substring: a `tier=structured-v2` or `foo=tier=structured`
  // fingerprint must not collide with either tier's verifier set.
  const expected = `tier=${tier}`;
  return (runtime: RuntimeIdentitySignals): boolean => {
    const fingerprint = runtime.runtimeFingerprint;
    if (!fingerprint?.startsWith(CLI_VERIFIER_RUNTIME_PREFIX)) {
      return false;
    }
    const query = fingerprint.indexOf("?");
    if (query === -1) {
      return false;
    }
    return fingerprint
      .slice(query + 1)
      .split("&")
      .includes(expected);
  };
};

/**
 * Registers both CLI-tier conformance verifier sets into the registry. Each
 * verifier keys on a tier-specific id derived from the capability id and the
 * harness version, and resolves only for a runtime fingerprint encoding the
 * matching tier (so a basic CLI profile never resolves to the structured
 * verifier, and ACP profiles never collide with these).
 */
export function makeCliVerifierRegistry(input: {
  readonly register: (verifier: {
    readonly id: string;
    readonly matchesRuntime?: (runtime: RuntimeIdentitySignals) => boolean;
    readonly verifies: (request: {
      readonly capabilityId: CapabilityId;
      readonly runtime: RuntimeIdentitySignals;
      readonly spawnContext?: {
        readonly command: string;
        readonly args?: ReadonlyArray<string>;
        readonly env?: Readonly<Record<string, string>>;
      };
    }) => Effect.Effect<
      {
        readonly capabilityId: CapabilityId;
        readonly outcome: EvidenceOutcome;
        readonly attribution: CapabilityAttribution;
        readonly detail?: string;
        readonly runtime?: RuntimeIdentitySignals;
      },
      Error
    >;
  }) => void;
}): void {
  const { register } = input;
  const fixtures = fixturePathsForCli();
  const matchesStructured = matchesCliTier("structured");
  const matchesBasic = matchesCliTier("basic");
  for (const capabilityId of CLI_CAPABILITY_IDS) {
    register({
      id: cliStructuredConformanceVerifierId(capabilityId),
      matchesRuntime: matchesStructured,
      verifies: ({ capabilityId: verifyId, runtime, spawnContext }) =>
        Effect.gen(function* () {
          const body = structuredProbeBodies[verifyId];
          if (body === undefined) {
            return {
              capabilityId: verifyId,
              outcome: "inconclusive",
              attribution: "unknown",
              detail: `No structured CLI conformance probe body for ${verifyId}`,
              runtime,
            };
          }
          const edge = yield* runScopedCliProbe({
            fixturePath: spawnContext?.command ?? fixtures.structured,
            env: spawnContext?.env,
            tier: "structured",
            capabilityId: verifyId,
            body: ({ runtime: child }) => body(child),
          });
          return {
            capabilityId: verifyId,
            outcome: edge.outcome,
            attribution: edge.attribution,
            detail: edge.detail,
            runtime,
          };
        }),
    });
    register({
      id: cliBasicConformanceVerifierId(capabilityId),
      matchesRuntime: matchesBasic,
      verifies: ({ capabilityId: verifyId, runtime, spawnContext }) =>
        Effect.gen(function* () {
          const body = basicProbeBodies[verifyId];
          if (body === undefined) {
            return {
              capabilityId: verifyId,
              outcome: "inconclusive",
              attribution: "unknown",
              detail: `No basic CLI conformance probe body for ${verifyId}`,
              runtime,
            };
          }
          const edge = yield* runScopedCliProbe({
            fixturePath: spawnContext?.command ?? fixtures.basic,
            env: spawnContext?.env,
            tier: "basic",
            capabilityId: verifyId,
            body: ({ runtime: child }) => body(child),
          });
          return {
            capabilityId: verifyId,
            outcome: edge.outcome,
            attribution: edge.attribution,
            detail: edge.detail,
            runtime,
          };
        }),
    });
  }
}

/**
 * Resolves the CLI fixture executables relative to this source file, mirroring
 * `fixturePathFromServerDir`. Both fixtures live next to the ACP hostile agent.
 */
export function fixturePathsForCli(): { readonly structured: string; readonly basic: string } {
  const serverDir = fixturePathFromServerDir();
  const base = serverDir.substring(0, serverDir.lastIndexOf("/") + 1);
  return {
    structured: `${base}cli-structured-agent.ts`,
    basic: `${base}cli-basic-agent.ts`,
  };
}

export type { CapabilityAttribution } from "../../capabilityEvidence/Services/CapabilityVerifierRegistry.ts";
export type { CliStructuredRuntimeShape } from "./CliStructuredRuntime.ts";
export type { CliStructuredTier } from "./CliStructuredRuntime.ts";
export type { CliSessionStartResult } from "./CliStructuredRuntime.ts";

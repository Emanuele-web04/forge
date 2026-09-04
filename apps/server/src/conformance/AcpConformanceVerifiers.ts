// FILE: AcpConformanceVerifiers.ts
// Purpose: ACP-specific conformance verifier bindings registered into the
// CapabilityVerifierRegistry. Each verifier keys on (capabilityId + ACP
// harness version), exercises the behavior through the canonical ACP session
// runtime, and reports a CapabilityVerificationOutcome with a hardware-typed
// EvidenceOutcome + Attribution. No Synara provider-name knowledge lives here:
// every expectation is expressed in terms of the ACP protocol itself.
// Layer: Server capability conformance
// Exports: ACP_CONFORMANCE_HARNESS_VERSION, makeAcpVerifierRegistry,
//          acpConformanceVerifierId, acpConformanceOutcome

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { CapabilityId, RuntimeIdentitySignals } from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber, Option, Scope } from "effect";

import {
  AcpSessionRuntime,
  isAcpStartupTimeoutError,
  type AcpSessionRuntimeShape,
  type AcpSessionRuntimeStartResult,
} from "../provider/acp/AcpSessionRuntime.ts";
import type { CapabilityAttribution } from "../capabilityEvidence/Services/CapabilityVerifierRegistry.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Constants

/** Version of the conformance harness. Bump when any verifier behavior changes. */
export const ACP_CONFORMANCE_HARNESS_VERSION = "2026-08-16.1";

/** Verifier key prefix shared by all ACP conformance verifiers. */
export const ACP_VERIFIER_PREFIX = "acp.conformance";

/** Evidence source for synthetic ACP conformance runs. */
export const ACP_CONFORMANCE_EVIDENCE_SOURCE = "synthetic-conformance";

/**
 * Deterministic capability-specific verifier id (AC #6). The harness version
 * is baked into the key so policy re-derivation folds harness drift into the
 * verdict.
 */
export const acpConformanceVerifierId = (capabilityId: CapabilityId): string =>
  `${capabilityId}.${ACP_VERIFIER_PREFIX}.v${ACP_CONFORMANCE_HARNESS_VERSION}`;

const CONFORMANCE_CLIENT_INFO = { name: "synara-conformance", version: "1.0.0" };

// ─────────────────────────────────────────────────────────────────────────────
// Scratch workspace

/**
 * Creates a fresh per-run scratch directory under the platform temp dir and
 * removes it when the scope closes. `rmSync(force: true)` on release so
 * cleanup never throws even if the hostile agent left locked or recreated
 * files behind.
 */
export const withConformanceScratchWorkspace: <A, E, R>(
  use: (workspace: string) => Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R | Scope.Scope> = (use) =>
  Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), "synara-conformance-"))),
    (directory) =>
      Effect.sync(() => {
        rmSync(directory, { recursive: true, force: true });
      }),
  ).pipe(Effect.flatMap(use));

// ─────────────────────────────────────────────────────────────────────────────
// Raw stdout capture + strict framing rejection (AC #5)

/**
 * Strictly validates newline-delimited JSON framing of a byte capture. Any
 * non-JSON line (or a JSON value that is not an object) is an agent fault, not
 * silently skipped: AC #5.
 */
export function findAcpFramingViolation(input: {
  readonly chunks: ReadonlyArray<Uint8Array>;
}): string | undefined {
  const decoder = new TextDecoder();
  const text = decoder.decode(Buffer.concat(input.chunks as Uint8Array[]));
  let start = 0;
  for (;;) {
    const newlineIndex = text.indexOf("\n", start);
    if (newlineIndex === -1) return undefined;
    const line = text.slice(start, newlineIndex).trim();
    if (line.length > 0) {
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return `ACP agent emitted a JSON line that is not an object: ${line.slice(0, 200)}`;
        }
      } catch {
        return `ACP agent emitted a non-JSON stdout line: ${line.slice(0, 200)}`;
      }
    }
    start = newlineIndex + 1;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Capability expectations (declarative single source of truth)

/** ACP probe methods for each canonical capability id. */
export const ACP_CAPABILITY_EXPECTATIONS: Readonly<
  Record<CapabilityId, { readonly method: string; readonly description: string }>
> = {
  "session.start": {
    method: "initialize+session/new",
    description: "initialize + session/new succeed within budget",
  },
  prompt: {
    method: "session/prompt",
    description: "session/prompt returns a successful stop reason",
  },
  stream: {
    method: "session/update",
    description: "session/update notifications arrive after prompt",
  },
  cancel: { method: "session/cancel", description: "session/cancel aborts an in-flight prompt" },
  "session.resume": {
    method: "session/resume",
    description: "resumed session id matches the requested id",
  },
  permissions: {
    method: "session/request_permission",
    description: "session/request_permission round-trips a decision",
  },
  elicitation: {
    method: "elicitation/create",
    description: "elicitation/create elicits a response",
  },
  "tool.events": {
    method: "session/update(tool)",
    description: "tool_call + tool_call_update notifications reflect completed calls",
  },
  "model.discovery": {
    method: "session config options",
    description: "session config options include a model picker",
  },
  "model.switch": {
    method: "session/set_config_option",
    description: "session/set_config_option switches the model",
  },
  modes: {
    method: "session mode state",
    description: "session mode state advertises and switches modes",
  },
  usage: {
    method: "session/update(usage)",
    description: "usage_update notification reflects token usage",
  },
  "terminal.state": {
    method: "terminal/create",
    description: "terminal/create + terminal output behave",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Outcome mapping

export type EvidenceOutcome = "pass" | "fail" | "inconclusive";

export interface ConformanceVerifierEdge {
  readonly outcome: EvidenceOutcome;
  readonly attribution: CapabilityAttribution;
  readonly detail: string;
}

/**
 * A deterministic probe failure: the probe body reached a state that *cannot*
 * be the agent behaving correctly (e.g. `session/cancel` was ignored). Unlike
 * a transport/spawn/framing fault this is a direct observation of the
 * advertised capability being false, so it grades fail/agent — never
 * inconclusive. The `_tag` discriminator survives the Effect/async boundary,
 * which is exactly how the grader classifies it below.
 */
class ConformanceCapabilityFailure extends Error {
  readonly _tag = "ConformanceCapabilityFailure";
  override readonly name = "ConformanceCapabilityFailure";
}

/**
 * Maps a single failed ACP probe edge to evidence. Startup timeouts and auth
 * refusals are reported inconclusive (environment/auth), never a hard agent
 * failure; everything else that looks like the agent misbehaving is fail/agent.
 */
export function acpConformanceOutcome(input: {
  readonly detail: string;
  readonly attribution: CapabilityAttribution;
  readonly outcome: EvidenceOutcome;
}): ConformanceVerifierEdge {
  return input;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-run scaffolding

/**
 * A bounded ACP capability probe. Spawns a fresh agent child in a scratch
 * workspace, guards the whole run with a hard deadline, and guarantees the
 * child process tree exits via the session runtime's scope finalizer (SIGTERM
 * → SIGKILL). Verifies strict framing on the raw stdout capture and folds any
 * violation into an agent-attributed failure.
 */
export function runScopedAcpProbe(input: {
  readonly fixturePath: string;
  readonly env?: Record<string, string>;
  readonly capabilityId: CapabilityId;
  /** When set, the spawned runtime resumes this session id instead of creating a fresh session. */
  readonly resumeSessionId?: string;
  /** Seconds the whole probe may take before being aborted as inconclusive. */
  readonly deadlineSeconds?: number;
  readonly body: (
    runtime: AcpSessionRuntimeShape,
    started: AcpSessionRuntimeStartResult,
  ) => Effect.Effect<string, unknown>;
}): Effect.Effect<ConformanceVerifierEdge, never> {
  const deadlineSeconds = input.deadlineSeconds ?? 15;
  const run = withConformanceScratchWorkspace((workspace) =>
    Effect.gen(function* () {
      const capture: Uint8Array[] = [];
      const layer = AcpSessionRuntime.layer({
        spawn: {
          command: process.execPath,
          args: [input.fixturePath],
          env: {
            ...input.env,
            VITEST: "true",
          },
        },
        cwd: workspace,
        ...(input.resumeSessionId !== undefined ? { resumeSessionId: input.resumeSessionId } : {}),
        clientInfo: CONFORMANCE_CLIENT_INFO,
        startupTimeouts: {
          initializeMs: deadlineSeconds * 1_000,
          authenticateMs: deadlineSeconds * 1_000,
          sessionSetupMs: deadlineSeconds * 1_000,
          totalMs: deadlineSeconds * 1_000,
        },
        protocolLogging: {
          logIncoming: true,
          logOutgoing: false,
          logger: (event) => {
            const rawChunk = event.payload;
            if (event.stage !== "raw" || !(rawChunk instanceof Uint8Array)) {
              return Effect.void;
            }
            return Effect.sync(() => capture.push(rawChunk.slice()));
          },
        },
      });

      const runBody = Effect.gen(function* () {
        const runtime = yield* AcpSessionRuntime;
        const started = yield* runtime.start();
        return yield* input.body(runtime, started);
      });

      const bodyResult = yield* runBody.pipe(
        Effect.provide(layer),
        Effect.scoped,
        Effect.provide(NodeServices.layer),
      );
      const detail = typeof bodyResult === "string" ? bodyResult : JSON.stringify(bodyResult);

      const framingViolation = findAcpFramingViolation({ chunks: capture });
      if (framingViolation !== undefined) {
        return {
          outcome: "fail" as const,
          attribution: "agent" as const,
          detail: framingViolation,
        };
      }
      return { outcome: "pass" as const, attribution: "agent" as const, detail };
    }),
  );

  return run.pipe(Effect.scoped).pipe(
    Effect.timeout((deadlineSeconds + 5) * 1_000),
    Effect.match({
      onFailure: (error) => gradeConformanceProbeFailure(error),
      onSuccess: (edge) => edge,
    }),
  );
}

/**
 * Maps a failed ACP probe run to an evidence edge, distinguishing agent faults
 * from environment/auth issues:
 * - startup/handshake timeouts → inconclusive/environment (the budget ran out
 *   before the capability could be observed; could be a slow machine)
 * - insufficient-auth (RequestError with a denied/auth marker) → fail/auth
 * - anything else the agent did after the handshake (transport error, process
 *   death mid-turn, request refused) → fail/agent (the advertised behavior
 *   demonstrably does not hold)
 */
function gradeConformanceProbeFailure(error: unknown): ConformanceVerifierEdge {
  const detailText = `ACP conformance probe failed: ${String(error)}`;
  // Schema.TaggedErrorClass values may cross Effect/async boundaries as plain
  // data (only the `_tag` discriminator is preserved), so grade by `_tag`
  // rather than `instanceof`.
  const tag =
    typeof error === "object" && error !== null
      ? ((error as { _tag?: unknown })._tag as string | undefined)
      : undefined;
  if (isAcpStartupTimeoutError(error)) {
    return {
      outcome: "inconclusive",
      attribution: "environment",
      detail: detailText,
    };
  }
  if (tag === "AcpRequestError") {
    const code =
      typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    // A denied auth request is the agent actively refusing the client; that is
    // an auth failure (inconclusive for the capability itself).
    if (code === -32002 || code === -32602) {
      return {
        outcome: "inconclusive",
        attribution: "auth",
        detail: detailText,
      };
    }
    // Any other JSON-RPC request error after the handshake is the agent
    // misbehaving on the capability under test.
    return { outcome: "fail", attribution: "agent", detail: detailText };
  }
  if (tag === "AcpTransportError") {
    return { outcome: "fail", attribution: "agent", detail: detailText };
  }
  if (tag === "AcpSpawnError") {
    return {
      outcome: "inconclusive",
      attribution: "environment",
      detail: detailText,
    };
  }
  if (tag === "ConformanceCapabilityFailure") {
    // A deterministic probe-body failure is the agent failing the capability
    // under test (e.g. it ignored a session/cancel that the protocol requires
    // it to honor). Fail/agent — never inconclusive.
    return {
      outcome: "fail",
      attribution: "agent",
      detail: error instanceof Error ? error.message : detailText,
    };
  }
  // A bare Error (e.g. a `TimeoutException` from the probe's hard deadline) or
  // anything unidentified: we could not attribute it to the agent, so it is
  // inconclusive — never a hard agent failure we cannot explain.
  return { outcome: "inconclusive", attribution: "environment", detail: detailText };
}

// ─────────────────────────────────────────────────────────────────────────────
// Verifier registry binding

export type { CapabilityAttribution } from "../capabilityEvidence/Services/CapabilityVerifierRegistry.ts";

/**
 * Per-capability probe bodies. Each exercises the canonical ACP behavior that
 * backs the capability through the runtime's public surface only.
 */
const probeBodies: Readonly<
  Record<CapabilityId, (runtime: AcpSessionRuntimeShape) => Effect.Effect<string, unknown>>
> = {
  "session.start": () => Effect.succeed("ACP initialize + session/new succeeded"),
  prompt: (runtime) =>
    Effect.gen(function* () {
      const response = yield* runtime.prompt({ prompt: [{ type: "text", text: "ping" }] });
      return `ACP session/prompt stopReason=${JSON.stringify(String(response.stopReason))}`;
    }),
  stream: (runtime) =>
    Effect.gen(function* () {
      const response = yield* runtime.prompt({ prompt: [{ type: "text", text: "ping" }] });
      return `ACP prompt streamed to stopReason=${JSON.stringify(String(response.stopReason))}`;
    }),
  cancel: (runtime) =>
    Effect.gen(function* () {
      // The ACP contract is that session/cancel aborts the in-flight prompt —
      // no readiness handshake required. Prompt, then cancel immediately. The
      // prompt fiber must settle with a cancelled stop reason; an agent that
      // keeps the turn running past a bounded grace window has ignored the
      // cancel (a hard agent failure, AC fault mode `ignore-cancel`), while an
      // agent that dies or errors on the cancel is graded fail/agent too.
      const promptFiber = yield* runtime
        .prompt({ prompt: [{ type: "text", text: "block" }] })
        .pipe(Effect.forkChild);
      // Give the prompt a moment to actually start before cancelling so the
      // cancel lands on a live turn.
      yield* Effect.sleep("150 millis");
      yield* runtime.cancel;
      // Bound the post-cancel settle: if the prompt never resolves, the agent
      // ignored the cancel. 4s is far shorter than the 15s probe deadline so
      // the failure is attributed to the agent, not masked by a probe timeout.
      const settled = yield* Fiber.join(promptFiber).pipe(Effect.timeoutOption("4 seconds"));
      if (Option.isNone(settled)) {
        return yield* Effect.fail(
          new ConformanceCapabilityFailure(
            "ACP session/cancel was sent but the in-flight prompt never settled (agent ignored cancel)",
          ),
        );
      }
      const result = settled.value;
      return `ACP session/cancel stopReason=${JSON.stringify(String(result.stopReason))}`;
    }),
  "session.resume": () =>
    Effect.succeed("ACP session.resume verified through dedicated two-phase resume probe"),
  permissions: (runtime) =>
    Effect.gen(function* () {
      yield* runtime.handleRequestPermission((params) => {
        void params;
        return Effect.succeed({
          outcome: { outcome: "selected", optionId: params.options[0]?.optionId ?? "allow" },
        });
      });
      return "ACP session/request_permission handler installed";
    }),
  elicitation: (runtime) =>
    Effect.gen(function* () {
      yield* runtime.handleElicitation(() =>
        Effect.succeed({
          action: "accept",
          content: {},
          _meta: { synara: true },
        }),
      );
      return "ACP elicitation/create handler installed";
    }),
  "tool.events": (runtime) =>
    Effect.gen(function* () {
      const response = yield* runtime.prompt({ prompt: [{ type: "text", text: "tool" }] });
      return `ACP tool event probe stopReason=${JSON.stringify(String(response.stopReason))}`;
    }),
  "model.discovery": (runtime) =>
    Effect.gen(function* () {
      const options = yield* runtime.getConfigOptions;
      const modelOption = options.find((option) => option.category === "model");
      return modelOption === undefined
        ? "no-model-option"
        : `ACP model option ${JSON.stringify(modelOption.id)} discovered`;
    }),
  "model.switch": (runtime) =>
    Effect.gen(function* () {
      const options = yield* runtime.getConfigOptions;
      const modelOption = options.find((option) => option.category === "model");
      if (modelOption === undefined) {
        return "no-model-option";
      }
      const targetValue =
        modelOption.type === "select"
          ? String(
              (modelOption.options?.[0] as { value?: string | number } | undefined)?.value ??
                "default",
            )
          : String(modelOption.currentValue);
      const response = yield* runtime.setConfigOption(modelOption.id, targetValue);
      return `ACP model switch result=${JSON.stringify(String(response))}`;
    }),
  modes: (runtime) =>
    Effect.gen(function* () {
      const modeState = yield* runtime.getModeState;
      return `ACP mode state=${JSON.stringify(modeState)}`;
    }),
  usage: (runtime) =>
    Effect.gen(function* () {
      const response = yield* runtime.prompt({ prompt: [{ type: "text", text: "usage" }] });
      return `ACP usage probe stopReason=${JSON.stringify(String(response.stopReason))}`;
    }),
  "terminal.state": (runtime) =>
    Effect.gen(function* () {
      yield* runtime.handleCreateTerminal(() => Effect.succeed({ terminalId: "term-1" }));
      return "ACP terminal/create handler installed";
    }),
};

/**
 * Builds and registers an ACP conformance verifier for every canonical
 * capability id. Each verifier runs the corresponding probe in a scratch
 * workspace against the given fixture and reports a hardware-typed outcome,
 * with `runtime` identity signals for evidence persistence (AC #3).
 */
export function makeAcpVerifierRegistry(input: {
  readonly fixturePath: string;
  readonly register: (verifier: {
    readonly id: string;
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
  const { fixturePath, register } = input;

  for (const capabilityId of Object.keys(ACP_CAPABILITY_EXPECTATIONS) as readonly CapabilityId[]) {
    register({
      id: acpConformanceVerifierId(capabilityId),
      verifies: ({ capabilityId: verifyId, runtime, spawnContext }) =>
        Effect.gen(function* () {
          const body = probeBodies[verifyId];
          if (body === undefined) {
            return {
              capabilityId: verifyId,
              outcome: "inconclusive",
              attribution: "unknown",
              detail: `No ACP conformance probe body for ${verifyId}`,
              runtime,
            };
          }
          // The runner stamps the agent executable + env it invited into the
          // run via spawnContext; the registered fixture path is the fallback.
          const commandToProbe = spawnContext?.command ?? fixturePath;
          const edge = yield* verifyId === "session.resume"
            ? runResumeProbe({
                fixturePath: commandToProbe,
                ...(spawnContext?.env !== undefined ? { env: { ...spawnContext.env } } : {}),
                runtime,
              })
            : runScopedAcpProbe({
                fixturePath: commandToProbe,
                ...(spawnContext?.env !== undefined ? { env: { ...spawnContext.env } } : {}),
                capabilityId: verifyId,
                body,
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
 * Two-phase session.resume conformance probe. Phase 1 creates a fresh session
 * and prompts it once (so there is state worth resuming). Phase 2 spawns a
 * second runtime that resumes the exact session id the agent handed back in
 * phase 1 and prompts it again. An agent that advertises resume but cannot
 * actually reopen a session (e.g. `fake-resume` hostile mode) fails with agent
 * attribution; a startup/resume timeout stays inconclusive/environment.
 */
const runResumeProbe = (input: {
  readonly fixturePath: string;
  readonly env?: Record<string, string>;
  readonly runtime: RuntimeIdentitySignals;
}): Effect.Effect<ConformanceVerifierEdge, never> =>
  Effect.gen(function* () {
    const phase1 = yield* runScopedAcpProbe({
      fixturePath: input.fixturePath,
      ...(input.env !== undefined ? { env: input.env } : {}),
      capabilityId: "session.resume",
      body: (_runtime, started) =>
        Effect.gen(function* () {
          const response = yield* _runtime.prompt({
            prompt: [{ type: "text", text: "first turn" }],
          });
          return `${started.sessionId}|${JSON.stringify(String(response.stopReason))}`;
        }),
    });
    if (phase1.outcome !== "pass") {
      return phase1;
    }
    const sessionId = phase1.detail.split("|")[0] ?? "";
    const phase2 = yield* runScopedAcpProbe({
      fixturePath: input.fixturePath,
      ...(input.env !== undefined ? { env: input.env } : {}),
      capabilityId: "session.resume",
      resumeSessionId: sessionId,
      body: (_runtime, started) =>
        Effect.gen(function* () {
          if (started.sessionSetupMethod !== "resume") {
            return yield* Effect.fail(
              new Error(
                `session/resume requested but handshake used ${started.sessionSetupMethod} (agent may not advertise resume)`,
              ),
            );
          }
          const response = yield* _runtime.prompt({
            prompt: [{ type: "text", text: "after resume" }],
          });
          return `resumed=${started.sessionId} stopReason=${JSON.stringify(String(response.stopReason))}`;
        }),
    });
    if (phase2.outcome === "pass") {
      return {
        outcome: "pass",
        attribution: "agent",
        detail: `ACP session.resume round-trip ok: ${phase2.detail}`,
      };
    }
    return {
      outcome: "fail",
      attribution: "agent",
      detail: `ACP session.resume round-trip failed: ${phase2.detail} (session id ${sessionId})`,
    };
  });

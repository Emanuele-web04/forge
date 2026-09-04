// FILE: AcpProbe.ts
// Purpose: Bounded `initialize` probe of a discovered local ACP candidate.
//
// Spawns the resolved binary via AcpSessionRuntime in a scratch workspace and
// captures what the agent advertises on `initialize`: agentInfo (name/version),
// advertised auth methods, and protocol capabilities. The probe is
// teardown-safe (the session runtime's scope finalizer terminates the process
// tree) and bounded (startup timeouts, not an unbounded wait).
//
// Fingerprint handling is split across two layers:
//   - DiscoveryService owns the identity-fingerprint cache. When the binary's
//     current `executableIdentity` differs from the cached one, it reports
//     `identity-changed` WITHOUT re-probing (the binary changed on disk).
//   - This module owns only the on-disk probe itself.
// Layer: Server discovery
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Data, Effect, Scope } from "effect";

import { AcpSessionRuntime, isAcpStartupTimeoutError } from "../provider/acp/AcpSessionRuntime.ts";
import { executableIdentity } from "../executableLookup.ts";

export class AcpProbeError extends Data.TaggedError("AcpProbeError")<{
  readonly code: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type AcpProbeOutcome =
  | {
      readonly state: "ok";
      readonly agentName: string | undefined;
      readonly agentVersion: string | undefined;
      readonly authMethodIds: ReadonlyArray<string>;
      readonly capabilities: {
        readonly loadSession: boolean;
        readonly resumeSession: boolean;
        readonly forkSession: boolean;
      };
      readonly protocolVersion: number | undefined;
      /** `executableIdentity` of the probed binary (null when unstat-able). */
      readonly identityFingerprint: string | null;
    }
  | {
      readonly state: "failed";
      readonly reason: "timeout" | "auth" | "spawn" | "handshake" | "unknown";
      readonly detail: string;
      readonly identityFingerprint: string | null;
    };

export interface AcpProbeOptions {
  readonly spawnEnv?: NodeJS.ProcessEnv;
  /** Override for the identity fingerprint (tests). */
  readonly identity?: string;
  /** Scratch cwd; defaults to a fresh temp dir removed when the scope closes. */
  readonly cwd?: string;
}

export const DEFAULT_ACP_PROBE_TIMEOUTS = {
  initializeMs: 8_000,
  authenticateMs: 8_000,
  sessionSetupMs: 8_000,
  totalMs: 12_000,
};

/**
 * Run a bounded initialize probe against `command`. The whole effect is
 * scoped: the child process tree is terminated when the scope closes. The
 * effect NEVER fails — every failure mode is a structured `AcpProbeOutcome` so
 * a bad agent can never crash discovery.
 */
export const runAcpInitializeProbe = (input: {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly options?: AcpProbeOptions;
}): Effect.Effect<AcpProbeOutcome, never, Scope.Scope> =>
  Effect.gen(function* () {
    const command = input.command;
    const args = input.args ?? [];
    const options = input.options ?? {};
    const identity = options.identity ?? executableIdentity(command) ?? null;

    const fallbackCwd = yield* Effect.sync(() =>
      mkdtempSync(path.join(tmpdir(), "synara-acp-probe-")),
    );
    const cwd = options.cwd ?? fallbackCwd;

    const layer = AcpSessionRuntime.layer({
      spawn: {
        command,
        args,
        ...(options.spawnEnv !== undefined ? { env: options.spawnEnv } : {}),
      },
      cwd,
      clientInfo: { name: "synara-discovery-probe", version: "1.0.0" },
      startupTimeouts: DEFAULT_ACP_PROBE_TIMEOUTS,
    });

    const runProbe = Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime;
      const started = yield* runtime.start();
      const initializeResult = started.initializeResult;
      const agentName = initializeResult.agentInfo?.title ?? initializeResult.agentInfo?.name;
      const agentVersion = initializeResult.agentInfo?.version;
      const authMethodIds = (initializeResult.authMethods ?? [])
        .map((method) => method.id.trim())
        .filter((methodId) => methodId.length > 0);
      return {
        state: "ok" as const,
        agentName,
        agentVersion,
        authMethodIds,
        capabilities: {
          loadSession: initializeResult.agentCapabilities?.loadSession === true,
          resumeSession: initializeResult.agentCapabilities?.sessionCapabilities?.resume != null,
          forkSession: initializeResult.agentCapabilities?.sessionCapabilities?.fork != null,
        },
        protocolVersion: initializeResult.protocolVersion,
        identityFingerprint: identity,
      } satisfies AcpProbeOutcome;
    });

    const probeRun = yield* runProbe
      .pipe(Effect.provide(layer), Effect.scoped, Effect.provide(NodeServices.layer))
      .pipe(Effect.result);

    const cleanup = Effect.sync(() => {
      if (options.cwd === undefined && fallbackCwd) {
        rmSync(fallbackCwd, { recursive: true, force: true });
      }
    });

    // Match against the failure to produce a structured outcome.
    if (probeRun._tag === "Success") {
      yield* cleanup;
      return probeRun.success;
    }

    // `detail` copies the child's error text verbatim. That text is OPAQUE
    // display-only diagnostics (AcpProbeResult.detail): a hostile agent
    // controls what it prints, so `detail` must never feed a launch/install
    // value (C1).
    const failureToOutcome = (error: unknown): AcpProbeOutcome => {
      if (isAcpStartupTimeoutError(error)) {
        return {
          state: "failed",
          reason: "timeout",
          detail: String(error),
          identityFingerprint: identity,
        };
      }
      const tag =
        typeof error === "object" && error !== null
          ? ((error as { _tag?: unknown })._tag as string | undefined)
          : undefined;
      if (tag === "AcpRequestError") {
        const code =
          typeof error === "object" && error !== null
            ? (error as { code?: unknown }).code
            : undefined;
        if (code === -32002 || code === -32602) {
          return {
            state: "failed",
            reason: "auth",
            detail: String(error),
            identityFingerprint: identity,
          };
        }
        return {
          state: "failed",
          reason: "handshake",
          detail: String(error),
          identityFingerprint: identity,
        };
      }
      if (tag === "AcpSpawnError") {
        return {
          state: "failed",
          reason: "spawn",
          detail: String(error),
          identityFingerprint: identity,
        };
      }
      if (tag === "AcpTransportError") {
        return {
          state: "failed",
          reason: "handshake",
          detail: String(error),
          identityFingerprint: identity,
        };
      }
      return {
        state: "failed",
        reason: "unknown",
        detail: String(error),
        identityFingerprint: identity,
      };
    };

    const outcome = failureToOutcome(probeRun.failure);
    yield* cleanup;
    return outcome;
  });

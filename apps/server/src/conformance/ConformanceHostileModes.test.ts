// FILE: ConformanceHostileModes.test.ts
// Purpose: Integration tests that run the KAR-524 conformance runner against
// the deterministic hostile ACP fixture, proving each fault mode produces the
// intended evidence edge without corrupting persistence (AC #1-#7).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { describe } from "vitest";

import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { capabilityEvidenceLayer } from "../capabilityEvidence/Layers/CapabilityEvidenceService.ts";
import { CapabilityEvidenceRepository } from "../capabilityEvidence/Services/CapabilityEvidenceRepository.ts";
import { ConformanceRunner, type ConformanceRunInput } from "./ConformanceRunner.ts";
import { ACP_CONFORMANCE_HARNESS_VERSION } from "./AcpConformanceVerifiers.ts";

const HOSTILE_FIXTURE = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "../../scripts/acp-hostile-agent.ts",
);

let profileSeq = 0;

function makeTestLayer() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-hostile-test-"));
  const dbPath = path.join(tempDir, "orchestration.sqlite");
  const persistenceLayer = makeSqlitePersistenceLive(dbPath);
  const layer = capabilityEvidenceLayer.pipe(
    Layer.provideMerge(persistenceLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  return { layer, tempDir, dbPath };
}

function runInput(overrides: Partial<ConformanceRunInput> = {}): ConformanceRunInput {
  profileSeq += 1;
  return {
    namespace: `hostile:test:${profileSeq}`,
    capabilityId: "prompt",
    runtimeIdentity: {
      runtimeFingerprint: `acp-conformance-${ACP_CONFORMANCE_HARNESS_VERSION}`,
      resolvedCommand: HOSTILE_FIXTURE,
    },
    agentCommand: HOSTILE_FIXTURE,
    advertised: true,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Healthy fixture → repeatable observations (AC #1)

const healthyLayer = makeTestLayer().layer;
const healthyTests = it.layer(healthyLayer);

describe("conformance runner vs healthy hostile fixture (AC #1)", () => {
  healthyTests("passes prompt on a clean fixture and persists an observation", (it) => {
    it.effect("prompt capability records pass/agent", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const runner = yield* ConformanceRunner;
          const input = runInput();
          const result = yield* runner.run(input);
          assert.equal(result.observation.outcome, "pass");
          assert.equal(result.observation.attribution, "agent");
          assert.equal(result.observation.source, "synthetic-conformance");
          assert.equal(result.observation.capabilityId, "prompt");

          const repo = yield* CapabilityEvidenceRepository;
          const rows = yield* repo.listObservations({
            namespace: input.namespace,
            capabilityId: "prompt",
          });
          assert.equal(rows.length, 1);
          assert.equal(rows[0]!.observationId, result.observation.observationId);
        }),
      ),
    );
  });

  healthyTests("is repeatable: two identical runs produce two stable rows", (it) => {
    it.effect("two runs on the same namespace keep both observations", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const runner = yield* ConformanceRunner;
          const input = runInput();
          yield* runner.run(input);
          yield* runner.run(input);

          const repo = yield* CapabilityEvidenceRepository;
          const rows = yield* repo.listObservations({
            namespace: input.namespace,
            capabilityId: "prompt",
          });
          assert.equal(rows.length, 2);
          assert.equal(rows[0]!.outcome, "pass");
          assert.equal(rows[1]!.outcome, "pass");
        }),
      ),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fault-mode matrix (AC #2, #5)
//
// `excludeTestServices: true` keeps the REAL clock: the conformance probes and
// the zombie-reap sleeper depend on actual timers, and TestClock's virtual
// time never elapses on its own (`it.effect` would hang the run until vitest's
// own 90s timeout).

const matrix = [
  // mode             capability    advertised  expected outcome/attribution
  {
    mode: "initialize-hang",
    capabilityId: "session.start",
    outcome: "inconclusive",
    attribution: "environment",
  },
  { mode: "malformed-frame", capabilityId: "prompt", outcome: "fail", attribution: "agent" },
  { mode: "stdout-pollution", capabilityId: "prompt", outcome: "fail", attribution: "agent" },
  { mode: "process-death", capabilityId: "prompt", outcome: "fail", attribution: "agent" },
  {
    mode: "late-event-after-close",
    capabilityId: "session.start",
    outcome: "pass",
    attribution: "agent",
  },
  { mode: "partial-utf8", capabilityId: "prompt", outcome: "fail", attribution: "agent" },
  { mode: "slow-drip", capabilityId: "prompt", outcome: "pass", attribution: "agent" },
  { mode: "huge-tool-output", capabilityId: "prompt", outcome: "pass", attribution: "agent" },
  {
    mode: "permission-deny-loop",
    capabilityId: "permissions",
    outcome: "pass",
    attribution: "agent",
  },
  { mode: "stale-ids", capabilityId: "prompt", outcome: "pass", attribution: "agent" },
] as const;

function runForMode(input: ConformanceRunInput) {
  return Effect.gen(function* () {
    const runner = yield* ConformanceRunner;
    return yield* runner.run(input);
  });
}

describe("conformance runner vs hostile fault modes", () => {
  for (const expectation of matrix) {
    const layer = makeTestLayer().layer;
    const tests = it.layer(layer, { excludeTestServices: true });
    tests(`${expectation.mode} → ${expectation.outcome}/${expectation.attribution}`, (it) => {
      it.effect("records the expected evidence edge", () =>
        TestClock.withLive(
          Effect.gen(function* () {
            const input = runInput({
              capabilityId: expectation.capabilityId,
              advertised: true,
              agentEnv: { SYNARA_ACP_HOSTILE_MODE: expectation.mode },
            });
            const result = yield* runForMode(input);
            assert.equal(
              result.observation.outcome,
              expectation.outcome,
              `${expectation.mode} outcome; detail: ${result.observation.run?.detail ?? "(none)"}`,
            );
            assert.equal(
              result.observation.attribution,
              expectation.attribution,
              `${expectation.mode} attribution; detail: ${result.observation.run?.detail ?? "(none)"}`,
            );

            const repo = yield* CapabilityEvidenceRepository;
            const rows = yield* repo.listObservations({
              namespace: input.namespace,
              capabilityId: expectation.capabilityId,
            });
            assert.equal(rows.length, 1);
          }),
        ),
      );
    });
  }
});

describe("advertised-but-heavy-failure disables via policy (AC #2)", () => {
  const layer = makeTestLayer().layer;
  const tests = it.layer(layer);
  tests("process-death on advertised prompt derives broken state", (it) => {
    it.effect("effective state reads broken for a hard agent failure", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const runner = yield* ConformanceRunner;
          const input = runInput({
            capabilityId: "prompt",
            advertised: true,
            agentEnv: { SYNARA_ACP_HOSTILE_MODE: "process-death" },
          });
          const result = yield* runner.run(input);
          assert.equal(
            result.observation.outcome,
            "fail",
            `process-death detail: ${result.observation.run?.detail ?? "(no detail)"}`,
          );
          assert.equal(result.effectiveStateView.state, "broken");
          assert.equal(result.effectiveStateView.advertised, true);
        }),
      ),
    );
  });
});

describe("policy hysteresis keeps flaky-cancel stable (AC #4)", () => {
  const layer = makeTestLayer().layer;
  const tests = it.layer(layer, { excludeTestServices: true });
  tests("alternating pass/fail cancel runs never flip to broken", (it) => {
    it.effect("mixed cancel outcomes derive degraded, not broken", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const runner = yield* ConformanceRunner;
          const input = runInput({
            capabilityId: "cancel",
            advertised: true,
            agentEnv: { SYNARA_ACP_HOSTILE_MODE: "flaky-cancel" },
          });

          // Warm with a healthy cancel pass first.
          yield* runner.run(
            runInput({
              namespace: input.namespace,
              capabilityId: "cancel",
              advertised: true,
              agentEnv: {},
            }),
          );

          // A flaky agent that occasionally fails must not flip the verdict.
          for (let i = 0; i < 4; i++) {
            const env =
              i % 2 === 0
                ? {
                    SYNARA_ACP_HOSTILE_MODE: "flaky-cancel",
                    SYNARA_ACP_HOSTILE_FLAKY_CANCEL_FAIL_FIRST: "1",
                  }
                : { SYNARA_ACP_HOSTILE_MODE: "none" };
            yield* runner.run(
              runInput({
                namespace: input.namespace,
                capabilityId: "cancel",
                advertised: true,
                agentEnv: env,
              }),
            );
          }

          const repo = yield* CapabilityEvidenceRepository;
          const stored = yield* repo.getEffectiveState({
            namespace: input.namespace,
            capabilityId: "cancel",
          });
          assert.isDefined(stored);
          // Mixed evidence stays degraded — never broken from a flaky fixture.
          assert.notEqual(stored!.state, "broken");
        }),
      ),
    );
  });
});

describe("advertised-but-broken capabilities fail with agent attribution", () => {
  // fake-resume and ignore-cancel are advertised but demonstrably false, so
  // they must produce fail/agent evidence (AC #2) — not a masked inconclusive.
  const layer = makeTestLayer().layer;
  const tests = it.layer(layer, { excludeTestServices: true });
  tests("fake-resume on session.resume derives fail/agent", (it) => {
    it.effect("resume round-trip failure is agent-attributed", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const runner = yield* ConformanceRunner;
          const input = runInput({
            capabilityId: "session.resume",
            advertised: true,
            agentEnv: {
              SYNARA_ACP_HOSTILE_MODE: "fake-resume",
              SYNARA_ACP_HOSTILE_ADVERTISE_RESUME: "1",
            },
          });
          const result = yield* runner.run(input);
          assert.equal(result.observation.outcome, "fail");
          assert.equal(result.observation.attribution, "agent");
        }),
      ),
    );
  });

  tests("ignore-cancel on cancel derives fail/agent", (it) => {
    it.effect("agent that ignores cancel is a hard agent failure", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const runner = yield* ConformanceRunner;
          const input = runInput({
            capabilityId: "cancel",
            advertised: true,
            agentEnv: { SYNARA_ACP_HOSTILE_MODE: "ignore-cancel" },
          });
          const result = yield* runner.run(input);
          assert.equal(
            result.observation.outcome,
            "fail",
            `cancel detail: ${result.observation.run?.detail ?? "(no detail)"}`,
          );
          assert.equal(result.observation.attribution, "agent");
        }),
      ),
    );
  });
});

describe("capability-change mid-session stays observable (AC #2)", () => {
  const layer = makeTestLayer().layer;
  const tests = it.layer(layer, { excludeTestServices: true });
  tests("a session id flip at session/new still starts cleanly", (it) => {
    it.effect("session.start passes after a capability change", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const runner = yield* ConformanceRunner;
          const input = runInput({
            capabilityId: "session.start",
            advertised: true,
            agentEnv: { SYNARA_ACP_HOSTILE_MODE: "capability-change" },
          });
          const result = yield* runner.run(input);
          assert.equal(result.observation.outcome, "pass");
        }),
      ),
    );
  });

  tests("resuming the flipped session still round-trips", (it) => {
    it.effect("session.resume survives a session id flip", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const runner = yield* ConformanceRunner;
          const input = runInput({
            capabilityId: "session.resume",
            advertised: true,
            agentEnv: {
              SYNARA_ACP_HOSTILE_MODE: "capability-change",
              SYNARA_ACP_HOSTILE_ADVERTISE_RESUME: "1",
            },
          });
          const result = yield* runner.run(input);
          assert.equal(result.observation.outcome, "pass");
        }),
      ),
    );
  });
});

describe("zombie-child leaves no descendant (AC #6)", () => {
  const layer = makeTestLayer().layer;
  const tests = it.layer(layer, { excludeTestServices: true });
  tests("a zombie grandchild is reaped after the run completes", (it) => {
    it.effect("no child process from the fixture survives the run", () =>
      TestClock.withLive(
        Effect.gen(function* () {
          const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-zombie-log-"));
          const logPath = path.join(logDir, "hostile.log");
          const runner = yield* ConformanceRunner;
          const input = runInput({
            capabilityId: "session.start",
            agentEnv: {
              SYNARA_ACP_HOSTILE_MODE: "zombie-child",
              SYNARA_ACP_HOSTILE_LOG_PATH: logPath,
            },
          });
          const done = yield* runner.run(input).pipe(Effect.timeoutOption("20 seconds"));
          if (done._tag === "None") {
            return yield* Effect.fail(new Error("runner.run hung; outer scope blocked"));
          }

          const entries = fs
            .readFileSync(logPath, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { type: string; payload?: unknown });
          const zombiePids: number[] = [];
          for (const entry of entries) {
            if (
              entry.type === "zombie-child" &&
              typeof entry.payload === "object" &&
              entry.payload !== null &&
              typeof (entry.payload as { pid?: unknown }).pid === "number"
            ) {
              zombiePids.push(Number((entry.payload as { pid: number }).pid));
            }
          }
          assert.ok(zombiePids.length > 0, "fixture logged its zombie child pid");

          // Give the process tree a moment to fully reap before probing.
          yield* Effect.sleep("250 millis");
          let survivorCount = 0;
          for (const pid of zombiePids) {
            try {
              process.kill(pid, 0);
              survivorCount += 1;
            } catch {
              // ESRCH → gone.
            }
          }
          assert.equal(survivorCount, 0, "grandchild process must be gone after run");
        }),
      ),
    );
  });
});

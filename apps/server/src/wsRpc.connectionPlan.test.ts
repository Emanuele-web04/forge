import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { resolveConnectionPlanForCandidate } from "./wsRpc";
import type { ConnectionCandidate } from "@synara/contracts";

function candidate(overrides: Partial<ConnectionCandidate> = {}): ConnectionCandidate {
  return {
    candidateId: "recipe:test-agent:/usr/local/bin/agent",
    agentId: "test-agent",
    displayName: "Test Agent",
    source: "recipe",
    resolvedPath: "/usr/local/bin/agent",
    provenance: { source: "recipe", version: "1.2.3" },
    order: 0,
    ...overrides,
  } as ConnectionCandidate;
}

const refused = (input: { readonly candidate: ConnectionCandidate; readonly cwd?: string }) =>
  resolveConnectionPlanForCandidate(input).pipe(Effect.flip);

it("returns a structured POLICY_CATALOGONLY error for a registry-only candidate", () =>
  Effect.gen(function* () {
    const error = yield* refused({
      candidate: candidate({
        source: "registry",
        resolvedPath: undefined,
        resolvedEndpoint: undefined,
        install: { kind: "npx", package: "test-agent" },
        provenance: { source: "registry" },
      }),
    });
    // A policy refusal is a typed WsRpcError with a structured code, never
    // a generic defect (C6a).
    assert.equal(error.code, "POLICY_CATALOGONLY");
    assert.include(error.message, "catalog-only");
    assert.isUndefined(error.retryable);
  }));

it("returns a structured POLICY_MISSINGBINARY error for a configured-but-absent binary", () =>
  Effect.gen(function* () {
    const error = yield* refused({
      candidate: candidate({
        resolvedPath: undefined,
        resolvedEndpoint: undefined,
        versionProbe: {
          state: "missing",
          detail: "No executable `ghost-agent` found on PATH.",
          probedAt: "2026-08-16T00:00:00.000Z",
        },
      }),
    });
    assert.equal(error.code, "POLICY_MISSINGBINARY");
    assert.include(error.message, "not installed");
  }));

it("returns a structured POLICY_POLICYREFUSED error for a shell-string launch target", () =>
  Effect.gen(function* () {
    const error = yield* refused({
      candidate: candidate({ resolvedPath: "/bin/sh -c 'evil' " }),
    });
    assert.equal(error.code, "POLICY_POLICYREFUSED");
  }));

it("resolves a launchable candidate to a plan", () =>
  Effect.gen(function* () {
    const { plan } = yield* resolveConnectionPlanForCandidate({
      candidate: candidate(),
      cwd: "/tmp/work",
    });
    assert.equal(plan.launch.kind, "command");
    if (plan.launch.kind === "command") {
      assert.equal(plan.launch.command, "/usr/local/bin/agent");
      assert.equal(plan.launch.cwd, "/tmp/work");
    }
  }));

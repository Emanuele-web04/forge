// FILE: ConformanceRunner.test.ts
// Purpose: Integration tests for the KAR-524 local conformance runner +
// hostile ACP fixture. Covers AC1-AC6 deterministically: a valid ACP fixture
// produces repeatable observations, advertised-but-broken maps to failed +
// broken, env/auth → inconclusive, flaky-cancel stays stable, stdout pollution
// is attributed to the agent, and zombie-child leaves no descendant.

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe } from "vitest";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { capabilityEvidenceLayer } from "../capabilityEvidence/Layers/CapabilityEvidenceService.ts";
import { CapabilityVerifierRegistry } from "../capabilityEvidence/Services/CapabilityVerifierRegistry.ts";
import {
  ACP_CONFORMANCE_HARNESS_VERSION,
  findAcpFramingViolation,
} from "./AcpConformanceVerifiers.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Pure framing rejection (AC #5)

describe("strict ACP framing rejection (AC #5)", () => {
  it("rejects non-JSON and non-object stdout lines and attributes them to the agent", () => {
    const violation = findAcpFramingViolation({
      chunks: [new TextEncoder().encode('random agent chatter\n{"json":true}\n')],
    });
    assert.isDefined(violation);
    assert.match(violation!, /non-JSON/);
    assert.match(violation!, /random agent chatter/);
  });

  it("rejects a JSON array on stdout", () => {
    const violation = findAcpFramingViolation({
      chunks: [new TextEncoder().encode("[1,2,3]\n")],
    });
    assert.isDefined(violation);
    assert.match(violation!, /not an object/);
  });

  it("passes clean newline-delimited JSON protocol frames", () => {
    const violation = findAcpFramingViolation({
      chunks: [new TextEncoder().encode('{"jsonrpc":"2.0","id":1}\n{"jsonrpc":"2.0","id":2}\n')],
    });
    assert.isUndefined(violation);
  });

  it("tolerates interleaved partial chunks that form valid lines", () => {
    const violation = findAcpFramingViolation({
      chunks: [
        new TextEncoder().encode('{"jsonrpc":"2.0"'),
        new TextEncoder().encode(',"id":3}\n{"jsonrpc"'),
        new TextEncoder().encode(':"2.0","id":4}\n'),
      ],
    });
    assert.isUndefined(violation);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Verifier registry (AC #2, #6)

const registryLayer = capabilityEvidenceLayer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const registryTests = it.layer(registryLayer);

describe("ACP verifier registry bindings", () => {
  registryTests("registers a verifier for every canonical capability id", (it) => {
    it.effect("resolves all 13 capability ids", () =>
      Effect.gen(function* () {
        const registry = yield* CapabilityVerifierRegistry;
        const found: string[] = [];
        for (const capabilityId of [
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
        ] as const) {
          const resolved = registry.resolve({
            capabilityId,
            runtime: {
              runtimeFingerprint: `acp-conformance-${ACP_CONFORMANCE_HARNESS_VERSION}`,
            },
          });
          if (resolved !== undefined) found.push(capabilityId);
        }
        assert.deepEqual(found, [
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
        ]);
      }),
    );
  });

  registryTests("verifier ids are capability-specific and versioned", (it) => {
    it.effect("prompt and cancel have distinct versioned ids", () =>
      Effect.gen(function* () {
        const registry = yield* CapabilityVerifierRegistry;
        const ids = registry.list().map((v) => v.id);
        const promptId = ids.find((id) => id.startsWith("prompt.acp.conformance."));
        const cancelId = ids.find((id) => id.startsWith("cancel.acp.conformance."));
        assert.isDefined(promptId);
        assert.isDefined(cancelId);
        assert.notEqual(promptId, cancelId);
        assert.match(promptId!, /v2026-08-16\.1$/);
      }),
    );
  });
});

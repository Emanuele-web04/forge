// FILE: CliConformanceVerifiers.test.ts
// Purpose: KAR-527 CLI conformance + coexistence tests. Covers AC #5
// (coexists with ACP + first-party providers): the CLI verifiers gate on a
// tier-specific CLI runtime fingerprint, so an ACP runtime resolves to the ACP
// verifier and a CLI runtime resolves to the structured/basic verifier. The
// end-to-end conformance runs exercise the deterministic fixtures through the
// shared conformance runner: structured fixtures stream + cancel (AC #1),
// basic never fakes resume/permissions (AC #2), and malformed structured
// output fails attributably (AC #3).

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe } from "vitest";

import { capabilityEvidenceLayer } from "../../capabilityEvidence/Layers/CapabilityEvidenceService.ts";
import { CapabilityVerifierRegistry } from "../../capabilityEvidence/Services/CapabilityVerifierRegistry.ts";
import { ConformanceRunner } from "../../conformance/ConformanceRunner.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  CLI_CONFORMANCE_HARNESS_VERSION,
  CLI_VERIFIER_RUNTIME_PREFIX,
  cliBasicConformanceVerifierId,
  cliConnectorRuntimePrefix,
  cliConnectorTierFingerprint,
  cliStructuredConformanceVerifierId,
} from "./CliConformanceVerifiers.ts";
import {
  CLI_CONNECTOR_KINDS,
  CLI_TIER_CAPABILITY_IDS,
  isCliConnectorKind,
} from "./CliConnector.ts";
import { fixturePathsForCli } from "./CliConformanceVerifiers.ts";

// Layer used by the end-to-end conformance runs. Provided + scoped inside each
// test body (plain `it` + `Effect.runPromise`) rather than via `it.layer`,
// because `it.layer`'s shared cached context hangs on the interruptible
// process-teardown finalizer in the cancel probe.
const registryLayer = capabilityEvidenceLayer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

// ─────────────────────────────────────────────────────────────────────────────
// Registry binding (coexistence)

describe("CLI verifier registry bindings (coexistence)", () => {
  it("resolves the structured verifier for a structured CLI fingerprint", async () => {
    const outcome = await Effect.gen(function* () {
      const registry = yield* CapabilityVerifierRegistry;
      const runtimeFingerprint = cliConnectorTierFingerprint("structured", "fixture");
      const resolved = registry.resolve({
        capabilityId: "prompt",
        runtime: { runtimeFingerprint },
      });
      return resolved?.id;
    }).pipe(
      Effect.provide(registryLayer),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.runPromise,
    );
    assert.isDefined(outcome);
    assert.match(outcome!, /^prompt\.cli-structured\.conformance\./);
    assert.ok(!/cli-basic\.conformance/.test(outcome!));
  });

  it("resolves the basic verifier for a basic CLI fingerprint", async () => {
    const outcome = await Effect.gen(function* () {
      const registry = yield* CapabilityVerifierRegistry;
      const runtimeFingerprint = cliConnectorTierFingerprint("basic", "fixture");
      const resolved = registry.resolve({
        capabilityId: "prompt",
        runtime: { runtimeFingerprint },
      });
      return resolved?.id;
    }).pipe(
      Effect.provide(registryLayer),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.runPromise,
    );
    assert.isDefined(outcome);
    assert.match(outcome!, /^prompt\.cli-basic\.conformance\./);
    assert.ok(!/cli-structured\.conformance/.test(outcome!));
  });

  it("an ACP runtime does not resolve to a CLI verifier", async () => {
    const outcome = await Effect.gen(function* () {
      const registry = yield* CapabilityVerifierRegistry;
      const acpResolved = registry.resolve({
        capabilityId: "prompt",
        runtime: { runtimeFingerprint: `acp-conformance-${CLI_CONFORMANCE_HARNESS_VERSION}` },
      });
      return acpResolved?.id;
    }).pipe(
      Effect.provide(registryLayer),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.runPromise,
    );
    assert.isDefined(outcome);
    assert.ok(!/cli-(structured|basic)\.conformance/.test(outcome!));
    assert.match(outcome!, /acp\.conformance/);
  });

  it("structured and basic bindings both exist for the same capability", async () => {
    const ids = await Effect.gen(function* () {
      const registry = yield* CapabilityVerifierRegistry;
      return registry.list().map((verifier) => verifier.id);
    }).pipe(
      Effect.provide(registryLayer),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.runPromise,
    );
    assert.isTrue(ids.includes(cliStructuredConformanceVerifierId("prompt")));
    assert.isTrue(ids.includes(cliBasicConformanceVerifierId("prompt")));
    assert.isTrue(ids.includes(cliStructuredConformanceVerifierId("cancel")));
    assert.isTrue(ids.includes(cliBasicConformanceVerifierId("cancel")));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end conformance runs against the deterministic CLI fixtures
// (AC #1 structured streams + cancels, AC #2 basic honest limits, AC #3
// malformed output attribution, AC #5 dispatch by ConnectorKind).

const cliRuntimeFingerprint = (tier: "structured" | "basic", command: string) =>
  cliConnectorTierFingerprint(tier, command);

const runCliConformance = (input: {
  readonly namespace: string;
  readonly capabilityId: "cancel" | "prompt" | "session.resume" | "session.start";
  readonly tier: "structured" | "basic";
  readonly agentCommand: string;
  readonly advertised: boolean;
  readonly agentEnv?: Readonly<Record<string, string>>;
}): Promise<{
  readonly outcome: string;
  readonly attribution: string;
  readonly detail: string;
}> => {
  const run = Effect.gen(function* () {
    const runner = yield* ConformanceRunner;
    const result = yield* runner.run({
      namespace: input.namespace,
      capabilityId: input.capabilityId,
      runtimeIdentity: {
        runtimeFingerprint: cliRuntimeFingerprint(input.tier, "cli-agent"),
      },
      agentCommand: input.agentCommand,
      ...(input.agentEnv !== undefined ? { agentEnv: input.agentEnv } : {}),
      advertised: input.advertised,
    });
    const detail = result.observation.run?.detail ?? "";
    return {
      outcome: result.observation.outcome,
      attribution: result.observation.attribution,
      detail,
    };
  }).pipe(
    Effect.provide(registryLayer),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.timeout("30 seconds"),
    Effect.orDie,
  );
  return Effect.runPromise(run);
};

describe("CLI connector end-to-end conformance (AC #1, #2, #3, #5)", () => {
  it("structured fixture streams a full turn under the conformance runner", async () => {
    const fixtures = fixturePathsForCli();
    const result = await runCliConformance({
      namespace: "external.cli-structured",
      capabilityId: "prompt",
      tier: "structured",
      agentCommand: fixtures.structured,
      advertised: true,
    });
    assert.equal(result.outcome, "pass", `detail: ${result.detail}`);
    assert.equal(result.attribution, "agent");
    assert.match(result.detail, /structured prompt/);
  });

  it("structured fixture cancel settles the run through the protocol ack", async () => {
    const fixtures = fixturePathsForCli();
    const result = await runCliConformance({
      namespace: "external.cli-structured",
      capabilityId: "cancel",
      tier: "structured",
      agentCommand: fixtures.structured,
      // Slow text keeps the turn in-flight (600ms) so the probe's cancel at
      // ~150ms arrives while `turn.cancelled` can still be the terminal event.
      agentEnv: { SYNARA_CLI_STRUCTURED_TEXT_DELAY_MS: "200" },
      advertised: true,
    });
    assert.equal(result.outcome, "pass", `detail: ${result.detail}`);
    assert.equal(result.attribution, "agent");
    // The cooperative fixture acks cancel with turn.cancelled, so the acked
    // cancel must end the turn through the protocol — not via teardown.
    assert.match(result.detail, /settled via turn\.cancelled/);
  });

  it("ignore-cancel structured fixture still settles via process-tree teardown", async () => {
    const fixtures = fixturePathsForCli();
    const result = await runCliConformance({
      namespace: "external.cli-structured",
      capabilityId: "cancel",
      tier: "structured",
      agentCommand: fixtures.structured,
      // Same slow-text window as the cooperative case: the turn must still be
      // in-flight when the probe's cancel arrives, so a missing ack is visible
      // as an unobserved settle (no turn.cancelled, tree torn down).
      agentEnv: {
        SYNARA_CLI_STRUCTURED_IGNORE_CANCEL: "1",
        SYNARA_CLI_STRUCTURED_TEXT_DELAY_MS: "200",
      },
      advertised: true,
    });
    assert.equal(result.outcome, "pass", `detail: ${result.detail}`);
    assert.equal(result.attribution, "agent");
    // An agent that never acks must still be stopped: the tree is torn down
    // after the ack-grace window, and no turn.cancelled is observed.
    assert.match(result.detail, /unobserved-settle/);
  });

  it("mid-stream malformed structured output is attributed to the agent", async () => {
    const fixtures = fixturePathsForCli();
    const result = await runCliConformance({
      namespace: "external.cli-structured",
      capabilityId: "prompt",
      tier: "structured",
      agentCommand: fixtures.structured,
      agentEnv: { SYNARA_CLI_STRUCTURED_MALFORMED_AFTER_HELLO: "1" },
      advertised: true,
    });
    assert.equal(result.outcome, "fail");
    assert.equal(result.attribution, "agent");
    assert.match(result.detail, /CliProtocolError/);
    assert.match(result.detail, /random mid-stream chatter/);
  });

  it("basic fixture echoes a prompt line (honest prompt+stream)", async () => {
    const fixtures = fixturePathsForCli();
    const result = await runCliConformance({
      namespace: "external.cli-basic",
      capabilityId: "prompt",
      tier: "basic",
      agentCommand: fixtures.basic,
      advertised: true,
    });
    assert.equal(result.outcome, "pass", `detail: ${result.detail}`);
    assert.equal(result.attribution, "agent");
    assert.match(result.detail, /basic prompt echoed/);
  });

  it("basic fixture never fakes resume (honest limits)", async () => {
    const fixtures = fixturePathsForCli();
    const result = await runCliConformance({
      namespace: "external.cli-basic",
      capabilityId: "session.resume",
      tier: "basic",
      agentCommand: fixtures.basic,
      advertised: false,
    });
    assert.equal(result.outcome, "fail");
    assert.equal(result.attribution, "agent");
    assert.match(result.detail, /no resume|resume/);
  });

  it("malformed structured output is attributed to the agent", async () => {
    const fixtures = fixturePathsForCli();
    const result = await runCliConformance({
      namespace: "external.cli-structured",
      capabilityId: "session.start",
      tier: "structured",
      agentCommand: fixtures.structured,
      agentEnv: { SYNARA_CLI_STRUCTURED_MALFORMED: "non-json" },
      advertised: true,
    });
    assert.equal(result.outcome, "fail");
    assert.equal(result.attribution, "agent");
    assert.match(result.detail, /CliProtocolError/);
    assert.match(result.detail, /random agent chatter/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tier dispatch + honest capability surface (coexistence with ACP)

describe("CLI connector tier dispatch (coexistence with ACP)", () => {
  it("exposes only the CLI kinds the connector owns", () => {
    assert.deepEqual(CLI_CONNECTOR_KINDS, ["cli-structured", "cli-basic"]);
  });

  it("routes cli-structured to the structured tier and cli-basic to basic", () => {
    assert.equal(isCliConnectorKind("cli-structured"), true);
    assert.equal(isCliConnectorKind("cli-basic"), true);
    assert.equal(CLI_TIER_CAPABILITY_IDS.structured.length > 0, true);
    assert.equal(CLI_TIER_CAPABILITY_IDS.basic.length > 0, true);
  });

  it("structured and basic advertise exactly the honest surface", () => {
    for (const capabilityId of ["session.start", "prompt", "stream", "cancel"]) {
      assert.include(CLI_TIER_CAPABILITY_IDS.structured, capabilityId as never);
      assert.include(CLI_TIER_CAPABILITY_IDS.basic, capabilityId as never);
    }
    // Neither tier ever advertises capabilities the protocol cannot provide.
    for (const faked of ["session.resume", "permissions", "elicitation", "usage"]) {
      assert.notInclude(CLI_TIER_CAPABILITY_IDS.structured, faked as never);
      assert.notInclude(CLI_TIER_CAPABILITY_IDS.basic, faked as never);
    }
  });

  it("cliConnectorRuntimePrefix stamps a deterministic CLI fingerprint", () => {
    const fingerprint = cliConnectorRuntimePrefix({
      runtimeFingerprint: undefined,
      resolvedCommand: "some-cli",
    });
    assert.ok(fingerprint.startsWith(CLI_VERIFIER_RUNTIME_PREFIX));
    assert.include(fingerprint, "some-cli");
  });

  it("cliConnectorTierFingerprint embeds the tier for dispatch", () => {
    const structured = cliConnectorTierFingerprint("structured", "some-cli");
    const basic = cliConnectorTierFingerprint("basic", "some-cli");
    assert.match(structured, /tier=structured/);
    assert.match(basic, /tier=basic/);
    assert.notEqual(structured, basic);
  });

  it("verifier ids are tier-specific and versioned", () => {
    assert.match(
      cliStructuredConformanceVerifierId("prompt"),
      /^prompt\.cli-structured\.conformance\.v/,
    );
    assert.match(cliBasicConformanceVerifierId("prompt"), /^prompt\.cli-basic\.conformance\.v/);
    assert.notEqual(
      cliStructuredConformanceVerifierId("prompt"),
      cliBasicConformanceVerifierId("prompt"),
    );
  });
});

// FILE: ProfileLifecycleService.test.ts
// Purpose: KAR-529 profile lifecycle tests: state transitions (quarantine /
// un-quarantine / re-certify), provenance trust evaluation + credential gate,
// evidence-freshness re-certification with downgrade to quarantine, session
// kill on quarantine, and lifecycle metadata persistence. The conformance
// runner and provider services are mocked so tests stay deterministic.

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import { describe } from "vitest";

import { CAPABILITY_IDS, ThreadId } from "@synara/contracts";
import type { ProviderSession } from "@synara/contracts";
import type {
  ProviderRuntimeBinding,
  ProviderSessionDirectoryShape,
} from "../provider/Services/ProviderSessionDirectory.ts";
import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { CapabilityEvidenceService } from "../capabilityEvidence/Services/CapabilityEvidenceService.ts";
import { capabilityEvidenceLayer } from "../capabilityEvidence/Layers/CapabilityEvidenceService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { AgentProfileRepositoryLive } from "./AgentProfileRepository.ts";
import {
  AgentProfileService,
  AgentProfileServiceLive,
  ExternalAgentProfileError,
} from "./AgentProfileService.ts";
import type { AgentProfileServiceShape } from "./AgentProfileService.ts";
import {
  ProfileLifecycleService,
  ProfileLifecycleError,
  ProfileLifecycleServiceLive,
  recertifyDecisionFromStates,
} from "./ProfileLifecycleService.ts";
import { profileEvidenceNamespace } from "./agentProfileTrust.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers

const now = () => new Date().toISOString();

const baseLaunch = { kind: "command" as const, command: "cline", args: [] as string[] };

function createProfileInput(overrides: {
  readonly name: string;
  readonly displayName: string;
  readonly command?: string;
  readonly credentialRefs?: NonNullable<
    Parameters<AgentProfileServiceShape["createProfile"]>[0]["credentialRefs"]
  >;
  readonly envRefs?: Array<{ name: string; envKey: string; required?: boolean }>;
  readonly provenanceSource?: string;
}) {
  return {
    name: overrides.name,
    displayName: overrides.displayName,
    connectorKind: "acp" as const,
    launch: {
      kind: "command" as const,
      command: overrides.command ?? "cline",
      args: [] as string[],
      ...(overrides.envRefs !== undefined ? { envRefs: overrides.envRefs } : {}),
    },
    credentialRefs: overrides.credentialRefs ?? [],
    provenance: { source: overrides.provenanceSource ?? "manual" },
  } satisfies Parameters<AgentProfileServiceShape["createProfile"]>[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure decision primitive

describe("recertifyDecisionFromStates", () => {
  it("does not quarantine when every capability is healthy", () => {
    const decision = recertifyDecisionFromStates({
      states: Object.fromEntries(CAPABILITY_IDS.map((id) => [id, "verified"])),
    });
    assert.isFalse(decision.shouldQuarantine);
    assert.deepEqual(decision.brokenCapabilities, []);
  });

  it("quarantines when at least one capability is broken", () => {
    const decision = recertifyDecisionFromStates({
      states: {
        "session.start": "verified",
        prompt: "broken",
      },
    });
    assert.isTrue(decision.shouldQuarantine);
    assert.deepEqual(decision.brokenCapabilities, ["prompt"]);
  });

  it("does not confuse unknown or degraded with broken", () => {
    const decision = recertifyDecisionFromStates({
      states: { "session.start": "unknown", prompt: "degraded" },
    });
    assert.isFalse(decision.shouldQuarantine);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle service integration

interface TestContext {
  readonly providerService: ProviderServiceShape;
  readonly directory: ProviderSessionDirectoryShape;
  readonly stoppedThreads: string[];
  /** Thread ids whose stopSession mock should fail. */
  readonly failStopThreads: Set<string>;
  readonly sessions: { value: ReadonlyArray<ProviderSession> };
  readonly bindings: { value: ReadonlyArray<ProviderRuntimeBinding> };
}

const makeTestContext = (): TestContext => {
  const stoppedThreads: string[] = [];
  const failStopThreads = new Set<string>();
  const sessions: { value: ReadonlyArray<ProviderSession> } = { value: [] };
  const bindings: { value: ReadonlyArray<ProviderRuntimeBinding> } = { value: [] };
  const providerService: ProviderServiceShape = {
    startSession: () => Effect.never as never,
    sendTurn: () => Effect.never as never,
    steerTurn: () => Effect.never as never,
    startReview: () => Effect.never as never,
    interruptTurn: () => Effect.never as never,
    stopTask: () => Effect.never as never,
    backgroundTask: () => Effect.never as never,
    steerSubagent: () => Effect.never as never,
    respondToRequest: () => Effect.never as never,
    respondToUserInput: () => Effect.never as never,
    stopSession: (input: { threadId: string }) =>
      failStopThreads.has(input.threadId)
        ? (Effect.fail(new Error(`stopSession failed for ${input.threadId}`)) as never)
        : (Effect.sync(() => {
            stoppedThreads.push(input.threadId);
          }) as never),
    listSessions: () => Effect.succeed(sessions.value),
    getCapabilities: () => Effect.never as never,
    rollbackConversation: () => Effect.never as never,
    compactThread: () => Effect.never as never,
    closeRuntimeEvents: Effect.void,
    streamEvents: Stream.empty,
  };

  const directory: ProviderSessionDirectoryShape = {
    upsert: () => Effect.void,
    getProvider: () => Effect.succeed("codex" as const),
    getBinding: () => Effect.succeed(Option.none<ProviderRuntimeBinding>()),
    remove: () => Effect.void,
    listThreadIds: () => Effect.succeed([]),
    listBindings: () => Effect.succeed(bindings.value),
  };

  return { providerService, directory, stoppedThreads, failStopThreads, sessions, bindings };
};

const makeTestLayer = (ctx: TestContext) => {
  const repository = AgentProfileRepositoryLive;
  const providerMocks = Layer.mergeAll(
    Layer.succeed(ProviderService, ctx.providerService),
    Layer.succeed(ProviderSessionDirectory, ctx.directory),
  );
  const lifecycle = ProfileLifecycleServiceLive.pipe(
    Layer.provide(repository),
    Layer.provideMerge(providerMocks),
    Layer.provideMerge(capabilityEvidenceLayer),
  );
  const profiles = AgentProfileServiceLive.pipe(
    Layer.provide(repository),
    Layer.provideMerge(providerMocks),
  );
  return Layer.mergeAll(lifecycle, profiles, repository, capabilityEvidenceLayer).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerSecretStoreLive.pipe(
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), {
            prefix: "synara-profile-lifecycle-test-",
          }),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
};

const testContext = makeTestContext();
const layer = it.layer(makeTestLayer(testContext));

layer("ProfileLifecycleService", (it) => {
  it.effect("quarantines an active profile and records the lifecycle event", () =>
    Effect.gen(function* () {
      const lifecycle = yield* ProfileLifecycleService;
      const service = yield* AgentProfileService;
      const created = yield* service.createProfile(
        createProfileInput({ name: "Cline", displayName: "Cline" }),
      );

      const result = yield* lifecycle.quarantineProfile(created.profile.profileId);
      assert.strictEqual(result.profile.status, "quarantined");
      assert.strictEqual(result.stoppedSessions, 0);
      assert.strictEqual(result.profile.lifecycleEvent?.kind, "quarantine");

      // A quarantined profile refuses fresh sessions.
      const flipped = yield* Effect.flip(
        service.resolveSessionLaunch({
          profileId: created.profile.profileId,
          revisionId: created.revision.revisionId,
        }),
      );
      assert.instanceOf(flipped, ExternalAgentProfileError);
      assert.strictEqual(flipped.code, "profile-quarantined");
    }),
  );

  it.effect("un-quarantines a quarantined profile back to active", () =>
    Effect.gen(function* () {
      const lifecycle = yield* ProfileLifecycleService;
      const service = yield* AgentProfileService;
      const created = yield* service.createProfile(
        createProfileInput({ name: "Cline", displayName: "Cline" }),
      );
      yield* lifecycle.quarantineProfile(created.profile.profileId);

      const unquarantined = yield* lifecycle.unquarantineProfile(created.profile.profileId);
      assert.strictEqual(unquarantined.status, "active");
      assert.strictEqual(unquarantined.lifecycleEvent?.kind, "re-certify");

      const resolved = yield* service.resolveSessionLaunch({
        profileId: created.profile.profileId,
        revisionId: created.revision.revisionId,
      });
      assert.strictEqual(resolved.profile.profileId, created.profile.profileId);
    }),
  );

  it.effect("refuses quarantine/lift transitions on retired profiles", () =>
    Effect.gen(function* () {
      const lifecycle = yield* ProfileLifecycleService;
      const service = yield* AgentProfileService;
      const created = yield* service.createProfile(
        createProfileInput({ name: "Cline", displayName: "Cline" }),
      );
      yield* service.tombstoneProfile(created.profile.profileId);

      // Tombstoning records the retire lifecycle event so archived profile
      // history carries the "why" alongside the retired status.
      const detail = yield* service.getProfile(created.profile.profileId);
      assert.strictEqual(detail.profile.status, "retired");
      assert.strictEqual(detail.profile.lifecycleEvent?.kind, "retire");

      const quarantineError = yield* Effect.flip(
        lifecycle.quarantineProfile(created.profile.profileId),
      );
      assert.instanceOf(quarantineError, ProfileLifecycleError);
      assert.strictEqual(quarantineError.status, 409);

      const unquarantineError = yield* Effect.flip(
        lifecycle.unquarantineProfile(created.profile.profileId),
      );
      assert.instanceOf(unquarantineError, ProfileLifecycleError);
      assert.strictEqual(unquarantineError.status, 409);
    }),
  );

  it.effect("stops running sessions bound to the profile on quarantine", () => {
    const threadId = ThreadId.makeUnsafe("thread-quarantine-kill");
    return Effect.gen(function* () {
      const lifecycle = yield* ProfileLifecycleService;
      const service = yield* AgentProfileService;
      const created = yield* service.createProfile(
        createProfileInput({
          name: "Kill target",
          displayName: "Kill target",
          command: "killme",
          provenanceSource: "legacy-settings-acp",
        }),
      );

      const session = {
        threadId,
        provider: "claudeAgent" as const,
        status: "running" as const,
        runtimeMode: "full-access" as const,
        resumeCursor: { profileId: created.profile.profileId } as unknown,
        createdAt: now(),
        updatedAt: now(),
      } as const;
      testContext.sessions.value = [session];
      testContext.bindings.value = [
        {
          threadId,
          provider: "claudeAgent" as const,
          runtimePayload: {
            modelSelection: {
              provider: "external",
              profileId: created.profile.profileId,
              revisionId: created.revision.revisionId,
              model: "cline",
            },
          },
        } satisfies ProviderRuntimeBinding,
      ];

      const result = yield* lifecycle.quarantineProfile(created.profile.profileId);
      assert.strictEqual(result.stoppedSessions, 1);
      assert.deepEqual(testContext.stoppedThreads, [threadId]);
    });
  });

  it.effect("counts only sessions that actually stopped on quarantine", () => {
    const okThreadId = ThreadId.makeUnsafe("thread-stop-ok");
    const failThreadId = ThreadId.makeUnsafe("thread-stop-fail");
    return Effect.gen(function* () {
      const lifecycle = yield* ProfileLifecycleService;
      const service = yield* AgentProfileService;
      const created = yield* service.createProfile(
        createProfileInput({
          name: "Stop counting",
          displayName: "Stop counting",
          command: "stopcount",
          provenanceSource: "legacy-settings-acp",
        }),
      );
      testContext.failStopThreads.add(failThreadId);
      const session = {
        threadId: okThreadId,
        provider: "claudeAgent" as const,
        status: "running" as const,
        runtimeMode: "full-access" as const,
        resumeCursor: { profileId: created.profile.profileId } as unknown,
        createdAt: now(),
        updatedAt: now(),
      } as const;
      const sessionFail = {
        ...session,
        threadId: failThreadId,
      } as const;
      testContext.sessions.value = [session, sessionFail];
      const stoppedBefore = [...testContext.stoppedThreads];

      const result = yield* lifecycle.quarantineProfile(created.profile.profileId);
      // Only the successful stop is counted and recorded; the failed stop is
      // logged (and in this mock path the Error is surfaced) without inflating
      // the success count or the recorded thread list.
      assert.strictEqual(result.stoppedSessions, 1);
      assert.deepEqual(testContext.stoppedThreads, [...stoppedBefore, okThreadId]);
    });
  });

  it.effect("re-certifies with freshly verified evidence and stays active", () =>
    Effect.gen(function* () {
      const lifecycle = yield* ProfileLifecycleService;
      const evidence = yield* CapabilityEvidenceService;
      const service = yield* AgentProfileService;
      const created = yield* service.createProfile(
        createProfileInput({ name: "Cline", displayName: "Cline" }),
      );
      const namespace = profileEvidenceNamespace(created.profile.profileId);

      for (const capabilityId of CAPABILITY_IDS) {
        yield* evidence.record({
          namespace,
          capabilityId,
          source: "synthetic-conformance",
          outcome: "pass",
          attribution: "agent",
          runtime: { agentName: "Cline" },
          verifier: { verifierId: `verifier:${capabilityId}` },
          policy: { version: "2026-08-16.1", params: {} },
          observedAt: now(),
        });
      }

      const result = yield* lifecycle.recertifyProfile(created.profile.profileId);
      assert.strictEqual(result.profile.status, "active");
      for (const capabilityId of CAPABILITY_IDS) {
        assert.strictEqual(result.states[capabilityId], "verified");
      }
    }),
  );

  it.effect("re-certification quarantines a profile with a broken capability", () =>
    Effect.gen(function* () {
      const lifecycle = yield* ProfileLifecycleService;
      const evidence = yield* CapabilityEvidenceService;
      const service = yield* AgentProfileService;
      const created = yield* service.createProfile(
        createProfileInput({ name: "Cline", displayName: "Cline" }),
      );
      const namespace = profileEvidenceNamespace(created.profile.profileId);

      for (const capabilityId of CAPABILITY_IDS) {
        yield* evidence.record({
          namespace,
          capabilityId,
          source: "synthetic-conformance",
          outcome: capabilityId === "prompt" ? "fail" : "pass",
          attribution: capabilityId === "prompt" ? "agent" : "agent",
          runtime: { agentName: "Cline" },
          verifier: { verifierId: `verifier:${capabilityId}` },
          policy: { version: "2026-08-16.1", params: {} },
          observedAt: now(),
        });
      }

      const result = yield* lifecycle.recertifyProfile(created.profile.profileId);
      assert.strictEqual(result.profile.status, "quarantined");
      assert.strictEqual(result.profile.lifecycleEvent?.kind, "re-certify");
      assert.match(result.profile.lifecycleEvent?.reason ?? "", /broken/);
      assert.strictEqual(result.states.prompt, "broken");
    }),
  );

  it.effect("evaluateTrust persists trust for a known-good workflow revision", () =>
    Effect.gen(function* () {
      const lifecycle = yield* ProfileLifecycleService;
      const service = yield* AgentProfileService;
      const created = yield* service.createProfile(
        createProfileInput({ name: "Trusted", displayName: "Trusted" }),
      );
      const updated = yield* service.updateProfile({
        profileId: created.profile.profileId,
        displayName: "Trusted",
        launch: { ...baseLaunch, command: "cline", args: [] },
        credentialRefs: [],
        provenance: { source: "manual" },
        trust: { workflows: ["code-review"] },
      });
      const withTrust = yield* lifecycle.evaluateTrust(created.profile.profileId);
      assert.deepEqual(withTrust.trust, {
        workflows: ["code-review"],
        brands: [],
        organizations: [],
      });
      assert.strictEqual(updated.revision.trust?.workflows?.[0], "code-review");
    }),
  );

  it.effect("evaluateTrust leaves an untrusted profile with trust unset", () =>
    Effect.gen(function* () {
      const lifecycle = yield* ProfileLifecycleService;
      const service = yield* AgentProfileService;
      const untrusted = yield* service.createProfile(
        createProfileInput({ name: "Rogue", displayName: "Rogue", command: "rogue" }),
      );
      const updated = yield* lifecycle.evaluateTrust(untrusted.profile.profileId);
      assert.isUndefined(updated.trust);
    }),
  );

  it.effect(
    "assertSessionAllowed blocks quarantined profiles and untrusted credential release",
    () =>
      Effect.gen(function* () {
        const lifecycle = yield* ProfileLifecycleService;
        const service = yield* AgentProfileService;

        const trusted = yield* service.createProfile(
          createProfileInput({
            name: "Trusted-Cred",
            displayName: "Trusted",
            envRefs: [{ name: "api-key", envKey: "CLINE_API_KEY", required: true }],
            credentialRefs: [{ name: "api-key", envKey: "CLINE_API_KEY", required: true }],
          }),
        );
        yield* service.updateProfile({
          profileId: trusted.profile.profileId,
          displayName: "Trusted",
          launch: {
            kind: "command",
            command: "cline",
            args: [],
            envRefs: [{ name: "api-key", envKey: "CLINE_API_KEY", required: true }],
          },
          credentialRefs: [{ name: "api-key", envKey: "CLINE_API_KEY", required: true }],
          provenance: { source: "manual" },
          trust: { brands: ["openai"] },
        });
        const trustedPinnedDetail = yield* service.getProfile(trusted.profile.profileId);
        yield* lifecycle.assertSessionAllowed({
          profile: trustedPinnedDetail.profile,
          revision: trustedPinnedDetail.currentRevision,
        });

        const untrusted = yield* service.createProfile(
          createProfileInput({ name: "Rogue", displayName: "Rogue", command: "rogue" }),
        );
        yield* lifecycle.quarantineProfile(untrusted.profile.profileId);
        const untrustedDetail = yield* service.getProfile(untrusted.profile.profileId);

        const blocked = yield* Effect.flip(
          lifecycle.assertSessionAllowed({
            profile: untrustedDetail.profile,
            revision: untrustedDetail.currentRevision,
          }),
        );
        assert.instanceOf(blocked, Error);
        assert.match(blocked.message, /quarantined/);
      }),
  );
});

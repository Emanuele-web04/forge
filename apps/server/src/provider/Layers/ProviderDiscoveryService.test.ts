// FILE: ProviderDiscoveryService.test.ts
// Purpose: Verifies the discovery service merges provider-native skills with the
//          unified Synara catalog, filters user-disabled skills, and reports
//          skill discovery as supported for every provider.
// Layer: Server provider tests

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type {
  ProviderComposerCapabilities,
  ProviderKind,
  ProviderListAgentsResult,
  ProviderListCommandsResult,
  ProviderListModelsResult,
  ProviderListSkillsResult,
} from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deriveServerPaths,
  resolveDefaultChatWorkspaceRoot,
  resolveDefaultStudioWorkspaceRoot,
  ServerConfig,
  type ServerConfigShape,
} from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderDiscoveryService } from "../Services/ProviderDiscoveryService.ts";
import { clearSkillsCatalogCacheForTests } from "../skillsCatalog.ts";
import { ProviderDiscoveryServiceLive } from "./ProviderDiscoveryService.ts";

let root: string;
let homeDir: string;
let baseDir: string;
let cwd: string;

async function writeSkill(skillDir: string, name: string): Promise<void> {
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} description\n---\n\n# ${name}\n`,
  );
}

const makeConfigLayer = () =>
  Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const derived = yield* deriveServerPaths(baseDir, undefined);
      return {
        mode: "web",
        port: 0,
        host: undefined,
        cwd,
        homeDir,
        chatWorkspaceRoot: resolveDefaultChatWorkspaceRoot({ homeDir }),
        studioWorkspaceRoot: resolveDefaultStudioWorkspaceRoot({ homeDir }),
        baseDir,
        ...derived,
        staticDir: undefined,
        devUrl: undefined,
        publicUrl: undefined,
        allowInsecureRemote: false,
        noBrowser: true,
        authToken: undefined,
        autoBootstrapProjectFromCwd: false,
        logProviderEvents: false,
        logWebSocketEvents: false,
      } satisfies ServerConfigShape;
    }),
  );

const makeRegistryLayer = (adapter: Partial<ProviderAdapterShape<ProviderAdapterError>>) =>
  Layer.succeed(ProviderAdapterRegistry, {
    getByProvider: () => Effect.succeed(adapter as ProviderAdapterShape<ProviderAdapterError>),
    listProviders: () => Effect.succeed([]),
  });

const runListSkills = (input: {
  adapter: Partial<ProviderAdapterShape<ProviderAdapterError>>;
  disabled?: string[];
  provider: ProviderKind;
}) => {
  const baseLayer = Layer.mergeAll(
    makeConfigLayer(),
    ServerSettingsService.layerTest({ skills: { disabled: input.disabled ?? [] } }),
    makeRegistryLayer(input.adapter),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const testLayer = ProviderDiscoveryServiceLive.pipe(Layer.provideMerge(baseLayer));
  const program = Effect.gen(function* () {
    const discovery = yield* ProviderDiscoveryService;
    return yield* discovery.listSkills({ provider: input.provider, cwd });
  }).pipe(Effect.provide(testLayer));
  return Effect.runPromise(
    program as unknown as Effect.Effect<ProviderListSkillsResult, never, never>,
  );
};

const runListModels = (input: {
  adapter: Partial<ProviderAdapterShape<ProviderAdapterError>>;
  enabled: boolean;
}) => {
  const baseLayer = Layer.mergeAll(
    makeConfigLayer(),
    ServerSettingsService.layerTest({
      providers: {
        cursor: {
          enabled: input.enabled,
        },
      },
    }),
    makeRegistryLayer(input.adapter),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const testLayer = ProviderDiscoveryServiceLive.pipe(Layer.provideMerge(baseLayer));
  const program = Effect.gen(function* () {
    const discovery = yield* ProviderDiscoveryService;
    return yield* discovery.listModels({ provider: "cursor" });
  }).pipe(Effect.provide(testLayer));
  return Effect.runPromise(
    program as unknown as Effect.Effect<ProviderListModelsResult, never, never>,
  );
};

beforeEach(async () => {
  clearSkillsCatalogCacheForTests();
  root = mkdtempSync(path.join(os.tmpdir(), "discovery-service-"));
  homeDir = path.join(root, "home");
  baseDir = path.join(homeDir, ".synara");
  cwd = path.join(root, "repo");
  await mkdir(cwd, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ProviderDiscoveryService.listSkills", () => {
  it("serves the unified catalog for providers without native skill discovery", async () => {
    await writeSkill(path.join(baseDir, "skills", "portable"), "portable");

    const result = await runListSkills({ adapter: {}, provider: "antigravity" });

    expect(result.skills.map((skill) => skill.name)).toEqual(["portable"]);
  });

  it("prefers provider-native entries and appends catalog-only skills", async () => {
    await writeSkill(path.join(baseDir, "skills", "shared"), "shared");
    await writeSkill(path.join(baseDir, "skills", "portable"), "portable");

    const nativeShared = {
      name: "shared",
      path: path.join(homeDir, ".codex", "skills", "shared", "SKILL.md"),
      enabled: true,
      scope: "user",
    };
    const result = await runListSkills({
      adapter: {
        listSkills: () =>
          Effect.succeed({ skills: [nativeShared], source: "codex-app-server", cached: false }),
      },
      provider: "codex",
    });

    const shared = result.skills.find((skill) => skill.name === "shared");
    expect(shared?.path).toBe(nativeShared.path);
    expect(result.skills.some((skill) => skill.name === "portable")).toBe(true);
  });

  it("filters user-disabled skills from merged results", async () => {
    await writeSkill(path.join(baseDir, "skills", "portable"), "portable");
    await writeSkill(path.join(baseDir, "skills", "muted"), "muted");

    const result = await runListSkills({
      adapter: {},
      disabled: ["Muted"],
      provider: "opencode",
    });

    expect(result.skills.map((skill) => skill.name)).toEqual(["portable"]);
  });

  it("falls back to the catalog when native discovery fails", async () => {
    await writeSkill(path.join(baseDir, "skills", "portable"), "portable");

    const result = await runListSkills({
      adapter: {
        listSkills: () =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: "codex",
              method: "skills/list",
              detail: "codex binary missing",
            }),
          ),
      },
      provider: "codex",
    });

    expect(result.skills.map((skill) => skill.name)).toEqual(["portable"]);
  });
});

describe("ProviderDiscoveryService.getComposerCapabilities", () => {
  it("reports skill discovery as supported even when the adapter declines it", async () => {
    const baseLayer = Layer.mergeAll(
      makeConfigLayer(),
      ServerSettingsService.layerTest(),
      makeRegistryLayer({}),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    const testLayer = ProviderDiscoveryServiceLive.pipe(Layer.provideMerge(baseLayer));

    const program = Effect.gen(function* () {
      const discovery = yield* ProviderDiscoveryService;
      return yield* discovery.getComposerCapabilities({ provider: "grok" });
    }).pipe(Effect.provide(testLayer));
    const capabilities = await Effect.runPromise(
      program as unknown as Effect.Effect<ProviderComposerCapabilities, never, never>,
    );

    expect(capabilities.supportsSkillDiscovery).toBe(true);
    expect(capabilities.supportsSkillMentions).toBe(true);
  });
});

describe("ProviderDiscoveryService.listModels", () => {
  it("skips OpenCode agent and command discovery until re-enabled", async () => {
    const adapterCalls: string[] = [];
    const adapter: Partial<ProviderAdapterShape<ProviderAdapterError>> = {
      listAgents: () => {
        adapterCalls.push("agents");
        return Effect.succeed({ agents: [], source: "opencode", cached: false });
      },
      listCommands: () => {
        adapterCalls.push("commands");
        return Effect.succeed({ commands: [], source: "opencode", cached: false });
      },
    };
    const baseLayer = Layer.mergeAll(
      makeConfigLayer(),
      ServerSettingsService.layerTest({
        providers: { opencode: { enabled: false } },
      }),
      makeRegistryLayer(adapter),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    const testLayer = ProviderDiscoveryServiceLive.pipe(Layer.provideMerge(baseLayer));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const discovery = yield* ProviderDiscoveryService;
        const settings = yield* ServerSettingsService;
        const disabledAgents = yield* discovery.listAgents({ provider: "opencode", cwd });
        const disabledCommands = yield* discovery.listCommands({ provider: "opencode", cwd });

        yield* settings.updateSettings({ providers: { opencode: { enabled: true } } });
        const enabledAgents = yield* discovery.listAgents({ provider: "opencode", cwd });
        const enabledCommands = yield* discovery.listCommands({ provider: "opencode", cwd });

        return {
          disabledAgents,
          disabledCommands,
          enabledAgents,
          enabledCommands,
        };
      }).pipe(Effect.provide(testLayer)) as Effect.Effect<
        {
          disabledAgents: ProviderListAgentsResult;
          disabledCommands: ProviderListCommandsResult;
          enabledAgents: ProviderListAgentsResult;
          enabledCommands: ProviderListCommandsResult;
        },
        never,
        never
      >,
    );

    expect(result.disabledAgents).toMatchObject({ agents: [], source: "disabled" });
    expect(result.disabledCommands).toMatchObject({ commands: [], source: "disabled" });
    expect(result.enabledAgents.source).toBe("opencode");
    expect(result.enabledCommands.source).toBe("opencode");
    expect(adapterCalls).toEqual(["agents", "commands"]);
  });

  it("does not invoke the adapter for a disabled provider", async () => {
    let adapterCalls = 0;
    const result = await runListModels({
      adapter: {
        listModels: () => {
          adapterCalls += 1;
          return Effect.succeed({
            models: [{ slug: "cursor-model", name: "Cursor Model" }],
            source: "cursor.cli",
            cached: false,
          });
        },
      },
      enabled: false,
    });

    expect(result).toEqual({
      models: [],
      source: "disabled",
      cached: false,
    });
    expect(adapterCalls).toBe(0);
  });

  it("dispatches model discovery for an enabled provider", async () => {
    let adapterCalls = 0;
    const result = await runListModels({
      adapter: {
        listModels: () => {
          adapterCalls += 1;
          return Effect.succeed({
            models: [{ slug: "cursor-model", name: "Cursor Model" }],
            source: "cursor.cli",
            cached: false,
          });
        },
      },
      enabled: true,
    });

    expect(result.models).toEqual([{ slug: "cursor-model", name: "Cursor Model" }]);
    expect(adapterCalls).toBe(1);
  });

  it("omits malformed model descriptors while preserving valid entries", async () => {
    const result = await runListModels({
      adapter: {
        listModels: () =>
          Effect.succeed({
            models: [
              { slug: "valid-model", name: "Valid Model" },
              { slug: "invalid-model", name: " " },
            ],
            source: "cursor.cli",
            cached: false,
          } as ProviderListModelsResult),
      },
      enabled: true,
    });

    expect(result).toEqual({
      models: [{ slug: "valid-model", name: "Valid Model" }],
      source: "cursor.cli",
      cached: false,
    });
  });
});

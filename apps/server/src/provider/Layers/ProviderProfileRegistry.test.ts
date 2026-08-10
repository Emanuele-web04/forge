import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_PROVIDER_PROFILE_ID, type CodexProviderTarget } from "@synara/contracts";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig } from "../../config";
import { ServerSettingsService } from "../../serverSettings";
import {
  ProviderProfileRegistry,
  ProviderProfileRegistryError,
} from "../Services/ProviderProfileRegistry";
import { ProviderProfileRegistryLive } from "./ProviderProfileRegistry";

const temporaryRoots: string[] = [];

function makeBaseDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "synara-provider-profiles-test-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeLayer(
  baseDir: string,
  codexSettings: {
    readonly enabled?: boolean;
    readonly binaryPath?: string;
    readonly homePath?: string;
  } = {},
) {
  const configLayer = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
    Layer.provide(NodeServices.layer),
  );
  const settingsLayer = ServerSettingsService.layerTest({
    providers: { codex: { enabled: true, ...codexSettings } },
  });
  const dependencies = Layer.merge(configLayer, settingsLayer);
  return Layer.merge(
    dependencies,
    ProviderProfileRegistryLive.pipe(Layer.provide(dependencies)),
  );
}

function runWithRegistry<A, E>(
  baseDir: string,
  effect: Effect.Effect<A, E, ProviderProfileRegistry | ServerConfig>,
  codexSettings: {
    readonly enabled?: boolean;
    readonly binaryPath?: string;
    readonly homePath?: string;
  } = {},
) {
  return Effect.runPromise(
    effect.pipe(Effect.provide(makeLayer(baseDir, codexSettings)), Effect.scoped),
  );
}

function storedProfile(profileId: string, storageKey: string) {
  return {
    profileId,
    storageKey,
    displayName: profileId,
    enabled: false,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    tombstonedAt: null,
  };
}

describe("ProviderProfileRegistryLive", () => {
  it("lists the implicit legacy default without persisting it", async () => {
    const baseDir = makeBaseDir();

    const result = await runWithRegistry(
      baseDir,
      Effect.gen(function* () {
        const registry = yield* ProviderProfileRegistry;
        const config = yield* ServerConfig;
        return {
          snapshot: yield* registry.list({ provider: "codex" }),
          indexPath: path.join(config.stateDir, "provider-profiles", "index.json"),
          resolution: yield* registry.resolveForRuntime({
            provider: "codex",
            profileId: DEFAULT_PROVIDER_PROFILE_ID,
          }),
        };
      }),
      { binaryPath: "/opt/codex", homePath: "/source/codex-home" },
    );

    expect(result.snapshot).toEqual({
      providerEnabled: true,
      profiles: [
        {
          target: { provider: "codex", profileId: "default" },
          displayName: "Default",
          enabled: true,
          lifecycle: "active",
          storageKind: "legacy-default",
        },
      ],
    });
    expect(fs.existsSync(result.indexPath)).toBe(false);
    expect(result.resolution.launchContext).toEqual({
      target: { provider: "codex", profileId: "default" },
      binaryPath: "/opt/codex",
      settingsRevision: 0,
      registryRevision: 0,
      home: { strategy: "legacy-overlay", sourceHomePath: "/source/codex-home" },
    });
    expect(Object.isFrozen(result.resolution.launchContext)).toBe(true);
    expect(Object.isFrozen(result.resolution.launchContext.home)).toBe(true);
  });

  it("creates an isolated disabled profile and resolves separate managed homes after enable", async () => {
    const baseDir = makeBaseDir();
    const sourceHome = path.join(baseDir, "source-codex-home");
    fs.mkdirSync(sourceHome, { recursive: true });
    fs.writeFileSync(path.join(sourceHome, "auth.json"), "source-secret", { mode: 0o600 });
    fs.writeFileSync(path.join(sourceHome, "config.toml"), "model = \"source\"\n", {
      mode: 0o600,
    });

    const result = await runWithRegistry(
      baseDir,
      Effect.gen(function* () {
        const registry = yield* ProviderProfileRegistry;
        const created = yield* registry.create({ provider: "codex", displayName: "Work" });
        const managed = created.profiles[1]!;
        const managementResolution = yield* registry.resolveForManagement(managed.target);
        if (managementResolution.launchContext.home.strategy !== "managed-direct") {
          throw new Error("Expected a managed Codex launch context");
        }
        fs.writeFileSync(
          path.join(managementResolution.launchContext.home.codexHomePath, "config.toml"),
          "model = \"managed\"\n",
          { mode: 0o600 },
        );
        fs.rmSync(managementResolution.launchContext.home.codexSqliteHomePath, {
          recursive: true,
          force: true,
        });
        const disabledError = yield* registry.resolveForRuntime(managed.target).pipe(Effect.flip);
        const disabledRuntimeCreatedStorage = fs.existsSync(
          managementResolution.launchContext.home.codexSqliteHomePath,
        );
        yield* registry.sealManagedAuthentication(managed.target);
        const enabled = yield* registry.setEnabled({ target: managed.target, enabled: true });
        const runtimeResolution = yield* registry.resolveForRuntime(managed.target);
        return {
          created,
          managementResolution,
          disabledError,
          disabledRuntimeCreatedStorage,
          enabled,
          runtimeResolution,
        };
      }),
      { binaryPath: "/opt/codex", homePath: sourceHome },
    );

    expect(result.created.profiles[1]).toMatchObject({
      displayName: "Work",
      enabled: false,
      lifecycle: "active",
      storageKind: "managed",
    });
    expect(result.disabledError.code).toBe("PROVIDER_PROFILE_DISABLED");
    expect(result.disabledRuntimeCreatedStorage).toBe(false);
    expect(result.enabled.profiles[1]?.enabled).toBe(true);

    const persistedRegistry = JSON.parse(
      fs.readFileSync(path.join(baseDir, "userdata", "provider-profiles", "index.json"), "utf8"),
    ) as { profiles: Array<{ profileId: string; storageKey: string }> };
    const persistedProfile = persistedRegistry.profiles[0]!;
    expect(persistedProfile.profileId).toBe(result.created.profiles[1]!.target.profileId);
    expect(persistedProfile.profileId).not.toBe(
      `codex_${persistedProfile.storageKey.replaceAll("-", "")}`,
    );
    expect(JSON.stringify(result.created)).not.toContain(persistedProfile.storageKey);

    expect(result.managementResolution.summary.enabled).toBe(false);
    expect(result.managementResolution.launchContext.registryRevision).toBe(1);
    expect(result.runtimeResolution.launchContext.registryRevision).toBe(3);
    expect(result.managementResolution.launchContext.home).toEqual(
      result.runtimeResolution.launchContext.home,
    );
    const launchContext = result.runtimeResolution.launchContext;
    expect(launchContext.home.strategy).toBe("managed-direct");
    if (launchContext.home.strategy !== "managed-direct") {
      throw new Error("Expected a managed Codex launch context");
    }
    expect(launchContext.home.codexHomePath).not.toBe(sourceHome);
    expect(launchContext.home.codexSqliteHomePath).not.toBe(launchContext.home.codexHomePath);
    expect(fs.readdirSync(launchContext.home.codexHomePath)).toEqual(["config.toml"]);
    expect(
      fs.readFileSync(path.join(launchContext.home.codexHomePath, "config.toml"), "utf8"),
    ).toBe(
      'project_root_markers = [".synara-provider-profile-root"]\nmodel_provider = "openai"\nforced_login_method = "chatgpt"\ncli_auth_credentials_store = "file"\nmcp_oauth_credentials_store = "file"\n',
    );
    expect(fs.readdirSync(launchContext.home.codexSqliteHomePath)).toEqual([]);
    expect(fs.readFileSync(path.join(sourceHome, "auth.json"), "utf8")).toBe("source-secret");
    expect(fs.existsSync(path.join(launchContext.home.codexHomePath, "auth.json"))).toBe(false);
    expect(Object.isFrozen(launchContext)).toBe(true);
    expect(Object.isFrozen(launchContext.target)).toBe(true);

    if (process.platform !== "win32") {
      const profileRoot = path.dirname(launchContext.home.codexHomePath);
      const codexProfilesRoot = path.dirname(profileRoot);
      const profilesRoot = path.dirname(codexProfilesRoot);
      for (const directoryPath of [
        profilesRoot,
        codexProfilesRoot,
        profileRoot,
        launchContext.home.codexHomePath,
        launchContext.home.codexSqliteHomePath,
      ]) {
        expect(fs.statSync(directoryPath).mode & 0o777).toBe(0o700);
      }
      expect(
        fs.statSync(path.join(launchContext.home.codexHomePath, "config.toml")).mode & 0o777,
      ).toBe(0o600);
      expect(fs.statSync(path.join(profilesRoot, "index.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("persists rename, enable, and terminal tombstones across service instances", async () => {
    const baseDir = makeBaseDir();
    let profileId = "";

    await runWithRegistry(
      baseDir,
      Effect.gen(function* () {
        const registry = yield* ProviderProfileRegistry;
        const created = yield* registry.create({ provider: "codex", displayName: "Work" });
        const target = created.profiles[1]!.target;
        profileId = target.profileId;
        const conflict = yield* registry
          .create({ provider: "codex", displayName: "work" })
          .pipe(Effect.flip);
        expect(conflict.code).toBe("PROVIDER_PROFILE_NAME_CONFLICT");
        expect((yield* registry.list({ provider: "codex" })).profiles).toHaveLength(2);
        yield* registry.rename({ target, displayName: "Client" });
        yield* registry.sealManagedAuthentication(target);
        yield* registry.setEnabled({ target, enabled: true });
        const activeResolution = yield* registry.resolveForManagement(target);
        if (activeResolution.launchContext.home.strategy !== "managed-direct") {
          throw new Error("Expected a managed Codex launch context");
        }
        const retainedProfileRoot = path.dirname(activeResolution.launchContext.home.codexHomePath);
        const tombstoned = yield* registry.tombstone({ target });
        const indexPath = path.join(baseDir, "userdata", "provider-profiles", "index.json");
        const persistedTombstone = fs.readFileSync(indexPath, "utf8");
        const repeated = yield* registry.tombstone({ target });
        expect(repeated).toEqual(tombstoned);
        expect(fs.readFileSync(indexPath, "utf8")).toBe(persistedTombstone);
        expect(fs.existsSync(retainedProfileRoot)).toBe(true);
        const managementError = yield* registry.resolveForManagement(target).pipe(Effect.flip);
        expect(managementError.code).toBe("PROVIDER_PROFILE_TOMBSTONED");
      }),
    );

    const persistedIndexPath = path.join(
      baseDir,
      "userdata",
      "provider-profiles",
      "index.json",
    );
    if (process.platform !== "win32") fs.chmodSync(persistedIndexPath, 0o644);

    const reloaded = await runWithRegistry(
      baseDir,
      Effect.gen(function* () {
        const registry = yield* ProviderProfileRegistry;
        return yield* registry.list({ provider: "codex" });
      }),
    );

    expect(reloaded.profiles[1]).toEqual({
      target: { provider: "codex", profileId },
      displayName: "Client",
      enabled: false,
      lifecycle: "tombstoned",
      storageKind: "managed",
    });
    if (process.platform !== "win32") {
      expect(fs.statSync(persistedIndexPath).mode & 0o777).toBe(0o600);
    }

    const replacement = await runWithRegistry(
      baseDir,
      Effect.gen(function* () {
        const registry = yield* ProviderProfileRegistry;
        return yield* registry.create({ provider: "codex", displayName: "Client" });
      }),
    );
    expect(replacement.profiles[2]!.target.profileId).not.toBe(profileId);
  });

  it("keeps the global Codex switch separate from each profile's administrative switch", async () => {
    const baseDir = makeBaseDir();
    let target: CodexProviderTarget | undefined;

    await runWithRegistry(
      baseDir,
      Effect.gen(function* () {
        const registry = yield* ProviderProfileRegistry;
        const created = yield* registry.create({ provider: "codex", displayName: "Work" });
        const createdTarget = created.profiles[1]!.target;
        target = createdTarget;
        yield* registry.sealManagedAuthentication(createdTarget);
        yield* registry.setEnabled({ target: createdTarget, enabled: true });
      }),
    );

    const result = await runWithRegistry(
      baseDir,
      Effect.gen(function* () {
        const registry = yield* ProviderProfileRegistry;
        const snapshot = yield* registry.list({ provider: "codex" });
        const managementResolution = yield* registry.resolveForManagement(target!);
        const runtimeError = yield* registry.resolveForRuntime(target!).pipe(Effect.flip);
        return { snapshot, managementResolution, runtimeError };
      }),
      { enabled: false },
    );

    expect(result.snapshot.providerEnabled).toBe(false);
    expect(result.snapshot.profiles.map((profile) => profile.enabled)).toEqual([true, true]);
    expect(result.managementResolution.providerEnabled).toBe(false);
    expect(result.runtimeError.code).toBe("PROVIDER_PROFILE_DISABLED");
  });

  it("rejects default mutation and corrupt registries without exposing private paths", async () => {
    const baseDir = makeBaseDir();
    const defaultTarget = { provider: "codex" as const, profileId: DEFAULT_PROVIDER_PROFILE_ID };

    const defaultMutations = await runWithRegistry(
      baseDir,
      Effect.gen(function* () {
        const registry = yield* ProviderProfileRegistry;
        return yield* Effect.all([
          registry.rename({ target: defaultTarget, displayName: "Changed" }).pipe(Effect.flip),
          registry.setEnabled({ target: defaultTarget, enabled: false }).pipe(Effect.flip),
          registry.tombstone({ target: defaultTarget }).pipe(Effect.flip),
        ]);
      }),
    );
    expect(defaultMutations.map((error) => error.code)).toEqual([
      "PROVIDER_PROFILE_DEFAULT_IMMUTABLE",
      "PROVIDER_PROFILE_DEFAULT_IMMUTABLE",
      "PROVIDER_PROFILE_DEFAULT_IMMUTABLE",
    ]);

    const indexPath = path.join(baseDir, "userdata", "provider-profiles", "index.json");
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, '{"version":999,"revision":0,"profiles":[]}', { mode: 0o600 });

    const corruptResult = await runWithRegistry(
      baseDir,
      Effect.gen(function* () {
        const registry = yield* ProviderProfileRegistry;
        return yield* registry.list({ provider: "codex" });
      }).pipe(Effect.flip),
    );
    expect(corruptResult).toBeInstanceOf(ProviderProfileRegistryError);
    expect(corruptResult.code).toBe("PROVIDER_PROFILE_REGISTRY_INVALID");
    expect(corruptResult.message).not.toContain(baseDir);
    expect(fs.readFileSync(indexPath, "utf8")).toContain('"version":999');
  });

  it.each([
    [
      "duplicate profile ids",
      [
        storedProfile("codex_one", "11111111-1111-4111-8111-111111111111"),
        storedProfile("codex_one", "22222222-2222-4222-8222-222222222222"),
      ],
    ],
    [
      "duplicate storage keys",
      [
        storedProfile("codex_one", "11111111-1111-4111-8111-111111111111"),
        storedProfile("codex_two", "11111111-1111-4111-8111-111111111111"),
      ],
    ],
    [
      "duplicate active display names",
      [
        {
          ...storedProfile("codex_one", "11111111-1111-4111-8111-111111111111"),
          displayName: "Work",
        },
        {
          ...storedProfile("codex_two", "22222222-2222-4222-8222-222222222222"),
          displayName: "work",
        },
      ],
    ],
    [
      "an enabled tombstone",
      [
        {
          ...storedProfile("codex_one", "11111111-1111-4111-8111-111111111111"),
          enabled: true,
          tombstonedAt: "2026-08-10T01:00:00.000Z",
        },
      ],
    ],
    [
      "an active profile named Default",
      [
        {
          ...storedProfile("codex_one", "11111111-1111-4111-8111-111111111111"),
          displayName: "DEFAULT",
        },
      ],
    ],
    ["an unsafe storage key", [storedProfile("codex_one", "../../legacy-codex-home")]],
  ])("fails closed on %s without rewriting the registry", async (_label, profiles) => {
    const baseDir = makeBaseDir();
    const indexPath = path.join(baseDir, "userdata", "provider-profiles", "index.json");
    fs.mkdirSync(path.dirname(indexPath), { recursive: true, mode: 0o700 });
    const invalidContents = `${JSON.stringify({ version: 1, revision: 7, profiles }, null, 2)}\n`;
    fs.writeFileSync(indexPath, invalidContents, { mode: 0o600 });

    const error = await runWithRegistry(
      baseDir,
      Effect.gen(function* () {
        const registry = yield* ProviderProfileRegistry;
        return yield* registry.list({ provider: "codex" });
      }).pipe(Effect.flip),
    );

    expect(error.code).toBe("PROVIDER_PROFILE_REGISTRY_INVALID");
    expect(fs.readFileSync(indexPath, "utf8")).toBe(invalidContents);
  });

  it("migrates v1 enabled profiles to disabled and unbound with a stable private namespace", async () => {
    const baseDir = makeBaseDir();
    const storageKey = "11111111-1111-4111-8111-111111111111";
    const profile = { ...storedProfile("codex_one", storageKey), enabled: true };
    const indexPath = path.join(baseDir, "userdata", "provider-profiles", "index.json");
    fs.mkdirSync(path.dirname(indexPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      indexPath,
      `${JSON.stringify({ version: 1, revision: 7, profiles: [profile] }, null, 2)}\n`,
      { mode: 0o600 },
    );

    const result = await runWithRegistry(
      baseDir,
      Effect.gen(function* () {
        const registry = yield* ProviderProfileRegistry;
        const target = { provider: "codex" as const, profileId: profile.profileId };
        const snapshot = yield* registry.list({ provider: "codex" });
        const resolution = yield* registry.resolveForManagement(target);
        const enableError = yield* registry
          .setEnabled({ target, enabled: true })
          .pipe(Effect.flip);
        return { snapshot, resolution, enableError };
      }),
    );

    expect(result.snapshot.profiles[1]?.enabled).toBe(false);
    expect(JSON.stringify(result.snapshot)).not.toContain(storageKey);
    expect(result.enableError.code).toBe("PROVIDER_PROFILE_AUTHENTICATION_UNBOUND");
    expect(result.resolution.launchContext.home.strategy).toBe("managed-direct");
    if (result.resolution.launchContext.home.strategy !== "managed-direct") {
      throw new Error("Expected managed launch context");
    }
    expect(result.resolution.launchContext.authenticationBoundAt).toBeNull();
    expect(result.resolution.launchContext.continuationNamespaceId).toBe(storageKey);

    const persisted = JSON.parse(fs.readFileSync(indexPath, "utf8")) as {
      version: number;
      revision: number;
      profiles: Array<{ enabled: boolean; authenticationBoundAt: string | null }>;
    };
    expect(persisted).toMatchObject({
      version: 2,
      revision: 8,
      profiles: [{ enabled: false, authenticationBoundAt: null }],
    });

    const reloaded = await runWithRegistry(
      baseDir,
      Effect.gen(function* () {
        const registry = yield* ProviderProfileRegistry;
        const target = { provider: "codex" as const, profileId: profile.profileId };
        return yield* registry.resolveForManagement(target);
      }),
    );
    expect(reloaded.launchContext.registryRevision).toBe(8);
    expect(fs.readFileSync(indexPath, "utf8")).toBe(
      `${JSON.stringify(persisted, null, 2)}\n`,
    );
  });

  it("rejects a v2 enabled profile with a noncanonical authentication binding", async () => {
    const baseDir = makeBaseDir();
    const indexPath = path.join(baseDir, "userdata", "provider-profiles", "index.json");
    fs.mkdirSync(path.dirname(indexPath), { recursive: true, mode: 0o700 });
    const profile = {
      ...storedProfile("codex_one", "11111111-1111-4111-8111-111111111111"),
      enabled: true,
      authenticationBoundAt: "x",
    };
    fs.writeFileSync(
      indexPath,
      `${JSON.stringify({ version: 2, revision: 7, profiles: [profile] }, null, 2)}\n`,
      { mode: 0o600 },
    );

    const error = await runWithRegistry(
      baseDir,
      Effect.gen(function* () {
        const registry = yield* ProviderProfileRegistry;
        return yield* registry.list({ provider: "codex" });
      }).pipe(Effect.flip),
    );

    expect(error.code).toBe("PROVIDER_PROFILE_REGISTRY_INVALID");
  });

  it("leaves an inert private orphan instead of publishing a profile when index persistence fails", async () => {
    const baseDir = makeBaseDir();
    const profilesRoot = path.join(baseDir, "userdata", "provider-profiles");
    const indexPath = path.join(profilesRoot, "index.json");

    const result = await runWithRegistry(
      baseDir,
      Effect.gen(function* () {
        const registry = yield* ProviderProfileRegistry;
        yield* registry.list({ provider: "codex" });
        yield* Effect.sync(() => fs.mkdirSync(indexPath, { recursive: true, mode: 0o700 }));
        const error = yield* registry
          .create({ provider: "codex", displayName: "Work" })
          .pipe(Effect.flip);
        const snapshot = yield* registry.list({ provider: "codex" });
        return { error, snapshot };
      }),
    );

    expect(result.error.code).toBe("PROVIDER_PROFILE_STORAGE_ERROR");
    expect(result.error.message).not.toContain(baseDir);
    expect(result.snapshot.profiles.map((profile) => profile.target.profileId)).toEqual([
      "default",
    ]);
    expect(fs.statSync(indexPath).isDirectory()).toBe(true);
    const storageKeys = fs.readdirSync(path.join(profilesRoot, "codex"));
    expect(storageKeys).toHaveLength(1);
    const orphanRoot = path.join(profilesRoot, "codex", storageKeys[0]!);
    expect(fs.readdirSync(path.join(orphanRoot, "home"))).toEqual(["config.toml"]);
    expect(fs.readdirSync(path.join(orphanRoot, "sqlite"))).toEqual([]);
    expect(fs.readdirSync(profilesRoot).sort()).toEqual(["codex", "index.json"]);

    if (process.platform !== "win32") {
      expect(fs.statSync(orphanRoot).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(orphanRoot, "home", "config.toml")).mode & 0o777).toBe(0o600);
    }
  });
});

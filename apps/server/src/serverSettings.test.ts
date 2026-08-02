import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_MODEL_BY_PROVIDER } from "@synara/contracts";
import { Effect, FileSystem, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { ServerConfig } from "./config";
import { ServerSettingsLive, ServerSettingsService } from "./serverSettings";

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "synara-settings-test-",
}).pipe(Layer.provide(NodeServices.layer));
const makeTestLayer = Layer.merge(NodeServices.layer, serverConfigLayer);
const testLayer = Layer.merge(makeTestLayer, ServerSettingsLive.pipe(Layer.provide(makeTestLayer)));

const runWithSettings = <A, E>(
  effect: Effect.Effect<A, E, ServerSettingsService | ServerConfig | FileSystem.FileSystem>,
) => Effect.runPromise(effect.pipe(Effect.provide(testLayer)) as Effect.Effect<A, E, never>);

describe("ServerSettingsService", () => {
  it("loads defaults when settings file does not exist", async () => {
    const settings = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        yield* service.start;
        return yield* service.getSettings;
      }),
    );

    expect(settings.providers.codex.binaryPath).toBe("codex");
    expect(settings.providers.grok.binaryPath).toBe("grok");
    expect(settings.defaultThreadEnvMode).toBe("local");
    expect(settings.enableProviderUpdateChecks).toBe(true);
  });

  it("persists updates and reloads them", async () => {
    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const { settingsPath } = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* service.start;

        const updated = yield* service.updateSettings({
          enableAssistantStreaming: true,
          enableProviderUpdateChecks: false,
          providers: {
            codex: {
              binaryPath: "/usr/local/bin/codex",
              customModels: ["gpt-custom"],
            },
          },
        });
        const raw = yield* fs.readFileString(settingsPath);
        return { updated, parsed: JSON.parse(raw) as unknown };
      }),
    );

    expect(result.updated.enableAssistantStreaming).toBe(true);
    expect(result.updated.enableProviderUpdateChecks).toBe(false);
    expect(result.updated.providers.codex.binaryPath).toBe("/usr/local/bin/codex");
    expect(result.parsed).toMatchObject({
      revision: 1,
      migrationVersion: 1,
      settings: {
        enableAssistantStreaming: true,
        enableProviderUpdateChecks: false,
        providers: {
          codex: {
            binaryPath: "/usr/local/bin/codex",
            customModels: ["gpt-custom"],
          },
        },
      },
    });
  });

  it("keeps provider passwords server-only and returns configured flags to clients", async () => {
    const result = await runWithSettings(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        const { settingsPath } = yield* ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* service.start;
        const view = yield* service.updateSettingsView({
          providers: {
            kilo: { serverPassword: "kilo-secret" },
            opencode: { serverPassword: "opencode-secret" },
          },
        });
        const internal = yield* service.getSettings;
        const persisted = yield* fs.readFileString(settingsPath);
        return { view, internal, persisted };
      }),
    );

    expect(result.internal.providers.kilo.serverPasswordConfigured).toBe(true);
    expect(result.internal.providers.opencode.serverPasswordConfigured).toBe(true);
    expect(result.view.providers.kilo).toMatchObject({ serverPasswordConfigured: true });
    expect(result.view.providers.opencode).toMatchObject({ serverPasswordConfigured: true });
    expect(JSON.stringify(result.internal)).not.toContain("kilo-secret");
    expect(JSON.stringify(result.internal)).not.toContain("opencode-secret");
    expect(JSON.stringify(result.view)).not.toContain("kilo-secret");
    expect(JSON.stringify(result.view)).not.toContain("opencode-secret");
    expect(JSON.stringify(result.view)).not.toContain('"serverPassword"');
    expect(result.persisted).not.toContain("kilo-secret");
    expect(result.persisted).not.toContain("opencode-secret");
  });

  it("resolves text generation selection away from disabled providers", async () => {
    const settings = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ServerSettingsService;
        return yield* service.getSettings;
      }).pipe(
        Effect.provide(
          ServerSettingsService.layerTest({
            textGenerationModelSelection: {
              provider: "antigravity",
              model: DEFAULT_MODEL_BY_PROVIDER.antigravity,
            },
            providers: {
              antigravity: { enabled: false },
            },
          }),
        ),
      ),
    );

    expect(settings.textGenerationModelSelection.provider).toBe("codex");
    expect(settings.textGenerationModelSelection.model).toBe(DEFAULT_MODEL_BY_PROVIDER.codex);
  });

  describe("remoteHosts", () => {
    const HOST = {
      hostId: "host-1",
      label: "Devbox",
      destination: "devbox",
    } as const;

    it("defaults to an empty list and round-trips through disk", async () => {
      const result = await runWithSettings(
        Effect.gen(function* () {
          const service = yield* ServerSettingsService;
          const { settingsPath } = yield* ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          yield* service.start;
          const initial = yield* service.getSettings;
          const updated = yield* service.updateSettings({ remoteHosts: [HOST] });
          const raw = yield* fs.readFileString(settingsPath);
          return { initial, updated, parsed: JSON.parse(raw) as { settings: unknown } };
        }),
      );

      expect(result.initial.remoteHosts).toEqual([]);
      expect(result.updated.remoteHosts).toHaveLength(1);
      // Fields the user never filled in must come back filled by the schema's
      // decoding defaults, so callers never have to special-case a partial host.
      expect(result.updated.remoteHosts[0]).toMatchObject({
        hostId: "host-1",
        label: "Devbox",
        destination: "devbox",
        hostKeyVerification: "strict",
        connectTimeoutSeconds: 10,
        launcher: { kind: "direct" },
        sshArgs: [],
      });
      expect(result.parsed.settings).toMatchObject({
        remoteHosts: [{ hostId: "host-1", destination: "devbox" }],
      });
    });

    it("replaces the whole list rather than merging element-wise", async () => {
      // Removing a host is expressed as "send the list without it". If the patch
      // merged per index, a two-host list patched with one host would keep the
      // second — i.e. Remove would silently not remove.
      const settings = await runWithSettings(
        Effect.gen(function* () {
          const service = yield* ServerSettingsService;
          yield* service.start;
          yield* service.updateSettings({
            remoteHosts: [HOST, { hostId: "host-2", label: "Big", destination: "big" }],
          });
          return yield* service.updateSettings({ remoteHosts: [HOST] });
        }),
      );

      expect(settings.remoteHosts.map((host) => host.hostId)).toEqual(["host-1"]);
    });

    it("never persists or exposes a secret-bearing field", async () => {
      // ServerSettingsView === ServerSettings, so every field here reaches every
      // client. This is the regression guard for the day someone adds a
      // convenience `password` to RemoteHostConfig.
      const result = await runWithSettings(
        Effect.gen(function* () {
          const service = yield* ServerSettingsService;
          const { settingsPath } = yield* ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          yield* service.start;
          const view = yield* service.updateSettingsView({
            remoteHosts: [{ ...HOST, password: "hunter2", privateKey: "-----BEGIN" }],
          } as never);
          return { view, persisted: yield* fs.readFileString(settingsPath) };
        }),
      );

      const host = result.view.remoteHosts[0];
      expect(host).toBeDefined();
      for (const field of ["password", "privateKey", "passphrase", "token", "secret"]) {
        expect(Object.keys(host as object)).not.toContain(field);
      }
      expect(JSON.stringify(result.view)).not.toContain("hunter2");
      expect(result.persisted).not.toContain("hunter2");
      expect(result.persisted).not.toContain("BEGIN");
    });
  });
});

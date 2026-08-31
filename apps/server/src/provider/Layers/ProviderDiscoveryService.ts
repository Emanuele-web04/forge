import {
  DEFAULT_SERVER_SETTINGS,
  type ProviderComposerCapabilities,
  ProviderGetComposerCapabilitiesInput,
  ProviderListAgentsInput,
  ProviderListCommandsInput,
  ProviderListModelsInput,
  type ProviderListModelsResult,
  ProviderListPluginsInput,
  ProviderModelDescriptor,
  ProviderListSkillsInput,
  type ProviderListSkillsResult,
  ProviderReadPluginInput,
  type ProviderSkillDescriptor,
} from "@synara/contracts";
import { Effect, Layer, Option, Schema, SchemaIssue } from "effect";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderValidationError } from "../Errors.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import {
  ProviderDiscoveryService,
  type ProviderDiscoveryServiceShape,
} from "../Services/ProviderDiscoveryService.ts";
import {
  discoverSkillsCatalog,
  filterDisabledSkills,
  mergeSkillsIntoCatalog,
} from "../skillsCatalog.ts";

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) =>
  Schema.decodeUnknownEffect(input.schema)(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );

const disabledCapabilitiesForProvider = (
  provider: ProviderComposerCapabilities["provider"],
): ProviderComposerCapabilities => ({
  provider,
  supportsSkillMentions: false,
  supportsSkillDiscovery: false,
  supportsNativeSlashCommandDiscovery: false,
  supportsPluginMentions: false,
  supportsPluginDiscovery: false,
  supportsRuntimeModelList: false,
  supportsThreadCompaction: false,
  supportsThreadImport: false,
});

const decodeProviderModelDescriptorOption = Schema.decodeUnknownOption(ProviderModelDescriptor);

function isolateMalformedModelDescriptors(input: {
  readonly provider: ProviderListModelsInput["provider"];
  readonly result: ProviderListModelsResult;
}): Effect.Effect<ProviderListModelsResult> {
  const models = input.result.models.flatMap((model) => {
    const decoded = decodeProviderModelDescriptorOption(model);
    return Option.isSome(decoded) ? [decoded.value] : [];
  });
  const omittedCount = input.result.models.length - models.length;
  if (omittedCount === 0) {
    return Effect.succeed(input.result);
  }
  return Effect.logWarning("provider model discovery omitted malformed descriptors", {
    provider: input.provider,
    source: input.result.source ?? "unknown",
    omittedCount,
  }).pipe(
    Effect.as({
      ...input.result,
      models,
    }),
  );
}

const make = Effect.gen(function* () {
  const registry = yield* ProviderAdapterRegistry;
  const serverConfig = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const providerIsEnabled = Effect.fn("providerIsEnabled")(function* (
    provider: ProviderGetComposerCapabilitiesInput["provider"],
  ) {
    return yield* serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.providers[provider].enabled),
      Effect.orElseSucceed(() => true),
    );
  });

  const getComposerCapabilities: ProviderDiscoveryServiceShape["getComposerCapabilities"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderDiscoveryService.getComposerCapabilities",
        schema: ProviderGetComposerCapabilitiesInput,
        payload: input,
      });
      if (!(yield* providerIsEnabled(parsed.provider))) {
        return disabledCapabilitiesForProvider(parsed.provider);
      }
      const adapter = yield* registry.getByProvider(parsed.provider);
      const capabilities = adapter.getComposerCapabilities
        ? yield* adapter.getComposerCapabilities()
        : disabledCapabilitiesForProvider(parsed.provider);
      // The unified Synara skills catalog backs skill discovery for every
      // provider, including ones without native skill support.
      return {
        ...capabilities,
        supportsSkillMentions: true,
        supportsSkillDiscovery: true,
      };
    });

  const listSkills: ProviderDiscoveryServiceShape["listSkills"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderDiscoveryService.listSkills",
        schema: ProviderListSkillsInput,
        payload: input,
      });
      if (!(yield* providerIsEnabled(parsed.provider))) {
        return {
          skills: [],
          source: "disabled",
          cached: false,
        };
      }
      const adapter = yield* registry.getByProvider(parsed.provider);
      const nativeResult: ProviderListSkillsResult | null = adapter.listSkills
        ? yield* adapter
            .listSkills(parsed)
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  "provider-native skill discovery failed; serving the Synara skills catalog only",
                  { provider: parsed.provider, error },
                ).pipe(Effect.as(null)),
              ),
            )
        : null;
      const catalogSkills = yield* Effect.tryPromise(() =>
        discoverSkillsCatalog({
          cwd: parsed.cwd,
          homeDir: serverConfig.homeDir,
          synaraBaseDir: serverConfig.baseDir,
          provider: parsed.provider,
          ...(parsed.forceReload !== undefined ? { forceReload: parsed.forceReload } : {}),
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("synara skills catalog discovery failed", {
            provider: parsed.provider,
            cause,
          }).pipe(Effect.as([] as ProviderSkillDescriptor[])),
        ),
      );
      const merged = mergeSkillsIntoCatalog({
        native: nativeResult?.skills ?? [],
        catalog: catalogSkills,
      });
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS),
      );
      return {
        skills: filterDisabledSkills(merged, settings.skills.disabled),
        source: nativeResult?.source ? `${nativeResult.source}+synara.catalog` : "synara.catalog",
        cached: nativeResult?.cached ?? false,
      } satisfies ProviderListSkillsResult;
    });

  const listCommands: ProviderDiscoveryServiceShape["listCommands"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderDiscoveryService.listCommands",
        schema: ProviderListCommandsInput,
        payload: input,
      });
      if (!(yield* providerIsEnabled(parsed.provider))) {
        return {
          commands: [],
          source: "disabled",
          cached: false,
        };
      }
      const adapter = yield* registry.getByProvider(parsed.provider);
      if (!adapter.listCommands) {
        return {
          commands: [],
          source: "unsupported",
          cached: false,
        };
      }
      return yield* adapter.listCommands(parsed);
    });

  const listPlugins: ProviderDiscoveryServiceShape["listPlugins"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderDiscoveryService.listPlugins",
        schema: ProviderListPluginsInput,
        payload: input,
      });
      if (!(yield* providerIsEnabled(parsed.provider))) {
        return {
          marketplaces: [],
          marketplaceLoadErrors: [],
          remoteSyncError: null,
          featuredPluginIds: [],
          source: "disabled",
          cached: false,
        };
      }
      const adapter = yield* registry.getByProvider(parsed.provider);
      if (!adapter.listPlugins) {
        return {
          marketplaces: [],
          marketplaceLoadErrors: [],
          remoteSyncError: null,
          featuredPluginIds: [],
          source: "unsupported",
          cached: false,
        };
      }
      return yield* adapter.listPlugins(parsed);
    });

  const readPlugin: ProviderDiscoveryServiceShape["readPlugin"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderDiscoveryService.readPlugin",
        schema: ProviderReadPluginInput,
        payload: input,
      });
      if (!(yield* providerIsEnabled(parsed.provider))) {
        return yield* new ProviderValidationError({
          operation: "ProviderDiscoveryService.readPlugin",
          issue: `Provider '${parsed.provider}' is disabled in Synara settings.`,
        });
      }
      const adapter = yield* registry.getByProvider(parsed.provider);
      if (!adapter.readPlugin) {
        return yield* new ProviderValidationError({
          operation: "ProviderDiscoveryService.readPlugin",
          issue: `Plugin discovery is unavailable for provider '${parsed.provider}'.`,
        });
      }
      return yield* adapter.readPlugin(parsed);
    });

  const listModels: ProviderDiscoveryServiceShape["listModels"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderDiscoveryService.listModels",
        schema: ProviderListModelsInput,
        payload: input,
      });
      if (!(yield* providerIsEnabled(parsed.provider))) {
        return {
          models: [],
          source: "disabled",
          cached: false,
        };
      }
      const adapter = yield* registry.getByProvider(parsed.provider);
      if (!adapter.listModels) {
        return {
          models: [],
          source: "unsupported",
          cached: false,
        };
      }
      const result = yield* adapter.listModels(parsed);
      return yield* isolateMalformedModelDescriptors({
        provider: parsed.provider,
        result,
      });
    });

  const listAgents: ProviderDiscoveryServiceShape["listAgents"] = (input) =>
    Effect.gen(function* () {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderDiscoveryService.listAgents",
        schema: ProviderListAgentsInput,
        payload: input,
      });
      if (!(yield* providerIsEnabled(parsed.provider))) {
        return {
          agents: [],
          source: "disabled",
          cached: false,
        };
      }
      const adapter = yield* registry.getByProvider(parsed.provider);
      if (!adapter.listAgents) {
        return {
          agents: [],
          source: "unsupported",
          cached: false,
        };
      }
      return yield* adapter.listAgents(parsed);
    });

  return {
    getComposerCapabilities,
    listCommands,
    listSkills,
    listPlugins,
    readPlugin,
    listModels,
    listAgents,
  } satisfies ProviderDiscoveryServiceShape;
});

export const ProviderDiscoveryServiceLive = Layer.effect(ProviderDiscoveryService, make);

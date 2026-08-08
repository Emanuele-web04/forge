/**
 * ServerSettings - Server-authoritative settings persistence.
 *
 * Owns settings that affect server-side behavior. The web app can continue to
 * keep UI-only preferences in local storage while these values become durable
 * and process-authoritative on the server.
 */
import {
  DEFAULT_SERVER_SETTINGS,
  GIT_TEXT_GENERATION_DEFAULT_PROVIDER_ORDER,
  type ModelSelection,
  ServerSettings,
  ServerSettingsError,
  type ServerSettingsPatch,
  type ServerSettingsView,
} from "@synara/contracts";
import { defaultGitTextGenerationSelectionFor } from "@synara/shared/model";
import { deepMerge, type DeepPartial } from "@synara/shared/Struct";
import { applyServerSettingsPatch } from "@synara/shared/serverSettings";
import {
  Cause,
  Deferred,
  Effect,
  FileSystem,
  Layer,
  Path,
  PubSub,
  Ref,
  Schema,
  SchemaIssue,
  ServiceMap,
  Stream,
} from "effect";
import * as Semaphore from "effect/Semaphore";
import { writeFileStringAtomically } from "./atomicWrite";
import { ServerConfig } from "./config";
import {
  ProviderCredentials,
  ProviderCredentialsLive,
  type ExternalProviderServer,
} from "./providerCredentials";

export interface ServerSettingsShape {
  readonly start: Effect.Effect<void, ServerSettingsError>;
  readonly ready: Effect.Effect<void, ServerSettingsError>;
  readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;
  readonly getSettingsView: Effect.Effect<ServerSettingsView, ServerSettingsError>;
  readonly getSnapshot: Effect.Effect<ServerSettingsSnapshot, ServerSettingsError>;
  readonly updateSettings: (
    patch: ServerSettingsPatch,
  ) => Effect.Effect<ServerSettings, ServerSettingsError>;
  readonly updateSettingsView: (
    patch: ServerSettingsPatch,
  ) => Effect.Effect<ServerSettingsView, ServerSettingsError>;
  readonly streamChanges: Stream.Stream<ServerSettings>;
  readonly streamViews: Stream.Stream<ServerSettingsView>;
}

export interface ServerSettingsSnapshot {
  readonly revision: number;
  readonly migrationVersion: number;
  readonly settings: ServerSettings;
}

const SERVER_SETTINGS_MIGRATION_VERSION = 1;

export function toServerSettingsView(settings: ServerSettings): ServerSettingsView {
  return settings;
}

export class ServerSettingsService extends ServiceMap.Service<
  ServerSettingsService,
  ServerSettingsShape
>()("synara/serverSettings/ServerSettingsService") {
  static readonly layerTest = (overrides: DeepPartial<ServerSettings> = {}) =>
    Layer.effect(
      ServerSettingsService,
      Effect.gen(function* () {
        const currentSettingsRef = yield* Ref.make<ServerSettings>(
          deepMerge(DEFAULT_SERVER_SETTINGS, overrides),
        );
        const changesPubSub = yield* PubSub.unbounded<ServerSettings>();
        const revisionRef = yield* Ref.make(0);
        const emitChange = (settings: ServerSettings) =>
          PubSub.publish(changesPubSub, settings).pipe(Effect.asVoid);
        const getSettings = Ref.get(currentSettingsRef).pipe(
          Effect.map(resolveTextGenerationProvider),
        );
        const updateSettings = (patch: ServerSettingsPatch) =>
          Ref.get(currentSettingsRef).pipe(
            Effect.flatMap((currentSettings) =>
              // Merge against the RAW persisted row: an unrelated/options-only/
              // empty selection patch must never disturb the persisted pair (a
              // temporary disabled-provider fallback alone never changes
              // persistence; provider.enabled toggles and password changes must
              // not silently replace the persisted pair with the fallback view).
              // Only a deliberate provider/model edit resolves against the
              // EFFECTIVE view (the disabled-provider fallback the UI displays):
              // the resolved pair then replaces the persisted one, attributed to
              // the provider the user is looking at.
              normalizeSettings(
                "<memory>",
                currentSettings,
                patch,
                resolveTextGenerationProvider(currentSettings),
              ),
            ),
            Effect.tap((nextSettings) => Ref.set(currentSettingsRef, nextSettings)),
            Effect.tap(() => Ref.update(revisionRef, (revision) => revision + 1)),
            Effect.tap(emitChange),
            Effect.map(resolveTextGenerationProvider),
          );

        return {
          start: Effect.void,
          ready: Effect.void,
          getSettings,
          getSettingsView: getSettings.pipe(Effect.map(toServerSettingsView)),
          getSnapshot: Effect.all({
            revision: Ref.get(revisionRef),
            settings: getSettings,
          }).pipe(
            Effect.map(({ revision, settings }) => ({
              revision,
              migrationVersion: SERVER_SETTINGS_MIGRATION_VERSION,
              settings,
            })),
          ),
          updateSettings,
          updateSettingsView: (patch) =>
            updateSettings(patch).pipe(Effect.map(toServerSettingsView)),
          get streamChanges() {
            return Stream.fromPubSub(changesPubSub).pipe(Stream.map(resolveTextGenerationProvider));
          },
          get streamViews() {
            return Stream.fromPubSub(changesPubSub).pipe(
              Stream.map(resolveTextGenerationProvider),
              Stream.map(toServerSettingsView),
            );
          },
        } satisfies ServerSettingsShape;
      }),
    );
}

// Only providers with a dedicated Git text generation default participate in the
// fallback. Searching over chat providers (e.g. claudeAgent) would let the
// fallback "resolve" to a provider that cannot generate Git text.
// Registry-driven: insertion order in the registry IS the fallback preference
// order, so adding a provider to the registry extends the fallback too.
const PROVIDER_ORDER = GIT_TEXT_GENERATION_DEFAULT_PROVIDER_ORDER;

function resolveTextGenerationProvider(settings: ServerSettings): ServerSettings {
  const selection = settings.textGenerationModelSelection;
  if (settings.providers[selection.provider].enabled) {
    return settings;
  }

  const fallback = PROVIDER_ORDER.find((provider) => settings.providers[provider].enabled);
  if (!fallback) {
    // All-disabled guard: every Git text generation provider is disabled, so
    // there is no valid rewrite target. Preserve the persisted selection
    // unchanged instead of silently replacing it with a provider the user
    // disabled (or an unsupported chat provider).
    return settings;
  }

  // The fallback selection is the complete Git text generation default for
  // that provider (PROVIDER_ORDER only contains Git text generation providers).
  const gitTextGenerationFallback = defaultGitTextGenerationSelectionFor(fallback);

  return {
    ...settings,
    textGenerationModelSelection: {
      provider: gitTextGenerationFallback.provider,
      model: gitTextGenerationFallback.model,
    } as ModelSelection,
  };
}

function normalizeSettings(
  settingsPath: string,
  current: ServerSettings,
  patch: ServerSettingsPatch,
  resolveAgainst?: ServerSettings,
): Effect.Effect<ServerSettings, ServerSettingsError> {
  return Schema.decodeUnknownEffect(ServerSettings)(
    applyServerSettingsPatch(current, patch, resolveAgainst),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          detail: `failed to normalize server settings: ${SchemaIssue.makeFormatterDefault()(cause.issue)}`,
          cause,
        }),
    ),
  );
}

const EXTERNAL_SERVER_PROVIDERS = ["kilo", "opencode"] as const;

function readLegacyProviderPasswords(raw: string): ReadonlyMap<ExternalProviderServer, string> {
  try {
    const parsed = JSON.parse(raw) as {
      providers?: Partial<Record<ExternalProviderServer, { readonly serverPassword?: unknown }>>;
    };
    const passwords = new Map<ExternalProviderServer, string>();
    for (const provider of EXTERNAL_SERVER_PROVIDERS) {
      const value = parsed.providers?.[provider]?.serverPassword;
      if (typeof value === "string" && value.trim().length > 0) {
        passwords.set(provider, value.trim());
      }
    }
    return passwords;
  } catch {
    return new Map();
  }
}

function omitProviderPasswords(patch: ServerSettingsPatch): ServerSettingsPatch {
  if (!patch.providers) return patch;
  const { serverPassword: _kiloPassword, ...kilo } = patch.providers.kilo ?? {};
  const { serverPassword: _openCodePassword, ...opencode } = patch.providers.opencode ?? {};
  return {
    ...patch,
    providers: {
      ...patch.providers,
      ...(patch.providers.kilo ? { kilo } : {}),
      ...(patch.providers.opencode ? { opencode } : {}),
    },
  };
}

function decodeSettingsFromJson(settingsPath: string, raw: string) {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const envelope =
      parsed !== null && typeof parsed === "object" && "settings" in parsed
        ? (parsed as { revision?: unknown; migrationVersion?: unknown; settings: unknown })
        : null;
    const decoded = Schema.decodeUnknownExit(ServerSettings)(envelope?.settings ?? parsed);
    if (decoded._tag === "Failure") {
      return { _tag: "Failure" as const, error: Cause.pretty(decoded.cause) };
    }
    return {
      _tag: "Success" as const,
      value: decoded.value,
      revision:
        envelope && Number.isSafeInteger(envelope.revision) && Number(envelope.revision) >= 0
          ? Number(envelope.revision)
          : 0,
      migrationVersion:
        envelope && Number.isSafeInteger(envelope.migrationVersion)
          ? Number(envelope.migrationVersion)
          : 0,
      legacyFormat: envelope === null,
    };
  } catch (cause) {
    const error = new ServerSettingsError({
      settingsPath,
      detail: "failed to parse settings JSON",
      cause,
    });
    return { _tag: "Failure" as const, error: error.message };
  }
}

const makeServerSettings = Effect.gen(function* () {
  const { settingsPath } = yield* ServerConfig;
  const providerCredentials = yield* ProviderCredentials;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const writeSemaphore = yield* Semaphore.make(1);
  const changesPubSub = yield* PubSub.unbounded<ServerSettings>();
  const settingsRef = yield* Ref.make<ServerSettings>(DEFAULT_SERVER_SETTINGS);
  const revisionRef = yield* Ref.make(0);
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, ServerSettingsError>();

  const emitChange = (settings: ServerSettings) =>
    PubSub.publish(changesPubSub, settings).pipe(Effect.asVoid);

  const withCredentialState = (settings: ServerSettings) =>
    Effect.all({
      kilo: providerCredentials.isServerPasswordConfigured("kilo"),
      opencode: providerCredentials.isServerPasswordConfigured("opencode"),
    }).pipe(
      Effect.map(
        (configured): ServerSettings => ({
          ...settings,
          providers: {
            ...settings.providers,
            kilo: {
              ...settings.providers.kilo,
              serverPasswordConfigured: configured.kilo,
            },
            opencode: {
              ...settings.providers.opencode,
              serverPasswordConfigured: configured.opencode,
            },
          },
        }),
      ),
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            detail: "failed to read provider credential state",
            cause,
          }),
      ),
    );

  const loadSettingsFromDisk = Effect.gen(function* () {
    const exists = yield* fs.exists(settingsPath).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            detail: "failed to check settings file existence",
            cause,
          }),
      ),
    );
    if (!exists) {
      return {
        settings: yield* withCredentialState(DEFAULT_SERVER_SETTINGS),
        revision: 0,
        migrated: false,
      };
    }

    const raw = yield* fs.readFileString(settingsPath).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            detail: "failed to read settings file",
            cause,
          }),
      ),
    );
    const decoded = decodeSettingsFromJson(settingsPath, raw);
    if (decoded._tag === "Failure") {
      const quarantinePath = `${settingsPath}.invalid-${Date.now()}`;
      yield* fs.rename(settingsPath, quarantinePath).pipe(Effect.catch(() => Effect.void));
      yield* Effect.logWarning("quarantined invalid settings.json, using defaults", {
        path: settingsPath,
        quarantinePath,
        error: decoded.error,
      });
      return {
        settings: yield* withCredentialState(DEFAULT_SERVER_SETTINGS),
        revision: 0,
        migrated: false,
      };
    }
    const legacyPasswords = readLegacyProviderPasswords(raw);
    yield* Effect.forEach(
      legacyPasswords,
      ([provider, password]) => providerCredentials.replaceServerPassword(provider, password),
      { discard: true },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            detail: "failed to migrate provider credentials",
            cause,
          }),
      ),
    );
    return {
      settings: yield* withCredentialState(decoded.value),
      revision: decoded.revision,
      migrated:
        legacyPasswords.size > 0 ||
        decoded.legacyFormat ||
        decoded.migrationVersion !== SERVER_SETTINGS_MIGRATION_VERSION,
    };
  });

  const writeSettingsAtomically = (snapshot: ServerSettingsSnapshot) => {
    return writeFileStringAtomically({
      filePath: settingsPath,
      contents: `${JSON.stringify(snapshot, null, 2)}\n`,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            detail: "failed to write settings file",
            cause,
          }),
      ),
    );
  };

  const start = Effect.gen(function* () {
    const shouldStart = yield* Ref.modify(startedRef, (started) => [!started, true]);
    if (!shouldStart) {
      return yield* Deferred.await(startedDeferred);
    }

    const startup = Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(settingsPath), { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ServerSettingsError({
              settingsPath,
              detail: "failed to prepare settings directory",
              cause,
            }),
        ),
      );
      const loaded = yield* loadSettingsFromDisk;
      if (loaded.migrated) {
        loaded.revision += 1;
        yield* writeSettingsAtomically({
          revision: loaded.revision,
          migrationVersion: SERVER_SETTINGS_MIGRATION_VERSION,
          settings: loaded.settings,
        });
      }
      yield* Ref.set(settingsRef, loaded.settings);
      yield* Ref.set(revisionRef, loaded.revision);
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  const getSettings = Ref.get(settingsRef).pipe(Effect.map(resolveTextGenerationProvider));
  const updateSettings = (patch: ServerSettingsPatch) =>
    writeSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const disk = yield* loadSettingsFromDisk;
        // Merge against the RAW persisted row (see the layerTest comment): an
        // unrelated/options-only/empty selection patch must never disturb the
        // persisted pair (a temporary disabled-provider fallback alone never
        // changes persistence; provider.enabled toggles and password changes
        // must not silently replace the persisted pair with the fallback view).
        // Only a deliberate provider/model edit resolves against the EFFECTIVE
        // view (the disabled-provider fallback the UI displays): the resolved
        // pair then replaces the persisted one, attributed to the provider the
        // user is looking at.
        const current = disk.settings;
        for (const provider of EXTERNAL_SERVER_PROVIDERS) {
          const password = patch.providers?.[provider]?.serverPassword;
          if (password !== undefined) {
            yield* providerCredentials.replaceServerPassword(provider, password).pipe(
              Effect.mapError(
                (cause) =>
                  new ServerSettingsError({
                    settingsPath,
                    detail: `failed to update ${provider} server password`,
                    cause,
                  }),
              ),
            );
          }
        }
        const normalized = yield* normalizeSettings(
          settingsPath,
          current,
          omitProviderPasswords(patch),
          resolveTextGenerationProvider(current),
        );
        const next = yield* withCredentialState(normalized);
        const nextRevision = Math.max(disk.revision, yield* Ref.get(revisionRef)) + 1;
        yield* writeSettingsAtomically({
          revision: nextRevision,
          migrationVersion: SERVER_SETTINGS_MIGRATION_VERSION,
          settings: next,
        });
        yield* Ref.set(settingsRef, next);
        yield* Ref.set(revisionRef, nextRevision);
        yield* emitChange(next);
        return resolveTextGenerationProvider(next);
      }),
    );

  return {
    start,
    ready: Deferred.await(startedDeferred),
    getSettings,
    getSettingsView: getSettings.pipe(Effect.map(toServerSettingsView)),
    getSnapshot: Effect.all({ revision: Ref.get(revisionRef), settings: getSettings }).pipe(
      Effect.map(({ revision, settings }) => ({
        revision,
        migrationVersion: SERVER_SETTINGS_MIGRATION_VERSION,
        settings,
      })),
    ),
    updateSettings,
    updateSettingsView: (patch) => updateSettings(patch).pipe(Effect.map(toServerSettingsView)),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub).pipe(Stream.map(resolveTextGenerationProvider));
    },
    get streamViews() {
      return Stream.fromPubSub(changesPubSub).pipe(
        Stream.map(resolveTextGenerationProvider),
        Stream.map(toServerSettingsView),
      );
    },
  } satisfies ServerSettingsShape;
});

export const ServerSettingsLive = Layer.effect(ServerSettingsService, makeServerSettings).pipe(
  Layer.provide(ProviderCredentialsLive),
);

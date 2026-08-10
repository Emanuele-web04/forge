import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_PROVIDER_PROFILE_ID,
  NonNegativeInt,
  ProviderProfileDisplayName,
  ProviderProfileId,
  type CodexProviderProfileSummary,
  type CodexServerProviderSettings,
  type CodexProviderTarget,
  type ProviderProfilesSnapshot,
} from "@synara/contracts";
import { Effect, Layer, Ref, Schema } from "effect";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../../atomicWrite";
import { ServerConfig } from "../../config";
import {
  PRIVATE_FILE_MODE,
  supportsPosixPermissions,
} from "../../privatePathPermissions";
import { ServerSettingsService } from "../../serverSettings";
import {
  materializeCodexManagedProfileHome,
  isCodexProfileStorageKey,
} from "../codexManagedProfileHome";
import {
  makeLegacyCodexLaunchContext,
  makeManagedCodexLaunchContext,
} from "../codexProviderLaunchContext";
import {
  ProviderProfileRegistry,
  ProviderProfileRegistryError,
  type ProviderProfileRegistryErrorCode,
  type ProviderProfileRegistryShape,
} from "../Services/ProviderProfileRegistry";

const REGISTRY_VERSION = 2;
const DEFAULT_PROFILE_DISPLAY_NAME = "Default";

const StorageKey = Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/u));
const CanonicalIsoInstant = Schema.String.check(
  Schema.makeFilter((value: string) => {
    try {
      return new Date(value).toISOString() === value;
    } catch {
      return false;
    }
  }),
);

const StoredCodexProfileV1 = Schema.Struct({
  profileId: ProviderProfileId,
  storageKey: StorageKey,
  displayName: ProviderProfileDisplayName,
  enabled: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  tombstonedAt: Schema.NullOr(Schema.String),
});

const StoredCodexProfile = Schema.Struct({
  profileId: ProviderProfileId,
  storageKey: StorageKey,
  displayName: ProviderProfileDisplayName,
  enabled: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  tombstonedAt: Schema.NullOr(Schema.String),
  authenticationBoundAt: Schema.NullOr(CanonicalIsoInstant),
});
type StoredCodexProfile = typeof StoredCodexProfile.Type;

const StoredProviderProfileRegistryV1 = Schema.Struct({
  version: Schema.Literal(1),
  revision: NonNegativeInt,
  profiles: Schema.Array(StoredCodexProfileV1),
});

const StoredProviderProfileRegistry = Schema.Struct({
  version: Schema.Literal(REGISTRY_VERSION),
  revision: NonNegativeInt,
  profiles: Schema.Array(StoredCodexProfile),
});
type StoredProviderProfileRegistry = typeof StoredProviderProfileRegistry.Type;

const PersistedProviderProfileRegistry = Schema.Union([
  StoredProviderProfileRegistryV1,
  StoredProviderProfileRegistry,
]);

type ActiveProfileInspection = Readonly<{
  state: StoredProviderProfileRegistry;
  target: CodexProviderTarget;
  settingsRevision: number;
  codexSettings: CodexServerProviderSettings;
  providerEnabled: boolean;
  profile: StoredCodexProfile | null;
  summary: CodexProviderProfileSummary;
}>;

function registryError(
  code: ProviderProfileRegistryErrorCode,
  message: string,
  cause?: unknown,
): ProviderProfileRegistryError {
  return new ProviderProfileRegistryError({
    code,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function registryAttempt<A>(operation: () => A): Effect.Effect<A, ProviderProfileRegistryError> {
  return Effect.try({
    try: operation,
    catch: (cause) =>
      cause instanceof ProviderProfileRegistryError
        ? cause
        : registryError(
            "PROVIDER_PROFILE_REGISTRY_INVALID",
            "The Codex provider profile registry is invalid.",
            cause,
          ),
  });
}

function assertValidRegistry(state: StoredProviderProfileRegistry): StoredProviderProfileRegistry {
  const profileIds = new Set<string>();
  const storageKeys = new Set<string>();
  const activeDisplayNames = new Set([normalizedDisplayName(DEFAULT_PROFILE_DISPLAY_NAME)]);
  for (const profile of state.profiles) {
    const normalizedName = normalizedDisplayName(profile.displayName);
    if (
      profile.profileId === DEFAULT_PROVIDER_PROFILE_ID ||
      profileIds.has(profile.profileId) ||
      storageKeys.has(profile.storageKey) ||
      !isCodexProfileStorageKey(profile.storageKey) ||
      (profile.tombstonedAt !== null && profile.enabled) ||
      (profile.tombstonedAt === null &&
        profile.enabled &&
        profile.authenticationBoundAt === null) ||
      (profile.tombstonedAt === null && activeDisplayNames.has(normalizedName))
    ) {
      throw registryError(
        "PROVIDER_PROFILE_REGISTRY_INVALID",
        "The Codex provider profile registry is invalid.",
      );
    }
    profileIds.add(profile.profileId);
    storageKeys.add(profile.storageKey);
    if (profile.tombstonedAt === null) activeDisplayNames.add(normalizedName);
  }
  return state;
}

function managedSummary(profile: StoredCodexProfile): CodexProviderProfileSummary {
  return {
    target: { provider: "codex", profileId: profile.profileId },
    displayName: profile.displayName,
    enabled: profile.enabled,
    lifecycle: profile.tombstonedAt === null ? "active" : "tombstoned",
    storageKind: "managed",
  };
}

function findProfile(
  state: StoredProviderProfileRegistry,
  target: CodexProviderTarget,
): StoredCodexProfile {
  const profile = state.profiles.find((candidate) => candidate.profileId === target.profileId);
  if (!profile) {
    throw registryError(
      "PROVIDER_PROFILE_NOT_FOUND",
      `Codex provider profile '${target.profileId}' was not found.`,
    );
  }
  return profile;
}

function assertManagedTarget(target: CodexProviderTarget): void {
  if (target.profileId === DEFAULT_PROVIDER_PROFILE_ID) {
    throw registryError(
      "PROVIDER_PROFILE_DEFAULT_IMMUTABLE",
      "The default Codex profile is managed by the existing provider settings.",
    );
  }
}

function assertActive(profile: StoredCodexProfile): void {
  if (profile.tombstonedAt !== null) {
    throw registryError(
      "PROVIDER_PROFILE_TOMBSTONED",
      `Codex provider profile '${profile.profileId}' has been removed.`,
    );
  }
}

function assertAuthenticationBound(profile: StoredCodexProfile): void {
  if (profile.authenticationBoundAt !== null) return;
  throw registryError(
    "PROVIDER_PROFILE_AUTHENTICATION_UNBOUND",
    `Codex provider profile '${profile.profileId}' has not completed account login.`,
  );
}

function migrateRegistry(
  state: typeof PersistedProviderProfileRegistry.Type,
): { readonly state: StoredProviderProfileRegistry; readonly migrated: boolean } {
  if (state.version === REGISTRY_VERSION) return { state, migrated: false };
  if (state.profiles.some((profile) => profile.tombstonedAt !== null && profile.enabled)) {
    throw registryError(
      "PROVIDER_PROFILE_REGISTRY_INVALID",
      "The Codex provider profile registry is invalid.",
    );
  }
  return {
    migrated: true,
    state: {
      version: REGISTRY_VERSION,
      revision: state.revision + 1,
      profiles: state.profiles.map((profile) => ({
        ...profile,
        enabled: false,
        authenticationBoundAt: null,
      })),
    },
  };
}

function normalizedDisplayName(displayName: string): string {
  return displayName.toLowerCase();
}

function assertDisplayNameAvailable(
  state: StoredProviderProfileRegistry,
  displayName: string,
  exceptProfileId?: string,
): void {
  const normalized = normalizedDisplayName(displayName);
  const conflictsWithDefault = normalized === normalizedDisplayName(DEFAULT_PROFILE_DISPLAY_NAME);
  const conflictsWithManaged = state.profiles.some(
    (profile) =>
      profile.profileId !== exceptProfileId &&
      profile.tombstonedAt === null &&
      normalizedDisplayName(profile.displayName) === normalized,
  );
  if (conflictsWithDefault || conflictsWithManaged) {
    throw registryError(
      "PROVIDER_PROFILE_NAME_CONFLICT",
      `An active Codex provider profile already uses the name '${displayName}'.`,
    );
  }
}

function makeIdentifiers(state: StoredProviderProfileRegistry): {
  readonly profileId: ProviderProfileId;
  readonly storageKey: string;
} {
  while (true) {
    const profileKey = randomUUID();
    const storageKey = randomUUID();
    const profileId = ProviderProfileId.makeUnsafe(`codex_${profileKey.replaceAll("-", "")}`);
    if (
      !state.profiles.some(
        (profile) => profile.profileId === profileId || profile.storageKey === storageKey,
      )
    ) {
      return { profileId, storageKey };
    }
  }
}

export const makeProviderProfileRegistry = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const lock = yield* Semaphore.make(1);
  const stateRef = yield* Ref.make<StoredProviderProfileRegistry | null>(null);
  const profilesRoot = path.join(config.stateDir, "provider-profiles");
  const indexPath = path.join(profilesRoot, "index.json");

  const persist = (state: StoredProviderProfileRegistry) =>
    Effect.uninterruptible(
      writeFileStringAtomically({
        filePath: indexPath,
        contents: `${JSON.stringify(state, null, 2)}\n`,
      }).pipe(
        Effect.mapError((cause) =>
          registryError(
            "PROVIDER_PROFILE_STORAGE_ERROR",
            "Could not save the Codex provider profile registry.",
            cause,
          ),
        ),
        // The in-memory publication and disk rename are one transaction. An
        // interrupt between them would let a later mutation overwrite a state
        // that was already durably committed.
        Effect.andThen(Ref.set(stateRef, state)),
      ),
    );

  const readRegistry = Effect.tryPromise({
    try: async () => {
      let handle: fs.FileHandle | undefined;
      try {
        const noFollowFlag = supportsPosixPermissions() ? fsConstants.O_NOFOLLOW : 0;
        handle = await fs.open(indexPath, fsConstants.O_RDONLY | noFollowFlag);
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error("Provider profile registry is not a regular file.");
        if (supportsPosixPermissions()) await handle.chmod(PRIVATE_FILE_MODE);
        return await handle.readFile("utf8");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw cause;
      } finally {
        await handle?.close();
      }
    },
    catch: (cause) =>
      registryError(
        "PROVIDER_PROFILE_STORAGE_ERROR",
        "Could not read the Codex provider profile registry.",
        cause,
      ),
  }).pipe(
    Effect.flatMap((contents) => {
      if (contents === null) {
        return Effect.succeed({
          state: {
            version: REGISTRY_VERSION,
            revision: 0,
            profiles: [],
          } satisfies StoredProviderProfileRegistry,
          migrated: false,
        });
      }
      return Effect.try({
        try: () => JSON.parse(contents) as unknown,
        catch: (cause) =>
          registryError(
            "PROVIDER_PROFILE_REGISTRY_INVALID",
            "The Codex provider profile registry is invalid.",
            cause,
          ),
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(PersistedProviderProfileRegistry)),
        Effect.flatMap((state) =>
          registryAttempt(() => {
            const migration = migrateRegistry(state);
            return {
              ...migration,
              state: assertValidRegistry(migration.state),
            };
          }),
        ),
        Effect.mapError((cause) =>
          cause instanceof ProviderProfileRegistryError
            ? cause
            : registryError(
                "PROVIDER_PROFILE_REGISTRY_INVALID",
                "The Codex provider profile registry is invalid.",
                cause,
              ),
        ),
      );
    }),
  );

  const loadState = Ref.get(stateRef).pipe(
    Effect.flatMap((cached) =>
      cached === null
        ? readRegistry.pipe(
            Effect.flatMap(({ state, migrated }) =>
              migrated
                ? persist(state).pipe(Effect.as(state))
                : Ref.set(stateRef, state).pipe(Effect.as(state)),
            ),
          )
        : Effect.succeed(cached),
    ),
  );

  const getSettingsSnapshot = serverSettings.getSnapshot.pipe(
    Effect.mapError((cause) =>
      registryError(
        "PROVIDER_PROFILE_STORAGE_ERROR",
        "Could not read the Codex provider settings.",
        cause,
      ),
    ),
  );

  const snapshot = (state: StoredProviderProfileRegistry) =>
    getSettingsSnapshot.pipe(
      Effect.map(
        ({ settings }): ProviderProfilesSnapshot => ({
          providerEnabled: settings.providers.codex.enabled,
          profiles: [
            {
              target: { provider: "codex", profileId: DEFAULT_PROVIDER_PROFILE_ID },
              displayName: DEFAULT_PROFILE_DISPLAY_NAME,
              enabled: true,
              lifecycle: "active",
              storageKind: "legacy-default",
            },
            ...state.profiles.map(managedSummary),
          ],
        }),
      ),
    );

  const list: ProviderProfileRegistryShape["list"] = () =>
    lock.withPermits(1)(loadState.pipe(Effect.flatMap(snapshot)));

  const create: ProviderProfileRegistryShape["create"] = (input) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* loadState;
        yield* registryAttempt(() => assertDisplayNameAvailable(state, input.displayName));
        const { profileId, storageKey } = makeIdentifiers(state);
        // Prepare storage before publishing the record. If the later atomic
        // index write fails, the unique directory is an inert orphan; the
        // inverse ordering could publish an executable profile whose home was
        // never made private. We deliberately do not delete here because a
        // failed durability boundary must not trigger recursive cleanup.
        yield* Effect.try({
          try: () => materializeCodexManagedProfileHome({ profilesRoot, storageKey }),
          catch: (cause) =>
            registryError(
              "PROVIDER_PROFILE_STORAGE_ERROR",
              "Could not prepare private storage for the Codex provider profile.",
              cause,
            ),
        });
        const timestamp = new Date().toISOString();
        const nextState: StoredProviderProfileRegistry = {
          ...state,
          revision: state.revision + 1,
          profiles: [
            ...state.profiles,
            {
              profileId,
              storageKey,
              displayName: input.displayName,
              enabled: false,
              createdAt: timestamp,
              updatedAt: timestamp,
              tombstonedAt: null,
              authenticationBoundAt: null,
            },
          ],
        };
        yield* persist(nextState);
        return yield* snapshot(nextState);
      }),
    );

  const rename: ProviderProfileRegistryShape["rename"] = (input) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        yield* registryAttempt(() => assertManagedTarget(input.target));
        const state = yield* loadState;
        const profile = yield* registryAttempt(() => findProfile(state, input.target));
        yield* registryAttempt(() => assertActive(profile));
        if (profile.displayName === input.displayName) return yield* snapshot(state);
        yield* registryAttempt(() =>
          assertDisplayNameAvailable(state, input.displayName, profile.profileId),
        );
        const nextState: StoredProviderProfileRegistry = {
          ...state,
          revision: state.revision + 1,
          profiles: state.profiles.map((candidate) =>
            candidate.profileId === profile.profileId
              ? {
                  ...candidate,
                  displayName: input.displayName,
                  updatedAt: new Date().toISOString(),
                }
              : candidate,
          ),
        };
        yield* persist(nextState);
        return yield* snapshot(nextState);
      }),
    );

  const setEnabled: ProviderProfileRegistryShape["setEnabled"] = (input) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        yield* registryAttempt(() => assertManagedTarget(input.target));
        const state = yield* loadState;
        const profile = yield* registryAttempt(() => findProfile(state, input.target));
        yield* registryAttempt(() => assertActive(profile));
        if (input.enabled) {
          yield* registryAttempt(() => assertAuthenticationBound(profile));
        }
        if (profile.enabled === input.enabled) return yield* snapshot(state);
        const nextState: StoredProviderProfileRegistry = {
          ...state,
          revision: state.revision + 1,
          profiles: state.profiles.map((candidate) =>
            candidate.profileId === profile.profileId
              ? { ...candidate, enabled: input.enabled, updatedAt: new Date().toISOString() }
              : candidate,
          ),
        };
        yield* persist(nextState);
        return yield* snapshot(nextState);
      }),
    );

  const tombstone: ProviderProfileRegistryShape["tombstone"] = (input) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        yield* registryAttempt(() => assertManagedTarget(input.target));
        const state = yield* loadState;
        const profile = yield* registryAttempt(() => findProfile(state, input.target));
        if (profile.tombstonedAt !== null) return yield* snapshot(state);
        const timestamp = new Date().toISOString();
        const nextState: StoredProviderProfileRegistry = {
          ...state,
          revision: state.revision + 1,
          profiles: state.profiles.map((candidate) =>
            candidate.profileId === profile.profileId
              ? {
                  ...candidate,
                  enabled: false,
                  updatedAt: timestamp,
                  tombstonedAt: timestamp,
                }
              : candidate,
          ),
        };
        yield* persist(nextState);
        return yield* snapshot(nextState);
      }),
    );

  const inspectActiveProfile = (
    state: StoredProviderProfileRegistry,
    target: CodexProviderTarget,
  ): Effect.Effect<ActiveProfileInspection, ProviderProfileRegistryError> =>
    Effect.gen(function* () {
      const { revision: settingsRevision, settings } = yield* getSettingsSnapshot;
      const providerEnabled = settings.providers.codex.enabled;
      if (target.profileId === DEFAULT_PROVIDER_PROFILE_ID) {
        return {
          state,
          target,
          settingsRevision,
          codexSettings: settings.providers.codex,
          providerEnabled,
          profile: null,
          summary: {
            target,
            displayName: DEFAULT_PROFILE_DISPLAY_NAME,
            enabled: true,
            lifecycle: "active",
            storageKind: "legacy-default",
          } satisfies CodexProviderProfileSummary,
        } as const;
      }

      const profile = yield* registryAttempt(() => findProfile(state, target));
      yield* registryAttempt(() => assertActive(profile));
      return {
        state,
        target,
        settingsRevision,
        codexSettings: settings.providers.codex,
        providerEnabled,
        profile,
        summary: managedSummary(profile),
      } as const;
    });

  const materializeResolvedProfile = Effect.fnUntraced(function* (
    inspection: ActiveProfileInspection,
  ) {
    if (inspection.profile === null) {
      return {
        summary: inspection.summary,
        providerEnabled: inspection.providerEnabled,
        launchContext: makeLegacyCodexLaunchContext({
          target: inspection.target,
          binaryPath: inspection.codexSettings.binaryPath,
          sourceHomePath: inspection.codexSettings.homePath.trim() || null,
          settingsRevision: inspection.settingsRevision,
          registryRevision: inspection.state.revision,
        }),
      };
    }

    const home = yield* Effect.try({
      try: () =>
        materializeCodexManagedProfileHome({
          profilesRoot,
          storageKey: inspection.profile.storageKey,
        }),
      catch: (cause) =>
        registryError(
          "PROVIDER_PROFILE_STORAGE_ERROR",
          "Could not prepare private storage for the Codex provider profile.",
          cause,
        ),
    });
    return {
      summary: inspection.summary,
      providerEnabled: inspection.providerEnabled,
      launchContext: makeManagedCodexLaunchContext({
        target: inspection.target,
        binaryPath: inspection.codexSettings.binaryPath,
        settingsRevision: inspection.settingsRevision,
        registryRevision: inspection.state.revision,
        authenticationBoundAt: inspection.profile.authenticationBoundAt,
        continuationNamespaceId: inspection.profile.storageKey,
        ...home,
      }),
    };
  });

  const resolveForManagement: ProviderProfileRegistryShape["resolveForManagement"] = (target) =>
    lock.withPermits(1)(
      loadState.pipe(
        Effect.flatMap((state) => inspectActiveProfile(state, target)),
        Effect.flatMap(materializeResolvedProfile),
      ),
    );

  const resolveForRuntime: ProviderProfileRegistryShape["resolveForRuntime"] = (target) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* loadState;
        const inspection = yield* inspectActiveProfile(state, target);
        if (!inspection.providerEnabled) {
          return yield* registryError(
            "PROVIDER_PROFILE_DISABLED",
            "The Codex provider is disabled in Synara settings.",
          );
        }
        if (!inspection.summary.enabled) {
          return yield* registryError(
            "PROVIDER_PROFILE_DISABLED",
            `Codex provider profile '${inspection.target.profileId}' is disabled.`,
          );
        }
        if (inspection.profile !== null) {
          yield* registryAttempt(() => assertAuthenticationBound(inspection.profile!));
        }
        return yield* materializeResolvedProfile(inspection);
      }),
    );

  const sealManagedAuthentication: ProviderProfileRegistryShape["sealManagedAuthentication"] =
    (target) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          yield* registryAttempt(() => assertManagedTarget(target));
          const state = yield* loadState;
          const profile = yield* registryAttempt(() => findProfile(state, target));
          yield* registryAttempt(() => assertActive(profile));
          if (profile.authenticationBoundAt !== null) return;
          const timestamp = new Date().toISOString();
          const nextState: StoredProviderProfileRegistry = {
            ...state,
            revision: state.revision + 1,
            profiles: state.profiles.map((candidate) =>
              candidate.profileId === profile.profileId
                ? {
                    ...candidate,
                    authenticationBoundAt: timestamp,
                    updatedAt: timestamp,
                  }
                : candidate,
            ),
          };
          yield* persist(nextState);
        }),
      );

  return {
    list,
    create,
    rename,
    setEnabled,
    tombstone,
    sealManagedAuthentication,
    resolveForManagement,
    resolveForRuntime,
  } satisfies ProviderProfileRegistryShape;
});

export const ProviderProfileRegistryLive = Layer.effect(
  ProviderProfileRegistry,
  makeProviderProfileRegistry,
);

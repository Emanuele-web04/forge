/**
 * Provider status cache helpers.
 *
 * Keeps provider readiness snapshots durable across restarts without making
 * the cache authoritative over fresh CLI probes.
 *
 * @module providerStatusCache
 */
import { ServerProviderStatus } from "@synara/contracts";
import { Cause, Effect, FileSystem, Schema } from "effect";
import { writeFileStringAtomically } from "../atomicWrite";

const PROVIDER_STATUS_CACHE_IDS = [
  "codex",
  "claudeAgent",
  "cursor",
  "antigravity",
  "grok",
  "droid",
  "devin",
  "kilo",
  "opencode",
  "pi",
] as const satisfies ReadonlyArray<ServerProviderStatus["provider"]>;

const decodeProviderStatusCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ServerProviderStatus),
);

const providerOrderRank = (provider: ServerProviderStatus["provider"]): number => {
  const rank = PROVIDER_STATUS_CACHE_IDS.indexOf(provider);
  return rank === -1 ? Number.MAX_SAFE_INTEGER : rank;
};

export const orderProviderStatuses = (
  providers: ReadonlyArray<ServerProviderStatus>,
): ReadonlyArray<ServerProviderStatus> =>
  [...providers].toSorted(
    (left, right) => providerOrderRank(left.provider) - providerOrderRank(right.provider),
  );

export function resolveProviderStatusCachePath(input: {
  readonly stateDir: string;
  readonly provider: ServerProviderStatus["provider"];
}): string {
  return `${input.stateDir}/provider-status/${input.provider}.json`;
}

// Ignore unreadable or malformed cache entries so the server can still boot
// and fall back to fresh probes or empty state.
export const readProviderStatusCache = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return undefined;
    }

    const raw = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    return yield* decodeProviderStatusCache(trimmed).pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          Effect.logWarning("failed to parse provider status cache, ignoring", {
            path: filePath,
            issues: Cause.pretty(cause),
          }).pipe(Effect.as(undefined)),
        onSuccess: Effect.succeed,
      }),
    );
  });

export const writeProviderStatusCache = (input: {
  readonly filePath: string;
  readonly provider: ServerProviderStatus;
}) => {
  return writeFileStringAtomically({
    filePath: input.filePath,
    contents: `${JSON.stringify(input.provider, null, 2)}\n`,
  });
};

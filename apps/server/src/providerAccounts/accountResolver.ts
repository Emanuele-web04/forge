import {
  type ResolveAccountLaunchInput,
  type ResolvedAccountLaunch,
  type SupportedAccountProvider,
} from "@synara/contracts";
import { supportLevelFor } from "@synara/shared/providerAccounts/capabilities";
import { accountAgentHome, accountAppDataDir } from "@synara/shared/providerAccounts/accountPaths";
import { Data, Effect } from "effect";

import type { AccountEnvironmentBuilder } from "@synara/shared/providerAccounts/accountEnvironment";
import { accountEnvironmentBuilders } from "@synara/shared/providerAccounts/accountEnvironmentBuilders";
import type { AccountStorageShape, ProviderAccountStorageError } from "./accountStorage";

export class ProviderAccountResolutionError extends Data.TaggedError(
  "ProviderAccountResolutionError",
)<{
  readonly code:
    | "account-not-found"
    | "binding-unavailable"
    | "binding-conflict"
    | "generation-mismatch";
  readonly detail: string;
}> {}

// Account 0 is the native provider account: no managed environment, no
// generation tracking. `generation` is pinned to 1 to satisfy the contract.
const NATIVE_GENERATION = 1;

export interface AccountResolverInput {
  readonly storage: AccountStorageShape;
  readonly environmentBuilders?: Record<SupportedAccountProvider, AccountEnvironmentBuilder>;
}

export type AccountResolverShape = ReturnType<typeof makeAccountResolver>;

export function makeAccountResolver(input: AccountResolverInput) {
  const { storage } = input;
  const environmentBuilders = input.environmentBuilders ?? accountEnvironmentBuilders;

  const resolveAccountLaunch = (
    launchInput: ResolveAccountLaunchInput,
  ): Effect.Effect<
    ResolvedAccountLaunch,
    ProviderAccountResolutionError | ProviderAccountStorageError
  > =>
    Effect.gen(function* () {
      const { provider, surface } = launchInput;
      // A thread already bound to one account must never be silently launched
      // with another: an explicit selection that conflicts with the persisted
      // binding fails closed instead of being overridden either way.
      if (
        launchInput.explicitOrdinal !== undefined &&
        launchInput.threadBinding !== undefined &&
        launchInput.threadBinding.ordinal !== launchInput.explicitOrdinal
      ) {
        return yield* new ProviderAccountResolutionError({
          code: "binding-conflict",
          detail: `This thread is already bound to '${provider}' account ${launchInput.threadBinding.ordinal}; it cannot be launched with account ${launchInput.explicitOrdinal}. Start a new thread to use a different account.`,
        });
      }
      const ordinal =
        launchInput.threadBinding?.ordinal ??
        launchInput.explicitOrdinal ??
        (yield* storage.readActiveOrdinal(provider)) ??
        0;

      if (ordinal === 0) {
        return {
          provider,
          ordinal: 0,
          generation: NATIVE_GENERATION,
          surface,
          environment: {},
          supportLevel: "supported",
        } satisfies ResolvedAccountLaunch;
      }

      // A selected managed account must never silently fall back to another
      // account: every failure below is fail-closed.
      const account = yield* storage.readAccount(provider, ordinal);
      if (account === null) {
        return yield* new ProviderAccountResolutionError({
          code: "account-not-found",
          detail: `Account '${provider}' ordinal ${ordinal} does not exist.`,
        });
      }

      const binding = surface === "agent" ? account.agent : account.app;
      if (binding === undefined || binding.state !== "connected") {
        return yield* new ProviderAccountResolutionError({
          code: "binding-unavailable",
          detail: `Account '${provider}' ordinal ${ordinal} has no connected ${surface} binding${binding !== undefined ? ` (state '${binding.state}')` : ""}.`,
        });
      }

      if (
        launchInput.threadBinding !== undefined &&
        launchInput.threadBinding.agentGeneration !== binding.generation
      ) {
        return yield* new ProviderAccountResolutionError({
          code: "generation-mismatch",
          detail: `Account '${provider}' ordinal ${ordinal} ${surface} binding generation ${binding.generation} does not match the thread binding generation ${launchInput.threadBinding.agentGeneration}. Re-select the account to continue.`,
        });
      }

      const builder = environmentBuilders[provider];
      const authMethod = binding.authMethod;
      const apiKey =
        surface === "agent" && authMethod === "apiKey"
          ? yield* storage.readSecret(provider, ordinal, "agent")
          : null;
      if (surface === "agent" && authMethod === "apiKey" && apiKey === null) {
        return yield* new ProviderAccountResolutionError({
          code: "binding-unavailable",
          detail: `Account '${provider}' ordinal ${ordinal} is missing its stored API key. Reconnect the account.`,
        });
      }

      const launchEnvironment = builder({
        provider,
        ordinal,
        surface,
        authMethod,
        agentHome: accountAgentHome(storage.root, provider, ordinal),
        appDataDir: accountAppDataDir(storage.root, provider, ordinal),
        ...(apiKey !== null ? { apiKey } : {}),
      });

      return {
        provider,
        ordinal,
        generation: binding.generation,
        surface,
        environment: launchEnvironment.environment,
        profilePath: launchEnvironment.profilePath,
        supportLevel: supportLevelFor(provider, surface, authMethod),
      } satisfies ResolvedAccountLaunch;
    });

  return { resolveAccountLaunch };
}

import { spawn } from "node:child_process";

import type {
  AppProcessLease,
  ProviderAppLaunchPlan,
  SupportedAccountProvider,
} from "@synara/contracts";
import { accountAppDataDir } from "@synara/shared/providerAccounts/accountPaths";
import { Data, Effect } from "effect";

import { applyAccountEnvironmentOverrides } from "@synara/shared/providerAccounts/accountEnvironment";
import type { AccountResolverShape } from "./accountResolver";
import type { AccountStorageShape } from "./accountStorage";

export class ProviderAppLaunchError extends Data.TaggedError("ProviderAppLaunchError")<{
  readonly code: "app-launch-unsupported" | "spawn-failed";
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export interface ProviderAppLaunchSpecInput {
  readonly provider: SupportedAccountProvider;
  readonly ordinal: number;
  readonly appDataDir: string;
}

export interface ProviderAppLaunchSpec {
  readonly executable: string;
  readonly args?: ReadonlyArray<string>;
}

export type ProviderAppLaunchSpecResolver = (
  input: ProviderAppLaunchSpecInput,
) => ProviderAppLaunchSpec | undefined;

// Providers register their desktop app spec from their own module; adding a
// provider never edits a central switch.
const specResolvers = new Map<SupportedAccountProvider, ProviderAppLaunchSpecResolver>();

export function registerProviderAppLaunchSpec(
  provider: SupportedAccountProvider,
  resolver: ProviderAppLaunchSpecResolver,
): void {
  specResolvers.set(provider, resolver);
}

export function resolveProviderAppLaunchSpec(
  provider: SupportedAccountProvider,
): ProviderAppLaunchSpecResolver | undefined {
  return specResolvers.get(provider);
}

export interface PlanAppLaunchInput {
  readonly provider: SupportedAccountProvider;
  readonly explicitOrdinal?: number;
}

export interface SpawnedAppProcess {
  readonly pid: number | undefined;
}

export type AppProcessSpawner = (plan: ProviderAppLaunchPlan) => SpawnedAppProcess;

/**
 * Starts the desktop app as a detached, fully disowned child: the server
 * process must never supervise or outlive-couple to the official app.
 */
const spawnDetached: AppProcessSpawner = (plan) => {
  const child = spawn(plan.executable, [...plan.args], {
    detached: true,
    stdio: "ignore",
    env: applyAccountEnvironmentOverrides({ ...process.env }, plan.environment),
  });
  child.unref();
  return { pid: child.pid };
};

export interface AppLaunchInput {
  readonly storage: AccountStorageShape;
  readonly resolver: AccountResolverShape;
  readonly spawnProcess?: AppProcessSpawner;
  readonly now?: () => string;
}

export type AppLaunchShape = ReturnType<typeof makeAppLaunch>;

export function makeAppLaunch(input: AppLaunchInput) {
  const { storage, resolver } = input;
  const spawnProcess = input.spawnProcess ?? spawnDetached;
  const now = input.now ?? (() => new Date().toISOString());

  const planAppLaunch = (planInput: PlanAppLaunchInput) =>
    Effect.gen(function* () {
      const resolved = yield* resolver.resolveAccountLaunch({
        provider: planInput.provider,
        surface: "app",
        ...(planInput.explicitOrdinal !== undefined
          ? { explicitOrdinal: planInput.explicitOrdinal }
          : {}),
      });
      const specResolver = resolveProviderAppLaunchSpec(resolved.provider);
      const spec = specResolver?.({
        provider: resolved.provider,
        ordinal: resolved.ordinal,
        appDataDir: accountAppDataDir(storage.root, resolved.provider, resolved.ordinal),
      });
      if (spec === undefined) {
        return yield* new ProviderAppLaunchError({
          code: "app-launch-unsupported",
          detail: `Desktop app launch is not available for provider '${resolved.provider}'.`,
        });
      }
      const account =
        resolved.ordinal > 0
          ? yield* storage.readAccount(resolved.provider, resolved.ordinal)
          : null;
      const expectedAppVersion = account?.app?.lastVerifiedAppVersion;
      return {
        provider: resolved.provider,
        ordinal: resolved.ordinal,
        appGeneration: resolved.generation,
        executable: spec.executable,
        args: spec.args ?? [],
        environment: resolved.environment,
        supportLevel: resolved.supportLevel,
        ...(expectedAppVersion !== undefined ? { expectedAppVersion } : {}),
      } satisfies ProviderAppLaunchPlan;
    });

  const launchApp = (plan: ProviderAppLaunchPlan) =>
    Effect.gen(function* () {
      const spawned = yield* Effect.try({
        try: () => spawnProcess(plan),
        catch: (cause) =>
          new ProviderAppLaunchError({
            code: "spawn-failed",
            detail: `Failed to start '${plan.executable}' for '${plan.provider}' ordinal ${plan.ordinal}.`,
            cause,
          }),
      });
      if (spawned.pid === undefined || spawned.pid < 1) {
        return yield* new ProviderAppLaunchError({
          code: "spawn-failed",
          detail: `'${plan.executable}' for '${plan.provider}' ordinal ${plan.ordinal} did not report a process id.`,
        });
      }
      const lease: AppProcessLease = {
        provider: plan.provider,
        ordinal: plan.ordinal,
        appGeneration: plan.appGeneration,
        pid: spawned.pid,
        processStartedAt: now(),
        ...(plan.expectedAppVersion !== undefined ? { appVersion: plan.expectedAppVersion } : {}),
      };
      // Best-effort tracking only: a failed lease write
      // must never prevent the launch itself.
      yield* storage
        .writeAppLease(lease)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("providerAccounts.app_lease_write_failed", { cause }),
          ),
        );
      return lease;
    });

  return { planAppLaunch, launchApp };
}

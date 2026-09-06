import "../claudeAppLaunch";

import {
  ProviderAccountsSnapshot,
  SupportedAccountProvider,
  type ProviderAccountRecord,
  type ProviderAccountView,
} from "@synara/contracts";
import { authCapabilities } from "@synara/shared/providerAccounts/capabilities";
import { resolveAccountRoot } from "@synara/shared/providerAccounts/accountPaths";
import { Effect, Layer, Option, Schema } from "effect";

import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory";
import { readAccountBindingFromRuntimePayload } from "../../provider/accountBindingPayload";
import { makeAccountConnect } from "../accountConnect";
import { makeAccountResolver } from "../accountResolver";
import { makeAppLaunch } from "../appLaunch";
import { makeAccountStorage } from "../accountStorage";
import { makeCliIntegration } from "../cliIntegration";
import { makeDoctorReport } from "../doctorReport";
import {
  ProviderAccounts,
  ProviderAccountsError,
  type ProviderAccountsShape,
} from "../Services/ProviderAccounts";

const SUPPORTED_PROVIDERS = SupportedAccountProvider.literals;

// Stable placeholder timestamp for the synthesized native account 0 view.
const NATIVE_ACCOUNT_CREATED_AT = "1970-01-01T00:00:00.000Z";

const toView = (record: ProviderAccountRecord): ProviderAccountView => ({
  provider: record.provider,
  ordinal: record.ordinal,
  createdAt: record.createdAt,
  ...(record.identity !== undefined
    ? {
        identity: {
          ...(record.identity.hint !== undefined ? { hint: record.identity.hint } : {}),
          ...(record.identity.plan !== undefined ? { plan: record.identity.plan } : {}),
        },
      }
    : {}),
  ...(record.agent !== undefined
    ? {
        agent: {
          generation: record.agent.generation,
          state: record.agent.state,
          authMethod: record.agent.authMethod,
        },
      }
    : {}),
  ...(record.app !== undefined
    ? {
        app: {
          generation: record.app.generation,
          state: record.app.state,
          supportLevel: record.app.supportLevel,
          ...(record.app.lastVerifiedAppVersion !== undefined
            ? { lastVerifiedAppVersion: record.app.lastVerifiedAppVersion }
            : {}),
          ...(record.app.lastVerifiedAt !== undefined
            ? { lastVerifiedAt: record.app.lastVerifiedAt }
            : {}),
        },
      }
    : {}),
});

export const makeProviderAccounts = Effect.gen(function* () {
  const directory = yield* ProviderSessionDirectory;
  const storage = makeAccountStorage({
    root: resolveAccountRoot({ env: process.env }),
  });
  const connect = makeAccountConnect({ storage });
  const resolver = makeAccountResolver({ storage });
  const appLaunch = makeAppLaunch({ storage, resolver });
  const cliIntegration = makeCliIntegration({ root: storage.root });
  const doctor = makeDoctorReport({ storage, cliIntegration });

  yield* storage.ensureRoot.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("providerAccounts.account_root_init_failed", { cause }),
    ),
  );

  // Startup recovery: pending login directories left behind by a previous
  // process are surfaced as failed operations, then removed.
  yield* connect.recoverInterruptedOperations.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("providerAccounts.pending_cleanup_failed", { cause }),
    ),
  );

  const fail = (operation: string) => (cause: unknown) =>
    new ProviderAccountsError({
      operation,
      detail:
        typeof cause === "object" && cause !== null && "detail" in cause
          ? String((cause as { detail: unknown }).detail)
          : "Provider account operation failed.",
      cause,
    });

  // The native account 0 is not stored on disk, but it is always a valid
  // selection: synthesize a permanent view so every selector can offer it.
  const nativeAccountView = (provider: SupportedAccountProvider): ProviderAccountView => ({
    provider,
    ordinal: 0,
    createdAt: NATIVE_ACCOUNT_CREATED_AT,
    agent: { generation: 1, state: "connected", authMethod: "oauth" },
  });

  const getSnapshot: ProviderAccountsShape["getSnapshot"] = Effect.gen(function* () {
    const providers = yield* Effect.forEach(SUPPORTED_PROVIDERS, (provider) =>
      Effect.gen(function* () {
        const records = yield* storage.listAccounts(provider);
        const visible: Array<ProviderAccountView> = [nativeAccountView(provider)];
        for (const record of records) {
          if (!(yield* storage.isAccountHidden(provider, record.ordinal))) {
            visible.push(toView(record));
          }
        }
        return {
          provider,
          activeOrdinal: (yield* storage.readActiveOrdinal(provider)) ?? 0,
          accounts: visible,
          capabilities: authCapabilities(provider),
        };
      }),
    );
    return { providers } satisfies ProviderAccountsSnapshot;
  }).pipe(Effect.mapError(fail("providerAccounts.getSnapshot")));

  const service: ProviderAccountsShape = {
    getSnapshot,
    beginConnect: (input) =>
      connect.beginConnect(input).pipe(Effect.mapError(fail("providerAccounts.beginConnect"))),
    getConnectStatus: (input) =>
      connect
        .getConnectStatus(input.operationId)
        .pipe(Effect.mapError(fail("providerAccounts.getConnectStatus"))),
    cancelConnect: (input) =>
      connect
        .cancelConnect(input.operationId)
        .pipe(Effect.mapError(fail("providerAccounts.cancelConnect"))),
    setActive: (input) =>
      connect
        .setActive(input.provider, input.ordinal)
        .pipe(Effect.mapError(fail("providerAccounts.setActive"))),
    disconnectBinding: (input) =>
      connect
        .disconnectBinding(input.provider, input.ordinal, input.surface)
        .pipe(Effect.mapError(fail("providerAccounts.disconnectBinding"))),
    hide: (input) =>
      connect
        .hide(input.provider, input.ordinal)
        .pipe(Effect.mapError(fail("providerAccounts.hide"))),
    launch: (input) =>
      input.surface === "app"
        ? appLaunch
            .planAppLaunch({
              provider: input.provider,
              ...(input.ordinal !== undefined ? { explicitOrdinal: input.ordinal } : {}),
            })
            .pipe(
              Effect.flatMap((plan) =>
                appLaunch.launchApp(plan).pipe(
                  Effect.map(() => ({
                    launched: true,
                    ordinal: plan.ordinal,
                    supportLevel: plan.supportLevel,
                  })),
                ),
              ),
              Effect.mapError(fail("providerAccounts.launch")),
            )
        : // Standalone agent CLI launching ships with the launcher work; resolve only.
          resolver
            .resolveAccountLaunch({
              provider: input.provider,
              surface: input.surface,
              ...(input.ordinal !== undefined ? { explicitOrdinal: input.ordinal } : {}),
            })
            .pipe(
              Effect.map((resolved) => ({
                launched: false,
                ordinal: resolved.ordinal,
                supportLevel: resolved.supportLevel,
              })),
              Effect.mapError(fail("providerAccounts.launch")),
            ),
    getIntegrationStatus: cliIntegration.getStatus.pipe(
      Effect.mapError(fail("providerAccounts.getIntegrationStatus")),
    ),
    updateCliIntegration: (input) =>
      cliIntegration
        .update(input.enabled)
        .pipe(Effect.mapError(fail("providerAccounts.updateCliIntegration"))),
    getDoctorReport: doctor.generate.pipe(
      Effect.mapError(fail("providerAccounts.getDoctorReport")),
    ),
    getThreadBinding: (input) =>
      Effect.gen(function* () {
        const binding = Option.getOrUndefined(yield* directory.getBinding(input.threadId));
        const accountBinding =
          binding === undefined
            ? undefined
            : readAccountBindingFromRuntimePayload(binding.runtimePayload);
        if (
          binding === undefined ||
          accountBinding === undefined ||
          !Schema.is(SupportedAccountProvider)(binding.provider)
        ) {
          return {};
        }
        return {
          binding: {
            provider: binding.provider,
            ordinal: accountBinding.ordinal,
            agentGeneration: accountBinding.agentGeneration,
          },
        };
      }).pipe(Effect.mapError(fail("providerAccounts.getThreadBinding"))),
    resolveLaunch: (input) =>
      resolver
        .resolveAccountLaunch(input)
        .pipe(Effect.mapError(fail("providerAccounts.resolveLaunch"))),
    planAppLaunch: (input) =>
      appLaunch.planAppLaunch(input).pipe(Effect.mapError(fail("providerAccounts.planAppLaunch"))),
  };

  return service;
});

export const ProviderAccountsLive = Layer.effect(ProviderAccounts, makeProviderAccounts);

// Account-system diagnostics: active pointers, record schemas, missing
// secrets, orphaned pending directories, stale app leases, and launcher
// installation/PATH health.

import { SupportedAccountProvider, type ProviderAccountsDoctorReport } from "@synara/contracts";
import { Effect } from "effect";

import type { AccountStorageShape } from "./accountStorage";
import type { CliIntegrationShape } from "./cliIntegration";

type DoctorCheck = ProviderAccountsDoctorReport["checks"][number];

const SUPPORTED_PROVIDERS = SupportedAccountProvider.literals;

export interface DoctorReportInput {
  readonly storage: AccountStorageShape;
  readonly cliIntegration: CliIntegrationShape;
}

export function makeDoctorReport(input: DoctorReportInput) {
  const { storage, cliIntegration } = input;

  const check = (
    id: string,
    label: string,
    status: DoctorCheck["status"],
    detail?: string,
  ): DoctorCheck => ({ id, label, status, ...(detail !== undefined ? { detail } : {}) });

  const rootCheck = storage.readVersion.pipe(
    Effect.map((version) =>
      version === null
        ? check("account-root", "Account root", "warning", "Account root is not initialized yet.")
        : check("account-root", "Account root", "ok", `Schema version ${version}.`),
    ),
    Effect.orElseSucceed(() =>
      check("account-root", "Account root", "error", "Failed to read the account root."),
    ),
  );

  const activePointerCheck = (provider: (typeof SUPPORTED_PROVIDERS)[number]) =>
    storage.readActiveOrdinal(provider).pipe(
      Effect.flatMap((ordinal) =>
        Effect.gen(function* () {
          const id = `active-pointer-${provider}`;
          const label = `Active pointer (${provider})`;
          if (ordinal === null || ordinal === 0) {
            return check(id, label, "ok", "Native account 0.");
          }
          const record = yield* storage.readAccount(provider, ordinal);
          if (record === null) {
            return check(id, label, "error", `Points at account ${ordinal}, which does not exist.`);
          }
          if (record.agent === undefined || record.agent.state !== "connected") {
            return check(
              id,
              label,
              "warning",
              `Points at account ${ordinal}, whose agent binding is not connected.`,
            );
          }
          return check(id, label, "ok", `Managed account ${ordinal}.`);
        }),
      ),
      Effect.orElseSucceed(() =>
        check(
          `active-pointer-${provider}`,
          `Active pointer (${provider})`,
          "error",
          "The active pointer file is corrupted. Delete it to reset to the native account.",
        ),
      ),
    );

  const recordsCheck = (provider: (typeof SUPPORTED_PROVIDERS)[number]) =>
    Effect.gen(function* () {
      const id = `accounts-${provider}`;
      const label = `Account records (${provider})`;
      const ordinals = yield* storage.listOrdinals(provider);
      const broken: Array<string> = [];
      const missingSecrets: Array<number> = [];
      for (const ordinal of ordinals) {
        const record = yield* storage
          .readAccount(provider, ordinal)
          .pipe(Effect.orElseSucceed(() => null));
        if (record === null) {
          broken.push(`account ${ordinal} record is missing or fails schema validation`);
          continue;
        }
        if (
          record.agent !== undefined &&
          record.agent.state === "connected" &&
          record.agent.authMethod === "apiKey" &&
          (yield* storage
            .readSecret(provider, ordinal, "agent")
            .pipe(Effect.orElseSucceed(() => null))) === null
        ) {
          missingSecrets.push(ordinal);
        }
      }
      if (broken.length > 0) {
        return check(id, label, "error", `${broken.join("; ")}.`);
      }
      if (missingSecrets.length > 0) {
        return check(
          id,
          label,
          "error",
          `Missing API-key secret for account(s) ${missingSecrets.join(", ")}. Reconnect them.`,
        );
      }
      return check(id, label, "ok", `${ordinals.length} managed account(s).`);
    }).pipe(
      Effect.orElseSucceed(() =>
        check(
          `accounts-${provider}`,
          `Account records (${provider})`,
          "error",
          "Failed to inspect account records.",
        ),
      ),
    );

  const pendingCheck = (provider: (typeof SUPPORTED_PROVIDERS)[number]) =>
    storage.listPendingOperations(provider).pipe(
      Effect.map((pending) =>
        pending.length === 0
          ? check(`pending-${provider}`, `Pending connects (${provider})`, "ok")
          : check(
              `pending-${provider}`,
              `Pending connects (${provider})`,
              "warning",
              `${pending.length} orphaned pending director${pending.length === 1 ? "y" : "ies"}; they are cleaned up on server restart.`,
            ),
      ),
      Effect.orElseSucceed(() =>
        check(
          `pending-${provider}`,
          `Pending connects (${provider})`,
          "error",
          "Failed to inspect pending directories.",
        ),
      ),
    );

  const staleLeaseCheck = (provider: (typeof SUPPORTED_PROVIDERS)[number]) =>
    Effect.gen(function* () {
      const ordinals = yield* storage.listOrdinals(provider);
      const stale: Array<number> = [];
      for (const ordinal of ordinals) {
        const lease = yield* storage.readAppLease(provider, ordinal);
        if (lease === null) continue;
        try {
          process.kill(lease.pid, 0);
        } catch {
          stale.push(ordinal);
        }
      }
      return stale.length === 0
        ? check(`app-leases-${provider}`, `App leases (${provider})`, "ok")
        : check(
            `app-leases-${provider}`,
            `App leases (${provider})`,
            "warning",
            `Stale lease(s) for account(s) ${stale.join(", ")} (process no longer running).`,
          );
    }).pipe(
      Effect.orElseSucceed(() =>
        check(
          `app-leases-${provider}`,
          `App leases (${provider})`,
          "error",
          "Failed to inspect app leases.",
        ),
      ),
    );

  const launcherCheck = Effect.gen(function* () {
    const status = yield* cliIntegration.getStatus;
    if (!status.launcherInstalled) {
      return check(
        "cli-integration",
        "CLI integration",
        "warning",
        "Provider shims are not installed. Enable CLI integration in Settings to launch managed accounts from a terminal.",
      );
    }
    if (!status.launcherEntryExists) {
      return check(
        "cli-integration",
        "CLI integration",
        "error",
        `The launcher entry point is missing (${cliIntegration.launcherEntry}). Reinstall CLI integration.`,
      );
    }
    if (!status.shimDirOnPath) {
      return check(
        "cli-integration",
        "CLI integration",
        "warning",
        `Shims are installed but ${status.shimDir} is not on PATH.`,
      );
    }
    const shadowed = yield* cliIntegration.listShadowedShims;
    if (shadowed.length > 0) {
      return check(
        "cli-integration",
        "CLI integration",
        "warning",
        `Shim(s) ${shadowed.join(", ")} resolve to another PATH entry before ${status.shimDir}. Move it earlier on PATH.`,
      );
    }
    return check(
      "cli-integration",
      "CLI integration",
      "ok",
      `Shims installed${status.launcherVersion !== undefined ? ` (launcher ${status.launcherVersion})` : ""} and on PATH.`,
    );
  }).pipe(
    Effect.orElseSucceed(() =>
      check("cli-integration", "CLI integration", "error", "Failed to inspect CLI integration."),
    ),
  );

  const generate = Effect.gen(function* () {
    const checks: Array<DoctorCheck> = [yield* rootCheck];
    for (const provider of SUPPORTED_PROVIDERS) {
      checks.push(yield* activePointerCheck(provider));
      checks.push(yield* recordsCheck(provider));
      checks.push(yield* pendingCheck(provider));
      checks.push(yield* staleLeaseCheck(provider));
    }
    checks.push(yield* launcherCheck);
    return {
      generatedAt: new Date().toISOString(),
      checks,
    } satisfies ProviderAccountsDoctorReport;
  });

  return { generate };
}

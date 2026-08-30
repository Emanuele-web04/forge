// FILE: backendStartupBlock.ts
// Purpose: Classifies expected backend startup blocks that need user action, not crash retries.

import {
  MIGRATION_DIVERGENCE_CONSENT_REQUIRED_PREFIX,
  parseMigrationDivergenceConsentChallenge,
  type MigrationDivergenceConsentChallenge,
} from "@synara/shared/migrationRecovery";

const MAX_STARTUP_OUTPUT_CHARS = 16_384;

export type BackendStartupBlock =
  | {
      readonly kind: "database-locked";
      readonly ownerPid: number | null;
    }
  | {
      readonly kind: "migration-recovery-required";
    }
  | {
      readonly kind: "migration-divergence-consent-required";
      readonly challenge: MigrationDivergenceConsentChallenge;
    }
  | {
      readonly kind: "migration-runtime-identity-mismatch";
    };

export class BackendStartupBlockDetector {
  private output = "";
  private block: BackendStartupBlock | null = null;

  push(chunk: unknown): void {
    if (this.block) return;

    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    this.output = `${this.output}${text.replace(/\r/g, "")}`;

    const divergenceChallenge = parseMigrationDivergenceConsentChallenge(this.output);
    if (divergenceChallenge) {
      this.block = {
        kind: "migration-divergence-consent-required",
        challenge: divergenceChallenge,
      };
      return;
    }

    this.output = retainRelevantStartupOutput(this.output);

    if (this.output.includes("MigrationRuntimeIdentityMismatchError:")) {
      this.block = { kind: "migration-runtime-identity-mismatch" };
      return;
    }

    if (this.output.includes("MigrationRecoveryRequiredError:")) {
      this.block = { kind: "migration-recovery-required" };
      return;
    }

    const lockErrorIndex = this.output.indexOf("DatabaseLifecycleLockedError:");
    if (lockErrorIndex === -1) {
      return;
    }
    const lockErrorOutput = this.output.slice(lockErrorIndex);
    const ownerPidMatch = lockErrorOutput.match(/owner pid (\d+) is live/);
    if (!ownerPidMatch && !lockErrorOutput.includes("\n")) {
      return;
    }
    const parsedOwnerPid = ownerPidMatch?.[1] ? Number.parseInt(ownerPidMatch[1], 10) : Number.NaN;
    this.block = {
      kind: "database-locked",
      ownerPid: Number.isSafeInteger(parsedOwnerPid) && parsedOwnerPid > 0 ? parsedOwnerPid : null,
    };
  }

  read(): BackendStartupBlock | null {
    return this.block;
  }
}

function retainRelevantStartupOutput(output: string): string {
  const challengeStart = output.lastIndexOf(MIGRATION_DIVERGENCE_CONSENT_REQUIRED_PREFIX);
  const challengeLineIsIncomplete =
    challengeStart !== -1 && output.indexOf("\n", challengeStart) === -1;
  if (challengeLineIsIncomplete) return output.slice(challengeStart);
  return output.length > MAX_STARTUP_OUTPUT_CHARS
    ? output.slice(-MAX_STARTUP_OUTPUT_CHARS)
    : output;
}

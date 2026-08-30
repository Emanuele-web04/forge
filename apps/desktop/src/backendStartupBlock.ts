// FILE: backendStartupBlock.ts
// Purpose: Classifies expected backend startup blocks that need user action, not crash retries.

import { StringDecoder } from "node:string_decoder";

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
  private readonly decoders = {
    stdout: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8"),
  };

  push(chunk: unknown, source: "stdout" | "stderr" = "stdout"): void {
    const text = Buffer.isBuffer(chunk) ? this.decoders[source].write(chunk) : String(chunk);
    this.append(text);
  }

  end(source: "stdout" | "stderr"): void {
    this.append(this.decoders[source].end());
  }

  private append(text: string): void {
    if (text.length === 0) return;
    this.output = `${this.output}${text.replace(/\r/g, "")}`;

    this.output = retainRelevantStartupOutput(this.output);

    if (this.block) return;

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
    const divergenceChallenge = parseMigrationDivergenceConsentChallenge(this.output);
    if (divergenceChallenge) {
      return {
        kind: "migration-divergence-consent-required",
        challenge: divergenceChallenge,
      };
    }
    return this.block;
  }
}

function retainRelevantStartupOutput(output: string): string {
  let challengeStart = output.lastIndexOf(MIGRATION_DIVERGENCE_CONSENT_REQUIRED_PREFIX);
  while (challengeStart > 0 && output[challengeStart - 1] !== "\n") {
    challengeStart = output.lastIndexOf(
      MIGRATION_DIVERGENCE_CONSENT_REQUIRED_PREFIX,
      challengeStart - 1,
    );
  }
  if (challengeStart !== -1) return output.slice(challengeStart);
  return output.length > MAX_STARTUP_OUTPUT_CHARS
    ? output.slice(-MAX_STARTUP_OUTPUT_CHARS)
    : output;
}

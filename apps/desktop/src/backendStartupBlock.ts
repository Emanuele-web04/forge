// FILE: backendStartupBlock.ts
// Purpose: Classifies expected backend startup blocks that need user action, not crash retries.

import { StringDecoder } from "node:string_decoder";

import {
  MIGRATION_DIVERGENCE_CONSENT_REQUIRED_PREFIX,
  MIGRATION_SCHEMA_TOO_NEW_BLOCK_PREFIX,
  parseMigrationDivergenceConsentChallenge,
  parseMigrationSchemaTooNewStartupBlock,
  type MigrationDivergenceConsentChallenge,
  type MigrationSchemaTooNewStartupBlock,
} from "@synara/shared/migrationRecovery";

const MAX_GENERIC_STARTUP_OUTPUT_CHARS = 16_384;
const MAX_STRUCTURED_STARTUP_BLOCK_CHARS = 1_048_576;
const STRUCTURED_STARTUP_BLOCK_PREFIXES = [
  MIGRATION_DIVERGENCE_CONSENT_REQUIRED_PREFIX,
  MIGRATION_SCHEMA_TOO_NEW_BLOCK_PREFIX,
] as const;

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
    }
  | {
      readonly kind: "migration-schema-too-new";
      readonly block: MigrationSchemaTooNewStartupBlock;
    }
  | {
      readonly kind: "migration-startup-block-invalid";
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
    if (text.length === 0 || this.block?.kind === "migration-startup-block-invalid") return;
    this.output = retainRelevantStartupOutput(`${this.output}${text.replace(/\r/g, "")}`);
    if (this.output.length > MAX_STRUCTURED_STARTUP_BLOCK_CHARS) {
      this.block = { kind: "migration-startup-block-invalid" };
      return;
    }

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
    if (lockErrorIndex === -1) return;
    const lockErrorOutput = this.output.slice(lockErrorIndex);
    const ownerPidMatch = lockErrorOutput.match(/owner pid (\d+) is live/);
    if (!ownerPidMatch && !lockErrorOutput.includes("\n")) return;
    const parsedOwnerPid = ownerPidMatch?.[1] ? Number.parseInt(ownerPidMatch[1], 10) : Number.NaN;
    this.block = {
      kind: "database-locked",
      ownerPid: Number.isSafeInteger(parsedOwnerPid) && parsedOwnerPid > 0 ? parsedOwnerPid : null,
    };
  }

  read(): BackendStartupBlock | null {
    if (this.block?.kind === "migration-startup-block-invalid") return this.block;
    const divergenceChallenge = parseMigrationDivergenceConsentChallenge(this.output);
    if (divergenceChallenge) {
      return {
        kind: "migration-divergence-consent-required",
        challenge: divergenceChallenge,
      };
    }
    const schemaTooNewBlock = parseMigrationSchemaTooNewStartupBlock(this.output);
    if (schemaTooNewBlock) {
      return { kind: "migration-schema-too-new", block: schemaTooNewBlock };
    }
    if (this.block) return this.block;
    return containsStructuredStartupBlock(this.output)
      ? { kind: "migration-startup-block-invalid" }
      : null;
  }
}

function retainRelevantStartupOutput(output: string): string {
  const structuredBlockIndex = earliestStructuredStartupBlockIndex(output);
  return structuredBlockIndex === -1
    ? output.slice(-MAX_GENERIC_STARTUP_OUTPUT_CHARS)
    : output.slice(structuredBlockIndex);
}

function earliestStructuredStartupBlockIndex(output: string): number {
  let earliest = -1;
  for (const prefix of STRUCTURED_STARTUP_BLOCK_PREFIXES) {
    let index = output.indexOf(prefix);
    while (index > 0 && output[index - 1] !== "\n") {
      index = output.indexOf(prefix, index + prefix.length);
    }
    if (index !== -1 && (earliest === -1 || index < earliest)) earliest = index;
  }
  return earliest;
}

function containsStructuredStartupBlock(output: string): boolean {
  return earliestStructuredStartupBlockIndex(output) !== -1;
}

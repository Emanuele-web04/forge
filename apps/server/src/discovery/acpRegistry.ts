// FILE: acpRegistry.ts
// Purpose: Schema + mapping for the upstream ACP Registry JSON.
//
// The registry is untrusted network input, so decoding is deliberately
// PERMISSIVE: every field is optional and length/type validation is the
// contract's job (`AcpRegistryEntry`). A single malformed record must never
// brick the whole catalog, and the document decode happens only after the
// network boundary has enforced byte/depth/node limits.
// Layer: Server discovery
import { Schema } from "effect";

import type { CandidateDistribution, CandidateDistributionKind } from "@synara/contracts";

/** `distribution` value in the real registry, tolerant of all attested shapes. */
export const RawDistribution = Schema.Record(Schema.String, Schema.Unknown);
export type RawDistribution = typeof RawDistribution.Type;

export const AcpRegistryDocumentEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  repository: Schema.optional(Schema.String),
  website: Schema.optional(Schema.String),
  authors: Schema.optional(Schema.Array(Schema.String)),
  license: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String),
  distribution: Schema.optional(RawDistribution),
});
export type AcpRegistryDocumentEntry = typeof AcpRegistryDocumentEntry.Type;

export const AcpRegistryDocument = Schema.Struct({
  version: Schema.optional(Schema.String),
  agents: Schema.Array(AcpRegistryDocumentEntry).pipe(Schema.withDecodingDefault(() => [])),
});
export type AcpRegistryDocument = typeof AcpRegistryDocument.Type;

/**
 * Decode upstream registry JSON with a strict depth/node budget.
 *
 * The upstream file is untrusted network input; the decode happens only after
 * the outbound boundary verified byte/depth/node limits. A decode failure is
 * an offline-degradation reason, never a process error.
 */
export const decodeAcpRegistryDocument = (input: unknown): AcpRegistryDocument =>
  Schema.decodeUnknownSync(AcpRegistryDocument)(input);

/**
 * Map the current Node platform+arch to the registry's per-target key
 * (`darwin-aarch64`, `linux-x86_64`, ...). Binary distributions select their
 * matching target record; unknown platforms keep the entry listable but
 * without an archive fact.
 */
export function currentRegistryBinaryTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  if (arch === "x64") arch = "x86_64";
  else if (arch === "arm64") arch = "aarch64";
  else if (arch === "ia32") arch = "x86_32";
  switch (platform) {
    case "darwin":
      return `darwin-${arch}`;
    case "linux":
      return `linux-${arch}`;
    case "win32":
      return `windows-${arch}`;
    default:
      return undefined;
  }
}

const asArgsOf = (args: unknown): string[] | undefined =>
  Array.isArray(args) ? args.map(String) : undefined;
const asEnvOf = (env: unknown): Record<string, string> | undefined =>
  typeof env === "object" && env !== null
    ? Object.fromEntries(
        Object.entries(env as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : undefined;

/**
 * Normalize one upstream `distribution` map into the contract's structured
 * `CandidateDistribution`:
 *
 * - `{ npx: { package, args, env } }` / `{ uvx: ... }` → package-manager
 *   distribution (kind `npx`/`uvx`, package id, args, env).
 * - `{ binary: { "<target>": { archive, cmd, args, sha256 } } }` → binary
 *   distribution. The target matching the CURRENT host platform is selected;
 *   the per-target `cmd` cannot be turned into a launch command without a
 *   real install, so it stays a display fact (KAR-526 + the ACP probe decide
 *   if a local binary is launchable).
 * - unknown/flat distribution shape → `undefined` (listable, not directly
 *   installable from structured facts).
 */
export function extractRegistryDistribution(
  value: RawDistribution | undefined,
  binaryTarget?: string,
): CandidateDistribution | undefined {
  if (value === undefined || typeof value !== "object" || value === null) return undefined;

  const npx = value.npx as { package?: unknown; args?: unknown; env?: unknown } | undefined;
  if (typeof npx === "object" && npx !== null && typeof npx.package === "string") {
    const distribution: CandidateDistribution = {
      kind: "npx",
      package: npx.package,
      ...(asArgsOf(npx.args) !== undefined ? { args: asArgsOf(npx.args) } : {}),
      ...(asEnvOf(npx.env) !== undefined ? { env: asEnvOf(npx.env) } : {}),
    };
    return distribution;
  }

  const uvx = value.uvx as { package?: unknown; args?: unknown; env?: unknown } | undefined;
  if (typeof uvx === "object" && uvx !== null && typeof uvx.package === "string") {
    const distribution: CandidateDistribution = {
      kind: "uvx",
      package: uvx.package,
      ...(asArgsOf(uvx.args) !== undefined ? { args: asArgsOf(uvx.args) } : {}),
      ...(asEnvOf(uvx.env) !== undefined ? { env: asEnvOf(uvx.env) } : {}),
    };
    return distribution;
  }

  const binary = value.binary as Record<string, unknown> | undefined;
  if (typeof binary === "object" && binary !== null) {
    const target =
      binaryTarget !== undefined
        ? (binary[binaryTarget] as unknown)
        : (Object.values(binary)[0] as unknown);
    if (typeof target === "object" && target !== null) {
      const t = target as {
        archive?: unknown;
        cmd?: unknown;
        args?: unknown;
        sha256?: unknown;
      };
      return {
        kind: "binary",
        ...(typeof t.archive === "string" ? { archiveUrl: t.archive } : {}),
        ...(typeof t.cmd === "string" ? { binaryCmd: t.cmd } : {}),
        ...(typeof t.sha256 === "string" ? { sha256: t.sha256 } : {}),
        ...(asArgsOf(t.args) !== undefined ? { args: asArgsOf(t.args) } : {}),
      } satisfies CandidateDistribution;
    }
    return { kind: "binary" } satisfies CandidateDistribution;
  }

  // Tolerate a historically-flat distribution value (early entries put
  // `{ package, args }` directly on distribution).
  const flat = value as { package?: unknown; args?: unknown; env?: unknown };
  if (typeof flat.package === "string") {
    const distribution: CandidateDistribution = {
      kind: "npx",
      package: flat.package,
      ...(asArgsOf(flat.args) !== undefined ? { args: asArgsOf(flat.args) } : {}),
      ...(asEnvOf(flat.env) !== undefined ? { env: asEnvOf(flat.env) } : {}),
    };
    return distribution;
  }
  return undefined;
}

export type { CandidateDistribution, CandidateDistributionKind };

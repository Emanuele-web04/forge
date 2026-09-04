// FILE: AcpRegistryCatalog.ts
// Purpose: Materializes the upstream ACP Registry into the contract
//          `AcpRegistryEntry[]` shape with provenance stamped per entry.
//          Kept separate from the client so tests can build a catalog from a
//          synthetic document without any network. The catalog never invents
//          install/launch commands — distribution facts are passed through as
//          structured display metadata only (AC #6).
// Layer: Server discovery
import type { AcpRegistryEntry } from "@synara/contracts";
import { ACP_REGISTRY_SOURCE_URL } from "./AcpRegistryClient.ts";
import {
  currentRegistryBinaryTarget,
  extractRegistryDistribution,
  type AcpRegistryDocument,
  type AcpRegistryDocumentEntry,
} from "./acpRegistry.ts";

export interface AcpRegistryCatalog {
  readonly snapshotVersion: string | undefined;
  readonly entries: ReadonlyArray<AcpRegistryEntry>;
}

interface CatalogEntryInput {
  readonly entry: AcpRegistryDocumentEntry;
  readonly binaryTarget: string | undefined;
  readonly sourceUrl: string;
  readonly fetchedAt: string;
  readonly registryVersion: string | undefined;
}

function catalogEntryFromDocument(input: CatalogEntryInput): AcpRegistryEntry | undefined {
  const id = input.entry.id;
  if (typeof id !== "string" || id.trim().length === 0) return undefined;
  const distribution = extractRegistryDistribution(input.entry.distribution, input.binaryTarget);
  return {
    agentId: id,
    name: input.entry.name ?? id,
    ...(input.entry.description !== undefined ? { description: input.entry.description } : {}),
    ...(input.entry.repository !== undefined ? { repository: input.entry.repository } : {}),
    ...(input.entry.website !== undefined ? { website: input.entry.website } : {}),
    ...(input.entry.authors !== undefined ? { authors: input.entry.authors } : {}),
    ...(input.entry.license !== undefined ? { license: input.entry.license } : {}),
    ...(input.entry.icon !== undefined ? { icon: input.entry.icon } : {}),
    ...(distribution !== undefined ? { distribution } : {}),
    registry: {
      sourceUrl: input.sourceUrl,
      ...(input.registryVersion !== undefined ? { registryVersion: input.registryVersion } : {}),
      fetchedAt: input.fetchedAt,
    },
  } satisfies AcpRegistryEntry;
}

export function acpRegistryCatalogFromDocument(
  document: AcpRegistryDocument,
  input: {
    readonly sourceUrl?: string;
    readonly fetchedAt?: string;
    /** Override for platform/arch in tests. */
    readonly platform?: NodeJS.Platform;
    readonly arch?: string;
    /** Override for the ACP registry version in tests. */
    readonly registryVersion?: string;
  } = {},
): AcpRegistryCatalog {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const binaryTarget = currentRegistryBinaryTarget(platform, arch);
  const fetchedAt = input.fetchedAt ?? new Date().toISOString();
  const sourceUrl = input.sourceUrl ?? ACP_REGISTRY_SOURCE_URL;
  const registryVersion = input.registryVersion ?? document.version;

  const entries = document.agents.flatMap((entry) => {
    const materialized = catalogEntryFromDocument({
      entry,
      binaryTarget,
      sourceUrl,
      fetchedAt,
      registryVersion,
    });
    return materialized === undefined ? [] : [materialized];
  });

  return { snapshotVersion: document.version, entries };
}

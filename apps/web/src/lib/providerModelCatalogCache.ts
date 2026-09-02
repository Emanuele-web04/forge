import { ProviderListModelsResult, type ProviderKind } from "@synara/contracts";
import { Schema } from "effect";

export const CATALOG_CACHE_VERSION = "v1";
export const CATALOG_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_KEY_PREFIX = `synara:provider-models-cache:${CATALOG_CACHE_VERSION}:`;

const UNCACHEABLE_SOURCES = new Set(["empty", "disabled", "unsupported"]);
function isCacheableModelSource(source: string | undefined): source is string {
  return typeof source === "string" && source.length > 0 && !UNCACHEABLE_SOURCES.has(source);
}

export function isUsableModelSource(source: string | undefined): boolean {
  return isCacheableModelSource(source);
}

const CatalogCachePayloadSchema = Schema.Struct({
  inputsKey: Schema.String,
  fetchedAt: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)),
  result: ProviderListModelsResult,
});

export function buildCatalogCacheInputsKey(input: {
  binaryPath?: string | null | undefined;
  apiEndpoint?: string | null | undefined;
  agentDir?: string | null | undefined;
  cwd?: string | null | undefined;
}): string {
  return JSON.stringify({
    binaryPath: input.binaryPath ?? null,
    apiEndpoint: input.apiEndpoint ?? null,
    agentDir: input.agentDir ?? null,
    cwd: input.cwd ?? null,
  });
}

export function readCatalogCacheEntry(
  provider: ProviderKind,
  inputsKey: string,
): typeof CatalogCachePayloadSchema.Type | undefined {
  const storage = globalThis.localStorage;
  if (!storage) return undefined;
  try {
    const raw = storage.getItem(`${CACHE_KEY_PREFIX}${provider}`);
    if (!raw) return undefined;

    const parsed: unknown = JSON.parse(raw);
    const cached = Schema.decodeUnknownSync(CatalogCachePayloadSchema)(parsed);

    if (cached.inputsKey !== inputsKey || Date.now() - cached.fetchedAt > CATALOG_CACHE_TTL_MS)
      return undefined;

    return cached;
  } catch {
    return undefined;
  }
}

export function writeCatalogCache(
  provider: ProviderKind,
  inputsKey: string,
  result: ProviderListModelsResult,
): void {
  if (
    result.error !== undefined ||
    !isCacheableModelSource(result.source) ||
    result.models.length === 0
  )
    return;

  const storage = globalThis.localStorage;
  if (!storage) return;
  try {
    storage.setItem(
      `${CACHE_KEY_PREFIX}${provider}`,
      JSON.stringify({ inputsKey, fetchedAt: Date.now(), result }),
    );
  } catch {}
}

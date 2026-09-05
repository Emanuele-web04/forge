import type { Api, Model } from "@earendil-works/pi-ai";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { outboundHttp, decodeOutboundJson } from "@synara/shared/outboundHttp";

const CATALOG_URL = "https://pi.dev/api/models/providers/opencode";
const INVENTORY_URL = "https://opencode.ai/zen/v1/models";
const CATALOG_TTL_MS = 60_000;
let publicCatalog: { models: Model<Api>[]; fetchedAt: number } | undefined;
const BASE_URLS: Record<string, string> = {
  "anthropic-messages": "https://opencode.ai/zen",
  "google-generative-ai": "https://opencode.ai/zen/v1",
  "openai-responses": "https://opencode.ai/zen/v1",
  "openai-completions": "https://opencode.ai/zen/v1",
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCatalogModel(value: unknown): value is Model<Api> {
  if (!record(value)) return false;
  const cost = value.cost;
  return (
    typeof value.id === "string" &&
    value.id.trim() === value.id &&
    value.id.length > 0 &&
    typeof value.name === "string" &&
    value.name.trim().length > 0 &&
    value.provider === "opencode" &&
    typeof value.api === "string" &&
    Object.hasOwn(BASE_URLS, value.api) &&
    value.baseUrl === BASE_URLS[value.api] &&
    typeof value.reasoning === "boolean" &&
    Array.isArray(value.input) &&
    value.input.includes("text") &&
    value.input.every((item) => item === "text" || item === "image") &&
    typeof value.contextWindow === "number" &&
    Number.isFinite(value.contextWindow) &&
    value.contextWindow > 0 &&
    typeof value.maxTokens === "number" &&
    Number.isFinite(value.maxTokens) &&
    value.maxTokens > 0 &&
    record(cost) &&
    ["input", "output", "cacheRead", "cacheWrite"].every(
      (key) => typeof cost[key] === "number" && Number.isFinite(cost[key]) && cost[key] >= 0,
    )
  );
}

/** Only advertise active models whose complete Pi protocol metadata is known. */
export function parsePiOpenCodeCatalog(catalog: unknown, inventory: unknown): Model<Api>[] {
  if (
    !record(catalog) ||
    !record(inventory) ||
    !Array.isArray(inventory.data) ||
    inventory.data.length === 0 ||
    !inventory.data.every(
      (item) => record(item) && typeof item.id === "string" && item.id.trim().length > 0,
    )
  ) {
    throw new Error("Invalid OpenCode model inventory");
  }
  const active = new Set(inventory.data.map((item) => item.id));
  const models = Object.values(catalog)
    .filter(isCatalogModel)
    .filter((model) => active.has(model.id));
  if (models.length === 0) throw new Error("No supported OpenCode models in catalog");
  // Public metadata must not supply authentication or arbitrary request headers.
  return models.map(({ headers: _headers, ...model }) => model);
}

/** Install before SDK services load extensions, so user registrations still win. */
export async function refreshPiOpenCodeCatalog(
  runtime: ModelRuntime,
  options: {
    signal?: AbortSignal;
    request?: typeof outboundHttp.request;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  if (process.env.PI_OFFLINE !== undefined || options.signal?.aborted) return;
  if (!runtime.hasConfiguredAuth("opencode")) return;
  if (runtime.getModels("opencode").some((model) => model.baseUrl !== BASE_URLS[model.api])) return;
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(options.timeoutMs ?? 5_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  try {
    let models =
      !options.request && publicCatalog && Date.now() - publicCatalog.fetchedAt < CATALOG_TTL_MS
        ? publicCatalog.models
        : undefined;
    if (!models) {
      const request = options.request ?? outboundHttp.request.bind(outboundHttp);
      const [catalog, inventory] = await Promise.all(
        [CATALOG_URL, INVENTORY_URL].map(async (url) => {
          const response = await request({
            url,
            method: "GET",
            signal,
            policy: {
              service: "pi-opencode-catalog",
              allowedOrigins: ["https://pi.dev", "https://opencode.ai"],
              timeoutMs: options.timeoutMs ?? 5_000,
              maxResponseBytes: 4 * 1024 * 1024,
              maxRequestBytes: 1024,
              maxRedirects: 0,
              maxConcurrent: 4,
              maxQueued: 8,
              requirePublicAddress: true,
            },
          });
          if (response.status !== 200) throw new Error("OpenCode catalog unavailable");
          return decodeOutboundJson(response, { maxDepth: 16, maxNodes: 100_000 });
        }),
      );
      models = parsePiOpenCodeCatalog(catalog, inventory);
      if (!options.request && !signal.aborted) {
        publicCatalog = { models, fetchedAt: Date.now() };
      }
    }
    if (signal.aborted) return;
    // Keep the SDK's native authentication and per-model protocol dispatch.
    // ModelRuntime composes models.json over this base; extensions load afterward.
    const resolvedModels = models;
    runtime.registerNativeProvider({
      ...opencodeProvider(),
      getModels: () => resolvedModels,
      refreshModels: async ({ store }) => {
        await store.write({
          models: resolvedModels,
          checkedAt: Date.now(),
          lastModified: Date.now(),
        });
      },
    });
    await runtime.refresh({ allowNetwork: false });
  } catch {
    // Offline, malformed, or unavailable public catalogs retain the SDK baseline.
  } finally {
    controller.abort();
  }
}

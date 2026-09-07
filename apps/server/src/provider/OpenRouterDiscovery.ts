// OpenRouter's public catalog is metadata only; credentials stay with the SDK.
import type { Model } from "@earendil-works/pi-ai";
import { outboundHttp, decodeOutboundJson } from "@synara/shared/outboundHttp";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function price(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const amount = Number(value) * 1_000_000;
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

export async function fetchOpenRouterModels(): Promise<ReadonlyArray<Model<"openai-completions">>> {
  try {
    const response = await outboundHttp.request({
      policy: {
        service: "openrouter-discovery",
        allowedOrigins: ["https://openrouter.ai"],
        timeoutMs: 5_000,
        maxRequestBytes: 1024,
        maxResponseBytes: 8 * 1024 * 1024,
        maxRedirects: 0,
        maxConcurrent: 2,
        maxQueued: 4,
        requirePublicAddress: true,
      },
      url: `${OPENROUTER_BASE_URL}/models`,
      method: "GET",
    });
    if (response.status !== 200) return [];
    const data = record(decodeOutboundJson(response, { maxDepth: 16, maxNodes: 400_000 }))?.data;
    if (!Array.isArray(data)) return [];
    const models = new Map<string, Model<"openai-completions">>();
    for (const value of data) {
      const dto = record(value);
      if (
        !dto ||
        typeof dto.id !== "string" ||
        !dto.id.trim() ||
        dto.id !== dto.id.trim() ||
        typeof dto.name !== "string" ||
        !dto.name.trim()
      )
        continue;
      const architecture = record(dto.architecture);
      const inputs = architecture?.input_modalities;
      const outputs = architecture?.output_modalities;
      const parameters = dto.supported_parameters;
      const maxTokens = record(dto.top_provider)?.max_completion_tokens;
      const pricing = record(dto.pricing);
      const input = price(pricing?.prompt);
      const output = price(pricing?.completion);
      // Pi is a text/tool agent. Do not advertise unsupported or incomplete models.
      if (
        !Array.isArray(inputs) ||
        !inputs.includes("text") ||
        !Array.isArray(outputs) ||
        !outputs.includes("text") ||
        !Array.isArray(parameters) ||
        !parameters.includes("tools") ||
        !positive(dto.context_length) ||
        !positive(maxTokens) ||
        input === undefined ||
        output === undefined
      )
        continue;
      models.set(dto.id, {
        id: dto.id,
        name: dto.name.trim(),
        provider: "openrouter",
        api: "openai-completions",
        baseUrl: OPENROUTER_BASE_URL,
        reasoning: parameters.includes("reasoning") || parameters.includes("reasoning_effort"),
        input: inputs.includes("image") ? ["text", "image"] : ["text"],
        cost: {
          input,
          output,
          cacheRead: price(pricing?.input_cache_read) ?? 0,
          cacheWrite: price(pricing?.input_cache_write) ?? 0,
        },
        contextWindow: dto.context_length,
        maxTokens: Math.min(maxTokens, dto.context_length),
      });
    }
    return [...models.values()];
  } catch {
    return [];
  }
}

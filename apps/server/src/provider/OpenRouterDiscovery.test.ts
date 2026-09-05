import { afterEach, describe, expect, it, vi } from "vitest";
import { outboundHttp } from "@synara/shared/outboundHttp";
import { fetchOpenRouterModels } from "./OpenRouterDiscovery.ts";

export const liveOpenRouterModel = {
  id: "vendor/new-model",
  name: "New model",
  context_length: 262144,
  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
  supported_parameters: ["tools", "reasoning"],
  top_provider: { max_completion_tokens: 32768 },
  pricing: { prompt: "0.000001", completion: "0.000002" },
};

function respond(data: unknown, status = 200) {
  return vi.spyOn(outboundHttp, "request").mockResolvedValue({
    status,
    headers: new Headers(),
    body: Buffer.from(JSON.stringify(data)),
    url: "https://openrouter.ai/api/v1/models",
  });
}
afterEach(() => vi.restoreAllMocks());

describe("OpenRouter executable catalog", () => {
  it("uses a bounded public request and explicit API capability metadata", async () => {
    const request = respond({ data: [liveOpenRouterModel] });
    expect(await fetchOpenRouterModels()).toEqual([
      {
        id: "vendor/new-model",
        name: "New model",
        provider: "openrouter",
        api: "openai-completions",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 262144,
        maxTokens: 32768,
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://openrouter.ai/api/v1/models",
        method: "GET",
        policy: expect.objectContaining({
          allowedOrigins: ["https://openrouter.ai"],
          timeoutMs: 5000,
          maxResponseBytes: 8 * 1024 * 1024,
          maxRedirects: 0,
        }),
      }),
    );
    expect(request.mock.calls[0]?.[0]).not.toHaveProperty("headers");
  });
  it("skips malformed and unsupported entries without losing valid siblings", async () => {
    respond({
      data: [
        null,
        {},
        { ...liveOpenRouterModel, id: 42 },
        { ...liveOpenRouterModel, id: "missing-output", top_provider: null },
        {
          ...liveOpenRouterModel,
          id: "image-only",
          architecture: { input_modalities: ["text"], output_modalities: ["image"] },
        },
        { ...liveOpenRouterModel, id: "bad-cost", pricing: { prompt: "NaN", completion: "1" } },
        {
          ...liveOpenRouterModel,
          id: "plain",
          name: "Reasoning",
          context_length: 1000000,
          supported_parameters: ["tools"],
        },
        liveOpenRouterModel,
        liveOpenRouterModel,
      ],
    });
    const models = await fetchOpenRouterModels();
    expect(models.map((model) => model.id)).toEqual(["plain", "vendor/new-model"]);
    expect(models[0]?.reasoning).toBe(false);
  });
  it("retains fallback behavior on transport and invalid payload failures", async () => {
    const request = respond({ data: {} });
    expect(await fetchOpenRouterModels()).toEqual([]);
    request.mockRejectedValue(new Error("timeout or response too large"));
    expect(await fetchOpenRouterModels()).toEqual([]);
  });
});

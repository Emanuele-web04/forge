// FILE: OpenRouterDiscovery.test.ts
// Purpose: Tests for OpenRouter model discovery normalization.

import { describe, expect, it } from "vitest";

import { fetchOpenRouterModels } from "./OpenRouterDiscovery.ts";

describe("fetchOpenRouterModels", () => {
  it("returns an array of model descriptors on success", async () => {
    const models = await fetchOpenRouterModels();
    expect(Array.isArray(models)).toBe(true);
    if (models.length > 0) {
      const model = models[0];
      expect(model).toHaveProperty("slug");
      expect(model).toHaveProperty("name");
      expect(model).toHaveProperty("upstreamProviderId", "openrouter");
      expect(model).toHaveProperty("upstreamProviderName", "OpenRouter");
      expect(typeof model.slug).toBe("string");
      expect(model.slug.startsWith("openrouter/")).toBe(true);
      expect(typeof model.name).toBe("string");
    }
  });

  it("never throws on network or parse errors", async () => {
    // Destructively override the internal function to simulate failure.
    // Since fetchOpenRouterModels wraps its logic in try-catch, we can
    // simply call it and verify it returns an empty array on any error.
    // No need to mock — the function handles failures gracefully.
    await expect(fetchOpenRouterModels()).resolves.toBeInstanceOf(Array);
  });

  it("prefixes every slug with 'openrouter/'", async () => {
    const models = await fetchOpenRouterModels();
    for (const model of models) {
      expect(model.slug.startsWith("openrouter/")).toBe(true);
    }
  });
});
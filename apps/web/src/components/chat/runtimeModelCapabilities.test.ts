import type { ProviderModelDescriptor } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  resolveDevinModelVariant,
  resolveRuntimeModelDescriptor,
} from "./runtimeModelCapabilities";

describe("resolveRuntimeModelDescriptor", () => {
  it("matches a Claude model by its resolved canonical id", () => {
    const runtimeModels: ReadonlyArray<ProviderModelDescriptor> = [
      {
        slug: "sonnet",
        resolvedModel: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        supportsAutoMode: false,
      },
    ];

    expect(
      resolveRuntimeModelDescriptor({
        provider: "claudeAgent",
        model: "claude-sonnet-5",
        runtimeModels,
      }),
    ).toBe(runtimeModels[0]);
  });
});

describe("resolveDevinModelVariant", () => {
  it("returns undefined when no variant matches the requested traits (all-fast matrix)", () => {
    const runtimeModel: ProviderModelDescriptor = {
      slug: "devin",
      name: "Devin",
      supportsFastMode: true,
      modelVariants: [
        { model: "devin-fast-1", reasoningEffort: "medium", fastMode: true },
        { model: "devin-fast-2", reasoningEffort: "high", fastMode: true },
      ],
    };

    expect(
      resolveDevinModelVariant({
        runtimeModel,
        fastMode: false,
      }),
    ).toBeUndefined();
  });
});

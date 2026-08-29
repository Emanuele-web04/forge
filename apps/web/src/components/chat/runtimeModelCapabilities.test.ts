import type { ProviderModelDescriptor } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { resolveRuntimeModelDescriptor } from "./runtimeModelCapabilities";

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

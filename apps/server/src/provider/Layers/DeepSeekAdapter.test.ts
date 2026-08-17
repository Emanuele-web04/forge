import { describe, expect, it } from "vitest";

import { buildDeepSeekTurnPromptText } from "./DeepSeekAdapter.ts";

describe("buildDeepSeekTurnPromptText", () => {
  it("keeps regular turns unchanged", () => {
    expect(
      buildDeepSeekTurnPromptText({
        text: "Implement the feature",
        interactionMode: "default",
      }),
    ).toBe("Implement the feature");
  });

  it("instructs Harness to keep plan turns read-only", () => {
    const prompt = buildDeepSeekTurnPromptText({
      text: "Add a provider",
      interactionMode: "plan",
    });

    expect(prompt).toContain("Do not implement or mutate files");
    expect(prompt).toContain("User request:\nAdd a provider");
  });
});

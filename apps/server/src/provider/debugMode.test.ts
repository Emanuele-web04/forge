import { describe, expect, it } from "vitest";

import { PROVIDER_DEBUG_MODE_PROMPT_PREFIX, withProviderDebugModePrompt } from "./debugMode.ts";

describe("provider Debug mode prompt", () => {
  it("leaves non-Debug turns unchanged", () => {
    expect(withProviderDebugModePrompt({ text: "hello", interactionMode: "default" })).toBe(
      "hello",
    );
    expect(withProviderDebugModePrompt({ text: "plan it", interactionMode: "plan" })).toBe(
      "plan it",
    );
  });

  it("adds evidence and reproduction fallback instructions exactly once", () => {
    const once = withProviderDebugModePrompt({
      text: "Investigate the crash",
      interactionMode: "debug",
    });
    const twice = withProviderDebugModePrompt({ text: once, interactionMode: "debug" });

    expect(once).toContain("observe -> reproduce -> investigate -> fix -> verify");
    expect(once).toContain('"Reproduced", "Could not reproduce", and "Cancel"');
    expect(once).toContain("send the same instructions as normal text");
    expect(once.split(PROVIDER_DEBUG_MODE_PROMPT_PREFIX)).toHaveLength(2);
    expect(twice).toBe(once);
  });
});

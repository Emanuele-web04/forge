import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { isCommandMissingCause } from "./providerCliOutput";
import { probeProviderCliVersion } from "./providerCliVersionProbe";

describe("provider CLI missing-command classification", () => {
  it("recognizes the process runner's normalized command-not-found error", () => {
    expect(isCommandMissingCause(new Error("Command not found: codex"))).toBe(true);
  });

  it("keeps existing ENOENT and NotFound classifications", () => {
    expect(isCommandMissingCause(new Error("spawn codex ENOENT"))).toBe(true);
    expect(isCommandMissingCause(new Error("NotFound: codex"))).toBe(true);
  });

  it("classifies normalized runner failures as a missing provider CLI", async () => {
    const outcome = await Effect.runPromise(
      probeProviderCliVersion(Effect.fail(new Error("Command not found: codex")), 1_000),
    );

    expect(outcome.outcome).toBe("missing");
  });

  it("does not classify unrelated failures as missing commands", () => {
    expect(isCommandMissingCause(new Error("Authentication failed"))).toBe(false);
  });
});

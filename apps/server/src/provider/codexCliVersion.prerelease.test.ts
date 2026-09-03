import { describe, expect, it } from "vitest";

import { compareCodexCliVersions, parseCodexCliVersion } from "./codexCliVersion";

describe("Codex CLI prerelease versions", () => {
  it("preserves hyphens inside the prerelease suffix", () => {
    const version = parseCodexCliVersion("codex-cli 0.124.0-alpha-beta\n");
    expect(version).toBe("0.124.0-alpha-beta");
  });

  it("keeps distinct hyphenated prereleases distinct", () => {
    const comparison = compareCodexCliVersions("0.124.0-alpha-beta", "0.124.0-alpha-gamma");
    expect(comparison).toBeLessThan(0);
  });
});

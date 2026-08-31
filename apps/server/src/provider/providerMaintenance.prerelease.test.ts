import { describe, it, assert } from "@effect/vitest";

import { compareSemverVersions, parseGenericCliVersion } from "./providerMaintenance";

describe("provider maintenance prerelease versions", () => {
  it("preserves hyphens inside a prerelease suffix", () => {
    assert.strictEqual(
      parseGenericCliVersion("provider-cli 0.124.0-alpha-beta\n"),
      "0.124.0-alpha-beta",
    );
    assert.strictEqual(parseGenericCliVersion("provider 2.1-alpha-beta"), "2.1.0-alpha-beta");
  });

  it("keeps distinct hyphenated prereleases distinguishable", () => {
    assert.ok(compareSemverVersions("0.124.0-alpha-beta", "0.124.0-alpha-gamma") < 0);
  });
});

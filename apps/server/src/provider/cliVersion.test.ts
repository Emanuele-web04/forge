import { describe, expect, it } from "vitest";

import { compareCodexCliVersions, parseCodexCliVersion } from "./codexCliVersion.ts";
import { compareSemverVersions, parseGenericCliVersion } from "./providerMaintenance.ts";

describe.each([
  { name: "Codex", compare: compareCodexCliVersions, parse: parseCodexCliVersion },
  { name: "generic", compare: compareSemverVersions, parse: parseGenericCliVersion },
])("$name CLI versions", ({ compare, parse }) => {
  it.each([
    ["provider-cli v0.124.0-alpha-beta\n", "0.124.0-alpha-beta"],
    ["provider 2.1-alpha-beta", "2.1.0-alpha-beta"],
    ["no version here", null],
  ] as const)("extracts the version from %j", (output, expected) => {
    expect(parse(output)).toBe(expected);
  });

  it.each([
    ["1.0.0", "2.0.0", -1],
    ["1.2.0", "1.3.0", -1],
    ["1.2.9", "1.2.10", -1],
    ["0.124.0-alpha-beta", "0.124.0-alpha-gamma", -1],
    ["1.2.3-rc.10", "1.2.3-rc.2", 1],
    ["1.2.3-1", "1.2.3-alpha", -1],
    ["1.2.3-alpha", "1.2.3-alpha.1", -1],
    ["1.2.3-rc.1", "1.2.3", -1],
    [" 2 . 1 ", "2.1.0", 0],
    ["2.1.0-alpha.1", "2.1.0-alpha.1", 0],
  ] as const)("orders %s against %s", (left, right, expected) => {
    expect(Math.sign(compare(left, right))).toBe(expected);
    expect(Math.sign(compare(right, left))).toBe(expected === 0 ? 0 : -expected);
  });

  it("falls back to text ordering when a version cannot be parsed", () => {
    expect(compare("unknown", "2.1.0")).toBe("unknown".localeCompare("2.1.0"));
  });
});

describe("provider-specific CLI version boundaries", () => {
  it("strips a leading v for generic comparisons but preserves Codex's fallback", () => {
    expect(compareSemverVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareCodexCliVersions("v1.2.3", "1.2.3")).toBe("v1.2.3".localeCompare("1.2.3"));
  });

  it("keeps Codex's numeric-prefix parsing separate from generic numeric validation", () => {
    expect(compareCodexCliVersions("1.2suffix.3", "1.2.3")).toBe(0);
    expect(compareSemverVersions("1.2suffix.3", "1.2.3")).toBe(
      "1.2suffix.3".localeCompare("1.2.3"),
    );
  });

  it("retains Codex's finite-number check when extracting an oversized version", () => {
    const version = `${"9".repeat(400)}.1.0`;
    expect(parseCodexCliVersion(`codex-cli ${version}`)).toBeNull();
    expect(parseGenericCliVersion(`provider ${version}`)).toBe(version);
  });
});

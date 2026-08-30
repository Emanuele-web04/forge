import type { ProviderKind } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { visibleProviderAccountProviders } from "./ProviderAccountsSettingsPanel";

describe("visibleProviderAccountProviders", () => {
  it("shows account management only for enabled supported providers", () => {
    expect(visibleProviderAccountProviders(new Set<ProviderKind>())).toEqual([
      "claudeAgent",
      "codex",
    ]);
    expect(visibleProviderAccountProviders(new Set<ProviderKind>(["claudeAgent"]))).toEqual([
      "codex",
    ]);
    expect(
      visibleProviderAccountProviders(new Set<ProviderKind>(["claudeAgent", "codex"])),
    ).toEqual([]);
  });

  it("ignores disabled providers that do not support managed accounts", () => {
    expect(visibleProviderAccountProviders(new Set<ProviderKind>(["cursor", "opencode"]))).toEqual([
      "claudeAgent",
      "codex",
    ]);
  });
});

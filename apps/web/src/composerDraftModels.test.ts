import { DEFAULT_PROVIDER_PROFILE_ID, ProviderProfileId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  normalizeModelSelection,
  reconcileProviderScopedModelSelection,
} from "./composerDraftModels";

describe("normalizeModelSelection", () => {
  it("defaults legacy selections to the default provider profile", () => {
    expect(normalizeModelSelection({ provider: "codex", model: "gpt-5.6-codex" })).toEqual({
      provider: "codex",
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
      model: "gpt-5.6-codex",
    });
  });

  it("preserves an explicit provider profile", () => {
    expect(
      normalizeModelSelection({
        provider: "codex",
        profileId: "work",
        model: "gpt-5.6-codex",
      }),
    ).toEqual({
      provider: "codex",
      profileId: "work",
      model: "gpt-5.6-codex",
    });
  });

  it("rejects an explicit invalid provider profile instead of falling back", () => {
    expect(
      normalizeModelSelection({
        provider: "codex",
        profileId: "../work",
        model: "gpt-5.6-codex",
      }),
    ).toBeNull();
  });
});

describe("reconcileProviderScopedModelSelection", () => {
  it("does not carry model options across provider profiles", () => {
    const requested = {
      provider: "codex" as const,
      profileId: ProviderProfileId.makeUnsafe("work"),
      model: "gpt-5.6-codex",
    };

    expect(
      reconcileProviderScopedModelSelection(requested, {
        provider: "codex",
        profileId: DEFAULT_PROVIDER_PROFILE_ID,
        model: "gpt-5.6-codex",
        options: { reasoningEffort: "high" },
      }),
    ).toEqual(requested);
  });
});

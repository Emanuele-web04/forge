import assert from "node:assert/strict";

import { ProviderProfileId } from "@synara/contracts";
import { it } from "@effect/vitest";

import {
  defaultProviderTarget,
  providerTargetFromModelSelection,
  providerTargetFromSource,
  providerTargetsEqual,
} from "./providerTarget";

it("resolves legacy provider sources to the default provider profile", () => {
  assert.deepEqual(
    providerTargetFromSource({
      provider: "codex",
    }),
    {
      provider: "codex",
      profileId: "default",
    },
  );
});

it("preserves explicit provider profile routing", () => {
  const target = providerTargetFromModelSelection({
    provider: "codex",
    profileId: ProviderProfileId.makeUnsafe("work"),
    model: "gpt-5.6-codex",
  });

  assert.deepEqual(target, {
    provider: "codex",
    profileId: "work",
  });
  assert.equal(providerTargetsEqual(target, defaultProviderTarget("codex")), false);
  assert.equal(providerTargetsEqual(target, { ...target }), true);
});

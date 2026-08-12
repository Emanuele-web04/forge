import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { DEFAULT_PROVIDER_PROFILE_ID, ProviderProfileId } from "./providerProfile";

const decodeProviderProfileId = Schema.decodeUnknownEffect(ProviderProfileId);

it.effect("decodes stable provider profile slugs", () =>
  Effect.gen(function* () {
    assert.equal(yield* decodeProviderProfileId("work_account"), "work_account");
    assert.equal(DEFAULT_PROVIDER_PROFILE_ID, "default");
  }),
);

it("rejects provider profile ids that are unsafe as routing keys", () => {
  assert.equal(Schema.is(ProviderProfileId)("../work"), false);
  assert.equal(Schema.is(ProviderProfileId)("Work Account"), false);
  assert.equal(Schema.is(ProviderProfileId)(""), false);
});

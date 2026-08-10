import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  CodexProviderProfileSummary,
  ProviderProfileLoginStartResult,
  ProviderProfilesCreateInput,
  ProviderProfilesSetEnabledInput,
} from "./providerProfileManagement";

it.effect("decodes redacted Codex profile summaries", () =>
  Effect.gen(function* () {
    const summary = yield* Schema.decodeUnknownEffect(CodexProviderProfileSummary)({
      target: { provider: "codex", profileId: "codex_work" },
      displayName: "Work",
      enabled: false,
      lifecycle: "active",
      storageKind: "managed",
      storageKey: "must-not-cross-the-contract",
      codexHomePath: "/private/profile/home",
    });

    assert.deepEqual(summary, {
      target: { provider: "codex", profileId: "codex_work" },
      displayName: "Work",
      enabled: false,
      lifecycle: "active",
      storageKind: "managed",
    });
  }),
);

it("accepts bounded managed-profile mutations and rejects unsafe targets", () => {
  assert.equal(
    Schema.is(ProviderProfilesCreateInput)({ provider: "codex", displayName: "Personal" }),
    true,
  );
  assert.equal(
    Schema.is(ProviderProfilesCreateInput)({ provider: "codex", displayName: " ".repeat(81) }),
    false,
  );
  assert.equal(
    Schema.is(ProviderProfilesSetEnabledInput)({
      target: { provider: "codex", profileId: "../other" },
      enabled: true,
    }),
    false,
  );
  assert.equal(
    Schema.is(ProviderProfilesSetEnabledInput)({
      target: { provider: "claudeAgent", profileId: "work" },
      enabled: true,
    }),
    false,
  );
});

it("accepts only bounded HTTP(S) login challenges", () => {
  const base = {
    target: { provider: "codex", profileId: "codex_work" },
    expiresAt: "2026-08-10T00:15:00.000Z",
  };
  assert.equal(
    Schema.is(ProviderProfileLoginStartResult)({
      ...base,
      challenge: { method: "browser", authUrl: "https://auth.example.test/start?x=1" },
    }),
    true,
  );
  assert.equal(
    Schema.is(ProviderProfileLoginStartResult)({
      ...base,
      challenge: { method: "browser", authUrl: "javascript:alert(1)" },
    }),
    false,
  );
  assert.equal(
    Schema.is(ProviderProfileLoginStartResult)({
      ...base,
      challenge: { method: "device-code", verificationUrl: "not a URL", userCode: "ABCD" },
    }),
    false,
  );
  assert.equal(
    Schema.is(ProviderProfileLoginStartResult)({
      ...base,
      challenge: {
        method: "device-code",
        verificationUrl: "https://auth.example.test/device",
        userCode: "x".repeat(257),
      },
    }),
    false,
  );
});

import {
  DEFAULT_PROVIDER_PROFILE_ID,
  ProviderProfileId,
  ThreadId,
  type OrchestrationSession,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  canAdoptFirstTurnTarget,
  deriveTurnStartModelSelection,
  deriveTurnStartSession,
} from "./turnStartSession.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-turn-start-session");
const REQUESTED_AT = "2026-07-21T00:00:00.000Z";

function makeSession(status: OrchestrationSession["status"]): OrchestrationSession {
  return {
    threadId: THREAD_ID,
    status,
    providerName: "codex",
    runtimeMode: "approval-required",
    activeTurnId: null,
    lastError: status === "error" ? "runtime exploded" : null,
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
}

function derive(currentSession: OrchestrationSession | null) {
  return deriveTurnStartSession({
    threadId: THREAD_ID,
    currentSession,
    providerName: "pi",
    requestedRuntimeMode: "full-access",
    requestedAt: REQUESTED_AT,
  });
}

describe("deriveTurnStartSession", () => {
  it.each([
    [{ hasLatestTurn: false, hasSession: false, messageCount: 0 }, true],
    [{ hasLatestTurn: false, hasSession: false, messageCount: 1 }, true],
    [{ hasLatestTurn: true, hasSession: false, messageCount: 0 }, false],
    [{ hasLatestTurn: false, hasSession: true, messageCount: 0 }, false],
    [{ hasLatestTurn: false, hasSession: false, messageCount: 2 }, false],
  ] as const)("resolves whether first-turn target adoption is safe", (input, expected) => {
    expect(canAdoptFirstTurnTarget(input)).toBe(expected);
  });

  it("keeps an established provider when a later turn requests another provider", () => {
    expect(
      deriveTurnStartModelSelection({
        currentModelSelection: {
          provider: "codex",
          profileId: DEFAULT_PROVIDER_PROFILE_ID,
          model: "gpt-5-codex",
        },
        requestedModelSelection: {
          provider: "pi",
          profileId: DEFAULT_PROVIDER_PROFILE_ID,
          model: "openai/gpt-5",
        },
        canAdoptRequestedTarget: false,
      }),
    ).toEqual({
      provider: "codex",
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
      model: "gpt-5-codex",
    });
  });

  it("allows an empty thread to adopt its first requested provider", () => {
    expect(
      deriveTurnStartModelSelection({
        currentModelSelection: {
          provider: "codex",
          profileId: DEFAULT_PROVIDER_PROFILE_ID,
          model: "gpt-5-codex",
        },
        requestedModelSelection: {
          provider: "pi",
          profileId: DEFAULT_PROVIDER_PROFILE_ID,
          model: "openai/gpt-5",
        },
        canAdoptRequestedTarget: true,
      }),
    ).toEqual({
      provider: "pi",
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
      model: "openai/gpt-5",
    });
  });

  it("keeps an established profile when a later turn requests another profile", () => {
    expect(
      deriveTurnStartModelSelection({
        currentModelSelection: {
          provider: "codex",
          profileId: DEFAULT_PROVIDER_PROFILE_ID,
          model: "gpt-5-codex",
        },
        requestedModelSelection: {
          provider: "codex",
          profileId: ProviderProfileId.makeUnsafe("work"),
          model: "gpt-5-codex",
        },
        canAdoptRequestedTarget: false,
      }),
    ).toMatchObject({ provider: "codex", profileId: "default" });
  });

  it("allows an empty thread to adopt its first requested profile", () => {
    expect(
      deriveTurnStartModelSelection({
        currentModelSelection: {
          provider: "codex",
          profileId: DEFAULT_PROVIDER_PROFILE_ID,
          model: "gpt-5-codex",
        },
        requestedModelSelection: {
          provider: "codex",
          profileId: ProviderProfileId.makeUnsafe("work"),
          model: "gpt-5-codex",
        },
        canAdoptRequestedTarget: true,
      }),
    ).toMatchObject({ provider: "codex", profileId: "work" });
  });

  it("creates a starting session when no session exists", () => {
    expect(derive(null)).toEqual({
      threadId: THREAD_ID,
      status: "starting",
      providerName: "pi",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: REQUESTED_AT,
    });
  });

  it("preserves established provider settings when restarting an idle session", () => {
    expect(derive(makeSession("ready"))).toMatchObject({
      status: "starting",
      providerName: "codex",
      runtimeMode: "approval-required",
      activeTurnId: null,
      lastError: null,
    });
  });

  it.each(["starting", "running"] as const)("does not replace a %s session", (status) => {
    expect(derive(makeSession(status))).toBeNull();
  });

  it("clears terminal error details when a new turn starts", () => {
    expect(derive(makeSession("error"))).toMatchObject({
      status: "starting",
      activeTurnId: null,
      lastError: null,
    });
  });
});

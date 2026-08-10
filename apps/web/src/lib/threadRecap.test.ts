// FILE: threadRecap.test.ts
// Purpose: Verify compact recap inputs only advance on real transcript messages.
// Layer: Unit test

import { DEFAULT_PROVIDER_PROFILE_ID } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { MessageId, ThreadId } from "@synara/contracts";
import type { ChatMessage, Thread } from "~/types";
import {
  DEFAULT_INITIAL_THREAD_RECAP_IDLE_MS,
  DEFAULT_REFRESH_THREAD_RECAP_IDLE_MS,
  THREAD_RECAP_STORAGE_KEY,
  deriveThreadRecapSource,
  persistThreadRecapCache,
  readPersistedThreadRecapCache,
  resolveThreadRecapIdleMs,
  shouldScheduleThreadRecapGeneration,
  upsertPersistedThreadRecap,
  type PersistedThreadRecapCache,
} from "./threadRecap";

interface MemoryStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
}

function createMemoryStorage(): MemoryStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

function message(input: {
  readonly id: string;
  readonly role: ChatMessage["role"];
  readonly text: string;
  readonly streaming?: boolean;
}): ChatMessage {
  return {
    id: input.id as MessageId,
    role: input.role,
    text: input.text,
    createdAt: "2026-06-05T10:00:00.000Z",
    streaming: input.streaming ?? false,
  };
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1" as ThreadId,
    codexThreadId: null,
    projectId: "project-1" as Thread["projectId"],
    title: "Environment panel",
    modelSelection: { provider: "codex", profileId: DEFAULT_PROVIDER_PROFILE_ID, model: "gpt-5.4-mini" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-06-05T10:00:00.000Z",
    latestTurn: null,
    turnDiffSummaries: [],
    activities: [],
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

describe("deriveThreadRecapSource", () => {
  it("builds initial material from real user and assistant messages", () => {
    const source = deriveThreadRecapSource({
      thread: thread({
        messages: [
          message({ id: "m1", role: "system", text: "hidden setup" }),
          message({ id: "m2", role: "user", text: "Add a recap to the panel." }),
          message({ id: "m3", role: "assistant", text: "Implemented the recap hook." }),
        ],
      }),
      hasPreviousRecap: false,
    });

    expect(source.hasNewMaterial).toBe(true);
    expect(source.latestMessageId).toBe("m3");
    expect(source.newMaterial).toContain("[user] Add a recap to the panel.");
    expect(source.newMaterial).toContain("[assistant] Implemented the recap hook.");
    expect(source.newMaterial).not.toContain("hidden setup");
  });

  it("does not advance when only tool activity changes after the covered message", () => {
    const source = deriveThreadRecapSource({
      thread: thread({
        messages: [message({ id: "m1", role: "user", text: "Review this." })],
        activities: [
          {
            id: "event-1" as Thread["activities"][number]["id"],
            tone: "tool",
            kind: "tool.command",
            summary: "Read files",
            payload: {},
            turnId: null,
            createdAt: "2026-06-05T10:01:00.000Z",
          },
        ],
      }),
      previousCoveredMessageId: "m1",
      hasPreviousRecap: true,
    });

    expect(source.hasNewMaterial).toBe(false);
    expect(source.currentState).toContain("Read files");
  });

  it("uses only delta messages when a previous recap exists", () => {
    const source = deriveThreadRecapSource({
      thread: thread({
        messages: [
          message({ id: "m1", role: "user", text: "First request." }),
          message({ id: "m2", role: "assistant", text: "First answer." }),
          message({ id: "m3", role: "user", text: "Now make it shorter." }),
        ],
      }),
      previousCoveredMessageId: "m2",
      hasPreviousRecap: true,
    });

    expect(source.hasNewMaterial).toBe(true);
    expect(source.newMaterial).toContain("Now make it shorter.");
    expect(source.newMaterial).not.toContain("First request.");
    expect(source.newMaterial).not.toContain("First answer.");
  });

  it("keeps initial recap material to a small recent message window", () => {
    const source = deriveThreadRecapSource({
      thread: thread({
        messages: Array.from({ length: 8 }, (_, index) =>
          message({
            id: `m${index + 1}`,
            role: index % 2 === 0 ? "user" : "assistant",
            text: `Message ${index + 1}`,
          }),
        ),
      }),
      hasPreviousRecap: false,
    });

    expect(source.newMaterial).not.toContain("Message 1");
    expect(source.newMaterial).not.toContain("Message 2");
    expect(source.newMaterial).toContain("Message 3");
    expect(source.newMaterial).toContain("Message 8");
  });

  it("keeps refresh material to an even smaller delta window", () => {
    const source = deriveThreadRecapSource({
      thread: thread({
        messages: Array.from({ length: 7 }, (_, index) =>
          message({
            id: `m${index + 1}`,
            role: index % 2 === 0 ? "user" : "assistant",
            text: `Delta ${index + 1}`,
          }),
        ),
      }),
      previousCoveredMessageId: "m1",
      hasPreviousRecap: true,
    });

    expect(source.newMaterial).not.toContain("Delta 2");
    expect(source.newMaterial).not.toContain("Delta 3");
    expect(source.newMaterial).toContain("Delta 4");
    expect(source.newMaterial).toContain("Delta 7");
  });
});

describe("shouldScheduleThreadRecapGeneration", () => {
  const schedulableInput = {
    cachedSourceSignature: "previous-signature",
    cwd: "/repo",
    enabled: true,
    hasStreamingAssistant: false,
    inFlightSourceSignature: null,
    latestTurnSettled: true,
    sourceHasNewMaterial: true,
    sourceSignature: "thread-1|m2:user:12",
    threadId: "thread-1" as ThreadId,
  } as const;

  it("schedules only when recap generation is enabled by the open panel", () => {
    expect(shouldScheduleThreadRecapGeneration(schedulableInput)).toBe(true);
    expect(
      shouldScheduleThreadRecapGeneration({
        ...schedulableInput,
        enabled: false,
      }),
    ).toBe(false);
  });

  it("does not schedule while assistant output is still streaming or unsettled", () => {
    expect(
      shouldScheduleThreadRecapGeneration({
        ...schedulableInput,
        hasStreamingAssistant: true,
      }),
    ).toBe(false);
    expect(
      shouldScheduleThreadRecapGeneration({
        ...schedulableInput,
        latestTurnSettled: false,
      }),
    ).toBe(false);
  });

  it("does not repeat a cached or in-flight source signature", () => {
    expect(
      shouldScheduleThreadRecapGeneration({
        ...schedulableInput,
        cachedSourceSignature: schedulableInput.sourceSignature,
      }),
    ).toBe(false);
    expect(
      shouldScheduleThreadRecapGeneration({
        ...schedulableInput,
        inFlightSourceSignature: schedulableInput.sourceSignature,
      }),
    ).toBe(false);
  });

  it("does not immediately retry a source signature that already failed", () => {
    expect(
      shouldScheduleThreadRecapGeneration({
        ...schedulableInput,
        failedSourceSignature: schedulableInput.sourceSignature,
      }),
    ).toBe(false);
  });
});

describe("resolveThreadRecapIdleMs", () => {
  it("uses a shorter delay for the first recap and a slower delay for refreshes", () => {
    expect(resolveThreadRecapIdleMs({ hasExistingRecap: false })).toBe(
      DEFAULT_INITIAL_THREAD_RECAP_IDLE_MS,
    );
    expect(resolveThreadRecapIdleMs({ hasExistingRecap: true })).toBe(
      DEFAULT_REFRESH_THREAD_RECAP_IDLE_MS,
    );
  });

  it("allows one override for tests or separate initial/refresh overrides", () => {
    expect(
      resolveThreadRecapIdleMs({
        hasExistingRecap: false,
        idleMsOverride: 5,
      }),
    ).toBe(5);
    expect(
      resolveThreadRecapIdleMs({
        hasExistingRecap: true,
        idleMsOverride: 5,
      }),
    ).toBe(5);
    expect(
      resolveThreadRecapIdleMs({
        hasExistingRecap: false,
        idleMsOverride: 5,
        initialIdleMsOverride: 10,
      }),
    ).toBe(10);
    expect(
      resolveThreadRecapIdleMs({
        hasExistingRecap: true,
        idleMsOverride: 5,
        refreshIdleMsOverride: 20,
      }),
    ).toBe(20);
  });
});

describe("thread recap persistence", () => {
  it("persists and hydrates a valid per-thread recap", () => {
    const storage = createMemoryStorage();
    const recap = {
      text: "Environment panel recap is compact and ready.",
      coveredMessageId: "m3",
      sourceSignature: "thread-1|m3:assistant",
      updatedAt: "2026-06-05T10:03:00.000Z",
    };

    persistThreadRecapCache({ "thread-1": recap }, storage);

    expect(readPersistedThreadRecapCache(storage)).toEqual({ "thread-1": recap });
  });

  it("drops malformed persisted entries and unsafe keys", () => {
    const storage = createMemoryStorage();
    storage.setItem(
      THREAD_RECAP_STORAGE_KEY,
      JSON.stringify({
        "thread-ok": {
          text: "Valid recap.",
          coveredMessageId: null,
          sourceSignature: "thread-ok|m1",
          updatedAt: "2026-06-05T10:00:00.000Z",
        },
        "thread-bad": {
          text: "",
          coveredMessageId: null,
          sourceSignature: "thread-bad|m1",
          updatedAt: "2026-06-05T10:00:00.000Z",
        },
        ["__proto__"]: {
          text: "Prototype pollution attempt.",
          coveredMessageId: null,
          sourceSignature: "polluted",
          updatedAt: "2026-06-05T10:00:00.000Z",
        },
      }),
    );

    const hydrated = readPersistedThreadRecapCache(storage);

    expect(hydrated).toEqual({
      "thread-ok": {
        text: "Valid recap.",
        coveredMessageId: null,
        sourceSignature: "thread-ok|m1",
        updatedAt: "2026-06-05T10:00:00.000Z",
      },
    });
    expect(Object.prototype).not.toHaveProperty("text", "Prototype pollution attempt.");
  });

  it("caps persisted recap cache to the freshest threads", () => {
    const cache = Array.from({ length: 90 }, (_, index) => {
      const threadId = `thread-${index}`;
      return [
        threadId,
        {
          text: `Recap ${index}`,
          coveredMessageId: `m${index}`,
          sourceSignature: `${threadId}|m${index}`,
          updatedAt: new Date(Date.UTC(2026, 5, 5, 10, index)).toISOString(),
        },
      ] as const;
    }).reduce<PersistedThreadRecapCache>(
      (current, [threadId, recap]) =>
        upsertPersistedThreadRecap(current, threadId as ThreadId, recap),
      {},
    );

    expect(Object.keys(cache)).toHaveLength(80);
    expect(cache["thread-89"]).toBeDefined();
    expect(cache["thread-0"]).toBeUndefined();
  });
});

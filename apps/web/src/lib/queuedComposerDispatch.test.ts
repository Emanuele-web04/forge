import { ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QueuedComposerTurn } from "../composerDraftStore";
import { resetComposerDraftStore } from "../composerDraftStoreTestFixtures";
import { useStore } from "../store";
import { initialState } from "../storeState";
import { makeState, makeThread } from "../storeTestFixtures";
import { dispatchQueuedComposerTurnHeadless } from "./queuedComposerDispatch";

const nativeApiMocks = vi.hoisted(() => ({
  dispatchCommand: vi.fn(async () => undefined),
}));

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: {
      dispatchCommand: nativeApiMocks.dispatchCommand,
    },
  }),
}));

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

function makeQueuedChatTurn(): QueuedComposerTurn {
  return {
    id: "queued-chat-1",
    kind: "chat",
    createdAt: "2026-03-13T12:00:00.000Z",
    previewText: "follow up after the turn",
    prompt: "follow up after the turn",
    images: [],
    files: [],
    assistantSelections: [],
    browserAnnotations: [],
    terminalContexts: [],
    fileComments: [],
    pastedTexts: [],
    skills: [],
    mentions: [],
    selectedProvider: "codex",
    selectedModel: "gpt-5",
    selectedPromptEffort: null,
    modelSelection: {
      provider: "codex",
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    envMode: "local",
  };
}

function makeQueuedPlanFollowUp(): QueuedComposerTurn {
  return {
    id: "queued-plan-1",
    kind: "plan-follow-up",
    createdAt: "2026-03-13T12:00:00.000Z",
    previewText: "implement the plan",
    text: "implement the plan",
    interactionMode: "default",
    selectedProvider: "codex",
    selectedModel: "gpt-5",
    selectedPromptEffort: null,
    modelSelection: {
      provider: "codex",
      model: "gpt-5",
    },
    runtimeMode: "full-access",
  };
}

describe("dispatchQueuedComposerTurnHeadless", () => {
  beforeEach(() => {
    resetComposerDraftStore();
    useStore.setState(initialState);
    nativeApiMocks.dispatchCommand.mockClear();
    useStore.setState(makeState(makeThread({ id: THREAD_ID })));
  });

  afterEach(() => {
    resetComposerDraftStore();
    useStore.setState(initialState);
  });

  it("dispatches a snapshotted chat turn with dispatchMode queue", async () => {
    const queuedTurn = makeQueuedChatTurn();
    const succeeded = await dispatchQueuedComposerTurnHeadless({
      threadId: THREAD_ID,
      queuedTurn,
      dispatchMode: "queue",
      assistantDeliveryMode: "streaming",
    });

    expect(succeeded).toBe(true);
    expect(nativeApiMocks.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.turn.start",
        threadId: THREAD_ID,
        dispatchMode: "queue",
        interactionMode: "default",
        runtimeMode: "full-access",
        assistantDeliveryMode: "streaming",
        message: expect.objectContaining({
          role: "user",
          text: "follow up after the turn",
        }),
      }),
    );
  });

  it("dispatches a snapshotted plan follow-up as its own turn kind", async () => {
    const succeeded = await dispatchQueuedComposerTurnHeadless({
      threadId: THREAD_ID,
      queuedTurn: makeQueuedPlanFollowUp(),
      dispatchMode: "queue",
      assistantDeliveryMode: "buffered",
    });

    expect(succeeded).toBe(true);
    expect(nativeApiMocks.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.turn.start",
        threadId: THREAD_ID,
        dispatchMode: "queue",
        interactionMode: "default",
        assistantDeliveryMode: "buffered",
        message: expect.objectContaining({
          role: "user",
          text: "implement the plan",
          attachments: [],
        }),
      }),
    );
  });

  it("returns false when the thread is not in the store", async () => {
    useStore.setState(initialState);
    const succeeded = await dispatchQueuedComposerTurnHeadless({
      threadId: THREAD_ID,
      queuedTurn: makeQueuedChatTurn(),
      dispatchMode: "queue",
      assistantDeliveryMode: "streaming",
    });
    expect(succeeded).toBe(false);
    expect(nativeApiMocks.dispatchCommand).not.toHaveBeenCalled();
  });
});

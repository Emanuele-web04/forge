import { ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QueuedComposerTurn } from "../composerDraftDomain";
import type { QueuedComposerChatTurn } from "../composerDraftDomain";
import { resetComposerDraftStore } from "../composerDraftStoreTestFixtures";
import { useStore } from "../store";
import { initialState } from "../storeState";
import { makeState, makeThread } from "../storeTestFixtures";
import { dispatchQueuedComposerTurnHeadless } from "./queuedComposerDispatch";

const nativeApiMocks = vi.hoisted(() => ({
  dispatchCommand: vi.fn(async (_command: unknown) => undefined),
}));

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: {
      dispatchCommand: nativeApiMocks.dispatchCommand,
    },
  }),
}));

const THREAD_ID = ThreadId.makeUnsafe("thread-1");

function makeQueuedChatTurn(): QueuedComposerChatTurn {
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
    workItems: [],
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

  it("serializes queued work items identically to the live send path", async () => {
    const queuedTurn: QueuedComposerTurn = {
      ...makeQueuedChatTurn(),
      pastedTexts: [
        {
          id: "pasted-1",
          createdAt: "2026-03-13T12:00:00.000Z",
          text: "pasted log line",
          lineCount: 1,
          charCount: "pasted log line".length,
        },
      ],
      workItems: [
        {
          id: "work-item-1",
          kind: "issue" as const,
          number: 712,
          title: "Composer drops draft on reload",
          state: "open" as const,
          url: "https://github.com/owner/repo/issues/712",
          bodyExcerpt: "Steps: open a draft, reload the tab.",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: "2024-01-02T00:00:00Z",
        },
      ],
    };
    const succeeded = await dispatchQueuedComposerTurnHeadless({
      threadId: THREAD_ID,
      queuedTurn,
      dispatchMode: "queue",
      assistantDeliveryMode: "streaming",
    });

    expect(succeeded).toBe(true);
    const turnStartCall = nativeApiMocks.dispatchCommand.mock.calls
      .map((call) => call[0] as { type?: string; message?: { text: string } })
      .find((command) => command.type === "thread.turn.start");
    expect(turnStartCall).toBeDefined();
    const text = turnStartCall!.message!.text;
    expect(text.match(/<attached_work_items>/g)).toHaveLength(1);
    const pastedIndex = text.indexOf("<pasted_text>");
    const workItemsIndex = text.indexOf("<attached_work_items>");
    expect(pastedIndex).toBeGreaterThan(-1);
    expect(workItemsIndex).toBeGreaterThan(pastedIndex);
    expect(text).toContain('"number": 712');
    // The queued preview never leaks the serialized block.
    expect(queuedTurn.previewText).not.toContain("<attached_work_items>");
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

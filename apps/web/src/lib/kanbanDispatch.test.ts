// FILE: kanbanDispatch.test.ts
// Purpose: Verifies Kanban draft dispatch rejects unavailable provider profiles before side effects.
// Layer: Web orchestration helper tests

import { ProjectId, ProviderProfileId, ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  resolveModelSelection: vi.fn(),
  dispatchCommand: vi.fn(),
  stageAttachments: vi.fn(),
  markOptimisticDispatch: vi.fn(),
  clearOptimisticDispatch: vi.fn(),
  promoteThreadCreate: vi.fn(),
  getDraftThread: vi.fn(),
}));

vi.mock("../components/kanban/kanban.logic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../components/kanban/kanban.logic")>()),
  buildKanbanComposerDraftSnapshot: () => ({ prompt: "Use the work account", hasAttachments: false }),
}));
vi.mock("../composerDraftStore", () => ({
  resolvePreferredComposerModelSelection: harness.resolveModelSelection,
  useComposerDraftStore: {
    getState: () => ({
      draftsByThreadId: { "thread-kanban-work": { prompt: "Use the work account" } },
      getDraftThread: harness.getDraftThread,
      clearComposerContent: vi.fn(),
    }),
  },
}));
vi.mock("../kanbanUiStore", () => ({
  useKanbanUiStore: {
    getState: () => ({
      markOptimisticDispatch: harness.markOptimisticDispatch,
      clearOptimisticDispatch: harness.clearOptimisticDispatch,
    }),
  },
}));
vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({ orchestration: { dispatchCommand: harness.dispatchCommand } }),
}));
vi.mock("../store", () => ({
  useStore: { getState: () => ({ projects: [] }) },
}));
vi.mock("./composerSend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./composerSend")>()),
  stageUploadComposerAttachments: harness.stageAttachments,
}));
vi.mock("./threadCreatePromotion", () => ({
  promoteThreadCreate: harness.promoteThreadCreate,
}));

import { dispatchKanbanDraftThread } from "./kanbanDispatch";

const THREAD_ID = ThreadId.makeUnsafe("thread-kanban-work");
const PROJECT_ID = ProjectId.makeUnsafe("project-kanban-work");

beforeEach(() => {
  for (const mock of [
    harness.resolveModelSelection,
    harness.dispatchCommand,
    harness.stageAttachments,
    harness.markOptimisticDispatch,
    harness.clearOptimisticDispatch,
    harness.promoteThreadCreate,
    harness.getDraftThread,
  ]) {
    mock.mockReset();
  }
  harness.resolveModelSelection.mockReturnValue({
    provider: "codex",
    profileId: ProviderProfileId.makeUnsafe("work"),
    model: "gpt-5.6-sol",
  });
});

describe("dispatchKanbanDraftThread provider profiles", () => {
  it("rejects a saved non-default draft before staging or durable UI mutations", async () => {
    await expect(
      dispatchKanbanDraftThread({
        threadId: THREAD_ID,
        projectId: PROJECT_ID,
        thread: null,
        defaultProvider: "codex",
        assistantDeliveryMode: "streaming",
      }),
    ).resolves.toEqual({
      kind: "error",
      message: "Provider profile 'work' is not configured for provider 'codex'.",
    });

    expect(harness.stageAttachments).not.toHaveBeenCalled();
    expect(harness.markOptimisticDispatch).not.toHaveBeenCalled();
    expect(harness.promoteThreadCreate).not.toHaveBeenCalled();
    expect(harness.dispatchCommand).not.toHaveBeenCalled();
    expect(harness.getDraftThread).not.toHaveBeenCalled();
  });
});

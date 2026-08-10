// FILE: useKanbanTaskSubmit.test.ts
// Purpose: Verifies provider-profile safety at the Kanban task send boundary.
// Layer: Web Kanban hook tests

import {
  ProjectId,
  ProviderProfileId,
  ThreadId,
  type ModelSlug,
} from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  draftsByThreadId: {} as Record<string, unknown>,
  navigate: vi.fn(),
  toast: vi.fn(),
  refreshStatuses: vi.fn(),
  waitForPendingImages: vi.fn(),
  createDraft: vi.fn(),
  createAndSend: vi.fn(),
  resolveAvailability: vi.fn(),
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useRef: <T>(value: T) => ({ current: value }),
  useState: <T>(value: T) => [value, vi.fn()] as const,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => harness.navigate }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: harness.toast } }));
vi.mock("~/composerDraftStore", () => {
  const useComposerDraftStore = {
    getState: () => ({ draftsByThreadId: harness.draftsByThreadId }),
  };
  return { useComposerDraftStore };
});
vi.mock("~/hooks/useProviderStatusRefresh", () => ({
  useRefreshProviderStatusesNow: () => harness.refreshStatuses,
}));
vi.mock("~/lib/kanbanTaskCreate", () => ({
  createKanbanDraftTask: harness.createDraft,
  createAndSendKanbanTask: harness.createAndSend,
}));
vi.mock("~/lib/providerAvailability", () => ({
  resolveProviderSendAvailabilityWithRefresh: harness.resolveAvailability,
}));

import { useKanbanTaskSubmit } from "./useKanbanTaskSubmit";

const PROJECT_ID = ProjectId.makeUnsafe("project-kanban-profile");
const SCRATCH_THREAD_ID = ThreadId.makeUnsafe("thread-kanban-profile");
const MODEL = "gpt-5.6-sol" as ModelSlug;
const WORK_PROFILE_ID = ProviderProfileId.makeUnsafe("work");

function renderSubmit(sendAsDraft: boolean) {
  return useKanbanTaskSubmit({
    selectedProjectId: PROJECT_ID,
    hasSendableContent: true,
    selectedProvider: "codex",
    selectedModel: MODEL,
    selectedModelSupportsAutoMode: undefined,
    taskPreview: "Profile-aware task",
    trimmedPrompt: "Profile-aware task",
    scratchThreadId: SCRATCH_THREAD_ID,
    runtimeMode: "approval-required",
    interactionMode: "default",
    envMode: "local",
    sendAsDraft,
    defaultProvider: "codex",
    assistantDeliveryMode: "streaming",
    providerOptionsForDispatch: undefined,
    providerStatuses: [],
    isPreparingImages: false,
    waitForPendingImages: harness.waitForPendingImages,
    onOpenChange: vi.fn(),
  });
}

beforeEach(() => {
  harness.draftsByThreadId = {
    [SCRATCH_THREAD_ID]: {
      modelSelectionByProvider: {
        codex: {
          provider: "codex",
          profileId: WORK_PROFILE_ID,
          model: MODEL,
        },
      },
    },
  };
  for (const mock of [
    harness.navigate,
    harness.toast,
    harness.refreshStatuses,
    harness.waitForPendingImages,
    harness.createDraft,
    harness.createAndSend,
    harness.resolveAvailability,
  ]) {
    mock.mockReset();
  }
  harness.waitForPendingImages.mockResolvedValue(undefined);
  harness.resolveAvailability.mockResolvedValue({ usable: true });
});

describe("useKanbanTaskSubmit provider profiles", () => {
  it("rejects an unavailable profile before images, discovery, or task creation", async () => {
    await renderSubmit(false).handleCreate();

    expect(harness.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Provider profile 'work' is not configured for provider 'codex'.",
    });
    expect(harness.waitForPendingImages).not.toHaveBeenCalled();
    expect(harness.resolveAvailability).not.toHaveBeenCalled();
    expect(harness.refreshStatuses).not.toHaveBeenCalled();
    expect(harness.createDraft).not.toHaveBeenCalled();
    expect(harness.createAndSend).not.toHaveBeenCalled();
    expect(harness.navigate).not.toHaveBeenCalled();
  });

  it("preserves a non-default profile when saving a draft without dispatching", async () => {
    await renderSubmit(true).handleCreate();

    expect(harness.waitForPendingImages).toHaveBeenCalledOnce();
    expect(harness.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelection: expect.objectContaining({
          provider: "codex",
          profileId: WORK_PROFILE_ID,
          model: MODEL,
        }),
      }),
    );
    expect(harness.resolveAvailability).not.toHaveBeenCalled();
    expect(harness.createAndSend).not.toHaveBeenCalled();
  });
});

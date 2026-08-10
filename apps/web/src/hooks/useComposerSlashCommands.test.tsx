// FILE: useComposerSlashCommands.test.tsx
// Purpose: Locks provider-profile guards around imperative composer slash-command discovery.
// Layer: Web hook tests

import { ProviderProfileId, ThreadId, type ModelSlug } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Thread } from "../types";

const mocks = vi.hoisted(() => ({
  clearComposerSlashDraft: vi.fn(),
  dispatchCommand: vi.fn(),
  listCommands: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    provider: {
      listCommands: mocks.listCommands,
    },
    orchestration: {
      dispatchCommand: mocks.dispatchCommand,
    },
  }),
}));

vi.mock("../components/ui/toast", () => ({
  toastManager: {
    add: mocks.toast,
  },
}));

vi.mock("../feedbackDialogStore", () => ({
  useFeedbackDialogStore: (selector: (state: { openDialog: () => void }) => unknown) =>
    selector({ openDialog: vi.fn() }),
}));

vi.mock("../rightDockStore", () => ({
  useRightDockStore: {
    getState: () => ({ openPane: vi.fn() }),
  },
}));

import { useComposerSlashCommands } from "./useComposerSlashCommands";

function renderSlashCommandsHook(
  overrides: Partial<Parameters<typeof useComposerSlashCommands>[0]> = {},
) {
  let result: ReturnType<typeof useComposerSlashCommands> | undefined;

  function Probe() {
    result = useComposerSlashCommands({
      activeProject: undefined,
      activeThread: undefined,
      activeRootBranch: null,
      isServerThread: false,
      supportsFastSlashCommand: false,
      canOfferCompactCommand: false,
      canOfferSideCommand: false,
      canOfferExportCommand: false,
      supportsTextNativeReviewCommand: false,
      fastModeEnabled: false,
      providerNativeCommands: [],
      providerCommandDiscoveryCwd: "/repo",
      targetExecutable: false,
      selectedProvider: "claudeAgent",
      currentProviderModelOptions: undefined,
      selectedModelSelection: {
        provider: "claudeAgent",
        profileId: ProviderProfileId.makeUnsafe("work"),
        model: "claude-opus-4-1" as ModelSlug,
      },
      environmentMode: "local",
      runtimeMode: "approval-required",
      interactionMode: "default",
      threadId: ThreadId.makeUnsafe("thread-slash-profile"),
      syncServerShellSnapshot: vi.fn(),
      navigateToThread: vi.fn(),
      handleClearConversation: vi.fn(),
      handleInteractionModeChange: vi.fn(),
      openForkTargetPicker: vi.fn(),
      openReviewTargetPicker: vi.fn(),
      setComposerDraftProviderModelOptions: vi.fn(),
      editorActions: {
        resolveActiveComposerTrigger: () => ({
          snapshot: { value: "/fast", cursor: 5, expandedCursor: 5 },
          trigger: null,
        }),
        applyPromptReplacement: vi.fn(),
        clearComposerSlashDraft: mocks.clearComposerSlashDraft,
        setComposerPromptValue: vi.fn(),
        scheduleComposerFocus: vi.fn(),
        setComposerHighlightedItemId: vi.fn(),
      },
      ...overrides,
    });
    return null;
  }

  renderToStaticMarkup(<Probe />);
  if (!result) {
    throw new Error("Slash-command hook did not render.");
  }
  return result;
}

beforeEach(() => {
  mocks.clearComposerSlashDraft.mockReset();
  mocks.dispatchCommand.mockReset();
  mocks.listCommands.mockReset();
  mocks.toast.mockReset();
});

describe("useComposerSlashCommands provider profile guard", () => {
  it("rejects Claude /fast discovery for an unsupported profile before force reload", async () => {
    const hook = renderSlashCommandsHook();

    await expect(hook.handleStandaloneSlashCommand("/fast")).resolves.toBe(true);

    expect(mocks.clearComposerSlashDraft).toHaveBeenCalledTimes(1);
    expect(mocks.listCommands).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith({
      type: "warning",
      title: "Fast mode is unavailable",
      description:
        "Provider profile 'work' is not configured for provider 'claudeAgent'.",
    });
  });

  it("rejects a native review before creating a thread for an unsupported profile", async () => {
    const hook = renderSlashCommandsHook({
      activeProject: { id: "project-review" } as unknown as Project,
      activeThread: { title: "Review source" } as unknown as Thread,
      isServerThread: true,
      selectedProvider: "codex",
      selectedModelSelection: {
        provider: "codex",
        profileId: ProviderProfileId.makeUnsafe("work"),
        model: "gpt-5" as ModelSlug,
      },
    });

    await expect(hook.handleReviewTargetSelection("changes")).resolves.toBeUndefined();

    expect(mocks.dispatchCommand).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith({
      type: "warning",
      title: "Review is unavailable",
      description: "Provider profile 'work' is not configured for provider 'codex'.",
    });
  });
});

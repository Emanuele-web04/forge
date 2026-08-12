// FILE: useChatAutomationSetup.test.ts
// Purpose: Characterizes automation draft restoration and draft warning rebuilds.
// Layer: Chat automation setup hook tests

import { ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const automationMocks = vi.hoisted(() => ({
  buildAutomationDraftWarnings: vi.fn(),
  scheduleFromForm: vi.fn(),
}));

const storeState = vi.hoisted(() => ({
  projects: [{ id: "project-fallback" }],
  threads: [{ id: "thread-a" }],
}));

vi.mock("react", async () => (await import("../../test/reactHookHarness")).reactHookHarnessMock);

vi.mock("../../routes/-automations.shared", () => ({
  scheduleFromForm: automationMocks.scheduleFromForm,
  useAutomations: () => ({
    data: { definitions: [], runs: [] },
    updateMutation: { mutate: vi.fn() },
  }),
}));

vi.mock("../../lib/automationDraft", () => ({
  buildAutomationDraftWarnings: automationMocks.buildAutomationDraftWarnings,
  updateAutomationDraftWarningAcknowledgement: (
    current: ReadonlySet<string>,
    id: string,
    checked: boolean,
  ) => {
    const next = new Set(current);
    if (checked) next.add(id);
    else next.delete(id);
    return next;
  },
}));

vi.mock("../../storeSelectors", () => ({
  createAllThreadsSelector: () => (state: typeof storeState) => state.threads,
}));

vi.mock("../../store", () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

import { reactHookHarness as reactHarness } from "../../test/reactHookHarness";
import { useChatAutomationSetup } from "./useChatAutomationSetup";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");
const DRAFT_FORM = {
  prompt: "draft prompt",
  mode: "standalone",
  runtimeMode: "standard",
  worktreeMode: "isolated",
} as never;
const DRAFT_WARNING = {
  id: "full-access",
  title: "Full access",
  detail: "Review access",
  requiresAcknowledgement: true,
} as const;

describe("useChatAutomationSetup", () => {
  const promptRef = { current: "" };
  const setComposerDraftPrompt = vi.fn();
  let threadId = THREAD_A;

  const render = () => {
    reactHarness.beginRender();
    return useChatAutomationSetup({
      threadId,
      hasLiveTurn: false,
      promptRef,
      setComposerDraftPrompt,
    });
  };

  beforeEach(() => {
    reactHarness.reset();
    threadId = THREAD_A;
    promptRef.current = "";
    setComposerDraftPrompt.mockReset();
    automationMocks.buildAutomationDraftWarnings.mockReset().mockReturnValue([]);
    automationMocks.scheduleFromForm.mockReset().mockReturnValue({ type: "manual" });
  });

  it("restores accumulated setup text plus the typed prompt when the thread changes", () => {
    let result = render();
    result.setPendingAutomationConversation({
      threadId: THREAD_A,
      accumulatedMessage: "Create a daily summary",
      bubbles: [],
    });
    promptRef.current = "include pull requests";
    result = render();

    threadId = THREAD_B;
    result = render();

    expect(setComposerDraftPrompt).toHaveBeenCalledTimes(1);
    expect(setComposerDraftPrompt).toHaveBeenCalledWith(
      THREAD_A,
      "Create a daily summary\ninclude pull requests",
    );
    expect(result.pendingAutomationConversationRef.current).toBeNull();
  });

  it("restores accumulated setup text plus the typed prompt on unmount", () => {
    let result = render();
    result.setPendingAutomationConversation({
      threadId: THREAD_A,
      accumulatedMessage: "Run the release checks",
      bubbles: [],
    });
    promptRef.current = "every Friday";
    result = render();

    reactHarness.unmount();

    expect(setComposerDraftPrompt).toHaveBeenCalledTimes(1);
    expect(setComposerDraftPrompt).toHaveBeenCalledWith(
      THREAD_A,
      "Run the release checks\nevery Friday",
    );
  });

  it("rebuilds draft warnings from the schedule whenever the draft form changes", () => {
    let result = render();

    automationMocks.buildAutomationDraftWarnings.mockClear().mockReturnValue([DRAFT_WARNING]);
    result.updateAutomationDraftForm(DRAFT_FORM);
    result = render();

    expect(automationMocks.scheduleFromForm).toHaveBeenCalledWith(DRAFT_FORM);
    expect(automationMocks.buildAutomationDraftWarnings).toHaveBeenCalledTimes(1);
    expect(automationMocks.buildAutomationDraftWarnings).toHaveBeenCalledWith(
      expect.objectContaining({
        schedule: { type: "manual" },
        mode: "standalone",
        prompt: "draft prompt",
      }),
    );
    expect(result.automationDraftForm).toBe(DRAFT_FORM);
    expect(result.automationDraftWarnings).toEqual([DRAFT_WARNING]);
  });
});

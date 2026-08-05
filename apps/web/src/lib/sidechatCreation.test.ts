import type { NativeApi, OrchestrationShellSnapshot } from "@synara/contracts";
import { ProjectId, ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Project, Thread } from "../types";
import {
  clearSidechatPaneRetention,
  createOrJoinSidechat,
  createSidechatThread,
  getSidechatPaneRetentionVersion,
  sidechatPaneRetentionRemainingMs,
  subscribeSidechatPaneRetention,
  type SidechatCreationFlight,
  type SidechatCreationResult,
} from "./sidechatCreation";

vi.mock("./utils", () => ({
  newCommandId: () => "command-1",
  newMessageId: () => "message-1",
  newThreadId: () => "sidechat-thread",
}));

const sourceThread = {
  id: ThreadId.makeUnsafe("source-thread"),
  projectId: ProjectId.makeUnsafe("project-1"),
  title: "Source thread",
  envMode: "local",
  branch: "main",
  worktreePath: null,
  workingDirectory: "/repo",
  associatedWorktreePath: null,
  associatedWorktreeBranch: null,
  associatedWorktreeRef: null,
  messages: [],
} as unknown as Thread;

const project = {
  id: ProjectId.makeUnsafe("project-1"),
  name: "Project",
  cwd: "/repo",
} as Project;

const selectedModelSelection = { provider: "codex", model: "gpt-5.6" } as const;

function makeApi(input?: {
  dispatchCommand?: ReturnType<typeof vi.fn>;
  getShellSnapshot?: ReturnType<typeof vi.fn>;
}): NativeApi {
  return {
    orchestration: {
      dispatchCommand: input?.dispatchCommand ?? vi.fn().mockResolvedValue(undefined),
      getShellSnapshot:
        input?.getShellSnapshot ?? vi.fn().mockResolvedValue({} as OrchestrationShellSnapshot),
    },
  } as unknown as NativeApi;
}

describe("createSidechatThread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSidechatPaneRetention(ThreadId.makeUnsafe("sidechat-thread"));
  });

  it("opens the fork before waiting for the shell snapshot", async () => {
    const openSidechat = vi.fn();
    const getShellSnapshot = vi.fn().mockImplementation(async () => {
      expect(openSidechat).toHaveBeenCalledWith(ThreadId.makeUnsafe("sidechat-thread"));
      return {} as OrchestrationShellSnapshot;
    });
    const syncServerShellSnapshot = vi.fn();

    const result = await createSidechatThread({
      api: makeApi({ getShellSnapshot }),
      project,
      sourceThread,
      selectedModelSelection,
      openSidechat,
      syncServerShellSnapshot,
    });

    expect(result).toEqual({
      threadId: ThreadId.makeUnsafe("sidechat-thread"),
      promptError: null,
      snapshotError: null,
    });
    expect(syncServerShellSnapshot).toHaveBeenCalledOnce();
  });

  it("starts snapshot synchronization before dispatching the optional prompt", async () => {
    const dispatchCommand = vi.fn().mockResolvedValue(undefined);
    const getShellSnapshot = vi.fn().mockImplementation(async () => {
      expect(dispatchCommand).toHaveBeenCalledTimes(1);
      return {} as OrchestrationShellSnapshot;
    });

    await createSidechatThread({
      api: makeApi({ dispatchCommand, getShellSnapshot }),
      project,
      sourceThread,
      selectedModelSelection,
      initialPrompt: "Investigate this",
      openSidechat: vi.fn(),
      syncServerShellSnapshot: vi.fn(),
    });

    expect(dispatchCommand).toHaveBeenCalledTimes(2);
  });

  it("retains the pane without a deadline while snapshot synchronization is in flight", async () => {
    let resolveSnapshot: ((snapshot: OrchestrationShellSnapshot) => void) | undefined;
    const getShellSnapshot = vi.fn().mockImplementation(
      () =>
        new Promise<OrchestrationShellSnapshot>((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    const creation = createSidechatThread({
      api: makeApi({ getShellSnapshot }),
      project,
      sourceThread,
      selectedModelSelection,
      openSidechat: vi.fn(),
      syncServerShellSnapshot: vi.fn(),
    });

    await vi.waitFor(() => expect(getShellSnapshot).toHaveBeenCalledOnce());
    expect(sidechatPaneRetentionRemainingMs(ThreadId.makeUnsafe("sidechat-thread"))).toBeNull();

    resolveSnapshot?.({} as OrchestrationShellSnapshot);
    await creation;
  });

  it("notifies the pane cleanup subscriber when snapshot synchronization finishes", async () => {
    let resolveSnapshot: ((snapshot: OrchestrationShellSnapshot) => void) | undefined;
    const getShellSnapshot = vi.fn().mockImplementation(
      () =>
        new Promise<OrchestrationShellSnapshot>((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    const onRetentionChange = vi.fn();
    const initialVersion = getSidechatPaneRetentionVersion();
    const unsubscribe = subscribeSidechatPaneRetention(onRetentionChange);
    const creation = createSidechatThread({
      api: makeApi({ getShellSnapshot }),
      project,
      sourceThread,
      selectedModelSelection,
      openSidechat: vi.fn(),
      syncServerShellSnapshot: vi.fn(),
    });

    await vi.waitFor(() => expect(getShellSnapshot).toHaveBeenCalledOnce());
    expect(onRetentionChange).toHaveBeenCalledTimes(1);
    expect(getSidechatPaneRetentionVersion()).toBe(initialVersion + 1);

    resolveSnapshot?.({} as OrchestrationShellSnapshot);
    await creation;
    expect(onRetentionChange).toHaveBeenCalledTimes(2);
    expect(getSidechatPaneRetentionVersion()).toBe(initialVersion + 2);
    unsubscribe();
  });

  it("keeps the created sidechat open when its initial prompt fails", async () => {
    const promptError = new Error("turn failed");
    const dispatchCommand = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(promptError);
    const openSidechat = vi.fn();

    const result = await createSidechatThread({
      api: makeApi({ dispatchCommand }),
      project,
      sourceThread,
      selectedModelSelection,
      initialPrompt: "Investigate this",
      openSidechat,
      syncServerShellSnapshot: vi.fn(),
    });

    expect(result.promptError).toBe(promptError);
    expect(openSidechat).toHaveBeenCalledOnce();
  });

  it("retains a grace period when snapshot synchronization fails", async () => {
    const snapshotError = new Error("snapshot failed");
    const result = await createSidechatThread({
      api: makeApi({ getShellSnapshot: vi.fn().mockRejectedValue(snapshotError) }),
      project,
      sourceThread,
      selectedModelSelection,
      openSidechat: vi.fn(),
      syncServerShellSnapshot: vi.fn(),
    });

    expect(result.snapshotError).toBe(snapshotError);
    expect(sidechatPaneRetentionRemainingMs(result.threadId)).toBeGreaterThan(0);
  });

  it("does not open a pane when the fork itself fails", async () => {
    const openSidechat = vi.fn();

    await expect(
      createSidechatThread({
        api: makeApi({ dispatchCommand: vi.fn().mockRejectedValue(new Error("fork failed")) }),
        project,
        sourceThread,
        selectedModelSelection,
        openSidechat,
        syncServerShellSnapshot: vi.fn(),
      }),
    ).rejects.toThrow("fork failed");
    expect(openSidechat).not.toHaveBeenCalled();
  });
});

describe("sidechat pane retention", () => {
  it("gives a restored missing pane one grace window before pruning", () => {
    const threadId = ThreadId.makeUnsafe("restored-sidechat");
    clearSidechatPaneRetention(threadId);

    expect(sidechatPaneRetentionRemainingMs(threadId, 1_000)).toBe(15_000);
    expect(sidechatPaneRetentionRemainingMs(threadId, 15_999)).toBe(1);
    expect(sidechatPaneRetentionRemainingMs(threadId, 16_000)).toBe(0);
  });
});

describe("createOrJoinSidechat", () => {
  const result = {
    threadId: ThreadId.makeUnsafe("created-sidechat"),
    promptError: null,
    snapshotError: null,
  } satisfies SidechatCreationResult;

  function run(input: {
    flights: Map<ThreadId, SidechatCreationFlight>;
    sourceThreadId: ThreadId;
    initialPrompt?: string | undefined;
    startCreation: (initialPrompt?: string | undefined) => Promise<SidechatCreationResult>;
    sendQueuedPrompt: (threadId: ThreadId, prompt: string) => Promise<void>;
  }): Promise<true> {
    return createOrJoinSidechat({
      inFlightBySourceThreadId: input.flights,
      sourceThreadId: input.sourceThreadId,
      initialPrompt: input.initialPrompt,
      startCreation: input.startCreation,
      sendQueuedPrompt: input.sendQueuedPrompt,
      onCreationResult: vi.fn(),
      onQueuedPromptError: vi.fn(),
    });
  }

  it("queues a later prompt onto the in-flight sidechat instead of dropping it", async () => {
    let resolveCreation: ((value: SidechatCreationResult) => void) | undefined;
    const startCreation = vi.fn(
      () =>
        new Promise<SidechatCreationResult>((resolve) => {
          resolveCreation = resolve;
        }),
    );
    const sendQueuedPrompt = vi.fn().mockResolvedValue(undefined);
    const flights = new Map<ThreadId, SidechatCreationFlight>();
    const sourceThreadId = ThreadId.makeUnsafe("source-a");

    const first = run({ flights, sourceThreadId, startCreation, sendQueuedPrompt });
    const second = run({
      flights,
      sourceThreadId,
      initialPrompt: "Do not lose this",
      startCreation,
      sendQueuedPrompt,
    });

    expect(startCreation).toHaveBeenCalledOnce();
    resolveCreation?.(result);
    await Promise.all([first, second]);
    expect(sendQueuedPrompt).toHaveBeenCalledWith(result.threadId, "Do not lose this");
  });

  it("does not queue the initial prompt twice when the same action is repeated", async () => {
    let resolveCreation: ((value: SidechatCreationResult) => void) | undefined;
    const startCreation = vi.fn(
      () =>
        new Promise<SidechatCreationResult>((resolve) => {
          resolveCreation = resolve;
        }),
    );
    const sendQueuedPrompt = vi.fn().mockResolvedValue(undefined);
    const flights = new Map<ThreadId, SidechatCreationFlight>();
    const sourceThreadId = ThreadId.makeUnsafe("source-a");

    const first = run({
      flights,
      sourceThreadId,
      initialPrompt: "Only once",
      startCreation,
      sendQueuedPrompt,
    });
    const duplicate = run({
      flights,
      sourceThreadId,
      initialPrompt: "Only once",
      startCreation,
      sendQueuedPrompt,
    });

    expect(startCreation).toHaveBeenCalledWith("Only once");
    resolveCreation?.(result);
    await Promise.all([first, duplicate]);
    expect(startCreation).toHaveBeenCalledOnce();
    expect(sendQueuedPrompt).not.toHaveBeenCalled();
  });

  it("allows different host threads to create sidechats concurrently", async () => {
    const flights = new Map<ThreadId, SidechatCreationFlight>();
    const startFirst = vi.fn().mockResolvedValue(result);
    const startSecond = vi.fn().mockResolvedValue({
      ...result,
      threadId: ThreadId.makeUnsafe("other-sidechat"),
    });

    await Promise.all([
      run({
        flights,
        sourceThreadId: ThreadId.makeUnsafe("source-a"),
        startCreation: startFirst,
        sendQueuedPrompt: vi
          .fn<(threadId: ThreadId, prompt: string) => Promise<void>>()
          .mockResolvedValue(undefined),
      }),
      run({
        flights,
        sourceThreadId: ThreadId.makeUnsafe("source-b"),
        startCreation: startSecond,
        sendQueuedPrompt: vi
          .fn<(threadId: ThreadId, prompt: string) => Promise<void>>()
          .mockResolvedValue(undefined),
      }),
    ]);

    expect(startFirst).toHaveBeenCalledOnce();
    expect(startSecond).toHaveBeenCalledOnce();
  });
});

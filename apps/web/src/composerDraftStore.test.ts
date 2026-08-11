import { ProjectId, ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectComposerThreadDraft } from "./composerDraftDomain";
import {
  finalizePromotedDraftThreads,
  markPromotedDraftThreads,
  useComposerDraftStore,
} from "./composerDraftStore";
import {
  makeImage,
  makeQueuedChatTurn,
  resetComposerDraftStore,
} from "./composerDraftStoreTestFixtures";

describe("composerDraftStore stable empty draft identity", () => {
  it("reuses the empty draft sentinel across unrelated store updates", () => {
    resetComposerDraftStore();
    const missingThreadId = ThreadId.makeUnsafe("thread-missing");
    const otherThreadId = ThreadId.makeUnsafe("thread-other");
    const before = selectComposerThreadDraft(useComposerDraftStore.getState(), missingThreadId);

    useComposerDraftStore.getState().setPrompt(otherThreadId, "unrelated");

    const after = selectComposerThreadDraft(useComposerDraftStore.getState(), missingThreadId);
    expect(after).toBe(before);
  });
});

describe("composerDraftStore clearComposerContent", () => {
  const threadId = ThreadId.makeUnsafe("thread-clear");
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    resetComposerDraftStore();
    originalRevokeObjectUrl = URL.revokeObjectURL;
    revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
  });

  afterEach(() => {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("revokes blob preview URLs when clearing composer content", () => {
    const first = makeImage({
      id: "img-clear",
      previewUrl: "blob:clear",
    });
    useComposerDraftStore.getState().addImage(threadId, first);

    useComposerDraftStore.getState().clearComposerContent(threadId);

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft).toBeUndefined();
    expect(revokeSpy).toHaveBeenCalledWith("blob:clear");
  });

  it("can preserve blob preview URLs for optimistic message handoff", () => {
    const first = makeImage({
      id: "img-optimistic",
      previewUrl: "blob:optimistic",
    });
    useComposerDraftStore.getState().addImage(threadId, first);

    useComposerDraftStore.getState().clearComposerContent(threadId, { preservePreviewUrls: true });

    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId];
    expect(draft).toBeUndefined();
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:optimistic");
  });

  it("clears selected provider references with composer content", () => {
    const store = useComposerDraftStore.getState();

    store.setPrompt(threadId, "Use @linear and /check-code");
    store.setSkills(threadId, [{ name: "check-code", path: "/skills/check-code" }]);
    store.setMentions(threadId, [{ name: "linear", path: "plugin://linear" }]);
    store.clearComposerContent(threadId);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });
});

describe("composerDraftStore project draft thread mapping", () => {
  const projectId = ProjectId.makeUnsafe("project-a");
  const otherProjectId = ProjectId.makeUnsafe("project-b");
  const threadId = ThreadId.makeUnsafe("thread-a");
  const otherThreadId = ThreadId.makeUnsafe("thread-b");
  let originalRevokeObjectUrl: typeof URL.revokeObjectURL;
  let revokeSpy: ReturnType<typeof vi.fn<(url: string) => void>>;

  beforeEach(() => {
    resetComposerDraftStore();
    originalRevokeObjectUrl = URL.revokeObjectURL;
    revokeSpy = vi.fn();
    URL.revokeObjectURL = revokeSpy;
  });

  afterEach(() => {
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("stores and reads project draft thread ids via actions", () => {
    const store = useComposerDraftStore.getState();
    expect(store.getDraftThreadByProjectId(projectId)).toBeNull();
    expect(store.getDraftThread(threadId)).toBeNull();

    store.setProjectDraftThreadId(projectId, threadId, {
      branch: "feature/test",
      worktreePath: "/tmp/worktree-test",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toEqual({
      threadId,
      projectId,
      entryPoint: "chat",
      branch: "feature/test",
      worktreePath: "/tmp/worktree-test",
      workingDirectory: null,
      envMode: "worktree",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastKnownPr: null,
    });
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toEqual({
      projectId,
      entryPoint: "chat",
      branch: "feature/test",
      worktreePath: "/tmp/worktree-test",
      workingDirectory: null,
      envMode: "worktree",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastKnownPr: null,
    });
  });

  it("preserves untouched thread draft identity across unrelated thread updates", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadId, "thread a");
    store.setPrompt(otherThreadId, "thread b");
    const threadADraft = useComposerDraftStore.getState().draftsByThreadId[threadId];

    useComposerDraftStore.getState().setPrompt(otherThreadId, "thread b updated");

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBe(threadADraft);
  });

  it("tracks temporary draft metadata and lets context updates clear it", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, { isTemporary: true });
    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.isTemporary).toBe(true);

    store.setProjectDraftThreadId(projectId, threadId, {
      branch: "feature/preserve-temp",
    });
    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.isTemporary).toBe(true);

    store.setDraftThreadContext(threadId, { isTemporary: false });
    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.isTemporary).toBeUndefined();
  });

  it("registers a mapping-less temporary terminal draft for staged navigation", () => {
    const store = useComposerDraftStore.getState();

    store.registerDraftThread(threadId, {
      projectId,
      entryPoint: "terminal",
      isTemporary: true,
      envMode: "local",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toMatchObject({
      projectId,
      entryPoint: "terminal",
      isTemporary: true,
      envMode: "local",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId, "terminal")).toBe(
      null,
    );
  });

  it("tracks chat and terminal draft threads independently for the same project", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, { entryPoint: "chat" });
    store.setProjectDraftThreadId(projectId, otherThreadId, { entryPoint: "terminal" });

    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectId(projectId, "chat"),
    ).toMatchObject({
      threadId,
      projectId,
      entryPoint: "chat",
    });
    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectId(projectId, "terminal"),
    ).toMatchObject({
      threadId: otherThreadId,
      projectId,
      entryPoint: "terminal",
    });
    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.entryPoint).toBe("chat");
    expect(useComposerDraftStore.getState().getDraftThread(otherThreadId)?.entryPoint).toBe(
      "terminal",
    );
  });

  it("clears only matching project draft mapping entries", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "hello");

    store.clearProjectDraftThreadById(projectId, otherThreadId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)?.threadId).toBe(
      threadId,
    );

    store.clearProjectDraftThreadById(projectId, threadId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("releases queued preview blobs when clearing a draft by project and thread id", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.enqueueQueuedTurn(
      threadId,
      makeQueuedChatTurn(
        "queued-project-delete",
        makeImage({ id: "queued-image-delete", previewUrl: "blob:queued-project-delete" }),
      ),
    );

    store.clearProjectDraftThreadById(projectId, threadId);

    expect(revokeSpy).toHaveBeenCalledWith("blob:queued-project-delete");
  });

  it("clears project draft mapping by project id", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "hello");
    store.clearProjectDraftThreadId(projectId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("releases queued preview blobs when clearing a project draft by project id", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.enqueueQueuedTurn(
      threadId,
      makeQueuedChatTurn(
        "queued-project-clear",
        makeImage({ id: "queued-image-clear", previewUrl: "blob:queued-project-clear" }),
      ),
    );

    store.clearProjectDraftThreadId(projectId);

    expect(revokeSpy).toHaveBeenCalledWith("blob:queued-project-clear");
  });

  it("clears orphaned composer drafts when remapping a project to a new draft thread", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "orphan me");

    store.setProjectDraftThreadId(projectId, otherThreadId);

    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)?.threadId).toBe(
      otherThreadId,
    );
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("releases queued preview blobs when remapping a project to a new draft thread", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.enqueueQueuedTurn(
      threadId,
      makeQueuedChatTurn(
        "queued-remap",
        makeImage({ id: "queued-image-remap", previewUrl: "blob:queued-remap" }),
      ),
    );

    store.setProjectDraftThreadId(projectId, otherThreadId);

    expect(revokeSpy).toHaveBeenCalledWith("blob:queued-remap");
  });

  it("keeps composer drafts when the thread is still mapped by another project", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setProjectDraftThreadId(otherProjectId, threadId);
    store.setPrompt(threadId, "keep me");
    store.enqueueQueuedTurn(
      threadId,
      makeQueuedChatTurn(
        "queued-kept-thread",
        makeImage({ id: "queued-image-kept", previewUrl: "blob:queued-kept-thread" }),
      ),
    );

    store.clearProjectDraftThreadId(projectId);

    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectId(otherProjectId)?.threadId,
    ).toBe(threadId);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe("keep me");
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.queuedTurns).toHaveLength(
      1,
    );
    expect(revokeSpy).not.toHaveBeenCalledWith("blob:queued-kept-thread");
  });

  it("clears draft registration independently", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "remove me");
    store.clearDraftThread(threadId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("marks promoted drafts without deleting composer state until finalization", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setPrompt(threadId, "keep me while server thread hydrates");

    markPromotedDraftThreads(new Set([threadId]));

    expect(useComposerDraftStore.getState().getDraftThread(threadId)?.promotedTo).toBe(threadId);
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
      "keep me while server thread hydrates",
    );

    useComposerDraftStore.getState().finalizePromotedDraftThread(threadId);

    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });

  it("finalizes every promoted draft exposed by the facade batch helper", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId);
    store.setProjectDraftThreadId(otherProjectId, otherThreadId);
    store.setPrompt(threadId, "first promoted draft");
    store.setPrompt(otherThreadId, "second promoted draft");
    markPromotedDraftThreads(new Set([threadId, otherThreadId]));

    finalizePromotedDraftThreads(new Set([threadId, otherThreadId]));

    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftThread(otherThreadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
    expect(useComposerDraftStore.getState().draftsByThreadId[otherThreadId]).toBeUndefined();
  });

  it("updates branch context on an existing draft thread", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, {
      branch: "main",
      worktreePath: null,
    });
    store.setDraftThreadContext(threadId, {
      branch: "feature/next",
      worktreePath: "/tmp/feature-next",
    });
    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)?.threadId).toBe(
      threadId,
    );
    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toMatchObject({
      projectId,
      branch: "feature/next",
      worktreePath: "/tmp/feature-next",
      envMode: "worktree",
    });
  });

  it("moves an empty draft to another project while preserving composer content", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, {
      branch: "feature/old",
      worktreePath: "/tmp/old-worktree",
      envMode: "worktree",
    });
    store.setPrompt(threadId, "keep this draft");

    store.moveDraftThreadToProject(threadId, otherProjectId, {
      branch: null,
      worktreePath: null,
      envMode: "local",
      lastKnownPr: null,
    });

    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectId(otherProjectId),
    ).toMatchObject({
      threadId,
      projectId: otherProjectId,
      branch: null,
      worktreePath: null,
      envMode: "local",
    });
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
      "keep this draft",
    );
  });

  it("clears the replaced target draft when moving a draft to another project", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, {
      branch: "feature/old",
      worktreePath: "/tmp/old-worktree",
      envMode: "worktree",
    });
    store.setPrompt(threadId, "move this draft");
    store.setProjectDraftThreadId(otherProjectId, otherThreadId);
    store.setPrompt(otherThreadId, "replace this draft");
    store.enqueueQueuedTurn(
      otherThreadId,
      makeQueuedChatTurn(
        "queued-target-replaced",
        makeImage({ id: "queued-target-replaced", previewUrl: "blob:queued-target-replaced" }),
      ),
    );

    store.moveDraftThreadToProject(threadId, otherProjectId, {
      branch: null,
      worktreePath: null,
      envMode: "local",
      lastKnownPr: null,
    });

    expect(useComposerDraftStore.getState().getDraftThreadByProjectId(projectId)).toBeNull();
    expect(
      useComposerDraftStore.getState().getDraftThreadByProjectId(otherProjectId),
    ).toMatchObject({
      threadId,
      projectId: otherProjectId,
      branch: null,
      worktreePath: null,
      envMode: "local",
    });
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
      "move this draft",
    );
    expect(useComposerDraftStore.getState().getDraftThread(otherThreadId)).toBeNull();
    expect(useComposerDraftStore.getState().draftsByThreadId[otherThreadId]).toBeUndefined();
    expect(revokeSpy).toHaveBeenCalledWith("blob:queued-target-replaced");
  });

  it("preserves existing branch and worktree when setProjectDraftThreadId receives undefined", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, {
      branch: "main",
      worktreePath: "/tmp/main-worktree",
    });
    const runtimeUndefinedOptions = {
      branch: undefined,
      worktreePath: undefined,
    } as unknown as {
      branch?: string | null;
      worktreePath?: string | null;
    };
    store.setProjectDraftThreadId(projectId, threadId, runtimeUndefinedOptions);

    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toMatchObject({
      projectId,
      branch: "main",
      worktreePath: "/tmp/main-worktree",
      envMode: "worktree",
    });
  });

  it("preserves worktree env mode without a worktree path", () => {
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectId, threadId, {
      branch: "feature/base",
      worktreePath: null,
      envMode: "worktree",
    });
    const runtimeUndefinedOptions = {
      branch: undefined,
      worktreePath: undefined,
      envMode: undefined,
    } as unknown as {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: "local" | "worktree";
    };
    store.setProjectDraftThreadId(projectId, threadId, runtimeUndefinedOptions);

    expect(useComposerDraftStore.getState().getDraftThread(threadId)).toMatchObject({
      projectId,
      branch: "feature/base",
      worktreePath: null,
      envMode: "worktree",
    });
  });
});

describe("composerDraftStore runtime and interaction settings", () => {
  const threadId = ThreadId.makeUnsafe("thread-settings");

  beforeEach(() => {
    resetComposerDraftStore();
  });

  it("stores runtime mode overrides in the composer draft", () => {
    const store = useComposerDraftStore.getState();

    store.setRuntimeMode(threadId, "approval-required");

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.runtimeMode).toBe(
      "approval-required",
    );
  });

  it("stores AI-reviewed auto mode in the composer draft", () => {
    const store = useComposerDraftStore.getState();

    store.setRuntimeMode(threadId, "auto");

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.runtimeMode).toBe("auto");
  });

  it("stores interaction mode overrides in the composer draft", () => {
    const store = useComposerDraftStore.getState();

    store.setInteractionMode(threadId, "debug");

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.interactionMode).toBe(
      "debug",
    );
  });

  it("removes empty settings-only drafts when overrides are cleared", () => {
    const store = useComposerDraftStore.getState();

    store.setRuntimeMode(threadId, "approval-required");
    store.setInteractionMode(threadId, "plan");
    store.setRuntimeMode(threadId, null);
    store.setInteractionMode(threadId, null);

    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]).toBeUndefined();
  });
});

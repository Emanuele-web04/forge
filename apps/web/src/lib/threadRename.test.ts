import { describe, expect, it, vi } from "vitest";

const dispatchCommand = vi.fn<(command: unknown) => Promise<void>>();
const regenerateThreadTitle = vi.fn<() => Promise<unknown>>();

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: {
      dispatchCommand,
      regenerateThreadTitle,
    },
  }),
}));

import {
  buildDraftThreadRenameCreateInput,
  dispatchThreadRename,
  dispatchThreadTitleRegeneration,
} from "./threadRename";

describe("dispatchThreadRename", () => {
  it("maps local draft metadata into the rename promotion input", () => {
    expect(
      buildDraftThreadRenameCreateInput({
        projectId: "project-chat" as never,
        modelSelection: { provider: "codex", model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: "2026-04-18T00:00:00.000Z",
      }),
    ).toEqual({
      projectId: "project-chat",
      modelSelection: { provider: "codex", model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      envMode: "local",
      branch: null,
      worktreePath: null,
      workingDirectory: null,
      createdAt: "2026-04-18T00:00:00.000Z",
    });
  });

  it("updates existing server threads", async () => {
    dispatchCommand.mockReset().mockResolvedValue(undefined);
    regenerateThreadTitle.mockReset();

    const outcome = await dispatchThreadRename({
      threadId: "thread-server" as never,
      newTitle: "Renamed server thread",
      unchangedTitles: ["New thread"],
    });

    expect(outcome).toBe("renamed");
    expect(dispatchCommand).toHaveBeenCalledTimes(1);
    expect(dispatchCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "thread.meta.update",
      threadId: "thread-server",
      title: "Renamed server thread",
    });
    expect(regenerateThreadTitle).not.toHaveBeenCalled();
  });

  it("promotes local drafts by creating the thread with the chosen title", async () => {
    dispatchCommand.mockReset().mockResolvedValue(undefined);

    const outcome = await dispatchThreadRename({
      threadId: "thread-draft" as never,
      newTitle: "Inbox cleanup",
      unchangedTitles: ["New thread"],
      createIfMissing: {
        projectId: "project-chat" as never,
        modelSelection: {
          provider: "codex",
          model: "gpt-5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "local",
        branch: null,
        worktreePath: null,
        workingDirectory: null,
        createdAt: "2026-04-18T00:00:00.000Z",
      },
    });

    expect(outcome).toBe("renamed");
    expect(dispatchCommand).toHaveBeenCalledTimes(1);
    expect(dispatchCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "thread.create",
      threadId: "thread-draft",
      projectId: "project-chat",
      title: "Inbox cleanup",
      createdAt: "2026-04-18T00:00:00.000Z",
    });
  });

  it("requests server-side title regeneration for an existing thread", async () => {
    regenerateThreadTitle.mockReset().mockResolvedValue({
      status: "renamed",
      title: "Backend auth",
    });

    const outcome = await dispatchThreadTitleRegeneration("thread-server" as never);

    expect(outcome).toEqual({ status: "renamed", title: "Backend auth" });
    expect(regenerateThreadTitle).toHaveBeenCalledWith({ threadId: "thread-server" });
  });
});

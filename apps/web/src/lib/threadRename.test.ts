import { DEFAULT_PROVIDER_PROFILE_ID } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

const dispatchCommand = vi.fn<(command: unknown) => Promise<void>>();

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: {
      dispatchCommand,
    },
  }),
}));

import { dispatchThreadRename } from "./threadRename";

describe("dispatchThreadRename", () => {
  it("updates existing server threads", async () => {
    dispatchCommand.mockReset().mockResolvedValue(undefined);

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
          profileId: DEFAULT_PROVIDER_PROFILE_ID,
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
});

import { describe, expect, it, vi } from "vitest";

const dispatchCommand = vi.fn<(command: unknown) => Promise<void>>();

vi.mock("./nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: {
      dispatchCommand,
    },
  }),
}));

import { dispatchThreadGoal } from "./threadGoal";

describe("dispatchThreadGoal", () => {
  it("sets and clears the persisted goal through thread.meta.update", async () => {
    dispatchCommand.mockReset().mockResolvedValue(undefined);

    await dispatchThreadGoal("thread-server" as never, "Ship the complete feature");
    await dispatchThreadGoal("thread-server" as never, "");

    expect(dispatchCommand).toHaveBeenCalledTimes(2);
    expect(dispatchCommand.mock.calls[0]?.[0]).toMatchObject({
      type: "thread.meta.update",
      threadId: "thread-server",
      goal: "Ship the complete feature",
    });
    expect(dispatchCommand.mock.calls[1]?.[0]).toMatchObject({
      type: "thread.meta.update",
      threadId: "thread-server",
      goal: "",
    });
  });
});

// FILE: importedThreadMessages.test.ts
// Purpose: Verifies provider transcript snapshots become stable Synara import messages.
// Layer: Orchestration mapping tests
// Depends on: importedThreadMessages.

import { ThreadId } from "@synara/contracts";
import { expect, it } from "vitest";

import { mapFactorySnapshotMessages } from "./importedThreadMessages.ts";

it("maps visible Factory session items and ignores unrelated rows", () => {
  const importedAt = "2026-07-08T00:00:00.000Z";
  expect(
    mapFactorySnapshotMessages({
      threadId: ThreadId.makeUnsafe("thread-1"),
      importedAt,
      turns: [
        {
          items: [
            {
              type: "factoryMessage",
              id: "user-1",
              role: "user",
              text: "Question",
              timestamp: "2026-07-07T23:59:00.000Z",
            },
            { type: "tool", text: "hidden" },
          ],
        },
        {
          items: [{ type: "factoryMessage", id: "assistant-1", role: "assistant", text: "Answer" }],
        },
      ],
    }),
  ).toEqual([
    {
      messageId: "import:thread-1:droid:0:0:user-1",
      role: "user",
      text: "Question",
      createdAt: "2026-07-07T23:59:00.000Z",
      updatedAt: "2026-07-07T23:59:00.000Z",
    },
    {
      messageId: "import:thread-1:droid:1:0:assistant-1",
      role: "assistant",
      text: "Answer",
      createdAt: "2026-07-08T00:00:00.001Z",
      updatedAt: "2026-07-08T00:00:00.001Z",
    },
  ]);
});

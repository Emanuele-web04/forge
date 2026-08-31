// FILE: MessagesTimeline.changedFiles.browser.tsx
// Purpose: Browser regressions for the changed-files row cap and expansion.
// Layer: Vitest browser tests

import "../../index.css";

import { MessageId, TurnId } from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import type { TimelineEntry } from "../../session-logic";
import { MessagesTimeline } from "./MessagesTimeline";

const ASSISTANT_MESSAGE_ID = MessageId.makeUnsafe("changed-files-assistant");
const VISIBLE_FILE_PATHS = Array.from(
  { length: 5 },
  (_, index) => `apps/web/src/visible-${index + 1}.tsx`,
);
const OVERFLOW_FILE_PATHS = ["apps/web/src/overflow-1.tsx", "apps/web/src/overflow-2.tsx"];

const TIMELINE_ENTRIES: TimelineEntry[] = [
  {
    id: "changed-files-entry",
    kind: "message",
    createdAt: "2026-03-17T19:12:29.000Z",
    message: {
      id: ASSISTANT_MESSAGE_ID,
      role: "assistant",
      text: "done",
      createdAt: "2026-03-17T19:12:29.000Z",
      completedAt: "2026-03-17T19:12:30.000Z",
      streaming: false,
    },
  },
];

function ChangedFilesTimeline() {
  const files = [...VISIBLE_FILE_PATHS, ...OVERFLOW_FILE_PATHS].map((path) => ({
    path,
    additions: 1,
    deletions: 0,
  }));

  return (
    <MessagesTimeline
      hasMessages
      isWorking={false}
      activeTurnInProgress={false}
      activeTurnStartedAt={null}
      timelineEntries={TIMELINE_ENTRIES}
      turnDiffSummaryByAssistantMessageId={
        new Map([
          [
            ASSISTANT_MESSAGE_ID,
            {
              turnId: TurnId.makeUnsafe("changed-files-turn"),
              completedAt: "2026-03-17T19:12:30.000Z",
              assistantMessageId: ASSISTANT_MESSAGE_ID,
              files,
            },
          ],
        ])
      }
      nowIso="2026-03-17T19:12:30.000Z"
      expandedWorkGroups={{}}
      onToggleWorkGroup={() => {}}
      onOpenTurnDiff={() => {}}
      revertTurnCountByUserMessageId={new Map()}
      onRevertUserMessage={() => {}}
      isRevertingCheckpoint={false}
      onImageExpand={() => {}}
      markdownCwd={undefined}
      resolvedTheme="dark"
      timestampFormat="locale"
      workspaceRoot={undefined}
    />
  );
}

function createTimelineHost(): HTMLDivElement {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;width:700px;height:520px;overflow:hidden;";
  document.body.append(host);
  return host;
}

describe("MessagesTimeline changed files", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not mount overflow rows until the user expands them", async () => {
    const host = createTimelineHost();
    const screen = await render(<ChangedFilesTimeline />, { container: host });

    try {
      await expect
        .poll(() => document.querySelectorAll('[data-edited-file-row="true"]').length)
        .toBe(VISIBLE_FILE_PATHS.length);
      for (const path of OVERFLOW_FILE_PATHS) {
        expect(document.body.textContent ?? "").not.toContain(path);
      }

      const expandButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => (button.textContent ?? "").includes("Show 2 more files"),
      );
      expect(expandButton).toBeDefined();
      expect(expandButton?.getAttribute("aria-expanded")).toBe("false");
      expandButton?.click();

      await expect
        .poll(() => document.querySelectorAll('[data-edited-file-row="true"]').length)
        .toBe(VISIBLE_FILE_PATHS.length + OVERFLOW_FILE_PATHS.length);
      for (const path of OVERFLOW_FILE_PATHS) {
        expect(document.body.textContent ?? "").toContain(path);
      }
      await expect.poll(() => expandButton?.getAttribute("aria-expanded")).toBe("true");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});

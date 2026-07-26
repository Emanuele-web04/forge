// FILE: MessagesTimeline.toolDetails.browser.tsx
// Purpose: Browser regressions for inline tool-call detail expand/collapse motion.
// Layer: Vitest browser tests

import "../../index.css";

import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { MessagesTimeline } from "./MessagesTimeline";
import { TimelineWorkEntryRow } from "./TimelineWorkEntryRow";

function ToolDetailsTimeline() {
  return (
    <MessagesTimeline
      hasMessages
      isWorking={false}
      activeTurnInProgress={false}
      activeTurnStartedAt={null}
      timelineEntries={[
        {
          id: "entry-command-details",
          kind: "work",
          createdAt: "2026-03-17T19:12:28.000Z",
          entry: {
            id: "work-command-details",
            createdAt: "2026-03-17T19:12:28.000Z",
            label: "Ran command",
            tone: "tool",
            itemType: "command_execution",
            toolTitle: "Searched",
            command: `rg -n "toolDetails" apps/web/src`,
            toolDetails: {
              kind: "command",
              title: "Searched",
              command: `rg -n "toolDetails" apps/web/src`,
              output: {
                stdout: "apps/web/src/session-logic.ts:55: toolDetails",
              },
            },
          },
        },
      ]}
      turnDiffSummaryByAssistantMessageId={new Map()}
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

function LiveActivityTimeline() {
  const nowMs = Date.now();
  return (
    <TimelineWorkEntryRow
      workEntry={{
        id: "work-live-activity",
        createdAt: "2026-03-17T19:12:28.000Z",
        label: "Bash",
        tone: "tool",
        itemType: "command_execution",
        toolTitle: "Running command",
        command: "bun install",
        liveActivity: {
          state: "running_tool",
          label: "Running bun install",
          startedAt: new Date(nowMs - 134_000).toISOString(),
          lastActivityAt: new Date(nowMs - 2_000).toISOString(),
          detail: "Resolving packages",
          progress: 0.42,
          elapsedSeconds: 132,
        },
      }}
      chatMetaFontSizePx={12}
      textFontSizePx={13}
      density="compact"
      onImageExpand={() => {}}
      markdownCwd={undefined}
    />
  );
}

function createTimelineHost(): HTMLDivElement {
  const host = document.createElement("div");
  host.style.cssText = "display:flex;width:600px;height:520px;overflow:hidden;";
  document.body.append(host);
  return host;
}

async function settleLayout(): Promise<void> {
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

describe("MessagesTimeline tool details", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("opens and closes command details with the shared disclosure motion", async () => {
    const host = createTimelineHost();
    const screen = await render(<ToolDetailsTimeline />, { container: host });
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const originalCancelAnimationFrame = window.cancelAnimationFrame;
    const pendingFrames: Array<FrameRequestCallback | null> = [];

    try {
      const trigger = document.querySelector<HTMLButtonElement>(
        '[data-tool-detail-trigger="true"]',
      );
      expect(trigger).not.toBeNull();
      expect(trigger?.getAttribute("aria-expanded")).toBe("false");
      expect(document.querySelector("[data-tool-details-inline='true']")).toBeNull();

      window.requestAnimationFrame = (callback: FrameRequestCallback) => {
        pendingFrames.push(callback);
        return pendingFrames.length;
      };
      window.cancelAnimationFrame = (handle: number) => {
        pendingFrames[handle - 1] = null;
      };

      trigger?.click();

      await expect.poll(() => trigger?.getAttribute("aria-expanded")).toBe("true");
      await expect
        .poll(() => document.querySelector("[data-tool-details-inline='true']") !== null)
        .toBe(true);
      const openingHiddenRegion = document
        .querySelector("[data-tool-details-inline='true']")
        ?.closest("[aria-hidden='true']");
      expect(openingHiddenRegion).not.toBeNull();
      expect(openingHiddenRegion?.hasAttribute("inert")).toBe(true);

      const framesToFlush = pendingFrames.splice(0);
      expect(framesToFlush.some((frame) => frame !== null)).toBe(true);
      for (const frame of framesToFlush) {
        frame?.(performance.now());
      }
      window.requestAnimationFrame = originalRequestAnimationFrame;
      window.cancelAnimationFrame = originalCancelAnimationFrame;

      await expect
        .poll(
          () =>
            document
              .querySelector("[data-tool-details-inline='true']")
              ?.closest("[aria-hidden='true']") ?? null,
        )
        .toBeNull();
      expect(document.body.textContent ?? "").toContain(`rg -n "toolDetails" apps/web/src`);

      trigger?.click();

      await expect.poll(() => trigger?.getAttribute("aria-expanded")).toBe("false");
      expect(document.querySelector("[data-tool-details-inline='true']")).not.toBeNull();
      const closingHiddenRegion = document
        .querySelector("[data-tool-details-inline='true']")
        ?.closest("[aria-hidden='true']");
      expect(closingHiddenRegion).not.toBeNull();
      expect(closingHiddenRegion?.hasAttribute("inert")).toBe(true);

      await new Promise<void>((resolve) => {
        window.setTimeout(() => resolve(), 320);
      });
      await expect
        .poll(() => document.querySelector("[data-tool-details-inline='true']"))
        .toBeNull();
      await settleLayout();
    } finally {
      window.requestAnimationFrame = originalRequestAnimationFrame;
      window.cancelAnimationFrame = originalCancelAnimationFrame;
      await screen.unmount();
      host.remove();
      await settleLayout();
    }
  });

  it("keeps live activity compact and reveals technical metadata on demand", async () => {
    const host = createTimelineHost();
    const screen = await render(<LiveActivityTimeline />, { container: host });

    try {
      expect(document.body.textContent ?? "").toContain("Running command · bun install");
      expect(document.body.textContent ?? "").toContain("Active");
      expect(document.body.textContent ?? "").toContain("2m 14s elapsed");
      expect(document.body.textContent ?? "").toContain("42%");
      expect(document.body.textContent ?? "").not.toContain("Resolving packages");
      const displayText = document.querySelector("[data-work-entry-display-text='true']");
      const activityMeta = document.querySelector("[data-live-activity-meta='true']");
      expect(displayText?.closest("p")).toBe(activityMeta?.closest("p"));
      expect(displayText?.closest("p")?.textContent ?? "").toContain(
        "Running command · bun install · Active",
      );

      const trigger = document.querySelector<HTMLButtonElement>(
        '[data-tool-detail-trigger="true"]',
      );
      expect(trigger).not.toBeNull();
      trigger?.click();

      await expect.poll(() => document.body.textContent ?? "").toContain("Resolving packages");
      expect(document.body.textContent ?? "").toContain("Activity");
      expect(document.body.textContent ?? "").toContain("Running tool");
      expect(document.body.textContent ?? "").toContain("42%");
    } finally {
      await screen.unmount();
      host.remove();
      await settleLayout();
    }
  });
});

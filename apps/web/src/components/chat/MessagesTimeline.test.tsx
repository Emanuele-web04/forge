// FILE: MessagesTimeline.test.tsx
// Purpose: Covers transcript row rendering and SSR-safe presentation contracts.
// Layer: Web chat component tests
// Depends on: renderToStaticMarkup and a mocked LegendList.

import { CheckpointRef, MessageId, ThreadId, TurnId } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { formatShortTimestamp } from "../../timestampFormat";
import type { WorkLogEntry } from "../../workLog";
import { COLLAPSED_USER_MESSAGE_MAX_CHARS } from "./userMessageCollapse";

const TOOLTIP_TRIGGER_MARKER = 'data-base-ui-tooltip-trigger=""';

vi.mock("@legendapp/list/react", async () => {
  const React = await import("react");

  const LegendList = React.forwardRef(function MockLegendList(
    props: {
      data: Array<{ id: string }>;
      keyExtractor: (item: { id: string }) => string;
      renderItem: (args: { item: { id: string } }) => React.ReactNode;
    },
    _ref: React.ForwardedRef<unknown>,
  ) {
    return (
      <div data-testid="legend-list">
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
        ))}
      </div>
    );
  });

  return { LegendList };
});

// Baseline MessagesTimeline props shared across render tests; spread the
// result and override individual props (or pass them as JSX after the spread).
function makeTimelineBaseProps() {
  return {
    hasMessages: true,
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnStartedAt: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    nowIso: "2026-03-17T19:12:30.000Z",
    expandedWorkGroups: {},
    onToggleWorkGroup: () => {},
    onOpenTurnDiff: () => {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    markdownCwd: undefined,
    resolvedTheme: "dark" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
  };
}

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

beforeAll(() => {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
});

describe("MessagesTimeline", () => {
  it("keeps small transcripts on the simple non-virtualized path", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-message-1"),
              role: "assistant",
              text: "stable transcript body",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
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
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).not.toContain('data-index="0"');
    expect(markup).not.toContain('class="relative" style="height:');
    expect(markup).toContain('data-timeline-row-kind="message"');
  }, 10_000);

  it("renders assistant math through the shared markdown renderer", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-assistant-math",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("assistant-message-math"),
              role: "assistant",
              text: ["Inline $a^2 + b^2 = c^2$", "", "$$", "\\sum_{n=1}^{4} n", "$$"].join("\n"),
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
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
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('class="katex"');
    expect(markup).toContain("katex-display");
  });

  it("renders user message metadata outside the bubble shell", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-1"),
              role: "user",
              text: "ship the fix",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map([[MessageId.makeUnsafe("message-1"), 1]])}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("flex w-full justify-end");
    expect(markup).toContain("group flex flex-col items-end gap-px max-w-[80%]");
    expect(markup).toContain(
      "w-max max-w-full min-w-0 self-end bg-[var(--app-user-message-background)]",
    );
    expect(markup).toContain("rounded-[var(--radius-user-message)]");
    expect(markup).toContain("py-1.5");
    expect(markup).toContain("group-hover:opacity-100");
  });

  it("labels only the first message when another task created the conversation", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        crossTaskOrigin={{
          sourceThreadId: ThreadId.makeUnsafe("source-thread"),
          sourceProvider: "codex",
        }}
        timelineEntries={[
          {
            id: "entry-first-user",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("first-user-message"),
              role: "user",
              text: "Inspect the repository",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
          {
            id: "entry-second-user",
            kind: "message",
            createdAt: "2026-03-17T19:13:28.000Z",
            message: {
              id: MessageId.makeUnsafe("second-user-message"),
              role: "user",
              text: "Continue",
              createdAt: "2026-03-17T19:13:28.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:14:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        onOpenThread={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup.match(/data-cross-task-origin="true"/g)).toHaveLength(1);
    expect(markup).toContain("Sent by Synara from another thread");
    expect(markup).toContain('aria-label="Open source thread"');
    expect(markup.indexOf("Sent by Synara from another thread")).toBeLessThan(
      markup.indexOf("Inspect the repository"),
    );
  });

  it("shows only the cross-task label (not the agent chip) when both apply", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        crossTaskOrigin={{
          sourceThreadId: ThreadId.makeUnsafe("source-thread"),
          sourceProvider: "codex",
        }}
        timelineEntries={[
          {
            id: "entry-first-user",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("first-user-message"),
              role: "user",
              text: "Inspect the repository",
              dispatchOrigin: "agent",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:14:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        onOpenThread={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Sent by Synara from another thread");
    expect(markup).not.toContain("Sent by agent");
  });

  it("keeps user-bubble file and folder mention icons from being overridden by plugin names", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const baseProps = { ...makeTimelineBaseProps(), resolvedTheme: "light" as const };

    const folderMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...baseProps}
        timelineEntries={[
          {
            id: "entry-folder-mention",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-folder-mention"),
              role: "user",
              text: "Use @linear",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(folderMarkup).toContain("/central-icons-reversed/folder-2.svg");
    expect(folderMarkup).not.toContain("/central-icons-reversed/puzzle.svg");

    const tsxMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...baseProps}
        timelineEntries={[
          {
            id: "entry-tsx-file-mention",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-tsx-file-mention"),
              role: "user",
              text: "Use @src/App.tsx",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(tsxMarkup).toContain("/central-icons-reversed/react.svg");
    expect(tsxMarkup).not.toContain("/central-icons-reversed/folder-2.svg");

    const pluginMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...baseProps}
        timelineEntries={[
          {
            id: "entry-plugin-mention",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-plugin-mention"),
              role: "user",
              text: "Use @linear",
              mentions: [{ name: "linear", path: "plugin://linear@openai-curated" }],
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(pluginMarkup).toContain("/central-icons-reversed/puzzle.svg");
  });

  it("renders edit beside copy for user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-editable-user",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-editable-user"),
              role: "user",
              text: "adjust this prompt",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
          {
            id: "entry-editable-assistant",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: MessageId.makeUnsafe("message-editable-assistant"),
              role: "assistant",
              text: "",
              turnId: TurnId.makeUnsafe("turn-editable-user"),
              createdAt: "2026-03-17T19:12:29.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={
          new Map([[MessageId.makeUnsafe("message-editable-user"), 0]])
        }
        onRevertUserMessage={() => {}}
        onEditUserMessage={() => true}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('aria-label="Copy message"');
    expect(markup).toContain('aria-label="Edit message"');
    expect(markup).toContain('aria-label="Revert to this message"');
    expect(markup).toContain("size-[1.125em]");
  });

  it("keeps edit available and hides undo before a revert checkpoint exists", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-user-no-checkpoint",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-user-no-checkpoint"),
              role: "user",
              text: "still waiting on undo",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
          {
            id: "entry-assistant-no-checkpoint",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: MessageId.makeUnsafe("message-assistant-no-checkpoint"),
              role: "assistant",
              text: "",
              turnId: TurnId.makeUnsafe("turn-user-no-checkpoint"),
              createdAt: "2026-03-17T19:12:29.000Z",
              streaming: false,
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
        onEditUserMessage={() => true}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain('aria-label="Edit message"');
    expect(markup).not.toContain('aria-label="Revert to this message"');
    expect(markup).not.toContain('title="Edit message"');
    expect(markup).not.toContain('title="Revert to this message"');
  });

  it("keeps edit available while an assistant turn is running", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnId={TurnId.makeUnsafe("turn-user-running")}
        activeTurnStartedAt="2026-03-17T19:12:30.000Z"
        timelineEntries={[
          {
            id: "entry-user-running",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-user-running"),
              role: "user",
              text: "change this while it runs",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:32.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={
          new Map([[MessageId.makeUnsafe("message-user-running"), 1]])
        }
        onRevertUserMessage={() => {}}
        onEditUserMessage={() => true}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    const editButtonMarkup = markup.match(/<button[^>]*aria-label="Edit message"[^>]*>/)?.[0] ?? "";
    expect(markup).toContain('aria-label="Edit message"');
    expect(editButtonMarkup).not.toContain('disabled=""');
    expect(markup).not.toContain('title="Edit message"');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Revert to this message"/);
  });

  it("renders a steering chip above steered user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-steered-user-message",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-steered-user"),
              role: "user",
              text: "hello",
              dispatchMode: "steer",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
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
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Steering conversation");
    expect(markup).toContain("mb-1.5");
  });

  it("renders a 'Sent via Automation' chip above automation-dispatched user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-automation-user-message",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-automation-user"),
              role: "user",
              text: "hello",
              dispatchOrigin: "automation",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
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
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Sent via Automation");
    expect(markup).not.toContain("Steering conversation");
  });

  it("renders a 'Sent by agent' chip above agent-dispatched user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-agent-user-message",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-agent-user"),
              role: "user",
              text: "status check from the coordinator",
              dispatchOrigin: "agent",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
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
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Sent by agent");
    expect(markup).not.toContain("Sent via Automation");
    expect(markup).not.toContain("Steering conversation");
  });

  it("pushes the steering chip higher when the user message has chips or photos", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-steered-user-message-media",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-steered-user-media"),
              role: "user",
              text: "hello",
              dispatchMode: "steer",
              attachments: [
                {
                  id: "assistant-selection-1",
                  type: "assistant-selection",
                  assistantMessageId: MessageId.makeUnsafe("assistant-1"),
                  text: "draft this",
                },
                {
                  id: "image-1",
                  type: "image",
                  name: "image.png",
                  mimeType: "image/png",
                  sizeBytes: 5,
                },
              ],
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
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
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Steering conversation");
    expect(markup).toContain("mb-3");
  });

  it("renders user text as markdown with hard line breaks", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-plain-user-message",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-plain-user"),
              role: "user",
              text: "tl\ndr",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
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
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("chat-markdown--user");
    // remark-breaks keeps the user's single newline as a hard break.
    expect(markup).toContain("tl<br/>\ndr");
    expect(markup).not.toContain("<pre");
  });

  it("clamps long user messages visually and renders a separate Show more button", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const hiddenTail = "TAIL_SHOULD_STAY_HIDDEN";
    const longText = `${"a".repeat(COLLAPSED_USER_MESSAGE_MAX_CHARS)}${hiddenTail}`;
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-long-user-message",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-long-user"),
              role: "user",
              text: longText,
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
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
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Show more");
    // The full text stays rendered; collapsing is a visual max-height clamp with
    // a fade mask, so markdown structures are never sliced mid-syntax.
    expect(markup).toContain(hiddenTail);
    expect(markup).toContain('data-user-message-clamp="true"');
    expect(markup).toContain("max-height:");
    expect(markup).toContain("mask-image:linear-gradient");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toMatch(/aria-controls="[^"]+"/);
  });

  it("renders inline terminal labels with the composer chip UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-2"),
              role: "user",
              text: [
                "yoo what's **bold** @terminal-1:1-5 mean",
                "",
                "<terminal_context>",
                "- Terminal 1 lines 1-5:",
                "  1 | julius@mac effect-http-ws-cli % bun i",
                "  2 | bun install v1.3.9 (cf6cdbbb)",
                "</terminal_context>",
              ].join("\n"),
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
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
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain("/central-icons-reversed/console.svg");
    expect(markup).toContain("yoo what&#x27;s ");
    expect(markup).toContain("<strong>bold</strong>");
  });

  it("renders assistant selection chips from hidden prompt markup when attachments are missing", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-user-selection-fallback",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-user-selection-fallback"),
              role: "user",
              text: [
                "please use this",
                "",
                "<assistant_selection>",
                "- assistant message assistant-1:",
                "  selected line from assistant",
                "</assistant_selection>",
              ].join("\n"),
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
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
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("please use this");
    expect(markup).toContain("1 selection");
    expect(markup).not.toContain("&lt;assistant_selection&gt;");
  });

  it("renders trailing user skill tokens with the composer skill pill UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-user-skill-pill",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-user-skill"),
              role: "user",
              text: "$check-code",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
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
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Check Code");
    expect(markup).toContain("text-[var(--info-foreground)]");
    expect(markup).not.toContain("$check-code</div>");
  });

  it("renders trailing user subagent mentions with the composer agent pill UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-user-agent-pill",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.makeUnsafe("message-user-agent"),
              role: "user",
              text: "@spark(check the UI)",
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
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
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("@spark");
    expect(markup).toContain("inline-flex max-w-full select-none items-center gap-0.5");
    expect(markup).toContain("mx-0.5");
    expect(markup).toContain("rounded-md px-1.5 py-0.5");
    expect(markup).toContain("(check the UI)");
    expect(markup).not.toContain("@spark(check the UI)</div>");
  });

  it("renders context compaction entries in the normal work log", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Context compacted manually",
              tone: "info",
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
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Context compacted manually");
    expect(markup).not.toContain("Work log");
  });

  it("keeps the generic working copy alongside the active compaction entry", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:28.000Z"
        timelineEntries={[
          {
            id: "entry-compacting",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-compacting",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Compacting conversation...",
              tone: "info",
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
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Compacting conversation...");
    expect(markup).toContain("Working for");
    expect(markup).not.toContain("h-px flex-1 bg-border");
  });

  it("does not reserve a timestamp footer between live status updates and Thinking", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const activeTurnId = TurnId.makeUnsafe("turn-live-status");
    const assistantCreatedAt = "2026-03-17T19:12:29.000Z";
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...makeTimelineBaseProps()}
        isWorking
        activeTurnInProgress
        activeTurnId={activeTurnId}
        activeTurnStartedAt="2026-03-17T19:12:28.000Z"
        timelineEntries={[
          {
            id: "entry-tasks-updated",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.500Z",
            entry: {
              id: "work-tasks-updated",
              createdAt: "2026-03-17T19:12:28.500Z",
              label: "Tasks updated",
              tone: "info",
              turnId: activeTurnId,
            },
          },
          {
            id: "entry-live-assistant",
            kind: "message",
            createdAt: assistantCreatedAt,
            message: {
              id: MessageId.makeUnsafe("message-live-assistant"),
              role: "assistant",
              text: "",
              createdAt: assistantCreatedAt,
              streaming: false,
              turnId: activeTurnId,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Tasks updated");
    expect(markup).toContain("Thinking");
    expect(markup).not.toContain(formatShortTimestamp(assistantCreatedAt, "locale"));
    expect(markup).toMatch(/class="[^"]*\bpb-1\b[^"]*" data-timeline-row-kind="message"/);
  });

  it("folds work log summaries above the next assistant message footer", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-work-inline",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "turn",
              tone: "info",
            },
          },
          {
            id: "entry-assistant-inline",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: MessageId.makeUnsafe("message-assistant-inline"),
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:29.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
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
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain(formatShortTimestamp("2026-03-17T19:12:29.000Z", "locale"));
    expect(markup).toContain("Worked for 1.0s");
    expect(markup).not.toContain("data-scroll-anchor-ignore");
    expect(markup).not.toContain(
      `${formatShortTimestamp("2026-03-17T19:12:29.000Z", "locale")} • 1.0s`,
    );
    expect(markup).not.toContain("Work log");
  });

  it("attaches trailing work log summaries to the last assistant reply after completion", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-assistant-trailing",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: MessageId.makeUnsafe("message-assistant-trailing"),
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:29.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
          {
            id: "entry-work-trailing",
            kind: "work",
            createdAt: "2026-03-17T19:12:31.000Z",
            entry: {
              id: "work-trailing-1",
              createdAt: "2026-03-17T19:12:31.000Z",
              label: "turn",
              tone: "info",
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:31.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain(">done</p>");
    expect(markup).not.toContain("Work log");
    expect(markup).not.toContain('data-timeline-row-kind="work"');
  });

  it("collapses every completed-turn tool call behind a single Worked-for toggle", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-inline-tools",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-tool-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "tool 1",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.100Z",
            entry: {
              id: "work-inline-tool-2",
              createdAt: "2026-03-17T19:12:28.100Z",
              label: "tool 2",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-3",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.200Z",
            entry: {
              id: "work-inline-tool-3",
              createdAt: "2026-03-17T19:12:28.200Z",
              label: "tool 3",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-4",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.300Z",
            entry: {
              id: "work-inline-tool-4",
              createdAt: "2026-03-17T19:12:28.300Z",
              label: "tool 4",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-5",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.400Z",
            entry: {
              id: "work-inline-tool-5",
              createdAt: "2026-03-17T19:12:28.400Z",
              label: "tool 5",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-6",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.500Z",
            entry: {
              id: "work-inline-tool-6",
              createdAt: "2026-03-17T19:12:28.500Z",
              label: "tool 6",
              tone: "tool",
            },
          },
          {
            id: "entry-assistant-inline-tools",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: MessageId.makeUnsafe("message-assistant-inline-tools"),
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:29.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
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
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Worked for");
    expect(markup).toContain(">done</p>");
    // Completed turns fold all tool work behind the single collapsed disclosure,
    // which stays unmounted until expanded, so no inline tool rows leak out.
    expect(markup).not.toContain("+2 more tool calls");
    expect(markup).not.toContain("Tool 1");
    expect(markup).not.toContain("Tool 5");
  });

  it("renders Cursor-style inline tool rows with a uniform label", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-05-09T16:31:20.000Z"
        timelineEntries={[
          {
            id: "entry-cursor-search",
            kind: "work",
            createdAt: "2026-05-09T16:31:20.000Z",
            entry: {
              id: "work-cursor-search",
              createdAt: "2026-05-09T16:31:20.000Z",
              label: "Tool",
              tone: "tool",
              itemType: "dynamic_tool_call",
              toolTitle: "Searched",
              detail: "2 files found",
            },
          },
          {
            id: "entry-cursor-assistant",
            kind: "message",
            createdAt: "2026-05-09T16:31:24.000Z",
            message: {
              id: MessageId.makeUnsafe("message-cursor-assistant"),
              role: "assistant",
              text: "done",
              createdAt: "2026-05-09T16:31:24.000Z",
              completedAt: "2026-05-09T16:31:25.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-05-09T16:31:25.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain(
      '<span data-work-entry-display-text="true">Searched 2 files found</span>',
    );
    expect(markup).not.toContain("data-work-entry-action-word");
  });

  it("renders Claude agent task output through the shared markdown renderer", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-05-09T16:31:20.000Z"
        timelineEntries={[
          {
            id: "entry-claude-agent-task",
            kind: "work",
            createdAt: "2026-05-09T16:31:20.000Z",
            entry: {
              id: "work-claude-agent-task",
              createdAt: "2026-05-09T16:31:20.000Z",
              label: "Agent task",
              tone: "tool",
              itemType: "collab_agent_tool_call",
              toolTitle: "Map file-icon logic in file-changes",
              detail: [
                "## Complete File-Icon Rendering Map",
                "",
                "```tsx",
                'const iconName = "react";',
                "```",
              ].join("\n"),
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-05-09T16:31:25.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("<h2>Complete File-Icon Rendering Map</h2>");
    expect(markup).toContain("chat-markdown-codeblock");
    expect(markup).not.toContain("```tsx");
  });

  it("collapses a leading tool run behind its summary once the assistant text follows, even mid-turn", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:28.000Z"
        timelineEntries={[
          {
            id: "entry-inline-tools-live-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-live-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "tool 1",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-live-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.100Z",
            entry: {
              id: "work-inline-live-2",
              createdAt: "2026-03-17T19:12:28.100Z",
              label: "tool 2",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-live-3",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.200Z",
            entry: {
              id: "work-inline-live-3",
              createdAt: "2026-03-17T19:12:28.200Z",
              label: "tool 3",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-live-4",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.300Z",
            entry: {
              id: "work-inline-live-4",
              createdAt: "2026-03-17T19:12:28.300Z",
              label: "tool 4",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-live-5",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.400Z",
            entry: {
              id: "work-inline-live-5",
              createdAt: "2026-03-17T19:12:28.400Z",
              label: "tool 5",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-live-6",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.500Z",
            entry: {
              id: "work-inline-live-6",
              createdAt: "2026-03-17T19:12:28.500Z",
              label: "tool 6",
              tone: "tool",
            },
          },
          {
            id: "entry-assistant-inline-tools-live",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: MessageId.makeUnsafe("message-assistant-inline-tools-live"),
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:29.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
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
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    // The assistant's text block already follows the run, so it compacts
    // behind the summary row even while the turn is still live.
    expect(markup).toContain("Ran 6 tool calls");
    expect(markup).not.toContain("Tool 1");
    expect(markup).not.toContain("Tool 6");
    expect(markup).not.toContain("+2 more tool calls");
  });

  it("renders reasoning activity as iconless tool text while Thinking remains live", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const activeTurnId = TurnId.makeUnsafe("turn-reasoning-live");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnId={activeTurnId}
        activeTurnStartedAt="2026-03-17T19:12:28.000Z"
        timelineEntries={[
          {
            id: "entry-reasoning-trace",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.100Z",
            entry: {
              id: "reasoning-trace",
              createdAt: "2026-03-17T19:12:28.100Z",
              turnId: activeTurnId,
              label: "Reasoning trace",
              toolTitle: "Reasoning trace",
              detail: "**Inspecting apps/web/src/store.ts**\n\n<!-- -->",
              tone: "tool",
            },
          },
          {
            id: "entry-mcp-tool",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.200Z",
            entry: {
              id: "mcp-tool",
              createdAt: "2026-03-17T19:12:28.200Z",
              turnId: activeTurnId,
              label: "MCP tool call",
              toolTitle: "MCP tool call",
              toolName: "mcp__docs__search",
              itemType: "mcp_tool_call",
              tone: "tool",
            },
          },
          {
            id: "entry-reasoning-summary",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.300Z",
            entry: {
              id: "reasoning-summary",
              createdAt: "2026-03-17T19:12:28.300Z",
              turnId: activeTurnId,
              label: "Reasoning summary",
              toolTitle: "Reasoning summary",
              preview: "Updating the adapter",
              tone: "tool",
            },
          },
          {
            id: "entry-command-execution",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.400Z",
            entry: {
              id: "command-execution",
              createdAt: "2026-03-17T19:12:28.400Z",
              turnId: activeTurnId,
              label: "Ran command",
              toolTitle: "Ran command",
              itemType: "command_execution",
              preview: "Running the focused tests",
              tone: "tool",
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup.match(/data-codex-status-row="true"/g) ?? []).toHaveLength(3);
    expect(markup.match(/data-work-entry-icon="true"/g) ?? []).toHaveLength(1);
    expect(markup).toContain(">Thinking<");
    expect(markup).toContain("Inspecting apps/web/src/store.ts");
    expect(markup).not.toContain("Reasoning trace Inspecting");
  });

  it("keeps Thinking when a new local send has no server turn id yet", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const previousTurnId = TurnId.makeUnsafe("turn-previous");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnId={null}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-user-previous",
            kind: "message",
            createdAt: "2026-03-17T19:12:20.000Z",
            message: {
              id: MessageId.makeUnsafe("message-user-previous"),
              role: "user",
              text: "Previous request",
              createdAt: "2026-03-17T19:12:20.000Z",
              streaming: false,
            },
          },
          {
            id: "entry-reasoning-previous",
            kind: "work",
            createdAt: "2026-03-17T19:12:21.000Z",
            entry: {
              id: "reasoning-previous",
              createdAt: "2026-03-17T19:12:21.000Z",
              turnId: previousTurnId,
              label: "Reasoning",
              toolTitle: "Reasoning",
              tone: "info",
            },
          },
          {
            id: "entry-assistant-previous",
            kind: "message",
            createdAt: "2026-03-17T19:12:22.000Z",
            message: {
              id: MessageId.makeUnsafe("message-assistant-previous"),
              role: "assistant",
              turnId: previousTurnId,
              text: "Previous answer",
              createdAt: "2026-03-17T19:12:22.000Z",
              completedAt: "2026-03-17T19:12:23.000Z",
              streaming: false,
            },
          },
          {
            id: "entry-user-current",
            kind: "message",
            createdAt: "2026-03-17T19:12:30.000Z",
            message: {
              id: MessageId.makeUnsafe("message-user-current"),
              role: "user",
              text: "Current request",
              createdAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain(">Thinking<");
  });

  it("attaches trailing tool rows to the last assistant reply after completion", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-assistant-final",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: MessageId.makeUnsafe("message-assistant-final"),
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:29.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
          {
            id: "entry-trailing-tool-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:30.100Z",
            entry: {
              id: "work-trailing-tool-1",
              createdAt: "2026-03-17T19:12:30.100Z",
              label: "tool 1",
              tone: "tool",
            },
          },
          {
            id: "entry-trailing-tool-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:30.200Z",
            entry: {
              id: "work-trailing-tool-2",
              createdAt: "2026-03-17T19:12:30.200Z",
              label: "tool 2",
              tone: "tool",
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:31.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Worked for");
    expect(markup).toContain(">done</p>");
    // Trailing work folds into the terminal reply's collapsed disclosure rather
    // than leaving a detached work row at the end of the transcript.
    expect(markup).not.toContain("Tool 1");
    expect(markup).not.toContain("Tool 2");
    expect(markup).not.toContain('data-timeline-row-kind="work"');
  });

  it("expands live inline tool calls past the cap when the group is toggled open", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking
        activeTurnInProgress
        activeTurnStartedAt="2026-03-17T19:12:28.000Z"
        timelineEntries={[
          // The message comes first so the tools are the turn's live inline
          // tail: the run stays expanded and keeps the +N cap behavior.
          {
            id: "entry-assistant-inline-tools-expanded",
            kind: "message",
            createdAt: "2026-03-17T19:12:27.000Z",
            message: {
              id: MessageId.makeUnsafe("message-assistant-inline-tools-expanded"),
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:27.000Z",
              streaming: true,
            },
          },
          {
            id: "entry-inline-tools-expanded",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-expanded-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "tool 1",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-expanded-2",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.100Z",
            entry: {
              id: "work-inline-expanded-2",
              createdAt: "2026-03-17T19:12:28.100Z",
              label: "tool 2",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-expanded-3",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.200Z",
            entry: {
              id: "work-inline-expanded-3",
              createdAt: "2026-03-17T19:12:28.200Z",
              label: "tool 3",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-expanded-4",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.300Z",
            entry: {
              id: "work-inline-expanded-4",
              createdAt: "2026-03-17T19:12:28.300Z",
              label: "tool 4",
              tone: "tool",
            },
          },
          {
            id: "entry-inline-tools-expanded-5",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.400Z",
            entry: {
              id: "work-inline-expanded-5",
              createdAt: "2026-03-17T19:12:28.400Z",
              label: "tool 5",
              tone: "tool",
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{ "entry-inline-tools-expanded": true }}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Tool 5");
    expect(markup).toContain("Show less");
  });

  it("renders inline file-change tool calls as edited rows with diff stats", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const assistantMessageId = MessageId.makeUnsafe("message-assistant-inline-edit");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-inline-file-change",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-file-change",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "File Change",
              tone: "tool",
              requestKind: "file-change",
              changedFiles: ["apps/web/src/components/chat/MessagesTimeline.test.tsx"],
              toolDetails: {
                kind: "file-change",
                title: "Edited",
                diff: [
                  "diff --git a/apps/web/src/components/chat/MessagesTimeline.test.tsx b/apps/web/src/components/chat/MessagesTimeline.test.tsx",
                  "-old",
                  "+new",
                ].join("\n"),
                files: ["apps/web/src/components/chat/MessagesTimeline.test.tsx"],
              },
            },
          },
          {
            id: "entry-assistant-inline-edit",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:29.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId: TurnId.makeUnsafe("turn-inline-edit-1"),
                completedAt: "2026-03-17T19:12:30.000Z",
                assistantMessageId,
                files: [
                  {
                    path: "apps/web/src/components/chat/MessagesTimeline.test.tsx",
                    additions: 1,
                    deletions: 1,
                  },
                ],
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
      />,
    );

    expect(markup).toContain("Edited");
    expect(markup).toContain("MessagesTimeline.test.tsx");
    expect(markup).toContain("+1");
    expect(markup).toContain("-1");
    expect(markup).not.toContain(
      "File Change - apps/web/src/components/chat/MessagesTimeline.test.tsx",
    );
  });

  it("marks visible file-change rows with captured details as clickable", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-file-change-details",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-file-change-details",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "File Change",
              tone: "tool",
              requestKind: "file-change",
              changedFiles: ["apps/web/src/components/chat/MessagesTimeline.test.tsx"],
              toolDetails: {
                kind: "file-change",
                title: "Edited",
                diff: "-old\n+new",
                files: ["apps/web/src/components/chat/MessagesTimeline.test.tsx"],
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
      />,
    );

    expect(markup).toContain('data-tool-detail-trigger="true"');
    expect(markup).toContain(TOOLTIP_TRIGGER_MARKER);
    expect(markup).not.toContain('data-tool-details-inline="true"');
    expect(markup).not.toContain("Diff");
    expect(markup).not.toContain("Details");
  });

  it("renders command rows with a readable summary and styled hover tooltip trigger", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-inline-command",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-command",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Searched",
              command: `rg -n "ProjectionSnapshotQuery" apps/server/src`,
              rawCommand: `/bin/zsh -lc 'rg -n "ProjectionSnapshotQuery" apps/server/src'`,
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
      />,
    );

    expect(markup).toContain("Searched");
    expect(markup).toContain("for ProjectionSnapshotQuery in server/src");
    expect(markup).not.toContain("data-work-entry-action-word");
    expect(markup).toContain(TOOLTIP_TRIGGER_MARKER);
    expect(markup).not.toContain(
      `title="/bin/zsh -lc &#x27;rg -n &quot;ProjectionSnapshotQuery&quot; apps/server/src&#x27;"`,
    );
    expect(markup).not.toContain("&gt;/bin/zsh -lc");
  });

  it("uses the GitHub logo for git and GitHub CLI command rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    // Rendered as a live turn: once settled, consecutive command rows fold into
    // a closed "Ran N commands" summary and individual rows are not in markup.
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={true}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-git-command",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-git-command",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Checked",
              command: "git status --short",
            },
          },
          {
            id: "entry-gh-command",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-gh-command",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Ran",
              command: "gh pr view 274 --repo owner/repo",
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
      />,
    );

    expect(markup.match(/data-tool-icon="github"/g)).toHaveLength(2);
    expect(markup).not.toContain("/central-icons-reversed/git.svg");
  });

  it("marks command rows with captured details as clickable", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
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
      />,
    );

    expect(markup).toContain('data-tool-detail-trigger="true"');
    expect(markup).not.toContain('data-tool-details-inline="true"');
    expect(markup).not.toContain("Shell");
    expect(markup).not.toContain("rounded-lg border border-border/45 bg-background/62");
    expect(markup).not.toContain("chat-markdown-codeblock");
    expect(markup).not.toContain("$ rg -n &quot;toolDetails&quot; apps/web/src");
    expect(markup).not.toContain("apps/web/src/session-logic.ts:55: toolDetails");
    expect(markup).not.toContain("Stdout");
    expect(markup).toContain("Searched");
  });

  it("renders command text even when commandActions provide a short preview", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-inline-command-actions",
            kind: "work",
            createdAt: "2026-05-09T10:06:54.443Z",
            entry: {
              id: "work-inline-command-actions",
              createdAt: "2026-05-09T10:06:54.443Z",
              label: "Ran command",
              tone: "tool",
              itemType: "command_execution",
              toolTitle: "Listed",
              preview: "web",
              command: "find apps/web/src -maxdepth 2 -type d",
              rawCommand: `/bin/zsh -lc "find apps/web/src -maxdepth 2 -type d | sort | sed -n '1,120p'"`,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-05-09T10:07:00.000Z"
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
      />,
    );

    expect(markup).toContain("Listed");
    expect(markup).not.toContain("data-work-entry-action-word");
    expect(markup).toContain("web/src");
    expect(markup).toContain(TOOLTIP_TRIGGER_MARKER);
    expect(markup).not.toContain(">Listed web<");
  });

  it("renders plain location details as file basenames", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-read-location",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-read-location",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Read",
              tone: "tool",
              itemType: "dynamic_tool_call",
              toolTitle: "Read",
              detail: "apps/web/src/session-logic.ts:12",
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onOpenTurnDiff={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Read");
    expect(markup).toContain("session-logic.ts");
    expect(markup).not.toContain("apps/web/src/session-logic.ts:12");
  });

  it("renders read target files without edit-row treatment", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-read-target",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-read-target",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Read",
              tone: "tool",
              itemType: "dynamic_tool_call",
              toolTitle: "Read",
              changedFiles: ["apps/web/src/session-logic.ts"],
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        onOpenTurnDiff={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Read");
    expect(markup).toContain("session-logic.ts");
    expect(markup).not.toContain("data-file-change-row");
  });

  it("shows a globe icon next to compact web-search rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-inline-web-search",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-web-search",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Web search",
              tone: "tool",
              itemType: "web_search",
              toolTitle: "Searched the web",
              detail: "48 files found",
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
      />,
    );

    expect(markup).toContain("Searched the web");
    expect(markup).toContain("48 files found");
    expect(markup).toContain("/central-icons-reversed/globe.svg");
    expect(markup).not.toContain("tabler-icon-world");
  });

  it("shows a GitHub icon next to compact GitHub MCP rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-inline-github-mcp",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-github-mcp",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "MCP tool call",
              tone: "tool",
              itemType: "mcp_tool_call",
              toolTitle: "Codex Apps: Github Fetch Pr",
              toolName: "mcp__codex_apps__github__fetch_pr",
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
      />,
    );

    expect(markup).toContain("Codex Apps: Github Fetch Pr");
    expect(markup).toContain('data-tool-icon="github"');
  });

  it("shows an MCP icon next to compact non-GitHub MCP rows", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-inline-mcp",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-mcp",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "MCP tool call",
              tone: "tool",
              itemType: "mcp_tool_call",
              toolTitle: "Codex Apps: Slack Search",
              toolName: "mcp__codex_apps__slack__search",
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
      />,
    );

    expect(markup).toContain("Codex Apps: Slack Search");
    expect(markup).toContain('data-tool-icon="mcp"');
  });

  it("shows the Synara mark for every provider-specific tool row shape", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const baseProps = makeTimelineBaseProps();

    // Provider-style server/tool identifier while the call is active.
    const claudeMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...baseProps}
        timelineEntries={[
          {
            id: "entry-inline-synara-claude",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-synara-claude",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "MCP tool call",
              tone: "tool",
              itemType: "dynamic_tool_call",
              toolTitle: "Synara__synara_create_thread",
              toolName: "Synara__synara_create_thread",
              detail: "Synara__synara_create_thread",
              activityKind: "tool.started",
            },
          },
        ]}
      />,
    );
    expect(claudeMarkup).toContain('data-tool-icon="synara"');
    expect(claudeMarkup).not.toContain('data-tool-icon="mcp"');
    expect(claudeMarkup).toContain("Synara is creating a thread");
    expect(claudeMarkup).not.toContain("Synara__synara_create_thread");

    // A provider may misclassify an MCP action containing "create" or "list"
    // as a file change. Tool identity still wins over that transport category.
    const codexMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...baseProps}
        timelineEntries={[
          {
            id: "entry-inline-synara-codex",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-synara-codex",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "MCP tool call",
              tone: "tool",
              itemType: "file_change",
              toolTitle: "mcp__Synara__synara_list_threads",
              detail: "mcp__Synara__synara_list_threads",
            },
          },
        ]}
      />,
    );
    expect(codexMarkup).toContain('data-tool-icon="synara"');
    expect(codexMarkup).toContain("Synara listed threads");
    expect(codexMarkup).not.toContain("mcp__Synara__synara_list_threads");

    const failedMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...baseProps}
        timelineEntries={[
          {
            id: "entry-inline-synara-failed",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-synara-failed",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "MCP tool call",
              tone: "tool",
              itemType: "mcp_tool_call",
              toolName: "mcp__synara__synara_create_threads",
              toolStatus: "failed",
              detail: "Claude rejected reasoningEffort",
              activityKind: "tool.completed",
            },
          },
        ]}
      />,
    );
    expect(failedMarkup).toContain("Synara couldn&#x27;t create threads");
    expect(failedMarkup).toContain("Claude rejected reasoningEffort");
  });

  it("hides raw `ToolName: {json}` argument details behind the humanized heading", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const baseProps = makeTimelineBaseProps();

    const renderSingleToolRow = (entry: WorkLogEntry) =>
      renderToStaticMarkup(
        <MessagesTimeline
          {...baseProps}
          timelineEntries={[
            {
              id: `entry-${entry.id}`,
              kind: "work",
              createdAt: "2026-03-17T19:12:28.000Z",
              entry,
            },
          ]}
        />,
      );

    const readThreadMarkup = renderSingleToolRow({
      id: "work-synara-read-thread-args",
      createdAt: "2026-03-17T19:12:28.000Z",
      label: "MCP tool call",
      tone: "tool",
      itemType: "mcp_tool_call",
      toolName: "mcp__synara__synara_read_thread",
      detail: 'mcp__synara__synara_read_thread: {"threadId":"c357d8c5-b4c1-47d0"}',
      activityKind: "tool.completed",
    });
    expect(readThreadMarkup).toContain("Synara read a thread");
    expect(readThreadMarkup).not.toContain("mcp__synara__synara_read_thread:");
    expect(readThreadMarkup).not.toContain("threadId");

    const diagnoseMarkup = renderSingleToolRow({
      id: "work-synara-diagnose-args",
      createdAt: "2026-03-17T19:12:28.000Z",
      label: "MCP tool call",
      tone: "tool",
      itemType: "mcp_tool_call",
      toolName: "mcp__synara__synara_diagnose_thread",
      detail: 'mcp__synara__synara_diagnose_thread: {"threadId":"09a1615d-084f-40b9"}',
      activityKind: "tool.completed",
    });
    expect(diagnoseMarkup).toContain("Synara diagnosed a thread");
    expect(diagnoseMarkup).not.toContain("mcp__synara__synara_diagnose_thread:");
    expect(diagnoseMarkup).not.toContain("threadId");

    const dynamicToolMarkup = renderSingleToolRow({
      id: "work-dynamic-tool-args",
      createdAt: "2026-03-17T19:12:28.000Z",
      label: "ToolSearch",
      tone: "tool",
      itemType: "dynamic_tool_call",
      toolName: "ToolSearch",
      toolTitle: "ToolSearch",
      detail: 'ToolSearch: {"query":"select:mcp__synara__synara_read_thread_events"}',
      activityKind: "tool.completed",
    });
    expect(dynamicToolMarkup).toContain("ToolSearch");
    expect(dynamicToolMarkup).not.toContain("&quot;query&quot;");

    // Failed calls are exempt: the JSON-shaped detail may be the only place
    // the error surfaces, so it stays visible inline.
    const failedArgsMarkup = renderSingleToolRow({
      id: "work-synara-failed-args",
      createdAt: "2026-03-17T19:12:28.000Z",
      label: "MCP tool call",
      tone: "tool",
      itemType: "mcp_tool_call",
      toolName: "mcp__synara__synara_create_threads",
      toolStatus: "failed",
      detail: 'McpError: {"code":-32602,"message":"Invalid params"}',
      activityKind: "tool.completed",
    });
    expect(failedArgsMarkup).toContain("Synara couldn&#x27;t create threads");
    expect(failedArgsMarkup).toContain("Invalid params");
  });

  it("keeps Synara tool calls and adds a thread creation recap at the end of the turn", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const assistantMessageId = MessageId.makeUnsafe("message-synara-recap");
    const workEntries = [
      {
        id: "entry-synara-create-tool",
        kind: "work",
        createdAt: "2026-03-17T19:12:28.000Z",
        entry: {
          id: "work-synara-create-tool",
          createdAt: "2026-03-17T19:12:28.000Z",
          label: "MCP tool call",
          tone: "tool",
          itemType: "mcp_tool_call",
          toolName: "mcp__synara__synara_create_threads",
          toolTitle: "Synara created threads",
          activityKind: "tool.completed",
        },
      },
      {
        id: "entry-synara-create-recap",
        kind: "work",
        createdAt: "2026-03-17T19:12:29.000Z",
        entry: {
          id: "work-synara-create-recap",
          createdAt: "2026-03-17T19:12:29.000Z",
          label: "Created 2 Synara threads",
          tone: "info",
          activityKind: "synara.threads.created",
          synaraThreadCreation: {
            operationId: "gateway:create:two-workers",
            requestedCount: 2,
            createdCount: 2,
            threads: [
              {
                threadId: "thread-terra",
                title: "Explain the repository with Terra",
                provider: "codex",
                model: "gpt-5.6-terra",
                environment: "local",
                status: "task_dispatched",
              },
              {
                threadId: "thread-claude",
                title: "Explain the repository with Claude",
                provider: "claudeAgent",
                model: "claude-sonnet-5",
                environment: "worktree",
                status: "task_dispatched",
              },
            ],
          },
        },
      },
    ] as const;
    const baseProps = {
      ...makeTimelineBaseProps(),
      nowIso: "2026-03-17T19:12:31.000Z",
      onOpenThread: () => {},
    };
    const liveMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...baseProps}
        isWorking
        activeTurnInProgress
        timelineEntries={[...workEntries]}
      />,
    );
    expect(liveMarkup).toContain("Synara created threads");
    expect(liveMarkup).not.toContain('data-synara-thread-creation-card="true"');

    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...baseProps}
        isWorking={false}
        activeTurnInProgress={false}
        timelineEntries={[
          ...workEntries,
          {
            id: "entry-synara-recap-assistant",
            kind: "message",
            createdAt: "2026-03-17T19:12:30.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "Both threads are running.",
              createdAt: "2026-03-17T19:12:30.000Z",
              completedAt: "2026-03-17T19:12:31.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    // The original MCP tool call is preserved inside the settled turn's
    // "Worked for..." disclosure; the recap is an additional final artifact.
    expect(markup).toContain("Worked for");
    expect(markup).toContain('data-synara-thread-creation-card="true"');
    expect(markup).toContain("2 threads created");
    expect(markup).toContain("2/2 requested threads created");
    expect(markup).toContain("Explain the repository with Terra");
    expect(markup).toContain("Explain the repository with Claude");
    expect(markup).toContain("GPT-5.6 Terra");
    expect(markup).toContain("Claude Sonnet 5");
    expect(markup.indexOf("Both threads are running.")).toBeLessThan(
      markup.indexOf('data-synara-thread-creation-card="true"'),
    );
  });

  it("anchors the changed-files summary at the end of a collapsed file-change turn", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const assistantMessageId = MessageId.makeUnsafe("message-assistant-inline-multi-edit");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-inline-multi-file-change",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-multi-file-change",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "File Change",
              tone: "tool",
              requestKind: "file-change",
              changedFiles: [
                "apps/web/src/components/chat/MessagesTimeline.test.tsx",
                "apps/web/src/components/chat/MessagesTimeline.tsx",
              ],
            },
          },
          {
            id: "entry-assistant-inline-multi-edit",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:29.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId: TurnId.makeUnsafe("turn-inline-multi-edit-1"),
                completedAt: "2026-03-17T19:12:30.000Z",
                assistantMessageId,
                files: [
                  {
                    path: "apps/web/src/components/chat/MessagesTimeline.test.tsx",
                    additions: 1,
                    deletions: 1,
                  },
                  {
                    path: "apps/web/src/components/chat/MessagesTimeline.tsx",
                    additions: 2,
                    deletions: 0,
                  },
                ],
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
      />,
    );

    // The tool work collapses, but the changed-files summary stays anchored at
    // the end of the turn with every file from the turn diff.
    expect(markup).toContain("Worked for");
    expect(markup).toContain("Edited 2 files");
    expect(markup).toContain("apps/web/src/components/chat/MessagesTimeline.test.tsx");
    expect(markup).toContain("apps/web/src/components/chat/MessagesTimeline.tsx");
    expect(markup).toContain("+1");
    expect(markup).toContain("-1");
    expect(markup).toContain("+2");
    expect(markup).not.toContain(">apps/web/src/components/chat<");
  });

  it("renders inline edited rows from the turn summary when the file-change tool call has no filenames", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const assistantMessageId = MessageId.makeUnsafe("message-assistant-inline-summary-fallback");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-inline-summary-fallback",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-inline-summary-fallback",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "File Change",
              tone: "tool",
              requestKind: "file-change",
            },
          },
          {
            id: "entry-assistant-inline-summary-fallback",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:29.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId: TurnId.makeUnsafe("turn-inline-summary-fallback-1"),
                completedAt: "2026-03-17T19:12:30.000Z",
                assistantMessageId,
                files: [
                  {
                    path: "apps/web/src/components/chat/ProviderHealth.ts",
                    additions: 63,
                    deletions: 4,
                  },
                  {
                    path: "apps/web/src/components/ChatView.tsx",
                    additions: 41,
                    deletions: 5,
                  },
                ],
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
      />,
    );

    expect(markup).toContain("Edited");
    expect(markup).toContain("ProviderHealth.ts");
    expect(markup).toContain("ChatView.tsx");
    expect(markup).toContain("+63");
    expect(markup).toContain("-4");
    expect(markup).toContain("+41");
    expect(markup).toContain("-5");
    expect(markup).not.toContain(">File Change<");
  });

  it("renders a collapsible changed files header with ui-font filenames", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const assistantMessageId = MessageId.makeUnsafe("message-assistant-diff");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={[
          {
            id: "entry-assistant-diff",
            kind: "message",
            createdAt: "2026-03-17T19:12:29.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "done",
              createdAt: "2026-03-17T19:12:29.000Z",
              completedAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId: TurnId.makeUnsafe("turn-diff-1"),
                checkpointTurnCount: 1,
                checkpointTurnCounts: [1],
                checkpointRef: CheckpointRef.makeUnsafe("refs/synara/checkpoints/thread/turn/1"),
                status: "ready",
                completedAt: "2026-03-17T19:12:30.000Z",
                assistantMessageId,
                files: [
                  { path: "apps/web/src/components/Sidebar.tsx", additions: 6, deletions: 5 },
                ],
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
        onUndoTurnFiles={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );

    expect(markup).toContain("Edited 1 file");
    expect(markup).toContain("Undo");
    expect(markup).toContain("Review");
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("font-system-ui truncate font-normal");
    expect(markup).toContain("apps/web/src/components/Sidebar.tsx");
  });
});

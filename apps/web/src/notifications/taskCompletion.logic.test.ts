import { describe, expect, it } from "vitest";
import {
  ApprovalRequestId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import {
  buildInputNeededCopy,
  buildTaskCompletionCopy,
  collectCompletedThreadCandidates,
  collectInputNeededThreadCandidates,
  isNotificationRuntimeFreshTimestamp,
  shouldShowThreadNotificationToast,
} from "./taskCompletion.logic";
import type { Thread } from "../types";

function makeThread(overrides: Partial<Thread>): Thread {
  return {
    id: "thread-1" as ThreadId,
    codexThreadId: null,
    projectId: "project-1" as ProjectId,
    title: "Polish notifications",
    modelSelection: { provider: "codex", model: "gpt-5.4-mini" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: {
      provider: "codex",
      status: "running",
      orchestrationStatus: "running",
      createdAt: "2026-04-05T10:00:00.000Z",
      updatedAt: "2026-04-05T10:00:00.000Z",
    },
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-04-05T10:00:00.000Z",
    updatedAt: "2026-04-05T10:00:00.000Z",
    latestTurn: {
      turnId: TurnId.makeUnsafe("turn-1"),
      state: "running",
      requestedAt: "2026-04-05T10:00:00.000Z",
      startedAt: "2026-04-05T10:00:00.000Z",
      completedAt: null,
      assistantMessageId: null,
    },
    lastVisitedAt: "2026-04-05T10:00:00.000Z",
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

function buildCollectedTaskCompletionCopy(assistantText: string) {
  const completedAt = "2026-04-05T10:00:05.000Z";
  const candidates = collectCompletedThreadCandidates(
    [makeThread({})],
    [
      makeThread({
        session: {
          provider: "codex",
          status: "ready",
          orchestrationStatus: "ready",
          createdAt: "2026-04-05T10:00:00.000Z",
          updatedAt: completedAt,
        },
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-04-05T10:00:00.000Z",
          startedAt: "2026-04-05T10:00:00.000Z",
          completedAt,
          assistantMessageId: MessageId.makeUnsafe("msg-1"),
          sourceProposedPlan: undefined,
        },
        messages: [
          {
            id: MessageId.makeUnsafe("msg-1"),
            role: "assistant",
            text: assistantText,
            createdAt: "2026-04-05T10:00:01.000Z",
            completedAt,
            turnId: TurnId.makeUnsafe("turn-1"),
            streaming: false,
          },
        ],
      }),
    ],
  );
  const candidate = candidates[0];
  if (!candidate) {
    throw new Error("Expected a completed thread candidate");
  }
  return buildTaskCompletionCopy(candidate);
}

describe("collectCompletedThreadCandidates", () => {
  it("returns threads that moved from working to completed", () => {
    const previous = [
      makeThread({
        session: {
          provider: "codex",
          status: "running",
          orchestrationStatus: "running",
          createdAt: "2026-04-05T10:00:00.000Z",
          updatedAt: "2026-04-05T10:00:01.000Z",
        },
      }),
    ];
    const next = [
      makeThread({
        session: {
          provider: "codex",
          status: "ready",
          orchestrationStatus: "ready",
          createdAt: "2026-04-05T10:00:00.000Z",
          updatedAt: "2026-04-05T10:00:05.000Z",
        },
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-04-05T10:00:00.000Z",
          startedAt: "2026-04-05T10:00:00.000Z",
          completedAt: "2026-04-05T10:00:05.000Z",
          assistantMessageId: MessageId.makeUnsafe("msg-1"),
          sourceProposedPlan: undefined,
        },
        messages: [
          {
            id: MessageId.makeUnsafe("msg-1"),
            role: "assistant",
            text: "Finished the task and everything looks good.",
            createdAt: "2026-04-05T10:00:01.000Z",
            completedAt: "2026-04-05T10:00:05.000Z",
            streaming: false,
          },
        ],
      }),
    ];

    expect(collectCompletedThreadCandidates(previous, next)).toEqual([
      {
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Polish notifications",
        completedAt: "2026-04-05T10:00:05.000Z",
        assistantSummary: "Finished the task and everything looks good.",
      },
    ]);
  });

  it("summarizes the turn's final assistant message, not the opening preamble", () => {
    const previous = [makeThread({})];
    const next = [
      makeThread({
        session: {
          provider: "codex",
          status: "ready",
          orchestrationStatus: "ready",
          createdAt: "2026-04-05T10:00:00.000Z",
          updatedAt: "2026-04-05T10:00:06.000Z",
        },
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-04-05T10:00:00.000Z",
          startedAt: "2026-04-05T10:00:00.000Z",
          completedAt: "2026-04-05T10:00:06.000Z",
          assistantMessageId: MessageId.makeUnsafe("msg-final"),
          sourceProposedPlan: undefined,
        },
        messages: [
          {
            id: MessageId.makeUnsafe("msg-preamble"),
            role: "assistant",
            text: "Alright, I'll take the hint and start inspecting the work.",
            createdAt: "2026-04-05T10:00:01.000Z",
            completedAt: "2026-04-05T10:00:01.500Z",
            turnId: TurnId.makeUnsafe("turn-1"),
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("msg-final"),
            role: "assistant",
            text: "Done — separated the risky changes from the in-progress ones.",
            createdAt: "2026-04-05T10:00:05.500Z",
            completedAt: "2026-04-05T10:00:06.000Z",
            turnId: TurnId.makeUnsafe("turn-1"),
            streaming: false,
          },
        ],
      }),
    ];

    expect(collectCompletedThreadCandidates(previous, next)[0]?.assistantSummary).toBe(
      "Done — separated the risky changes from the in-progress ones.",
    );
  });

  it("falls back to the turn's last non-empty reply when the final message is still empty", () => {
    const previous = [makeThread({})];
    const next = [
      makeThread({
        session: {
          provider: "codex",
          status: "ready",
          orchestrationStatus: "ready",
          createdAt: "2026-04-05T10:00:00.000Z",
          updatedAt: "2026-04-05T10:00:06.000Z",
        },
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-04-05T10:00:00.000Z",
          startedAt: "2026-04-05T10:00:00.000Z",
          completedAt: "2026-04-05T10:00:06.000Z",
          assistantMessageId: MessageId.makeUnsafe("msg-final"),
          sourceProposedPlan: undefined,
        },
        messages: [
          {
            id: MessageId.makeUnsafe("msg-preamble"),
            role: "assistant",
            text: "Working on it now.",
            createdAt: "2026-04-05T10:00:01.000Z",
            completedAt: "2026-04-05T10:00:01.500Z",
            turnId: TurnId.makeUnsafe("turn-1"),
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("msg-final"),
            role: "assistant",
            text: "   ",
            createdAt: "2026-04-05T10:00:05.500Z",
            completedAt: "2026-04-05T10:00:06.000Z",
            turnId: TurnId.makeUnsafe("turn-1"),
            streaming: false,
          },
        ],
      }),
    ];

    expect(collectCompletedThreadCandidates(previous, next)[0]?.assistantSummary).toBe(
      "Working on it now.",
    );
  });

  it("does not reuse a legacy null-turn reply for a newer completed turn", () => {
    const previous = [makeThread({})];
    const next = [
      makeThread({
        session: {
          provider: "codex",
          status: "ready",
          orchestrationStatus: "ready",
          createdAt: "2026-04-05T10:00:00.000Z",
          updatedAt: "2026-04-05T10:00:06.000Z",
        },
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-2"),
          state: "completed",
          requestedAt: "2026-04-05T10:00:04.000Z",
          startedAt: "2026-04-05T10:00:04.000Z",
          completedAt: "2026-04-05T10:00:06.000Z",
          assistantMessageId: MessageId.makeUnsafe("msg-final"),
          sourceProposedPlan: undefined,
        },
        messages: [
          {
            id: MessageId.makeUnsafe("msg-legacy"),
            role: "assistant",
            text: "Stale answer from an imported turn.",
            createdAt: "2026-04-05T09:00:00.000Z",
            completedAt: "2026-04-05T09:00:01.000Z",
            streaming: false,
          },
          {
            id: MessageId.makeUnsafe("msg-final"),
            role: "assistant",
            text: "   ",
            createdAt: "2026-04-05T10:00:05.500Z",
            completedAt: "2026-04-05T10:00:06.000Z",
            turnId: TurnId.makeUnsafe("turn-2"),
            streaming: false,
          },
        ],
      }),
    ];

    const candidate = collectCompletedThreadCandidates(previous, next)[0];
    expect(candidate?.assistantSummary).toBeNull();
    expect(candidate && buildTaskCompletionCopy(candidate)).toEqual({
      title: "Polish notifications",
      body: "Finished working.",
    });
  });

  it("returns threads that settle after skipping the visible running-to-ready transition", () => {
    const previous = [
      makeThread({
        session: {
          provider: "codex",
          status: "ready",
          orchestrationStatus: "ready",
          activeTurnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-04-05T10:00:00.000Z",
          updatedAt: "2026-04-05T10:00:01.000Z",
        },
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "running",
          requestedAt: "2026-04-05T10:00:00.000Z",
          startedAt: "2026-04-05T10:00:00.000Z",
          completedAt: null,
          assistantMessageId: null,
          sourceProposedPlan: undefined,
        },
      }),
    ];
    const next = [
      makeThread({
        session: {
          provider: "codex",
          status: "ready",
          orchestrationStatus: "ready",
          createdAt: "2026-04-05T10:00:00.000Z",
          updatedAt: "2026-04-05T10:00:05.000Z",
        },
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-04-05T10:00:00.000Z",
          startedAt: "2026-04-05T10:00:00.000Z",
          completedAt: "2026-04-05T10:00:05.000Z",
          assistantMessageId: MessageId.makeUnsafe("msg-1"),
          sourceProposedPlan: undefined,
        },
        messages: [
          {
            id: MessageId.makeUnsafe("msg-1"),
            role: "assistant",
            text: "Done and verified.",
            createdAt: "2026-04-05T10:00:01.000Z",
            completedAt: "2026-04-05T10:00:05.000Z",
            streaming: false,
          },
        ],
      }),
    ];

    expect(collectCompletedThreadCandidates(previous, next)).toEqual([
      {
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Polish notifications",
        completedAt: "2026-04-05T10:00:05.000Z",
        assistantSummary: "Done and verified.",
      },
    ]);
  });

  it("does not notify while the same turn is still running after an assistant block completes", () => {
    const previous = [
      makeThread({
        session: {
          provider: "codex",
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-04-05T10:00:00.000Z",
          updatedAt: "2026-04-05T10:00:01.000Z",
        },
      }),
    ];
    const next = [
      makeThread({
        session: {
          provider: "codex",
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-04-05T10:00:00.000Z",
          updatedAt: "2026-04-05T10:00:05.000Z",
        },
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-04-05T10:00:00.000Z",
          startedAt: "2026-04-05T10:00:00.000Z",
          completedAt: "2026-04-05T10:00:05.000Z",
          assistantMessageId: MessageId.makeUnsafe("msg-1"),
          sourceProposedPlan: undefined,
        },
        messages: [
          {
            id: MessageId.makeUnsafe("msg-1"),
            role: "assistant",
            text: "First block is done.",
            createdAt: "2026-04-05T10:00:01.000Z",
            completedAt: "2026-04-05T10:00:05.000Z",
            streaming: false,
          },
        ],
      }),
    ];

    expect(collectCompletedThreadCandidates(previous, next)).toEqual([]);
  });

  it("notifies once when the same completed turn later settles via session idle", () => {
    const previous = [
      makeThread({
        session: {
          provider: "codex",
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-04-05T10:00:00.000Z",
          updatedAt: "2026-04-05T10:00:05.000Z",
        },
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-04-05T10:00:00.000Z",
          startedAt: "2026-04-05T10:00:00.000Z",
          completedAt: "2026-04-05T10:00:05.000Z",
          assistantMessageId: MessageId.makeUnsafe("msg-1"),
          sourceProposedPlan: undefined,
        },
        messages: [
          {
            id: MessageId.makeUnsafe("msg-1"),
            role: "assistant",
            text: "First block is done.",
            createdAt: "2026-04-05T10:00:01.000Z",
            completedAt: "2026-04-05T10:00:05.000Z",
            streaming: false,
          },
        ],
      }),
    ];
    const next = [
      makeThread({
        session: {
          provider: "codex",
          status: "ready",
          orchestrationStatus: "ready",
          createdAt: "2026-04-05T10:00:00.000Z",
          updatedAt: "2026-04-05T10:00:06.000Z",
        },
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-04-05T10:00:00.000Z",
          startedAt: "2026-04-05T10:00:00.000Z",
          completedAt: "2026-04-05T10:00:05.000Z",
          assistantMessageId: MessageId.makeUnsafe("msg-1"),
          sourceProposedPlan: undefined,
        },
        messages: [
          {
            id: MessageId.makeUnsafe("msg-1"),
            role: "assistant",
            text: "First block is done.",
            createdAt: "2026-04-05T10:00:01.000Z",
            completedAt: "2026-04-05T10:00:05.000Z",
            streaming: false,
          },
        ],
      }),
    ];

    expect(collectCompletedThreadCandidates(previous, next)).toEqual([
      {
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Polish notifications",
        completedAt: "2026-04-05T10:00:05.000Z",
        assistantSummary: "First block is done.",
      },
    ]);
  });

  it("ignores initial hydrated threads and non-completion updates", () => {
    const previous = [makeThread({ session: null })];
    const next = [
      makeThread({
        session: {
          provider: "codex",
          status: "ready",
          orchestrationStatus: "ready",
          createdAt: "2026-04-05T10:00:00.000Z",
          updatedAt: "2026-04-05T10:00:05.000Z",
        },
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-04-05T10:00:00.000Z",
          startedAt: "2026-04-05T10:00:00.000Z",
          completedAt: "2026-04-05T10:00:05.000Z",
          assistantMessageId: null,
          sourceProposedPlan: undefined,
        },
      }),
    ];

    expect(collectCompletedThreadCandidates(previous, next)).toEqual([]);
  });
});

describe("shouldShowThreadNotificationToast", () => {
  it("hides in-app task notifications for already-visible threads", () => {
    expect(
      shouldShowThreadNotificationToast({
        threadId: ThreadId.makeUnsafe("thread-1"),
        visibleThreadIds: new Set([ThreadId.makeUnsafe("thread-1")]),
      }),
    ).toBe(false);
  });

  it("shows in-app task notifications for off-screen threads", () => {
    expect(
      shouldShowThreadNotificationToast({
        threadId: ThreadId.makeUnsafe("thread-2"),
        visibleThreadIds: new Set([ThreadId.makeUnsafe("thread-1")]),
      }),
    ).toBe(true);
  });
});

describe("buildTaskCompletionCopy", () => {
  it("prefers assistant output when available", () => {
    expect(
      buildCollectedTaskCompletionCopy("Finished the task and everything looks good."),
    ).toEqual({
      title: "Polish notifications",
      body: "Finished the task and everything looks good.",
    });
  });

  it("keeps compact context while stripping assistant Markdown", () => {
    expect(
      buildCollectedTaskCompletionCopy(
        "Sì, esattamente così:\n- menu principale con `Model`, **Effort** e Speed\n- slider dentro [Advanced](https://example.com)",
      ),
    ).toEqual({
      title: "Polish notifications",
      body: "Sì, esattamente così: · menu principale con Model, Effort e Speed · slider dentro Advanced",
    });
  });

  it("preserves technical underscores and cleans an unclosed code fence", () => {
    expect(
      buildCollectedTaskCompletionCopy(
        "Updated `apps/web/src/foo_bar.ts`.\n```ts\nconst result_value = true;",
      ),
    ).toEqual({
      title: "Polish notifications",
      body: "Updated apps/web/src/foo_bar.ts. const result_value = true;",
    });
  });

  it("preserves useful content inside a closed code fence", () => {
    expect(buildCollectedTaskCompletionCopy('Result:\n```json\n{"status":"ok"}\n```')).toEqual({
      title: "Polish notifications",
      body: 'Result: {"status":"ok"}',
    });
  });

  it("does not reinterpret Markdown-shaped syntax inside fenced code", () => {
    expect(
      buildCollectedTaskCompletionCopy(
        "Result:\n```python\ndef __init__(self):\n  return x - y\n```",
      ),
    ).toEqual({
      title: "Polish notifications",
      body: "Result: def __init__(self): return x - y",
    });
  });

  it.each([
    ["four-backtick", "Result:\n````python\ndef __init__(self):\n  return x * y * z\n````"],
    ["tilde", "Result:\n~~~python\ndef __init__(self):\n  return x * y * z\n~~~"],
  ])("preserves Markdown-shaped syntax inside a %s fence", (_label, assistantText) => {
    expect(buildCollectedTaskCompletionCopy(assistantText)).toEqual({
      title: "Polish notifications",
      body: "Result: def __init__(self): return x * y * z",
    });
  });

  it("recognizes CRLF fenced blocks without swallowing following prose", () => {
    expect(
      buildCollectedTaskCompletionCopy(
        "Result:\r\n```ts\r\nconst foo__bar__ = true;\r\n```\r\n**Done**",
      ),
    ).toEqual({
      title: "Polish notifications",
      body: "Result: const foo__bar__ = true; Done",
    });
  });

  it("only normalizes list markers at the start of a line", () => {
    expect(buildCollectedTaskCompletionCopy("Computed 7 * 6 = 42; auth - tests pass.")).toEqual({
      title: "Polish notifications",
      body: "Computed 7 * 6 = 42; auth - tests pass.",
    });
  });

  it("preserves spaced multiplication operators", () => {
    expect(buildCollectedTaskCompletionCopy("Computed 2 * 3 * 4 = 24.")).toEqual({
      title: "Polish notifications",
      body: "Computed 2 * 3 * 4 = 24.",
    });
  });

  it("removes GFM task-list markers with their list prefix", () => {
    expect(buildCollectedTaskCompletionCopy("- [x] Tests passed\n- [ ] Release pending")).toEqual({
      title: "Polish notifications",
      body: "· Tests passed · Release pending",
    });
  });

  it("preserves numeric prefixes longer than Markdown ordered-list markers", () => {
    expect(buildCollectedTaskCompletionCopy("1234567890. tests passed")).toEqual({
      title: "Polish notifications",
      body: "1234567890. tests passed",
    });
  });

  it("consumes balanced parentheses in Markdown link destinations", () => {
    expect(
      buildCollectedTaskCompletionCopy("Read the [docs](https://example.com/a_(b)) for details."),
    ).toEqual({
      title: "Polish notifications",
      body: "Read the docs for details.",
    });
  });

  it.each([
    ["full", "Read [the guide][docs].\n[docs]: https://example.com", "Read the guide."],
    ["collapsed", "Read [the guide][].\n[the guide]: https://example.com", "Read the guide."],
    ["shortcut", "Read [docs].\n[docs]: https://example.com", "Read docs."],
  ])("strips %s reference links and their definitions", (_label, assistantText, expectedBody) => {
    expect(buildCollectedTaskCompletionCopy(assistantText)).toEqual({
      title: "Polish notifications",
      body: expectedBody,
    });
  });

  it("preserves bracketed status text that is not a valid reference definition", () => {
    expect(buildCollectedTaskCompletionCopy("[status]: all tests passed")).toEqual({
      title: "Polish notifications",
      body: "[status]: all tests passed",
    });
  });

  it("handles bracket-heavy generated output without recursive rescanning", () => {
    expect(buildCollectedTaskCompletionCopy("[".repeat(16_000))).toEqual({
      title: "Polish notifications",
      body: `${"[".repeat(119)}…`,
    });
  });

  it("keeps separate triple-backtick inline spans independent", () => {
    expect(buildCollectedTaskCompletionCopy("Use ```foo``` now.\nThen ```bar``` next.")).toEqual({
      title: "Polish notifications",
      body: "Use foo now. Then bar next.",
    });
  });

  it("preserves shorter backtick runs inside multi-backtick code spans", () => {
    expect(buildCollectedTaskCompletionCopy("Use ``foo ` bar`` now.")).toEqual({
      title: "Polish notifications",
      body: "Use foo ` bar now.",
    });
  });

  it("preserves Markdown-shaped syntax inside code spans that cross line breaks", () => {
    expect(buildCollectedTaskCompletionCopy("Use `foo\n__bar__` now.")).toEqual({
      title: "Polish notifications",
      body: "Use foo __bar__ now.",
    });
  });

  it("does not strip underscores from inline code identifiers", () => {
    expect(buildCollectedTaskCompletionCopy("Updated `__init__.py` and `foo__bar__`.")).toEqual({
      title: "Polish notifications",
      body: "Updated __init__.py and foo__bar__.",
    });
  });

  it("does not treat intraword double underscores as emphasis", () => {
    expect(buildCollectedTaskCompletionCopy("Updated foo__bar__ successfully.")).toEqual({
      title: "Polish notifications",
      body: "Updated foo__bar__ successfully.",
    });
  });

  it("does not treat double underscores beside Unicode identifier characters as emphasis", () => {
    expect(buildCollectedTaskCompletionCopy("Updated café__menu__ and 变量__名称__.")).toEqual({
      title: "Polish notifications",
      body: "Updated café__menu__ and 变量__名称__.",
    });
  });

  it("renders escaped Markdown punctuation literally", () => {
    expect(
      buildCollectedTaskCompletionCopy("Use \\*literal\\*, \\_name\\_, and \\[raw\\]."),
    ).toEqual({
      title: "Polish notifications",
      body: "Use *literal*, _name_, and [raw].",
    });
  });

  it.each([
    [
      "blockquote",
      "Result:\n> ```python\n> def __init__(self):\n>   return value\n> ```",
      "Result: def __init__(self): return value",
    ],
    [
      "list",
      "Result:\n- ```python\n  def __init__(self):\n  return value\n  ```",
      "Result: def __init__(self): return value",
    ],
    [
      "ordered list",
      "Result:\n10. ```python\n    def __init__(self):\n    return value\n    ```\n**Done**",
      "Result: def __init__(self): return value Done",
    ],
    [
      "ordered list with an over-indented fence-like code line",
      "Result:\n10. ```python\n    def __init__(self):\n        ```\n    return value\n    ```\n**Done**",
      "Result: def __init__(self): ``` return value Done",
    ],
  ])(
    "preserves Markdown-shaped syntax inside a fence nested in a %s",
    (_label, assistantText, expectedBody) => {
      expect(buildCollectedTaskCompletionCopy(assistantText)).toEqual({
        title: "Polish notifications",
        body: expectedBody,
      });
    },
  );

  it.each([
    ["blockquote", "Result:\n> ```\n> code\n\n**Done**"],
    ["list", "Result:\n- ```\n  code\n\n**Done**"],
  ])("stops an unclosed fence at its %s container boundary", (_label, assistantText) => {
    expect(buildCollectedTaskCompletionCopy(assistantText)).toEqual({
      title: "Polish notifications",
      body: "Result: code Done",
    });
  });
});

describe("collectInputNeededThreadCandidates", () => {
  it("returns threads with newly opened approval requests", () => {
    const previous = [makeThread({ activities: [] })];
    const next = [
      makeThread({
        activities: [
          {
            id: EventId.makeUnsafe("activity-approval-1"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Command approval requested",
            payload: {
              requestId: "approval-request-1",
              requestKind: "command",
            },
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-04-05T10:00:04.000Z",
          },
        ],
      }),
    ];

    expect(collectInputNeededThreadCandidates(previous, next)).toEqual([
      {
        kind: "approval",
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Polish notifications",
        createdAt: "2026-04-05T10:00:04.000Z",
        requestId: ApprovalRequestId.makeUnsafe("approval-request-1"),
        requestKind: "command",
      },
    ]);
  });

  it("returns threads with newly opened user-input requests", () => {
    const previous = [makeThread({ activities: [] })];
    const next = [
      makeThread({
        activities: [
          {
            id: EventId.makeUnsafe("activity-user-input-1"),
            tone: "info",
            kind: "user-input.requested",
            summary: "User input requested",
            payload: {
              requestId: "user-input-request-1",
              questions: [
                {
                  id: "question-1",
                  header: "Question",
                  question: "Continue?",
                  options: [
                    { label: "Yes", description: "Continue" },
                    { label: "No", description: "Stop" },
                  ],
                },
              ],
            },
            turnId: TurnId.makeUnsafe("turn-1"),
            createdAt: "2026-04-05T10:00:06.000Z",
          },
        ],
      }),
    ];

    expect(collectInputNeededThreadCandidates(previous, next)).toEqual([
      {
        kind: "user-input",
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Polish notifications",
        createdAt: "2026-04-05T10:00:06.000Z",
        requestId: ApprovalRequestId.makeUnsafe("user-input-request-1"),
      },
    ]);
  });

  it("ignores already-open requests from the previous snapshot", () => {
    const activities = [
      {
        id: EventId.makeUnsafe("activity-approval-1"),
        tone: "approval" as const,
        kind: "approval.requested",
        summary: "Command approval requested",
        payload: {
          requestId: "approval-request-1",
          requestKind: "command",
        },
        turnId: TurnId.makeUnsafe("turn-1"),
        createdAt: "2026-04-05T10:00:04.000Z",
      },
    ];

    expect(
      collectInputNeededThreadCandidates(
        [makeThread({ activities })],
        [makeThread({ activities })],
      ),
    ).toEqual([]);
  });
});

describe("buildInputNeededCopy", () => {
  it("describes approvals succinctly", () => {
    expect(
      buildInputNeededCopy({
        kind: "approval",
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Polish notifications",
        createdAt: "2026-04-05T10:00:04.000Z",
        requestId: ApprovalRequestId.makeUnsafe("approval-request-1"),
        requestKind: "command",
      }),
    ).toEqual({
      title: "Input needed",
      body: "Polish notifications: Command approval requested.",
    });
  });

  it("describes user-input requests succinctly", () => {
    expect(
      buildInputNeededCopy({
        kind: "user-input",
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Polish notifications",
        createdAt: "2026-04-05T10:00:06.000Z",
        requestId: ApprovalRequestId.makeUnsafe("user-input-request-1"),
      }),
    ).toEqual({
      title: "Input needed",
      body: "Polish notifications: User input requested.",
    });
  });
});

describe("isNotificationRuntimeFreshTimestamp", () => {
  it("suppresses hydrated notifications from before the notification runtime mounted", () => {
    const runtimeStartedAtMs = Date.parse("2026-04-05T10:00:10.000Z");

    expect(
      isNotificationRuntimeFreshTimestamp("2026-04-05T10:00:05.000Z", runtimeStartedAtMs),
    ).toBe(false);
  });

  it("allows live notifications created after the notification runtime mounted", () => {
    const runtimeStartedAtMs = Date.parse("2026-04-05T10:00:10.000Z");

    expect(
      isNotificationRuntimeFreshTimestamp("2026-04-05T10:00:11.000Z", runtimeStartedAtMs),
    ).toBe(true);
  });
});

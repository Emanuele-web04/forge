// FILE: KanbanProjectBoardView.browser.tsx
// Purpose: Real-chromium render of the v2 attention-first board over seeded state.
import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

vi.mock("~/appSettings", () => ({
  useAppSettings: () => ({
    settings: {
      defaultProvider: "codex",
      sidebarProjectSortOrder: "manual",
      kanbanProviderStartOptions: [],
    },
    setSetting: vi.fn(),
  }),
  getProviderStartOptions: () => [],
  resolveAssistantDeliveryMode: () => "default",
}));
vi.mock("~/hooks/useProviderStatusesForLocalConfig", () => ({
  useProviderStatusesForLocalConfig: () => [],
}));
vi.mock("~/hooks/useProviderStatusRefresh", () => ({
  useRefreshProviderStatusesNow: () => () => undefined,
}));
vi.mock("../../lib/kanbanDispatch", () => ({
  dispatchKanbanDraftCard: vi.fn().mockResolvedValue({ ok: true }),
}));

import type { ThreadId } from "@synara/contracts";
import { KANBAN_ATTENTION_LABELS, KANBAN_COLUMN_V2_LABELS } from "@synara/shared/kanban";
import { KanbanProjectBoardView } from "./KanbanProjectBoardView";
import type { KanbanCard, KanbanProjectBoard } from "./kanban.logic";

const NOW_MS = Date.parse("2026-08-21T12:00:00.000Z");
const NOW_ISO = new Date(NOW_MS).toISOString();

function makeCard(
  id: string,
  column: KanbanCard["column"],
  overrides?: Partial<KanbanCard>,
): KanbanCard {
  return {
    cardId: `thread:${id}`,
    threadId: id as ThreadId,
    projectId: "project-1" as KanbanCard["projectId"],
    column,
    title: `Card ${id}`,
    provider: "codex",
    isTerminal: false,
    branch: null,
    envMode: null,
    worktreePath: null,
    thread: null,
    draftPrompt: "",
    draftHasAttachments: false,
    sortTimestamp: NOW_MS,
    timestamp: NOW_ISO,
    activeWorkStartedAt: column === "inProgress" ? NOW_ISO : null,
    isOptimisticDispatch: false,
    ...(overrides ?? {}),
  };
}

const board: KanbanProjectBoard = {
  projectId: "project-1" as KanbanProjectBoard["projectId"],
  projectName: "Demo",
  projectKind: "project",
  draft: [makeCard("draft-1", "draft")],
  inProgress: [makeCard("live-1", "inProgress")],
  awaitingYou: [
    makeCard("awaiting-1", "awaitingYou", {
      attention: ["awaiting-approval"],
      needsReview: true,
    }),
  ],
  done: [makeCard("done-1", "done")],
  totalCount: 4,
  hiddenCount: 0,
};

describe("KanbanProjectBoardView v2 (browser)", () => {
  it("renders the four-column attention-first layout with pills and filter", async () => {
    await render(
      <KanbanProjectBoardView
        board={board}
        onOpenCard={vi.fn()}
        onNewTask={vi.fn()}
        prByThreadId={new Map()}
        nowMs={NOW_MS}
        viewMode="v2"
      />,
    );

    for (const label of Object.values(KANBAN_COLUMN_V2_LABELS)) {
      await expect.element(page.getByRole("heading", { name: label })).toBeVisible();
    }
    for (const cardTitle of ["Card draft-1", "Card live-1", "Card awaiting-1", "Card done-1"]) {
      await expect.element(page.getByText(cardTitle)).toBeVisible();
    }
    await expect
      .element(page.getByText(KANBAN_ATTENTION_LABELS["awaiting-approval"]))
      .toBeVisible();
    await expect.element(page.getByText("Needs review")).toBeVisible();
  });

  it("keeps classic mode at three columns without the awaiting-you column", async () => {
    const { unmount } = await render(
      <KanbanProjectBoardView
        board={{ ...board, awaitingYou: [] }}
        onOpenCard={vi.fn()}
        onNewTask={vi.fn()}
        prByThreadId={new Map()}
        nowMs={NOW_MS}
        viewMode="classic"
      />,
    );

    await expect
      .element(page.getByRole("heading", { name: KANBAN_COLUMN_V2_LABELS.draft }))
      .toBeVisible();
    await expect
      .element(page.getByRole("heading", { name: KANBAN_COLUMN_V2_LABELS.inProgress }))
      .toBeVisible();
    await expect
      .element(page.getByRole("heading", { name: KANBAN_COLUMN_V2_LABELS.done }))
      .toBeVisible();
    expect(document.body.textContent).not.toContain(KANBAN_COLUMN_V2_LABELS.awaitingYou);
    await unmount();
  });
});

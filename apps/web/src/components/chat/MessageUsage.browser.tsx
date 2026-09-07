import "../../index.css";

import { EventId, MessageId, TurnId, type OrchestrationThreadActivity } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { deriveConversationUsage, deriveMessageUsageByTurnId } from "~/lib/messageUsage";
import { MessageUsage } from "./MessageUsage";
import { MessagesTimeline } from "./MessagesTimeline";
import type { TimelineEntry } from "../../session-logic";

const turnId = TurnId.makeUnsafe("usage-turn");
const assistant: TimelineEntry = {
  id: "reply",
  kind: "message",
  createdAt: "2026-09-05T00:00:00.000Z",
  message: {
    id: MessageId.makeUnsafe("reply"),
    role: "assistant",
    text: "The changes are ready for testing.",
    turnId,
    createdAt: "2026-09-05T00:00:00.000Z",
    streaming: false,
  },
};
function fixture(outputTokens: number): OrchestrationThreadActivity[] {
  return [
    {
      id: EventId.makeUnsafe("usage"),
      tone: "info",
      kind: "context-window.updated",
      summary: "Usage",
      turnId,
      createdAt: "2026-09-05T00:00:01.000Z",
      payload: {
        provider: "codex",
        usedTokens: 100_000,
        maxTokens: 256_000,
        inputTokens: 90_000,
        outputTokens,
        cachedInputTokens: 81_000,
        reasoningOutputTokens: 300,
        compactsAutomatically: true,
      },
    },
  ];
}
function Timeline({ output, live = false }: { output: number; live?: boolean }) {
  return (
    <div style={{ width: 360, height: 600 }}>
      <MessagesTimeline
        hasMessages
        isWorking={live}
        activeTurnInProgress={live}
        activeTurnStartedAt={live ? "2026-09-05T00:00:00.000Z" : null}
        activeTurnId={live ? turnId : null}
        timelineEntries={[assistant]}
        usageByTurnId={deriveMessageUsageByTurnId(fixture(output))}
        turnDiffSummaryByAssistantMessageId={new Map()}
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
    </div>
  );
}

describe("message usage footer", () => {
  it("renders in the timeline, updates when only usage changes and opens details", async () => {
    const screen = await render(<Timeline output={1000} />);
    const button = screen.getByRole("button", { name: "Message usage details" });
    await expect.element(button).toBeVisible();
    await expect.element(button).toHaveTextContent("1k");
    await screen.rerender(<Timeline output={2000} />);
    await expect.element(button).toHaveTextContent("2k");
    await button.click();
    await expect.element(screen.getByText("Turn usage")).toBeVisible();
    const element = document.querySelector('[aria-label="Message usage details"]')!;
    expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth);
  });
  it("uses the same compact notation for conversation totals at narrow widths", async () => {
    const metrics = deriveMessageUsageByTurnId(fixture(1000)).get(turnId)!;
    const screen = await render(
      <div style={{ width: 280 }}>
        <MessageUsage scope="conversation" metrics={metrics} />
      </div>,
    );
    const button = screen.getByRole("button", { name: "Conversation usage details" });
    await expect
      .element(button)
      .toHaveTextContent(/↑\s*90k\s*·\s*↓\s*1k\s*·\s*R\s*81k\s*·\s*W\s*—\s*·\s*CH\s*90\.0%/);
    await button.click();
    await expect.element(screen.getByText("Conversation usage", { exact: true })).toBeVisible();
    const element = document.querySelector('[aria-label="Conversation usage details"]')!;
    expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth);
  });
  it("does not show the footer during an active turn", async () => {
    const screen = await render(<Timeline output={1000} live />);
    await expect
      .element(screen.getByRole("button", { name: "Message usage details" }))
      .not.toBeInTheDocument();
  });
});

it("shows turn TPS with units and its wall-time explanation at narrow widths", async () => {
  const usage = deriveConversationUsage(
    [
      {
        ...fixture(1000)[0]!,
        kind: "turn.completed",
        payload: {
          provider: "antigravity",
          usage: { inputTokens: 2000, outputTokens: 25 },
        },
      },
    ],
    [
      { role: "user", createdAt: "2026-09-05T00:00:00.000Z" },
      { role: "assistant", turnId, createdAt: "2026-09-05T00:00:00.500Z" },
    ],
  );
  const screen = await render(
    <div style={{ width: 280 }}>
      <MessageUsage metrics={usage.byTurnId.get(turnId)!} />
    </div>,
  );
  const button = screen.getByRole("button", { name: "Message usage details" });
  await expect.element(button).toHaveTextContent(/TPS\s*25\.0 tok\/s/);
  const element = document.querySelector('[aria-label="Message usage details"]')!;
  expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth);
  await button.click();
  await expect
    .element(
      screen.getByText("TPS = output ÷ turn wall time, including thinking, tools and waiting."),
    )
    .toBeVisible();
});

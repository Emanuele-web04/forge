// FILE: handoff.test.ts
// Purpose: Verifies bootstrap transcripts stay within the replay char budget.
// Layer: Orchestration mapping tests
// Depends on: handoff.

import { MessageId, type OrchestrationMessage } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  buildHandoffDurableStateUpdate,
  buildPriorTranscriptBootstrapText,
} from "./handoff.ts";

const message = (
  index: number,
  role: "user" | "assistant",
  text: string,
): OrchestrationMessage => ({
  id: MessageId.makeUnsafe(`message-${index}`),
  role,
  text,
  turnId: null,
  streaming: false,
  source: "native",
  createdAt: "2026-07-08T00:00:00.000Z",
  updatedAt: "2026-07-08T00:00:00.000Z",
});

const thread = (messages: ReadonlyArray<OrchestrationMessage>) => ({
  title: "Budgeted thread",
  branch: null,
  worktreePath: null,
  messages,
});

describe("buildPriorTranscriptBootstrapText", () => {
  it("injects durable notes when a restarted provider has no prior transcript", () => {
    const text = buildPriorTranscriptBootstrapText(
      { ...thread([]), notes: "Resume from the verified service install." },
      undefined,
    );

    expect(text).toContain("Durable Synara task state follows");
    expect(text).toContain("Resume from the verified service install.");
  });

  it("keeps every message with a plain summary header when under budget", () => {
    const messages = Array.from({ length: 10 }, (_, index) =>
      message(index, index % 2 === 0 ? "user" : "assistant", `marker-${index} short message`),
    );
    const text = buildPriorTranscriptBootstrapText(thread(messages), "message-9");

    expect(text).not.toBeNull();
    expect(text).toContain("Earlier conversation summary:");
    expect(text).not.toContain("omitted to fit the context budget");
    for (let index = 0; index < 9; index += 1) {
      expect(text).toContain(`marker-${index}`);
    }
  });

  it("drops the oldest summaries and notes the omission when over budget", () => {
    const filler = "x".repeat(400);
    const messages = Array.from({ length: 301 }, (_, index) =>
      message(index, index % 2 === 0 ? "user" : "assistant", `marker-${index} ${filler}`),
    );
    const text = buildPriorTranscriptBootstrapText(thread(messages), "message-300");

    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThanOrEqual(32_000);
    expect(text).toContain("omitted to fit the context budget");
    // The most recent messages survive verbatim; the oldest summaries are gone.
    expect(text).toContain("marker-299");
    expect(text).toContain("marker-294");
    expect(text).not.toContain("marker-0 ");
    expect(text).not.toContain("marker-1 ");
    // Kept summaries stay in chronological order.
    expect(text!.indexOf("marker-250")).toBeLessThan(text!.indexOf("marker-290"));
  });

  it("respects a caller budget smaller than the transcript ceiling", () => {
    const filler = "y".repeat(400);
    const messages = Array.from({ length: 60 }, (_, index) =>
      message(index, index % 2 === 0 ? "user" : "assistant", `marker-${index} ${filler}`),
    );
    const text = buildPriorTranscriptBootstrapText(thread(messages), "message-59", 8_000);

    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThanOrEqual(8_000);
    expect(text).toContain("marker-58");
  });

  it("never lets the omission header push the newest message past the budget", () => {
    // Adversarial tight budget: without reserving room for the "Earlier
    // conversation summary (...) omitted..." header before selecting
    // summary lines, the budget accountant lets summary lines fill the
    // entire remaining allowance, then tacks the header on top -- pushing
    // the assembled text past maxChars. The final truncateText clips from
    // the end, which is the recent-messages section, so the newest message
    // (the one newest-first retention exists to protect) gets clipped
    // instead of an older summary line.
    const earlierMessages = Array.from({ length: 5 }, (_, index) =>
      message(index, index % 2 === 0 ? "user" : "assistant", `EARLY-${index} ${"e".repeat(60)}`),
    );
    const recentPlainMessages = Array.from({ length: 5 }, (_, index) =>
      message(5 + index, index % 2 === 0 ? "user" : "assistant", `plain-recent-${index}`),
    );
    const newestMessage = message(
      10,
      "assistant",
      `NEWEST-START ${"r".repeat(10)} NEWEST-END-UNIQUE-MARKER`,
    );
    const currentMessage = message(11, "user", "current turn");
    const messages = [...earlierMessages, ...recentPlainMessages, newestMessage, currentMessage];

    const text = buildPriorTranscriptBootstrapText(thread(messages), "message-11", 600);

    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThanOrEqual(600);
    // The newest message must survive intact, including its trailing marker
    // -- if the header overflow clips the tail, this substring is the first
    // casualty.
    expect(text).toContain("NEWEST-START");
    expect(text).toContain("NEWEST-END-UNIQUE-MARKER");
    expect(text).toContain("omitted to fit the context budget");
  });

  it("reserves header budget correctly when the omitted count reaches three digits", () => {
    const filler = "z".repeat(40);
    const earlierMessages = Array.from({ length: 150 }, (_, index) =>
      message(index, index % 2 === 0 ? "user" : "assistant", `EARLY-${index} ${filler}`),
    );
    const recentPlainMessages = Array.from({ length: 5 }, (_, index) =>
      message(150 + index, index % 2 === 0 ? "user" : "assistant", `plain-recent-${index}`),
    );
    const newestMessage = message(
      155,
      "assistant",
      `NEWEST-START ${"r".repeat(10)} NEWEST-END-UNIQUE-MARKER`,
    );
    const currentMessage = message(156, "user", "current turn");
    const messages = [...earlierMessages, ...recentPlainMessages, newestMessage, currentMessage];

    const text = buildPriorTranscriptBootstrapText(thread(messages), "message-156", 1_600);

    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThanOrEqual(1_600);
    expect(text).toMatch(/\(\d{3,} older messages omitted to fit the context budget\):/);
    expect(text).toContain("NEWEST-START");
    expect(text).toContain("NEWEST-END-UNIQUE-MARKER");
  });
});

describe("buildHandoffDurableStateUpdate", () => {
  it("copies task metadata and remaps pins to imported message ids", () => {
    const sourceMessage = message(1, "assistant", "Keep this decision");
    const update = buildHandoffDurableStateUpdate({
      sourceThread: {
        messages: [sourceMessage],
        notes: "Use the existing backend.",
        goal: "Finish Android access",
        goalStartedAt: "2026-07-08T01:00:00.000Z",
        goalAchievements: [
          {
            goal: "Choose the remote architecture",
            achievedAt: "2026-07-08T00:55:00.000Z",
            elapsedMs: 1_000,
            turnId: "source-turn-1" as never,
          },
        ],
        pinnedMessages: [
          {
            messageId: sourceMessage.id,
            label: "Decision",
            done: false,
            pinnedAt: "2026-07-08T01:05:00.000Z",
          },
        ],
      },
      importedMessages: [
        {
          messageId: MessageId.makeUnsafe("imported-message-1"),
          role: sourceMessage.role as "assistant",
          text: sourceMessage.text,
          createdAt: sourceMessage.createdAt,
          updatedAt: sourceMessage.updatedAt,
        },
      ],
    });

    expect(update).toMatchObject({
      notes: "Use the existing backend.",
      goal: "Finish Android access",
      goalStartedAt: "2026-07-08T01:00:00.000Z",
      goalAchievements: [{ goal: "Choose the remote architecture", turnId: null }],
      pinnedMessages: [{ messageId: "imported-message-1", label: "Decision" }],
    });
  });
});

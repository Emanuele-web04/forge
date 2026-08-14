import { describe, expect, it } from "vitest";
import {
  buildFeedbackSubmission,
  FEEDBACK_CATEGORIES,
  formatFeedbackSummary,
  type FeedbackDiagnostics,
  type FeedbackThreadContext,
} from "./feedback";

const CONTEXT: FeedbackThreadContext = {
  provider: "codex",
  model: "gpt-5.6-sol",
  projectKind: "project",
  environmentMode: "worktree",
  runtimeMode: "full-access",
  interactionMode: "default",
  sessionStatus: "running",
  latestTurnState: "error",
  messageCount: 12,
  activityCount: 8,
  hasPendingApproval: false,
  hasPendingUserInput: true,
  hasThreadError: true,
};

const DIAGNOSTICS: FeedbackDiagnostics = {
  ...CONTEXT,
  appVersion: "0.5.1",
  submittedAt: "2026-07-15T18:00:00.000Z",
  userAgent: "Synara test agent",
  platform: "MacIntel",
  language: "en-US",
  viewport: "1440x900",
};

describe("formatFeedbackSummary", () => {
  it("opens in the reporter's voice and lists the diagnostics a maintainer needs", () => {
    const summary = formatFeedbackSummary({
      category: "bug",
      diagnostics: DIAGNOSTICS,
    });

    expect(summary).toBe(
      [
        "I ran into a bug in Synara 0.5.1, using codex with gpt-5.6-sol.",
        "",
        "Report type: Bug",
        "App version: 0.5.1",
        "Provider: codex",
        "Model: gpt-5.6-sol",
        "Project kind: project",
        "Environment mode: worktree",
        "Runtime mode: full-access",
        "Interaction mode: default",
        "Session status: running",
        "Latest turn state: error",
        "Thread size: 12 messages, 8 activities",
        "At submission: the thread was in an error state, the agent was waiting for input.",
        "Platform: MacIntel, viewport 1440x900",
        "Language: en-US",
        "User agent: Synara test agent",
        "Submitted at: 2026-07-15T18:00:00.000Z",
      ].join("\n"),
    );
  });

  it("falls back to a neutral opening and omits fields the session never set", () => {
    const summary = formatFeedbackSummary({
      category: null,
      diagnostics: {
        ...DIAGNOSTICS,
        projectKind: null,
        environmentMode: null,
        sessionStatus: null,
        latestTurnState: null,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        hasThreadError: false,
      },
    });

    expect(summary).toContain(
      "I have some feedback in Synara 0.5.1, using codex with gpt-5.6-sol.",
    );
    expect(summary).toContain("Report type: Unspecified");
    expect(summary).toContain("At submission: nothing pending.");
    expect(summary).not.toContain("Screenshot:");
    expect(summary).not.toContain("Project kind:");
    expect(summary).not.toContain("Session status:");
  });

  it.each(FEEDBACK_CATEGORIES)(
    "routes the $label report with its own opening line",
    ({ value, label, lead }) => {
      const summary = formatFeedbackSummary({ category: value, diagnostics: DIAGNOSTICS });

      expect(summary.startsWith(`${lead} in Synara 0.5.1`)).toBe(true);
      expect(summary).toContain(`Report type: ${label}`);
    },
  );

  it("describes feedback sent outside an active chat without inventing provider context", () => {
    const summary = formatFeedbackSummary({
      category: "other",
      diagnostics: {
        ...DIAGNOSTICS,
        provider: null,
        model: null,
        projectKind: null,
        environmentMode: null,
        runtimeMode: null,
        interactionMode: null,
        sessionStatus: null,
        latestTurnState: null,
      },
    });

    expect(summary).toContain("I have some feedback in Synara 0.5.1 outside an active chat.");
    expect(summary).not.toContain("Provider:");
    expect(summary).not.toContain("Model:");
  });
});

describe("buildFeedbackSubmission", () => {
  it("adds useful runtime diagnostics without adding project or conversation content", () => {
    const submission = buildFeedbackSubmission({
      category: "bug",
      details: "  The composer stopped responding.  ",
      context: CONTEXT,
      now: new Date("2026-07-15T18:00:00.000Z"),
      userAgent: "Synara test agent",
      platform: "MacIntel",
      language: "en-US",
      viewport: { width: 1_440, height: 900 },
    });

    expect(submission).toMatchObject({
      category: "bug",
      details: "The composer stopped responding.",
      diagnostics: {
        provider: "codex",
        model: "gpt-5.6-sol",
        submittedAt: "2026-07-15T18:00:00.000Z",
        userAgent: "Synara test agent",
        platform: "MacIntel",
        language: "en-US",
        viewport: "1440x900",
      },
    });
    expect(submission.summary).toBe(
      formatFeedbackSummary({
        category: "bug",
        diagnostics: submission.diagnostics,
      }),
    );
    expect(submission.summary).not.toContain("The composer stopped responding.");
    expect(submission).not.toHaveProperty("screenshot");
    expect(submission.diagnostics).not.toHaveProperty("projectPath");
    expect(submission.diagnostics).not.toHaveProperty("threadTitle");
    expect(submission.diagnostics).not.toHaveProperty("messages");
    expect(submission.diagnostics).not.toHaveProperty("logs");
  });
});

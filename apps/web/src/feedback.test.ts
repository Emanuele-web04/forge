import { describe, expect, it } from "vitest";
import {
  buildFeedbackSubmission,
  FEEDBACK_CATEGORIES,
  formatBugReportDiagnostics,
  formatFeedbackSummary,
  redactObviousSecrets,
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
    expect(submission.details).not.toContain("  ");
    expect(submission).not.toHaveProperty("screenshot");
    expect(submission.diagnostics).not.toHaveProperty("projectPath");
    expect(submission.diagnostics).not.toHaveProperty("threadTitle");
    expect(submission.diagnostics).not.toHaveProperty("messages");
    expect(submission.diagnostics).not.toHaveProperty("logs");
  });

  it("sanitizes secrets and home paths from details before submission", () => {
    const submission = buildFeedbackSubmission({
      category: "bug",
      details:
        "My token is ghp_0123456789abcdefghijklmnopqrst and I work in /Users/kartik/scratch.",
      context: CONTEXT,
      now: new Date("2026-07-15T18:00:00.000Z"),
      userAgent: "Synara test agent",
      platform: "MacIntel",
      language: "en-US",
      viewport: { width: 1_440, height: 900 },
    });

    expect(submission.details).not.toContain("ghp_0123456789abcdefghijklmnopqrst");
    expect(submission.details).toContain("[REDACTED]");
    expect(submission.details).not.toContain("/Users/kartik");
    expect(submission.details).toContain("~/scratch");
  });

  // Every pattern family in SECRET_PATTERNS has a fixture here so a new or
  // edited row that stops matching fails loudly instead of leaking silently.
  it.each([
    ["a GitHub PAT", "ghp_0123456789abcdefghijklmnop"],
    ["a fine-grained GitHub PAT", "github_pat_0123456789abcdefghijklmnop"],
    ["a GitHub OAuth token", "gho_0123456789abcdefghijklmnop"],
    ["a GitHub user-to-server token", "ghu_0123456789abcdefghijklmnop"],
    ["a GitHub server-to-server token", "ghs_0123456789abcdefghijklmnop"],
    ["a GitHub refresh token", "ghr_0123456789abcdefghijklmnop"],
    ["an OpenAI project key", "sk-proj-0123456789abcdefghijkl"],
    ["an Anthropic key", "sk-ant-0123456789abcdefghijkl"],
    ["a bare sk- key", "sk-0123456789abcdefghijklmnopqrst"],
    ["a Stripe live key", "sk_live_0123456789abcdef"],
    ["a Stripe test key", "rk_test_0123456789abcdef"],
    ["an AWS access key", "AKIAIOSFODNN7EXAMPLE"],
    ["an AWS temporary key", "ASIAIOSFODNN7EXAMPLE"],
    ["an AWS ABIA key", "ABIAIOSFODNN7EXAMPLE"],
    ["a Slack bot token", "xoxb-123456789012-abcdefghijkl"],
    ["a Slack user token", "xoxp-123456789012-abcdefghijkl"],
    ["a Slack app token", "xoxa-123456789012-abcdefghijkl"],
    ["a GitLab PAT", "glpat-abcdefghij12345"],
    ["an npm token", "npm_0123456789abcdefghijklmn"],
    ["a Google OAuth token", "ya29.a0AfH6SMBx-0123456789abcdefghij"],
    ["a Google API key", "AIzaSyA0123456789abcdefghijklmnopqrstuv"],
    ["a JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnopqrst"],
    [
      "a private key block",
      "-----BEGIN PRIVATE KEY-----\nabcdef0123456789\n-----END PRIVATE KEY-----",
    ],
    ["a bearer token", "bearer abcdefghijklmnop"],
    ["a password assignment", "password=hunter2hunter2"],
    ["a secret assignment", "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY"],
    ["an api_key assignment", "api_key: abcdef1234567890"],
    ["a token assignment", "token = abcdef1234567890"],
  ])("redacts %s from pasted details", (_label, secret) => {
    const submission = buildFeedbackSubmission({
      category: "bug",
      details: `here is the leak: ${secret} end`,
      context: CONTEXT,
      userAgent: "Synara test agent",
      platform: "MacIntel",
      language: "en-US",
      viewport: { width: 1_440, height: 900 },
    });

    expect(submission.details).not.toContain(secret);
    expect(submission.details).toContain("[REDACTED]");
  });

  it("redacts credentials embedded in URLs but keeps the host", () => {
    const { text } = redactObviousSecrets(
      "DATABASE_URL=postgres://deploy:hunter2pass@db.internal:5432/app",
    );

    expect(text).not.toContain("hunter2pass");
    expect(text).toContain("postgres://[REDACTED]@db.internal:5432/app");
  });

  it("does not mangle a word that merely contains the letters of a token prefix", () => {
    const { text } = redactObviousSecrets("the mybearer flag controls retries");

    expect(text).toBe("the mybearer flag controls retries");
  });

  it("sanitizes untrusted provider and model strings in the summary and diagnostics", () => {
    const submission = buildFeedbackSubmission({
      category: "bug",
      details: "The model picker stopped listing models.",
      context: {
        ...CONTEXT,
        model: "sk-0123456789ABCDEFGHIJKLMNOPQRSTUVWX fine-tune from /Users/kartik/leak",
      },
      now: new Date("2026-07-15T18:00:00.000Z"),
      userAgent: "Synara test agent",
      platform: "MacIntel",
      language: "en-US",
      viewport: { width: 1_440, height: 900 },
    });

    expect(submission.diagnostics.model).toBe("[REDACTED] fine-tune from ~/leak");
    expect(submission.summary).not.toContain("sk-0123456789ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(submission.summary).not.toContain("/Users/kartik");
    expect(submission.summary).toContain("Model: [REDACTED] fine-tune from ~/leak");
  });
});

describe("formatBugReportDiagnostics", () => {
  it("keeps the rows the issue template asks for and drops the raw browser strings", () => {
    const report = formatBugReportDiagnostics({ category: "bug", diagnostics: DIAGNOSTICS });

    expect(report).toContain("I ran into a bug in Synara 0.5.1, using codex with gpt-5.6-sol.");
    expect(report).toContain("Report type: Bug");
    expect(report).toContain("Platform: MacIntel, viewport 1440x900");
    expect(report).toContain("At submission: the thread was in an error state");
    expect(report).not.toContain("User agent:");
    expect(report).not.toContain("Synara test agent");
    expect(report).not.toContain("Language:");
    expect(report).not.toContain("Submitted at:");
  });

  it("omits fields the session never set without changing the allow-list", () => {
    const report = formatBugReportDiagnostics({
      category: null,
      diagnostics: { ...DIAGNOSTICS, provider: null, model: null },
    });

    expect(report).toContain("I have some feedback in Synara 0.5.1 outside an active chat.");
    expect(report).not.toContain("Provider:");
    expect(report).not.toContain("User agent:");
  });
});

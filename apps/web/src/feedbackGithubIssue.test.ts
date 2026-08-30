// FILE: feedbackGithubIssue.test.ts
// Purpose: Verifies the bug-report prompt builder, secret redaction, and
//          home-path normalization used by the agent-drafted GitHub issue flow.
// Layer: Web feature logic tests

import { describe, expect, it } from "vitest";

import {
  buildGithubIssueInterviewPrompt,
  BUG_REPORT_CONFIRMATION_QUESTION,
  buildGitHubNewIssueUrl,
  normalizeHomePaths,
  redactObviousSecrets,
  SYNARA_UPSTREAM_REPO,
} from "./feedbackGithubIssue";

describe("feedbackGithubIssue", () => {
  it("embeds the diagnostics summary and sanitized details in the prompt", () => {
    const prompt = buildGithubIssueInterviewPrompt({
      details: "I hit a bug with my sk-api-key and /Users/kartik/scratch project.",
      diagnosticsSummary: "Synara 0.7.3, macOS, viewport 1920x1080, provider: codex.",
    });

    expect(prompt).toContain("<diagnostics>");
    expect(prompt).toContain("Synara 0.7.3, macOS, viewport 1920x1080, provider: codex.");
    expect(prompt).toContain("</diagnostics>");
    expect(prompt).toContain("<initial-report>");
    expect(prompt).toContain("[REDACTED]");
    expect(prompt).toContain("~/scratch project");
    expect(prompt).toContain("</initial-report>");
  });

  it("contains the gh issue create command and no --label", () => {
    const prompt = buildGithubIssueInterviewPrompt({
      details: "The sidebar footer button is missing.",
      diagnosticsSummary: "Synara 0.7.3.",
    });

    const commandLine = prompt
      .split("\n")
      .find((line) => line.includes(`gh issue create -R ${SYNARA_UPSTREAM_REPO}`));

    expect(commandLine).toBeDefined();
    expect(commandLine).toContain('--title "[Bug]: <summary>"');
    expect(commandLine).toContain("--body-file");
    // The command itself intentionally omits --label; the prompt later tells
    // the agent not to add one.
    expect(commandLine).not.toContain("--label");
  });

  it("contains the exact confirmation question", () => {
    const prompt = buildGithubIssueInterviewPrompt({
      details: "Crash on startup.",
      diagnosticsSummary: "Synara 0.7.3.",
    });

    expect(prompt).toContain(BUG_REPORT_CONFIRMATION_QUESTION);
  });

  it("contains the fallback new-issue URL and the 6,000-char warning", () => {
    const prompt = buildGithubIssueInterviewPrompt({
      details: "No gh installed.",
      diagnosticsSummary: "Synara 0.7.3.",
    });

    expect(prompt).toContain(buildGitHubNewIssueUrl());
    expect(prompt).toContain("?title=<encoded title>&body=<encoded body>");
    expect(prompt).toContain("6,000");
  });

  it("contains every bug_report.yml section heading", () => {
    const prompt = buildGithubIssueInterviewPrompt({
      details: "Something is wrong.",
      diagnosticsSummary: "Synara 0.7.3.",
    });

    expect(prompt).toContain("### Before submitting");
    expect(prompt).toContain("### Area");
    expect(prompt).toContain("### Steps to reproduce");
    expect(prompt).toContain("### Expected behavior");
    expect(prompt).toContain("### Actual behavior");
    expect(prompt).toContain("### Impact");
    expect(prompt).toContain("### Version or commit");
    expect(prompt).toContain("### Environment");
    expect(prompt).toContain("### Logs or stack traces");
    expect(prompt).toContain("### Workaround");
  });

  it("redacts obvious secrets and leaves ordinary text alone", () => {
    const text =
      "My token is ghp_0123456789abcdefghijklmnop and my aws key is AKIA0123456789ABCDEF. " +
      "I also have github_pat_0123456789_abcdefghijklmnopqrstuvwxyz and a bearer abcdef1234567890abcdef. " +
      "My sk-key is sk-0123456789ABCDEFG and normal word sk-loop is fine.";

    const { text: redacted, redactedCount } = redactObviousSecrets(text);

    expect(redacted).not.toContain("ghp_0123456789abcdefghijklmnop");
    expect(redacted).not.toContain("AKIA0123456789ABCDEF");
    expect(redacted).not.toContain("github_pat_0123456789_abcdefghijklmnopqrstuvwxyz");
    expect(redacted).not.toContain("abcdef1234567890abcdef");
    expect(redacted).not.toContain("sk-0123456789ABCDEFG");
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).toContain("normal word sk-loop is fine");
    expect(redactedCount).toBeGreaterThanOrEqual(5);
  });

  it("redacts bearer tokens case-insensitively", () => {
    const { text } = redactObviousSecrets("Authorization: Bearer abcdef1234567890123456");
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("abcdef1234567890123456");
  });

  it("normalizes macOS and Linux home paths", () => {
    expect(normalizeHomePaths("/Users/kartik/x")).toBe("~/x");
    expect(normalizeHomePaths("/home/k/x")).toBe("~/x");
    expect(normalizeHomePaths("/Users/kartik")).toBe("~");
    expect(normalizeHomePaths("/home/k")).toBe("~");
    expect(normalizeHomePaths("/tmp/users/kartik")).toBe("/tmp/users/kartik");
  });
});

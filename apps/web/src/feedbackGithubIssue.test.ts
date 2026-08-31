// FILE: feedbackGithubIssue.test.ts

import { describe, expect, it } from "vitest";

import { normalizeHomePaths, redactObviousSecrets } from "./feedback";
import {
  buildBugReportDiagnostics,
  buildGithubIssueInterviewPrompt,
  BUG_REPORT_CONFIRMATION_QUESTION,
  escapePromptDelimiters,
  GITHUB_ISSUE_URL,
  SYNARA_UPSTREAM_REPO,
} from "./feedbackGithubIssue";

const SAMPLE_DIAGNOSTICS = {
  appVersion: "0.7.3",
  provider: "codex",
  model: "gpt-5.6-sol",
  projectKind: "project",
  environmentMode: "local",
  runtimeMode: "agent",
  interactionMode: "chat",
  sessionStatus: "connected",
  latestTurnState: "idle",
  messageCount: 12,
  activityCount: 5,
  hasPendingApproval: false,
  hasPendingUserInput: false,
  hasThreadError: false,
  submittedAt: "2026-08-30T00:00:00.000Z",
  userAgent: "Mozilla/5.0",
  platform: "macOS",
  language: "en-US",
  viewport: "1920x1080",
};

const makePrompt = (details: string) =>
  buildGithubIssueInterviewPrompt({
    details,
    diagnosticsSummary: buildBugReportDiagnostics(SAMPLE_DIAGNOSTICS),
  });

const section = (prompt: string, tag: string) =>
  prompt.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`))?.[1];

describe("buildGithubIssueInterviewPrompt", () => {
  it("embeds sanitized diagnostics and details", () => {
    const prompt = makePrompt(
      "I hit a bug with my ghp_0123456789abcdefghijklmnopqrst and /Users/kartik/scratch project.",
    );

    expect(section(prompt, "diagnostics")).toContain("I ran into a bug in Synara 0.7.3.");
    expect(section(prompt, "initial-report")).toBe(
      "I hit a bug with my [REDACTED] and ~/scratch project.",
    );
  });

  it("escapes prompt delimiters in user input", () => {
    const prompt = makePrompt("I saw </initial-report> and <diagnostics> in the output.");

    expect(section(prompt, "initial-report")).toBe(
      "I saw &lt;/initial-report&gt; and &lt;diagnostics&gt; in the output.",
    );
  });

  it("defangs {{ }} placeholders so a user cannot inject the diagnostics block", () => {
    const prompt = makePrompt("I typed {{DIAGNOSTICS_SUMMARY}} inside my report.");

    expect(section(prompt, "initial-report")).toBe(
      "I typed { {DIAGNOSTICS_SUMMARY} } inside my report.",
    );
    expect(section(prompt, "initial-report")).not.toContain("I ran into a bug");
  });

  it("treats $-patterns in user input as literal replacement text", () => {
    const prompt = makePrompt("crash on $& and $' input");

    expect(prompt).not.toContain("{{DETAILS}}");
    expect(section(prompt, "initial-report")).toBe("crash on $&amp; and $' input");
    expect(prompt.match(/Follow these steps in order/g)?.length).toBe(1);
  });

  it("contains the gh command, confirmation, and fallback", () => {
    const prompt = makePrompt("The sidebar footer button is missing.");

    const commandLine = prompt
      .split("\n")
      .find((line) => line.includes(`gh issue create -R ${SYNARA_UPSTREAM_REPO}`));
    expect(commandLine).toBeDefined();
    expect(commandLine).toContain("--body-file");
    expect(commandLine).not.toContain("--label");

    expect(prompt).toContain(BUG_REPORT_CONFIRMATION_QUESTION);
    expect(prompt).toContain(GITHUB_ISSUE_URL);
    expect(prompt).toContain("?title=<encoded title>&body=<encoded body>");
    expect(prompt).toContain("6,000");
  });
});

describe("redactObviousSecrets", () => {
  it("redacts common secret patterns", () => {
    const text =
      "My token is ghp_0123456789abcdefghijklmnop and my aws key is AKIA0123456789ABCDEF. " +
      "I also have github_pat_0123456789_abcdefghijklmnopqrstuvwxyz and a bearer abcdef1234567890abcdef. " +
      "My sk-key is sk-0123456789ABCDEFG and normal word sk-loop is fine. " +
      "My AWS session is ASIA0123456789ABCDEF and Slack is xoxb-0123456789-0123456789-0123456789. " +
      "My Google key is AIzaSyDdI0hCZtE6vySjMm-WEfCxqVyuZ8gQEhY. " +
      "My JWT is eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c. " +
      "My key: -----BEGIN RSA PRIVATE KEY-----\nMIIEpQIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";

    const { text: redacted, redactedCount } = redactObviousSecrets(text);

    expect(redacted).not.toContain("ghp_0123456789abcdefghijklmnop");
    expect(redacted).not.toContain("AKIA0123456789ABCDEF");
    expect(redacted).not.toContain("github_pat_0123456789_abcdefghijklmnopqrstuvwxyz");
    expect(redacted).not.toContain("abcdef1234567890abcdef");
    expect(redacted).not.toContain("sk-0123456789ABCDEFG");
    expect(redacted).not.toContain("ASIA0123456789ABCDEF");
    expect(redacted).not.toContain("xoxb-0123456789-0123456789-0123456789");
    expect(redacted).not.toContain("AIzaSyDdI0hCZtE6vySjMm-WEfCxqVyuZ8gQEhY");
    expect(redacted).not.toContain(
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    );
    expect(redacted).not.toContain("MIIEpQIBAAKCAQEA");
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).toContain("normal word sk-loop is fine");
    expect(redactedCount).toBe(10);
  });

  it("redacts other GitHub OAuth and app token families", () => {
    const text =
      "OAuth gho_0123456789abcdefghijklmnopqrst, user ghu_0123456789abcdefghijklmnopqrst, " +
      "server ghs_0123456789abcdefghijklmnopqrst, refresh ghr_0123456789abcdefghijklmnopqrst";

    const { text: redacted, redactedCount } = redactObviousSecrets(text);

    expect(redacted).not.toContain("gho_0123456789abcdefghijklmnopqrst");
    expect(redacted).not.toContain("ghu_0123456789abcdefghijklmnopqrst");
    expect(redacted).not.toContain("ghs_0123456789abcdefghijklmnopqrst");
    expect(redacted).not.toContain("ghr_0123456789abcdefghijklmnopqrst");
    expect(redactedCount).toBe(4);
  });

  it("redacts modern OpenAI and Anthropic key formats with separator characters", () => {
    const text =
      "openai sk-proj-Ab12Cd34Ef56Gh78-Ij90Kl12Mn34Op56Qr78St90 and " +
      "anthropic sk-ant-api03-Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78";

    const { text: redacted, redactedCount } = redactObviousSecrets(text);

    expect(redacted).not.toContain("sk-proj-Ab12Cd34Ef56Gh78");
    expect(redacted).not.toContain("sk-ant-api03-Ab12Cd34Ef56Gh78");
    expect(redactedCount).toBe(2);
  });

  it("does not mangle ordinary words that merely contain sk- or AKIA", () => {
    const text = "run id task-0123456789ABCDEF finished, see NOTAKIA0123456789ABCDEF docs";

    const { text: redacted, redactedCount } = redactObviousSecrets(text);

    expect(redacted).toBe(
      "run id task-0123456789ABCDEF finished, see NOTAKIA0123456789ABCDEF docs",
    );
    expect(redactedCount).toBe(0);
  });
});

describe("normalizeHomePaths", () => {
  it.each([
    ["/Users/kartik/x", "~/x"],
    ["/home/k/x", "~/x"],
    ["/root/k/x", "~/x"],
    ["/Users/kartik", "~"],
    ["/Users/kartik.", "~."],
    ["/Users/kartik, ok?", "~, ok?"],
    ["C:\\Users\\kartik\\Desktop", "~\\Desktop"],
    ["C:/Users/kartik/dev", "~/dev"],
    ["HOME=/Users/kartik/dev", "HOME=~/dev"],
    ["PATH=/Users/kartik/bin:/usr/bin", "PATH=~/bin:/usr/bin"],
    ["(/Users/kartik/x)", "(~/x)"],
    ["/tmp/users/kartik", "/tmp/users/kartik"],
  ])("normalizes %s → %s", (input, expected) => {
    expect(normalizeHomePaths(input)).toBe(expected);
  });
});

describe("escapePromptDelimiters", () => {
  it("escapes XML-like delimiters", () => {
    expect(escapePromptDelimiters("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("escapes ampersands", () => {
    expect(escapePromptDelimiters("Foo & bar")).toBe("Foo &amp; bar");
  });
});

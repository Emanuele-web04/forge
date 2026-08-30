// FILE: feedbackGithubIssue.ts
// Purpose: Privacy-safe bug-report prompt builder and sanitizers for the
//          agent-drafted GitHub issue flow.
// Layer: Web feature logic
// Depends on: The feedback diagnostics contract and the bug report template.

import { APP_VERSION } from "./branding";

export const SYNARA_UPSTREAM_REPO = "Emanuele-web04/synara";

const GITHUB_ISSUE_URL = `https://github.com/${SYNARA_UPSTREAM_REPO}/issues/new`;

const SECRET_PATTERNS = [
  { name: "github-pat", pattern: /ghp_[A-Za-z0-9]{20,}/gu },
  { name: "github-pat-underscore", pattern: /github_pat_[A-Za-z0-9_]{20,}/gu },
  { name: "sk-api-key", pattern: /sk-[A-Za-z0-9_-]{16,}/gu },
  { name: "aws-access-key", pattern: /AKIA[0-9A-Z]{16}/gu },
  { name: "bearer-token", pattern: /bearer\s+[A-Za-z0-9._~+/=-]{16,}/giu },
] as const;

/**
 * Masks high-confidence secrets with `[REDACTED]` and returns the number of
 * redactions made. This is a last-line-of-defense sanitizer; the prompt itself
 * also instructs the agent to run a second sanitization pass before filing.
 */
export function redactObviousSecrets(text: string): { text: string; redactedCount: number } {
  let redactedCount = 0;
  let redacted = text;
  for (const { pattern } of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      redactedCount += 1;
      return match.length > 0 ? "[REDACTED]" : match;
    });
  }
  return { text: redacted, redactedCount };
}

const HOME_PATH_PATTERN = /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+)(\/|$)/gu;

/**
 * Replaces `/Users/<name>/...` and `/home/<name>/...` prefixes with `~/` so
 * reporter home directories are not leaked into a public issue.
 */
export function normalizeHomePaths(text: string): string {
  return text.replace(HOME_PATH_PATTERN, (match, trailing: string) => {
    return trailing === "/" ? "~/" : "~";
  });
}

/**
 * Copy-verbatim from Plan 07 §6.4. The only substitutions are `{{DETAILS}}`
 * and `{{DIAGNOSTICS_SUMMARY}}`; everything else is the fixed interview
 * protocol shown to the agent.
 */
const BUG_REPORT_INTERVIEW_PROMPT_TEMPLATE = [
  "You are helping me file a high-quality bug report for Synara (the app you are running inside) to its public GitHub repository, Emanuele-web04/synara. Act as a careful bug-report interviewer and scribe. Do not modify the codebase and do not run destructive commands. You must not create the issue until I explicitly confirm in step 6.",
  "",
  "Context collected by the Synara feedback dialog (sanitized; it contains no prompts, messages, file paths, or logs):",
  "",
  "<diagnostics>",
  "{{DIAGNOSTICS_SUMMARY}}",
  "</diagnostics>",
  "",
  "My initial description (may be empty):",
  "",
  "<initial-report>",
  "{{DETAILS}}",
  "</initial-report>",
  "",
  "Follow these steps in order, asking one focused question at a time and waiting for my answer instead of assuming:",
  "",
  "1. Understand the problem. Restate the bug in one or two sentences and ask me to confirm or correct. If the initial description is empty, ask me what happened.",
  "2. Interview me, one topic per message:",
  "   a. Steps to reproduce — a minimal, deterministic, numbered list.",
  "   b. Expected behavior vs. actual (observed) behavior.",
  '   c. Impact — agree on one of: "Blocks work completely", "Major degradation or frequent failure", "Minor bug or occasional failure", "Cosmetic issue".',
  '   d. Area — agree on one of: apps/web, apps/server, apps/desktop, packages/contracts or packages/shared, "Build, CI, or release tooling", Docs, "Not sure".',
  "   e. Optional, only if I volunteer them: pasted logs or stack traces, and any workaround I found.",
  "3. Sanitization pass (mandatory before showing any draft). Apply this checklist to everything that will appear in the issue, including text I pasted:",
  '   - Mask anything that looks like a secret (API keys, tokens such as ghp_, github_pat_, sk-, AKIA…, "Bearer …", passwords, signed URLs) with [REDACTED].',
  "   - Replace absolute home paths with ~ (for example /Users/alice/dev/app → ~/dev/app).",
  "   - Never include prompt text, conversation content, or file contents from my other Synara threads unless I pasted them into this thread myself.",
  "   - Private identifiers (private repo names, internal hostnames, email addresses, other people's usernames): list each one you found and ask me, item by item, whether to keep, mask, or drop it.",
  "   - Logs appear only if I pasted them, trimmed to the relevant portion.",
  "4. Duplicate check, only if the gh CLI works: run",
  '   gh search issues --repo Emanuele-web04/synara --state open "<3-6 keywords>" --limit 5',
  "   and show me anything that looks like the same bug. If I confirm a duplicate, stop and suggest commenting on that issue instead.",
  "5. Assemble the issue exactly in this format (it mirrors .github/ISSUE_TEMPLATE/bug_report.yml):",
  "",
  "   Title: [Bug]: <one-line summary>",
  "",
  "   ### Before submitting",
  "   - [x] I searched existing issues and did not find a duplicate.",
  "   - [x] I included enough detail to reproduce or investigate the problem.",
  "",
  "   ### Area",
  "   <the Area we agreed on>",
  "",
  "   ### Steps to reproduce",
  "   1. …",
  "",
  "   ### Expected behavior",
  "   …",
  "",
  "   ### Actual behavior",
  "   …",
  "",
  "   ### Impact",
  "   <the Impact we agreed on>",
  "",
  "   ### Version or commit",
  "   <app version from the diagnostics; add commit or branch if I provided one>",
  "",
  "   ### Environment",
  "   <OS/platform, viewport, provider and model, modes — from the diagnostics plus anything I added>",
  "",
  "   ### Logs or stack traces",
  '   <only what I pasted, sanitized; otherwise "None provided.">',
  "",
  "   ### Workaround",
  '   <only if I described one; otherwise "None found.">',
  "",
  "6. Confirmation gate (hard rule). Show me the final title and the COMPLETE markdown body — no summaries, no elisions. Then ask exactly:",
  "   \"File this issue to Emanuele-web04/synara under your GitHub account (via gh)? Reply 'file it' to submit, or tell me what to change.\"",
  '   Do not run any command that creates an issue until my next message is an explicit yes ("file it", "yes, file it", or equivalent). If I request edits, apply them and repeat this step with the full updated body. File at most one issue per confirmation; after a successful filing, never file again in this thread unless I explicitly ask for a new, separate issue and you repeat this entire gate.',
  "7. Filing path (only after my explicit confirmation):",
  "   - Check the CLI: gh --version, then gh auth status.",
  "   - If both succeed, write the confirmed body verbatim to a temp file (for example /tmp/synara-bug-<timestamp>.md) and run:",
  '     gh issue create -R Emanuele-web04/synara --title "[Bug]: <summary>" --body-file /tmp/synara-bug-<timestamp>.md',
  "     Do not pass --label; maintainers apply labels during triage.",
  "   - Print the returned issue URL in your reply so this thread's transcript records it, then delete the temp file.",
  '   - If the command\'s outcome is unclear (timeout, ambiguous error), run gh issue list -R Emanuele-web04/synara --author "@me" --limit 3 and check before ever considering a retry — never risk a duplicate.',
  "8. Fallback path (gh missing or unauthenticated): do NOT install or authenticate gh yourself. Instead:",
  "   - Output the final title and body as one copy-ready markdown block.",
  "   - Give me a prefilled link, URL-encoding the values:",
  `     ${GITHUB_ISSUE_URL}?title=<encoded title>&body=<encoded body>`,
  "     If the encoded URL would exceed roughly 6,000 characters, link with the title only and tell me to paste the body from the block above.",
  "   - Mention that I can run gh auth login myself and then ask you to file it.",
  "",
  'Tone: concise, no filler, one question at a time. Never invent details I did not give you — write "Not sure" rather than guessing.',
].join("\n");

export interface BuildGithubIssueInterviewPromptInput {
  details: string;
  diagnosticsSummary: string;
}

/**
 * Builds the bug-report interview prompt that is prefilled into a new draft
 * thread composer. The user-typed `details` are sanitized for secrets and home
 * paths; the `diagnosticsSummary` is the privacy-safe summary produced by
 * `buildFeedbackSubmission(...).summary`.
 */
export function buildGithubIssueInterviewPrompt(
  input: BuildGithubIssueInterviewPromptInput,
): string {
  const { diagnosticsSummary } = input;
  const sanitizedDetails = normalizeHomePaths(redactObviousSecrets(input.details).text);
  return BUG_REPORT_INTERVIEW_PROMPT_TEMPLATE.replaceAll(
    "{{DETAILS}}",
    sanitizedDetails,
  ).replaceAll("{{DIAGNOSTICS_SUMMARY}}", diagnosticsSummary);
}

export const BUG_REPORT_CONFIRMATION_QUESTION =
  "File this issue to Emanuele-web04/synara under your GitHub account (via gh)? Reply 'file it' to submit, or tell me what to change.";

/**
 * The prefilled new-issue URL used as a fallback when `gh` is missing or
 * unauthenticated. Callers should URL-encode `title` and `body` before appending.
 */
export function buildGitHubNewIssueUrl(): string {
  return GITHUB_ISSUE_URL;
}

/**
 * Builds the app version string included in the issue body when the user does
 * not supply a commit. Reads the same `APP_VERSION` the feedback endpoint uses.
 */
export function buildBugReportAppVersion(): string {
  return APP_VERSION;
}

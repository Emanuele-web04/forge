#!/usr/bin/env bun
// FILE: cli-basic-agent.ts
// Purpose: Deterministic basic-tier (no structured protocol) CLI fixture for
// the KAR-527 generic CLI connector. Outputs plain text lines on stdout and
// reads plain lines from stdin. It has NO protocol knowledge and MUST NOT fake
// capabilities it does not have: no resume, no permissions, no elicitation —
// honest limits only. Env knobs (SYNARA_CLI_BASIC_*) select canned behaviors.
// Layer: Test fixture executable
// Exports: none; speaks line-oriented text over stdio.

import { createInterface } from "node:readline";

const greeting = process.env.SYNARA_CLI_BASIC_GREETING ?? "basic cli ready";
const echoLines = Number(process.env.SYNARA_CLI_BASIC_ECHO_LINES ?? "3");
const promptText = process.env.SYNARA_CLI_BASIC_PROMPT_TEXT ?? "basic says hi";
const hangOnPrompt = process.env.SYNARA_CLI_BASIC_HANG_ON_PROMPT === "1";
const ignoreStdin = process.env.SYNARA_CLI_BASIC_IGNORE_STDIN === "1";
const slowLineDelayMs = Number(process.env.SYNARA_CLI_BASIC_LINE_DELAY_MS ?? "5");
const stderrNotes = process.env.SYNARA_CLI_BASIC_STDERR_NOTES === "1";
// One-shot mode: exit cleanly after echoing the response for one prompt. The
// basic tier has no turn-completion protocol event, so process exit (EOF) is
// the honest turn boundary the connector waits on.
const exitAfterEcho = process.env.SYNARA_CLI_BASIC_EXIT_AFTER_ECHO === "1";

process.stdout.write(`${greeting}\n`);
if (stderrNotes) {
  process.stderr.write("basic cli note on stderr\n");
}

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

let promptCount = 0;

rl.on("line", (raw) => {
  const line = raw.trim();
  if (!line) return;
  if (ignoreStdin) return;

  promptCount += 1;
  if (hangOnPrompt && promptCount === 1) {
    // Never respond; cancellation must come from the connector killing us.
    return;
  }
  for (let i = 0; i < echoLines; i++) {
    const text = i === 0 ? `${promptText} ${line}` : `${promptText} ${line} [${i}]`;
    const timer = setTimeout(() => {
      process.stdout.write(`${text}\n`);
    }, slowLineDelayMs * i);
    timer.unref();
  }
  if (exitAfterEcho) {
    // One-shot: flush the echoed lines, then exit so the connector observes EOF
    // as the turn boundary. The delay is the last line's offset plus a margin.
    const exitAt = setTimeout(() => {
      process.exit(0);
    }, slowLineDelayMs * echoLines + 50);
    exitAt.unref();
  }
});

process.once("SIGTERM", () => {
  process.exit(0);
});
process.once("SIGINT", () => {
  process.exit(0);
});

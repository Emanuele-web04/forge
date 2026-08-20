// FILE: providerUsageSnapshot.test.ts
// Purpose: Verifies provider usage scans stay bounded for large local archives.
// Layer: Server provider usage tests

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readClaudeUsageSamples, readCodexSessionSummary } from "./providerUsageSnapshot";

const tempDirs: string[] = [];

function tokenCountLine(timestamp: string, totalTokens: number, note?: string): string {
  return JSON.stringify({
    timestamp,
    ...(note ? { note } : {}),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { total_tokens: totalTokens } },
      rate_limits: {
        primary: { used_percent: 25, window_minutes: 300 },
      },
    },
  });
}

async function makeSessionFile(contents: string, name = "rollout.jsonl"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synara-provider-usage-"));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  await fs.writeFile(file, contents);
  return file;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("readCodexSessionSummary", () => {
  it("reads the latest token count from the file tail without readFile", async () => {
    const file = await makeSessionFile(
      [
        tokenCountLine("2026-08-13T10:00:00.000Z", 100),
        JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
        tokenCountLine("2026-08-14T10:00:00.000Z", 250),
        "not-json",
      ].join("\n"),
    );
    const probe = await fs.open(file, "r");
    const handlePrototype: Pick<typeof probe, "read"> = Object.getPrototypeOf(probe);
    await probe.close();
    const read = vi.spyOn(handlePrototype, "read");
    const readFile = vi.spyOn(fs, "readFile");

    await expect(readCodexSessionSummary(file)).resolves.toEqual({
      timestampMs: Date.parse("2026-08-14T10:00:00.000Z"),
      totalTokens: 250,
      limits: [{ window: "5h", usedPercent: 25, windowDurationMins: 300 }],
    });
    expect(readFile).not.toHaveBeenCalled();
    const positionalReadCalls = read.mock.calls as unknown as readonly (readonly [
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
    ])[];
    expect(positionalReadCalls.every(([, , length]) => length <= 64 * 1024)).toBe(true);
  });

  it("parses a CRLF token record split across read chunks", async () => {
    const tokenLine = tokenCountLine("2026-08-14T10:00:00.000Z", 250, "café 🧠");
    const trailingLength = 64 * 1024 - Math.floor(Buffer.byteLength(tokenLine) / 2) - 2;
    const file = await makeSessionFile(`ignored\r\n${tokenLine}\r\n${"x".repeat(trailingLength)}`);

    await expect(readCodexSessionSummary(file)).resolves.toMatchObject({
      timestampMs: Date.parse("2026-08-14T10:00:00.000Z"),
      totalTokens: 250,
    });
  });

  it("skips an oversized trailing record without retaining it in memory", async () => {
    const file = await makeSessionFile(
      `${tokenCountLine("2026-08-14T10:00:00.000Z", 250)}\n${"x".repeat(2 * 1024 * 1024)}`,
    );

    await expect(readCodexSessionSummary(file)).resolves.toMatchObject({
      timestampMs: Date.parse("2026-08-14T10:00:00.000Z"),
      totalTokens: 250,
    });
  });
});

function assistantLine(input: {
  timestamp: string;
  totalTokens: number;
  sessionId?: string;
  messageId?: string;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: input.timestamp,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    message: {
      ...(input.messageId ? { id: input.messageId } : {}),
      model: "claude-opus-4-5",
      usage: { input_tokens: input.totalTokens, output_tokens: 0 },
    },
  });
}

describe("readClaudeUsageSamples", () => {
  it("reads samples from the transcript stream without readFile", async () => {
    // A record carrying no session or message id falls back to its line number, so the
    // blank line has to keep its place in the count for that key to stay stable.
    const file = await makeSessionFile(
      [
        JSON.stringify({ type: "user", timestamp: "2026-08-14T09:00:00.000Z" }),
        "",
        assistantLine({ timestamp: "2026-08-14T10:00:00.000Z", totalTokens: 40 }),
        assistantLine({
          timestamp: "2026-08-14T11:00:00.000Z",
          totalTokens: 60,
          sessionId: "session-a",
          messageId: "message-a",
        }),
        "not-json",
      ].join("\n"),
      "transcript.jsonl",
    );
    const readFile = vi.spyOn(fs, "readFile");

    await expect(readClaudeUsageSamples(file)).resolves.toEqual([
      {
        sessionId: `${file}:2`,
        timestampMs: Date.parse("2026-08-14T10:00:00.000Z"),
        totalTokens: 40,
        model: "claude-opus-4-5",
      },
      {
        sessionId: "session-a",
        timestampMs: Date.parse("2026-08-14T11:00:00.000Z"),
        totalTokens: 60,
        model: "claude-opus-4-5",
      },
    ]);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("returns no samples for a missing transcript", async () => {
    const file = await makeSessionFile("", "transcript.jsonl");

    await expect(readClaudeUsageSamples(`${file}.absent`)).resolves.toEqual([]);
  });

  it("skips an oversized record and resumes at the next line", async () => {
    const oversizedAssistantLine = JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-14T10:30:00.000Z",
      message: {
        model: "claude-opus-4-5",
        content: "x".repeat(2 * 1024 * 1024),
        usage: { input_tokens: 50, output_tokens: 0 },
      },
    });
    const file = await makeSessionFile(
      [
        assistantLine({ timestamp: "2026-08-14T10:00:00.000Z", totalTokens: 40 }),
        oversizedAssistantLine,
        assistantLine({ timestamp: "2026-08-14T11:00:00.000Z", totalTokens: 60 }),
      ].join("\n"),
      "transcript.jsonl",
    );

    await expect(readClaudeUsageSamples(file)).resolves.toEqual([
      {
        sessionId: `${file}:0`,
        timestampMs: Date.parse("2026-08-14T10:00:00.000Z"),
        totalTokens: 40,
        model: "claude-opus-4-5",
      },
      {
        sessionId: `${file}:2`,
        timestampMs: Date.parse("2026-08-14T11:00:00.000Z"),
        totalTokens: 60,
        model: "claude-opus-4-5",
      },
    ]);
  });
});

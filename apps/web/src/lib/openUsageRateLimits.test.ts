import { describe, expect, it } from "vitest";

import type { ProviderKind } from "@synara/contracts";

import {
  normalizeOpenUsageSnapshot,
  normalizeOpenUsageUsageLines,
  openUsageProviderIdForProvider,
} from "./openUsageRateLimits";
import { mergeProviderRateLimits } from "./rateLimits";

describe("openUsageRateLimits", () => {
  it("maps every Synara provider to its compatible OpenUsage id", () => {
    expect(
      (
        [
          "codex",
          "claudeAgent",
          "cursor",
          "opencode",
          "antigravity",
          "grok",
          "droid",
          "kilo",
          "pi",
        ] satisfies ProviderKind[]
      ).map((provider) => openUsageProviderIdForProvider(provider)),
    ).toEqual(["codex", "claude", "cursor", "opencode", null, null, null, null, null]);
  });

  it("normalizes OpenUsage progress lines into shared provider rate limits", () => {
    expect(
      normalizeOpenUsageSnapshot({
        providerId: "codex",
        fetchedAt: "2099-04-08T18:00:00.000Z",
        lines: [
          {
            type: "progress",
            label: "Session",
            used: 20,
            limit: 100,
            resetsAt: "2099-04-08T21:18:00.000Z",
            periodDurationMs: 18_000_000,
          },
          {
            type: "progress",
            label: "Weekly",
            used: 10,
            limit: 100,
            resetsAt: "2099-04-14T18:00:00.000Z",
            periodDurationMs: 604_800_000,
          },
        ],
      }),
    ).toEqual({
      provider: "codex",
      updatedAt: "2099-04-08T18:00:00.000Z",
      limits: [
        {
          window: "5h",
          usedPercent: 20,
          resetsAt: "2099-04-08T21:18:00.000Z",
          windowDurationMins: 300,
        },
        {
          window: "Weekly",
          usedPercent: 10,
          resetsAt: "2099-04-14T18:00:00.000Z",
          windowDurationMins: 10080,
        },
      ],
    });
  });

  it("merges runtime and OpenUsage windows for the same provider", () => {
    expect(
      mergeProviderRateLimits(
        [
          {
            provider: "codex",
            updatedAt: "2099-04-08T18:05:00.000Z",
            limits: [
              {
                window: "5h",
                usedPercent: 22,
                resetsAt: "2099-04-08T21:18:00.000Z",
                windowDurationMins: 300,
              },
            ],
          },
        ],
        [
          {
            provider: "codex",
            updatedAt: "2099-04-08T18:00:00.000Z",
            limits: [
              {
                window: "Weekly",
                usedPercent: 10,
                resetsAt: "2099-04-14T18:00:00.000Z",
                windowDurationMins: 10080,
              },
            ],
          },
        ],
      ),
    ).toEqual([
      {
        provider: "codex",
        updatedAt: "2099-04-08T18:05:00.000Z",
        limits: [
          {
            window: "5h",
            usedPercent: 22,
            resetsAt: "2099-04-08T21:18:00.000Z",
            windowDurationMins: 300,
          },
          {
            window: "Weekly",
            usedPercent: 10,
            resetsAt: "2099-04-14T18:00:00.000Z",
            windowDurationMins: 10080,
          },
        ],
      },
    ]);
  });

  it("keeps the freshest window when two sources report the same provider limit", () => {
    expect(
      mergeProviderRateLimits(
        [
          {
            provider: "codex",
            updatedAt: "2099-04-08T18:00:00.000Z",
            limits: [
              {
                window: "Weekly",
                usedPercent: 65,
                resetsAt: "2099-04-14T18:00:00.000Z",
                windowDurationMins: 10080,
              },
            ],
          },
        ],
        [
          {
            provider: "codex",
            updatedAt: "2099-04-08T18:05:00.000Z",
            limits: [
              {
                window: "Weekly",
                usedPercent: 84,
                resetsAt: "2099-04-14T18:00:00.000Z",
                windowDurationMins: 10080,
              },
            ],
          },
        ],
      ),
    ).toEqual([
      {
        provider: "codex",
        updatedAt: "2099-04-08T18:05:00.000Z",
        limits: [
          {
            window: "Weekly",
            usedPercent: 84,
            resetsAt: "2099-04-14T18:00:00.000Z",
            windowDurationMins: 10080,
          },
        ],
      },
    ]);
  });

  it("fills missing timing metadata from an older source when the freshest row only has usage", () => {
    expect(
      mergeProviderRateLimits(
        [
          {
            provider: "codex",
            updatedAt: "2099-04-08T18:00:00.000Z",
            limits: [
              {
                window: "Weekly",
                usedPercent: 65,
                resetsAt: "2099-04-14T18:00:00.000Z",
                windowDurationMins: 10080,
              },
            ],
          },
        ],
        [
          {
            provider: "codex",
            updatedAt: "2099-04-08T18:05:00.000Z",
            limits: [
              {
                window: "Weekly",
                usedPercent: 84,
              },
            ],
          },
        ],
      ),
    ).toEqual([
      {
        provider: "codex",
        updatedAt: "2099-04-08T18:05:00.000Z",
        limits: [
          {
            window: "Weekly",
            usedPercent: 84,
            resetsAt: "2099-04-14T18:00:00.000Z",
            windowDurationMins: 10080,
          },
        ],
      },
    ]);
  });

  it("preserves OpenUsage text lines for daily token usage summaries", () => {
    expect(
      normalizeOpenUsageUsageLines({
        providerId: "codex",
        fetchedAt: "2099-04-08T18:00:00.000Z",
        lines: [
          {
            type: "progress",
            label: "Session",
            used: 20,
            limit: 100,
          },
          {
            type: "text",
            label: "Today",
            value: "$5.17 · 9.2M tokens",
          },
          {
            type: "text",
            label: "Yesterday",
            value: "$2.04 · 3.1M tokens",
            subtitle: "via ccusage",
          },
        ],
      }),
    ).toEqual([
      {
        label: "Today",
        value: "$5.17 · 9.2M tokens",
      },
      {
        label: "Yesterday",
        value: "$2.04 · 3.1M tokens",
        subtitle: "via ccusage",
      },
    ]);
  });
});

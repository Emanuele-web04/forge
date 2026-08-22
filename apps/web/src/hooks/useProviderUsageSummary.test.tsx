// FILE: useProviderUsageSummary.test.tsx
// Purpose: Verifies how the shared provider-usage summary hook arbitrates live,
// local, OpenUsage, and thread-derived fallback usage signals.

import type { ServerProviderUsageSnapshot } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ProviderRateLimit } from "~/lib/rateLimits";
import { openUsageProviderSnapshotQueryOptions } from "~/lib/openUsageReactQuery";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { useProviderUsageSummary } from "./useProviderUsageSummary";

vi.mock("~/lib/openUsageReactQuery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/openUsageReactQuery")>();
  return {
    ...actual,
    openUsageProviderSnapshotQueryOptions: vi.fn(actual.openUsageProviderSnapshotQueryOptions),
  };
});

function snapshot(input: Partial<ServerProviderUsageSnapshot> = {}): ServerProviderUsageSnapshot {
  return {
    provider: "claudeAgent",
    updatedAt: "2026-06-09T12:00:00.000Z",
    limits: [],
    usageLines: [],
    source: "test",
    ...input,
  };
}

function fallbackSnapshot(): ServerProviderUsageSnapshot {
  return snapshot({
    limits: [
      {
        window: "Weekly",
        usedPercent: 64,
        resetsAt: "2026-06-15T12:00:00.000Z",
        windowDurationMins: 10080,
      },
    ],
    usageLines: [{ label: "24h", value: "123M tokens", subtitle: "12 recent sessions" }],
  });
}

function renderWithQueryClient(queryClient: QueryClient, node: ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>,
  );
}

function readProviderUsageSummary(input: {
  queryClient: QueryClient;
  threadRateLimits?: ReadonlyArray<ProviderRateLimit> | undefined;
  providerSnapshot?: ServerProviderUsageSnapshot | undefined;
  fetchOpenUsageData?: boolean;
}) {
  // Capture into a ref-style holder: the hook only runs inside the closure, so a
  // plain `let` would narrow to `never` after the guard (TS can't see <Probe/> run).
  const captured: { current: ReturnType<typeof useProviderUsageSummary> | null } = {
    current: null,
  };

  function Probe() {
    captured.current = useProviderUsageSummary({
      provider: "claudeAgent",
      threads: [],
      threadRateLimits: input.threadRateLimits,
      providerSnapshot: input.providerSnapshot,
      fetchOpenUsageData: input.fetchOpenUsageData,
    });
    return <span />;
  }

  renderWithQueryClient(input.queryClient, <Probe />);

  if (!captured.current) {
    throw new Error("Provider usage summary probe did not render.");
  }
  return captured.current;
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

describe("useProviderUsageSummary", () => {
  it("can keep OpenUsage polling disabled while using the server batch query", () => {
    const queryClient = createQueryClient();

    readProviderUsageSummary({ queryClient, fetchOpenUsageData: false });

    expect(openUsageProviderSnapshotQueryOptions).toHaveBeenCalledWith("claudeAgent", {
      enabled: false,
    });
    expect(
      queryClient.getQueryCache().find({ queryKey: serverQueryKeys.allProviderUsage() }),
    ).toBeDefined();
  });

  it("does not show local fallback rows when the live batch reports a non-ok status", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [
      snapshot({ status: "needs-auth", detail: "Sign in with claude to see usage." }),
    ]);
    queryClient.setQueryData(
      serverQueryKeys.providerUsage("claudeAgent", null),
      fallbackSnapshot(),
    );

    const summary = readProviderUsageSummary({ queryClient });

    expect(summary.rateLimits).toEqual([]);
    expect(summary.usageLines).toEqual([]);
  });

  it("still uses local fallback rows when no live snapshot exists", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), []);
    queryClient.setQueryData(
      serverQueryKeys.providerUsage("claudeAgent", null),
      fallbackSnapshot(),
    );

    const summary = readProviderUsageSummary({ queryClient });

    expect(summary.rateLimits).toHaveLength(1);
    expect(summary.rateLimits[0]?.limits?.[0]?.window).toBe("Weekly");
    expect(summary.usageLines).toEqual([
      { label: "24h", value: "123M tokens", subtitle: "12 recent sessions" },
    ]);
  });

  it("accepts precomputed thread fallback rows from aggregate provider surfaces", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), []);

    const summary = readProviderUsageSummary({
      queryClient,
      threadRateLimits: [
        {
          provider: "claudeAgent",
          updatedAt: "2026-06-09T12:00:00.000Z",
          limits: [
            {
              window: "5h",
              usedPercent: 12,
              resetsAt: "2026-06-09T17:00:00.000Z",
              windowDurationMins: 300,
            },
          ],
        },
      ],
    });

    expect(summary.rateLimits).toHaveLength(1);
    expect(summary.rateLimits[0]?.limits?.[0]?.window).toBe("5h");
    expect(summary.rateLimits[0]?.limits?.[0]?.usedPercent).toBe(12);
  });

  it("surfaces the throttle notice from an ok snapshot that carries a detail", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [
      snapshot({
        status: "ok",
        detail: "Anthropic is rate-limiting usage checks — showing your last values.",
        limits: [
          {
            window: "Weekly",
            usedPercent: 64,
            resetsAt: "2026-06-15T12:00:00.000Z",
            windowDurationMins: 10080,
          },
        ],
      }),
    ]);

    const summary = readProviderUsageSummary({ queryClient });

    expect(summary.rateLimits).toHaveLength(1);
    expect(summary.usageNotice).toContain("rate-limiting");
  });

  it("has no notice when the live snapshot is non-ok", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [
      snapshot({ status: "error", detail: "Usage is currently unavailable." }),
    ]);

    const summary = readProviderUsageSummary({ queryClient });

    expect(summary.usageNotice).toBeUndefined();
  });

  it("does not show fallback rows when an explicit provider card snapshot is non-ok", () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), []);
    queryClient.setQueryData(
      serverQueryKeys.providerUsage("claudeAgent", null),
      fallbackSnapshot(),
    );

    const summary = readProviderUsageSummary({
      queryClient,
      providerSnapshot: snapshot({ status: "error", detail: "Usage is currently unavailable." }),
    });

    expect(summary.rateLimits).toEqual([]);
    expect(summary.usageLines).toEqual([]);
  });
});

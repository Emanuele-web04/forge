// FILE: ProviderUsageSettingsPanel.test.tsx
// Purpose: Renders the settings usage panel with seeded query data and verifies
// the machine-activity partial states: a partial activity without periods shows
// its detail, and a partial activity with periods shows the amber banner.

import type { ServerProviderUsageActivity, ServerProviderUsageSnapshot } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { serverQueryKeys } from "~/lib/serverReactQuery";
import { ProviderUsageSettingsPanel } from "./ProviderUsageSettingsPanel";

function machineActivity(input: Partial<ServerProviderUsageActivity>): ServerProviderUsageActivity {
  return {
    status: "partial",
    scope: "machine",
    source: "opencode-local-sqlite",
    capturedAt: "2026-08-09T00:00:00.000Z",
    periods: [],
    breakdown: [],
    ...input,
  };
}

function snapshot(input: Partial<ServerProviderUsageSnapshot>): ServerProviderUsageSnapshot {
  return {
    provider: "opencode",
    updatedAt: "2026-08-09T00:00:00.000Z",
    limits: [],
    usageLines: [],
    source: "live",
    status: "ok",
    ...input,
  };
}

function renderPanel(queryClient: QueryClient) {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ProviderUsageSettingsPanel />
    </QueryClientProvider>,
  );
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

describe("ProviderUsageSettingsPanel", () => {
  it("renders a partial machine activity detail when no periods exist", () => {
    const queryClient = createQueryClient();
    const detail = "The kilo history is partial because the scan is limited to 12 local databases.";
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [
      snapshot({
        provider: "kilo",
        activity: machineActivity({
          source: "kilo-local-sqlite",
          detail,
        }),
      }),
    ]);

    const markup = renderPanel(queryClient);

    expect(markup).toContain("On this machine:");
    expect(markup).toContain(detail);
  });

  it("renders the amber partial banner for a partial activity with periods", () => {
    const queryClient = createQueryClient();
    const detail =
      "The opencode history is partial because at least one local database exceeded the 50,000-message scan cap.";
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [
      snapshot({
        provider: "opencode",
        activity: machineActivity({
          detail,
          periods: [
            {
              id: "30d",
              startAt: "2026-07-10T00:00:00.000Z",
              endAt: "2026-08-09T00:00:00.000Z",
              sessions: 2,
              tokens: { total: 1234 },
              recordedCostUsd: null,
            },
          ],
        }),
      }),
    ]);

    const markup = renderPanel(queryClient);

    expect(markup).toContain("On this machine");
    expect(markup).toContain(detail);
    expect(markup).toContain("1.2k");
  });
});

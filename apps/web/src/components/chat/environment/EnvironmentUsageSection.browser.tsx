// FILE: EnvironmentUsageSection.browser.tsx
// Purpose: Browser coverage for the per-enabled-provider usage rows and multi-window summaries.

import "../../../index.css";

import { DEFAULT_SERVER_SETTINGS_VIEW, type ServerProviderUsageSnapshot } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const appSettingsMocks = vi.hoisted(() => ({
  useAppSettings: vi.fn(() => ({ settings: { codexHomePath: "" } })),
}));

vi.mock("~/appSettings", () => ({
  useAppSettings: appSettingsMocks.useAppSettings,
}));

import { serverQueryKeys } from "~/lib/serverReactQuery";

import { EnvironmentUsageSection } from "./EnvironmentUsageSection";

function snapshot(
  provider: ServerProviderUsageSnapshot["provider"],
  limits: ServerProviderUsageSnapshot["limits"],
  usageLines: ServerProviderUsageSnapshot["usageLines"] = [],
): ServerProviderUsageSnapshot {
  return {
    provider,
    updatedAt: "2026-08-30T12:00:00.000Z",
    limits,
    usageLines,
    source: "test",
    status: "ok",
  };
}

function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
}

describe("EnvironmentUsageSection", () => {
  it("renders one row per enabled provider with every reported usage window", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [
      snapshot("codex", [
        { window: "Weekly", usedPercent: 18, windowDurationMins: 10_080 },
        { window: "5h", usedPercent: 5, windowDurationMins: 300 },
      ]),
      snapshot("claudeAgent", [{ window: "Weekly", usedPercent: 54, windowDurationMins: 10_080 }]),
    ]);
    queryClient.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);

    await render(
      <QueryClientProvider client={queryClient}>
        <EnvironmentUsageSection />
      </QueryClientProvider>,
    );

    const codex = page.getByRole("button", {
      name: "Codex usage: 5h 95% remaining, Weekly 82% remaining",
    });
    await expect.element(codex).toBeVisible();
    await expect
      .element(
        page.getByRole("button", { name: "Claude usage: Weekly 46% remaining" }),
      )
      .toBeVisible();
    await expect.element(codex.getByText("5h", { exact: true })).toBeVisible();
    await expect.element(codex.getByText("Weekly", { exact: true })).toBeVisible();

    await codex.click();

    await expect.element(page.getByText("95% left", { exact: true })).toBeVisible();
    await expect.element(page.getByText("82% left", { exact: true })).toBeVisible();
  });

  it("hides the disabled provider's row but keeps the others", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [
      snapshot("codex", [{ window: "Weekly", usedPercent: 18, windowDurationMins: 10_080 }]),
      snapshot("cursor", [{ window: "Current", usedPercent: 30 }]),
    ]);
    queryClient.setQueryData(serverQueryKeys.settings(), {
      ...DEFAULT_SERVER_SETTINGS_VIEW,
      providers: {
        ...DEFAULT_SERVER_SETTINGS_VIEW.providers,
        cursor: { ...DEFAULT_SERVER_SETTINGS_VIEW.providers.cursor, enabled: false },
      },
    });

    await render(
      <QueryClientProvider client={queryClient}>
        <EnvironmentUsageSection />
      </QueryClientProvider>,
    );

    await expect
      .element(page.getByRole("button", { name: "Codex usage: Weekly 82% remaining" }))
      .toBeVisible();
    expect(document.querySelector('button[aria-label^="Cursor usage:"]')).toBeNull();
  });

  it("shows the row from usage lines alone when the provider reports no limit windows", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [
      snapshot(
        "droid",
        [],
        [{ label: "Limits", value: "Remaining limits stay in the Droid CLI." }],
      ),
    ]);
    queryClient.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);

    await render(
      <QueryClientProvider client={queryClient}>
        <EnvironmentUsageSection />
      </QueryClientProvider>,
    );

    await expect
      .element(page.getByRole("button", { name: "Droid usage: Connected" }))
      .toBeVisible();
  });

  it("hides the section entirely when no enabled provider has anything displayable", async () => {
    const queryClient = createQueryClient();
    // Empty batch and no local/thread fallback produces rows: nothing renders, not even the
    // "Usage" label, until some source yields data.
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), []);
    queryClient.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);

    await render(
      <QueryClientProvider client={queryClient}>
        <EnvironmentUsageSection />
      </QueryClientProvider>,
    );

    expect(document.querySelector('button[aria-label*="usage:"]')).toBeNull();
    // The "Usage" label itself renders as a <p>; with every row hidden nothing may mount.
    expect(document.querySelector("p")).toBeNull();
  });
});

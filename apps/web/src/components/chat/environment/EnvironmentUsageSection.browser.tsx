// FILE: EnvironmentUsageSection.browser.tsx
// Purpose: Browser coverage for enabled-provider rows and multi-window usage summaries.

import "../../../index.css";

import { DEFAULT_SERVER_SETTINGS_VIEW, type ServerProviderUsageSnapshot } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
  document.body.innerHTML = "";
});

describe("EnvironmentUsageSection", () => {
  it("renders every enabled provider and every reported usage window", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(serverQueryKeys.allProviderUsage(), [
      snapshot("codex", [
        { window: "Weekly", usedPercent: 18, windowDurationMins: 10_080 },
        { window: "5h", usedPercent: 5, windowDurationMins: 300 },
      ]),
      snapshot("claudeAgent", [{ window: "Weekly", usedPercent: 54, windowDurationMins: 10_080 }]),
      snapshot("cursor", [{ window: "Current", usedPercent: 30 }]),
      snapshot(
        "droid",
        [],
        [
          {
            label: "Limits",
            value: "Remaining limits stay in the Droid CLI.",
          },
        ],
      ),
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

    const codex = page.getByRole("button", {
      name: "Codex usage: 5h 95% remaining, Weekly 82% remaining",
    });
    const claude = page.getByRole("button", {
      name: "Claude usage: Weekly 46% remaining",
    });
    const droid = page.getByRole("button", { name: "Droid usage: Connected" });
    await expect.element(codex).toBeVisible();
    await expect.element(claude).toBeVisible();
    await expect.element(droid).toBeVisible();
    expect(document.querySelector('button[aria-label^="Cursor usage:"]')).toBeNull();
    expect(appSettingsMocks.useAppSettings).not.toHaveBeenCalled();
    expect(queryClient.getQueryState(serverQueryKeys.providerUsage("codex", null))).toBeUndefined();
    await expect.element(page.getByText("5h", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Weekly", { exact: true }).first()).toBeVisible();

    await codex.click();

    await expect.element(page.getByText("95% left", { exact: true })).toBeVisible();
    await expect.element(page.getByText("82% left", { exact: true })).toBeVisible();

    await userEvent.keyboard("{Escape}");
    await droid.click();

    await expect
      .element(page.getByText("Remaining limits stay in the Droid CLI.", { exact: true }))
      .toBeVisible();
  });
});

import "../../index.css";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ContextWindowMeter } from "./ContextWindowMeter";
vi.mock("@tanstack/react-query", async (load) => ({
  ...(await load<object>()),
  useQuery: () => ({
    isPending: false,
    data: [{ provider: "claudeAgent", updatedAt: "2026-09-06T00:00:00Z" }],
  }),
}));
vi.mock("../ProviderUsageMenuControl", () => ({
  useProviderUsageMenuModel: () => ({
    rows: [
      {
        id: "5h",
        label: "5h",
        remainingPercent: 72,
        remainingLabel: "72%",
        remainingTone: "healthy",
        resetText: "Resets in 2h",
      },
      {
        id: "week",
        label: "Weekly",
        remainingPercent: 18,
        remainingLabel: "18%",
        remainingTone: "warning",
        resetText: "Resets in 3d",
      },
    ],
  }),
}));
it("shows account limit bars beside session usage inside the context popover", async () => {
  const screen = await render(
    <ContextWindowMeter
      provider="claudeAgent"
      usage={null}
      sessionUsage={[{ label: "↑", value: "45k", detail: "Session input" }]}
    />,
  );
  await screen
    .getByRole("button", { name: "Context window and session usage", exact: true })
    .click();
  await expect.element(screen.getByText("5h limit", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Weekly limit", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("72% left", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Session usage", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("meter", { name: "Weekly remaining", exact: true }))
    .toHaveAttribute("aria-valuenow", "18");
});

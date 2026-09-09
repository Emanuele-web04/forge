import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { memo, useState, type ReactNode } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useParams: () => null,
}));

vi.mock("../hooks/useDiffRouteSearch", () => ({
  useDiffRouteSearch: () => ({}),
}));

vi.mock("../nativeApi", () => ({
  readNativeApi: () => undefined,
  ensureNativeApi: () => {
    throw new Error("This diff preference test must not call the server.");
  },
  readNativeApiServerCapability: () => false,
  onNativeApiServerCapabilitiesChange: () => () => undefined,
}));

import DiffPanel from "./DiffPanel";

const MemoizedDiffPanel = memo(DiffPanel);
const PANEL_STATE = { panel: "diff", diffTurnId: null, diffFilePath: null } as const;

function DiffPanelHarness() {
  const [open, setOpen] = useState(true);
  const [options, setOptions] = useState<ReactNode>(null);

  return (
    <>
      <button onClick={() => setOpen((previous) => !previous)}>
        {open ? "Close panel" : "Open panel"}
      </button>
      {options}
      {open ? (
        <MemoizedDiffPanel
          hideHeader
          queriesEnabled={false}
          panelState={PANEL_STATE}
          onEditorDiffOptionsChange={setOptions}
        />
      ) : null}
    </>
  );
}

function mountPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DiffPanelHarness />
    </QueryClientProvider>,
  );
}

async function openOptions() {
  await page.getByRole("button", { name: "Diff options", exact: true }).click();
  await userEvent.keyboard("{ArrowDown}");
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

it("remembers stacked and split diff choices after closing and remounting the panel", async () => {
  const screen = await mountPanel();
  await openOptions();
  await expect
    .element(page.getByRole("menuitemradio", { name: "Split diff", exact: true }))
    .toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "Stacked diff", exact: true }).click();
  await userEvent.keyboard("{Escape}");

  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await page.getByRole("button", { name: "Open panel", exact: true }).click();
  await openOptions();
  await expect
    .element(page.getByRole("menuitemradio", { name: "Stacked diff", exact: true }))
    .toHaveAttribute("aria-checked", "true");
  await screen.unmount();

  const reopened = await mountPanel();
  await openOptions();
  await expect
    .element(page.getByRole("menuitemradio", { name: "Stacked diff", exact: true }))
    .toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "Split diff", exact: true }).click();
  await userEvent.keyboard("{Escape}");
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await page.getByRole("button", { name: "Open panel", exact: true }).click();
  await openOptions();
  await expect
    .element(page.getByRole("menuitemradio", { name: "Split diff", exact: true }))
    .toHaveAttribute("aria-checked", "true");
  await reopened.unmount();
});

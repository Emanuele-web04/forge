// FILE: workItemReactQuery.browser.tsx
// Purpose: Verifies the composer work item search debounce fires one request
//          per settled input after the 300ms window.
// Layer: Browser UI test

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WORK_ITEMS_SEARCH_DEBOUNCE_MS, useDebouncedWorkItemsSearch } from "./workItemReactQuery";

const searchCalls = vi.hoisted(() =>
  [] as Array<{ at: number; query: string }>,
);

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    workItems: {
      search: async (input: { cwd: string; query: string; limit: number }) => {
        searchCalls.push({ at: Date.now(), query: input.query });
        return { available: true, errorHint: null, items: [] };
      },
    },
  }),
}));

let queryClient: QueryClient;

function SearchProbe({ cwd, query }: { cwd: string; query: string }) {
  useDebouncedWorkItemsSearch(cwd, query, true);
  return null;
}

describe("useDebouncedWorkItemsSearch", () => {
  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    searchCalls.length = 0;
  });

  afterEach(() => {
    queryClient.clear();
  });

  it("waits the 300ms debounce before issuing a changed search", async () => {
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <SearchProbe cwd="/repo" query="" />
      </QueryClientProvider>,
    );

    // The initial empty query issues its request immediately (recent list).
    await vi.waitFor(() => {
      expect(searchCalls.length).toBe(1);
    });

    const rerenderStart = Date.now();
    await screen.rerender(
      <QueryClientProvider client={queryClient}>
        <SearchProbe cwd="/repo" query="scroll bug" />
      </QueryClientProvider>,
    );

    // Half the debounce window: the typed query must not have fired yet.
    await new Promise((resolve) => setTimeout(resolve, WORK_ITEMS_SEARCH_DEBOUNCE_MS / 2));
    expect(searchCalls).toHaveLength(1);

    // Past the window: exactly one additional request carries the typed query.
    await vi.waitFor(
      () => {
        expect(searchCalls.length).toBe(2);
      },
      { timeout: WORK_ITEMS_SEARCH_DEBOUNCE_MS * 4 },
    );
    expect(searchCalls[1]?.query).toBe("scroll bug");
    expect(searchCalls[1]!.at - rerenderStart).toBeGreaterThanOrEqual(
      WORK_ITEMS_SEARCH_DEBOUNCE_MS - 40,
    );

    await screen.unmount();
  });
});

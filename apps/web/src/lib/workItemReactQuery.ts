// FILE: workItemReactQuery.ts
// Purpose: React Query hook for debounced GitHub work item search.

import { useQuery, queryOptions } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import type { WorkItemSearchInput, WorkItemSearchResult } from "@synara/contracts";
import { ensureNativeApi } from "~/nativeApi";

export const WORK_ITEMS_SEARCH_DEBOUNCE_MS = 300;

export const workItemQueryKeys = {
  search: (input: WorkItemSearchInput | null) =>
    ["work-items", "search", input?.cwd ?? "", input?.query ?? "", input?.limit ?? 20] as const,
};

export function workItemsSearchQueryOptions(input: WorkItemSearchInput | null) {
  return queryOptions({
    queryKey: workItemQueryKeys.search(input),
    queryFn: async () => {
      if (!input) {
        return { available: false, errorHint: "No project directory.", items: [] };
      }
      return ensureNativeApi().workItems.search(input);
    },
    enabled: input !== null,
    staleTime: 30_000,
    gcTime: 10 * 60_000,
  });
}

export function useWorkItemsSearch(input: WorkItemSearchInput | null) {
  return useQuery(workItemsSearchQueryOptions(input));
}

export function useDebouncedWorkItemsSearch(cwd: string | null, query: string, enabled: boolean) {
  const [debouncedQuery, setDebouncedQuery] = useState(query);

  useEffect(() => {
    if (!enabled) {
      setDebouncedQuery(query);
      return;
    }
    const handle = setTimeout(() => setDebouncedQuery(query), WORK_ITEMS_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query, enabled]);

  const input = useMemo<WorkItemSearchInput | null>(() => {
    if (!cwd) return null;
    return { cwd, query: debouncedQuery, limit: 20 };
  }, [cwd, debouncedQuery]);

  return useWorkItemsSearch(input);
}

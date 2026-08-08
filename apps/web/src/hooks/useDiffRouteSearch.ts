// FILE: useDiffRouteSearch.ts
// Purpose: Stable router-search hook for the normalized chat/diff route state.
// Layer: Web routing hook
// Exports: useDiffRouteSearch

import { useSearch } from "@tanstack/react-router";

import {
  diffRouteSearchEquals,
  type DiffRouteSearch,
  parseDiffRouteSearch,
} from "../diffRouteSearch";

function createStableDiffRouteSearchSelector() {
  let previous: DiffRouteSearch | null = null;
  return (search: Record<string, unknown>): DiffRouteSearch => {
    const next = parseDiffRouteSearch(search);
    if (previous && diffRouteSearchEquals(previous, next)) {
      return previous;
    }
    previous = next;
    return next;
  };
}

const selectStableDiffRouteSearch = createStableDiffRouteSearchSelector();

// `parseDiffRouteSearch` returns a new object. Keep one stable selector instance
// so unchanged search values reuse the previous snapshot. TanStack structural
// sharing is not usable here because `TurnId` is an Effect-branded string.
export function useDiffRouteSearch() {
  return useSearch({
    strict: false,
    select: selectStableDiffRouteSearch,
  });
}

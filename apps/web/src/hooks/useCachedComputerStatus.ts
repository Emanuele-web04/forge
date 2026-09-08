// FILE: useCachedComputerStatus.ts
// Purpose: Read the desktop backend's status if some other surface has already asked,
//          without being the thing that asks.
// Layer: Web data hook
// Exports: useCachedComputerStatus
//
// Reading computer status is not free: on macOS `getStatus` resolves the backend,
// which starts the helper and can put a permission dialog on screen. Surfaces
// that merely want to *describe* the desktop — the settings search, which decides
// whether a row exists at all — must never trigger that. This subscribes to the
// same query the Computer settings panel owns and returns whatever it has
// fetched, or undefined.

import type { ComputerStatusResult } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";

import { computerStatusQueryOptions } from "~/lib/serverReactQuery";

export function useCachedComputerStatus(): ComputerStatusResult | undefined {
  return useQuery({ ...computerStatusQueryOptions(), enabled: false }).data;
}

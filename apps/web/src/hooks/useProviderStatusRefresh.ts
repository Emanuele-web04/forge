// FILE: useProviderStatusRefresh.ts
// Purpose: Shared provider-status refresh hooks — focus/periodic version checks plus an
//          imperative refresh callback for UI affordances (voice auth retry, banners).
// Layer: Web hooks
// Exports: useProviderStatusRefresh, useRefreshProviderStatusesNow

import { useEffect } from "react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import type { ServerProviderStatus } from "@synara/contracts";
import { toastManager } from "../components/ui/toast";
import { readNativeApi } from "../nativeApi";
import { reconcileServerProviderStatuses } from "../lib/serverReactQuery";

export type RefreshProviderStatusesOptions = {
  readonly silent?: boolean;
};

export type RefreshProviderStatusesNow = (
  options?: RefreshProviderStatusesOptions,
) => Promise<readonly ServerProviderStatus[] | null>;

function writeProviderStatusesToConfigCache(
  queryClient: QueryClient,
  providers: readonly ServerProviderStatus[],
) {
  return reconcileServerProviderStatuses(queryClient, providers);
}

/**
 * Imperative one-shot provider-status refresh: re-checks providers on the server
 * and folds the result into the cached server config. Surfaces failures as a toast.
 */
export function useRefreshProviderStatusesNow(): RefreshProviderStatusesNow {
  const queryClient = useQueryClient();
  return async (options?: RefreshProviderStatusesOptions) => {
    const api = readNativeApi();
    if (!api) return null;
    try {
      const result = await api.server.refreshProviders();
      await writeProviderStatusesToConfigCache(queryClient, result.providers);
      return result.providers;
    } catch (error) {
      if (!options?.silent) {
        toastManager.add({
          type: "error",
          title: "Unable to refresh provider status",
          description:
            error instanceof Error ? error.message : "Unknown error refreshing provider status.",
        });
      }
      return null;
    }
  };
}

type ProviderStatusRefreshOptions = {
  readonly enabled?: boolean;
  readonly initialDelayMs?: number;
  readonly intervalMs?: number;
  readonly minIntervalMs?: number;
  readonly refreshOnFocus?: boolean;
};

export function useProviderStatusRefresh(options: ProviderStatusRefreshOptions): void {
  const queryClient = useQueryClient();
  const enabled = options.enabled ?? true;
  const initialDelayMs = options.initialDelayMs;
  const intervalMs = options.intervalMs;
  const minIntervalMs = options.minIntervalMs ?? 0;
  const refreshOnFocus = options.refreshOnFocus ?? false;

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof document === "undefined") {
      return;
    }

    let disposed = false;
    let lastRefreshAtMs = 0;
    const refreshProviderStatuses = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      const nowMs = Date.now();
      if (minIntervalMs > 0 && nowMs - lastRefreshAtMs < minIntervalMs) {
        return;
      }
      const api = readNativeApi();
      if (!api) {
        return;
      }
      lastRefreshAtMs = nowMs;
      void api.server
        .refreshProviders()
        .then((result) => {
          if (disposed) {
            return;
          }
          return writeProviderStatusesToConfigCache(queryClient, result.providers);
        })
        .catch(() => undefined);
    };

    const initialRefreshId =
      typeof initialDelayMs === "number" && initialDelayMs >= 0
        ? window.setTimeout(refreshProviderStatuses, initialDelayMs)
        : null;
    const refreshIntervalId =
      typeof intervalMs === "number" && intervalMs > 0
        ? window.setInterval(refreshProviderStatuses, intervalMs)
        : null;

    if (refreshOnFocus) {
      window.addEventListener("focus", refreshProviderStatuses);
      document.addEventListener("visibilitychange", refreshProviderStatuses);
    }

    return () => {
      disposed = true;
      if (initialRefreshId !== null) {
        window.clearTimeout(initialRefreshId);
      }
      if (refreshIntervalId !== null) {
        window.clearInterval(refreshIntervalId);
      }
      if (refreshOnFocus) {
        window.removeEventListener("focus", refreshProviderStatuses);
        document.removeEventListener("visibilitychange", refreshProviderStatuses);
      }
    };
  }, [enabled, initialDelayMs, intervalMs, minIntervalMs, queryClient, refreshOnFocus]);
}

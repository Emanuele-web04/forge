// FILE: ProviderUsageSettingsPanel.tsx
// Purpose: Settings → Usage panel. One card per supported provider showing live remaining
// quota/credits with linear progress meters, the provider brand icon, and plan/status pills.
// Usage is fetched read-only from each CLI's stored credentials by the server.

import type { ServerProviderUsageSnapshot } from "@synara/contracts";
import {
  PROVIDER_USAGE_PROVIDERS,
  providerUsageDisplayName,
  providerUsageNeedsAuthDetail,
  selectVisibleProviderUsageSnapshots,
} from "@synara/shared/providerUsage";
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAppSettings } from "~/appSettings";
import { ProviderIcon } from "~/components/ProviderIcon";
import { ProviderUsageLimitRows } from "~/components/ProviderUsageLimitRows";
import { ProviderUsageLineList } from "~/components/ProviderUsageLineList";
import { SettingsCard, SettingsSectionShell } from "~/components/settings/SettingsPanelPrimitives";
import { Button } from "~/components/ui/button";
import { useProviderUsageSummary } from "~/hooks/useProviderUsageSummary";
import { RotateCcwIcon, TriangleAlertIcon } from "~/lib/icons";
import { deriveProviderUsageDisplayRows } from "~/lib/providerUsageDisplay";
import { deriveAccountRateLimits, type ProviderRateLimit } from "~/lib/rateLimits";
import {
  fetchAllProviderUsage,
  serverAllProviderUsageQueryOptions,
  serverQueryKeys,
} from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { useStore } from "~/store";
import { createAllThreadsSelector } from "~/storeSelectors";

const PILL_CLASS_NAME = "shrink-0 rounded-full px-2 py-1 text-[11px] font-medium leading-none";

interface StatusPill {
  label: string;
  className: string;
}

function statusPill(status: ServerProviderUsageSnapshot["status"]): StatusPill | null {
  switch (status) {
    case "needs-auth":
      return {
        label: "Not signed in",
        className: "bg-amber-500/12 text-amber-600 dark:text-amber-400",
      };
    case "unsupported":
      return { label: "Unsupported", className: "bg-muted text-muted-foreground" };
    case "error":
      return { label: "Unavailable", className: "bg-red-500/12 text-red-600 dark:text-red-400" };
    default:
      return null;
  }
}

function ProviderUsageCard({
  snapshot,
  threadRateLimits,
  codexHomePath,
}: {
  snapshot: ServerProviderUsageSnapshot;
  threadRateLimits: ReadonlyArray<ProviderRateLimit>;
  codexHomePath: string | null;
}) {
  const provider = snapshot.provider;
  const status = snapshot.status ?? "ok";
  const usageSummary = useProviderUsageSummary({
    provider,
    threadRateLimits,
    codexHomePath,
    providerSnapshot: snapshot,
  });
  const meterRows = deriveProviderUsageDisplayRows(usageSummary.rateLimits);
  const usageLines = usageSummary.usageLines;

  const hasUsage = meterRows.length > 0 || usageLines.length > 0;
  const pill = status === "ok" ? null : statusPill(snapshot.status);

  return (
    <SettingsCard>
      <div className="space-y-3.5 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-[color:var(--color-border)] bg-muted/60">
              <ProviderIcon provider={provider} className="size-4" />
            </span>
            <span className="truncate text-sm font-semibold text-foreground">
              {providerUsageDisplayName(provider)}
            </span>
          </div>
          {status === "ok" && snapshot.planName ? (
            <span className={cn(PILL_CLASS_NAME, "bg-muted text-muted-foreground")}>
              {snapshot.planName}
            </span>
          ) : pill ? (
            <span className={cn(PILL_CLASS_NAME, pill.className)}>{pill.label}</span>
          ) : null}
        </div>

        {status === "ok" && hasUsage ? (
          <>
            {usageSummary.usageNotice ? (
              <p className="flex items-start gap-1.5 text-xs leading-relaxed text-amber-600 dark:text-amber-300/90">
                <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>{usageSummary.usageNotice}</span>
              </p>
            ) : null}
            {meterRows.length > 0 ? (
              <ProviderUsageLimitRows rows={meterRows} surface="settings" />
            ) : null}
            {usageLines.length > 0 ? (
              <ProviderUsageLineList
                className={cn(
                  meterRows.length > 0 && "border-t border-[color:var(--color-border)] pt-3",
                )}
                lines={usageLines}
                surface="settings"
              />
            ) : null}
          </>
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {status === "ok"
              ? "No usage data reported yet."
              : (snapshot.detail ?? providerUsageNeedsAuthDetail(provider))}
          </p>
        )}
      </div>
    </SettingsCard>
  );
}

function mergeProviderUsageRefresh(
  previous: readonly ServerProviderUsageSnapshot[] | undefined,
  next: readonly ServerProviderUsageSnapshot[],
): readonly ServerProviderUsageSnapshot[] {
  if (!previous) {
    return next;
  }
  const previousByProvider = new Map(previous.map((snapshot) => [snapshot.provider, snapshot]));
  const nextByProvider = new Map(next.map((snapshot) => [snapshot.provider, snapshot]));
  return PROVIDER_USAGE_PROVIDERS.map(
    (provider) => nextByProvider.get(provider) ?? previousByProvider.get(provider),
  ).filter((snapshot): snapshot is ServerProviderUsageSnapshot => snapshot !== undefined);
}

export function ProviderUsageSettingsPanel() {
  const queryClient = useQueryClient();
  const { settings } = useAppSettings();
  const codexHomePath = settings.codexHomePath || null;
  const threads = useStore(useMemo(() => createAllThreadsSelector(), []));
  // Account/thread fallback rows are shared by every provider card; derive them once per panel.
  const threadRateLimits = deriveAccountRateLimits(threads);
  const usageQuery = useQuery(serverAllProviderUsageQueryOptions());
  const refreshMutation = useMutation({
    mutationFn: () => fetchAllProviderUsage({ forceRefresh: true }),
    onSuccess: (data) => {
      queryClient.setQueryData<readonly ServerProviderUsageSnapshot[]>(
        serverQueryKeys.allProviderUsage(),
        (previous) => mergeProviderUsageRefresh(previous, data),
      );
    },
  });

  // Use the live payload only. Inventing error placeholders for omitted providers
  // would count as "connected" and hide unsigned cards.
  const cards = selectVisibleProviderUsageSnapshots(usageQuery.data ?? []);

  const showInitialLoading = usageQuery.isPending && !usageQuery.data;

  const isRefreshing = usageQuery.isFetching || refreshMutation.isPending;

  return (
    <SettingsSectionShell
      title="Provider usage"
      action={
        <Button
          size="xs"
          variant="outline"
          className="shrink-0"
          disabled={isRefreshing}
          onClick={() => refreshMutation.mutate()}
        >
          <RotateCcwIcon className={cn("size-3.5", isRefreshing && "animate-spin")} />
          Refresh
        </Button>
      }
    >
      {showInitialLoading ? (
        <SettingsCard>
          <div className="px-4 py-3.5 text-xs text-muted-foreground">Loading provider usage…</div>
        </SettingsCard>
      ) : (
        <div className="flex flex-col gap-3">
          {cards.map((snapshot) => (
            <ProviderUsageCard
              key={snapshot.provider}
              snapshot={snapshot}
              threadRateLimits={threadRateLimits}
              codexHomePath={codexHomePath}
            />
          ))}
        </div>
      )}

      <p className="px-2 text-[11px] leading-relaxed text-muted-foreground">
        Usage is read locally from each provider CLI&apos;s stored credentials and fetched directly
        from the provider. The list follows whatever you are signed into; unsigned providers stay
        visible until any account is connected, then drop away. Short-lived tokens are refreshed
        through the provider&apos;s own CLI or official token endpoint.
      </p>
    </SettingsSectionShell>
  );
}

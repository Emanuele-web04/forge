// FILE: ProviderUsageSettingsPanel.tsx
// Purpose: Settings → Usage panel. One card per supported provider showing live remaining
// quota/credits with linear progress meters, the provider brand icon, and plan/status pills.
// Usage is fetched read-only from each CLI's stored credentials by the server.

import type {
  ProviderKind,
  ServerProviderUsageActivity,
  ServerProviderUsageSnapshot,
} from "@synara/contracts";
import {
  PROVIDER_USAGE_PROVIDERS,
  providerUsageDisplayName,
  providerUsageNeedsAuthDetail,
  selectVisibleProviderUsageSnapshots,
} from "@synara/shared/providerUsage";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ProviderIcon } from "~/components/ProviderIcon";
import { ProviderUsageLimitRows } from "~/components/ProviderUsageLimitRows";
import { ProviderUsageLineList } from "~/components/ProviderUsageLineList";
import { ProviderUsageActivityCard } from "~/components/settings/ProviderUsageActivityCard";
import { SettingsCard, SettingsSectionShell } from "~/components/settings/SettingsPanelPrimitives";
import { Button } from "~/components/ui/button";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { useProviderUsageSummary } from "~/hooks/useProviderUsageSummary";
import { RotateCcwIcon, TriangleAlertIcon } from "~/lib/icons";
import { deriveProviderUsageDisplayRows } from "~/lib/providerUsageDisplay";
import { deriveAccountRateLimits, type ProviderRateLimit } from "~/lib/rateLimits";
import {
  fetchAllProviderUsage,
  serverAllProviderUsageQueryOptions,
  serverProfileTokenStatsQueryOptions,
  serverQueryKeys,
} from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { useStore } from "~/store";
import { createAllThreadsSelector } from "~/storeSelectors";
import { formatCompact, formatNumber } from "~/components/profile/profileFormatting";

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

function formatActivityCost(value: number | null | undefined): string {
  if (value === null || value === undefined) return "Not reported";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function ProviderUsageMachineActivity({
  activity,
  provider,
}: {
  activity: ServerProviderUsageActivity;
  provider: ProviderKind;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const breakdownId = `provider-machine-activity-breakdown-${provider}`;
  const period = activity.periods.find((entry) => entry.id === "30d") ?? activity.periods[0];
  if (!period) {
    return (
      <div className="rounded-lg border border-[color:var(--color-border)] bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
        On this machine: {activity.detail ?? "no token-bearing sessions found in the last 30 days."}
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-[color:var(--color-border)] bg-muted/20 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">On this machine</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {activity.source.replace(/-local-sqlite$/u, " local history")} · measured tokens
          </p>
        </div>
        <span className={cn(PILL_CLASS_NAME, "bg-muted text-muted-foreground")}>30 days</span>
      </div>

      {activity.status === "partial" && activity.detail ? (
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-600 dark:text-amber-300/90">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{activity.detail}</span>
        </p>
      ) : null}

      <div className="grid grid-cols-3 divide-x divide-border/60 rounded-lg border border-border/60 bg-background/40">
        <div className="px-2 py-2 text-center">
          <p className="text-sm font-semibold tabular-nums text-foreground">
            {formatCompact(period.tokens.total)}
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">tokens</p>
        </div>
        <div className="px-2 py-2 text-center">
          <p className="text-sm font-semibold tabular-nums text-foreground">
            {formatNumber(period.sessions)}
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">sessions</p>
        </div>
        <div className="px-2 py-2 text-center">
          <p className="text-sm font-semibold tabular-nums text-foreground">
            {formatActivityCost(period.recordedCostUsd)}
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">recorded cost</p>
        </div>
      </div>

      <Button
        type="button"
        variant="ghost"
        className="min-h-9 w-full justify-between px-1 text-xs text-muted-foreground hover:text-foreground"
        aria-expanded={detailsOpen}
        aria-controls={breakdownId}
        onClick={() => setDetailsOpen((open) => !open)}
      >
        <span>{detailsOpen ? "Hide model breakdown" : "View model breakdown"}</span>
        <DisclosureChevron open={detailsOpen} className="size-3.5" />
      </Button>
      <DisclosureRegion open={detailsOpen}>
        <div id={breakdownId} className="space-y-1.5 border-t border-border/60 pt-3">
          {activity.breakdown.slice(0, 8).map((entry) => (
            <div
              key={`${entry.upstreamProviderId ?? "direct"}:${entry.model}`}
              className="flex items-center justify-between gap-3 text-xs"
            >
              <span className="min-w-0 truncate text-foreground">
                {entry.upstreamProviderId ? `${entry.upstreamProviderId} · ` : ""}
                {entry.model}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {formatCompact(entry.tokens.total)} · {formatNumber(entry.sessions)} sessions
              </span>
            </div>
          ))}
        </div>
      </DisclosureRegion>
    </div>
  );
}

function ProviderUsageCard({
  snapshot,
  threadRateLimits,
}: {
  snapshot: ServerProviderUsageSnapshot;
  threadRateLimits: ReadonlyArray<ProviderRateLimit>;
}) {
  const provider = snapshot.provider;
  const status = snapshot.status ?? "ok";
  const usageSummary = useProviderUsageSummary({
    provider,
    threadRateLimits,
    providerSnapshot: snapshot,
  });
  const meterRows = deriveProviderUsageDisplayRows(usageSummary.rateLimits);
  const usageLines = usageSummary.usageLines;

  const hasAccountUsage = meterRows.length > 0 || usageLines.length > 0;
  const canShowAccountUsage = hasAccountUsage && (status === "ok" || status === "unsupported");
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

        {canShowAccountUsage ? (
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
              ? "No account usage data reported yet."
              : (snapshot.detail ?? providerUsageNeedsAuthDetail(provider))}
          </p>
        )}
        {snapshot.activity ? (
          <ProviderUsageMachineActivity provider={provider} activity={snapshot.activity} />
        ) : null}
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
  const threads = useStore(useMemo(() => createAllThreadsSelector(), []));
  // Account/thread fallback rows are shared by every provider card; derive them once per panel.
  const threadRateLimits = deriveAccountRateLimits(threads);
  const usageQuery = useQuery(serverAllProviderUsageQueryOptions());
  const tokenUsageQuery = useQuery(serverProfileTokenStatsQueryOptions());
  const refreshMutation = useMutation({
    mutationFn: () => fetchAllProviderUsage({ forceRefresh: true }),
    onSuccess: (data) => {
      queryClient.setQueryData<readonly ServerProviderUsageSnapshot[]>(
        serverQueryKeys.allProviderUsage(),
        (previous) => mergeProviderUsageRefresh(previous, data),
      );
      void queryClient.invalidateQueries({
        queryKey: serverProfileTokenStatsQueryOptions().queryKey,
      });
    },
  });

  // Use the live payload only. Inventing error placeholders for omitted providers
  // would count as "connected" and hide unsigned cards.
  const cards = selectVisibleProviderUsageSnapshots(usageQuery.data ?? []);

  const showInitialLoading = usageQuery.isPending && !usageQuery.data;

  const isRefreshing = usageQuery.isFetching || refreshMutation.isPending;

  const liveStatusCounts = cards.reduce(
    (counts, snapshot) => {
      const status: NonNullable<ServerProviderUsageSnapshot["status"]> = snapshot.status ?? "ok";
      counts[status] = (counts[status] ?? 0) + 1;
      return counts;
    },
    {} as Partial<Record<NonNullable<ServerProviderUsageSnapshot["status"]>, number>>,
  );
  const providersWithLimits = cards.filter(
    (snapshot) => (snapshot.status ?? "ok") === "ok" && snapshot.limits.length > 0,
  ).length;
  const providersWithMachineActivity = cards.filter(
    (snapshot) => snapshot.activity?.status === "ok" || snapshot.activity?.status === "partial",
  ).length;
  const lastUpdated = cards.reduce((latest, snapshot) => {
    const time = Date.parse(snapshot.updatedAt);
    return Number.isNaN(time) || time <= latest ? latest : time;
  }, 0);
  const updatedLabel =
    lastUpdated > 0
      ? new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date(lastUpdated))
      : "—";

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
        <>
          {/* Coverage strip: how many providers actually report data right now.
              Mirrors the opencode.ai/data density (totals + freshness in one
              row) without cloning its leaderboard design. */}
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border/60 bg-border/60 text-xs sm:grid-cols-4">
            <SummaryCell value={String(providersWithLimits)} label="with account limits" />
            <SummaryCell
              value={String(providersWithMachineActivity)}
              label="with machine history"
            />
            <SummaryCell value={String(liveStatusCounts.ok ?? 0)} label="sources responding" />
            <SummaryCell value={updatedLabel} label="last refreshed" />
          </div>

          <div className="flex flex-col gap-3">
            {cards.map((snapshot) => (
              <ProviderUsageCard
                key={snapshot.provider}
                snapshot={snapshot}
                threadRateLimits={threadRateLimits}
              />
            ))}
          </div>
        </>
      )}

      <ProviderUsageActivityCard
        usage={tokenUsageQuery.data?.providerUsage ?? []}
        isLoading={tokenUsageQuery.isPending}
        isError={tokenUsageQuery.isError}
        onRetry={() => void tokenUsageQuery.refetch()}
      />

      <p className="px-2 text-[11px] leading-relaxed text-muted-foreground">
        Account limits come from provider-owned sources: Codex, Claude, and Cursor read the provider
        backend through stored credentials; Antigravity reads the local Antigravity process quota
        server when it is running. Providers without a safe source (Grok, Droid, OpenCode, Pi) stay
        marked “Unsupported” rather than showing invented numbers. “On this machine” history comes
        from provider-owned local archives (Codex, Claude, OpenCode, Grok) when Synara has a safe
        reader; “Actual usage” below is Synara-observed activity. Account limits never include local
        totals. If a provider shows “Not signed in”, re-authenticate with its CLI.
      </p>
    </SettingsSectionShell>
  );
}

function SummaryCell({ value, label }: { value: string; label: string }) {
  return (
    <div className="min-w-0 bg-background px-3 py-2">
      <div className="truncate text-sm font-semibold tabular-nums text-foreground">{value}</div>
      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

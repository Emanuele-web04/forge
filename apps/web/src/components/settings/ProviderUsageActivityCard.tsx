// FILE: ProviderUsageActivityCard.tsx
// Purpose: Compact local activity summary kept separate from account limits.
// Actual usage is measured from Synara's projected turns, not inferred from a
// provider quota percentage.

import type { ProfileTokenProviderUsage } from "@synara/contracts";
import { PROVIDER_DISPLAY_NAMES } from "@synara/contracts";
import { useState } from "react";

import { ProviderIcon } from "~/components/ProviderIcon";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Button } from "~/components/ui/button";
import { SettingsCard, SettingsEmptyState } from "~/components/settings/SettingsPanelPrimitives";
import { formatCompact, formatNumber } from "~/components/profile/profileFormatting";
import { providerUsageDisplayName } from "@synara/shared/providerUsage";
import { cn } from "~/lib/utils";

const COST_FORMATTER = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

function formatCost(costUsd: number | null): string {
  return costUsd === null ? "Not reported" : COST_FORMATTER.format(costUsd);
}

function formatLastUsedAt(value: string | null): string {
  if (!value) return "No recent turn";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "No recent turn"
    : `Last used ${new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(parsed)}`;
}

function tokenCoverageOf(
  entry: ProfileTokenProviderUsage,
): "complete" | "partial" | "not-reported" {
  return entry.tokenCoverage ?? (entry.tokensReported ? "complete" : "not-reported");
}

function ProviderActivityDetail({ usage }: { usage: ProfileTokenProviderUsage }) {
  return (
    <div className="space-y-3 border-t border-[color:var(--color-border)] pt-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span>{formatLastUsedAt(usage.lastUsedAt)}</span>
        <span>{formatNumber(usage.threadCount)} threads</span>
      </div>

      {usage.models.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-muted-foreground">Models</p>
          <div className="space-y-1.5">
            {usage.models.slice(0, 5).map((model) => (
              <div
                key={`${model.provider}:${model.model}`}
                className="flex items-center justify-between gap-3 text-xs"
              >
                <span className="min-w-0 truncate text-foreground">
                  {model.upstreamProviderId ? `${model.upstreamProviderId} · ` : ""}
                  {model.model}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {model.tokens > 0 ? formatCompact(model.tokens) : "Not reported"} tokens
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {usage.history.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-muted-foreground">Recent history</p>
          <div className="space-y-1.5">
            {usage.history.slice(0, 7).map((entry) => (
              <div
                key={`${usage.provider}:${entry.day}`}
                className="flex items-center justify-between gap-3 text-xs"
              >
                <span className="text-muted-foreground">{entry.day}</span>
                <span className="shrink-0 tabular-nums text-foreground">
                  {entry.tokens > 0
                    ? `${formatCompact(entry.tokens)} tokens · ${formatNumber(entry.turnCount)} turns`
                    : `Not reported · ${formatNumber(entry.turnCount)} turns`}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ProviderUsageActivityCard({
  usage,
  isLoading,
  isError,
  onRetry,
}: {
  usage: ReadonlyArray<ProfileTokenProviderUsage>;
  isLoading: boolean;
  isError?: boolean;
  onRetry?: () => void;
}) {
  const hasError = isError ?? false;
  const retry = onRetry ?? (() => undefined);
  const [detailsOpen, setDetailsOpen] = useState(false);

  if (isLoading) {
    return (
      <SettingsCard>
        <div className="px-4 py-3.5 text-xs text-muted-foreground">Loading actual usage…</div>
      </SettingsCard>
    );
  }

  if (hasError && usage.length === 0) {
    return (
      <SettingsEmptyState layout="status" tone="destructive">
        <div className="flex items-center justify-between gap-3">
          <span>Actual usage is unavailable.</span>
          <Button type="button" variant="outline" size="xs" onClick={retry}>
            Try again
          </Button>
        </div>
      </SettingsEmptyState>
    );
  }

  if (usage.length === 0) {
    return (
      <SettingsEmptyState layout="status">No usage recorded in Synara yet.</SettingsEmptyState>
    );
  }

  const totalTokens = usage.reduce((sum, entry) => sum + entry.tokens, 0);
  const totalTurns = usage.reduce((sum, entry) => sum + entry.turnCount, 0);
  const reportedCosts = usage.filter((entry) => entry.costUsd !== null);
  const totalCost = reportedCosts.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0);
  const costCoverage = usage.map(
    (entry) => entry.costCoverage ?? (entry.costUsd === null ? "not-reported" : "complete"),
  );
  const hasPartialCost = costCoverage.some((coverage) => coverage !== "complete");
  const tokenCoverage = usage.map((entry) => tokenCoverageOf(entry));
  const hasReportedTokens = tokenCoverage.some((coverage) => coverage !== "not-reported");
  const hasPartialTokens = tokenCoverage.some((coverage) => coverage === "partial");
  const tokenSummary = !hasReportedTokens
    ? "Not reported"
    : hasPartialTokens
      ? `${formatCompact(totalTokens)} partial`
      : formatCompact(totalTokens);
  const costSummary =
    reportedCosts.length === 0
      ? "Not reported"
      : !hasPartialCost && reportedCosts.length === usage.length
        ? formatCost(totalCost)
        : `${formatCost(totalCost)} partial`;

  return (
    <SettingsCard divided={false}>
      {hasError ? (
        <SettingsEmptyState layout="status" tone="destructive">
          <div className="flex items-center justify-between gap-3">
            <span>Actual usage could not be refreshed; showing the last available values.</span>
            <Button type="button" variant="outline" size="xs" onClick={retry}>
              Try again
            </Button>
          </div>
        </SettingsEmptyState>
      ) : null}
      <div className="space-y-4 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">Actual usage</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Local Synara history. Token totals include retained deleted-thread aggregates when
              available; turn and cost detail covers retained projections.
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-[11px] text-muted-foreground">
            {usage.length} providers
          </span>
        </div>

        <div className="grid grid-cols-3 divide-x divide-border/60 rounded-xl border border-border/60 bg-muted/20">
          <Summary value={tokenSummary} label="Tokens" />
          <Summary value={formatNumber(totalTurns)} label="Turns" />
          <Summary value={costSummary} label="Cost" />
        </div>

        <div className="space-y-1.5">
          {usage.map((entry) => {
            const providerLabel =
              entry.provider === "unknown"
                ? "Unknown provider"
                : (PROVIDER_DISPLAY_NAMES[entry.provider] ??
                  providerUsageDisplayName(entry.provider));
            return (
              <div
                key={entry.provider}
                className="flex items-center justify-between gap-3 rounded-lg px-1 py-1.5"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  {entry.provider === "unknown" ? (
                    <span className="size-4 shrink-0 rounded-full bg-muted" />
                  ) : (
                    <ProviderIcon provider={entry.provider} className="size-4 shrink-0" />
                  )}
                  <span className="truncate text-xs font-medium text-foreground">
                    {providerLabel}
                  </span>
                </span>
                <span className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {entry.tokensReported
                    ? `${formatCompact(entry.tokens)}${
                        tokenCoverageOf(entry) === "partial" ? " partial" : ""
                      }`
                    : "Not reported"}{" "}
                  tokens · {formatNumber(entry.turnCount)} turns
                </span>
              </div>
            );
          })}
        </div>

        <Button
          type="button"
          variant="ghost"
          className="min-h-11 w-full justify-between px-2 text-xs text-muted-foreground hover:text-foreground"
          aria-expanded={detailsOpen}
          aria-controls="provider-usage-activity-details"
          onClick={() => setDetailsOpen((open) => !open)}
        >
          <span>{detailsOpen ? "Hide breakdown" : "View breakdown"}</span>
          <DisclosureChevron open={detailsOpen} className="size-3.5" />
        </Button>

        <DisclosureRegion open={detailsOpen}>
          <div id="provider-usage-activity-details" className="space-y-4">
            {usage.map((entry) => (
              <ProviderActivityDetail key={entry.provider} usage={entry} />
            ))}
          </div>
        </DisclosureRegion>
      </div>
    </SettingsCard>
  );
}

function Summary({ value, label }: { value: string; label: string }) {
  return (
    <div className={cn("min-w-0 px-2 py-3 text-center", label === "Cost" && "sm:px-3")}>
      <div className="truncate text-sm font-semibold tabular-nums text-foreground">{value}</div>
      <div className="mt-1 text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

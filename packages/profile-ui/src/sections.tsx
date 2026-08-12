// FILE: sections.tsx
// Purpose: Small stat-display building blocks shared by the in-app profile panel and the
// public profile page: stat tiles, insight rows, and model-usage rows. App-specific
// visuals (provider icons) are injected as ReactNode slots so this package stays free of
// app dependencies.
// Layer: profile-ui shared components.

import type { ReactNode } from "react";
import { Skeleton } from "./skeleton";

export function StatTile({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col items-center gap-0.5 px-3 py-3">
      {value === null ? (
        <Skeleton className="h-4 w-12" />
      ) : (
        <span className="text-sm font-normal tabular-nums text-foreground">{value}</span>
      )}
      <span className="text-sm font-normal text-muted-foreground">{label}</span>
    </div>
  );
}

export function StatTileGrid({
  tiles,
}: {
  tiles: readonly { label: string; value: string | null }[];
}) {
  return (
    <div className="grid grid-cols-2 divide-x divide-y divide-border/50 overflow-hidden rounded-2xl border border-border/60 sm:grid-cols-3 lg:grid-cols-5 lg:divide-y-0">
      {tiles.map((tile) => (
        <StatTile key={tile.label} label={tile.label} value={tile.value} />
      ))}
    </div>
  );
}

export function InsightRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm font-normal tabular-nums" title={value}>
        {value}
      </dd>
    </div>
  );
}

export function ModelUsageRow({
  icon,
  model,
  percent,
  detail,
  stat,
}: {
  /** Leading provider/model icon, e.g. the web app's `<ProviderIcon />`. */
  icon: ReactNode;
  model: string;
  percent: number;
  /** Optional muted context after the model name, e.g. "Codex · xhigh". */
  detail?: string;
  /** Right-hand stat label; defaults to "{percent}%" (public page passes "17bn · 42%"). */
  stat?: string;
}) {
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="flex min-w-0 items-center gap-2">
          {icon}
          <span className="truncate">
            {model}
            {detail ? <span className="text-muted-foreground"> · {detail}</span> : null}
          </span>
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{stat ?? `${percent}%`}</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-[var(--info)]"
          style={{ width: `${Math.min(100, Math.max(2, percent))}%` }}
        />
      </div>
    </li>
  );
}

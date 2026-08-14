// FILE: ShareCard.tsx
// Purpose: Fixed-size, theme-independent "virality" card rendered to PNG via html-to-image.
// Uses explicit colors (not theme tokens) so the exported image looks identical in light
// and dark mode. Fixed width AND height keep the exported PNG a clean wide card with no
// trailing whitespace, regardless of how dense the heatmap data is.
// Layer: web profile feature.

import { forwardRef, type ReactNode } from "react";
import type { ProfileStats, ProfileTokenStats } from "@synara/contracts";
import { ProviderIcon } from "~/components/ProviderIcon";
import { SynaraLogo } from "~/components/SynaraLogo";
import { ActivityHeatmap, CARD_HEATMAP_INTENSITY_CLASSES } from "./ActivityHeatmap";
import { ProfileAvatar } from "./ProfileAvatar";
import { formatCompact, formatDays } from "./profileFormatting";
import { selectProfileHeatmap, selectProfileTopProvider } from "./profileSelectors";

export const SHARE_CARD_WIDTH = 860;
export const SHARE_CARD_HEIGHT = 440;

// The in-app panel shows a longer window; the share card trims to the most recent ~6 months
// so the grid stays large and legible inside the fixed card width.
const CARD_HEATMAP_DAYS = 183;

// Shared styling for the large stat value, reused so the provider tile's icon + percent
// line up with the text-only tiles.
const VALUE_CLASS = "text-2xl font-normal leading-none tracking-tight";

interface ShareCardProps {
  readonly stats: ProfileStats;
  readonly tokenStats: ProfileTokenStats | null;
  readonly displayName: string;
  readonly handle: string;
  readonly avatarColor: string;
  readonly avatarImage: string | null;
}

interface Tile {
  readonly key: string;
  readonly value: ReactNode;
  readonly label: string;
}

export const ShareCard = forwardRef<HTMLDivElement, ShareCardProps>(function ShareCard(
  { stats, tokenStats, displayName, handle, avatarColor, avatarImage },
  ref,
) {
  const topProvider = selectProfileTopProvider(stats, tokenStats);

  const tiles: Tile[] = [
    {
      key: "lifetime",
      value: (
        <span className={VALUE_CLASS}>
          {formatCompact(tokenStats?.lifetimeTotalTokens ?? null)}
        </span>
      ),
      label: "lifetime tokens",
    },
    {
      key: "peak",
      value: (
        <span className={VALUE_CLASS}>{formatCompact(tokenStats?.peakDayTokens ?? null)}</span>
      ),
      label: "peak day",
    },
    {
      key: "current",
      value: <span className={VALUE_CLASS}>{formatDays(stats.activity.currentStreakDays)}</span>,
      label: "current streak",
    },
    {
      key: "longest",
      value: <span className={VALUE_CLASS}>{formatDays(stats.activity.longestStreakDays)}</span>,
      label: "longest streak",
    },
    {
      key: "provider",
      // Most-used provider: token telemetry when available, otherwise turn count. An explicit
      // slate color keeps currentColor glyphs visible on the white card in every theme.
      value: topProvider.provider ? (
        <span className="flex items-center gap-2">
          <ProviderIcon
            provider={topProvider.provider}
            className="size-6 shrink-0 text-slate-700"
          />
          {topProvider.percent !== null ? (
            <span className={VALUE_CLASS}>{`${Math.round(topProvider.percent)}%`}</span>
          ) : null}
        </span>
      ) : (
        <span className={VALUE_CLASS}>—</span>
      ),
      label: "top provider",
    },
  ];

  // Same tokens-first series as the profile page so the exported card matches the app.
  const heatmapCells = selectProfileHeatmap(stats, tokenStats).cells.slice(-CARD_HEATMAP_DAYS);

  return (
    <div
      ref={ref}
      style={{ width: `${SHARE_CARD_WIDTH}px`, height: `${SHARE_CARD_HEIGHT}px` }}
      className="flex flex-col justify-center gap-7 overflow-hidden bg-white px-12 font-sans text-slate-900"
    >
      {/* Header: user-edited identity truncates before it can collide with the fixed brand. */}
      <div className="flex min-w-0 items-center justify-between gap-6">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <ProfileAvatar
            initials={stats.identity.initials}
            color={avatarColor}
            image={avatarImage}
            className="size-16 shrink-0 text-lg font-medium"
            textClassName="text-lg font-medium"
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-2xl font-normal leading-tight tracking-tight">
              {displayName}
            </span>
            <span className="truncate text-base font-normal text-slate-400">{handle}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-slate-600">
          <SynaraLogo className="size-6 text-slate-700" />
          <span className="text-xl font-normal tracking-tight">Synara</span>
        </div>
      </div>

      {/* Heatmap — recent ~6 months; cells sized so the grid fills the card width */}
      <ActivityHeatmap
        cells={heatmapCells}
        cellSize={22}
        gap={4}
        radius={5}
        intensityClasses={CARD_HEATMAP_INTENSITY_CLASSES}
      />

      {/* Stat tiles — left-aligned columns, no dividers (reference style) */}
      <div className="flex items-stretch">
        {tiles.map((tile) => (
          <div key={tile.key} className="flex flex-1 flex-col items-start gap-1">
            {tile.value}
            <span className="text-sm font-normal text-slate-400">{tile.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
});

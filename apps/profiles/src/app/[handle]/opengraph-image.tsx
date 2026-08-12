// FILE: opengraph-image.tsx
// Purpose: The social link preview for /@handle — the in-app ShareCard's design
// (apps/web/src/components/profile/ShareCard.tsx) recomposed at 1200×630 with
// next/og. Same white card, slate ink, identity header with the Synara brand on
// the right, a trailing ~26-week heatmap strip, and a four-column stat row.
// Unknown/private handles get a generic brand card, indistinguishable from one
// another by design (like the page's 404).
// Layer: profiles app route (Next.js file-convention OG image).

import { ImageResponse } from "next/og";
import { formatCompact, formatDays } from "@synara/profile-ui/formatting";
import { SYNARA_LOGO_PATHS } from "@synara/profile-ui/logo";
import { buildHeatmapCells } from "../../lib/heatmapCells";
import { fetchPublicProfile, type PublicProfile } from "../../lib/publicProfile";

export const alt = "Synara profile";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// The card's palette, resolved to literal hexes: satori has no CSS variables,
// so the CARD_HEATMAP_INTENSITY ramp (color-mix of --info toward white) is
// hardcoded at its computed values. INK/MUTED mirror slate-900/slate-400.
const HEATMAP_RAMP = ["#f8f8f8", "#d8e6fd", "#b0cbfa", "#79a8f8", "#3b82f6"] as const;
const INK = "#0f172a";
const MUTED = "#94a3b8";

// Trailing window: ~26 weeks, mirroring the ShareCard's CARD_HEATMAP_DAYS
// (183 days) trimmed to whole columns for the week-by-week grid.
// 26 columns of 34px cells + 6px gaps ≈ 1034px, filling the 1056px content
// width the way the ShareCard's heatmap fills its card.
const HEATMAP_WEEKS = 26;
const CELL = 34;
const GAP = 6;

type Params = { params: Promise<{ handle: string }> };

// Same @-prefixed decode as the page; kept inline because importing the page
// module would drag its React tree into the OG bundle.
function handleFromParam(raw: string): string | null {
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) return null;
  const handle = decoded.slice(1).toLowerCase();
  return /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(handle) ? handle : null;
}

function SynaraMark({ edge }: { edge: number }) {
  return (
    <svg
      viewBox="0 0 470 504"
      width={edge}
      height={Math.round(edge * (504 / 470))}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {SYNARA_LOGO_PATHS.map((path) => (
        <path key={path} d={path} fill="#334155" />
      ))}
    </svg>
  );
}

function BrandCluster() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <SynaraMark edge={40} />
      <span style={{ fontSize: 34, color: "#475569", letterSpacing: "-0.02em" }}>Synara</span>
    </div>
  );
}

/** The fallback: brand only, served for unknown and private handles alike. */
function genericCard() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#ffffff",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
        <SynaraMark edge={72} />
        <span style={{ fontSize: 64, color: INK, letterSpacing: "-0.02em" }}>Synara</span>
      </div>
    </div>,
    size,
  );
}

function initialsOf(displayName: string): string {
  return displayName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

/** Week columns (7 rows each) for the trailing window, Sunday-first. */
function heatmapColumns(profile: PublicProfile): number[][] {
  const cells = buildHeatmapCells(profile.heatmap);
  // Trim to whole weeks ending on the last cell so no partial column renders.
  const total = HEATMAP_WEEKS * 7;
  const trailing = cells.slice(-total);
  const columns: number[][] = [];
  for (let index = 0; index < trailing.length; index += 7) {
    columns.push(trailing.slice(index, index + 7).map((cell) => cell.intensity));
  }
  return columns;
}

export default async function OgImage({ params }: Params) {
  const handle = handleFromParam((await params).handle);
  if (!handle) return genericCard();
  const profile = await fetchPublicProfile(handle).catch(() => null);
  if (!profile) return genericCard();

  const columns = heatmapColumns(profile);
  const topModel = [...profile.models].sort((a, b) => b.tokens - a.tokens)[0]?.model ?? "—";
  const stats = [
    { value: formatCompact(profile.lifetimeTokens), label: "lifetime tokens" },
    { value: profile.peakDay ? formatCompact(profile.peakDay.tokens) : "—", label: "peak day" },
    { value: formatDays(profile.currentStreakDays), label: "current streak" },
    { value: topModel, label: "top model" },
  ];

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 48,
        padding: "0 72px",
        backgroundColor: "#ffffff",
        color: INK,
      }}
    >
      {/* Identity header: avatar + name/handle left, brand right. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 32,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 24, minWidth: 0 }}>
          {profile.avatarUrl ? (
            <img
              src={profile.avatarUrl}
              width={88}
              height={88}
              style={{ borderRadius: 9999, objectFit: "cover" }}
            />
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 88,
                height: 88,
                borderRadius: 9999,
                backgroundColor: profile.avatarColor,
                color: "#ffffff",
                fontSize: 34,
                fontWeight: 500,
              }}
            >
              {initialsOf(profile.displayName)}
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 40, fontWeight: 400, letterSpacing: "-0.02em" }}>
              {profile.displayName}
            </span>
            <span style={{ fontSize: 24, color: MUTED }}>@{profile.handle}</span>
          </div>
        </div>
        <BrandCluster />
      </div>

      {/* Heatmap strip — week columns of rounded squares, ShareCard's ramp. */}
      <div style={{ display: "flex", gap: GAP }}>
        {columns.map((column, columnIndex) => (
          <div key={columnIndex} style={{ display: "flex", flexDirection: "column", gap: GAP }}>
            {column.map((intensity, rowIndex) => (
              <div
                key={rowIndex}
                style={{
                  width: CELL,
                  height: CELL,
                  borderRadius: 6,
                  backgroundColor: HEATMAP_RAMP[intensity] ?? HEATMAP_RAMP[0],
                }}
              />
            ))}
          </div>
        ))}
      </div>

      {/* Stat columns — left-aligned, no dividers, ShareCard's type scale. */}
      <div style={{ display: "flex" }}>
        {stats.map((stat) => (
          <div
            key={stat.label}
            style={{ display: "flex", flex: 1, flexDirection: "column", gap: 6 }}
          >
            <span style={{ fontSize: 36, fontWeight: 400, letterSpacing: "-0.02em" }}>
              {stat.value}
            </span>
            <span style={{ fontSize: 20, color: MUTED }}>{stat.label}</span>
          </div>
        ))}
      </div>
    </div>,
    size,
  );
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ProfileAvatar } from "@synara/profile-ui/avatar";
import { ActivityHeatmap } from "@synara/profile-ui/heatmap";
import { deriveInitials, formatCompact, formatHourLabel } from "@synara/profile-ui/formatting";
import {
  PROVIDER_GLYPHS,
  providerIconToneClassName,
  providerLabel,
} from "@synara/profile-ui/provider-icon";
import { InsightRow, ModelUsageRow, StatTileGrid } from "@synara/profile-ui/sections";
import { PageShell } from "../../components/chrome";
import { buildHeatmapCells } from "../../lib/heatmapCells";
import { formatStreak, memberSince } from "../../lib/profileFormat";
import { fetchPublicProfile, type PublicProfile } from "../../lib/publicProfile";

type Params = { params: Promise<{ handle: string }> };

/**
 * The trysynara.com rewrite delivers `/@dylan` as the `handle` segment, so
 * the raw param arrives URL-encoded with its @ ("%40dylan"). Anything that
 * does not carry the @ is not a profile URL this app serves.
 */
function handleFromParam(raw: string): string | null {
  const decoded = decodeURIComponent(raw);
  if (!decoded.startsWith("@")) return null;
  const handle = decoded.slice(1).toLowerCase();
  return /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(handle) ? handle : null;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const handle = handleFromParam((await params).handle);
  if (!handle) return {};
  const profile = await fetchPublicProfile(handle).catch(() => null);
  if (!profile) return {};
  const description = `${formatCompact(profile.lifetimeTokens)} tokens · ${formatCompact(profile.lifetimePrompts)} prompts on Synara`;
  return {
    title: `${profile.displayName} (@${profile.handle}) · Synara`,
    description,
    openGraph: {
      title: `${profile.displayName} (@${profile.handle})`,
      description,
    },
    // The file-convention opengraph-image registers itself; the card type is
    // the only twitter-specific bit the route can't infer.
    twitter: { card: "summary_large_image" },
  };
}

export default async function ProfilePage({ params }: Params) {
  const handle = handleFromParam((await params).handle);
  if (!handle) notFound();
  const profile = await fetchPublicProfile(handle);
  if (!profile) notFound();

  const since = memberSince(profile.createdAt);

  return (
    <PageShell>
      {/* Identity */}
      <header className="flex items-center gap-5">
        <ProfileAvatar
          initials={deriveInitials(profile.displayName)}
          color={profile.avatarColor}
          image={profile.avatarUrl ?? null}
          className="size-[72px] shadow-sm"
          textClassName="text-2xl"
        />
        <div className="min-w-0">
          <h1 className="truncate text-[28px] font-semibold leading-tight tracking-tight">
            {profile.displayName}
          </h1>
          <p className="mt-1 truncate text-sm text-muted-foreground">
            @{profile.handle}
            {since ? ` · on Synara since ${since}` : ""}
          </p>
        </div>
      </header>

      <StatTileGrid
        tiles={[
          { label: "Lifetime tokens", value: formatCompact(profile.lifetimeTokens) },
          {
            label: "Peak day",
            value: profile.peakDay ? formatCompact(profile.peakDay.tokens) : "—",
          },
          { label: "Prompts", value: formatCompact(profile.lifetimePrompts) },
          { label: "Current streak", value: formatStreak(profile.currentStreakDays) },
          { label: "Longest streak", value: formatStreak(profile.longestStreakDays) },
        ]}
      />

      <ActivitySection heatmap={profile.heatmap} />
      <InsightsSection profile={profile} />
      <ModelUsageSection models={profile.models} lifetimeTokens={profile.lifetimeTokens} />
      <ActiveHoursSection hours={profile.hours} />
    </PageShell>
  );
}

// ── Activity ───────────────────────────────────────────────────────────

function ActivitySection({ heatmap }: { heatmap: PublicProfile["heatmap"] }) {
  // No renderTooltip: ActivityHeatmap falls back to a native `title`, keeping the
  // page free of client JS. Fill mode with the app's window length, so the grid
  // renders exactly like the in-app Activity section — no horizontal scroll.
  const cells = buildHeatmapCells(heatmap);
  return (
    <section aria-label="Activity" className="flex min-w-0 flex-col gap-3">
      <h2 className="text-sm font-medium">Activity</h2>
      <ActivityHeatmap cells={cells} fill radius={5} gap={3} showMonths monthsPosition="bottom" />
    </section>
  );
}

// ── Activity insights ──────────────────────────────────────────────────

function InsightsSection({ profile }: { profile: PublicProfile }) {
  const byProvider = new Map<string, number>();
  const byReasoning = new Map<string, number>();
  for (const row of profile.models) {
    byProvider.set(row.provider, (byProvider.get(row.provider) ?? 0) + row.tokens);
    if (row.reasoning) {
      byReasoning.set(row.reasoning, (byReasoning.get(row.reasoning) ?? 0) + row.turns);
    }
  }
  const totalTokens = Math.max(1, profile.lifetimeTokens);
  const totalTurns = Math.max(
    1,
    profile.models.reduce((sum, row) => sum + row.turns, 0),
  );
  const top = (entries: Map<string, number>) =>
    [...entries.entries()].sort((a, b) => b[1] - a[1])[0];
  const topProvider = top(byProvider);
  const topReasoning = top(byReasoning);
  const topHour = profile.hours.reduce<{ hour: number; prompts: number } | null>(
    (best, entry) =>
      entry.prompts > 0 && (best === null || entry.prompts > best.prompts) ? entry : best,
    null,
  );

  const rows: { label: string; value: string }[] = [
    {
      label: "Most used provider",
      value: topProvider
        ? `${providerLabel(topProvider[0])} · ${Math.round((topProvider[1] / totalTokens) * 100)}%`
        : "—",
    },
    {
      label: "Most used reasoning",
      value: topReasoning
        ? `${capitalize(topReasoning[0])} · ${Math.round((topReasoning[1] / totalTurns) * 100)}%`
        : "—",
    },
    { label: "Most active hour", value: topHour ? formatHourLabel(topHour.hour) : "—" },
  ];

  return (
    <section aria-label="Activity insights" className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">Activity insights</h2>
      <dl className="flex flex-col gap-2.5">
        {rows.map((row) => (
          <InsightRow key={row.label} label={row.label} value={row.value} />
        ))}
      </dl>
    </section>
  );
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0]!.toUpperCase() + value.slice(1) : value;
}

// ── Model usage ────────────────────────────────────────────────────────

function ModelUsageSection({
  models,
  lifetimeTokens,
}: {
  models: PublicProfile["models"];
  lifetimeTokens: number;
}) {
  if (models.length === 0) return null;
  const total = Math.max(1, lifetimeTokens);

  return (
    <section aria-label="Model usage" className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">Model usage</h2>
      <ul className="flex flex-col gap-3">
        {models.map((row) => {
          const percent = Math.round((row.tokens / total) * 100);
          const Glyph = (
            PROVIDER_GLYPHS as Partial<Record<string, (typeof PROVIDER_GLYPHS)["codex"]>>
          )[row.provider];
          return (
            <ModelUsageRow
              key={`${row.provider}/${row.model}/${row.reasoning ?? ""}`}
              icon={
                Glyph ? (
                  <Glyph
                    aria-hidden
                    className={`size-3.5 shrink-0 ${providerIconToneClassName(row.provider)}`}
                  />
                ) : (
                  <span aria-hidden className="size-3.5 shrink-0 rounded-sm bg-muted" />
                )
              }
              model={row.model}
              detail={`${providerLabel(row.provider)}${row.reasoning ? ` · ${row.reasoning}` : ""}`}
              percent={percent}
              stat={`${formatCompact(row.tokens)} · ${percent}%`}
            />
          );
        })}
      </ul>
    </section>
  );
}

// ── Active hours ───────────────────────────────────────────────────────

function ActiveHoursSection({ hours }: { hours: PublicProfile["hours"] }) {
  if (hours.length === 0) return null;
  const byHour = new Map(hours.map((entry) => [entry.hour, entry.prompts]));
  const max = Math.max(1, ...hours.map((entry) => entry.prompts));

  return (
    <section aria-label="Active hours" className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">Active hours</h2>
      <div className="flex h-14 items-end gap-1">
        {Array.from({ length: 24 }, (_, hour) => {
          const prompts = byHour.get(hour) ?? 0;
          return (
            <div
              key={hour}
              title={`${prompts.toLocaleString()} ${prompts === 1 ? "prompt" : "prompts"} at ${formatHourLabel(hour)}`}
              className={`flex-1 rounded-[3px] ${prompts > 0 ? "bg-[var(--info)]" : "bg-muted"}`}
              style={{ height: `${Math.max(4, Math.round((prompts / max) * 100))}%` }}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-[10px] leading-none text-muted-foreground">
        {["12 AM", "6 AM", "12 PM", "6 PM", "11 PM"].map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
    </section>
  );
}

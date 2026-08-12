import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Heatmap } from "../../components/Heatmap";
import { ActiveHours } from "../../components/ActiveHours";
import { ModelSplit } from "../../components/ModelSplit";
import {
  compactNumber,
  formatHourLabel,
  formatStreak,
  initial,
  memberSince,
} from "../../lib/format";
import { fetchPublicProfile } from "../../lib/publicProfile";

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
  const description = `${compactNumber(profile.lifetimeTokens)} tokens · ${compactNumber(profile.lifetimePrompts)} prompts on Synara`;
  return {
    title: `${profile.displayName} (@${profile.handle}) · Synara`,
    description,
    openGraph: {
      title: `${profile.displayName} (@${profile.handle})`,
      description,
    },
  };
}

export default async function ProfilePage({ params }: Params) {
  const handle = handleFromParam((await params).handle);
  if (!handle) notFound();
  const profile = await fetchPublicProfile(handle);
  if (!profile) notFound();

  const since = memberSince(profile.createdAt);

  return (
    <main
      style={{
        maxWidth: 720,
        margin: "0 auto",
        padding: "48px 24px 64px",
        display: "flex",
        flexDirection: "column",
        gap: 28,
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div
          aria-hidden
          style={{
            width: 64,
            height: 64,
            borderRadius: "50%",
            background: profile.avatarColor || "var(--accent-fallback)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 26,
            fontWeight: 600,
            color: "#0a0a0b",
          }}
        >
          {initial(profile.displayName)}
        </div>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 650 }}>{profile.displayName}</h1>
          <p style={{ margin: "2px 0 0", color: "var(--muted)", fontSize: 14 }}>
            @{profile.handle}
            {since ? ` · on Synara since ${since}` : ""}
          </p>
        </div>
      </header>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, 1fr)",
          gap: 12,
        }}
      >
        {(
          [
            ["Lifetime tokens", compactNumber(profile.lifetimeTokens)],
            ["Peak day", profile.peakDay ? compactNumber(profile.peakDay.tokens) : "—"],
            ["Prompts", compactNumber(profile.lifetimePrompts)],
            ["Current streak", formatStreak(profile.currentStreakDays)],
            ["Longest streak", formatStreak(profile.longestStreakDays)],
          ] as const
        ).map(([label, value]) => (
          <div
            key={label}
            style={{
              background: "var(--panel)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: "14px 16px",
            }}
          >
            <div style={{ fontSize: 24, fontWeight: 650 }}>{value}</div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{label}</div>
          </div>
        ))}
      </section>

      <Heatmap days={profile.heatmap} />
      <Insights profile={profile} />
      <ModelSplit models={profile.models} lifetimeTokens={profile.lifetimeTokens} />
      <ActiveHours hours={profile.hours} />

      <footer style={{ fontSize: 12, color: "var(--muted)" }}>
        Powered by{" "}
        <a href="https://trysynara.com" style={{ color: "inherit" }}>
          Synara
        </a>{" "}
        — the open workspace for coding agents.
      </footer>
    </main>
  );
}

function Insights({
  profile,
}: {
  profile: Awaited<ReturnType<typeof fetchPublicProfile>> & object;
}) {
  const byProvider = new Map<string, number>();
  const byReasoning = new Map<string, number>();
  for (const row of profile.models) {
    byProvider.set(row.provider, (byProvider.get(row.provider) ?? 0) + row.tokens);
    if (row.reasoning) {
      byReasoning.set(row.reasoning, (byReasoning.get(row.reasoning) ?? 0) + row.turns);
    }
  }
  const total = Math.max(1, profile.lifetimeTokens);
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

  const rows: [string, string][] = [
    [
      "Most used provider",
      topProvider
        ? `${providerLabel(topProvider[0])} · ${Math.round((topProvider[1] / total) * 100)}%`
        : "—",
    ],
    [
      "Most used reasoning",
      topReasoning
        ? `${topReasoning[0][0].toUpperCase()}${topReasoning[0].slice(1)} · ${Math.round((topReasoning[1] / totalTurns) * 100)}%`
        : "—",
    ],
    ["Most active hour", topHour ? formatHourLabel(topHour.hour) : "—"],
  ];

  return (
    <section
      aria-label="Activity insights"
      style={{ display: "flex", flexDirection: "column", gap: 10 }}
    >
      <span style={{ fontSize: 14, fontWeight: 500 }}>Activity insights</span>
      <dl style={{ margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
        {rows.map(([label, value]) => (
          <div key={label} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
            <dt style={{ fontSize: 14, color: "var(--muted)" }}>{label}</dt>
            <dd style={{ margin: 0, fontSize: 14, fontVariantNumeric: "tabular-nums" }}>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Synara's provider keys → human labels, mirroring the in-app spelling. */
function providerLabel(provider: string): string {
  const labels: Record<string, string> = {
    codex: "Codex",
    claudeAgent: "Claude",
    cursor: "Cursor",
    antigravity: "Antigravity",
    grok: "Grok",
    droid: "Droid",
    kilo: "Kilo",
    opencode: "OpenCode",
    pi: "Pi",
  };
  return labels[provider] ?? provider;
}

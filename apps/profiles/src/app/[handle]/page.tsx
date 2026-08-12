import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Heatmap } from "../../components/Heatmap";
import { ModelSplit } from "../../components/ModelSplit";
import { compactNumber, initial, memberSince } from "../../lib/format";
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
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 12,
        }}
      >
        {(
          [
            ["Tokens", profile.lifetimeTokens],
            ["Prompts", profile.lifetimePrompts],
            ["Turns", profile.lifetimeTurns],
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
            <div style={{ fontSize: 24, fontWeight: 650 }}>{compactNumber(value)}</div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{label}</div>
          </div>
        ))}
      </section>

      <Heatmap days={profile.heatmap} />
      <ModelSplit models={profile.models} lifetimeTokens={profile.lifetimeTokens} />

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

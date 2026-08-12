import type { PublicProfileModelUsage } from "../lib/publicProfile";
import { compactNumber } from "../lib/format";

/**
 * The provider/model/reasoning token split — the same depth the in-app
 * dashboard shows, because the depth is the point. Rows arrive
 * tokens-descending from the API; only the share is computed here.
 */
export function ModelSplit({
  models,
  lifetimeTokens,
}: {
  models: readonly PublicProfileModelUsage[];
  lifetimeTokens: number;
}) {
  if (models.length === 0) return null;
  const total = Math.max(1, lifetimeTokens);

  return (
    <section
      aria-label="Model usage"
      style={{
        background: "var(--panel)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {models.map((row) => {
        const percent = Math.round((row.tokens / total) * 100);
        const key = `${row.provider}/${row.model}/${row.reasoning ?? ""}`;
        return (
          <div key={key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: 13,
                gap: 12,
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {row.model}
                <span style={{ color: "var(--muted)" }}>
                  {" · "}
                  {row.provider}
                  {row.reasoning ? ` · ${row.reasoning}` : ""}
                </span>
              </span>
              <span style={{ color: "var(--muted)", flexShrink: 0 }}>
                {compactNumber(row.tokens)} ({percent}%)
              </span>
            </div>
            <div
              aria-hidden
              style={{ height: 4, borderRadius: 2, background: "#1b1b1f", overflow: "hidden" }}
            >
              <div
                style={{
                  width: `${Math.max(1, percent)}%`,
                  height: "100%",
                  background: "#16a34a",
                }}
              />
            </div>
          </div>
        );
      })}
    </section>
  );
}

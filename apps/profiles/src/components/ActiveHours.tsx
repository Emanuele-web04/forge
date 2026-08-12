/**
 * Prompt count per hour of the owner's day — the public counterpart of the
 * in-app active-hours insight. Pure SSR markup: 24 fixed slots so quiet
 * hours keep their lane, bars scaled to the busiest hour.
 */
export function ActiveHours({ hours }: { hours: readonly { hour: number; prompts: number }[] }) {
  if (hours.length === 0) return null;
  const byHour = new Map(hours.map((entry) => [entry.hour, entry.prompts]));
  const max = Math.max(1, ...hours.map((entry) => entry.prompts));

  return (
    <section
      aria-label="Active hours"
      style={{ display: "flex", flexDirection: "column", gap: 10 }}
    >
      <span style={{ fontSize: 14, fontWeight: 500 }}>Active hours</span>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 56 }}>
        {Array.from({ length: 24 }, (_, hour) => {
          const prompts = byHour.get(hour) ?? 0;
          const share = prompts / max;
          return (
            <div
              key={hour}
              title={`${prompts} prompts at ${hour}:00`}
              style={{
                flex: 1,
                height: `${Math.max(4, Math.round(share * 100))}%`,
                borderRadius: 3,
                background: prompts > 0 ? "#3B82F6" : "var(--panel)",
              }}
            />
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        {["12 AM", "6 AM", "12 PM", "6 PM", "11 PM"].map((label) => (
          <span key={label} style={{ fontSize: 10, color: "var(--muted)" }}>
            {label}
          </span>
        ))}
      </div>
    </section>
  );
}

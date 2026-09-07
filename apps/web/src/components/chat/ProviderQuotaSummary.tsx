import { PROVIDER_DISPLAY_NAMES, type ProviderKind } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { serverAllProviderUsageQueryOptions } from "~/lib/serverReactQuery";
import { providerUsageToneClassName } from "~/lib/providerUsageDisplay";
import { useProviderUsageMenuModel } from "../ProviderUsageMenuControl";

export function ProviderQuotaSummary({ provider }: { provider: ProviderKind }) {
  const query = useQuery(serverAllProviderUsageQueryOptions());
  const snapshot = query.data?.find((entry) => entry.provider === provider);
  const model = useProviderUsageMenuModel(provider, { providerSnapshot: snapshot });
  return (
    <section className="mt-3 space-y-3 border-t border-border/50 pt-3" aria-label="Account limits">
      <div className="flex items-center justify-between gap-3 text-[11px]">
        <span className="font-medium text-muted-foreground">Account limits</span>
        <span className="font-medium text-foreground">{PROVIDER_DISPLAY_NAMES[provider]}</span>
      </div>
      {model.rows.map((row) => (
        <div key={row.id} className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-4 text-xs">
            <span className="text-muted-foreground">{row.label} limit</span>
            <span className="font-medium tabular-nums">{row.remainingLabel} left</span>
          </div>
          <div
            role="meter"
            aria-label={`${row.label} remaining`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={row.remainingPercent}
            className="h-1.5 overflow-hidden rounded-full bg-muted/70"
          >
            <div
              className={`h-full rounded-full ${providerUsageToneClassName(row.remainingTone)}`}
              style={{ width: `${row.remainingPercent}%` }}
            />
          </div>
          {row.resetText ? (
            <div className="text-right text-[10px] text-muted-foreground">{row.resetText}</div>
          ) : null}
        </div>
      ))}
      {!model.rows.length ? (
        <div className="text-xs leading-relaxed text-muted-foreground">
          {query.isPending || model.isLoading
            ? "Checking account limits…"
            : (model.emptyMessage ?? snapshot?.detail ?? "Account limits could not be retrieved.")}
        </div>
      ) : null}
      <div className="flex justify-between gap-3 text-[10px] text-muted-foreground/80">
        <span>Shared across conversations</span>
        {snapshot?.updatedAt ? (
          <span title={new Date(snapshot.updatedAt).toLocaleString()}>
            {snapshot.stale ? "Last known · " : "Updated · "}
            {new Date(snapshot.updatedAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        ) : null}
      </div>
    </section>
  );
}

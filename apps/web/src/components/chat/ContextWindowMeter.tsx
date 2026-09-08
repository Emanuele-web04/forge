import type { ProviderKind } from "@synara/contracts";
import { ProviderQuotaSummary } from "./ProviderQuotaSummary";
import type { MessageUsageMetric } from "~/lib/messageUsage";
import {
  type ContextWindowSnapshot,
  deriveContextWindowMeterDisplay,
  formatContextWindowTokens,
  formatCostUsd,
} from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot | null;
  provider?: ProviderKind;
  sessionUsage?: readonly MessageUsageMetric[];
  cumulativeCostUsd?: number | null | undefined;
  activeWindowLabel?: string | null | undefined;
  pendingWindowLabel?: string | null | undefined;
}) {
  const { usage, cumulativeCostUsd, activeWindowLabel, pendingWindowLabel } = props;
  const display = usage ? deriveContextWindowMeterDisplay(usage) : null;
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - ((display?.normalizedPercentage ?? 0) / 100) * circumference;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className="group inline-flex shrink-0 items-center justify-center rounded-full p-0.5 transition-opacity hover:opacity-80"
            aria-label={display?.ariaLabel ?? "Context window and session usage"}
          >
            <span className="relative flex h-4 w-4 items-center justify-center">
              <svg
                viewBox="0 0 16 16"
                className="-rotate-90 absolute inset-0 h-full w-full transform-gpu"
                aria-hidden="true"
              >
                <circle
                  cx="8"
                  cy="8"
                  r={radius}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-muted-foreground/25 dark:text-muted-foreground/40"
                />
                <circle
                  cx="8"
                  cy="8"
                  r={radius}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="text-primary transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none dark:text-[var(--color-text-foreground)]"
                />
              </svg>
            </span>
          </button>
        }
      />
      <PopoverPopup
        tooltipStyle
        side="top"
        align="end"
        className="w-80 max-w-[calc(100vw-2rem)] px-4 py-3"
      >
        <div className="space-y-1.5 leading-tight">
          <div className="text-[11px] font-medium text-muted-foreground">Context window</div>
          {usage && display ? (
            <>
              {pendingWindowLabel ? (
                <div className="text-xs text-muted-foreground">
                  Current session: {activeWindowLabel ?? "Unknown"}
                </div>
              ) : null}
              {display.usedPercentageLabel ? (
                <div className="whitespace-nowrap text-xs font-medium text-foreground">
                  <span>{display.usedPercentageLabel}</span>
                  {display.hasReliableTokenRatio ? (
                    <>
                      <span className="mx-1">⋅</span>
                      <span>{display.tokenUsageLabel}</span>
                      <span>/</span>
                      <span>{formatContextWindowTokens(usage.maxTokens)} context used</span>
                    </>
                  ) : (
                    <span className="ml-1">context used</span>
                  )}
                </div>
              ) : (
                <div className="text-sm text-foreground">
                  {display.tokenUsageLabel} tokens used so far
                </div>
              )}
              {usage.maxTokens !== null ? (
                <div className="text-xs text-muted-foreground">
                  Model window: {formatContextWindowTokens(usage.maxTokens)} tokens
                </div>
              ) : null}
              {pendingWindowLabel ? (
                <div className="text-xs text-muted-foreground">Next turn: {pendingWindowLabel}</div>
              ) : null}
              {(usage.totalProcessedTokens ?? null) !== null &&
              (usage.totalProcessedTokens ?? 0) > usage.usedTokens ? (
                <div className="text-xs text-muted-foreground">
                  Total processed: {formatContextWindowTokens(usage.totalProcessedTokens ?? null)}{" "}
                  tokens
                </div>
              ) : null}
              {usage.compactsAutomatically ? (
                <div className="text-xs text-muted-foreground">
                  Automatically compacts its context when needed.
                </div>
              ) : null}
            </>
          ) : (
            <div className="text-xs text-muted-foreground">Context usage unavailable</div>
          )}
          {cumulativeCostUsd !== null && cumulativeCostUsd !== undefined ? (
            <div className="text-xs text-muted-foreground">
              Session cost: {formatCostUsd(cumulativeCostUsd)}
            </div>
          ) : null}
          {props.sessionUsage && props.sessionUsage.length > 0 ? (
            <div className="mt-2 space-y-1.5 border-t border-border/50 pt-2">
              <div className="text-[11px] font-medium text-muted-foreground">Session usage</div>
              <div className="flex flex-wrap gap-x-1.5 gap-y-1 text-xs tabular-nums">
                {props.sessionUsage.map((metric, index) => (
                  <span key={metric.label} className="whitespace-nowrap" title={metric.detail}>
                    {index > 0 ? (
                      <span aria-hidden="true" className="mr-1.5 text-muted-foreground/50">
                        ·
                      </span>
                    ) : null}
                    <span className="text-muted-foreground">{metric.label}</span>{" "}
                    <span className="font-medium">{metric.value}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {props.provider ? <ProviderQuotaSummary provider={props.provider} /> : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

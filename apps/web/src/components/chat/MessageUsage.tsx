import type { MessageUsageMetric } from "~/lib/messageUsage";
import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

const names: Record<string, string> = {
  "↑": "Input",
  "↓": "Output",
  R: "Cache read",
  W: "Cache write",
  CH: "Cache hit",
  TPS: "Average output speed",
};

export function MessageUsage({
  metrics,
  scope = "turn",
  context,
}: {
  metrics: readonly MessageUsageMetric[];
  scope?: "turn" | "conversation";
  context?: ContextWindowSnapshot | null;
}) {
  if (metrics.length === 0) return null;
  const conversation = scope === "conversation";
  const partial = metrics.some((metric) => /only;|some historical/.test(metric.detail));
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        render={
          <button
            type="button"
            aria-label={conversation ? "Conversation usage details" : "Message usage details"}
            className={`${conversation ? "rounded-md border border-border/40 bg-muted/20 px-2 py-1" : "mt-2 rounded-md px-1 py-0.5"} flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-1 text-left font-system-ui text-[11px] leading-5 tabular-nums text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring`}
          >
            {metrics.map((metric, index) => (
              <span
                key={metric.label}
                className="inline-flex items-baseline gap-1 whitespace-nowrap"
              >
                {index > 0 ? (
                  <span aria-hidden="true" className="mr-1 text-muted-foreground/35">
                    ·
                  </span>
                ) : null}
                <span className="text-[10px] text-muted-foreground/60">{metric.label}</span>
                <span className={metric.value === "—" ? "text-muted-foreground/40" : "font-medium"}>
                  {metric.value}
                </span>
              </span>
            ))}
          </button>
        }
      />
      <PopoverPopup
        tooltipStyle
        side="top"
        align={conversation ? "end" : "start"}
        className="w-72 max-w-[calc(100vw-2rem)] p-0 [&_[data-slot=popover-viewport]]:max-h-[min(28rem,calc(var(--available-height)-2rem))] [&_[data-slot=popover-viewport]]:overflow-y-auto"
      >
        <div className="border-b border-border/50 px-4 py-3">
          <p className="text-xs font-medium">
            {conversation ? "Conversation usage" : "Turn usage"}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            {partial
              ? "Some historical request totals were not saved."
              : conversation
                ? "All recorded model requests in this conversation."
                : "All model requests in this turn, including tools and subagents."}
          </p>
        </div>
        <dl className="space-y-2 px-4 py-3 text-xs">
          {metrics.map((metric) => (
            <div
              key={metric.label}
              className="flex items-baseline justify-between gap-4"
              title={metric.detail}
            >
              <dt className="text-muted-foreground">{names[metric.label] ?? metric.label}</dt>
              <dd className="font-medium tabular-nums">
                {metric.exactValue ?? metric.value}
                <span className="sr-only"> — {metric.detail}</span>
              </dd>
            </div>
          ))}
        </dl>
        <div className="space-y-1.5 border-t border-border/50 bg-muted/20 px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
          <p>Input includes cache reads and writes. Cache hit = reads ÷ input.</p>
          <p>— means the provider did not report this metric.</p>
          {metrics.some((metric) => metric.label === "TPS") ? (
            <p>TPS = output ÷ turn wall time, including thinking, tools and waiting.</p>
          ) : null}
          {context ? (
            <p>
              Context: {context.usedTokens.toLocaleString("en-US")} tokens
              {context.maxTokens != null
                ? ` · Capacity: ${context.maxTokens.toLocaleString("en-US")}`
                : ""}
              {context.compactsAutomatically ? " · Auto compaction" : ""}
            </p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

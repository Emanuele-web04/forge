// FILE: CapabilityEvidenceBadge.tsx
// Purpose: Evidence-driven capability badge for an external agent profile
// (KAR-530 AC #2). Reads effective capability states from the evidence store
// and collapses them into a compact status chip: verified → green check,
// provisional/degraded → amber warning, broken → red alert, unknown/empty →
// muted. The badge never fabricates confidence; it only ever reflects the
// derived evidence.
// Layer: Chat composer presentation
// Depends on: capabilityEvidenceBadgeQueryOptions

import { useQuery } from "@tanstack/react-query";
import { type ComponentProps } from "react";

import { capabilityEvidenceBadgeQueryOptions } from "~/lib/capabilityEvidence";
import { cn } from "~/lib/utils";

/**
 * Worst-state summary of a capability set, ordered from most to least severe so
 * an unsafe outcome visibly dominates the chip even when most capabilities work.
 */
export function summarizeCapabilityBadge(
  states: ReadonlyArray<{
    readonly state: "verified" | "provisional" | "degraded" | "unknown" | "broken";
  }>,
): "verified" | "provisional" | "degraded" | "broken" | "unknown" {
  const seen = new Set(states.map((entry) => entry.state));
  if (seen.has("broken")) return "broken";
  if (seen.has("degraded")) return "degraded";
  if (seen.has("provisional")) return "provisional";
  // An empty history and a history made up entirely of `unknown` readings both
  // mean "no confidence evidence yet" — never a fabricated green check.
  if (seen.size === 0 || (seen.size === 1 && seen.has("unknown"))) return "unknown";
  return "verified";
}

const BADGE_STYLE_BY_STATE = {
  verified: "text-emerald-400",
  provisional: "text-amber-400",
  degraded: "text-amber-400",
  broken: "text-red-400",
  unknown: "text-muted-foreground",
} as const;

const BADGE_ICON_BY_STATE = {
  verified: "✓",
  provisional: "~",
  degraded: "!",
  broken: "✕",
  unknown: "?",
} as const;

export interface CapabilityEvidenceBadgeProps extends ComponentProps<"span"> {
  /** External agent profile id the badge belongs to. */
  readonly profileId: string;
}

/**
 * Compact evidence badge mounted next to an external agent selection. While
 * the evidence store is loading it renders a neutral placeholder rather than a
 * fabricated status; once loaded the chip reflects only the derived evidence.
 */
export function CapabilityEvidenceBadge({
  profileId,
  className,
  ...rest
}: CapabilityEvidenceBadgeProps) {
  const { data } = useQuery(capabilityEvidenceBadgeQueryOptions(profileId));
  const states = data?.states ?? [];
  const summary = summarizeCapabilityBadge(states);
  const tooltip =
    states.length > 0
      ? `${states.length} capabilities tracked — ${summary}`
      : "No capability evidence yet";
  if (data === undefined) {
    return (
      <span
        role="img"
        aria-label="Loading capability status"
        title={tooltip}
        className={cn(
          "inline-flex size-4 items-center justify-center rounded-full text-[10px] text-muted-foreground/60",
          className,
        )}
        {...rest}
      >
        ·
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={`Capability status: ${summary}`}
      title={tooltip}
      className={cn(
        "inline-flex size-4 items-center justify-center rounded-full text-[10px]",
        BADGE_STYLE_BY_STATE[summary],
        className,
      )}
      {...rest}
    >
      {BADGE_ICON_BY_STATE[summary]}
    </span>
  );
}

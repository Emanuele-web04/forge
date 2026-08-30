// FILE: EnvironmentUsageSection.logic.ts
// Purpose: Pure compact-summary decisions for provider rows in the Environment panel.

import type { ServerProviderUsageSnapshot } from "@synara/contracts";
import type { ProviderUsageDisplayRow } from "~/lib/providerUsageDisplay";

export interface EnvironmentProviderUsageSummary {
  readonly rows: ReadonlyArray<ProviderUsageDisplayRow>;
  readonly statusLabel: string;
  readonly ariaLabel: string;
}

function providerUsageStatusLabel(snapshot: ServerProviderUsageSnapshot): string {
  switch (snapshot.status) {
    case "needs-auth":
      return "Sign in";
    case "unsupported":
      return "Unsupported";
    case "error":
      return "Unavailable";
    default:
      return "No data";
  }
}

export function resolveEnvironmentProviderUsageSummary(input: {
  readonly providerName: string;
  readonly rows: ReadonlyArray<ProviderUsageDisplayRow>;
  readonly snapshot: ServerProviderUsageSnapshot;
}): EnvironmentProviderUsageSummary {
  const statusLabel = providerUsageStatusLabel(input.snapshot);
  const rowSummary = input.rows
    .map((row) => `${row.label} ${row.remainingLabel} remaining`)
    .join(", ");

  return {
    rows: input.rows,
    statusLabel,
    ariaLabel: `${input.providerName} usage: ${rowSummary || statusLabel}`,
  };
}

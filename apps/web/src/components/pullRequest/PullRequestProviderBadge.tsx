// FILE: PullRequestProviderBadge.tsx
// Purpose: Compact provider identity for pull request rows — visible "GitHub"/"Bitbucket" text
//          in the list's fine-print scale so mixed-provider lists stay scannable without
//          provider-specific branching at the call sites.
// Layer: Pull request presentation
// Exports: PullRequestProviderBadge

import type { PullRequestProvider } from "@synara/contracts";

import { cn } from "~/lib/utils";
import { providerLabel } from "./pullRequestCapabilities";
import { PR_FINE_TEXT_CLASS_NAME, PR_QUIET_INK_CLASS_NAME } from "./pullRequestText";

export function PullRequestProviderBadge({
  provider,
  className,
}: {
  provider: PullRequestProvider;
  className?: string;
}) {
  return (
    <span
      data-provider-badge={provider}
      className={cn(
        PR_FINE_TEXT_CLASS_NAME,
        PR_QUIET_INK_CLASS_NAME,
        "shrink-0 rounded border border-border/60 px-1 py-px font-medium whitespace-nowrap",
        className,
      )}
    >
      {providerLabel(provider)}
    </span>
  );
}

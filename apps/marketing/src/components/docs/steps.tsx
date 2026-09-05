// FILE: components/docs/steps.tsx
// Purpose: MDX <Steps>/<Step> for docs pages — compact numbered rail where the
//          badge, connector line, and first heading share one baseline.
//          Fine-grained prose spacing inside a step lives in globals.css
//          (.docs-step rules) because unlayered site CSS beats utilities.
// Layer: server component (no client hooks).

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Steps({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("docs-steps my-5 [counter-reset:step]", className)}>{children}</div>;
}

export function Step({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "docs-step relative pb-6 ps-9 [counter-increment:step] last:pb-0",
        // Number badge, aligned with the step title line.
        "before:absolute before:start-0 before:top-0 before:flex before:size-6 before:items-center before:justify-center before:rounded-full before:bg-secondary before:font-mono before:text-[11px] before:font-medium before:text-muted-foreground before:content-[counter(step)]",
        // Connector line down to the next badge; hidden on the last step.
        "after:absolute after:bottom-1 after:start-3 after:top-8 after:w-px after:bg-border last:after:hidden",
        className,
      )}
    >
      {children}
    </div>
  );
}

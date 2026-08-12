// FILE: skeleton.tsx
// Purpose: Animated loading placeholder. Pure Tailwind classes (keyframes come from the
// consumer's theme via `--animate-skeleton`), so it renders identically wherever the
// consumer compiles Tailwind.
// Layer: profile-ui shared component.

import type * as React from "react";
import { cn } from "./cn";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "animate-skeleton rounded-sm [--skeleton-highlight:--alpha(var(--color-white)/64%)] [background:linear-gradient(120deg,transparent_40%,var(--skeleton-highlight),transparent_60%)_var(--color-muted)_0_0/200%_100%_fixed] dark:[--skeleton-highlight:--alpha(var(--color-white)/4%)]",
        className,
      )}
      data-slot="skeleton"
      {...props}
    />
  );
}

export { Skeleton };

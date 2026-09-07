// FILE: SectionEyebrow.tsx
// Purpose: The small mono uppercase label that heads a page or a section on the
//          sponsor pages — "SPONSORS", "TOP DONORS", "MONTHLY TIERS".
// Layer: Presentational component
// Depends on: lib/utils (cn), design tokens in globals.css
// Note: `as` exists because the same treatment is a page eyebrow (a <p> above
//       the <h1>) in one spot and a real section heading (<h2>) in another —
//       the styling is shared, the document outline shouldn't be.

import { cn } from "@/lib/utils";

export function SectionEyebrow({
  children,
  as: Tag = "h2",
  className,
}: {
  children: React.ReactNode;
  as?: "h2" | "h3" | "p";
  className?: string;
}) {
  return (
    <Tag
      className={cn(
        "font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--text-tertiary)]",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

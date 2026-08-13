// FILE: lib/ctaButton.ts
// Purpose: The site's pill call-to-action styling in one place — the filled
//          primary pill and the bordered secondary pill used by the hero,
//          sponsor, privacy, and changelog CTAs.
// Layer: shared style helper (server/client importable).
// Note: A class helper rather than a wrapper component on purpose. These CTAs
//       are variously a <Link>, an <a target="_blank">, and a <button>, so the
//       call site keeps ownership of the element, href, rel, and aria bits
//       instead of everything routing through a prop passthrough layer.
//       Mirrors the cva convention already used by components/ui/button.tsx.

import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const ctaButton = cva(
  "inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-[13px] font-medium",
  {
    variants: {
      variant: {
        primary:
          "bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)] transition-opacity hover:opacity-90",
        secondary:
          "border border-[var(--divide)] text-[var(--text-primary)] transition-colors hover:bg-[var(--mock-row)]",
      },
      width: {
        /** Natural content width — the default for inline CTAs. */
        auto: "",
        /** Pinned to content width inside a stretching flex/grid parent. */
        fit: "w-fit",
        /** Full-width stacked on mobile, natural width from sm up. */
        responsive: "w-full justify-center sm:w-auto",
      },
    },
    defaultVariants: {
      variant: "primary",
      width: "auto",
    },
  },
);

export type CtaButtonVariants = VariantProps<typeof ctaButton>;

/**
 * Builds the CTA pill class. `className` is merged last through `cn`, so a call
 * site can still override a single token (tighter padding, added margin)
 * without restating the whole pill.
 */
export function ctaButtonClass(options: CtaButtonVariants & { className?: string } = {}) {
  const { className, ...variants } = options;
  return cn(ctaButton(variants), className);
}

// FILE: CortexLogo.tsx
// Purpose: Central public CORTEX mark. The asset path data remains the supplied product mark;
//          callers must not copy it into feature components.
// Layer: Shared app branding primitive

import type { SVGProps } from "react";

import { SYNARA_LOGO_PATHS } from "~/assets/synaraLogoPath";
import { cn } from "~/lib/utils";

/** Public-brand wrapper around the existing, centrally stored logo asset. */
export function CortexLogo({ className, ...props }: SVGProps<SVGSVGElement>) {
  const ariaLabel = props["aria-label"];

  return (
    <svg
      viewBox="0 0 470 504"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden={ariaLabel ? undefined : true}
      {...props}
      className={cn("shrink-0 text-foreground", className)}
    >
      {SYNARA_LOGO_PATHS.map((path) => (
        <path key={path} d={path} fill="currentColor" />
      ))}
    </svg>
  );
}

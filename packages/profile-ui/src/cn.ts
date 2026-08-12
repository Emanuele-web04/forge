// FILE: cn.ts
// Purpose: Tailwind class merge helper local to profile-ui. Mirrors the `cn` in
// apps/web/src/lib/utils.ts so moved components keep byte-identical class output.
// Layer: profile-ui internal (not a subpath export).

import { type CxOptions, cx } from "class-variance-authority";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}

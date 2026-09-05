// FILE: BrandIcons.tsx
// Purpose: Holds small brand glyph components used across marketing sections.
// Layer: UI component helpers
// Exports: WorktreeIcon and shared provider brand marks
// Depends on: react-icons marks and inline SVGs

import { SiClaude } from "react-icons/si";
import { LuSplit } from "react-icons/lu";

export { AntigravityIcon } from "@/components/AntigravityIcon";

type IconProps = { className?: string };

/**
 * Default worktrees glyph: Lucide's "split" icon, rotated 90° so the trunk
 * points up and the two branches diverge horizontally — reads as a worktree
 * fork rather than a left-to-right path split.
 */
export function WorktreeIcon({ className }: IconProps) {
  return (
    <span className={`inline-flex rotate-90 ${className ?? ""}`}>
      <LuSplit className="size-full" aria-hidden="true" />
    </span>
  );
}

/** Claude mark normalized through currentColor for theme support. */
export function ClaudeIcon({ className }: IconProps) {
  return <SiClaude className={className} aria-hidden="true" />;
}

export function OpencodeIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 512 512" className={className} aria-hidden="true">
      <path d="M320 224V352H192V224H320Z" fill="currentColor" opacity="0.22" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function CursorIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 466.73 532.09" className={className} aria-hidden="true">
      <path
        d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** Grok mark — solid xAI glyph normalized to currentColor for theme support. */
export function GrokIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 1024 1024" className={className} aria-hidden="true">
      <path
        d="M395.479 633.828L735.91 381.105C752.599 368.715 776.454 373.548 784.406 392.792C826.26 494.285 807.561 616.253 724.288 699.996C641.016 783.739 525.151 802.104 419.247 760.277L303.556 814.143C469.49 928.202 670.987 899.995 796.901 773.282C896.776 672.843 927.708 535.937 898.785 412.476L899.047 412.739C857.105 231.37 909.358 158.874 1016.4 10.6326C1018.93 7.11771 1021.47 3.60279 1024 0L883.144 141.651V141.212L395.392 633.916"
        fill="currentColor"
      />
      <path
        d="M325.226 695.251C206.128 580.84 226.662 403.776 328.285 301.668C403.431 226.097 526.549 195.254 634.026 240.596L749.454 186.994C728.657 171.88 702.007 155.623 671.424 144.2C533.19 86.9942 367.693 115.465 255.323 228.382C147.234 337.081 113.244 504.215 171.613 646.833C215.216 753.423 143.739 828.818 71.7385 904.916C46.2237 931.893 20.6216 958.87 0 987.429L325.139 695.339"
        fill="currentColor"
      />
    </svg>
  );
}

/** Pi block-letter mark — stylized "Pi" composed of square modules. */
export function PiIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 800 800" className={className} aria-hidden="true">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z"
      />
      <path fill="currentColor" d="M517.36 400 H634.72 V634.72 H517.36 Z" />
    </svg>
  );
}

/** Devin mark supplied with Synara's provider icon set. */
export function DevinIcon({ className }: IconProps) {
  return (
    <span className={`relative inline-block shrink-0 ${className ?? ""}`} aria-hidden="true">
      <span
        className="absolute inset-0 bg-current dark:hidden"
        style={{
          mask: "url('/devin.svg') center / contain no-repeat",
          WebkitMask: "url('/devin.svg') center / contain no-repeat",
        }}
      />
      <span
        className="absolute inset-0 hidden bg-current dark:block"
        style={{
          mask: "url('/devin-reversed.svg') center / contain no-repeat",
          WebkitMask: "url('/devin-reversed.svg') center / contain no-repeat",
        }}
      />
    </span>
  );
}

/** Droid mark supplied by Factory, rendered as a currentColor mask. */
export function DroidIcon({ className }: IconProps) {
  return (
    <span
      className={`inline-block shrink-0 ${className ?? ""}`}
      aria-hidden="true"
      style={{
        backgroundColor: "currentColor",
        mask: "url('/droid.svg') center / contain no-repeat",
        WebkitMask: "url('/droid.svg') center / contain no-repeat",
      }}
    />
  );
}

// FILE: central-icons.tsx
// Purpose: Resolve and render Central icon SVGs shipped as static web assets.
// Layer: web UI utility
// Exports: CentralIcon, getCentralIconUrl, createCentralIconElement, createCentralIconComponent
// Depends on: Vite public asset serving and app className merging utilities.

import { forwardRef, type CSSProperties, type HTMLAttributes, type ReactElement } from "react";
import { cn } from "./utils";

// Central icons ship in two visual sets served as static assets: the default
// "reversed" outline set and a solid "fill" set. The variant only selects the
// source folder — rendering (CSS mask + bg-current) is identical for both, so a
// fill asset paints as a solid glyph and an outline asset as a stroked one.
const CENTRAL_ICON_BASE_PATHS = {
  reversed: "/central-icons-reversed",
  fill: "/central-icons-fill",
} as const;
export type CentralIconVariant = keyof typeof CENTRAL_ICON_BASE_PATHS;
const DEFAULT_CENTRAL_ICON_VARIANT: CentralIconVariant = "reversed";
const SVG_SUFFIX = ".svg";
const CENTRAL_ICON_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export type CentralIconProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  name: string;
  label?: string | undefined;
  variant?: CentralIconVariant | undefined;
};

// Builds a public asset URL from the icon basename without allowing path traversal.
export function getCentralIconUrl(
  name: string,
  variant: CentralIconVariant = DEFAULT_CENTRAL_ICON_VARIANT,
): string | null {
  // Defensive: a non-string name (stale HMR module state, or a dynamic call site handing
  // through bad data) must degrade to "no icon" with a loud diagnostic instead of taking
  // down the whole tree with `name.endsWith is not a function`.
  if (typeof name !== "string") {
    console.error("[central-icons] non-string icon name:", name, new Error("caller").stack);
    return null;
  }
  const normalizedName = name.endsWith(SVG_SUFFIX) ? name.slice(0, -SVG_SUFFIX.length) : name;

  if (!CENTRAL_ICON_NAME_PATTERN.test(normalizedName)) {
    return null;
  }

  return `${CENTRAL_ICON_BASE_PATHS[variant]}/${encodeURIComponent(normalizedName)}${SVG_SUFFIX}`;
}

// Shared base classes so the React component and the imperative DOM helper stay
// pixel-identical (single uniform fill tinted to the current text color).
const CENTRAL_ICON_BASE_CLASS = "inline-block size-4 shrink-0 bg-current";
export const CENTRAL_ICON_SLOT = "central-icon";

// CSS-mask shorthand value that paints the icon as a solid `bg-current` fill.
function centralIconMaskValue(iconUrl: string): string {
  return `url("${iconUrl}") center / contain no-repeat`;
}

/** Mirror Button/Toggle `[&_svg:*]` child rules for masked Central icons. */
export function extendButtonIconChildSelectors(className: string): string {
  let result = className;

  result = result.replace(
    /\[&_svg:not\(\[class\*='opacity-'\]\)\]:([^\s"']+)/g,
    (match, util) =>
      `${match} [&_[data-slot=${CENTRAL_ICON_SLOT}]:not([class*='opacity-'])]:${util}`,
  );

  result = result.replace(
    /((?:sm:|not-in-data-\[slot=input-group\]:)?\[&_svg:not\(\[class\*='size-'\]\)\]:[^\s"']+)/g,
    (match) => {
      const central = match.replace("[&_svg:not", `[&_[data-slot=${CENTRAL_ICON_SLOT}]:not`);
      return `${match} ${central}`;
    },
  );

  result = result.replace(
    /\[&_svg\]:([a-z0-9\-/[\].]+)/g,
    (match, util) => `[&_svg,&_[data-slot=${CENTRAL_ICON_SLOT}]]:${util}`,
  );

  return result;
}

export const CentralIcon = forwardRef<HTMLSpanElement, CentralIconProps>(function CentralIcon(
  { name, label, variant, className, style, ...props },
  ref,
) {
  const iconUrl = getCentralIconUrl(name, variant);

  if (!iconUrl) {
    return null;
  }

  const maskValue = centralIconMaskValue(iconUrl);
  const maskStyle = {
    WebkitMask: maskValue,
    mask: maskValue,
    ...style,
  } satisfies CSSProperties;

  return (
    <span
      {...props}
      ref={ref}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-slot={CENTRAL_ICON_SLOT}
      className={cn(CENTRAL_ICON_BASE_CLASS, className)}
      style={maskStyle}
    />
  );
});

// Adapts a Central icon name to the `ComponentType<{ className?: string }>` shape
// expected by icon-prop APIs (SidebarIconButton, menu action descriptors, …) so
// Central glyphs can drop in wherever a react-icons/lucide component was used.
export function createCentralIconComponent(
  name: string,
  variant?: CentralIconVariant,
): (props: { className?: string }) => ReactElement {
  function CentralIconGlyph({ className }: { className?: string }) {
    return <CentralIcon name={name} variant={variant} className={className} />;
  }
  CentralIconGlyph.displayName = `CentralIconGlyph(${name})`;
  return CentralIconGlyph;
}

// Imperative twin of `CentralIcon` for non-React surfaces such as the Lexical
// composer chips that build their DOM by hand. Returns null when the name is
// invalid so callers can fall back to a static glyph.
export function createCentralIconElement(
  name: string,
  className?: string,
  variant?: CentralIconVariant,
): HTMLSpanElement | null {
  const iconUrl = getCentralIconUrl(name, variant);
  if (!iconUrl) {
    return null;
  }

  const span = document.createElement("span");
  span.setAttribute("aria-hidden", "true");
  span.dataset.slot = CENTRAL_ICON_SLOT;
  span.className = cn(CENTRAL_ICON_BASE_CLASS, className);
  const maskValue = centralIconMaskValue(iconUrl);
  span.style.setProperty("-webkit-mask", maskValue);
  span.style.setProperty("mask", maskValue);
  return span;
}

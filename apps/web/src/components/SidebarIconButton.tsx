// FILE: SidebarIconButton.tsx
// Purpose: Single square icon-button primitive shared by every sidebar control
//          (section headers, project headers, and row hover actions).
// Layer: Sidebar UI primitive
// Exports: SidebarIconButton, SidebarIconButtonSize
// Why: The sidebar had ~7 near-identical `sidebar-icon-button inline-flex size-N`
//      + `<Icon size-3.5>` buttons, several redundantly wrapped in their own
//      Tooltip/MenuTrigger blocks. This collapses them into one variant-driven
//      button so size, hover tone, tooltip, and the optional menu-trigger element
//      stay consistent in one place.

import {
  cloneElement,
  type ButtonHTMLAttributes,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import { cn } from "~/lib/utils";
import { type SidebarGlyphVariant, sidebarGlyphClass } from "./sidebarGlyphs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const SLOT_SIZE = {
  sm: "size-[18px]",
  md: "size-5",
  /**
   * Sidebar header-bar chrome (Search, Activity bell): a roomier hit target with a
   * softer radius than row actions. Single source of truth so every header control
   * keeps the same box — the Activity bell renders its own shell (unread dot +
   * controlled onboarding tooltip) and reuses this token instead of hardcoding it.
   */
  header: "size-6 rounded-md",
  /** Surface picker row. */
  lg: "size-7",
} as const;

export type SidebarIconButtonSize = keyof typeof SLOT_SIZE;

/** Box classes for a given sidebar icon-button slot, for shells that can't use the component. */
export function sidebarIconButtonSlotClass(size: SidebarIconButtonSize): string {
  return SLOT_SIZE[size];
}

type TooltipSide = "top" | "right" | "bottom" | "left";

export type SidebarIconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  // Accepts both our LucideIcon adapters and raw react-icons glyphs.
  icon: ComponentType<{ className?: string }>;
  // Always rendered as the accessible name (aria-label).
  label: string;
  /** Tailwind glyph scale; ignored when `iconClassName` is set. */
  glyph?: SidebarGlyphVariant;
  iconClassName?: string;
  size?: SidebarIconButtonSize;
  // When provided, the button is wrapped in a hover Tooltip (Base UI). Use
  // native `title` instead for row hover actions that should not pop a tooltip.
  tooltip?: ReactNode;
  tooltipSide?: TooltipSide;
  // Swap the underlying interactive element (e.g. `<MenuTrigger />`). Defaults
  // to a plain `<button type="button" />`. The icon is injected as its child.
  render?: ReactElement;
  "data-testid"?: string;
};

export function SidebarIconButton({
  icon: Icon,
  label,
  glyph: glyphProp,
  iconClassName,
  size: sizeProp,
  tooltip,
  tooltipSide: tooltipSideProp,
  render,
  className,
  ...buttonProps
}: SidebarIconButtonProps) {
  const glyph = glyphProp ?? "chrome";
  const size = sizeProp ?? "md";
  const tooltipSide = tooltipSideProp ?? "top";
  const triggerElement = (render ?? <button type="button" />) as ReactElement<{
    className?: string;
  }>;
  const mergedProps: Record<string, unknown> = {
    ...buttonProps,
    "aria-label": label,
    className: cn(
      "sidebar-icon-button inline-flex shrink-0 cursor-pointer",
      SLOT_SIZE[size],
      triggerElement.props.className,
      className,
    ),
  };
  const iconNode = <Icon className={iconClassName ?? sidebarGlyphClass(glyph)} />;
  const trigger = triggerElement as ReactElement<Record<string, unknown>>;

  if (!tooltip) {
    return cloneElement(trigger, mergedProps, iconNode);
  }

  return (
    <Tooltip>
      <TooltipTrigger render={cloneElement(trigger, mergedProps)}>{iconNode}</TooltipTrigger>
      <TooltipPopup side={tooltipSide}>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

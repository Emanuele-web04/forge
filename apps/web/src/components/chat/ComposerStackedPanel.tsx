// FILE: ComposerStackedPanel.tsx
// Purpose: Shared chrome for panels stacked above the composer input.
// Layer: Chat composer layout primitive
// Exports: ComposerStackedPanel and divider token for inner stacked-panel rows.

import { type HTMLAttributes, type ReactNode, type Ref } from "react";

import { cn } from "~/lib/utils";
import { ComposerStackedHeaderFrame } from "./ComposerColumnFrame";
import { COMPOSER_STACKED_PANEL_CHROME_CLASS_NAME } from "./composerStackedPanelStyles";

export { COMPOSER_STACKED_PANEL_DIVIDER_CLASS_NAME } from "./composerStackedPanelStyles";

interface ComposerStackedPanelProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  ref?: Ref<HTMLDivElement>;
  /** Removes the top radius so this panel visually merges into the one above it. */
  attachedToPrevious?: boolean;
  /** Lets clicks pass through the side margins to the transcript underneath. */
  passthroughSideMargins?: boolean;
  /** Drops the hairline outline, keeping only the translucent surface (empty-landing tray). */
  borderless?: boolean;
}

/** Single owner for composer-stacked panel frame, border, radius, and surface chrome. */
export function ComposerStackedPanel({
  children,
  className,
  ref,
  attachedToPrevious: attachedToPreviousProp,
  passthroughSideMargins: passthroughSideMarginsProp,
  borderless: borderlessProp,
  ...rest
}: ComposerStackedPanelProps) {
  const attachedToPrevious = attachedToPreviousProp ?? false;
  const passthroughSideMargins = passthroughSideMarginsProp ?? false;
  const borderless = borderlessProp ?? false;
  return (
    <ComposerStackedHeaderFrame
      ref={ref}
      passthroughSideMargins={passthroughSideMargins}
      data-composer-stacked-attached={attachedToPrevious ? "true" : undefined}
      className={cn(COMPOSER_STACKED_PANEL_CHROME_CLASS_NAME, borderless && "border-0", className)}
      {...rest}
    >
      {children}
    </ComposerStackedHeaderFrame>
  );
}

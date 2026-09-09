// FILE: PickerTriggerButton.tsx
// Purpose: Shares the trigger shell used by chat picker-style menus in the header and composer.
// Layer: Chat shell controls
// Depends on: button primitives, shared picker text styles, and icon slots supplied by callers.

import { type ComponentProps, type ReactNode } from "react";
import { ChevronDownIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME } from "./composerPickerStyles";

export function PickerTriggerButton(
  props: {
    icon: ReactNode;
    label: ReactNode;
    compact?: boolean;
    // Icon-only mode for narrow composers; the label stays available to
    // assistive tech and as a hover title.
    hideLabel?: boolean;
    // Drop the trailing chevron so the trigger reads as a plain label (e.g. the
    // folder picker) instead of an obvious dropdown.
    hideChevron?: boolean;
  } & Omit<ComponentProps<typeof Button>, "children" | "size">,
) {
  const {
    icon,
    label,
    compact,
    hideLabel,
    hideChevron,
    className,
    variant = "chrome",
    ...buttonProps
  } = props;

  return (
    <Button
      {...buttonProps}
      size="sm"
      variant={variant}
      {...(hideLabel && typeof label === "string" ? { title: label } : {})}
      className={cn(
        "min-w-0 justify-start overflow-hidden whitespace-nowrap px-1.5 text-[var(--color-text-foreground)] [&_svg]:mx-0",
        COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME,
        compact ? "max-w-52 shrink-0" : "max-w-56 shrink sm:max-w-64 sm:px-1.5",
        className,
      )}
    >
      <span
        className={cn(
          "flex min-w-0 w-full items-center gap-1.5 overflow-hidden",
          hideLabel ? "gap-1" : compact ? "max-w-44" : undefined,
        )}
      >
        <span className="inline-flex size-3.5 shrink-0 items-center justify-center">{icon}</span>
        {hideLabel ? (
          <span className="sr-only">{label}</span>
        ) : (
          <span className="min-w-0 flex-1 truncate">{label}</span>
        )}
        {hideChevron ? null : (
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        )}
      </span>
    </Button>
  );
}

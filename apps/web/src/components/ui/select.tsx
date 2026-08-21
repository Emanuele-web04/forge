"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { ChevronDownIcon, ChevronsUpDownIcon, ChevronUpIcon } from "~/lib/icons";
import * as React from "react";

import { cn } from "~/lib/utils";
import {
  APP_TRANSLUCENT_POPUP_SURFACE_BASE_CLASS_NAME,
  COMPOSER_PICKER_MENU_POPUP_BODY_CLASS_NAME,
  COMPOSER_PICKER_MENU_POPUP_VIEWPORT_CLASS_NAME,
  COMPOSER_PICKER_MENU_SURFACE_CLASS_NAME,
  COMPOSER_PICKER_SELECT_OPTION_CLASS_NAME,
  COMPOSER_SURFACE_SHADOW_CLASS_NAME,
} from "../chat/composerPickerStyles";

const Select = SelectPrimitive.Root;

// Every select popup uses a shared picker shell: "composer" is the app-wide
// frosted picker (ComposerPickerSelectPopup), "settings" the settings variant
// (SettingsSelectPopup). The legacy unstyled default surface was removed on
// purpose — do not add it back.
type SelectPopupSurface = "composer" | "settings";

const settingsSelectOptionClassName =
  "[&>svg]:-mx-0.5 flex cursor-default select-none items-center rounded-lg text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground)] outline-none data-disabled:pointer-events-none data-highlighted:bg-[var(--color-background-button-secondary-hover)] data-highlighted:text-[var(--color-text-foreground)] data-disabled:opacity-64 [&>svg:not([class*='opacity-'])]:opacity-80 [&>svg]:pointer-events-none [&>svg]:shrink-0 grid in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)]";

const SelectPopupSurfaceContext = React.createContext<SelectPopupSurface>("composer");

// Keep neutral select chrome on the same token families Codex uses for menus and list hover.
const selectTriggerVariants = cva(
  "relative inline-flex cursor-pointer select-none items-center justify-between gap-2 border rounded-md text-left text-[length:var(--app-font-size-ui,12px)] outline-none transition-[color,background-color] data-disabled:pointer-events-none data-disabled:opacity-64 sm:text-[length:var(--app-font-size-ui,12px)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      variant: {
        default:
          "w-full min-w-36 border-[color:var(--color-border)] bg-[var(--color-background-control-opaque)] text-[var(--color-text-foreground)] ring-[color:var(--color-border-focus)]/16 pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 focus-visible:border-[color:var(--color-border-focus)] focus-visible:ring-2 aria-invalid:border-destructive/30 focus-visible:aria-invalid:border-destructive/50 focus-visible:aria-invalid:ring-destructive/12 dark:aria-invalid:ring-destructive/20 [&_svg:not([class*='opacity-'])]:opacity-80",
        ghost:
          "border-transparent text-[var(--color-text-foreground-secondary)] focus-visible:ring-1 focus-visible:ring-[color:var(--color-border-focus)]/60 data-pressed:bg-[var(--color-background-elevated-secondary)] [:hover,[data-pressed]]:bg-[var(--color-background-elevated-secondary)] [:hover,[data-pressed]]:text-[var(--color-text-foreground)]",
      },
      size: {
        default: "min-h-9 px-[calc(--spacing(3)-1px)] sm:min-h-8",
        lg: "min-h-10 px-[calc(--spacing(3)-1px)] sm:min-h-9",
        sm: "min-h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] sm:min-h-7",
        xs: "h-7 gap-1 rounded-sm px-[calc(--spacing(2)-1px)] text-[length:var(--app-font-size-ui-sm,11px)] sm:h-6 sm:text-[length:var(--app-font-size-ui-xs,10px)] [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5",
      },
    },
  },
);

const selectTriggerIconClassName = "-me-1 size-4.5 opacity-80 sm:size-4";

interface SelectButtonProps extends useRender.ComponentProps<"button"> {
  size?: VariantProps<typeof selectTriggerVariants>["size"];
  variant?: VariantProps<typeof selectTriggerVariants>["variant"];
}

function SelectButton({ className, size, variant, render, children, ...props }: SelectButtonProps) {
  const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] = render
    ? undefined
    : "button";

  const defaultProps = {
    children: (
      <>
        <span className="flex-1 truncate in-data-placeholder:text-muted-foreground/72">
          {children}
        </span>
        {variant === "ghost" ? (
          <ChevronDownIcon className="size-3 opacity-50" />
        ) : (
          <ChevronsUpDownIcon className={selectTriggerIconClassName} />
        )}
      </>
    ),
    className: cn(selectTriggerVariants({ size, variant }), "min-w-0", className),
    "data-slot": "select-button",
    type: typeValue,
  };

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}

function SelectTrigger({
  className,
  size: sizeProp,
  variant: variantProp,
  children,
  ...props
}: SelectPrimitive.Trigger.Props & VariantProps<typeof selectTriggerVariants>) {
  const size = sizeProp === undefined ? "default" : sizeProp;
  const variant = variantProp === undefined ? "default" : variantProp;
  return (
    <SelectPrimitive.Trigger
      className={cn(selectTriggerVariants({ size, variant }), className)}
      data-slot="select-trigger"
      {...props}
    >
      {children}
      <SelectPrimitive.Icon data-slot="select-icon">
        <ChevronDownIcon className="size-3 opacity-50" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      className={cn("flex-1 truncate data-placeholder:text-muted-foreground", className)}
      data-slot="select-value"
      {...props}
    />
  );
}

function SelectPopup({
  className,
  shellClassName,
  children,
  side: sideProp,
  sideOffset: sideOffsetProp,
  align: alignProp,
  alignOffset: alignOffsetProp,
  alignItemWithTrigger: alignItemWithTriggerProp,
  anchor,
  surface,
  ...props
}: SelectPrimitive.Popup.Props & {
  side?: SelectPrimitive.Positioner.Props["side"];
  sideOffset?: SelectPrimitive.Positioner.Props["sideOffset"];
  align?: SelectPrimitive.Positioner.Props["align"];
  alignOffset?: SelectPrimitive.Positioner.Props["alignOffset"];
  alignItemWithTrigger?: SelectPrimitive.Positioner.Props["alignItemWithTrigger"];
  anchor?: SelectPrimitive.Positioner.Props["anchor"];
  surface: SelectPopupSurface;
  /** Size/shell classes applied to the composer picker viewport wrapper. */
  shellClassName?: string;
}) {
  const side = sideProp ?? "bottom";
  const sideOffset = sideOffsetProp ?? 4;
  const align = alignProp ?? "start";
  const alignOffset = alignOffsetProp ?? 0;
  const alignItemWithTrigger = alignItemWithTriggerProp ?? true;
  const viewportClassName = cn(
    COMPOSER_PICKER_MENU_POPUP_VIEWPORT_CLASS_NAME,
    surface === "settings"
      ? cn(
          APP_TRANSLUCENT_POPUP_SURFACE_BASE_CLASS_NAME,
          "rounded-lg",
          COMPOSER_SURFACE_SHADOW_CLASS_NAME,
        )
      : COMPOSER_PICKER_MENU_SURFACE_CLASS_NAME,
    shellClassName,
  );

  const listClassName = cn(
    COMPOSER_PICKER_MENU_POPUP_BODY_CLASS_NAME,
    "max-h-[min(var(--available-height),28rem)]",
    className,
  );
  const scrollArrowSurfaceClassName =
    surface === "settings"
      ? "before:from-[var(--app-settings-surface)]"
      : "before:from-[var(--composer-surface)]";

  return (
    <SelectPopupSurfaceContext.Provider value={surface}>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          align={align}
          alignItemWithTrigger={alignItemWithTrigger}
          alignOffset={alignOffset}
          anchor={anchor}
          className="z-50 select-none [-webkit-app-region:no-drag]"
          data-slot="select-positioner"
          side={side}
          sideOffset={sideOffset}
        >
          <SelectPrimitive.Popup
            className="origin-(--transform-origin) text-[var(--color-text-foreground)]"
            data-slot="select-popup"
            {...props}
          >
            <SelectPrimitive.ScrollUpArrow
              className={cn(
                "top-0 z-50 flex h-6 w-full cursor-default items-center justify-center before:pointer-events-none before:absolute before:inset-x-px before:top-px before:h-[200%] before:rounded-t-[calc(var(--radius-lg)-1px)] before:bg-linear-to-b before:from-50%",
                scrollArrowSurfaceClassName,
              )}
              data-slot="select-scroll-up-arrow"
            >
              <ChevronUpIcon className="relative size-4.5 sm:size-4" />
            </SelectPrimitive.ScrollUpArrow>
            {/* Keep a hard popup viewport cap so long theme lists can always scroll
                fully to both edges even when the positioner reports a tight height. */}
            <div className={viewportClassName}>
              <SelectPrimitive.List
                className={cn(listClassName, "relative z-1")}
                data-slot="menu-popup-body"
              >
                {children}
              </SelectPrimitive.List>
            </div>
            <SelectPrimitive.ScrollDownArrow
              className={cn(
                "bottom-0 z-50 flex h-6 w-full cursor-default items-center justify-center before:pointer-events-none before:absolute before:inset-x-px before:bottom-px before:h-[200%] before:rounded-b-[calc(var(--radius-lg)-1px)] before:bg-linear-to-t before:from-50%",
                scrollArrowSurfaceClassName,
              )}
              data-slot="select-scroll-down-arrow"
            >
              <ChevronDownIcon className="relative size-4.5 sm:size-4" />
            </SelectPrimitive.ScrollDownArrow>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPopupSurfaceContext.Provider>
  );
}

function SelectItem({
  className,
  children,
  hideIndicator: hideIndicatorProp,
  ...props
}: SelectPrimitive.Item.Props & {
  hideIndicator?: boolean;
}) {
  const hideIndicator = hideIndicatorProp ?? false;
  const popupSurface = React.useContext(SelectPopupSurfaceContext);
  const optionBaseClassName =
    popupSurface === "settings"
      ? settingsSelectOptionClassName
      : COMPOSER_PICKER_SELECT_OPTION_CLASS_NAME;

  return (
    <SelectPrimitive.Item
      className={cn(
        optionBaseClassName,
        hideIndicator ? "grid-cols-[1fr] ps-3 pe-3" : "grid-cols-[1fr_auto] gap-3 px-2.5",
        className,
      )}
      data-slot="select-item"
      {...props}
    >
      <SelectPrimitive.ItemText className="col-start-1 min-w-0" data-slot="select-item-text">
        {children}
      </SelectPrimitive.ItemText>
      {hideIndicator ? null : (
        <SelectPrimitive.ItemIndicator
          className="col-start-2 justify-self-end"
          data-slot="select-item-indicator"
        >
          <svg
            className="size-3"
            fill="none"
            height="24"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            viewBox="0 0 24 24"
            width="24"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
          </svg>
        </SelectPrimitive.ItemIndicator>
      )}
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({ className, ...props }: SelectPrimitive.Separator.Props) {
  return (
    <SelectPrimitive.Separator
      className={cn("mx-2 my-1 h-px bg-border", className)}
      data-slot="select-separator"
      {...props}
    />
  );
}

function SelectGroup(props: SelectPrimitive.Group.Props) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectGroupLabel(props: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      className="px-2 py-1.5 font-medium text-muted-foreground text-[length:var(--app-font-size-ui-xs,10px)]"
      data-slot="select-group-label"
      {...props}
    />
  );
}

export {
  Select,
  SelectTrigger,
  SelectButton,
  selectTriggerVariants,
  SelectValue,
  SelectPopup,
  SelectItem,
  SelectSeparator,
  SelectGroup,
  SelectGroupLabel,
};

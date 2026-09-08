"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { ChevronRightIcon } from "~/lib/icons";
import * as React from "react";

import { cn } from "~/lib/utils";
import {
  APP_TRANSLUCENT_POPUP_SURFACE_CLASS_NAME,
  COMPOSER_PICKER_MENU_OPTION_CLASS_NAME,
  COMPOSER_PICKER_MENU_POPUP_BODY_CLASS_NAME,
  COMPOSER_PICKER_MENU_SURFACE_CLASS_NAME,
} from "../chat/composerPickerStyles";
import { SWITCH_THUMB_CLASS_NAME, SWITCH_TRACK_CLASS_NAME } from "./switch";

const MenuCreateHandle = MenuPrimitive.createHandle;

type MenuProps = MenuPrimitive.Root.Props & {
  /** Keep a controlled menu open while one of its portalled submenus is being entered. */
  keepOpenOnSubmenuInteraction?: boolean;
};

function Menu({
  keepOpenOnSubmenuInteraction: keepOpenOnSubmenuInteractionProp,
  onOpenChange,
  ...props
}: MenuProps) {
  const keepOpenOnSubmenuInteraction = keepOpenOnSubmenuInteractionProp ?? false;
  const handleOpenChange: NonNullable<MenuPrimitive.Root.Props["onOpenChange"]> = (
    nextOpen,
    eventDetails,
  ) => {
    if (
      !nextOpen &&
      keepOpenOnSubmenuInteraction &&
      (eventDetails.reason === "sibling-open" ||
        eventDetails.reason === "trigger-hover" ||
        eventDetails.reason === "focus-out")
    ) {
      eventDetails.cancel();
      return;
    }
    onOpenChange?.(nextOpen, eventDetails);
  };

  return <MenuPrimitive.Root onOpenChange={handleOpenChange} {...props} />;
}

const MenuPortal = MenuPrimitive.Portal;

function MenuTrigger({ className, children, ...props }: MenuPrimitive.Trigger.Props) {
  return (
    <MenuPrimitive.Trigger className={className} data-slot="menu-trigger" {...props}>
      {children}
    </MenuPrimitive.Trigger>
  );
}

/** Low-level popup foundation. App surfaces should use ComposerPickerMenuPopup instead. */
function MenuPopupBase({
  children,
  className,
  surface: surfaceProp,
  pickerSize,
  sideOffset: sideOffsetProp,
  align: alignProp,
  alignOffset,
  side: sideProp,
  anchor,
  collisionAvoidance,
  ...props
}: MenuPrimitive.Popup.Props & {
  align?: MenuPrimitive.Positioner.Props["align"];
  sideOffset?: MenuPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: MenuPrimitive.Positioner.Props["alignOffset"];
  side?: MenuPrimitive.Positioner.Props["side"];
  anchor?: MenuPrimitive.Positioner.Props["anchor"];
  /** Root menus default to flipping only along their own axis (no top/bottom fallback for
   *  a side-placed menu); pass `{ fallbackAxisSide: "end" }` for side-placed root menus so
   *  they drop below the anchor when neither side fits. */
  collisionAvoidance?: MenuPrimitive.Positioner.Props["collisionAvoidance"];
  surface?: "default" | "composer";
  pickerSize?: "small" | "normal" | undefined;
}) {
  const surface = surfaceProp ?? "default";
  const sideOffset = sideOffsetProp ?? 4;
  const align = alignProp ?? "center";
  const side = sideProp ?? "bottom";
  const popupSurfaceClassName =
    surface === "composer"
      ? COMPOSER_PICKER_MENU_SURFACE_CLASS_NAME
      : APP_TRANSLUCENT_POPUP_SURFACE_CLASS_NAME;

  const isComposerSurface = surface === "composer";

  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        collisionAvoidance={collisionAvoidance}
        className={cn("z-50 min-w-32", isComposerSurface ? undefined : className)}
        data-slot="menu-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          className={cn(
            "relative flex origin-(--transform-origin) text-[var(--color-text-foreground)] outline-none focus:outline-none",
            isComposerSurface ? "min-w-0 max-w-[92vw]" : "w-full min-w-full",
            isComposerSurface ? className : null,
            popupSurfaceClassName,
          )}
          data-slot="menu-popup"
          {...props}
        >
          {surface === "composer" ? (
            <div
              className={cn(
                COMPOSER_PICKER_MENU_POPUP_BODY_CLASS_NAME,
                "relative z-1 max-h-(--available-height)",
              )}
              data-picker-size={pickerSize}
              data-slot="menu-popup-body"
            >
              {children}
            </div>
          ) : (
            <div className="max-h-(--available-height) w-full overflow-y-auto p-1">{children}</div>
          )}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function MenuGroup(props: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="menu-group" {...props} />;
}

function MenuItem({
  className,
  inset,
  variant: variantProp,
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean;
  variant?: "default" | "destructive";
}) {
  const variant = variantProp ?? "default";
  return (
    <MenuPrimitive.Item
      className={cn(
        COMPOSER_PICKER_MENU_OPTION_CLASS_NAME,
        // text-destructive (not -foreground): these items sit on the popup surface, so they
        // need the red accent itself — the foreground token is for text on a destructive fill.
        "data-inset:ps-8 data-[variant=destructive]:text-destructive",
        className,
      )}
      data-inset={inset}
      data-variant={variant}
      {...props}
      data-slot="menu-item"
    />
  );
}

function MenuCheckboxItem({
  className,
  children,
  checked,
  variant: variantProp,
  ...props
}: MenuPrimitive.CheckboxItem.Props & {
  variant?: "default" | "switch";
}) {
  const variant = variantProp ?? "default";
  return (
    <MenuPrimitive.CheckboxItem
      checked={checked}
      className={cn(
        cn(
          COMPOSER_PICKER_MENU_OPTION_CLASS_NAME,
          "grid in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] py-1 ps-2",
        ),
        variant === "switch"
          ? "grid-cols-[1fr_auto] gap-4 pe-1.5"
          : "grid-cols-[1fr_auto] gap-3 px-2.5",
        className,
      )}
      {...props}
      data-slot="menu-checkbox-item"
    >
      {variant === "switch" ? (
        <>
          <span className="col-start-1">{children}</span>
          <MenuPrimitive.CheckboxItemIndicator
            className={cn(
              SWITCH_TRACK_CLASS_NAME,
              "inset-shadow-[0_1px_--theme(--color-black/4%)] [--thumb-size:--spacing(4)] focus-visible:ring-1 sm:[--thumb-size:--spacing(3)]",
            )}
            keepMounted
          >
            <span
              className={cn(
                SWITCH_THUMB_CLASS_NAME,
                "in-[[data-slot=menu-checkbox-item][data-checked]]:origin-[var(--thumb-size)_50%] in-[[data-slot=menu-checkbox-item][data-checked]]:translate-x-[calc(var(--thumb-size)-4px)] in-[[data-slot=menu-checkbox-item]:active]:not-data-disabled:scale-x-110 in-[[data-slot=menu-checkbox-item]:active]:rounded-[var(--thumb-size)/calc(var(--thumb-size)*1.10)]",
              )}
            />
          </MenuPrimitive.CheckboxItemIndicator>
        </>
      ) : (
        <>
          <span className="col-start-1 min-w-0">{children}</span>
          <MenuPrimitive.CheckboxItemIndicator className="col-start-2 justify-self-end">
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
          </MenuPrimitive.CheckboxItemIndicator>
        </>
      )}
    </MenuPrimitive.CheckboxItem>
  );
}

function MenuRadioGroup(props: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="menu-radio-group" {...props} />;
}

function MenuRadioItem({
  className,
  children,
  preserveChildLayout: preserveChildLayoutProp,
  trailing,
  ...props
}: MenuPrimitive.RadioItem.Props & {
  preserveChildLayout?: boolean;
  trailing?: React.ReactNode;
}) {
  const preserveChildLayout = preserveChildLayoutProp ?? false;
  return (
    <MenuPrimitive.RadioItem
      className={cn(
        cn(
          COMPOSER_PICKER_MENU_OPTION_CLASS_NAME,
          preserveChildLayout
            ? "grid in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] grid-cols-[minmax(0,1fr)_2.5rem] gap-x-1.5 gap-y-0 px-2"
            : "w-full min-w-0 px-2.5",
        ),
        className,
      )}
      {...props}
      data-slot="menu-radio-item"
    >
      {preserveChildLayout ? (
        <>
          <span className="col-start-1 min-w-0">{children}</span>
          <div className="col-start-2 flex shrink-0 items-center justify-end gap-0.5">
            <MenuPrimitive.RadioItemIndicator className="shrink-0 data-unchecked:hidden">
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
            </MenuPrimitive.RadioItemIndicator>
            {trailing}
          </div>
        </>
      ) : (
        <span className="flex w-full min-w-0 items-center gap-2">
          {children}
          <MenuPrimitive.RadioItemIndicator className="ml-auto shrink-0">
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
          </MenuPrimitive.RadioItemIndicator>
        </span>
      )}
    </MenuPrimitive.RadioItem>
  );
}

function MenuGroupLabel({
  className,
  inset,
  ...props
}: MenuPrimitive.GroupLabel.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.GroupLabel
      // Shared section/group label style: matches the composer picker section
      // headers (e.g. "Effort"). Picker menus may still override padding-block
      // via the `--picker-section-py` token on `[data-slot="menu-label"]`.
      className={cn(
        "px-2 py-1.5 font-normal text-xs text-muted-foreground/45 data-inset:ps-9 sm:data-inset:ps-8",
        className,
      )}
      data-inset={inset}
      data-slot="menu-label"
      {...props}
    />
  );
}

function MenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      className={cn("mx-2 my-1 h-px bg-border", className)}
      data-slot="menu-separator"
      {...props}
    />
  );
}

function MenuShortcut({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "ms-auto font-medium font-sans text-muted-foreground/72 text-[length:var(--app-font-size-ui-xs,10px)] tracking-widest",
        className,
      )}
      data-slot="menu-shortcut"
      {...props}
    />
  );
}

type MenuSubProps = MenuPrimitive.SubmenuRoot.Props & {
  /** Keep a hover-open submenu mounted when focus moves into its portalled popup. */
  keepOpenOnFocusOut?: boolean;
};

function FocusStableMenuSub({
  defaultOpen,
  onOpenChange,
  open: controlledOpen,
  ...props
}: MenuPrimitive.SubmenuRoot.Props) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false);
  const open = controlledOpen ?? uncontrolledOpen;
  const handleOpenChange: NonNullable<MenuPrimitive.SubmenuRoot.Props["onOpenChange"]> = (
    nextOpen,
    eventDetails,
  ) => {
    // Base UI can report focus-out while the pointer is already inside the submenu's
    // portalled popup. Let the parent menu's outside/sibling handling own real dismissal.
    if (!nextOpen && eventDetails.reason === "focus-out") return;
    if (controlledOpen === undefined) setUncontrolledOpen(nextOpen);
    onOpenChange?.(nextOpen, eventDetails);
  };

  return (
    <MenuPrimitive.SubmenuRoot
      data-slot="menu-sub"
      open={open}
      onOpenChange={handleOpenChange}
      {...props}
    />
  );
}

function MenuSub({ keepOpenOnFocusOut: keepOpenOnFocusOutProp, ...props }: MenuSubProps) {
  const keepOpenOnFocusOut = keepOpenOnFocusOutProp ?? false;
  return keepOpenOnFocusOut ? (
    <FocusStableMenuSub {...props} />
  ) : (
    <MenuPrimitive.SubmenuRoot data-slot="menu-sub" {...props} />
  );
}

function MenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.SubmenuTrigger
      className={cn(
        cn(
          COMPOSER_PICKER_MENU_OPTION_CLASS_NAME,
          "data-popup-open:bg-[var(--color-background-button-secondary-hover)] data-popup-open:text-[var(--color-text-foreground)] data-inset:ps-8",
        ),
        className,
      )}
      data-inset={inset}
      {...props}
      data-slot="menu-sub-trigger"
    >
      {children}
      <ChevronRightIcon className="-me-0.5 shrink-0" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

function MenuSubPopup({
  className,
  surface: surfaceProp,
  pickerSize,
  sideOffset: sideOffsetProp,
  alignOffset,
  align: alignProp,
  side: sideProp,
  ...props
}: MenuPrimitive.Popup.Props & {
  align?: MenuPrimitive.Positioner.Props["align"];
  sideOffset?: MenuPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: MenuPrimitive.Positioner.Props["alignOffset"];
  /** Cascade direction; `inline-start` when the parent menu already opened toward the start. */
  side?: "inline-end" | "inline-start";
  surface?: "default" | "composer";
  pickerSize?: "small" | "normal";
}) {
  const surface = surfaceProp ?? "default";
  const sideOffset = sideOffsetProp ?? 0;
  const align = alignProp ?? "start";
  const side = sideProp ?? "inline-end";
  const defaultAlignOffset = align !== "center" ? -5 : undefined;

  return (
    <MenuPopupBase
      align={align}
      alignOffset={alignOffset ?? defaultAlignOffset}
      className={className}
      data-slot="menu-sub-content"
      pickerSize={pickerSize}
      side={side}
      sideOffset={sideOffset}
      surface={surface}
      {...props}
    />
  );
}

export {
  MenuCreateHandle,
  Menu,
  MenuPortal,
  MenuTrigger,
  MenuPopupBase,
  MenuGroup,
  MenuItem,
  MenuCheckboxItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuGroupLabel,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
};

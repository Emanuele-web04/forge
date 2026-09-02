// FILE: ComposerModelEffortPicker.tsx
// Purpose: Combined composer picker for model + effort/reasoning + speed in a single trigger.
// Layer: Chat composer presentation
// Depends on: provider/model menu items, traits menu content (which owns the fast-mode
//   toggle in its Effort header), shared menu primitives, and composer trait helpers.

import {
  type ModelSlug,
  type ProviderAgentDescriptor,
  type ProviderKind,
  type ProviderModelDescriptor,
  type ProviderModelOptions,
  type ServerProviderStatus,
  type ThreadId,
} from "@synara/contracts";
import { useState } from "react";

import { ChevronDownIcon, FastModeIcon, SettingsIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { type ProviderModelOption } from "../../providerModelOptions";
import { Button } from "../ui/button";
import { Menu, MenuSeparator, MenuSub, MenuSubTrigger, MenuTrigger } from "../ui/menu";
import { ShortcutKbd } from "../ui/shortcut-kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PROVIDER_ICON_COMPONENT_BY_PROVIDER } from "../ProviderIcon";
import {
  COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME,
  COMPOSER_PICKER_MODEL_SUBMENU_HEIGHT_CLASS_NAME,
  COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME,
} from "./composerPickerStyles";
import { ComposerPickerMenuPopup, ComposerPickerMenuSubPopup } from "./ComposerPickerMenuPopup";
import {
  getComposerTraitSelection,
  hasVisibleComposerTraitControls,
  resolveComposerTraitStatusLabel,
  showsComposerFastModeBadge,
} from "./composerTraits";
import {
  getProviderIconClassName,
  ProviderModelMenuItems,
  resolveProviderModelLabel,
} from "./ProviderModelPicker";
import { TraitsMenuContent } from "./TraitsPicker";

type ComposerModelEffortPickerProps = {
  // Model picker data.
  provider: ProviderKind;
  model: ModelSlug;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProviderStatus>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelOption>>;
  loadingModelProviders?: Partial<Record<ProviderKind, boolean>>;
  discoveryErrorsByProvider?: Partial<Record<ProviderKind, string | undefined>>;
  hiddenProviders?: ReadonlyArray<ProviderKind>;
  providerOrder?: ReadonlyArray<ProviderKind>;
  compact?: boolean;
  // Narrow-composer degradation: drop the model name (provider icon stays)
  // and/or the effort/status label; both remain available to assistive tech.
  hideModelLabel?: boolean;
  hideStatusLabel?: boolean;
  disabled?: boolean;
  onProviderModelChange: (provider: ProviderKind, model: ModelSlug) => void;
  onSelectionCommitted?: () => void;

  // Traits/effort/speed data.
  threadId: ThreadId;
  runtimeModel?: ProviderModelDescriptor | undefined;
  runtimeModels?: ReadonlyArray<ProviderModelDescriptor> | null | undefined;
  runtimeAgents?: ReadonlyArray<ProviderAgentDescriptor> | null | undefined;
  modelOptions: ProviderModelOptions[ProviderKind] | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;

  // Shared menu control.
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  shortcutLabel?: string | null;
};

// Renders a single composer trigger that combines model selection, reasoning
// effort, and the optional speed/fast-mode toggle. The primary menu hosts the
// reasoning radio group (with fast mode as an icon toggle in its Effort
// header); the model is reachable via a sub-menu so the footer stays compact.
export function ComposerModelEffortPicker(props: ComposerModelEffortPickerProps) {
  const { onOpenChange, open } = props;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isMenuOpen = open ?? uncontrolledOpen;

  const setMenuOpen = (nextOpen: boolean) => {
    if (open === undefined) {
      setUncontrolledOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  };

  const activeProvider = props.lockedProvider ?? props.provider;
  const ProviderIcon = PROVIDER_ICON_COMPONENT_BY_PROVIDER[activeProvider];
  const modelLabel = resolveProviderModelLabel({
    provider: props.provider,
    lockedProvider: props.lockedProvider,
    model: props.model,
    modelOptionsByProvider: props.modelOptionsByProvider,
  });

  const traitSelection = getComposerTraitSelection(
    props.provider,
    props.model,
    props.prompt,
    props.modelOptions,
    props.runtimeModel,
  );

  const hasTraitsTopSection = hasVisibleComposerTraitControls(traitSelection);

  const triggerStatusLabel = resolveComposerTraitStatusLabel(traitSelection);
  const showsFastBadge = showsComposerFastModeBadge(traitSelection);

  const handleAfterModelSelection = () => {
    setMenuOpen(false);
    props.onSelectionCommitted?.();
  };

  const handleAfterTraitsSelection = () => {
    setMenuOpen(false);
    props.onSelectionCommitted?.();
  };

  const hiddenTriggerTitle = [
    props.hideModelLabel ? modelLabel : null,
    props.hideStatusLabel ? triggerStatusLabel : null,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" · ");

  const triggerButton = (
    <Button
      size="sm"
      variant="chrome"
      disabled={props.disabled ?? false}
      className={cn(
        "min-w-0 shrink-0 justify-start gap-1.5 whitespace-nowrap px-2 sm:px-2.5 [&_svg]:mx-0",
        COMPOSER_PICKER_TRIGGER_TEXT_CLASS_NAME,
      )}
      aria-label="Change model and reasoning"
      {...(hiddenTriggerTitle.length > 0 ? { title: hiddenTriggerTitle } : {})}
    />
  );

  const triggerContent = (
    <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
      <ProviderIcon
        aria-hidden="true"
        className={cn(
          // opacity-100 opts out of the Button base's [&_svg]:opacity-80 dimming.
          "size-3.5 shrink-0 opacity-100",
          getProviderIconClassName(activeProvider, "text-[var(--color-text-foreground)]"),
        )}
      />
      {props.hideModelLabel ? (
        <span className="sr-only">{modelLabel}</span>
      ) : (
        <span className="min-w-0 truncate text-[var(--color-text-foreground)]">{modelLabel}</span>
      )}
      {showsFastBadge ? (
        <FastModeIcon
          aria-hidden="true"
          className={cn("size-3.5 shrink-0", COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME)}
        />
      ) : null}
      {triggerStatusLabel ? (
        props.hideStatusLabel ? (
          <>
            <SettingsIcon
              aria-hidden="true"
              className={cn("size-3.5 shrink-0", COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME)}
            />
            <span className="sr-only">{triggerStatusLabel}</span>
          </>
        ) : (
          <span className={cn("shrink-0", COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME)}>
            {triggerStatusLabel}
          </span>
        )
      ) : null}
      <ChevronDownIcon aria-hidden="true" className="ms-0.5 size-3 shrink-0 opacity-60" />
    </span>
  );

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(nextOpen) => {
        if (props.disabled) {
          setMenuOpen(false);
          return;
        }
        setMenuOpen(nextOpen);
      }}
    >
      {props.shortcutLabel ? (
        <Tooltip>
          <TooltipTrigger render={<MenuTrigger render={triggerButton} />}>
            {triggerContent}
          </TooltipTrigger>
          {!isMenuOpen ? (
            <TooltipPopup side="top" sideOffset={6} variant="picker">
              <span className="inline-flex items-center gap-2 px-1 py-0.5">
                <span>Change model</span>
                <ShortcutKbd
                  shortcutLabel={props.shortcutLabel}
                  className="h-4 min-w-4 px-1 text-[length:var(--app-font-size-ui-2xs,9px)] text-muted-foreground"
                />
              </span>
            </TooltipPopup>
          ) : null}
        </Tooltip>
      ) : (
        <MenuTrigger render={triggerButton}>{triggerContent}</MenuTrigger>
      )}
      <ComposerPickerMenuPopup align="end" side="top" fixedWidth>
        {hasTraitsTopSection ? (
          <TraitsMenuContent
            provider={props.provider}
            threadId={props.threadId}
            model={props.model}
            {...(props.runtimeModel ? { runtimeModel: props.runtimeModel } : {})}
            {...(props.runtimeModels !== undefined ? { runtimeModels: props.runtimeModels } : {})}
            {...(props.runtimeAgents !== undefined ? { runtimeAgents: props.runtimeAgents } : {})}
            modelOptions={props.modelOptions}
            prompt={props.prompt}
            onPromptChange={props.onPromptChange}
            onSelectionComplete={handleAfterTraitsSelection}
          />
        ) : null}

        {hasTraitsTopSection ? <MenuSeparator /> : null}

        <MenuSub>
          <MenuSubTrigger>
            <ProviderIcon
              aria-hidden="true"
              className={cn("size-3 shrink-0", getProviderIconClassName(activeProvider))}
            />
            <span className="truncate">{modelLabel}</span>
          </MenuSubTrigger>
          <ComposerPickerMenuSubPopup
            fixedWidth
            className={COMPOSER_PICKER_MODEL_SUBMENU_HEIGHT_CLASS_NAME}
          >
            <ProviderModelMenuItems
              provider={props.provider}
              model={props.model}
              lockedProvider={props.lockedProvider}
              {...(props.providers ? { providers: props.providers } : {})}
              modelOptionsByProvider={props.modelOptionsByProvider}
              {...(props.loadingModelProviders
                ? { loadingModelProviders: props.loadingModelProviders }
                : {})}
              {...(props.discoveryErrorsByProvider
                ? { discoveryErrorsByProvider: props.discoveryErrorsByProvider }
                : {})}
              {...(props.hiddenProviders ? { hiddenProviders: props.hiddenProviders } : {})}
              {...(props.providerOrder ? { providerOrder: props.providerOrder } : {})}
              {...(props.disabled !== undefined ? { disabled: props.disabled } : {})}
              onProviderModelChange={props.onProviderModelChange}
              onAfterSelection={handleAfterModelSelection}
            />
          </ComposerPickerMenuSubPopup>
        </MenuSub>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

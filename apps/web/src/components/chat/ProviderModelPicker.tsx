// FILE: ProviderModelPicker.tsx
// Purpose: Renders the composer provider/model menu and supports controlled opening for shortcuts.
// Layer: Chat composer presentation
// Depends on: provider availability metadata, shared menu primitives, and picker trigger styling.

import {
  type ModelSlug,
  type ProviderKind,
  type ServerProviderStatus,
  PROVIDER_DISPLAY_NAMES,
} from "@synara/contracts";
import { resolveSelectableModel } from "@synara/shared/model";
import * as Schema from "effect/Schema";
import { useDeferredValue, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { providerDiscoveryQueryKeys } from "../../lib/providerDiscoveryReactQuery";
import { type ProviderPickerKind, PROVIDER_OPTIONS } from "../../session-logic";
import { appHistory } from "../../appNavigation";
import { formatProviderModelOptionName } from "../../providerModelOptions";
import { compareProvidersByOrder } from "../../providerOrdering";
import {
  Menu,
  MenuItem,
  MenuRadioGroup,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { PROVIDER_ICON_COMPONENT_BY_PROVIDER } from "../ProviderIcon";
import { cn } from "~/lib/utils";
import { PickerPanelShell } from "./PickerPanelShell";
import { PickerTriggerButton } from "./PickerTriggerButton";
import { ProviderModelOptionGroupList } from "./ProviderModelOptionGroupList";
import { ComposerPickerMenuPopup, ComposerPickerMenuSubPopup } from "./ComposerPickerMenuPopup";
import {
  COMPOSER_PICKER_MODEL_LIST_MAX_HEIGHT_CLASS_NAME,
  COMPOSER_PICKER_MODEL_LIST_SCROLL_CLASS_NAME,
  COMPOSER_PICKER_MODEL_SUBMENU_HEIGHT_CLASS_NAME,
  COMPOSER_PICKER_MENU_OPTION_CLASS_NAME,
} from "./composerPickerStyles";
import { ShortcutKbd } from "../ui/shortcut-kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  DISCOVERY_OWNED_MODEL_PROVIDERS,
  groupProviderModelOptions,
  groupProviderModelOptionsWithFavorites,
  shouldUseCollapsibleModelGroups,
  type ProviderModelOption,
} from "../../providerModelOptions";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import {
  FAVORITE_MODEL_STORAGE_KEYS,
  supportsModelFavorites,
  type FavoriteModelProvider,
} from "../../lib/modelFavorites";
import { Skeleton } from "../ui/skeleton";
import { PlusIcon, RefreshCwIcon } from "~/lib/icons";
import type { ProviderModelDiscoveryState } from "../../hooks/useProviderModelCatalog";

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter((option) => option.available);

function providerIconClassName(
  provider: ProviderKind | ProviderPickerKind,
  fallbackClassName: string,
): string {
  return provider === "claudeAgent" || provider === "antigravity" || provider === "pi"
    ? "text-foreground"
    : fallbackClassName;
}

const SEARCHABLE_MODEL_PICKER_THRESHOLD = 15;
const FavoriteModelSlugs = Schema.Array(Schema.String);
const EMPTY_FAVORITE_MODEL_SLUGS: ReadonlyArray<string> = [];

// Keeps persisted favorite slugs compact and stable while preserving the user's order.
function toggleFavoriteModelSlug(current: ReadonlyArray<string>, slug: string): string[] {
  const normalizedCurrent = Array.from(new Set(current.filter((entry) => entry.trim().length > 0)));
  return normalizedCurrent.includes(slug)
    ? normalizedCurrent.filter((entry) => entry !== slug)
    : [...normalizedCurrent, slug];
}

function stripParameterizedModelSuffix(model: string): string {
  return model.trim().replace(/\[[^\]]*\]$/u, "");
}

function resolveSelectedModelLabel(input: {
  provider: ProviderKind;
  model: string;
  options: ReadonlyArray<ProviderModelOption>;
}): string {
  const exact = input.options.find((option) => option.slug === input.model);
  if (exact) {
    return exact.name;
  }
  if (input.provider === "cursor") {
    const baseModel = stripParameterizedModelSuffix(input.model);
    const baseMatch = input.options.find(
      (option) => stripParameterizedModelSuffix(option.slug) === baseModel,
    );
    if (baseMatch) {
      return baseMatch.name;
    }
  }
  return formatProviderModelOptionName({
    provider: input.provider,
    slug: input.model,
  });
}

function buildModelSearchText(option: ProviderModelOption): string {
  return [
    option.name,
    option.slug,
    option.description,
    option.upstreamProviderName,
    option.upstreamProviderId,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
}

function formatCatalogAgeLabel(fetchedAt: number | undefined): string {
  if (!fetchedAt || Date.now() - fetchedAt < 60_000) return fetchedAt ? "Updated just now" : "";
  const minutes = Math.floor((Date.now() - fetchedAt) / 60_000);
  const [amount, unit] =
    minutes < 60
      ? [minutes, "minute"]
      : minutes < 1440
        ? [Math.floor(minutes / 60), "hour"]
        : [Math.floor(minutes / 1440), "day"];
  return `Updated ${new Intl.RelativeTimeFormat("en", { style: "narrow", numeric: "always" }).format(-amount, unit as Intl.RelativeTimeFormatUnit)}`;
}

function DiscoveryStatusRow({
  provider,
  discovery,
  onRefresh,
}: {
  provider: ProviderKind;
  discovery: ProviderModelDiscoveryState;
  onRefresh: () => void;
}) {
  if (discovery.status === "never-loaded" || discovery.status === "loading") return null;
  const busy = discovery.refreshing;
  const displayName = PROVIDER_DISPLAY_NAMES[provider];
  const noList = discovery.status === "failed" && !discovery.hasDynamicList;
  const title =
    discovery.status === "empty"
      ? `No models available from ${displayName}`
      : noList
        ? "Couldn’t load models"
        : discovery.status === "failed"
          ? "Couldn’t refresh"
          : "Refresh models";
  const detail =
    discovery.status === "empty"
      ? `Check the ${displayName} configuration and authentication, then retry.`
      : noList
        ? `${displayName} discovery failed`
        : null;
  const action = busy
    ? "Refreshing…"
    : discovery.status === "success"
      ? formatCatalogAgeLabel(discovery.fetchedAt)
      : "Retry";
  return (
    <button
      type="button"
      disabled={busy}
      className={cn(
        COMPOSER_PICKER_MENU_OPTION_CLASS_NAME,
        "w-full justify-between gap-2 text-[length:var(--app-font-size-ui,12px)] text-foreground hover:bg-[var(--color-background-button-secondary-hover)] disabled:cursor-not-allowed disabled:opacity-60",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onRefresh();
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span
        className={
          detail
            ? "flex min-w-0 flex-col items-start text-left"
            : "inline-flex items-center gap-1.5"
        }
      >
        {!detail ? (
          <RefreshCwIcon
            aria-hidden="true"
            className={cn("size-3 shrink-0", busy && "animate-spin motion-reduce:animate-none")}
          />
        ) : null}
        <span>{title}</span>
        {detail ? (
          <span className="text-[length:var(--app-font-size-ui-2xs,10px)] text-muted-foreground/70">
            {detail}
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          "shrink-0",
          discovery.status === "success" &&
            "text-[length:var(--app-font-size-ui-2xs,10px)] text-muted-foreground/70",
        )}
      >
        {action}
      </span>
    </button>
  );
}

type ProviderModelMenuItemsProps = {
  provider: ProviderKind;
  model: ModelSlug;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProviderStatus>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelOption>>;
  modelDiscoveryByProvider?: Record<ProviderKind, ProviderModelDiscoveryState>;
  hiddenProviders?: ReadonlyArray<ProviderKind>;
  providerOrder?: ReadonlyArray<ProviderKind>;
  disabled?: boolean;
  onProviderModelChange: (provider: ProviderKind, model: ModelSlug) => void;
  onAfterSelection?: () => void;
};

export const ProviderModelMenuItems = function ProviderModelMenuItems(
  props: ProviderModelMenuItemsProps,
) {
  const { onAfterSelection } = props;
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const [cursorFavoriteModelSlugs, setCursorFavoriteModelSlugs] = useLocalStorage(
    FAVORITE_MODEL_STORAGE_KEYS.cursor,
    EMPTY_FAVORITE_MODEL_SLUGS,
    FavoriteModelSlugs,
  );
  const [openCodeFavoriteModelSlugs, setOpenCodeFavoriteModelSlugs] = useLocalStorage(
    FAVORITE_MODEL_STORAGE_KEYS.opencode,
    EMPTY_FAVORITE_MODEL_SLUGS,
    FavoriteModelSlugs,
  );
  const [piFavoriteModelSlugs, setPiFavoriteModelSlugs] = useLocalStorage(
    FAVORITE_MODEL_STORAGE_KEYS.pi,
    EMPTY_FAVORITE_MODEL_SLUGS,
    FavoriteModelSlugs,
  );
  const deferredModelSearchQuery = useDeferredValue(modelSearchQuery);
  const activeProvider = props.lockedProvider ?? props.provider;
  const hiddenProviderSet = new Set<ProviderKind>(props.hiddenProviders ?? []);
  const protectedProviderSet = new Set<ProviderKind>([props.provider]);
  if (props.lockedProvider !== null) {
    protectedProviderSet.add(props.lockedProvider);
  }
  const availableProviderOptions = AVAILABLE_PROVIDER_OPTIONS.toSorted((left, right) =>
    compareProvidersByOrder(props.providerOrder ?? [], left.value, right.value),
  ).filter((option) =>
    props.providers?.some((provider) => provider.provider === option.value && provider.available),
  );
  const visibleAvailableProviderOptions = availableProviderOptions.filter(
    (option) => protectedProviderSet.has(option.value) || !hiddenProviderSet.has(option.value),
  );
  const favoriteModelSlugSets = {
    cursor: new Set(cursorFavoriteModelSlugs),
    opencode: new Set(openCodeFavoriteModelSlugs),
    pi: new Set(piFavoriteModelSlugs),
  };
  const handleModelChange = (provider: ProviderKind, value: string) => {
    if (props.disabled) return;
    if (!value) return;
    const resolvedModel = resolveSelectableModel(
      provider,
      value,
      props.modelOptionsByProvider[provider],
    );
    if (!resolvedModel) return;
    props.onProviderModelChange(provider, resolvedModel);
    onAfterSelection?.();
  };
  const favoriteSetters = {
    cursor: setCursorFavoriteModelSlugs,
    opencode: setOpenCodeFavoriteModelSlugs,
    pi: setPiFavoriteModelSlugs,
  };
  const toggleFavoriteModel = (provider: FavoriteModelProvider, slug: string) => {
    favoriteSetters[provider]((current) => toggleFavoriteModelSlug(current, slug));
  };

  const queryClient = useQueryClient();

  const renderModelRadioGroup = (provider: ProviderKind) => {
    const discovery = props.modelDiscoveryByProvider?.[provider];
    const isDiscoveryOwned = DISCOVERY_OWNED_MODEL_PROVIDERS.has(provider);

    if (isDiscoveryOwned && discovery?.status === "loading") {
      return (
        <div className="space-y-2 px-2 py-2" aria-label="Loading models">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="flex items-center gap-2 rounded-md px-2 py-1.5">
              <Skeleton className="size-3.5 rounded-full" />
              <Skeleton className={cn("h-3.5 rounded-full", index % 3 === 0 ? "w-24" : "w-32")} />
            </div>
          ))}
        </div>
      );
    }

    const providerOptions = props.modelOptionsByProvider[provider];
    const shouldShowSearch = providerOptions.length >= SEARCHABLE_MODEL_PICKER_THRESHOLD;
    const normalizedModelSearchQuery = deferredModelSearchQuery.trim().toLowerCase();
    const filteredOptions =
      shouldShowSearch && normalizedModelSearchQuery.length > 0
        ? providerOptions.filter((option) =>
            buildModelSearchText(option).includes(normalizedModelSearchQuery),
          )
        : providerOptions;
    const favoriteProvider = supportsModelFavorites(provider) ? provider : null;
    const favoriteModelSlugSet =
      favoriteProvider !== null ? favoriteModelSlugSets[favoriteProvider] : undefined;
    const groupedOptions =
      favoriteModelSlugSet !== undefined
        ? groupProviderModelOptionsWithFavorites({
            options: filteredOptions,
            favoriteSlugs: favoriteModelSlugSet,
          })
        : groupProviderModelOptions(filteredOptions);

    const content =
      groupedOptions.length > 0 ? (
        <MenuRadioGroup
          value={activeProvider === provider ? props.model : ""}
          onValueChange={(value) => handleModelChange(provider, value)}
        >
          <ProviderModelOptionGroupList
            groupedOptions={groupedOptions}
            provider={provider}
            activeModel={props.model}
            isSearching={normalizedModelSearchQuery.length > 0}
            favoriteProvider={favoriteProvider}
            favoriteModelSlugSet={favoriteModelSlugSet}
            onToggleFavorite={toggleFavoriteModel}
          />
        </MenuRadioGroup>
      ) : (
        <div className="px-2 py-2 text-muted-foreground text-sm">
          {provider === "pi" && normalizedModelSearchQuery.length === 0
            ? "No Pi models found"
            : "No matches"}
        </div>
      );

    const discoveryStatusRow =
      isDiscoveryOwned && discovery !== undefined ? (
        <DiscoveryStatusRow
          provider={provider}
          discovery={discovery}
          onRefresh={() => {
            // refetchQueries defaults to active queries, so only mounted
            // pickers trigger discovery work.
            void queryClient
              .refetchQueries({
                queryKey: providerDiscoveryQueryKeys.modelsForProvider(provider),
              })
              .catch(() => undefined);
          }}
        />
      ) : null;

    if (
      isDiscoveryOwned &&
      ((discovery?.status === "failed" && discovery?.hasDynamicList === false) ||
        discovery?.status === "empty")
    ) {
      // Discovery owns this catalog, so a failed or empty live list must not
      // fall back to the static catalog: show only the selected model and
      // selection hints, plus the retry row.
      const selectedOptions = providerOptions.filter(
        (option) => option.isSelectionHint === true || option.slug === props.model,
      );
      if (selectedOptions.length === 0) return discoveryStatusRow;
      return (
        <>
          <MenuRadioGroup
            value={activeProvider === provider ? props.model : ""}
            onValueChange={(value) => handleModelChange(provider, value)}
          >
            <ProviderModelOptionGroupList
              groupedOptions={groupProviderModelOptions(selectedOptions)}
              provider={provider}
              activeModel={props.model}
              isSearching={false}
              favoriteProvider={null}
              favoriteModelSlugSet={undefined}
              onToggleFavorite={toggleFavoriteModel}
            />
          </MenuRadioGroup>
          {discoveryStatusRow}
        </>
      );
    }

    const listWithFooter = (
      <>
        {content}
        {discoveryStatusRow}
      </>
    );

    if (!shouldShowSearch) {
      const needsScrollContainer =
        filteredOptions.length >= SEARCHABLE_MODEL_PICKER_THRESHOLD ||
        shouldUseCollapsibleModelGroups(groupedOptions.length, false);
      if (needsScrollContainer) {
        return (
          <div
            className={cn(
              "overflow-y-auto overscroll-contain py-0.5",
              COMPOSER_PICKER_MODEL_LIST_SCROLL_CLASS_NAME,
              COMPOSER_PICKER_MODEL_LIST_MAX_HEIGHT_CLASS_NAME,
            )}
          >
            {listWithFooter}
          </div>
        );
      }
      return listWithFooter;
    }

    return (
      <PickerPanelShell
        searchPlaceholder="Search models or providers"
        query={modelSearchQuery}
        onQueryChange={setModelSearchQuery}
        stopSearchKeyPropagation
        autoFocusSearch
        widthClassName="w-full"
        bleedParentPadding
        listMaxHeightClassName={COMPOSER_PICKER_MODEL_LIST_MAX_HEIGHT_CLASS_NAME}
        footer={discoveryStatusRow}
      >
        {content}
      </PickerPanelShell>
    );
  };

  if (props.lockedProvider !== null) {
    return <>{renderModelRadioGroup(props.lockedProvider)}</>;
  }

  return (
    <>
      {visibleAvailableProviderOptions.map((option) => {
        const OptionIcon = PROVIDER_ICON_COMPONENT_BY_PROVIDER[option.value];
        const liveProvider = props.providers?.find((entry) => entry.provider === option.value);
        const availability: { disabled: boolean; label: string | null } = !liveProvider
          ? { disabled: true, label: "Checking" }
          : !liveProvider.available
            ? {
                disabled: true,
                label: liveProvider.authStatus === "unauthenticated" ? "Sign in" : "Unavailable",
              }
            : liveProvider.authStatus === "unauthenticated"
              ? { disabled: true, label: "Sign in" }
              : { disabled: false, label: null };
        if (availability.disabled) {
          return (
            <MenuItem key={option.value} disabled>
              <OptionIcon
                aria-hidden="true"
                className={cn(
                  "size-3 shrink-0 opacity-80",
                  providerIconClassName(option.value, "text-muted-foreground/85"),
                )}
              />
              <span>{option.label}</span>
              <span className="ms-auto text-[11px] text-muted-foreground/80">
                {availability.label}
              </span>
            </MenuItem>
          );
        }
        return (
          <MenuSub key={option.value}>
            <MenuSubTrigger>
              <OptionIcon
                aria-hidden="true"
                className={cn(
                  "size-3 shrink-0",
                  providerIconClassName(option.value, "text-muted-foreground/85"),
                )}
              />
              {option.label}
            </MenuSubTrigger>
            <ComposerPickerMenuSubPopup
              fixedWidth
              className={COMPOSER_PICKER_MODEL_SUBMENU_HEIGHT_CLASS_NAME}
            >
              {renderModelRadioGroup(option.value)}
            </ComposerPickerMenuSubPopup>
          </MenuSub>
        );
      })}
      {visibleAvailableProviderOptions.length > 0 ? <MenuSeparator /> : null}
      <MenuItem onClick={() => appHistory.push("/settings?section=providers")}>
        <PlusIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground/85" />
        <span>Add Providers</span>
      </MenuItem>
    </>
  );
};

// Resolves the human-readable label for the currently selected model.
export function resolveProviderModelLabel(input: {
  provider: ProviderKind;
  lockedProvider: ProviderKind | null;
  model: ModelSlug;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelOption>>;
}): string {
  const activeProvider = input.lockedProvider ?? input.provider;
  return resolveSelectedModelLabel({
    provider: activeProvider,
    model: input.model,
    options: input.modelOptionsByProvider[activeProvider],
  });
}

export function getProviderIconClassName(
  provider: ProviderKind | ProviderPickerKind,
  fallbackClassName: string = "text-muted-foreground/70",
): string {
  return providerIconClassName(provider, fallbackClassName);
}

type ProviderModelPickerProps = {
  provider: ProviderKind;
  model: ModelSlug;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProviderStatus>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<ProviderModelOption>>;
  modelDiscoveryByProvider?: Record<ProviderKind, ProviderModelDiscoveryState>;
  hiddenProviders?: ReadonlyArray<ProviderKind>;
  providerOrder?: ReadonlyArray<ProviderKind>;
  activeProviderIconClassName?: string;
  compact?: boolean;
  // Icon-only trigger for narrow composers; the model name moves to title/sr-only.
  hideLabel?: boolean;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSelectionCommitted?: () => void;
  shortcutLabel?: string | null;
  onProviderModelChange: (provider: ProviderKind, model: ModelSlug) => void;
};

export const ProviderModelPicker = function ProviderModelPicker(props: ProviderModelPickerProps) {
  const { onOpenChange, onSelectionCommitted, open } = props;
  const [uncontrolledMenuOpen, setUncontrolledMenuOpen] = useState(false);
  const selectionCommitTimerRef = useRef<number | null>(null);
  const isMenuOpen = open ?? uncontrolledMenuOpen;
  const activeProvider = props.lockedProvider ?? props.provider;
  const selectedModelLabel = resolveProviderModelLabel({
    provider: props.provider,
    lockedProvider: props.lockedProvider,
    model: props.model,
    modelOptionsByProvider: props.modelOptionsByProvider,
  });
  const ProviderIcon = PROVIDER_ICON_COMPONENT_BY_PROVIDER[activeProvider];

  const setMenuOpen = (nextOpen: boolean) => {
    if (open === undefined) {
      setUncontrolledMenuOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  };
  const scheduleSelectionCommitted = () => {
    if (selectionCommitTimerRef.current !== null) {
      window.clearTimeout(selectionCommitTimerRef.current);
    }
    // Base UI restores focus to the trigger while closing; refocus callers after that tick.
    selectionCommitTimerRef.current = window.setTimeout(() => {
      selectionCommitTimerRef.current = null;
      onSelectionCommitted?.();
    }, 0);
  };
  useEffect(
    () => () => {
      if (selectionCommitTimerRef.current !== null) {
        window.clearTimeout(selectionCommitTimerRef.current);
      }
    },
    [],
  );

  const handleAfterSelection = () => {
    setMenuOpen(false);
    scheduleSelectionCommitted();
  };

  const triggerButton = (
    <PickerTriggerButton
      disabled={props.disabled ?? false}
      compact={props.compact ?? false}
      hideLabel={props.hideLabel ?? false}
      className="text-[var(--color-text-foreground)]"
      icon={
        <ProviderIcon
          aria-hidden="true"
          className={cn(
            // opacity-100 opts out of the Button base's [&_svg]:opacity-80 dimming.
            "size-3.5 shrink-0 opacity-100",
            providerIconClassName(activeProvider, "text-muted-foreground/70"),
            props.activeProviderIconClassName,
          )}
        />
      }
      label={selectedModelLabel}
    />
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
            <span className="sr-only">{selectedModelLabel}</span>
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
        <MenuTrigger render={triggerButton}>
          <span className="sr-only">{selectedModelLabel}</span>
        </MenuTrigger>
      )}
      <ComposerPickerMenuPopup align="start" fixedWidth>
        <ProviderModelMenuItems
          provider={props.provider}
          model={props.model}
          lockedProvider={props.lockedProvider}
          {...(props.providers ? { providers: props.providers } : {})}
          modelOptionsByProvider={props.modelOptionsByProvider}
          {...(props.modelDiscoveryByProvider
            ? { modelDiscoveryByProvider: props.modelDiscoveryByProvider }
            : {})}
          {...(props.hiddenProviders ? { hiddenProviders: props.hiddenProviders } : {})}
          {...(props.providerOrder ? { providerOrder: props.providerOrder } : {})}
          {...(props.disabled !== undefined ? { disabled: props.disabled } : {})}
          onProviderModelChange={props.onProviderModelChange}
          onAfterSelection={handleAfterSelection}
        />
      </ComposerPickerMenuPopup>
    </Menu>
  );
};

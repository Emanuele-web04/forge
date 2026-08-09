// FILE: PickerPanelShell.tsx
// Purpose: Share the visual shell used by combobox-style pickers in chat surfaces.
// Layer: Chat picker UI
// Depends on: shared input styling plus caller-provided content slots.

import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "~/lib/utils";
import { Input } from "../ui/input";
import {
  COMPOSER_PICKER_MODEL_LIST_SCROLL_CLASS_NAME,
  COMPOSER_PICKER_RADIUS_CLASS_NAME,
  COMPOSER_PICKER_SEARCH_HEADER_CLASS_NAME,
  COMPOSER_PICKER_SEARCH_INPUT_CLASS_NAME,
} from "./composerPickerStyles";

const MENU_NAVIGATION_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "Home",
  "End",
  "PageDown",
  "PageUp",
  "Enter",
  "Escape",
]);

export function PickerPanelShell(props: {
  searchPlaceholder?: string;
  query?: string;
  onQueryChange?: (query: string) => void;
  searchInput?: ReactNode;
  stopSearchKeyPropagation?: boolean;
  autoFocusSearch?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  widthClassName?: string;
  bleedParentPadding?: boolean;
  listMaxHeightClassName?: string;
}) {
  const {
    searchPlaceholder: searchPlaceholderProp,
    query: queryProp,
    onQueryChange,
    searchInput,
    stopSearchKeyPropagation: stopSearchKeyPropagationProp,
    autoFocusSearch: autoFocusSearchProp,
    children,
    footer,
    widthClassName: widthClassNameProp,
    bleedParentPadding: bleedParentPaddingProp,
    listMaxHeightClassName,
  } = props;
  const searchPlaceholder = searchPlaceholderProp ?? "Search";
  const query = queryProp ?? "";
  const stopSearchKeyPropagation = stopSearchKeyPropagationProp ?? false;
  const autoFocusSearch = autoFocusSearchProp ?? false;
  const widthClassName = widthClassNameProp ?? "w-72";
  const bleedParentPadding = bleedParentPaddingProp ?? false;
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!autoFocusSearch || !onQueryChange) {
      return;
    }

    const frame = requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });

    return () => cancelAnimationFrame(frame);
  }, [autoFocusSearch, onQueryChange]);

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col",
        widthClassName,
        listMaxHeightClassName,
        bleedParentPadding ? cn("-m-1 overflow-clip", COMPOSER_PICKER_RADIUS_CLASS_NAME) : null,
      )}
    >
      {onQueryChange || searchInput ? (
        <div
          className={cn(
            bleedParentPadding
              ? cn(COMPOSER_PICKER_SEARCH_HEADER_CLASS_NAME, "-top-1 pt-2")
              : "sticky top-0 z-20 shrink-0 border-b border-border bg-[var(--composer-surface)] p-1",
          )}
        >
          {searchInput ?? (
            <Input
              className={cn(
                "rounded-md border-border/60 shadow-none before:hidden has-focus-visible:border-neutral-500/15 has-focus-visible:ring-0 [&_input]:font-sans",
                bleedParentPadding ? COMPOSER_PICKER_SEARCH_INPUT_CLASS_NAME : "bg-background",
              )}
              nativeInput
              ref={searchInputRef}
              size="sm"
              type="search"
              placeholder={searchPlaceholder}
              value={query}
              onChange={(event) => onQueryChange?.(event.target.value)}
              onKeyDownCapture={
                stopSearchKeyPropagation
                  ? (event) => {
                      if (!MENU_NAVIGATION_KEYS.has(event.key)) {
                        event.stopPropagation();
                      }
                    }
                  : undefined
              }
            />
          )}
        </div>
      ) : null}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto overscroll-contain py-0.5",
          bleedParentPadding ? COMPOSER_PICKER_MODEL_LIST_SCROLL_CLASS_NAME : null,
        )}
      >
        {children}
      </div>
      {footer ? <div className="border-t p-1">{footer}</div> : null}
    </div>
  );
}

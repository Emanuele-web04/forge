// FILE: BrowserTabStrip.tsx
// Purpose: Horizontal tab strip for the in-app browser panel (tab pills, new-tab button,
// chrome status chip). Owns only presentation + keeping the active tab scrolled into view.
// Layer: Web UI component
// Depends on: BrowserPanel.logic chrome styles/status, contracts BrowserTabState

import { useLayoutEffect, useRef } from "react";
import type { BrowserTabState } from "@synara/contracts";
import { isBlankBrowserTabUrl } from "@synara/shared/browserSession";

import { GlobeIcon, PlusIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import {
  BROWSER_CHROME_CONTROL_CLASS_NAME,
  BROWSER_CHROME_CONTROL_FILLED_CLASS_NAME,
  type BrowserChromeStatus,
} from "./BrowserPanel.logic";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export interface BrowserTabStripProps {
  tabs: readonly BrowserTabState[];
  activeTabId: string | null;
  status: BrowserChromeStatus | null;
  // Extend the frameless window drag region across the strip's empty space so the panel
  // is easy to grab; interactive children stay no-drag via global CSS (`.drag-region button`).
  dragRegion: boolean;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCreateTab: () => void;
}

function closeButtonClassName(isActive: boolean) {
  return cn(
    "ml-1 size-5 shrink-0 rounded-sm p-0 text-muted-foreground/70 hover:bg-background/80 hover:text-foreground",
    isActive ? "hover:bg-background" : "hover:bg-card",
  );
}

// Scroll only the strip itself (not `scrollIntoView`, which would also scroll every
// scrollable ancestor such as the dock or chat column when the pane mounts offscreen).
function scrollTabIntoView(strip: HTMLElement, tab: HTMLElement): void {
  const stripRect = strip.getBoundingClientRect();
  const tabRect = tab.getBoundingClientRect();
  const left = tabRect.left - stripRect.left + strip.scrollLeft;
  const right = left + tabRect.width;
  if (left < strip.scrollLeft) {
    strip.scrollLeft = left;
  } else if (right > strip.scrollLeft + strip.clientWidth) {
    strip.scrollLeft = right - strip.clientWidth;
  }
}

export function BrowserTabStrip(props: BrowserTabStripProps) {
  const { activeTabId, onCloseTab, onCreateTab, onSelectTab } = props;
  const stripRef = useRef<HTMLDivElement>(null);

  // A tab created/selected past the visible edge ("New tab" appends at the end) must come
  // into view or the action looks like it did nothing.
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip || activeTabId === null) {
      return;
    }
    const activeTabElement = strip.querySelector<HTMLElement>('[data-browser-tab-active="true"]');
    if (activeTabElement) {
      scrollTabIntoView(strip, activeTabElement);
    }
  }, [activeTabId]);

  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b border-border px-2 py-1.5",
        props.dragRegion && "drag-region",
      )}
    >
      <div ref={stripRef} className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {props.tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const tabIsBlank = isBlankBrowserTabUrl(tab);
          return (
            <div
              key={tab.id}
              data-browser-tab-active={isActive ? "true" : undefined}
              className={cn(
                "group flex min-w-0 max-w-[14rem] items-center px-2.5 text-left transition-colors",
                BROWSER_CHROME_CONTROL_CLASS_NAME,
                isActive
                  ? cn(BROWSER_CHROME_CONTROL_FILLED_CLASS_NAME, "text-foreground")
                  : "border-transparent text-muted-foreground hover:border-border/60 hover:bg-background/40 hover:text-foreground",
                tab.status === "suspended" && !tabIsBlank ? "opacity-75" : "",
              )}
            >
              <span className="mr-2 flex size-4 shrink-0 items-center justify-center rounded-sm">
                {tab.faviconUrl ? (
                  <img alt="" src={tab.faviconUrl} className="size-3 rounded-[2px]" />
                ) : (
                  <GlobeIcon className="size-3 text-muted-foreground" />
                )}
              </span>
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left"
                onClick={() => onSelectTab(tab.id)}
              >
                {tab.title || "Untitled"}
              </button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={closeButtonClassName(isActive)}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTab(tab.id);
                }}
              >
                <XIcon className="size-3" />
                <span className="sr-only">Close tab</span>
              </Button>
            </div>
          );
        })}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
                aria-label="New tab"
                onClick={onCreateTab}
              />
            }
          >
            <PlusIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup>New tab</TooltipPopup>
        </Tooltip>
      </div>
      {props.status ? (
        <div
          className={cn(
            "max-w-[13rem] shrink-0 truncate rounded-full border px-2.5 py-1 text-[11px] leading-none sm:max-w-[16rem]",
            props.status.tone === "error"
              ? "border-destructive/25 bg-destructive/8 text-destructive"
              : "border-border/60 bg-background/80 text-muted-foreground",
          )}
          title={props.status.label}
        >
          {props.status.label}
        </div>
      ) : null}
    </div>
  );
}

// FILE: PdfViewerToolbar.tsx
// Purpose: Top chrome bar for the in-app PDF viewer. Mirrors the reference UI:
//          file name + "PDF" label on the left, centered page navigation, and
//          zoom controls + the shared "Open in editor" split button on the right.
// Layer: Web PDF viewer chrome
// Exports: PdfViewerToolbar

import { useState } from "react";

import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MinusIcon,
  PlusIcon,
  RefreshCwIcon,
} from "~/lib/icons";
import { formatZoomPercent, PDF_ZOOM_PRESETS, type PdfZoomMode } from "~/lib/pdf/pdfZoom";
import { cn } from "~/lib/utils";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import {
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  ChatHeaderButton,
  ChatHeaderIconButton,
} from "../chat/chatHeaderControls";
import { OpenInPicker } from "../chat/OpenInPicker";
import { Badge } from "../ui/badge";
import { Menu, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "../ui/menu";

interface PdfViewerToolbarProps {
  fileName: string;
  currentPage: number;
  numPages: number;
  onJumpToPage: (pageNumber: number) => void;
  zoomMode: PdfZoomMode;
  scale: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onSetScale: (scale: number) => void;
  onFitWidth: () => void;
  onFitPage: () => void;
  openInTarget: string | null;
  onReload?: (() => void) | undefined;
}

function zoomSelectionValue(mode: PdfZoomMode, scale: number): string {
  if (mode.type === "fit-width") {
    return "fit-width";
  }
  if (mode.type === "fit-page") {
    return "fit-page";
  }
  return String(Math.round(scale * 100));
}

export const PdfViewerToolbar = function PdfViewerToolbar(props: PdfViewerToolbarProps) {
  const selectionValue = zoomSelectionValue(props.zoomMode, props.scale);

  return (
    <div
      className={cn(
        // Match the breadcrumb file-preview header height (h-10) so swapping
        // between a PDF and a text file in the same pane doesn't jump the chrome.
        "flex h-10 shrink-0 items-center gap-2 px-3",
        CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-[12px] font-medium text-foreground" title={props.fileName}>
          {props.fileName}
        </span>
        <Badge variant="outline" size="sm" className="text-muted-foreground/80">
          PDF
        </Badge>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <ChatHeaderIconButton
          label="Previous page"
          tone="plain"
          disabled={props.currentPage <= 1}
          onClick={() => props.onJumpToPage(props.currentPage - 1)}
        >
          <ChevronLeftIcon aria-hidden="true" className="size-4" />
        </ChatHeaderIconButton>
        <PdfPageIndicator
          key={props.currentPage}
          currentPage={props.currentPage}
          numPages={props.numPages}
          onJumpToPage={props.onJumpToPage}
        />
        <ChatHeaderIconButton
          label="Next page"
          tone="plain"
          disabled={props.currentPage >= props.numPages}
          onClick={() => props.onJumpToPage(props.currentPage + 1)}
        >
          <ChevronRightIcon aria-hidden="true" className="size-4" />
        </ChatHeaderIconButton>
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
        <div className="flex items-center gap-0.5">
          <ChatHeaderIconButton label="Zoom out" tone="plain" onClick={props.onZoomOut}>
            <MinusIcon aria-hidden="true" className="size-4" />
          </ChatHeaderIconButton>
          <Menu>
            <MenuTrigger
              render={
                <ChatHeaderButton tone="plain" className="min-w-16 justify-center gap-1 px-2" />
              }
            >
              <span className="tabular-nums">{formatZoomPercent(props.scale)}</span>
              <ChevronDownIcon aria-hidden="true" className="size-3.5 opacity-70" />
            </MenuTrigger>
            <ComposerPickerMenuPopup align="end" side="bottom" className="w-40 min-w-40">
              <MenuRadioGroup
                value={selectionValue}
                onValueChange={(value) => {
                  if (value === "fit-width") {
                    props.onFitWidth();
                  } else if (value === "fit-page") {
                    props.onFitPage();
                  } else {
                    const percent = Number(value);
                    if (Number.isFinite(percent)) {
                      props.onSetScale(percent / 100);
                    }
                  }
                }}
              >
                <MenuRadioItem value="fit-width">Fit width</MenuRadioItem>
                <MenuRadioItem value="fit-page">Fit page</MenuRadioItem>
                <MenuSeparator className="mx-1" />
                {PDF_ZOOM_PRESETS.map((preset) => {
                  const percent = String(Math.round(preset * 100));
                  return (
                    <MenuRadioItem key={percent} value={percent}>
                      {percent}%
                    </MenuRadioItem>
                  );
                })}
              </MenuRadioGroup>
            </ComposerPickerMenuPopup>
          </Menu>
          <ChatHeaderIconButton label="Zoom in" tone="plain" onClick={props.onZoomIn}>
            <PlusIcon aria-hidden="true" className="size-4" />
          </ChatHeaderIconButton>
        </div>

        {props.onReload ? (
          <ChatHeaderIconButton label="Reload file from disk" tone="plain" onClick={props.onReload}>
            <RefreshCwIcon aria-hidden="true" className="size-3.5" />
          </ChatHeaderIconButton>
        ) : null}
        <OpenInPicker
          openInTarget={props.openInTarget}
          labelMode="always"
          defaultEditor="system-default"
        />
      </div>
    </div>
  );
};

function PdfPageIndicator({
  currentPage,
  numPages,
  onJumpToPage,
}: {
  currentPage: number;
  numPages: number;
  onJumpToPage: (pageNumber: number) => void;
}) {
  // The caller keys this editor by currentPage, so every navigation gets a new
  // draft even when the page sequence returns A -> B -> A.
  const [draft, setDraft] = useState(String(currentPage));

  const commit = () => {
    const parsed = Number.parseInt(draft, 10);
    if (Number.isFinite(parsed)) {
      const clamped = Math.min(Math.max(parsed, 1), Math.max(numPages, 1));
      onJumpToPage(clamped);
      // Canonicalize in place for jumps that clamp to the current page: the
      // keyed remount only resets the draft when the page actually changes.
      setDraft(String(clamped));
    } else {
      setDraft(String(currentPage));
    }
  };

  return (
    <span className="flex items-center gap-1 text-[11px] tabular-nums text-muted-foreground">
      <input
        value={draft}
        inputMode="numeric"
        aria-label="Current page"
        className="h-6 w-8 rounded-sm border border-border/60 bg-transparent text-center text-[11px] text-foreground tabular-nums outline-none focus-visible:border-[color:var(--color-border-focus)]"
        onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, ""))}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
      />
      <span className="opacity-70">/ {numPages}</span>
    </span>
  );
}

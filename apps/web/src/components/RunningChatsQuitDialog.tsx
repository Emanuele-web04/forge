// FILE: RunningChatsQuitDialog.tsx
// Purpose: Confirms desktop quit while chats are still running.
// Layer: Root web overlay
// Depends on: Base UI alert-dialog primitives, the ⌘P palette surface, the shared running spinner,
// and the persisted "resume chats after quit" app setting.

import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import { useId } from "react";

import { useAppSettings } from "~/appSettings";
import { APP_DISPLAY_NAME } from "~/branding";
import { ThreadRunningSpinner } from "~/components/ThreadRunningSpinner";
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogPortal,
  AlertDialogViewport,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { commandDialogPopupClassName } from "~/components/ui/command";
import {
  runningChatsQuitCopy,
  type RunningChatQuitSummary,
  type RunningChatsQuitCopy,
} from "~/lib/runningChatsQuitConfirmation";
import { cn } from "~/lib/utils";

export interface RunningChatsQuitDecision {
  /** Remember the listed chats and continue them automatically on the next launch. */
  readonly resume: boolean;
}

export interface RunningChatsQuitDialogProps {
  readonly chats: ReadonlyArray<RunningChatQuitSummary> | null;
  /** Quit was confirmed and is being finalized; the dialog stays visible but inert. */
  readonly quitting?: boolean;
  readonly onStay: () => void;
  readonly onQuit: (decision: RunningChatsQuitDecision) => void;
}

const uiFont = "font-[family-name:var(--font-ui-family)]";

// Same surface as the ⌘P palette: the body sits on the palette's list background and the footer
// shows the popup's lighter overlay through, separated by a hairline — mirroring CommandPanel +
// CommandFooter without the palette's scroll chrome.
const BODY_CLASS =
  "relative rounded-t-[calc(var(--radius-2xl)-1px)] border-b border-[color:var(--color-border-light)] bg-[var(--color-background-surface-under)] px-4 pt-3 pb-3.5";
const FOOTER_CLASS = "relative flex items-center gap-2 px-3 py-2";
const KEY_HINT_CLASS = "text-[11px] font-normal tabular-nums opacity-55";

export function RunningChatsQuitDialog({
  chats,
  quitting = false,
  onStay,
  onQuit,
}: RunningChatsQuitDialogProps) {
  const copy = chats && chats.length > 0 ? runningChatsQuitCopy(chats, APP_DISPLAY_NAME) : null;

  return (
    <AlertDialog
      open={copy != null}
      onOpenChange={(open) => {
        if (!open) onStay();
      }}
    >
      <AlertDialogPortal>
        <AlertDialogBackdrop />
        <AlertDialogViewport>
          <AlertDialogPrimitive.Popup
            className={cn(
              commandDialogPopupClassName,
              uiFont,
              // Keep the palette's hairline border but drop its inner top highlight/shadow.
              "w-[520px] max-w-[calc(100vw-2rem)] max-h-full text-[12px] before:shadow-none dark:before:shadow-none",
            )}
          >
            {copy && chats ? (
              <RunningChatsQuitDialogContent
                chats={chats}
                copy={copy}
                quitting={quitting}
                onQuit={onQuit}
              />
            ) : null}
          </AlertDialogPrimitive.Popup>
        </AlertDialogViewport>
      </AlertDialogPortal>
    </AlertDialog>
  );
}

// Mounted only while the dialog is open so the settings subscription costs nothing otherwise.
function RunningChatsQuitDialogContent({
  chats,
  copy,
  quitting,
  onQuit,
}: {
  readonly chats: ReadonlyArray<RunningChatQuitSummary>;
  readonly copy: RunningChatsQuitCopy;
  readonly quitting: boolean;
  readonly onQuit: (decision: RunningChatsQuitDecision) => void;
}) {
  const { settings, updateSettings } = useAppSettings();
  const resume = settings.resumeChatsAfterQuit;
  const resumeCheckboxId = useId();

  return (
    <>
      <div className={BODY_CLASS}>
        <AlertDialogPrimitive.Title className={cn(uiFont, "m-0 text-[14px] font-medium leading-5")}>
          {copy.title}
        </AlertDialogPrimitive.Title>
        <AlertDialogPrimitive.Description
          className={cn(
            uiFont,
            "m-0 mt-1 text-[12.5px] font-normal leading-[18px] text-muted-foreground",
          )}
        >
          {copy.description}
        </AlertDialogPrimitive.Description>
        <ul className="m-0 mt-3 flex max-h-[40vh] list-none flex-col gap-2 overflow-y-auto p-0">
          {chats.map((chat) => (
            <li key={chat.id} className="flex min-w-0 items-center gap-2.5">
              <ThreadRunningSpinner />
              <span className={cn(uiFont, "truncate text-[12.5px] font-normal leading-[18px]")}>
                {chat.title}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className={FOOTER_CLASS}>
        <label
          htmlFor={resumeCheckboxId}
          className={cn(
            uiFont,
            "flex min-w-0 cursor-pointer select-none items-center gap-2 px-1 text-[12px] font-normal leading-[18px] text-muted-foreground",
          )}
        >
          <Checkbox
            id={resumeCheckboxId}
            checked={resume}
            disabled={quitting}
            onCheckedChange={(checked) => {
              updateSettings({ resumeChatsAfterQuit: checked === true });
            }}
          />
          <span className="truncate">{copy.resumeLabel}</span>
        </label>
        <div className="ml-auto flex items-center gap-2">
          <AlertDialogClose
            disabled={quitting}
            render={<Button variant="ghost" size="sm" className={cn(uiFont, "gap-1.5")} />}
          >
            {copy.stayLabel}
            <span className={KEY_HINT_CLASS}>Esc</span>
          </AlertDialogClose>
          <Button
            autoFocus
            variant="default"
            size="sm"
            className={cn(uiFont, "gap-1.5")}
            disabled={quitting}
            onClick={() => onQuit({ resume })}
          >
            {copy.quitLabel}
            <span aria-hidden className={KEY_HINT_CLASS}>
              ↵
            </span>
          </Button>
        </div>
      </div>
    </>
  );
}

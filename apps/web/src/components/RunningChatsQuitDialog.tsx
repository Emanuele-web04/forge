// FILE: RunningChatsQuitDialog.tsx
// Purpose: Confirms desktop quit while chats are still running.
// Layer: Root web overlay
// Depends on: Base UI alert-dialog primitives and the shared running spinner.

import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";

import { APP_DISPLAY_NAME } from "~/branding";
import { ThreadRunningSpinner } from "~/components/ThreadRunningSpinner";
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogPortal,
  AlertDialogViewport,
} from "~/components/ui/alert-dialog";
import {
  runningChatsQuitCopy,
  type RunningChatQuitSummary,
} from "~/lib/runningChatsQuitConfirmation";
import { cn } from "~/lib/utils";

export interface RunningChatsQuitDialogProps {
  readonly chats: ReadonlyArray<RunningChatQuitSummary> | null;
  readonly onStay: () => void;
  readonly onQuit: () => void;
}

const uiFont = "font-[family-name:var(--font-ui-family)]";

export function RunningChatsQuitDialog({ chats, onStay, onQuit }: RunningChatsQuitDialogProps) {
  const copy = chats && chats.length > 0 ? runningChatsQuitCopy(chats, APP_DISPLAY_NAME) : null;

  return (
    <AlertDialog
      open={copy != null}
      onOpenChange={(open) => {
        if (!open) onStay();
      }}
    >
      <AlertDialogPortal>
        <AlertDialogBackdrop className="bg-black/50" />
        <AlertDialogViewport>
          <AlertDialogPrimitive.Popup
            className={cn(
              uiFont,
              "row-start-2 w-[400px] max-w-[calc(100vw-2rem)] rounded-[10px] border border-[color:color-mix(in_srgb,var(--color-text-foreground)_10%,transparent)] bg-popover px-4 pt-3.5 pb-3 text-[12px] text-[var(--color-text-foreground)] outline-none dark:bg-[#1e1e1e]",
            )}
          >
            {copy && chats ? (
              <>
                <AlertDialogPrimitive.Title
                  className={cn(uiFont, "m-0 text-[13px] font-semibold leading-[18px]")}
                >
                  {copy.title}
                </AlertDialogPrimitive.Title>
                <AlertDialogPrimitive.Description
                  className={cn(
                    uiFont,
                    "m-0 mt-1 text-[12px] font-normal leading-[16px] text-muted-foreground",
                  )}
                >
                  {copy.description}
                </AlertDialogPrimitive.Description>
                <ul className="m-0 mt-3 flex list-none flex-col gap-2 p-0">
                  {chats.map((chat) => (
                    <li key={chat.id} className="flex min-w-0 items-center gap-2">
                      <ThreadRunningSpinner />
                      <span
                        className={cn(uiFont, "truncate text-[12px] font-normal leading-[16px]")}
                      >
                        {chat.title}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="mt-3.5 flex items-center justify-end gap-1.5">
                  <AlertDialogClose
                    render={
                      <button
                        type="button"
                        className={cn(
                          uiFont,
                          "inline-flex h-[26px] items-center gap-1 rounded-md px-1.5 text-[12px] font-normal text-muted-foreground hover:text-foreground",
                        )}
                      />
                    }
                  >
                    {copy.stayLabel}
                    <span className="text-[11px] text-muted-foreground/45">Esc</span>
                  </AlertDialogClose>
                  <button
                    type="button"
                    autoFocus
                    className={cn(
                      uiFont,
                      "inline-flex h-[26px] items-center gap-1 rounded-md bg-primary px-2.5 text-[12px] font-medium text-primary-foreground",
                    )}
                    onClick={onQuit}
                  >
                    {copy.quitLabel}
                    <span aria-hidden className="text-[11px] font-normal opacity-70">
                      ↵
                    </span>
                  </button>
                </div>
              </>
            ) : null}
          </AlertDialogPrimitive.Popup>
        </AlertDialogViewport>
      </AlertDialogPortal>
    </AlertDialog>
  );
}

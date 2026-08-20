// FILE: RunningChatsQuitDialog.tsx
// Purpose: Confirms desktop quit while chats are still running (Windows/Linux).
// Layer: Root web overlay
// Depends on: Shared alert-dialog chrome and quit-confirmation copy.

import { APP_DISPLAY_NAME } from "~/branding";
import { ThreadRunningSpinner } from "~/components/ThreadRunningSpinner";
import { Button } from "~/components/ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Kbd } from "~/components/ui/kbd";
import {
  runningChatsQuitCopy,
  type RunningChatQuitSummary,
} from "~/lib/runningChatsQuitConfirmation";

export interface RunningChatsQuitDialogProps {
  readonly chats: ReadonlyArray<RunningChatQuitSummary> | null;
  readonly onStay: () => void;
  readonly onQuit: () => void;
}

export function RunningChatsQuitDialog({ chats, onStay, onQuit }: RunningChatsQuitDialogProps) {
  const copy = chats && chats.length > 0 ? runningChatsQuitCopy(chats, APP_DISPLAY_NAME) : null;

  return (
    <AlertDialog
      open={copy != null}
      onOpenChange={(open) => {
        if (!open) onStay();
      }}
    >
      <AlertDialogPopup className="max-w-sm">
        {copy && chats ? (
          <>
            <AlertDialogHeader className="text-left">
              <AlertDialogTitle>{copy.title}</AlertDialogTitle>
              <AlertDialogDescription>{copy.description}</AlertDialogDescription>
            </AlertDialogHeader>
            <ul className="flex max-h-48 min-h-0 flex-col gap-0.5 overflow-y-auto px-4 pb-3">
              {chats.map((chat) => (
                <li key={chat.id} className="flex min-w-0 items-center gap-2.5 py-1">
                  <ThreadRunningSpinner className="text-primary/70" />
                  <span className="truncate font-medium text-sm text-[var(--color-text-foreground)]">
                    {chat.title}
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-end gap-2 border-t border-[color:var(--color-border-light)] px-4 py-3">
              <AlertDialogClose
                render={
                  <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" />
                }
              >
                {copy.stayLabel}
                <Kbd className="h-4 min-w-4">Esc</Kbd>
              </AlertDialogClose>
              <Button autoFocus variant="default" size="sm" className="gap-1.5" onClick={onQuit}>
                {copy.quitLabel}
                <Kbd className="h-4 min-w-4 border-0 bg-primary-foreground/20 text-primary-foreground">
                  ↵
                </Kbd>
              </Button>
            </div>
          </>
        ) : null}
      </AlertDialogPopup>
    </AlertDialog>
  );
}

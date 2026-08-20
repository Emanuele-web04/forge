// FILE: RunningChatsQuitDialog.tsx
// Purpose: Confirms desktop quit while chats are still running.
// Layer: Root web overlay
// Depends on: Shared alert-dialog chrome and quit-confirmation copy.

import { Button } from "~/components/ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";

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
  const copy = chats && chats.length > 0 ? runningChatsQuitCopy(chats) : null;
  const showList = (chats?.length ?? 0) > 1;

  return (
    <AlertDialog
      open={copy != null}
      onOpenChange={(open) => {
        if (!open) onStay();
      }}
    >
      <AlertDialogPopup className="max-w-md">
        {copy ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>{copy.title}</AlertDialogTitle>
              <AlertDialogDescription>{copy.description}</AlertDialogDescription>
            </AlertDialogHeader>
            {showList && chats ? (
              <ul className="flex max-h-48 min-h-0 flex-col gap-1.5 overflow-y-auto px-4 pb-2">
                {chats.map((chat) => (
                  <li
                    key={chat.id}
                    className="truncate text-sm text-[var(--color-text-foreground)]"
                  >
                    {chat.title}
                  </li>
                ))}
              </ul>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" size="sm" />}>
                {copy.stayLabel}
              </AlertDialogClose>
              <Button variant="destructive" size="sm" onClick={onQuit}>
                {copy.quitLabel}
              </Button>
            </AlertDialogFooter>
          </>
        ) : null}
      </AlertDialogPopup>
    </AlertDialog>
  );
}

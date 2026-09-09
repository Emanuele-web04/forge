// FILE: TitleSuggestionBanner.tsx
// Purpose: Preview card for suggested-mode title candidates (#1041) with
//          one-click accept/dismiss. Rendered above the composer.
// Layer: Chat UI (slot owns native-API dispatch; banner stays dumb)

import type { ThreadId } from "@synara/contracts";

import { acceptThreadTitleSuggestion, dismissThreadTitleSuggestion } from "../lib/threadTitleRefresh";
import { cn } from "~/lib/utils";
import { toastManager } from "./ui/toast";
import { COMPOSER_INPUT_SURFACE_CLASS_NAME } from "./chat/composerPickerStyles";

export function TitleSuggestionBanner({
  candidate,
  onAccept,
  onDismiss,
}: {
  candidate: string;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className={cn(COMPOSER_INPUT_SURFACE_CLASS_NAME, "flex w-full min-w-0 items-center gap-3 px-4 py-3")}
      data-testid="title-suggestion-banner"
      role="status"
    >
      <div className="min-w-0 flex-1">
        <p className="text-[length:var(--app-font-size-ui,12px)] leading-5 font-medium text-foreground/95">
          Suggested title
        </p>
        <p
          className="mt-0.5 truncate text-[length:var(--app-font-size-ui-sm,11px)] leading-5 text-muted-foreground"
          title={candidate}
        >
          {candidate}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          className="rounded-md px-2.5 py-1 text-[length:var(--app-font-size-ui-sm,11px)] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onDismiss}
        >
          Dismiss
        </button>
        <button
          type="button"
          className="rounded-md bg-primary px-2.5 py-1 text-[length:var(--app-font-size-ui-sm,11px)] font-medium text-primary-foreground hover:bg-primary/90"
          onClick={onAccept}
        >
          Use title
        </button>
      </div>
    </div>
  );
}

export function TitleSuggestionSlot({
  threadId,
  candidate,
}: {
  threadId: ThreadId;
  candidate: string;
}) {
  return (
    <TitleSuggestionBanner
      candidate={candidate}
      onAccept={() => {
        void acceptThreadTitleSuggestion({ threadId, title: candidate })
          .then((ok) => {
            if (ok) toastManager.add({ type: "success", title: "Thread renamed" });
          })
          .catch((error) => {
            toastManager.add({
              type: "error",
              title: "Could not apply suggestion",
              description: error instanceof Error ? error.message : "Unknown error",
            });
          });
      }}
      onDismiss={() => {
        void dismissThreadTitleSuggestion(threadId).catch(() => {});
      }}
    />
  );
}

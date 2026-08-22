// FILE: ForkSourceDivider.tsx
// Purpose: Link a forked transcript back to the immediate source chat.
// Layer: Chat transcript UI

import { type ThreadId } from "@synara/contracts";
import { memo, type MouseEvent } from "react";

import { GitForkIcon } from "~/lib/icons";

export interface ForkSourceReference {
  readonly sourceThreadId: ThreadId;
  readonly sourceTitle: string;
}

function shouldUseClientNavigation(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export const ForkSourceDivider = memo(function ForkSourceDivider({
  source,
  onOpenSourceThread,
}: {
  readonly source: ForkSourceReference;
  readonly onOpenSourceThread: (threadId: ThreadId) => void;
}) {
  const sourceHref = `/${encodeURIComponent(source.sourceThreadId)}`;

  return (
    <div
      data-fork-source-divider="true"
      className="flex w-full items-center gap-4 py-4 font-system-ui"
    >
      <span aria-hidden className="h-px min-w-0 flex-1 bg-[color:var(--color-border-light)]" />
      <a
        href={sourceHref}
        aria-label={`Open source chat ${source.sourceTitle}`}
        title={source.sourceTitle}
        className="inline-flex min-w-0 shrink items-center gap-2 rounded-sm text-[length:var(--app-font-size-ui,12px)] font-normal text-[var(--color-text-accent)] transition-opacity duration-150 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-border-focus)]/60"
        onClick={(event) => {
          if (!shouldUseClientNavigation(event)) {
            return;
          }
          event.preventDefault();
          onOpenSourceThread(source.sourceThreadId);
        }}
      >
        <GitForkIcon className="size-4 shrink-0 text-muted-foreground/70" aria-hidden />
        <span className="truncate">Continued from chat</span>
      </a>
      <span aria-hidden className="h-px min-w-0 flex-1 bg-[color:var(--color-border-light)]" />
    </div>
  );
});

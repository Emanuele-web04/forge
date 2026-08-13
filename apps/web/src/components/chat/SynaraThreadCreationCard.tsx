// FILE: SynaraThreadCreationCard.tsx
// Purpose: End-of-turn recap for threads created through the Synara MCP harness.
// Layer: Chat transcript UI

import { PROVIDER_DISPLAY_NAMES } from "@synara/contracts";
import { formatModelDisplayName } from "@synara/shared/model";
import { memo } from "react";

import type { WorkLogSynaraThreadCreation } from "../../session-logic";
import { ProviderIcon } from "../ProviderIcon";
import { SynaraLogo } from "../SynaraLogo";
import { Button } from "../ui/button";

function threadMeta(thread: WorkLogSynaraThreadCreation["threads"][number]): string {
  const model = formatModelDisplayName(thread.model) ?? thread.model;
  const environment = thread.environment === "worktree" ? "Worktree" : "Local";
  return `${PROVIDER_DISPLAY_NAMES[thread.provider]} · ${model} · ${environment}`;
}

export const SynaraThreadCreationCard = memo(function SynaraThreadCreationCard({
  creation,
  onOpenThread,
}: {
  readonly creation: WorkLogSynaraThreadCreation;
  readonly onOpenThread?: (threadId: string) => void;
}) {
  const singleThread = creation.threads.length === 1 ? creation.threads[0] : undefined;
  const title = singleThread ? "Thread created" : `${creation.createdCount} threads created`;
  const summary = singleThread
    ? singleThread.title
    : `${creation.createdCount}/${creation.requestedCount} requested threads created`;

  return (
    <div
      className="overflow-hidden rounded-[0.65rem] border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-primary)] dark:border-[color:color-mix(in_srgb,var(--color-border-light)_55%,transparent)]"
      data-synara-thread-creation-card="true"
    >
      <div className="flex min-w-0 items-center gap-3 px-3 py-2.5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-background-elevated-secondary)] text-foreground">
          <SynaraLogo className="h-[22px] w-auto" aria-label="Synara" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-system-ui text-[length:var(--app-font-size-ui-lg,13px)] font-medium text-foreground/95">
            {title}
          </p>
          <p className="truncate font-system-ui text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/65">
            {summary}
          </p>
          {singleThread ? (
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/52">
              <ProviderIcon provider={singleThread.provider} className="size-3 shrink-0" />
              <span className="truncate">{threadMeta(singleThread)}</span>
            </div>
          ) : null}
        </div>
        {singleThread && onOpenThread ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => onOpenThread(singleThread.threadId)}
          >
            Open thread
          </Button>
        ) : null}
      </div>

      {!singleThread ? (
        <div className="border-t border-[color:var(--color-border-light)]">
          {creation.threads.map((thread) => (
            <div
              key={thread.threadId}
              className="flex min-w-0 items-center gap-2.5 border-t border-[color:var(--color-border-light)] px-3 py-2 first:border-t-0"
            >
              <ProviderIcon provider={thread.provider} className="size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-system-ui text-[length:var(--app-font-size-ui,12px)] font-medium text-foreground/90">
                  {thread.title}
                </p>
                <p className="truncate font-system-ui text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/52">
                  {threadMeta(thread)}
                </p>
              </div>
              {onOpenThread ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="shrink-0"
                  onClick={() => onOpenThread(thread.threadId)}
                >
                  Open
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
});

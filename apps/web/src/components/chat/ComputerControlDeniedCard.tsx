// FILE: ComputerControlDeniedCard.tsx
// Purpose: Transcript card shown when an agent's desktop tool call was rejected because
//          the chat has computer control switched off. Replaces the buried tool error
//          with a one-click way to switch control on and retry.
// Layer: Chat transcript UI

import { Button } from "~/components/ui/button";
import { MonitorIcon } from "~/lib/icons";

export function ComputerControlDeniedCard({
  toolName,
  computerControlEnabled,
  textFontSizePx,
  metaFontSizePx,
  onEnable,
}: {
  readonly toolName: string | null;
  // Live composer state: once the user (or this card) switches control on, the
  // card flips to a confirmation instead of offering a dead button.
  readonly computerControlEnabled?: boolean;
  readonly textFontSizePx?: number;
  readonly metaFontSizePx?: number;
  readonly onEnable?: () => void;
}) {
  const enabled = computerControlEnabled === true;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-primary)] px-3 py-2.5">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-secondary)] text-amber-500">
        <MonitorIcon className="size-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p
          className="truncate font-medium text-[var(--color-text-foreground)]"
          style={textFontSizePx ? { fontSize: `${textFontSizePx}px` } : undefined}
        >
          {enabled
            ? "Computer control is on for this chat"
            : "Computer control is off for this chat"}
        </p>
        <p
          className="text-[var(--color-text-foreground-secondary)]"
          style={metaFontSizePx ? { fontSize: `${metaFontSizePx}px` } : undefined}
        >
          {enabled
            ? "Send a message and the agent will pick up where it left off."
            : `The agent tried to act on the desktop${toolName ? ` (${toolName})` : ""} and was stopped.`}
        </p>
      </div>
      {onEnable && !enabled ? (
        <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={onEnable}>
          Enable
        </Button>
      ) : null}
    </div>
  );
}

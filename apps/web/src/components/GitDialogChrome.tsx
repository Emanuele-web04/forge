// FILE: GitDialogChrome.tsx
// Purpose: The shared shell of every git dialog (Create PR, Commit) — popup sizing and
//          submit chord, the branch heading, the borderless message fields, and the
//          bottom action rows with their "why is this unavailable" tooltip.
// Layer: Git dialog UI primitive

import type { ReactNode } from "react";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { cn } from "~/lib/utils";

/**
 * Popup shell shared by the git dialogs: same width, no close button, and ⌘/Ctrl+↵
 * runs the dialog's primary action.
 */
export function GitDialogShell({
  open,
  onOpenChange,
  onSubmitShortcut,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitShortcut: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        className="max-w-md"
        showCloseButton={false}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onSubmitShortcut();
          }
        }}
      >
        {children}
      </DialogPopup>
    </Dialog>
  );
}

/** Muted context line (branch flow, dialog kind) above the branch the action targets. */
export function GitDialogHeading({
  eyebrow,
  eyebrowTrailing,
  subject,
  subjectMuted,
}: {
  eyebrow: ReactNode;
  eyebrowTrailing?: ReactNode;
  subject: string;
  /** Marks a subject the dialog will derive rather than one that already exists. */
  subjectMuted?: boolean;
}) {
  return (
    <DialogHeader className="gap-0.5">
      <DialogTitle className="flex items-center justify-between gap-2 font-normal font-sans text-muted-foreground text-xs">
        <span className="truncate">{eyebrow}</span>
        {eyebrowTrailing}
      </DialogTitle>
      <DialogDescription
        className={cn(
          "truncate font-medium text-sm",
          subjectMuted ? "text-muted-foreground italic" : "text-[var(--color-text-foreground)]",
        )}
      >
        {subject}
      </DialogDescription>
    </DialogHeader>
  );
}

/** Body between the heading and the action rows. */
export function GitDialogBody({ children }: { children: ReactNode }) {
  return <DialogPanel className="space-y-1 pt-2">{children}</DialogPanel>;
}

/** Borderless authoring field (PR title/description, commit message). */
export const GIT_DIALOG_FIELD_CLASS =
  "w-full bg-transparent py-1 font-system-ui text-sm outline-none placeholder:text-muted-foreground/70";

/** Hairline-separated action strip pinned to the bottom of a git dialog. */
export function GitDialogActionList({ children }: { children: ReactNode }) {
  return <div className="border-[color:var(--color-border)] border-t p-2">{children}</div>;
}

export function GitDialogActionRow({
  highlighted,
  disabled,
  disabledReason,
  onClick,
  icon,
  label,
  trailing,
}: {
  highlighted?: boolean;
  disabled?: boolean;
  /** Shown as a hover tooltip while the row is disabled. */
  disabledReason?: string | null;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  trailing?: ReactNode;
}) {
  const row = (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm outline-none transition-colors",
        "hover:bg-[var(--color-background-button-secondary-hover)] focus-visible:bg-[var(--color-background-button-secondary-hover)]",
        highlighted && "bg-[var(--color-background-button-secondary-hover)]",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      <span className="shrink-0 text-muted-foreground [&_svg]:size-4">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {trailing}
    </button>
  );

  if (!disabled || !disabledReason) {
    return row;
  }

  // The disabled button drops pointer events, so the trigger span owns the hover.
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        nativeButton={false}
        render={<span className="block cursor-not-allowed" />}
      >
        {row}
      </PopoverTrigger>
      <PopoverPopup tooltipStyle side="top" align="center">
        {disabledReason}
      </PopoverPopup>
    </Popover>
  );
}

// FILE: automationInlineFields.tsx
// Purpose: Row and inline-control primitives for the automation detail page.
// Layer: Web components (automation)
// Exports: DetailGroup/DetailRow/StatusValue/EditRow layout rows plus the inline
// commit-on-change controls (select, toggle, time, commit-on-blur text input).

import type { AutomationMode, AutomationWorktreeMode } from "@synara/contracts";

import { CentralIcon } from "~/lib/central-icons";
import { useCommitDraft, useCommitDraftBlurHandlers } from "~/lib/automationInlineDraft";
import { cn } from "~/lib/utils";

export type SelectOption = {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean | undefined;
  readonly title?: string | undefined;
};

export const MODE_LABELS: Record<AutomationMode, string> = {
  standalone: "Standalone",
  heartbeat: "Heartbeat",
  dedicated: "Dedicated thread",
};

export const WORKTREE_OPTIONS: readonly SelectOption[] = [
  { value: "auto", label: "Auto" },
  { value: "local", label: "Local" },
  { value: "worktree", label: "Worktree" },
];

export function worktreeModeLabel(mode: AutomationWorktreeMode): string {
  return WORKTREE_OPTIONS.find((option) => option.value === mode)?.label ?? mode;
}

export function DetailGroup({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="space-y-0.5">
      <h2 className="px-1.5 pb-1 text-xs font-medium text-muted-foreground/70">{title}</h2>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

export function DetailRow({
  label,
  children,
}: {
  readonly label: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md px-1.5 py-1.5 text-xs">
      <span className="flex shrink-0 items-center gap-1 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-foreground">{children}</span>
    </div>
  );
}

// Read-only Status group values (Active/Next run/Last ran). The reference renders these as
// plain right-aligned text — the status as foreground, timestamps muted — with no chip behind
// them, so the value column stays quiet and flush to the right.
export function StatusValue({
  tone: toneProp,
  children,
}: {
  readonly tone?: "default" | "muted";
  readonly children: React.ReactNode;
}) {
  const tone = toneProp ?? "default";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5",
        tone === "muted" ? "text-muted-foreground" : "text-foreground",
      )}
    >
      {children}
    </span>
  );
}

export function EditRow({
  label,
  children,
}: {
  readonly label: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md py-px pl-1.5 pr-0.5 text-xs transition-colors hover:bg-foreground/[0.04]">
      <span className="flex shrink-0 items-center gap-1 text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

export const INLINE_CONTROL_CLASS =
  "cursor-pointer rounded-md bg-transparent px-2 py-1.5 text-right text-xs text-foreground outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-60";

export function InlineSelect({
  value,
  options,
  onChange,
  disabled,
  title,
}: {
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean | undefined;
  readonly title?: string | undefined;
}) {
  return (
    <div className="relative flex min-w-0 items-center">
      <select
        value={value}
        disabled={disabled}
        title={title}
        onChange={(event) => onChange(event.target.value)}
        className={cn(INLINE_CONTROL_CLASS, "max-w-[11rem] appearance-none truncate pr-5")}
      >
        {options.map((option) => (
          <option
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            title={option.title}
          >
            {option.label}
          </option>
        ))}
      </select>
      <CentralIcon
        name="chevron-down-small"
        className="pointer-events-none absolute right-1 size-3 text-muted-foreground"
      />
    </div>
  );
}

export function InlineToggle({
  value,
  onChange,
  disabled,
  title,
}: {
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
  readonly disabled?: boolean | undefined;
  readonly title?: string | undefined;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={() => onChange(!value)}
      className={cn(INLINE_CONTROL_CLASS, "min-w-[3rem]")}
    >
      {value ? "On" : "Off"}
    </button>
  );
}

export function InlineTime({
  value,
  onChange,
  disabled,
  title,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean | undefined;
  readonly title?: string | undefined;
}) {
  return (
    <input
      type="time"
      value={value}
      disabled={disabled}
      title={title}
      onChange={(event) => onChange(event.target.value)}
      className={INLINE_CONTROL_CLASS}
    />
  );
}

// Keeps free-text schedule fields editable while intermediate cron/timezone text is invalid.
// Enter commits, Escape reverts, and an invalid draft silently reverts on blur instead of
// sending a doomed request.
export function InlineCommitTextInput({
  value,
  onCommit,
  validate,
  normalize,
  flushOnUnmount,
  disabled,
  title,
  className,
  placeholder,
}: {
  readonly value: string;
  readonly onCommit: (value: string) => void;
  readonly validate?: ((value: string) => string | null) | undefined;
  readonly normalize?: ((value: string) => string) | undefined;
  readonly flushOnUnmount?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly title?: string | undefined;
  readonly className?: string;
  readonly placeholder?: string;
}) {
  const draft = useCommitDraft({ value, onCommit, validate, normalize, flushOnUnmount });
  const { onBlur, revertAndBlur } = useCommitDraftBlurHandlers(draft);

  return (
    <input
      value={draft.draft}
      disabled={disabled}
      title={title}
      placeholder={placeholder}
      aria-invalid={draft.error !== null || undefined}
      onChange={(event) => draft.setDraft(event.target.value)}
      onBlur={onBlur}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          revertAndBlur(event.currentTarget);
        }
      }}
      className={cn(INLINE_CONTROL_CLASS, className)}
    />
  );
}

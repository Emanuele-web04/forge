// FILE: ui/src/components/Field.tsx
// Purpose: Form primitives shared by every ceremony page — labelled input,
// submit button, and the notice strip used for errors and status copy.
// Layer: Account UI presentation
// Depends on: React.

import { useId, type ComponentPropsWithoutRef, type ReactNode } from "react";

export function Field({
  label,
  hint,
  ...input
}: { label: string; hint?: ReactNode } & ComponentPropsWithoutRef<"input">): ReactNode {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-[12.5px] font-medium text-ink-muted">
        {label}
      </label>
      <input
        id={id}
        className="block w-full rounded-lg border border-line bg-canvas/60 px-3 py-2.5 text-[14px] text-ink transition-colors duration-150 outline-none placeholder:text-ink-faint hover:border-line/80 focus:border-accent motion-reduce:transition-none"
        {...input}
      />
      {hint ? <p className="text-[12px] text-ink-faint">{hint}</p> : null}
    </div>
  );
}

export function SubmitButton({
  pending,
  children,
  ...button
}: { pending?: boolean } & ComponentPropsWithoutRef<"button">): ReactNode {
  return (
    <button
      type="submit"
      disabled={pending || button.disabled}
      className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2.5 text-[14px] font-medium text-accent-ink transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-55 motion-reduce:transition-none motion-reduce:active:scale-100"
      {...button}
    >
      {pending ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function Spinner(): ReactNode {
  return (
    <span
      aria-hidden
      className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
    />
  );
}

export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "error" | "success";
  children: ReactNode;
}): ReactNode {
  const toneClass =
    tone === "error"
      ? "border-danger/35 bg-danger/10 text-danger"
      : tone === "success"
        ? "border-success/30 bg-success/10 text-success"
        : "border-line bg-canvas/50 text-ink-muted";
  return (
    <p
      role={tone === "error" ? "alert" : undefined}
      className={`rounded-lg border px-3 py-2.5 text-[13px] leading-relaxed ${toneClass}`}
    >
      {children}
    </p>
  );
}

export function Divider({ label }: { label: string }): ReactNode {
  return (
    <div className="flex items-center gap-3">
      <span className="h-px flex-1 bg-line" />
      <span className="text-[11px] tracking-[0.12em] text-ink-faint uppercase">{label}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

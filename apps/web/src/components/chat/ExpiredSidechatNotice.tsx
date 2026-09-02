import { Button } from "~/components/ui/button";

export function ExpiredSidechatNotice({ onStartNew }: { readonly onStartNew: () => void }) {
  return (
    <div
      className="mb-2 flex items-center justify-between gap-3 rounded-xl border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-primary-opaque)] px-3 py-2 text-[length:var(--app-font-size-ui,12px)]"
      role="status"
    >
      <span className="min-w-0 text-[var(--color-text-foreground-secondary)]">
        This side chat expired after 1 hour of inactivity. Start a new side chat.
      </span>
      <Button type="button" variant="outline" size="sm" onClick={onStartNew}>
        Start new
      </Button>
    </div>
  );
}

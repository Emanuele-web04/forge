import { PageShell } from "../components/chrome";

export default function NotFound() {
  return (
    <PageShell>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 py-24 text-center">
        <h1 className="text-xl font-semibold tracking-tight">No public profile here</h1>
        {/* One page for "unknown handle" and "private profile", matching the
            API's deliberate 404 ambiguity. */}
        <p className="text-sm text-muted-foreground">
          This handle doesn&apos;t exist, or its owner keeps their profile private.
        </p>
        <a
          href="https://trysynara.com"
          className="mt-4 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          trysynara.com
        </a>
      </div>
    </PageShell>
  );
}

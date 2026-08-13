// FILE: components/docs/pagination.tsx
// Purpose: Previous/Next footer for docs pages as compact shadcn outline
//          buttons (shadcn.com-docs style) — replaces fumadocs' default
//          footer cards, which read as large empty surfaces.
// Layer: server component (no client hooks).

import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";

type PageLink = { name: ReactNode; url: string } | undefined;

export function DocsPagination({ previous, next }: { previous: PageLink; next: PageLink }) {
  if (!previous && !next) return null;

  return (
    <nav className="not-prose flex items-center justify-between gap-3" aria-label="Docs pages">
      {previous ? (
        <Link
          href={previous.url}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5 ps-2")}
        >
          <ChevronLeft className="size-3.5 text-muted-foreground" />
          {previous.name}
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link
          href={next.url}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "gap-1.5 pe-2")}
        >
          {next.name}
          <ChevronRight className="size-3.5 text-muted-foreground" />
        </Link>
      ) : null}
    </nav>
  );
}

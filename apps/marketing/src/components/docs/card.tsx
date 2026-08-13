// FILE: components/docs/card.tsx
// Purpose: MDX <Cards>/<Card> for docs pages, built on the shadcn Card
//          primitives so docs surfaces match the rest of the design system.
// Layer: server component (no client hooks).

import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card as UICard, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function Cards({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("not-prose my-5 grid gap-3 sm:grid-cols-2", className)}>{children}</div>
  );
}

type DocsCardProps = {
  title: ReactNode;
  description?: ReactNode;
  href?: string;
  icon?: ReactNode;
  className?: string;
  children?: ReactNode;
};

export function Card({ title, description, href, icon, className, children }: DocsCardProps) {
  const card = (
    <UICard
      size="sm"
      className={cn(
        "h-full gap-1 ring-border",
        href &&
          "transition-[background-color,box-shadow] group-hover/doccard:bg-accent group-hover/doccard:ring-ring",
        className,
      )}
    >
      <CardHeader className="gap-1">
        <CardTitle className="flex items-center gap-2 text-[13.5px]">
          {icon ? <span className="text-muted-foreground [&_svg]:size-4">{icon}</span> : null}
          {title}
          {href ? (
            <ArrowUpRight className="ms-auto size-3.5 shrink-0 text-muted-foreground transition-transform group-hover/doccard:-translate-y-px group-hover/doccard:translate-x-px" />
          ) : null}
        </CardTitle>
        {description ? (
          <CardDescription className="text-[13px] leading-relaxed">{description}</CardDescription>
        ) : null}
        {children ? (
          <div className="text-[13px] leading-relaxed text-muted-foreground">{children}</div>
        ) : null}
      </CardHeader>
    </UICard>
  );

  if (!href) return card;

  return (
    <Link href={href} className="group/doccard block no-underline">
      {card}
    </Link>
  );
}

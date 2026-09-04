// FILE: components/docs/callout.tsx
// Purpose: MDX <Callout> for docs pages, built on the shadcn Alert primitive.
//          Monochrome by design — type only changes the icon, not the color.
// Layer: server component (no client hooks).

import type { ReactNode } from "react";
import { Info, Lightbulb, OctagonAlert, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

type CalloutType = "info" | "note" | "tip" | "warn" | "warning" | "error";

const CALLOUT_ICONS: Record<CalloutType, typeof Info> = {
  info: Info,
  note: Info,
  tip: Lightbulb,
  warn: TriangleAlert,
  warning: TriangleAlert,
  error: OctagonAlert,
};

export function Callout({
  type = "info",
  title,
  className,
  children,
}: {
  type?: CalloutType;
  title?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const Icon = CALLOUT_ICONS[type] ?? Info;

  return (
    <Alert className={cn("not-prose my-5 rounded-xl py-2.5", className)}>
      <Icon className="text-muted-foreground" />
      {title ? <AlertTitle className="text-[13.5px]">{title}</AlertTitle> : null}
      <AlertDescription className="text-[13px] leading-relaxed">{children}</AlertDescription>
    </Alert>
  );
}

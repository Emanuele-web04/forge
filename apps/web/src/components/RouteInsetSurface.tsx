// FILE: RouteInsetSurface.tsx
// Purpose: Route-level SidebarInset preset — the straight seam surface for chat-style routes.
// Layer: Shared app component
// Exports: RouteInsetSurface
// Depends on: SidebarInset (ui) and the shared chat surface class constants.

import { type ComponentProps } from "react";

import {
  CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME,
  CHAT_ROUTE_INSET_SHELL_CLASS_NAME,
} from "./chat/composerPickerStyles";
import { SidebarInset } from "./ui/sidebar";

const CARD_SURFACE_ROUTE_INSET_CLASS_NAME = "h-dvh min-h-0 overscroll-y-none text-foreground";

// Default route surfaces keep SidebarInset as the sidebar peer while letting the
// inner seam shadow bleed past the unclipped outer inset.
export function RouteInsetSurface({
  className,
  surfaceClassName,
  ...props
}: ComponentProps<typeof SidebarInset>) {
  if (surfaceClassName === undefined) {
    return (
      <SidebarInset
        className={className ?? CARD_SURFACE_ROUTE_INSET_CLASS_NAME}
        surfaceClassName={CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME}
        {...props}
      />
    );
  }
  return (
    <SidebarInset
      className={className ?? CHAT_ROUTE_INSET_SHELL_CLASS_NAME}
      surfaceClassName={surfaceClassName}
      {...props}
    />
  );
}

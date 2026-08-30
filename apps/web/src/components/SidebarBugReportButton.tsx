// FILE: SidebarBugReportButton.tsx
// Purpose: One-click bug-report button that opens the global feedback dialog
//          with the Bug category preselected.
// Layer: Sidebar UI
// Depends on: SidebarIconButton and the Bug icon.

import { BugIcon } from "~/lib/icons";
import { SidebarIconButton } from "./SidebarIconButton";

export interface SidebarBugReportButtonProps {
  onClick: () => void;
}

export function SidebarBugReportButton({ onClick }: SidebarBugReportButtonProps) {
  return (
    <SidebarIconButton
      icon={BugIcon}
      label="Report a bug"
      tooltip="Report a bug"
      tooltipSide="top"
      onClick={onClick}
    />
  );
}

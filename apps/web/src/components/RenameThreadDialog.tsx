import type { ThreadTitleRefreshMode } from "@synara/contracts";

import { RenameDialog } from "./RenameDialog";
import { TitleRefreshModePicker } from "./TitleRefreshModePicker";

interface RenameThreadDialogProps {
  open: boolean;
  currentTitle: string;
  refreshMode: ThreadTitleRefreshMode | null;
  manualTitlePinned: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (newTitle: string) => Promise<void> | void;
  onRefreshModeChange: (mode: ThreadTitleRefreshMode | null) => void;
  onPinChange: (pinned: boolean) => void;
}

export function RenameThreadDialog({
  open,
  currentTitle,
  refreshMode,
  manualTitlePinned,
  onOpenChange,
  onSave,
  onRefreshModeChange,
  onPinChange,
}: RenameThreadDialogProps) {
  return (
    <RenameDialog
      open={open}
      title="Rename chat"
      description="Keep it short and recognizable."
      initialValue={currentTitle}
      onOpenChange={onOpenChange}
      onSave={onSave}
      belowField={
        <div className="space-y-2.5 border-t border-border/60 pt-3">
          <TitleRefreshModePicker value={refreshMode} onChange={onRefreshModeChange} />
          <label className="flex cursor-pointer items-center gap-2 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              className="size-3.5 accent-primary"
              checked={manualTitlePinned}
              onChange={(event) => onPinChange(event.target.checked)}
            />
            Keep my manual title (block automatic refresh)
          </label>
        </div>
      }
    />
  );
}

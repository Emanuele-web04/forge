// FILE: ReviewChangesButton.tsx
// Purpose: Compact bordered "Review" action pill shared by the changed-files chrome —
// the per-turn "Edited N files" card and the live composer changes header — so the
// open-the-diff affordance stays visually identical across both surfaces.
// Layer: Chat changed-files UI
// Exports: ReviewChangesButton

import type { CSSProperties } from "react";

import { cn } from "~/lib/utils";
import { COMPOSER_INLINE_ACTION_PILL_CLASS_NAME } from "./composerPickerStyles";

interface ReviewChangesButtonProps {
  onClick: () => void;
  className?: string;
  style?: CSSProperties;
  label?: string;
}

export const ReviewChangesButton = function ReviewChangesButton({
  onClick,
  className,
  style,
  label: labelProp,
}: ReviewChangesButtonProps) {
  const label = labelProp ?? "Review";
  return (
    <button
      type="button"
      className={cn(COMPOSER_INLINE_ACTION_PILL_CLASS_NAME, className)}
      style={style}
      onClick={onClick}
    >
      {label}
    </button>
  );
};

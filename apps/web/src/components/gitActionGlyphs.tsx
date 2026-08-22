// FILE: gitActionGlyphs.tsx
// Purpose: Single source of truth mapping every git affordance to its glyph, so the
//          header quick action, the dropdown picker rows, and the git dialogs always
//          render the same icon for the same action.
// Layer: Git UI primitive

import {
  CloudSyncIcon,
  GitBranchIcon,
  GitCommitIcon,
  type LucideIcon,
  PushIcon,
} from "~/lib/icons";
import type { GitGlyphName } from "./GitActionsControl.logic";
import { GitHubIcon } from "./Icons";

// Central icons render as masked spans (not <svg>), so size them explicitly here
// rather than relying on parent `[&>svg]` selectors.
export const GIT_ACTION_ICON_CLASS = "size-3.5";

const GIT_ACTION_GLYPH: Record<GitGlyphName, LucideIcon> = {
  commit: GitCommitIcon,
  push: PushIcon,
  pr: GitHubIcon,
  sync: CloudSyncIcon,
  branch: GitBranchIcon,
};

export function GitActionGlyph({ name, className }: { name: GitGlyphName; className?: string }) {
  const Glyph = GIT_ACTION_GLYPH[name];
  return <Glyph className={className ?? GIT_ACTION_ICON_CLASS} />;
}

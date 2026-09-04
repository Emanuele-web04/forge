// FILE: usePullRequestPaneStateIcon.tsx
// Purpose: Dock-tab glyph for a pull request pane that tracks the PR's live state. Mirrors the
//          detail query cache (never fetches — the detail panel owns fetching) so the chip
//          icon flips to draft/merged/closed the moment the panel's data does. Shared by both
//          dock hosts (chat thread route and /pull-requests route).
// Layer: Pull request presentation
// Exports: usePullRequestPaneStateIcon

import type { PullRequestDetailInput } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { CHAT_SURFACE_CHIP_GLYPH_CLASS_NAME } from "~/components/chat/chatHeaderControls";
import { pullRequestDetailQueryOptions } from "~/lib/pullRequestReactQuery";
import { PullRequestStateGlyph } from "./PullRequestStateGlyph";

export function usePullRequestPaneStateIcon(
  input: PullRequestDetailInput | null,
): ReactNode | undefined {
  const detailQuery = useQuery({
    ...pullRequestDetailQueryOptions(input),
    enabled: false,
  });
  const detail = input ? detailQuery.data : undefined;
  if (!detail) return undefined;
  // Chip geometry without the chrome muting: this glyph's color *is* the state, so it renders
  // at the same strength as the state glyphs in the list rather than at a tab icon's.
  return (
    <PullRequestStateGlyph
      state={detail.state}
      isDraft={detail.isDraft}
      mergeability={detail.mergeability ?? undefined}
      className={CHAT_SURFACE_CHIP_GLYPH_CLASS_NAME}
    />
  );
}

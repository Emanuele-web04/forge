// FILE: panelWidthPolicy.ts
// Purpose: Pure width math for side panels (right dock + split-pane panel) so the
//          "open half" vs "open full width" policy has one testable source of truth
//          shared by every surface that hosts a panel.
// Layer: Web panel layout utilities

// Resolve the width the right dock should take when it opens.
//
// `preferredWidth` is a per-kind natural size (a phone-shaped device pane). It still
// wins under full width: stretching a fixed-aspect object edge to edge strands it in
// more empty space, not less. The kinds the full-width preference exists for (browser,
// diff, terminal, file, git, side chat) have no preferred width, so they fall through
// to the shell measurement.
//
// Returns null when the shell cannot be measured, so the caller leaves the CSS default
// in place rather than pinning a bogus width.
export function resolveDockOpenWidth(input: {
  shellWidth: number;
  minWidth: number;
  preferredWidth?: number | undefined;
  fullWidth: boolean;
}): number | null {
  if (input.preferredWidth !== undefined && input.preferredWidth > 0) {
    return Math.max(input.minWidth, input.preferredWidth);
  }
  if (!Number.isFinite(input.shellWidth) || input.shellWidth <= 0) {
    return null;
  }
  // Floor (not round) the full-width case so a fractional shell can never resolve to a
  // dock wider than the row it lives in, which would overflow the chat surface.
  const target = input.fullWidth ? Math.floor(input.shellWidth) : Math.round(input.shellWidth / 2);
  return Math.max(input.minWidth, target);
}

// Under full width the composer feasibility probe no longer gates a drag, so the only
// remaining bound is the shell itself: accept anything that still fits the row. An
// unmeasurable shell accepts the drag rather than freezing the handle.
export function acceptsFullWidthPanelDrag(input: {
  nextWidth: number;
  shellWidth: number;
}): boolean {
  if (!Number.isFinite(input.shellWidth) || input.shellWidth <= 0) {
    return true;
  }
  return input.nextWidth <= input.shellWidth;
}

// Largest width a split-pane panel may reach. Half mode reserves a readable chat
// column; full width reserves nothing and lets the panel take the whole pane.
export function resolveSplitPanelMaxWidth(input: {
  paneWidth: number;
  minPanelWidth: number;
  chatMinWidth: number;
  fullWidth: boolean;
}): number {
  const reservedForChat = input.fullWidth ? 0 : input.chatMinWidth;
  return Math.max(input.minPanelWidth, input.paneWidth - reservedForChat);
}

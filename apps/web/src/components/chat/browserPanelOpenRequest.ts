import type { ThreadId } from "@synara/contracts";

import { findLeafPaneById } from "../../splitView.logic";
import type { PaneId, SplitView } from "../../splitViewStore";

// The single-pane browser open request routes through
// `routeSingleDockPaneOpenRequest` (dockPaneOpenRequest.ts) like every other
// dock pane; only the split-view variant is browser-specific.

interface SplitBrowserPanelOpenRequestInput {
  readonly splitView: SplitView;
  readonly requestedThreadId: ThreadId;
  readonly rememberFloatingBrowser: (threadId: ThreadId) => void;
  readonly showFloatingBrowser: (paneId: PaneId) => void;
}

export function routeSplitBrowserPanelOpenRequest(input: SplitBrowserPanelOpenRequestInput): void {
  input.rememberFloatingBrowser(input.requestedThreadId);
  const focusedPane = findLeafPaneById(input.splitView.root, input.splitView.focusedPaneId);
  if (!focusedPane || focusedPane.threadId !== input.requestedThreadId) {
    return;
  }

  input.showFloatingBrowser(focusedPane.id);
}

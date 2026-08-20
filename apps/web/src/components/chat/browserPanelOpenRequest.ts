import type { ThreadId } from "@synara/contracts";

import { findLeafPaneById } from "../../splitView.logic";
import type { PaneId, SplitView } from "../../splitViewStore";

interface SingleBrowserPanelOpenRequestInput {
  readonly currentThreadId: ThreadId;
  readonly requestedThreadId: ThreadId;
  readonly requestImmediateBrowserHydration: () => void;
  readonly rememberFloatingBrowser: (threadId: ThreadId) => void;
  readonly showFloatingBrowser: (threadId: ThreadId) => void;
}

export function routeSingleBrowserPanelOpenRequest(
  input: SingleBrowserPanelOpenRequestInput,
): void {
  // Remember even when another chat is focused. The native runtime stays on
  // the requested thread; returning to that chat should restore the card.
  input.rememberFloatingBrowser(input.requestedThreadId);
  if (input.requestedThreadId !== input.currentThreadId) {
    return;
  }

  // Explicit same-thread requests must not wait for rAF, which Electron may
  // suspend while the app is backgrounded.
  input.requestImmediateBrowserHydration();
  input.showFloatingBrowser(input.currentThreadId);
}

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

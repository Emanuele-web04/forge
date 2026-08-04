import type { ThreadId } from "@synara/contracts";

import { findLeafPaneById } from "../../splitView.logic";
import type { PaneId, SplitView } from "../../splitViewStore";

interface SingleBrowserPanelOpenRequestInput {
  readonly currentThreadId: ThreadId;
  readonly requestedThreadId: ThreadId;
  readonly requestImmediateBrowserHydration: () => void;
  readonly openBrowserPane: (threadId: ThreadId) => void;
}

export function routeSingleBrowserPanelOpenRequest(
  input: SingleBrowserPanelOpenRequestInput,
): void {
  if (input.requestedThreadId !== input.currentThreadId) {
    // The native agent runtime stays alive without mounting this route. Never
    // steal the user's current chat merely to make the browser executable.
    return;
  }

  // Explicit same-thread requests must not wait for rAF, which Electron may
  // suspend while the app is backgrounded.
  input.requestImmediateBrowserHydration();
  input.openBrowserPane(input.currentThreadId);
}

interface SplitBrowserPanelOpenRequestInput {
  readonly splitView: SplitView;
  readonly requestedThreadId: ThreadId;
  readonly openBrowserPanel: (paneId: PaneId) => void;
}

export function routeSplitBrowserPanelOpenRequest(input: SplitBrowserPanelOpenRequestInput): void {
  const focusedPane = findLeafPaneById(input.splitView.root, input.splitView.focusedPaneId);
  if (!focusedPane || focusedPane.threadId !== input.requestedThreadId) {
    return;
  }

  input.openBrowserPanel(focusedPane.id);
}

// FILE: PullRequestDockPane.tsx
// Purpose: Adapter from a right-dock "pullRequest" pane to the detail panel — the single place
//          that validates the pane's identity fields, builds the PullRequestDetailInput, and
//          keys the panel so switching pull requests remounts it. Shared by the chat thread
//          dock and the /pull-requests route dock so neither duplicates this mapping.
// Layer: Pull request presentation
// Exports: PullRequestDockPane

import type { RightDockPane } from "~/rightDockStore.logic";

import { PanelStateMessage } from "~/components/chat/PanelStateMessage";
import {
  pullRequestDetailInputFromPane,
  pullRequestDetailInputKey,
} from "./pullRequestDetail.logic";
import { PullRequestDetailPanel } from "./PullRequestDetailPanel";

export function PullRequestDockPane({
  pane,
  onClose,
  onSelectPullRequest,
  pollingEnabled: pollingEnabledProp,
}: {
  pane: RightDockPane;
  onClose?: (() => void) | undefined;
  onSelectPullRequest?: ((number: number) => void) | undefined;
  pollingEnabled?: boolean;
}) {
  const pollingEnabled = pollingEnabledProp ?? true;
  const input = pullRequestDetailInputFromPane(pane);
  if (!input) {
    return <PanelStateMessage>Select a pull request to open it here.</PanelStateMessage>;
  }
  return (
    <PullRequestDetailPanel
      key={pullRequestDetailInputKey(input)}
      input={input}
      initialTab={pane.pullRequestInitialTab ?? "summary"}
      pollingEnabled={pollingEnabled}
      {...(onClose ? { onClose } : {})}
      {...(onSelectPullRequest ? { onSelectPullRequest } : {})}
    />
  );
}

export default PullRequestDockPane;

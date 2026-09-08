// FILE: PullRequestBitbucketConnectPrompt.tsx
// Purpose: The single restrained prompt shown above partial pull request results when Bitbucket
//          remotes are eligible but the Paraty MCP connection is missing or stale. GitHub
//          results stay visible below it; there is never one card per repository.
// Layer: Pull request presentation
// Exports: PullRequestBitbucketConnectPrompt, needsBitbucketConnection

import type { PullRequestProviderRequirement } from "@synara/contracts";

import { Button } from "~/components/ui/button";
import { PullRequestWarningNote } from "./PullRequestWarningNote";

/** True when at least one Bitbucket requirement asks the user to (re)connect. */
export function needsBitbucketConnection(
  requirements: readonly PullRequestProviderRequirement[] | undefined,
): boolean {
  return (requirements ?? []).some(
    (requirement) =>
      requirement.provider === "bitbucket" &&
      (requirement.status === "not-connected" || requirement.status === "reconnect-required"),
  );
}

export function PullRequestBitbucketConnectPrompt({
  onOpenIntegrations,
}: {
  onOpenIntegrations: () => void;
}) {
  return (
    <PullRequestWarningNote shape="callout" role="status">
      Connect Paraty MCP to include Bitbucket pull requests.{" "}
      <Button variant="outline" size="sm" className="ml-2" onClick={onOpenIntegrations}>
        Open integrations
      </Button>
    </PullRequestWarningNote>
  );
}

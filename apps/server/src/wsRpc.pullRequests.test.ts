import { PullRequestsUnavailableError, WsRpcError } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { PullRequestProviderError } from "./pullRequests/Services/PullRequestProvider";
import { toPullRequestsRpcError } from "./wsRpc";

describe("toPullRequestsRpcError", () => {
  it.each([
    ["not-installed", "gh-not-installed"],
    ["not-authenticated", "gh-not-authenticated"],
  ] as const)("maps a GitHub provider %s failure to %s", (reason, expectedReason) => {
    const error = toPullRequestsRpcError(
      new PullRequestProviderError({
        provider: "github",
        host: "github.com",
        operation: "getViewerLogin",
        repository: null,
        scope: "global",
        reason,
        message: `GitHub ${reason}`,
      }),
      "Pull request request failed",
    );

    expect(error).toBeInstanceOf(PullRequestsUnavailableError);
    expect(error).toMatchObject({
      reason: expectedReason,
      message: `GitHub ${reason}`,
    });
  });

  it("keeps other provider errors on the generic RPC error path", () => {
    const error = toPullRequestsRpcError(
      new PullRequestProviderError({
        provider: "bitbucket",
        host: "bitbucket.org",
        operation: "list",
        repository: "paraty/payment-seeker",
        scope: "repository",
        reason: "other",
        message: "Bitbucket request failed",
      }),
      "Pull request request failed",
    );

    expect(error).toBeInstanceOf(WsRpcError);
    expect(error).toMatchObject({ message: "Bitbucket request failed" });
  });
});

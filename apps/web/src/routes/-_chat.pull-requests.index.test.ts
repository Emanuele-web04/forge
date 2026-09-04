import { describe, expect, it } from "vitest";

import { normalizePullRequestsRouteSearch } from "./_chat.pull-requests.index";

describe("normalizePullRequestsRouteSearch", () => {
  it("defaults old selected pull request links to GitHub", () => {
    expect(
      normalizePullRequestsRouteSearch({
        selectedProjectId: "project-a",
        selectedRepo: "acme/widgets",
        number: 42,
      }),
    ).toMatchObject({
      selectedProjectId: "project-a",
      selectedProvider: "github",
      selectedRepo: "acme/widgets",
      number: 42,
    });
  });

  it("preserves Bitbucket in selected pull request links", () => {
    expect(
      normalizePullRequestsRouteSearch({
        selectedProjectId: "project-a",
        selectedProvider: "bitbucket",
        selectedRepo: "paraty/payment-seeker",
        number: 12,
      }),
    ).toMatchObject({
      selectedProvider: "bitbucket",
      selectedRepo: "paraty/payment-seeker",
      number: 12,
    });
  });
});

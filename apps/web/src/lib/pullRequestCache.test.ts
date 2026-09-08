import type { ProjectId } from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  listScopesContainingPullRequestRepository,
  optimisticallyPatchPullRequestActionFieldsInListCaches,
  pullRequestIdentityKey,
  pullRequestRemoteIdentityKey,
} from "./pullRequestCache";
import { pullRequestQueryKeys } from "./pullRequestQueryOptions";

describe("pull request cache identities", () => {
  it("includes provider in remote and project-local identities", () => {
    const projectId = "project-a" as ProjectId;
    const github = {
      projectId,
      provider: "github",
      repository: " Acme/Widgets ",
      number: 42,
    } as const;
    const bitbucket = { ...github, provider: "bitbucket" } as const;

    expect(pullRequestRemoteIdentityKey(github)).toBe("github\u0000acme/widgets\u000042");
    expect(pullRequestIdentityKey(github)).not.toBe(pullRequestIdentityKey(bitbucket));
    expect(pullRequestRemoteIdentityKey(github)).not.toBe(pullRequestRemoteIdentityKey(bitbucket));
  });

  it("finds repository scopes only for the matching provider", () => {
    const queryClient = new QueryClient();
    const projectA = "project-a" as ProjectId;
    const projectB = "project-b" as ProjectId;
    const githubScope = pullRequestQueryKeys.list({ state: "open", projectId: projectA });
    const bitbucketScope = pullRequestQueryKeys.list({ state: "open", projectId: projectB });
    const github = {
      projectId: projectA,
      provider: "github",
      repository: "acme/widgets",
      number: 42,
      isPinned: false,
    } as const;
    const bitbucket = { ...github, projectId: projectB, provider: "bitbucket" } as const;
    queryClient.setQueryData(githubScope, { entries: [github] });
    queryClient.setQueryData(bitbucketScope, { entries: [bitbucket] });

    expect(listScopesContainingPullRequestRepository(queryClient, github)).toEqual([
      { state: "open", projectId: projectA },
    ]);
  });

  it("optimistically patches action fields only for the matching provider", () => {
    const queryClient = new QueryClient();
    const projectId = "project-a" as ProjectId;
    const listKey = pullRequestQueryKeys.list({ state: "open", projectId: null });
    const github = {
      projectId,
      provider: "github",
      repository: "acme/widgets",
      number: 42,
      state: "open",
      isDraft: true,
      isPinned: false,
    } as const;
    const bitbucket = { ...github, provider: "bitbucket" } as const;
    queryClient.setQueryData(listKey, { entries: [github, bitbucket] });

    optimisticallyPatchPullRequestActionFieldsInListCaches(queryClient, github, {
      isDraft: false,
    });

    expect(queryClient.getQueryData(listKey)).toEqual({
      entries: [{ ...github, isDraft: false }, bitbucket],
    });
  });
});

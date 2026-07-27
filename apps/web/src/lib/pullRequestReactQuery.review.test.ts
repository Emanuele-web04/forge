import type { ProjectId } from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as nativeApi from "../nativeApi";
import {
  pullRequestQueryKeys,
  pullRequestReviewDraftCreateMutationOptions,
  pullRequestReviewSubmitMutationOptions,
} from "./pullRequestReactQuery";

afterEach(() => {
  vi.restoreAllMocks();
});

const projectId = "project-a" as ProjectId;
const target = { projectId, repository: "acme/widgets", number: 42 } as const;

describe("pull request review React Query", () => {
  it("shares a draft query across local projects for the same GitHub pull request", () => {
    expect(pullRequestQueryKeys.reviewDrafts(target)).toEqual(
      pullRequestQueryKeys.reviewDrafts({ ...target, projectId: "project-b" as ProjectId }),
    );
  });

  it("saves a draft through the pull request API and refreshes the exact draft query", async () => {
    const queryClient = new QueryClient();
    const key = pullRequestQueryKeys.reviewDrafts(target);
    queryClient.setQueryData(key, { drafts: [] });
    const createReviewDraft = vi.fn(async (input) => ({
      draft: {
        id: "draft-1",
        repository: input.repository,
        number: input.number,
        headSha: input.headSha,
        patchSignature: input.patchSignature,
        path: input.path,
        line: input.line,
        side: input.side,
        body: input.body,
        createdAt: "2026-07-26T00:00:00.000Z",
        updatedAt: "2026-07-26T00:00:00.000Z",
      },
    }));
    vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
      pullRequests: { createReviewDraft },
    } as never);
    const mutation = queryClient
      .getMutationCache()
      .build(queryClient, pullRequestReviewDraftCreateMutationOptions(queryClient));

    await mutation.execute({
      ...target,
      headSha: "head-1",
      patchSignature: "patch-1",
      path: "src/app.ts",
      line: 12,
      side: "RIGHT",
      body: "Keep this guard.",
    });

    expect(createReviewDraft).toHaveBeenCalledOnce();
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
  });

  it("keeps blocked review drafts cached while marking them stale for a refetch", async () => {
    const queryClient = new QueryClient();
    const key = pullRequestQueryKeys.reviewDrafts(target);
    const cached = { drafts: [{ id: "draft-1" }] };
    queryClient.setQueryData(key, cached);
    const submitReview = vi.fn(async () => ({
      status: "blocked" as const,
      submittedDraftIds: [],
      staleDraftIds: ["draft-1"],
      invalidDraftIds: [],
    }));
    vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
      pullRequests: { submitReview },
    } as never);
    const mutation = queryClient
      .getMutationCache()
      .build(queryClient, pullRequestReviewSubmitMutationOptions(queryClient));

    await mutation.execute({
      ...target,
      event: "COMMENT",
      body: "",
      draftIds: ["draft-1"],
    });

    expect(queryClient.getQueryData(key)).toEqual(cached);
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
  });
});

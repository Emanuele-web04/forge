import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { paratyBitbucketPullRequestBinding as binding } from "./paratyBitbucketBinding.ts";

const json = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const entry = {
  id: 2286, title: "Add gateway", state: "OPEN", draft: true,
  author: "Ada", author_uuid: "{ada}", source_branch: "feature/gateway",
  destination_branch: "master", created_on: "2026-09-03T15:06:03.529364+00:00",
  updated_on: "2026-09-03T16:42:15.786603+00:00",
  url: "https://bitbucket.org/paraty/payment-seeker/pull-requests/2286",
  comment_count: 0, task_count: 0,
};

describe("deployed Paraty MCP contract", () => {
  it("translates internal list arguments to the MCP tool schema", async () => {
    expect(await Effect.runPromise(binding.operations.list.encode({
      workspace: "paraty", repository: "payment-seeker", state: "OPEN",
      page: 1, pagelen: 50, sort: "-updated_on",
    }))).toEqual({ workspace: "paraty", repo_slug: "payment-seeker", states: ["OPEN"],
      page: 1, pagelen: 50, sort: "-updated_on" });
  });
  it.each(["detail", "diff", "comments"] as const)("translates %s repository arguments", async (operation) => {
    const pagination = operation === "comments" ? { page: 1, pagelen: 50 } : {};
    expect(await Effect.runPromise(binding.operations[operation].encode({
      workspace: "paraty", repository: "payment-seeker", pull_request_id: 2286, ...pagination,
    }))).toEqual({ workspace: "paraty", repo_slug: "payment-seeker", pull_request_id: 2286, ...pagination });
  });
  it("decodes structured summaries and retains pagination and skipped entries", async () => {
    const result = await Effect.runPromise(binding.operations.list.decode({ structuredContent: {
      workspace: "paraty", repo_slug: "payment-seeker", page: 1, pagelen: 50,
      pull_requests: [entry, { id: "bad" }], has_more: true, next_page: 2,
      total_count: null, skipped_count: 3, returned_count: 2,
    } }));
    expect(result).toMatchObject({ values: [{ id: 2286, draft: true, author: { display_name: "Ada" } }], malformedCount: 4 });
    expect(result).toHaveProperty("next");
  });
  it("decodes an explicit comments page without requiring size", async () => {
    expect(await Effect.runPromise(binding.operations.comments.decode(json({
      pagelen: 50, page: 1, values: [],
    })))).toMatchObject({ values: [], malformedCount: 0 });
  });
  it("decodes aggregated comments", async () => {
    expect(await Effect.runPromise(binding.operations.comments.decode(json({
      values: [], totalFetched: 0, fetchedPages: 1,
    })))).toMatchObject({ values: [], malformedCount: 0 });
  });
  it("accepts raw diff text and exposes server truncation", async () => {
    const patch = "diff --git a/a b/a\n--- a/a\n+++ b/a\n";
    expect(await Effect.runPromise(binding.operations.diff.decode({ content: [{ type: "text", text: patch }] }))).toEqual({ patch, truncated: false });
    expect(await Effect.runPromise(binding.operations.diff.decode({ content: [{ type: "text", text: patch + "\n\n[Truncated: exceeded character limit...]" }] }))).toMatchObject({ truncated: true });
  });
  it("rejects error envelopes even when they contain plausible data", async () => {
    await expect(Effect.runPromise(binding.operations.diff.decode({ isError: true,
      content: [{ type: "text", text: "diff --git a/a b/a\n" }],
    }))).rejects.toMatchObject({ category: "invalid-response" });
  });
});

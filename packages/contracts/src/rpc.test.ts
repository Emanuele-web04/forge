import { describe, expect, it } from "vitest";

import {
  WsAutomationCreateRpc,
  WsAutomationGetMemoryRpc,
  WsAutomationResolveProposalRpc,
  WsBootstrapRpcGroup,
  WsFeatureRpcGroup,
  WsProjectsDiscoverScriptsRpc,
  WsPullRequestsReviewRequestCountRpc,
  WsPullRequestsReviewDraftsListRpc,
  WsPullRequestsReviewDraftCreateRpc,
  WsPullRequestsReviewDraftUpdateRpc,
  WsPullRequestsReviewDraftDeleteRpc,
  WsPullRequestsReviewSubmitRpc,
  WsRpcError,
  WsRpcGroup,
} from "./rpc";
import { ORCHESTRATION_WS_METHODS } from "./orchestration";

describe("WS RPC contracts", () => {
  it("exports the additive Effect RPC group", () => {
    expect(WsRpcGroup).toBeDefined();
    expect(WsBootstrapRpcGroup.requests.has("bootstrap.negotiate")).toBe(true);
    expect(WsFeatureRpcGroup.requests.has("bootstrap.negotiate")).toBe(false);
    expect(
      WsFeatureRpcGroup.requests.has(ORCHESTRATION_WS_METHODS.listProviderDeliveryBlockers),
    ).toBe(true);
    expect(WsFeatureRpcGroup.requests.has(ORCHESTRATION_WS_METHODS.reconcileProviderDelivery)).toBe(
      true,
    );
  });

  it("uses a schema-backed transport error", () => {
    expect(new WsRpcError({ message: "failed" }).message).toBe("failed");
  });

  it("exports the project script discovery RPC", () => {
    expect(WsProjectsDiscoverScriptsRpc).toBeDefined();
  });

  it("exports the automation create RPC", () => {
    expect(WsAutomationCreateRpc).toBeDefined();
    expect(WsAutomationGetMemoryRpc).toBeDefined();
    expect(WsAutomationResolveProposalRpc).toBeDefined();
  });

  it("exports the count-only pull request review RPC", () => {
    expect(WsPullRequestsReviewRequestCountRpc).toBeDefined();
  });

  it("exports review draft and submit RPCs through the pull request group", () => {
    expect(WsPullRequestsReviewDraftsListRpc).toBeDefined();
    expect(WsPullRequestsReviewDraftCreateRpc).toBeDefined();
    expect(WsPullRequestsReviewDraftUpdateRpc).toBeDefined();
    expect(WsPullRequestsReviewDraftDeleteRpc).toBeDefined();
    expect(WsPullRequestsReviewSubmitRpc).toBeDefined();
    expect(WsFeatureRpcGroup.requests.has("pullRequests.reviewDrafts.list")).toBe(true);
    expect(WsFeatureRpcGroup.requests.has("pullRequests.review.submit")).toBe(true);
  });
});

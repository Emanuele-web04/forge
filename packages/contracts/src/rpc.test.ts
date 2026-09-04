import { describe, expect, it } from "vitest";

import {
  WsAutomationCreateRpc,
  WsAutomationGetMemoryRpc,
  WsAutomationResolveProposalRpc,
  WsBootstrapRpcGroup,
  WsFeatureRpcGroup,
  WsProjectsDiscoverScriptsRpc,
  WsProjectsProvisionFromGitHubRpc,
  WsPullRequestsReviewRequestCountRpc,
  WsResourceCancelDiskScanRpc,
  WsResourceCleanWorkspacesRpc,
  WsResourceGetSnapshotRpc,
  WsResourceKillAllSessionsRpc,
  WsResourceKillSessionRpc,
  WsResourceRestartDaemonRpc,
  WsResourceScanDiskRpc,
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
    expect(WsProjectsProvisionFromGitHubRpc).toBeDefined();
    expect(WsFeatureRpcGroup.requests.has("projects.provisionFromGitHub")).toBe(true);
  });

  it("exports the automation create RPC", () => {
    expect(WsAutomationCreateRpc).toBeDefined();
    expect(WsAutomationGetMemoryRpc).toBeDefined();
    expect(WsAutomationResolveProposalRpc).toBeDefined();
  });

  it("exports the count-only pull request review RPC", () => {
    expect(WsPullRequestsReviewRequestCountRpc).toBeDefined();
  });

  it("exports every resource-manager RPC through the feature group", () => {
    expect(WsResourceGetSnapshotRpc).toBeDefined();
    expect(WsResourceKillSessionRpc).toBeDefined();
    expect(WsResourceKillAllSessionsRpc).toBeDefined();
    expect(WsResourceCleanWorkspacesRpc).toBeDefined();
    expect(WsResourceScanDiskRpc).toBeDefined();
    expect(WsResourceCancelDiskScanRpc).toBeDefined();
    expect(WsResourceRestartDaemonRpc).toBeDefined();
    expect(WsFeatureRpcGroup.requests.has("resource.getSnapshot")).toBe(true);
    expect(WsFeatureRpcGroup.requests.has("resource.killSession")).toBe(true);
    expect(WsFeatureRpcGroup.requests.has("resource.killAllSessions")).toBe(true);
    expect(WsFeatureRpcGroup.requests.has("resource.cleanWorkspaces")).toBe(true);
    expect(WsFeatureRpcGroup.requests.has("resource.scanDisk")).toBe(true);
    expect(WsFeatureRpcGroup.requests.has("resource.cancelDiskScan")).toBe(true);
    expect(WsFeatureRpcGroup.requests.has("resource.restartDaemon")).toBe(true);
  });
});

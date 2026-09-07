import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  CloudConnectedRepository,
  CloudCreateWorkspaceInput,
  CloudEvent,
  CloudMembership,
  CloudOrganization,
  CloudRunnerHeartbeat,
  CloudTask,
  CloudTerminateWorkspaceInput,
  CloudUser,
  CloudWorkspace,
} from "./cloud";
import { CloudWorkspaceId } from "./baseSchemas";

const decodeWorkspace = Schema.decodeUnknownSync(CloudWorkspace);
const decodeTask = Schema.decodeUnknownSync(CloudTask);
const decodeEvent = Schema.decodeUnknownSync(CloudEvent);
const decodeHeartbeat = Schema.decodeUnknownSync(CloudRunnerHeartbeat);
const decodeTerminate = Schema.decodeUnknownSync(CloudTerminateWorkspaceInput);

function workspace() {
  return {
    id: "workspace-cloud-1",
    organizationId: "org-1",
    name: "Main app",
    status: "ready",
    region: "eu-west-1",
    repository: {
      connectedRepositoryId: "repo-1",
      owner: "acme",
      repo: "widgets",
      branch: "main",
      headSha: "f0d2c1",
    },
    checkout: { path: "/ws/main-app", commit: "f0d2c1" },
    quotas: { cpu: 2, cpuLimit: 4, memoryMb: 8_192, storageGb: 50, network: "isolated" },
    lifecycle: {
      createdAt: "2026-09-07T00:00:00.000Z",
      lastActiveAt: "2026-09-07T01:00:00.000Z",
      expiresAt: "2026-09-07T23:00:00.000Z",
      destroyAt: "2026-09-08T00:00:00.000Z",
    },
    isolation: "container-hardened",
  };
}

describe("CloudWorkspace", () => {
  it("decodes a complete workspace payload", () => {
    const decoded = decodeWorkspace(workspace());
    expect(decoded.id).toBe("workspace-cloud-1");
    expect(decoded.name).toBe("Main app");
    expect(decoded.status).toBe("ready");
    expect(decoded.quotas.cpu).toBe(2);
    expect(decoded.repository?.branch).toBe("main");
  });

  it("rejects an unknown workspace status", () => {
    expect(() => decodeWorkspace({ ...workspace(), status: "exploded" })).toThrow();
  });

  it("rejects a missing organization id", () => {
    expect(() =>
      decodeWorkspace({ ...workspace(), organizationId: undefined }),
    ).toThrow();
  });
});

describe("Cloud control-plane identity", () => {
  it("decodes organization, membership, user, and connected repository records", () => {
    expect(
      Schema.decodeUnknownSync(CloudOrganization)({
        id: "org-1",
        slug: "ada-personal",
        name: "Ada's workspace",
        personal: true,
        createdAt: "2026-09-07T00:00:00.000Z",
      }),
    ).toMatchObject({ id: "org-1", personal: true });
    expect(
      Schema.decodeUnknownSync(CloudMembership)({
        organizationId: "org-1",
        userId: "user-1",
        role: "owner",
        createdAt: "2026-09-07T00:00:00.000Z",
      }).role,
    ).toBe("owner");
    expect(
      Schema.decodeUnknownSync(CloudUser)({
        id: "user-1",
        email: "ada@example.com",
        createdAt: "2026-09-07T00:00:00.000Z",
      }).email,
    ).toBe("ada@example.com");
    expect(
      Schema.decodeUnknownSync(CloudConnectedRepository)({
        id: "repo-1",
        organizationId: "org-1",
        provider: "github",
        owner: "acme",
        name: "widgets",
        defaultBranch: "main",
        installationId: "installation-1",
        permissions: "write",
        connectedAt: "2026-09-07T00:00:00.000Z",
      }).permissions,
    ).toBe("write");
  });
});

describe("Cloud workspace commands", () => {
  it("ties workspace creation to an organization and connected repository", () => {
    expect(
      Schema.decodeUnknownSync(CloudCreateWorkspaceInput)({
        organizationId: "org-1",
        connectedRepositoryId: "repo-1",
        name: "Fix login",
        baseBranch: "main",
        region: "eu-west-1",
      }),
    ).toMatchObject({ connectedRepositoryId: "repo-1", baseBranch: "main" });
  });
});

describe("CloudTask", () => {
  it("decodes the task lifecycle and defaults providerSessionId to undefined", () => {
    const decoded = decodeTask({
      id: "task-1",
      workspaceId: "workspace-cloud-1",
      title: "Fix the flaky test",
      status: "running",
      turn: 3,
    });
    expect(decoded.title).toBe("Fix the flaky test");
    expect(decoded.status).toBe("running");
    expect(decoded.providerSessionId).toBeUndefined();
  });
});

describe("CloudEvent", () => {
  it("decodes a runtime event with opaque payload", () => {
    const decoded = decodeEvent({
      id: "event-1",
      workspaceId: "workspace-cloud-1",
      type: "quota.warning",
      at: "2026-09-07T01:30:00.000Z",
      payload: { cpu: 95 },
    });
    expect(decoded.type).toBe("quota.warning");
    expect(decoded.payload).toEqual({ cpu: 95 });
  });
});

describe("Cloud control-plane surface", () => {
  it("decodes a runner heartbeat", () => {
    const decoded = decodeHeartbeat({ workspaceId: "workspace-cloud-1", cpu: 0.42, memoryMb: 2_048 });
    expect(decoded.memoryMb).toBe(2_048);
  });

  it("decodes a termination request", () => {
    const decoded = decodeTerminate({ workspaceId: "workspace-cloud-1", reason: "expired" });
    expect(decoded.reason).toBe("expired");
  });

  it("rejects an unclassified workspace termination reason", () => {
    expect(() =>
      decodeTerminate({ workspaceId: "workspace-cloud-1", reason: "cleanup" }),
    ).toThrow();
  });

  it("decodes the branded workspace identifier", () => {
    expect(decodeWorkspace(workspace()).id).toBe("workspace-cloud-1");
    expect(() => Schema.decodeUnknownSync(CloudWorkspaceId)("")).toThrow();
  });
});

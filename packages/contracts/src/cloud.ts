import { Schema } from "effect";
import {
  CloudTaskId,
  CloudWorkspaceId,
  NonNegativeInt,
  OrganizationId,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas";

// Cloud (SaaS) workspace contracts. Design source:
// `.plans/Blueprint_de_la_version_cloud.md` §7–§8. Schema-only —
// no runtime logic, kept in line with the `packages/contracts` role.

const CloudWorkspaceStatus = Schema.Literals([
  "provisioning",
  "ready",
  "suspended",
  "destroyed",
]);
export type CloudWorkspaceStatus = typeof CloudWorkspaceStatus.Type;

const CloudTaskStatus = Schema.Literals([
  "queued",
  "running",
  "waiting",
  "done",
  "failed",
  "cancelled",
]);
export type CloudTaskStatus = typeof CloudTaskStatus.Type;

const CloudRegion = TrimmedNonEmptyString;
export type CloudRegion = typeof CloudRegion.Type;

const CloudNetworkMode = Schema.Literals(["isolated", "restricted"]);
export type CloudNetworkMode = typeof CloudNetworkMode.Type;

const CloudIsolation = Schema.Literals(["container-hardened", "microvm"]);
export type CloudIsolation = typeof CloudIsolation.Type;

export const CloudWorkspaceQuotas = Schema.Struct({
  cpu: Schema.Number,
  cpuLimit: Schema.Number,
  memoryMb: PositiveInt,
  storageGb: PositiveInt,
  network: CloudNetworkMode,
});
export type CloudWorkspaceQuotas = typeof CloudWorkspaceQuotas.Type;

export const CloudWorkspaceRepository = Schema.Struct({
  owner: TrimmedNonEmptyString,
  repo: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  headSha: TrimmedNonEmptyString,
});
export type CloudWorkspaceRepository = typeof CloudWorkspaceRepository.Type;

export const CloudWorkspaceCheckout = Schema.Struct({
  path: TrimmedNonEmptyString,
  commit: TrimmedNonEmptyString,
});
export type CloudWorkspaceCheckout = typeof CloudWorkspaceCheckout.Type;

export const CloudWorkspaceLifecycle = Schema.Struct({
  createdAt: Schema.DateTimeUtcFromString,
  lastActiveAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  destroyAt: Schema.DateTimeUtcFromString,
});
export type CloudWorkspaceLifecycle = typeof CloudWorkspaceLifecycle.Type;

export const CloudWorkspace = Schema.Struct({
  id: CloudWorkspaceId,
  organizationId: OrganizationId,
  name: TrimmedNonEmptyString,
  status: CloudWorkspaceStatus,
  region: CloudRegion,
  repository: Schema.optional(CloudWorkspaceRepository),
  checkout: CloudWorkspaceCheckout,
  quotas: CloudWorkspaceQuotas,
  lifecycle: CloudWorkspaceLifecycle,
  isolation: CloudIsolation,
});
export type CloudWorkspace = typeof CloudWorkspace.Type;

export const CloudTask = Schema.Struct({
  id: CloudTaskId,
  workspaceId: CloudWorkspaceId,
  title: TrimmedNonEmptyString,
  status: CloudTaskStatus,
  turn: NonNegativeInt,
  providerSessionId: Schema.optional(TrimmedNonEmptyString),
});
export type CloudTask = typeof CloudTask.Type;

const CloudEventType = Schema.Literals([
  "task.update",
  "git.update",
  "runtime.update",
  "quota.warning",
  "session.expiring",
]);
export type CloudEventType = typeof CloudEventType.Type;

export const CloudEvent = Schema.Struct({
  id: TrimmedNonEmptyString,
  workspaceId: CloudWorkspaceId,
  taskId: Schema.optional(CloudTaskId),
  type: CloudEventType,
  at: Schema.DateTimeUtcFromString,
  payload: Schema.Unknown,
});
export type CloudEvent = typeof CloudEvent.Type;

// Planned interaction surface between control plane and execution plane
// (design sketch §8 — not wired to any transport yet).
export const CloudProvisionWorkspaceInput = Schema.Struct({
  workspaceId: CloudWorkspaceId,
  organizationId: OrganizationId,
});
export type CloudProvisionWorkspaceInput = typeof CloudProvisionWorkspaceInput.Type;

export const CloudProvisionWorkspaceResult = Schema.Struct({
  endpoint: TrimmedNonEmptyString,
});
export type CloudProvisionWorkspaceResult = typeof CloudProvisionWorkspaceResult.Type;

export const CloudRunnerHeartbeat = Schema.Struct({
  workspaceId: CloudWorkspaceId,
  cpu: Schema.Number,
  memoryMb: NonNegativeInt,
});
export type CloudRunnerHeartbeat = typeof CloudRunnerHeartbeat.Type;

export const CloudTerminateWorkspaceInput = Schema.Struct({
  workspaceId: CloudWorkspaceId,
  reason: TrimmedNonEmptyString,
});
export type CloudTerminateWorkspaceInput = typeof CloudTerminateWorkspaceInput.Type;
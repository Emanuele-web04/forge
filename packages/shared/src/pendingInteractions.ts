// FILE: pendingInteractions.ts
// Purpose: Shared policy for atomically claiming durable approval/user-input responses.
// Layer: Cross-package orchestration utility
// Exports: reclaim timing and status predicates used by server persistence and web projection.

import type { OrchestrationPendingInteraction } from "@synara/contracts";

export const RESPONDING_INTERACTION_RECLAIM_GRACE_MS = 30_000;

export function respondingInteractionReclaimCutoff(requestedAt: string): string {
  const requestedAtMs = Date.parse(requestedAt);
  return Number.isNaN(requestedAtMs)
    ? requestedAt
    : new Date(requestedAtMs - RESPONDING_INTERACTION_RECLAIM_GRACE_MS).toISOString();
}

export function isPendingInteractionResponseClaimable(input: {
  readonly status: OrchestrationPendingInteraction["status"];
  readonly responseRequestedAt: string | null;
  readonly requestedAt: string;
}): boolean {
  if (input.status === "pending" || input.status === "retryable" || input.status === "uncertain") {
    return true;
  }
  if (input.status !== "responding") {
    return false;
  }
  return (
    input.responseRequestedAt === null ||
    input.responseRequestedAt <= respondingInteractionReclaimCutoff(input.requestedAt)
  );
}

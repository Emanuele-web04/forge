import type { OrchestrationThread } from "@synara/contracts";

export const SIDECHAT_EXPIRED_EXECUTION_MESSAGE =
  "This side chat expired after 1 hour of inactivity. Start a new side chat.";

type SidechatExpiryState = Pick<OrchestrationThread, "sidechatExpiredAt">;

export function isExpiredSidechat(thread: SidechatExpiryState): boolean {
  return thread.sidechatExpiredAt != null;
}

function parseTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function latestSidechatActivityAt(
  current: string | null | undefined,
  candidate: string,
): string {
  const currentTimestamp = current == null ? null : parseTimestamp(current);
  const candidateTimestamp = parseTimestamp(candidate);
  if (candidateTimestamp === null) return current ?? candidate;
  if (currentTimestamp === null) return new Date(candidateTimestamp).toISOString();
  return new Date(Math.max(currentTimestamp, candidateTimestamp)).toISOString();
}

export function sidechatActivityInstantsEqual(left: string, right: string): boolean {
  const leftTimestamp = parseTimestamp(left);
  const rightTimestamp = parseTimestamp(right);
  if (leftTimestamp === null || rightTimestamp === null) return left === right;
  return leftTimestamp === rightTimestamp;
}

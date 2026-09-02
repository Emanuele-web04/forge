// FILE: providerDeliveryBlock.ts
// Purpose: Single source for the "thread blocked by an earlier provider failure" message contract.
// Layer: Shared runtime utilities
// Exports: PROVIDER_DELIVERY_BLOCK_SUMMARY, formatProviderDeliveryBlockDetail, isProviderDeliveryBlockDetail

/**
 * Summary the provider command reactor records when it refuses to run a command
 * for a quarantined thread. The web app matches on the same text to offer the
 * recovery action, so server and client must never drift apart.
 */
export const PROVIDER_DELIVERY_BLOCK_SUMMARY = "Thread is blocked by an earlier provider failure";
const PROVIDER_DELIVERY_BLOCK_DETAIL_PREFIX = `${PROVIDER_DELIVERY_BLOCK_SUMMARY}:`;

/** Session error detail written for a quarantined thread, e.g. "<summary>: <blocker>". */
export function formatProviderDeliveryBlockDetail(blockerDetail: string): string {
  return `${PROVIDER_DELIVERY_BLOCK_DETAIL_PREFIX} ${blockerDetail}`;
}

/**
 * True when a thread-level error detail was produced by the delivery quarantine,
 * meaning the thread can be recovered by reconciling its blocking deliveries.
 */
export function isProviderDeliveryBlockDetail(detail: string | null | undefined): boolean {
  if (typeof detail !== "string") return false;
  const normalized = detail.trimStart();
  return (
    normalized === PROVIDER_DELIVERY_BLOCK_SUMMARY ||
    normalized.startsWith(PROVIDER_DELIVERY_BLOCK_DETAIL_PREFIX)
  );
}

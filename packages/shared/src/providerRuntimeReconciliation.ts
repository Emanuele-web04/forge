// FILE: providerRuntimeReconciliation.ts
// Purpose: Canonical semantic identity for provider runtime recovery activities.
// Layer: Shared runtime utilities

export const PROVIDER_RUNTIME_RECONCILIATION_ACTIONS = [
  "align-running-turn",
  "settle-interrupted",
  "settle-terminal-projection",
  "settle-error",
] as const;

export type ProviderRuntimeReconciliationAction =
  (typeof PROVIDER_RUNTIME_RECONCILIATION_ACTIONS)[number];

export function isProviderRuntimeReconciliationAction(
  value: string | null | undefined,
): value is ProviderRuntimeReconciliationAction {
  return PROVIDER_RUNTIME_RECONCILIATION_ACTIONS.some((action) => action === value);
}

/**
 * Returns one stable identity for all settlement refinements of the same stale
 * turn. Runtime realignments stay distinct because their live turn id is part
 * of the identity. Callers can add scope fields such as the owning thread when
 * the resulting key must be globally unique.
 */
export function providerRuntimeReconciliationIdentityKey(
  input: {
    readonly provider: string;
    readonly action: ProviderRuntimeReconciliationAction;
    readonly projectedTurnId: string | null;
    readonly runtimeTurnId: string | null;
  },
  scope: ReadonlyArray<string> = [],
): string {
  const operation = input.action === "align-running-turn" ? input.action : "settle-running-turn";
  return `provider-runtime-reconcile:${JSON.stringify([
    input.provider,
    operation,
    ...scope,
    input.projectedTurnId,
    input.runtimeTurnId,
  ])}`;
}

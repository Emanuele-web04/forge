import { Effect, ServiceMap } from "effect";

import type {
  CapabilityId,
  EvidenceOutcome,
  RuntimeIdentitySignals,
  VerifierIdentity,
} from "@synara/contracts";

export type CapabilityAttribution =
  | "agent"
  | "synara"
  | "auth"
  | "network"
  | "environment"
  | "unknown";

export interface CapabilityVerificationRequest {
  readonly namespace: string;
  readonly capabilityId: CapabilityId;
  readonly runtime: RuntimeIdentitySignals;
  readonly verifier: VerifierIdentity;
  readonly advertisement: { readonly advertised: boolean } | undefined;
  /**
   * Harness-specific spawn context for the verifier: the executable to invite
   * into the run and its environment. Verifiers that own a child process use
   * this instead of guessing from the runtime fingerprint. KAR-524.
   */
  readonly spawnContext?: {
    readonly command: string;
    readonly args?: ReadonlyArray<string>;
    readonly env?: Readonly<Record<string, string>>;
  };
}

export interface CapabilityVerificationOutcome {
  readonly capabilityId: CapabilityId;
  readonly outcome: EvidenceOutcome;
  readonly attribution: CapabilityAttribution;
  readonly detail?: string;
  /** The runtime identity observed while verifying, for persistence (KAR-524). */
  readonly runtime?: RuntimeIdentitySignals;
  /** When the observation was captured; falls back to `new Date().toISOString()`. */
  readonly observedAt?: string;
}

export interface CapabilityVerifierShape {
  readonly id: string;
  /**
   * Optional runtime-key predicate. When present, the registry only resolves
   * this verifier for a runtime that matches (e.g. ACP verifiers match any
   * runtime whose fingerprint is an ACP fingerprint). KAR-524.
   */
  readonly matchesRuntime?: (runtime: RuntimeIdentitySignals) => boolean;
  readonly verifies: (
    request: CapabilityVerificationRequest,
  ) => Effect.Effect<CapabilityVerificationOutcome, Error>;
}

export interface CapabilityVerifierRegistryShape {
  readonly register: (verifier: CapabilityVerifierShape) => void;
  readonly resolve: (request: {
    readonly capabilityId: CapabilityId;
    readonly runtime: RuntimeIdentitySignals | undefined;
  }) => CapabilityVerifierShape | undefined;
  readonly list: () => ReadonlyArray<CapabilityVerifierShape>;
}

export class CapabilityVerifierRegistry extends ServiceMap.Service<
  CapabilityVerifierRegistry,
  CapabilityVerifierRegistryShape
>()("synara/capabilityEvidence/Services/CapabilityVerifierRegistry") {}

/**
 * Empty seam. KAR-524 registers real bindings (ACP conformance, production
 * observers, vendor attestations) and keys them by (capabilityId, runtime
 * fingerprint). Until then `resolve` always answers `undefined`, which the
 * service treats as "no verifier available → no new evidence".
 */
export const makeCapabilityVerifierRegistry = Effect.sync((): CapabilityVerifierRegistryShape => {
  const verifiers: CapabilityVerifierShape[] = [];
  return {
    register: (verifier) => {
      verifiers.push(verifier);
    },
    resolve: ({ capabilityId, runtime }) => {
      for (const verifier of verifiers) {
        if (
          verifier.id.startsWith(`${capabilityId}.`) &&
          (runtime === undefined || (verifier.matchesRuntime?.(runtime) ?? true))
        ) {
          return verifier;
        }
      }
      return undefined;
    },
    list: () => [...verifiers],
  };
});

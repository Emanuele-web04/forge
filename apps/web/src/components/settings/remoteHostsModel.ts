// FILE: remoteHostsModel.ts
// Purpose: The decisions the remote-hosts settings UI makes, as pure functions:
//          which dialog state a probe result implies, whether a fingerprint may
//          be trusted, and what a saved row says.
// Layer: Web / settings (no React, so every branch is directly testable)
// Exports: AddHostStage, addHostStageFromProbe, canTrustHostKey,
//          connectivityLabelFor, isDestinationComplete

import type {
  RemoteHostConnectivityState,
  RemoteHostFingerprintResult,
  RemoteHostProbeResult,
} from "@synara/contracts";
import { mayOfferHostKeyTrust } from "@synara/shared/remoteHostProbe";

import { CONNECTIVITY_LABEL } from "./remoteHostsCopy";

/**
 * What the add-host dialog is showing.
 *
 * `host-key-unknown` and `host-key-changed` are separate stages rather than one
 * "host key problem" stage with a flag, so the changed-key branch has no code
 * path that could render a trust button at all.
 */
export type AddHostStage =
  | { readonly kind: "form" }
  | { readonly kind: "checking" }
  | { readonly kind: "host-key-unknown"; readonly probe: RemoteHostProbeResult }
  | { readonly kind: "host-key-changed"; readonly probe: RemoteHostProbeResult }
  | { readonly kind: "failed"; readonly probe: RemoteHostProbeResult }
  | { readonly kind: "ready"; readonly probe: RemoteHostProbeResult };

/**
 * Maps a probe result to a dialog stage.
 *
 * Readiness deliberately does NOT gate adding: an `ok` probe is `ready`, but so
 * is a host that answered and simply has no agent installed. A host with
 * nothing on it is still worth adding — it just cannot start chats yet, which
 * the readiness copy explains later. Only a genuine connection failure blocks.
 */
export function addHostStageFromProbe(probe: RemoteHostProbeResult): AddHostStage {
  if (probe.outcome === "unreachable") {
    if (probe.unreachableReason === "host-key-unknown") return { kind: "host-key-unknown", probe };
    if (probe.unreachableReason === "host-key-changed") return { kind: "host-key-changed", probe };
    return { kind: "failed", probe };
  }
  // Reachable. `missing-binary` / `missing-path` mean the host answered, which
  // is all adding requires.
  return { kind: "ready", probe };
}

/**
 * Whether the trust affordance may be shown.
 *
 * Two independent conditions, both required:
 *  1. `mayOfferHostKeyTrust` — the shared gate, true only for first contact.
 *  2. A fingerprint we actually fetched. Trusting without one is trusting
 *     whatever answered the connection, which is the thing the prompt exists to
 *     prevent, so a failed keyscan must not degrade into a trust button.
 */
export function canTrustHostKey(
  probe: RemoteHostProbeResult,
  fingerprint: RemoteHostFingerprintResult | undefined,
): boolean {
  if (!mayOfferHostKeyTrust(probe)) return false;
  return fingerprint !== undefined && fingerprint.fingerprints.length > 0;
}

export function connectivityLabelFor(state: RemoteHostConnectivityState): string {
  return CONNECTIVITY_LABEL[state];
}

/** The submit button is enabled on a non-empty destination and nothing else. */
export function isDestinationComplete(destination: string): boolean {
  return destination.trim().length > 0;
}

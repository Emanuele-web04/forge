// FILE: remoteHostsModel.ts
// Purpose: The decisions the remote-hosts settings UI makes, as pure functions:
//          which dialog state a probe result implies, whether a fingerprint may
//          be trusted, and what a saved row says.
// Layer: Web / settings (no React, so every branch is directly testable)
// Exports: AddHostStage, addHostStageFromProbe, canTrustHostKey,
//          connectivityLabelFor, isDestinationComplete, appendBootstrapStage,
//          bootstrapStageLabel, BootstrapStageLine

import type {
  RemoteHostConnectivityState,
  RemoteHostFingerprintResult,
  RemoteHostProbeResult,
} from "@synara/contracts";
import { mayOfferHostKeyTrust } from "@synara/shared/remoteHostProbe";

import { ADD_STAGE_LABEL, CONNECTIVITY_LABEL } from "./remoteHostsCopy";

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

/** One rendered stage line. `step` is kept only as a React key, never shown. */
export interface BootstrapStageLine {
  readonly step: BootstrapStageStep;
  readonly label: string;
}

export type BootstrapStageStep = keyof typeof ADD_STAGE_LABEL;

/**
 * The label for a step, or `undefined` for a step we have no approved copy for.
 *
 * Returns undefined rather than falling back to the raw step name. A step name
 * is an internal identifier — "installing-supervisor" is not a sentence — and a
 * fallback that rendered one would put unapproved text in front of a user the
 * first time the server gained a step this UI had not been taught.
 */
export function bootstrapStageLabel(step: string): string | undefined {
  return Object.hasOwn(ADD_STAGE_LABEL, step)
    ? ADD_STAGE_LABEL[step as BootstrapStageStep]
    : undefined;
}

/**
 * Appends the line for a step that just fired.
 *
 * APPEND, never advance through a script. The eight steps are not a fixed
 * sequence — `uploading` and `reusing-staged` are alternatives, `verifying`
 * fires once per artifact — so a progress bar over a known list would claim
 * work that may never happen. A line appears when, and only when, its step
 * actually fired.
 *
 * Consecutive duplicates collapse: `uploading` fires once per artifact and two
 * identical adjacent lines read as a rendering bug, not as progress. The same
 * label reached again LATER still appends, because that is a real second visit.
 */
export function appendBootstrapStage(
  lines: readonly BootstrapStageLine[],
  step: string,
): readonly BootstrapStageLine[] {
  const label = bootstrapStageLabel(step);
  if (label === undefined) return lines;
  if (lines.at(-1)?.step === step) return lines;
  return [...lines, { step: step as BootstrapStageStep, label }];
}

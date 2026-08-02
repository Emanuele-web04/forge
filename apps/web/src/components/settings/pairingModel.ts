// FILE: pairingModel.ts
// Purpose: Turns a host's credential and reachability into the exact URL a phone
//          should scan, or an explicit reason it cannot be paired yet.
// Layer: Settings logic
// Exports: pairing URL construction and per-host pairing state resolution.

import type { EnvironmentId, ServerPhoneReachabilityResult } from "@synara/contracts";

/**
 * Builds the pairing URL a phone opens.
 *
 * The credential goes in the FRAGMENT, never the query: a fragment is not sent
 * to the server, is not written to access logs, and is not carried on a
 * `Referer`. This mirrors the startup pairing link the server already prints.
 */
export function buildPairingUrl(input: {
  readonly origin: string;
  readonly credential: string;
}): string {
  const url = new URL(input.origin);
  url.pathname = "/pair";
  url.search = "";
  url.hash = new URLSearchParams([["token", input.credential]]).toString();
  return url.toString();
}

export interface PairingHostState {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Scannable URL, present only when this host can actually be paired now. */
  readonly pairingUrl: string | null;
  readonly reachability: ServerPhoneReachabilityResult | null;
  /** Why no QR is shown. Null when `pairingUrl` is present. */
  readonly blockedReason: string | null;
  /** Always shown, so the fallback is documented even on the blessed path. */
  readonly fallbackCommand: string | null;
}

export interface PairingHostInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly reachable: boolean;
  readonly reachability: ServerPhoneReachabilityResult | null;
  readonly credential: string | null;
  /**
   * Origin this browser is already using for the host, used when the host has
   * no Tailscale origin but the page itself was loaded over one (the phone can
   * reach whatever this browser reached).
   */
  readonly browserOrigin: string | null;
}

/**
 * Resolves one host's pairing state.
 *
 * A QR code is produced ONLY when there is both a credential and an origin a
 * phone can actually open. Encoding a `localhost` URL would produce a code that
 * scans fine and then fails to load — the user blames the phone, not the setup.
 */
export function resolvePairingHostState(input: PairingHostInput): PairingHostState {
  const base: Pick<PairingHostState, "environmentId" | "label" | "reachability"> & {
    fallbackCommand: string | null;
  } = {
    environmentId: input.environmentId,
    label: input.label,
    reachability: input.reachability,
    fallbackCommand: input.reachability?.fallbackCommand ?? null,
  };

  if (!input.reachable) {
    return {
      ...base,
      pairingUrl: null,
      blockedReason: `Synara cannot reach ${input.label}, so it cannot issue a pairing link. Bring the host back online, then reopen this screen.`,
    };
  }
  if (!input.credential) {
    return {
      ...base,
      pairingUrl: null,
      blockedReason: `Could not get a pairing link from ${input.label}. Only an owner session can create one — sign in as the owner on ${input.label} and try again.`,
    };
  }

  const origin = input.reachability?.origin ?? phoneUsableOrigin(input.browserOrigin);
  if (!origin) {
    return {
      ...base,
      pairingUrl: null,
      blockedReason:
        input.reachability?.setupHint ??
        `${input.label} is only reachable at a loopback address, which a phone cannot open. Set up Tailscale on the host, or use the SSH port forward below.`,
    };
  }

  return {
    ...base,
    pairingUrl: buildPairingUrl({ origin, credential: input.credential }),
    blockedReason: null,
  };
}

/**
 * An origin a phone could plausibly open.
 *
 * Loopback and `.local` names resolve to something different on the phone — in
 * the loopback case, the phone itself — so they are rejected rather than turned
 * into a QR code that scans and then 404s.
 */
export function phoneUsableOrigin(candidate: string | null): string | null {
  if (!candidate) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
    return null;
  }
  return url.origin;
}

// FILE: reachability.ts
// Purpose: How a host's last probe reads in the UI, and how a host's endpoints
//          become the candidate list the transport race walks.
// Layer: Web remote-access feature logic.
// Exports: candidate building, reachability projection, and its display tokens.

import type { AccountHost } from "@synara/contracts";
import type {
  TransportCandidate,
  TransportKind,
  TransportRaceResult,
} from "@synara/shared/transportRace";

/**
 * Reachability as this app renders it (ADR 0010).
 *
 * There is no presence store and no push channel, so every one of these is a
 * statement about the LAST ATTEMPT, never about right now. That is also why
 * `unknown` exists as a real state rather than defaulting to "offline": a host
 * nobody has probed yet has not failed, and telling a user their machine is
 * down because the app has not looked would be a lie the palette can't even
 * express (there is no success/warning token — see the spec's §4 conventions).
 */
export type HostReachability =
  | { readonly state: "unknown" }
  | { readonly state: "probing" }
  | { readonly state: "reachable"; readonly transport: TransportKind; readonly at: number }
  | { readonly state: "unreachable"; readonly at: number }
  /** Probed, heard nothing — a network problem, not evidence the host is off. */
  | { readonly state: "no-answer"; readonly at: number }
  /** Nothing to probe: no endpoints published and no relay configured. */
  | { readonly state: "no-route"; readonly at: number };

export const TRANSPORT_LABELS: Record<TransportKind, string> = {
  loopback: "this machine",
  lan: "local network",
  tailscale: "Tailscale",
  ssh: "SSH",
  relay: "relay",
};

/**
 * The one line the host row shows for status.
 *
 * Deliberately a sentence rather than a dot: the palette is warm-neutral and
 * low-chroma with no success token, and a green light would claim live
 * presence the architecture does not have. Reachability reads as text, dimmed
 * when it is not a confirmed connection (see {@link reachabilityToneClassName}).
 */
export function reachabilityLabel(reachability: HostReachability): string {
  switch (reachability.state) {
    case "unknown":
      return "Not checked yet";
    case "probing":
      return "Checking…";
    case "reachable":
      return `Reachable over ${TRANSPORT_LABELS[reachability.transport]}`;
    case "unreachable":
      return "Did not answer";
    case "no-answer":
      return "No response — check your network";
    case "no-route":
      return "No known address";
  }
}

/**
 * Emphasis, not color. A confirmed path gets full-strength foreground text;
 * everything else is muted, which is the only "status" signal this palette
 * offers and the only one ADR 0010 entitles us to.
 */
export function reachabilityToneClassName(reachability: HostReachability): string {
  return reachability.state === "reachable" ? "text-foreground" : "text-muted-foreground";
}

/**
 * The transport actually carrying the session, once one is open. Distinct from
 * reachability: a probe says a path answered, this says a path is in use, and
 * the spec asks the row to show both.
 */
export function activeTransportLabel(transport: TransportKind): string {
  return `Connected over ${TRANSPORT_LABELS[transport]}`;
}

export interface HostCandidateInput {
  readonly host: AccountHost;
  /** `wss://…` base for the relay, or null when this deployment has none. */
  readonly relayUrl: string | null;
  /**
   * Extra candidates the shell discovered for itself — mDNS on Desktop, the
   * loopback address of a host running in this very process. Web clients pass
   * none: they cannot browse mDNS (spec §5) and have no SSH.
   */
  readonly discovered?: readonly TransportCandidate[];
}

/**
 * The candidate list for one host, in no particular order — `raceTransports`
 * sorts by ADR 0007 preference itself, so ordering here would be a second
 * place for the preference to live and disagree.
 *
 * The relay is always last-resort but always present when configured: it is
 * the only path that works from a foreign network, and omitting it because a
 * LAN address exists is how "works at my desk, dead on the train" happens.
 */
export function buildHostCandidates(input: HostCandidateInput): readonly TransportCandidate[] {
  const candidates: TransportCandidate[] = [];
  for (const endpoint of input.host.endpoints) {
    candidates.push({ kind: endpoint.transport, url: endpoint.url, label: endpoint.transport });
  }
  for (const discovered of input.discovered ?? []) {
    candidates.push(discovered);
  }
  if (input.relayUrl) {
    candidates.push({
      kind: "relay",
      url: relaySessionUrl(input.relayUrl, input.host.id),
      label: "relay",
    });
  }
  return candidates;
}

/**
 * The relay's client-session URL for a host. The grant is appended at dial
 * time, not here: this URL is put in logs and rendered in diagnostics, and a
 * grant is a bearer credential that must not end up in either.
 */
export function relaySessionUrl(relayUrl: string, hostId: string): string {
  const base = relayUrl.replace(/\/+$/, "");
  return `${base}/client/session?host=${encodeURIComponent(hostId)}`;
}

/**
 * The relay's per-host readiness probe.
 *
 * A probe of the relay itself only ever proved the RELAY was up, so every
 * host in a relay-configured deployment read as "Reachable over relay" and
 * the host's actual absence surfaced later as a 4404 at session open. This
 * asks the question the row is claiming to answer: is THIS host's control
 * socket connected and ready?
 */
export function relayHostHealthUrl(relayUrl: string, hostId: string): string {
  const base = relayUrl.replace(/\/+$/, "").replace(/^ws(s?):/, "http$1:");
  return `${base}/healthz/host/${encodeURIComponent(hostId)}`;
}

/** Projects a finished race into the row's status line. */
export function reachabilityFromRace(result: TransportRaceResult, at: number): HostReachability {
  switch (result.outcome) {
    case "reachable":
      return { state: "reachable", transport: result.candidate.kind, at };
    case "unreachable":
      return { state: "unreachable", at };
    case "timed-out":
      return { state: "no-answer", at };
    case "no-candidates":
      return { state: "no-route", at };
  }
}

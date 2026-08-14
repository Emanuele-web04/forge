// FILE: connect.ts
// Purpose: The client connection flow — grant, transport race, mint, session —
//          and what a relay close code means for the next attempt.
// Layer: Web remote-access feature logic.
// Exports: connectToHost, close-code retry classification, and their types.

import {
  RELAY_CLOSE_BAD_TOKEN,
  RELAY_CLOSE_GRANT_REPLAY,
  RELAY_CLOSE_HOST_UNAVAILABLE,
  RELAY_CLOSE_KEEPALIVE_LOST,
  RELAY_CLOSE_OVERLOADED,
  RELAY_CLOSE_SPLICE_CLAIMED,
  RELAY_CLOSE_SUPERSEDED,
  HOST_SESSION_CLOSE_AUTH_FAILED,
  HOST_SESSION_CLOSE_PROTOCOL_ERROR,
  HOST_SESSION_CLOSE_REVOKED,
} from "@synara/relay-protocol";
import {
  raceTransports,
  type TransportCandidate,
  type TransportProbe,
  type TransportRaceResult,
} from "@synara/shared/transportRace";

/**
 * What to do after a relay socket closed.
 *
 * The close code is the only diagnosis the client gets, so the mapping has to
 * be exact — retrying a dead grant forever and giving up on a busy relay are
 * both one wrong branch away.
 */
export type RelayRetryPlan =
  /** The grant was refused or already spent: mint a fresh one and dial again. */
  | { readonly action: "re-grant"; readonly reason: string }
  /** The host is not on the relay. Surface it; retry on a backoff (ADR 0010). */
  | { readonly action: "host-offline"; readonly reason: string }
  /** The relay is shedding load. Back off before touching it again. */
  | { readonly action: "back-off"; readonly reason: string }
  /** Someone else took this session over — reconnecting would fight them. */
  | { readonly action: "stop"; readonly reason: string }
  /** Ordinary transport loss: reconnect on the normal schedule. */
  | { readonly action: "reconnect"; readonly reason: string };

/**
 * Relay close code ⇒ retry semantics (spec §3.5).
 *
 * 4401/4403 are the two shapes of "your grant is no good": refused outright,
 * or replayed after it was already consumed. Both are cured by a new grant and
 * only by a new grant — reconnecting with the same one reproduces the close
 * immediately and, for 4403, looks like an attacker replaying credentials.
 */
export function relayRetryPlan(code: number): RelayRetryPlan {
  switch (code) {
    case RELAY_CLOSE_BAD_TOKEN:
      return { action: "re-grant", reason: "The connection grant was refused." };
    case RELAY_CLOSE_GRANT_REPLAY:
      return { action: "re-grant", reason: "That connection grant was already used." };
    case RELAY_CLOSE_HOST_UNAVAILABLE:
      return { action: "host-offline", reason: "That host is not currently reachable." };
    case RELAY_CLOSE_OVERLOADED:
      return { action: "back-off", reason: "The relay is busy — retrying shortly." };
    case RELAY_CLOSE_SUPERSEDED:
    case RELAY_CLOSE_SPLICE_CLAIMED:
      return { action: "stop", reason: "This session was taken over by another connection." };
    case RELAY_CLOSE_KEEPALIVE_LOST:
      return { action: "reconnect", reason: "The connection timed out." };
    // Host-session codes travel verbatim through the splice, so they must be
    // classified here too — a revoked session is NOT a bad grant, and
    // re-granting would only produce a 403 from the API.
    case HOST_SESSION_CLOSE_REVOKED:
      return { action: "stop", reason: "Your access to this host was revoked." };
    case HOST_SESSION_CLOSE_AUTH_FAILED:
      return { action: "re-grant", reason: "The host refused this session credential." };
    case HOST_SESSION_CLOSE_PROTOCOL_ERROR:
      return { action: "stop", reason: "The host rejected the connection handshake." };
    default:
      return { action: "reconnect", reason: "The connection closed." };
  }
}

/** Whether a close code means the grant must be re-minted before redialing. */
export function requiresFreshGrant(code: number): boolean {
  return relayRetryPlan(code).action === "re-grant";
}

export interface ConnectToHostInput {
  readonly hostId: string;
  readonly candidates: readonly TransportCandidate[];
  /** `POST /hosts/:id/grant` — device-bound and short-lived (60s). */
  readonly requestGrant: (hostId: string) => Promise<string>;
  /** Cheap liveness check; the shell supplies it (fetch here, TCP on desktop). */
  readonly probe: TransportProbe;
  /**
   * Presents `synara-mint-request+jwt` over the winning transport and returns
   * the host-minted session credential. Transport-independent by design (ADR
   * 0013): the credential works on whatever path won, so a later transport
   * switch does not re-auth.
   */
  readonly mint: (input: {
    readonly candidate: TransportCandidate;
    readonly grant: string;
  }) => Promise<string>;
  readonly raceOptions?: Parameters<typeof raceTransports>[2];
}

export type ConnectToHostResult =
  | {
      readonly outcome: "connected";
      readonly candidate: TransportCandidate;
      readonly credential: string;
      readonly race: TransportRaceResult;
    }
  | {
      /** Every path failed. `race` carries each attempt for the status line. */
      readonly outcome: "unreachable";
      readonly race: TransportRaceResult;
    };

/**
 * `grant → connect → mint → session`, once.
 *
 * The grant is fetched BEFORE the race even though only the winner uses it:
 * grants live 60 seconds and the race can burn 3 of them, so minting after a
 * slow race is how a valid path gets a grant that expires between winning and
 * being used. Ordering it first also means a cloud outage fails fast with a
 * clear reason instead of after a full probe cycle.
 *
 * Retries are the caller's: this returns the outcome and the attempts, and the
 * close-code plan above says what a *later* failure should do. Baking a retry
 * loop in here would hide the re-grant boundary that 4401/4403 depend on.
 */
export async function connectToHost(input: ConnectToHostInput): Promise<ConnectToHostResult> {
  const grant = await input.requestGrant(input.hostId);
  const race = await raceTransports(input.candidates, input.probe, input.raceOptions ?? {});
  if (race.outcome !== "reachable") {
    return { outcome: "unreachable", race };
  }
  const credential = await input.mint({ candidate: race.candidate, grant });
  return { outcome: "connected", candidate: race.candidate, credential, race };
}

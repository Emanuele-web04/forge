# Remote hosts — what shipped, what is still dark

Written after the epic-wide review of the five-slice hosts epic (commits
`e2e432915` … `092408ba0`). The slice specs describe what each slice set out
to build; this records **what a user can actually do today** and what remains.
Read this before assuming the feature is usable end to end.

## Shipped and proven

The A→B→C spine is real and covered by `apps/e2e` (8 scenarios, real API +
real relay + real host): host enrollment and re-link key rotation, device-code
enrollment, relay sessions with byte-identical text and binary traffic, one
credential reused across transports, grant single-use, revocation killing a
live session across all three services, offline degradation, and backpressure
integrity. The account API, relay service, and host runtime are complete.

## Dark tops — built bottom-up, not yet wired

These are implemented and unit-tested but have no path a user can reach:

1. **No `hosts` namespace on NativeApi.** The web UI probes for it and falls
   back to "this server does not support remote hosts yet", so the Connections
   panel, discoverability prompt, and `/link` route are unreachable in a real
   shell. This is the single blocker for Slice D being user-visible.
2. **Desktop sign-in auto-register** (ADR 0015's _primary_ enrollment path) is
   unbuilt; only the `synara auth` CLI path exists.
3. **mDNS** (slice D §5) is unimplemented. `buildHostCandidates` accepts a
   `discovered` list, so Desktop can supply results without touching the race.
4. **Slice E's client half.** `packages/shared/src/hostSecrets.ts` is complete
   and tested but has no consumer outside API tests: no pairing UI, no Sync-Key
   handoff, and nothing triggers rotation when `DELETE /devices/:id` fires.
5. **No host-side session UI.** `RemoteSessionRegistry` tracks live sessions
   but nothing surfaces them, so a user cannot see who is connected.

## Known gaps worth fixing before external users

6. **Consent is grant-first.** Every link inserts `discoverable: true`, and the
   consent prompt is a client-side toggle _after_ the fact — so between link
   and answer (or forever, if the prompt is never shown) an org can reach the
   machine. ADR 0002 says consent comes first. Multi-member-org links should
   start `discoverable: false`, and the headless device-code path needs a
   consent story at all. Note `discoverabilityAcknowledged` is referenced by
   the client but has no column.
7. **Missed `device_revoked` events are unrecoverable.** The authorization
   snapshot cannot express device revocation, so reconnect-reverify can never
   drop a revoked device's session; a relay restart, an offline host, or the
   200-host fan-out cap all silently degrade the stolen-device kill to the ~1h
   credential TTL. Fix by carrying revoked jkts (or a revocation watermark) in
   `HostAuthorizationSnapshot`, or amend ADR 0015 to name the exposure.
8. **Revocation delivery hinges on optional config.** `relayUrl` is optional,
   but direct and ssh-forward sessions are accepted regardless — so a linked
   host without `SYNARA_RELAY_URL` serves remote sessions that outlive every
   revocation kind. At minimum warn loudly; better, treat linked-but-relayless
   as misconfiguration.
9. **Relay reachability is service-level, not per-host.** The relay's only
   health surface is aggregate, so "Reachable over relay" means "the relay is
   up" — the host's actual absence only surfaces as a 4404 at session open. A
   per-host health read (`GET /healthz/host/:id` over the in-memory map) would
   stay within the stateless-relay rules; otherwise rename the UI state.
10. **Owner access depends on the cloud.** Per the corrected ADR 0011, the
    owner short-circuit should be pinned to the link-time `hostOwnerUserId` so
    the owner's own sessions survive an API outage or compromise without a
    round trip.

## Vocabulary drift

`CONTEXT.md` proscribes "remote host" — all hosts are the same entity — yet the
client feature is `lib/remoteHosts/`, `useRemoteHosts`, `RemoteHostsApi`.
Rename to `hosts`/`useHosts` before it fossilizes. (`remoteSessions` on the
server is fine: a _session_ genuinely is remote.)

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

1. ~~**No `hosts` namespace on NativeApi.**~~ **DONE** (commit below). Nine
   owner-guarded RPCs — `hosts.list`, `update`, `delete`, `listDevices`,
   `revokeDevice`, `approveDeviceLink`, `requestGrant`, `enrollment`,
   `unlinkLocalHost` — now span contracts → server → web, so the Connections
   panel, consent prompt and `/link` route resolve in a real shell.
2. ~~**Desktop sign-in auto-register** (ADR 0015's _primary_ enrollment
   path).~~ **DONE** — sign-in and cold-launch status now load or create this
   shell's ES256 device identity, upsert it through `POST /devices`, persist
   its active `{deviceId, deviceJkt}`, and automatically link the bundled
   local host when it has no complete link. The private key stays in the
   shell's atomic owner-only secrets file and is re-imported as a
   non-extractable runtime signer. `hosts.requestGrant` uses the retained
   key's real JKT and re-registers after revocation, so the returned grant is
   bound to a key this shell can prove. Sign-out continues to unlink the
   bundled host before removing the local account session.
3. ~~**mDNS**~~ **WON'T DO** (decided 2026-08-14). Directory-reported LAN and
   Tailscale endpoints plus the relay already cover discovery; mDNS only helps
   when a self-reported address is stale AND the client is on the same LAN AND
   it is Desktop — and that case already degrades correctly, losing the probe
   race and falling through to the relay. Every other follow-up shipped
   because something was broken or unsafe; this one was an optimization, and
   the only one that would add a new dependency class.

   Research done before deciding, so this is re-openable without redoing it:
   - The repo already pays the native-module cost twice (`node-pty`, and the
     Swift `appsnap` helper), and `@electron/rebuild` is already active — so a
     native dep would ride existing machinery, but would add a second special
     case to the hand-rolled Linux rebuild in `build-desktop-artifact.ts`.
   - Bun handles multicast fine: `dgram` + `addMembership` on 224.0.0.251 and
     `ff02::fb`, real `_services._dns-sd._udp.local` queries, and an
     end-to-end publish/browse via `bonjour-service` all behaved identically
     to Node, unprivileged. Note the packaged desktop runs the host on
     Electron's Node, not Bun, so both runtimes matter and both work.
   - Best pure-JS option is `bonjour-service` (maintained TS rewrite, 14.6M
     weekly). `mdns`/node_mdns is the worst (NAN, 1.8k weekly, last release
     2020, needs Bonjour SDK on Windows).
   - Shell-out — the repo's established pattern for optional discovery, see
     `tailscaleEndpoint.ts` shelling to `tailscale status --json` — does not
     generalize here: macOS has `/usr/bin/dns-sd`, Linux needs `avahi-utils`
     which is often absent, and **Windows has no browse tool at all**.
   - Unresolved risk if revisited: on Linux, a running `avahi-daemon` owns UDP
     5353 and will conflict with a pure-JS advertiser.

4. ~~**Slice E's client half.**~~ **DONE** — owner-only pairing RPCs (begin,
   offer, receive, confirm) carry the Sync-Key handoff; both devices derive the
   six-character verification code and the recipient does not unwrap or persist
   the key until the codes are confirmed to match. Device revocation now
   triggers surviving-device rotation, using CAS writes plus a durable journal
   so a partial upload or a process restart recovers safely; self-revocation is
   refused because a revoked device cannot be the surviving rotator.
   **Presentation decided 2026-08-14** (grilling session), now the only work
   left on this item:
   - **Paste a short code**, mirroring the `/link` device-code flow already
     built for headless linking — same alphabet, same input handling, no new
     dependency and no new API surface.
   - **The new device displays; the existing device types.** Matches `/link`
     (the thing being enrolled displays) and keeps approval with the device
     that already holds the secret.
   - **Mismatch: retype, capped at 3, then burn the pairing.** A typo is the
     common case and is forgiven; exhausting the attempts destroys the pending
     pairing on both sides and forces a fresh start, because the other cause
     of a mismatch is the MITM this code exists to catch. The final attempt's
     copy should name that risk rather than saying "incorrect code".
   - **Lives as a "Sync host secrets" section in the Connections settings
     pane**, alongside hosts, devices and active sessions. No new route.
5. ~~**No host-side session UI.**~~ **DONE** — owner-only `hosts.listSessions`
   and `hosts.endSession`, with an "Active sessions" section in the Connections
   panel showing user, device, transport and start time, and a confirmed
   disconnect through the registry's existing revocation path. This closes the
   third leg of ADR 0011's threat model: access is no longer invisible.

## Known gaps worth fixing before external users

6. ~~**Consent is grant-first.**~~ **DONE** — shared-workspace links now start
   private and the owner opts in; solo workspaces stay frictionless; the
   membership probe fails closed. Original finding: Every link inserts `discoverable: true`, and the
   consent prompt is a client-side toggle _after_ the fact — so between link
   and answer (or forever, if the prompt is never shown) an org can reach the
   machine. ADR 0002 says consent comes first. Multi-member-org links should
   start `discoverable: false`, and the headless device-code path needs a
   consent story at all. Note `discoverabilityAcknowledged` is referenced by
   the client but has no column.
7. ~~**Missed `device_revoked` events are unrecoverable.**~~ **DONE** — the
   authorization snapshot now carries recently revoked thumbprints, so an
   eventless reverify drops the session. Original finding: The authorization
   snapshot cannot express device revocation, so reconnect-reverify can never
   drop a revoked device's session; a relay restart, an offline host, or the
   200-host fan-out cap all silently degrade the stolen-device kill to the ~1h
   credential TTL. Fix by carrying revoked jkts (or a revocation watermark) in
   `HostAuthorizationSnapshot`, or amend ADR 0015 to name the exposure.
8. ~~**Revocation delivery hinges on optional config.**~~ **DONE** — a linked
   host with no relay URL now warns loudly at startup. Original finding: `relayUrl` is optional,
   but direct and ssh-forward sessions are accepted regardless — so a linked
   host without `SYNARA_RELAY_URL` serves remote sessions that outlive every
   revocation kind. At minimum warn loudly; better, treat linked-but-relayless
   as misconfiguration.
9. ~~**Relay reachability is service-level, not per-host.**~~ **DONE** — the
   relay exposes `GET /healthz/host/:hostId`. Original finding: The relay's only
   health surface is aggregate, so "Reachable over relay" means "the relay is
   up" — the host's actual absence only surfaces as a 4404 at session open. A
   per-host health read (`GET /healthz/host/:id` over the in-memory map) would
   stay within the stateless-relay rules; otherwise rename the UI state.
10. ~~**Owner access depends on the cloud.**~~ **DONE** — mint decides the
    owner from the link-time record, so the owner reaches their machine
    during an API outage. Original finding: Per the corrected ADR 0011, the
    owner short-circuit should be pinned to the link-time `hostOwnerUserId` so
    the owner's own sessions survive an API outage or compromise without a
    round trip.

## Vocabulary drift — DONE

Renamed `lib/remoteHosts/` → `lib/hosts/`, `useRemoteHosts` → `useHosts`,
`RemoteHostsApi` → `HostsApi`, including user-facing copy. `CONTEXT.md`
proscribes "remote host" (all hosts are the same entity) and the client was
teaching the banned term. `remoteSessions` on the server keeps its name: a
_session_ genuinely is remote.

## What remains

Items 3–5 above. They are independent additions.

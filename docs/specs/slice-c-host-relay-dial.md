# Slice C — Host relay dial: control socket, mint endpoint, revocation kill

**Draft — finalized after A+B land.** Implements workstream C per ADRs 0010–0013, 0015. Touches `apps/server` (the Synara host).

## 1. Host identity & keys

- Ed25519 keypair generated on first link, stored in the server state dir as a JSON secret (PKCS8/SPKI PEM), `0o600`, atomic temp+rename — mirroring the t3code `environmentKeys` pattern. New module `apps/server/src/hostIdentity/`.
- Link flow (client-initiated via Desktop/device-code, Slice A §4): host receives `{challengeJwt}`, generates keypair if absent, signs `synara-host-link+jwt`, POSTs to API `link/complete`. Re-link generates a **fresh keypair** (ADR 0015: sign-out unlink → new keypair on next sign-in).
- HostProof minting helper (`synara-host-proof+jwt`, ≤60s) for all API calls; replaces any `synhost_` bearer usage.

## 2. Relay control socket supervisor

New `apps/server/src/relayDial/` — supervisor-kept outbound WSS to the relay (reuse the connectivity state machine + jittered backoff from `feat/remote-hosts-combined`'s `packages/shared/src/remoteHostConnectivity.ts` as reference):

- Obtain `synara-relay-ticket` from API (HostProof-authed), dial `wss://<relay>/host/control?ticket=`.
- Handle `splice_request`: validate expiry, dial `/host/data?splice=<id>`, bridge the data socket into the local WS server as a new inbound connection (same path a direct LAN WS takes — one protocol stack, transport-independent).
- Handle `revocation`: re-verify affected live sessions against the API; drop sessions whose authorization no longer holds (close code from `packages/contracts/src/relayProtocol.ts`).
- Keepalive ping/pong; reconnect forever with capped backoff; on reconnect, re-fetch a fresh ticket and re-verify all live remote sessions (covers offline-missed revocations).
- Enabled iff the host is linked; sign-out/unlink tears it down.

## 3. Transport-independent mint endpoint (ADR 0013)

New WS-layer handshake in `apps/server` (runs identically over LAN, Tailscale, SSH-forward, or a relay splice — it's just the first frames on the socket):

- Client sends `synara-mint-request+jwt`: wraps its grant + a DPoP proof of its device key. Host verifies: grant signature against API JWKS (cached; fetched via HostProof-authed call or public endpoint), exp, aud, `hostId` = self, jti unseen (in-memory 60s cache), DPoP proof signed by the key matching the grant's `cnf.jkt`.
- Host mints `synara-session-credential+jwt`: signed by the host key, `cnf.jkt` = device jkt, TTL 1h, claims include userId + granted scope. Client uses it (+ per-connection DPoP proof) to authenticate subsequent connections on ANY transport until expiry; re-mint requires a fresh grant.
- Loopback/same-machine connections keep the existing local trust path — mint not required. SSH-forwarded connections are distinguished (dedicated forwarded port) and DO require the credential.
- Grant verification works offline-tolerantly: JWKS cached with last-known-good; if the API is unreachable and no cached key exists, mint fails (accepted: first contact needs the cloud).

## 4. Session authorization state

Sessions carry `{userId, deviceJkt, credentialExp, via}`. The revocation handler and the credential-expiry sweep both terminate sessions through one code path. Owner sessions survive discoverability-off; org-member sessions die on it (verified against API on signal).

## 5. Endpoint reporting

On startup and network change: PUT LAN/Tailscale URLs to `PUT /hosts/:id/endpoints` (HostProof-authed). Reuse `feat/remote-hosts-combined`'s `tailscaleServe.ts` detection as reference where applicable.

## 6. Tests

Vitest in `apps/server` (`--maxWorkers=1` pinned per repo policy). Unit: keypair persistence/atomicity, HostProof shape, mint verification matrix (bad sig/exp/aud/jti-replay/jkt-mismatch), credential verification, revocation session-kill logic. Integration: fake relay (in-process WS server speaking the control protocol) + fake API (JWKS + revocations) driving a real host through link → dial → splice → mint → traffic → revoke → kill. The connectivity supervisor: reconnect/backoff behavior under socket drops.

## Out of scope

Client-side probe race (D); mDNS (D); secrets sync (E); SSH bootstrap re-landing (separate follow-up from feat/remote-hosts-combined).

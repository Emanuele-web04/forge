# Slice checkpoint — headless end-to-end harness

Gates the A→B→C thin slice (parent spec, "Workstreams & build order" step 4). Proves a real client reaches a real host through a real relay, with the **real account API** — no fakes anywhere in the path. Lands after Slice C.

## Why this exists

Each slice's own suite uses fakes for its neighbours: the relay tests fake the API, the host tests fake the relay. Those prove each side honors the contract _as that side understands it_. Only this harness proves the three understandings agree — and it is the thing that would have caught, in one run, both bugs the per-slice suites missed (the closing-handshake hang and the silently dropped frames).

It is not throwaway: it becomes the permanent integration suite and the debugging tool for Slices D and E.

## Shape

New package `apps/e2e` (vitest, no UI). Boots, in one process:

1. **Real API** — `createApp()` from `apps/api` against the docker-compose Postgres (`TEST_DATABASE_URL`), with `fakeWorkos` as the identity provider (the only substitution — WorkOS is a third party, not our contract).
2. **Real relay** — `createRelayApp()` from `apps/relay`, pointed at the API's origin and JWKS.
3. **Real host** — `apps/server` in its test configuration, pointed at the API and relay.
4. **Headless client** — a small library (not a UI) doing what Slice D's client will: device keypair (ES256), device registration with PoP, grant fetch, transport selection, mint handshake, then normal Synara WS traffic.

Each gets an ephemeral port; no fixed ports, so the suite is parallel-safe and CI-safe.

## The scenarios (each an assertion, not a smoke test)

1. **Enrollment**: host links via challenge → `hosts` row has the public key and `key_generation` 1; a second link rotates the key and the old HostProof is refused.
2. **Device-code enrollment**: headless path — mint code, approve as the owner, exchange, complete.
3. **Relay session**: client fetches a grant, connects through the relay, completes the mint handshake, exchanges real protocol traffic both directions, and the payloads arrive byte-identical (text _and_ binary).
4. **Direct session**: same client, same credential, over the host's LAN URL — proving the credential is transport-independent (ADR 0013) and no re-auth occurs on switch.
5. **Grant single-use**: replaying a spent grant is refused with the documented close code.
6. **Revocation kills live sessions**: with a session open, the owner turns discoverability off (or revokes the device) → the API writes the event → the relay polls it → the host drops that session, and the client observes the specific close code. This is the one path that spans all three services and cannot be tested anywhere else.
7. **Offline degradation**: stop the relay mid-session → the direct transport still works; stop the API → an already-minted credential still authenticates until expiry, and a _new_ device→host pairing fails cleanly (the accepted trade in ADR 0013).
8. **Backpressure integrity**: push a large burst through a deliberately slow reader and assert every frame arrives, in order, unmodified — the regression test for the dropped-frame blocker.

## Running

`bun run --cwd apps/e2e test` with `TEST_DATABASE_URL` set (docker-compose Postgres up). Skips with a clear message when the DB is absent, in the same `describe.skipIf` idiom as `apps/api`, so a developer without Postgres still gets a green workspace — but CI must set it. Each scenario cleans its own rows; the suite never assumes an empty database.

## Explicit non-goals

No browser, no Electron, no UI (Slice D covers those). No mDNS (needs a real LAN). No performance targets beyond the backpressure integrity check.

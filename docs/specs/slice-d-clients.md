# Slice D — Clients: device keys, transport race, enrollment UX

**Draft — finalized after Slice C lands.** Implements workstream D per ADRs 0007, 0010, 0013, 0015. Touches `apps/web`, `apps/desktop`, and `packages/shared`.

## 1. Device identity (`packages/shared/src/deviceKey.ts`, new)

- Generate a **non-extractable** keypair in the platform keystore: WebCrypto `ECDSA P-256` (`extractable: false`) in the browser/Electron renderer, persisted by handle in IndexedDB; Desktop main may use the OS keychain where available. ES256 is required — Secure Enclave and WebCrypto cannot do Ed25519 (Slice A already allows ES256 for device keys).
- `POST /devices` with a `synara-device-register+jwt` proof of possession (Slice A §9), then cache `{deviceId, jkt}` locally. Re-register idempotently on launch; a revoked device re-registers as a fresh row.
- DPoP proofs (`typ: dpop+jwt`, `htu`/`htm`/`jti`/`iat`/`ath`) are minted per request from the same key for session-credential use.

## 2. Transport selection (`packages/shared/src/transportRace.ts`, new)

Implements ADR 0007 exactly: build the candidate list, probe concurrently, pick by fixed preference **loopback > LAN > Tailscale > SSH (desktop only) > relay**.

- Candidates: directory endpoints (`AccountHost.endpoints`), mDNS discoveries (Desktop only), and always the relay.
- Probe = cheap liveness check with a short timeout (~1.5s) and an overall race deadline (~3s); first *preferred* winner wins, not merely the first to answer — a slower loopback still beats a fast relay.
- Reachability is **attempt-based** (ADR 0010): no presence store, no push channel. The host list renders status as of the last probe.
- Credential reuse across transports (ADR 0013): one minted session credential authenticates on any winning transport, so a mid-session transport switch does not re-auth.

## 3. Connection flow

`grant → connect → mint → session`:

1. `POST /hosts/:id/grant` with the device `jkt` (Slice A §4.4).
2. Connect over the winning transport (relay: `wss://relay/client/session?grant=…`; direct: the host's own URL).
3. Present `synara-mint-request+jwt` wrapping the grant + DPoP proof; receive the host-minted `synara-session-credential+jwt` (~1h).
4. Speak the normal Synara WS protocol; on expiry, fetch a fresh grant and re-mint.
5. Close codes from `@synara/relay-protocol` drive retry semantics: `4401`/`4403` ⇒ re-grant, `4404` ⇒ host offline (surface it, retry with backoff), `1013` ⇒ back off.

## 4. UI (Synara design system; Paper references)

Per the repo's UI conventions: **all open/close motion via `apps/web/src/lib/disclosureMotion.ts`** — no bespoke transitions. Follow existing Sidebar/Settings patterns.

**Paper state (checked 2026-08-13, file `Synara`):** the `Architecture` page holds the Remote Access diagram (the architecture reference used throughout this epic); `Profile` holds the shipped profile/share dialogs; the **`Connections` page is empty**. So there is no host-UI artboard to match — this slice designs it fresh against the token system below, and the user's follow-up pass is where visual polish lands.

Design tokens (from Paper; mirror whatever the web app already defines rather than hardcoding):

| token | value | | token | value |
|---|---|---|---|---|
| `--color-background` | `#FCFCFC` | | `--text-ui-sm` | 11px |
| `--color-card` | `#FFFFFF` | | `--text-ui` | 12px |
| `--color-foreground` | `#262626` | | `--text-ui-lg` | 13px |
| `--color-muted-foreground` | `#676767` | | `--text-body` | 14px |
| `--color-faint-foreground` | `#8F8F8F` | | `--text-title` | 20px |
| `--color-primary` | `#171717` | | `--weight-regular` / `--weight-medium` | 400 / 500 |
| `--color-primary-foreground` | `#FFFFFF` | | `--radius-sm` / `md` / `lg` | 6 / 8 / 10px |
| `--color-border` | `rgb(0 0 0 / 5%)` | | `--radius-dialog` | 22px |
| `--color-border-input` | `rgb(0 0 0 / 6%)` | | `--font-ui` | System Sans-Serif |
| `--color-secondary` | `rgb(0 0 0 / 4%)` | | `--font-display` | Cal Sans |
| `--color-destructive` | `#EF4444` | | `--font-mono` | JetBrains Mono |

Conventions that follow from the palette: it is a warm-neutral, low-chroma system — **no color-coded status dots** (there is no success/warning token, and ADR 0010 means we have no live presence to show anyway). Reachability reads as text/opacity, not a green light. `--color-destructive` is reserved for genuinely destructive affordances: device revoke, host delete, unlink. The device-code is `--font-mono`.

- **Host list** (Sidebar section + Settings pane): name, platform, `mine` vs org badge, last-probe reachability, and the transport actually in use once connected. Discoverability toggle for owned hosts.
- **Link a host**: Desktop auto-registers its bundled host at sign-in; in a **multi-member org** show the consent prompt before making it discoverable (ADR 0002/0015). Sign-out unlinks.
- **Device-code flow** (headless): a `/link` route where the owner enters the `userCode` and approves — the alphabet excludes I/O/0/1 and the field should be case-insensitive and auto-uppercasing.
- **Devices pane**: list the user's devices, show last-used, allow revoke (with the "this signs that device out everywhere" consequence stated plainly).

The user will do a polish pass afterward; this slice aims for correct structure, correct tokens, and no bespoke motion.

## 5. mDNS (Desktop only)

Advertise `_synara._tcp` from the host and browse from Desktop clients; discovered addresses join the probe candidate list. Web clients cannot use mDNS and rely on directory endpoints + relay.

## 6. Tests

`apps/web` and `apps/desktop` vitest. Transport race: preference order honored under mixed latencies; deadline behavior; no candidate reachable ⇒ clear error. Device key: non-extractable, PoP proof shape, idempotent re-register, revoked ⇒ re-register path. Enrollment: multi-member-org prompt shown/not-shown; sign-out unlink called. Credential lifecycle: re-mint on expiry, transport switch without re-auth. Note `--passWithNoTests` makes typo'd paths pass silently — assert real counts.

## 7. Out of scope

Presence dots (ADR 0010); hosted web client (ADR 0014); secrets sync UI (Slice E).

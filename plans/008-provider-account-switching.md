# Plan 008 — Provider Account Switching

Status: IN PROGRESS
Priority: P1
Effort: L
Depends on: —

## Goal

Let one Synara installation keep several authenticated identities for a provider and let the user
choose the active identity without moving, duplicating, or deleting Synara chats. The first complete
drivers are Claude Agent and Codex; the account domain and RPC boundary are intentionally generic so
providers with a safe isolated credential mechanism can be added later.

The reference interaction is the Orca account screen:

- A permanent `System default` entry preserves the provider CLI's normal machine login.
- Managed accounts can be added, reauthenticated, selected, or removed.
- Exactly one account is active per provider.
- Changing account is explicit and global for that provider; there is no automatic quota rotation.

## Product semantics

1. The server, not the browser or a thread option, owns the active account selection.
2. A switch stops all live and discovery runtimes for that provider before subsequent work starts.
   The next turn starts with the selected identity and resumes the existing provider session where
   the provider supports cross-identity resume. Synara's own transcript always remains intact.
3. Existing `~/.claude` and `~/.codex` logins are never modified. `System default` always means the
   CLI behavior the machine already had before this feature.
4. Managed credentials live in private per-account directories under Synara's server data root.
   Claude uses `CLAUDE_CONFIG_DIR`; Codex uses `CODEX_HOME` with file-backed credential storage.
5. Non-credential session/history/config entries are linked to the system provider home so switching
   does not split provider history. Direct credential environment variables are removed from managed
   process environments so they cannot silently override the chosen account.
6. Removing an account is recoverable: metadata stops referencing it and its managed directory moves
   to a local trash directory. It is never recursively deleted by the account RPC.

## Architecture

### Shared contracts

`packages/contracts/src/providerAccounts.ts` defines the managed-provider key, account projection,
auth states, and mutations. The WS/RPC/IPC surfaces expose list, create, select, reauthenticate, and
delete. Credentials and credential paths never cross this boundary.

### Server account authority

`apps/server/src/providerAccounts.ts` owns metadata, private directories, authentication jobs,
credential probes, active-account resolution, and change notifications. All provider consumers ask
this service for the current environment at operation time.

The account resolver is wired into:

- Codex and Claude session start/resume;
- model, command, skill, and plugin discovery caches;
- provider health/authentication probes;
- live and local usage snapshots;
- Claude credential keepalive;
- Codex discovery sessions.

The web client cannot pin a managed `accountId` in recoverable thread options. This prevents stale
threads from bypassing a later global switch.

### Web UI

Provider settings renders one section per implemented driver. Each includes `System default`, managed
account rows, active/authentication state, and explicit actions. Authentication is asynchronous: the
CLI opens its official browser flow and the UI polls while that job is active.

## Delivery phases

### Phase 1 — Claude and Codex drivers (implemented in this branch)

- Contracts and server account service.
- Isolated official CLI login flows (`claude auth login`, `codex login`).
- Server-authoritative switching and provider runtime teardown.
- Resolver coverage for runtime, discovery, health, usage, and keepalive.
- Provider settings UI and recoverable removal.

### Phase 2 — Packaged-app validation

- Verify add/login/switch/reauthenticate/remove for two real accounts of each provider.
- Verify a pre-existing chat can continue after switching, including provider-native resume behavior.
- Verify usage and health labels follow the selected identity.
- Verify browser/device authentication callbacks in signed packaged builds on macOS, Windows, and
  Linux where supported.

### Phase 3 — Additional providers

Add a driver only when the provider has a documented, isolatable credential store or profile switch.
Each driver must define login, status probe, environment resolution, shared non-secret state, and
safe deletion semantics. Providers that only expose a single global keychain identity remain on
`System default` until a reliable isolation mechanism exists; the UI must not imply support early.

## Security and failure rules

- Metadata files use mode `0600`; managed directories use `0700` where the platform supports modes.
- Never return tokens, auth files, or raw CLI output to the renderer.
- Failed or incomplete authentication cannot be selected.
- A failed runtime stop leaves the old account selected; switching is not committed halfway through.
- Corrupt metadata is normalized conservatively and an absent active account falls back to
  `System default`.
- Login subprocesses are owned and terminated on server shutdown.

## Verification

Focused automated coverage should include:

- contract decoding for every account RPC;
- metadata normalization and active-account fallback;
- credential environment isolation for Claude and Codex;
- account selection rejection when authentication is incomplete;
- account-aware usage cache keys and provider discovery invalidation;
- settings UI loading, polling, switch, reauthentication, and removal states.

Final live validation must use an isolated Synara home and non-default ports. Do not reuse or mutate the
operator's normal provider logins while validating managed accounts.

## Remaining design question

Provider-native session resume may be rejected when a session identifier was created by another
identity. The server currently attempts normal resume because it preserves the richest continuity.
Packaged validation must characterize Claude and Codex independently; if either rejects it, add a
provider-specific fallback that starts a fresh native session from Synara's authoritative transcript
without changing the visible Synara conversation.

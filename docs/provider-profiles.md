# Provider profiles

Provider profiles let one provider implementation, such as Codex, run with more than one
server-owned account configuration. The profile identity is part of thread routing; credentials
and launch configuration are not.

## Identity model

Synara keeps these concepts separate:

- `ProviderKind` selects the adapter implementation, for example `codex` or `claudeAgent`.
- `ProviderProfileId` selects one named server-owned configuration for that provider.
- `ProviderTarget` is the complete routing identity: `{ provider, profileId }`.
- A continuation namespace identifies the provider-native thread store. It is not automatically
  the same thing as an authentication profile.
- A runtime lease owns the right to write to one provider-native continuation. It is a runtime
  concern, not a persisted profile identifier.

Legacy data that has no profile identifier belongs to the reserved `default` profile.

## Sources of truth

- A thread's persisted model selection records its intended provider target.
- `provider_session_runtime` records the exact target needed for runtime recovery.
- A server-owned profile registry resolves a target into launch configuration and credentials.
- Browser requests may select a target, but they never supply or override profile credentials.

Do not add another independently writable target field to a projection. Derived views may expose
the target, but they must be rebuilt from the thread model selection or runtime binding.

## Routing invariants

1. Resume cursors, provider options, active runtimes, and native forks are reusable only when the
   complete provider target matches.
2. A change of provider or profile is a target replacement. The old runtime stops before the new
   runtime starts, so two accounts never own the same continuation concurrently.
3. If replacement fails, recovery restores the exact old target and its compatible runtime state.
4. A thread may adopt its first target before work begins. After its first turn, changing profiles
   creates a new thread or an explicit history handoff; it does not mutate the established thread.
5. Missing, disabled, or invalid profiles fail closed. They never fall back to `default`.
6. Profile removal must not erase the persisted target. Keeping the unresolved identity makes the
   failure explainable and allows recovery if the profile returns.
7. Authentication identity and continuation storage remain separate. Sharing a continuation store
   is an explicit provider policy, never a side effect of copying an entire home directory.

## Delivery stages

### 1. Routing foundation

- Add typed profile and target identities with legacy `default` compatibility.
- Preserve target identity through model selections, settings, projections, and runtime bindings.
- Make session start, recovery, fork, and first-turn locking compare complete targets.
- Keep executable profiles restricted to `default` until server-owned profile resolution exists.

### 2. Isolated runtime profiles

- Add the typed, redacted server profile registry.
- Resolve immutable launch contexts on the server.
- Isolate Codex authentication and cache state without cloning or symlinking a broad home tree.
- Route discovery, health, text generation, automations, Agent Gateway, images, and recovery by
  complete target.
- Add per-continuation runtime leases and deterministic stop-then-start handoff.

### 3. Product experience

- Add profile management and a separate account picker.
- Explain missing or disabled profiles without silently changing the thread.
- Offer an explicit "Continue with another account" flow that creates a new thread or handoff.
- Verify concurrent accounts, restart recovery, profile removal, authentication rotation, and
  active-writer conflicts end to end.

The old multi-account pull request remains useful as a requirements and failure-case archive. Its
implementation is not a base for these stages.

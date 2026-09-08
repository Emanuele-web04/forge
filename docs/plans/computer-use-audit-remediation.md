# Computer-use audit — core remediation plan

Branch: `computer-use-linux`
Date: 2026-08-21
Status: plan for the backend-agnostic computer-use core.

## Scope and method

This plan covers the shared contracts, server manager and lease, gateway
integration, frame transport, provider approval routing, and web surface. It
does not prescribe a desktop backend. Backend-specific implementation and
provisioning concerns belong with the backend that supplies them.

The security architecture remains approval-gated and capability-leased. The
server must fail closed when a thread has not opted in, a lease is unavailable,
or no computer backend is configured.

## Findings and remediation

| ID  | Severity | Area      | Finding                                                                                  | Remediation                                                                                                                   |
| --- | -------- | --------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| H1  | high     | core      | A fake desktop must never become the production default.                                 | Select `FakeComputerBackend` only for an explicit `SYNARA_COMPUTER_BACKEND=fake`; otherwise use `UnavailableComputerBackend`. |
| M9  | medium   | core      | Backend errors can exceed schema-bounded message fields.                                 | Clamp `lastError` and availability messages before constructing contract payloads.                                            |
| M10 | medium   | gateway   | Provider arguments are not always constrained by runtime schemas.                        | Enforce text, action, hotkey count, and per-item bounds in the gateway before dispatch.                                       |
| L22 | low      | core/web  | Cursor state and the web overlay must agree about whether pointer position is published. | Either publish a backend pointer position consistently or remove the unused state and overlay.                                |
| L23 | low      | web       | Input queue overflow can be invisible to the user.                                       | Surface a transient busy indication when the bounded input queue drops work.                                                  |
| L26 | low      | core      | Some manager errors are recorded without a state publication.                            | Republish error state with bounded, ordered updates.                                                                          |
| L27 | low      | core      | Concurrent state publication needs per-thread ordering.                                  | Serialize publishes per thread and preserve monotonically increasing versions.                                                |
| L28 | low      | transport | Queued frame bytes must obey the same bounded-transport policy as frame count.           | Enforce the byte cap while retaining latest-frame behavior.                                                                   |
| L34 | low      | gateway   | Denial tracking should evict old entries predictably.                                    | Use FIFO eviction at the bounded-cache limit.                                                                                 |
| L35 | low      | contracts | Capability-gating comments must describe the current agent and human paths.              | Keep contract documentation aligned with the gateway lease and authenticated pane split.                                      |

## Verification coverage

Changes to the core should preserve focused tests for:

1. explicit fake-backend selection and safe unavailability;
2. approval and capability checks for every mutating tool;
3. lease claim, takeover, idle expiry, and terminal release;
4. contract-boundary truncation and structured refusal of oversized tool input;
5. frame-route authentication, bounded transport, reconnects, and sequence
   handling;
6. ordered state publication and error propagation;
7. provider approval routing and startup reconciliation of stale interactions;
8. the web panel's opt-in, status, health, and no-backend states.

Each change should include a focused regression test and pass the repository's
format, lint, typecheck, and Vitest checks.

## Verified solid

The following invariants were reviewed and should not regress: mutating tools
are approval-gated; computer control is opt-in and derived from the capability
lease; server checks bind access to the authenticated thread; elicitation
routing fails closed; lease takeover requires staleness and no in-flight
calls; idle expiry is suppressed during a call; terminal paths release the
lease; frame decoding is latest-wins and generation-guarded; and the web
disclosure-motion convention is shared by toggleable regions.

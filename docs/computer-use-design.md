# Computer use

Computer use is a backend-agnostic capability for letting an approved agent
inspect and operate a desktop through Synara. The feature is available to the
fake backend when `SYNARA_COMPUTER_BACKEND=fake`; without an explicitly
configured backend, the server reports that computer use is unavailable.

## Product shape

The web client exposes a Computer panel, a settings status view, and a
per-thread opt-in. The agent receives computer tools only for threads that
have opted in and hold the required capability lease. Human interaction with
the panel remains authenticated and independent of the agent turn.

The computer tool surface is intentionally small:

- inspect the current state and screenshot;
- list and focus windows;
- move the pointer, click, scroll, press keys, type text, and drag;
- read and write clipboard text;
- launch an application when the selected backend supports it.

Mutating operations require approval and are checked again by the server at
dispatch time. Tool descriptions use logical desktop coordinates and bounded
text payloads so providers receive the same contract regardless of backend.

## Architecture

`packages/contracts/src/computer.ts` defines the state, geometry, input, and
capability schemas. `ComputerBackend` is the server-side boundary for desktop
capture, window state, input, and clipboard operations. `ComputerManager`
owns leases, thread state, sequencing, publication, and lifecycle cleanup.

The WebSocket handlers expose the authenticated human-facing computer stream
and state RPCs. Gateway tools use the same manager and lease checks. Frame
transport is bounded, reconnectable, and generation-aware so a stale stream
cannot overwrite a newer one.

## Backends

`FakeComputerBackend` is deterministic and intended for tests and local
harnesses. It is selected only when `SYNARA_COMPUTER_BACKEND=fake`.
`UnavailableComputerBackend` is the safe fallback when no real backend is
configured. It preserves the protocol and UI shape while refusing desktop
operations with a clear unavailable status.

Future backends should implement `ComputerBackend` without changing the
contracts, lease model, approval policy, or web surface.

## Reliability and safety

The manager releases leases and input state during terminal and disconnect
paths. Availability, health, and last-error messages are bounded before they
are placed in contract payloads. State publication is ordered per thread,
and screenshots are treated as replaceable live frames rather than transcript
messages.

Computer control is opt-in per thread, capability-gated, and approval-gated.
The server must continue to fail closed when the provider, lease, backend, or
authenticated browser connection is unavailable.

## Open work

The remaining implementation work is backend-specific. The backend-neutral
core should continue to receive focused tests for contract bounds, lease
handoff, reconnects, frame sequencing, approval routing, and graceful
unavailability.

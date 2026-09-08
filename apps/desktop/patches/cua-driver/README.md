# Synara native Cua revision

`0001-synara-native.patch` applies to the exact upstream commit in
`packages/shared/src/cuaDriverRelease.json`. That manifest pins the patch checksum,
Rust version and native protocol revision. Preserve the upstream license in
`docs/computer-use-cua/CUA-LICENSE.txt`; the original Cua implementation and its
contributor attribution remain intact. This is a local macOS patch, not an
upstream release or a claim of support on other platforms.

The patch closes native input admission irreversibly for one driver process.
Keyboard and mouse guards prepare their matching releases before sending a down
event and release on normal return, failure, cancellation and Rust unwind. A
separate action lease covers native context restoration and verification.
The private `cancel_input` daemon method accepts only the authenticated embedded
parent and the exact child PID. A cleanup acknowledgement requires all registered
inputs and action contexts to finish. Host EOF drains the same gate before
aborting connection tasks. Synara refuses to kill or replace an active generation
when that acknowledgement is absent or invalid.

Pixel clicks and text can select synthetic delivery before dispatch. Clicks use
the native app or Chromium recipe according to process metadata, with one event
transport instead of duplicate SkyLight/CoreGraphics submissions. No uncertain
action is replayed or silently promoted to foreground. The cursor overlay keeps
one replaceable pending bitmap and one queued presentation callback; CoreGraphics
takes ownership of that bitmap without making another full-screen copy.

Revision 2 adds read-only `check_input_ready` for the exact PID/window, with
reviewed authorization and restricted-window grants. Input admission rechecks
window ownership, active Space, visibility and optional observed bounds at native
dispatch boundaries. A Space change invalidates the current action while held
releases and focus restoration drain; it does not retire the driver generation.
Semantic AX actions distinguish pre-dispatch refusal from attempted or uncertain
mutation. A submitted selection/value write never falls through to another
actuator, and exact foreground activation no longer requests all sibling windows.

The gate applies to the SDK tool path admitted by Synara's GUI host. It does not
instrument the separate interactive-worker API. An acknowledgement means native
release events were submitted and action contexts drained; fixture-owned event
counts are the independent evidence that a tested target consumed those releases.
An external SIGKILL, process crash or OS failure cannot be given a cooperative
cleanup guarantee.

Build using `apps/desktop/scripts/provision-cua-driver.mjs --source-checkout
/path/to/cua --arch arm64` (or `x64` / `universal`). The script archives the pinned
commit, so checkout edits do not enter the build, applies the verified patch and
uses Cargo's lockfile. `--offline` uses already-cached dependencies. Without a
source checkout it fetches that commit from the official upstream repository.
Rust and the Apple build tools are build-time dependencies only.

For reuse, `--artifact-dir /path/to/built-directory` verifies the manifest,
pre-signing executable checksum and Mach-O architectures. Desktop packaging can
use the same directory through `SYNARA_CUA_ARTIFACT_DIR`. Signing changes the
executable bytes; the recorded checksum describes the artifact before app signing.
The stock upstream `--archive` path is intentionally rejected because that binary
does not implement the native cancellation revision required by the host.

Current integration verification and limits are recorded in
[`integration-refresh.md`](../../../../docs/computer-use-cua/integration-refresh.md).
[`qualification.md`](../../../../docs/computer-use-cua/qualification.md) records
the historical revision 1 GUI qualification. Revision 2 compilation, pure tests
and control-plane checks do not establish a fresh GUI or RAM qualification.

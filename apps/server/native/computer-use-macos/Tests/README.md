# Native computer-use tests

Run these commands from the repository root on macOS with the Xcode Command Line Tools installed. Test executables and the helper are built into a temporary directory.

## Capture geometry

These assertions cover mixed display scales, negative origins, gaps between displays, and host-window masking. They use synthetic images and do not capture or control the desktop.

```sh
helper_test_dir=$(mktemp -d "${TMPDIR:-/tmp}/synara-computer-tests.XXXXXX")
swiftc \
  apps/server/native/computer-use-macos/Sources/CaptureCanvas.swift \
  apps/server/native/computer-use-macos/Tests/CaptureCanvasTests.swift \
  -o "$helper_test_dir/capture-canvas-tests" -framework AppKit
"$helper_test_dir/capture-canvas-tests"
```

## Helper perception and input

The fallback-history checks run without desktop permissions. They verify that a failed click does not force keyboard input or other windows onto the foreground path, and that old fallback decisions expire:

```sh
helper_test_dir=$(mktemp -d "${TMPDIR:-/tmp}/synara-computer-tests.XXXXXX")
swiftc \
  apps/server/native/computer-use-macos/Sources/InputDeliveryHistory.swift \
  apps/server/native/computer-use-macos/Tests/InputDeliveryHistoryTests.swift \
  -o "$helper_test_dir/input-delivery-history-tests"
"$helper_test_dir/input-delivery-history-tests"
```

The input suite creates and closes its own AppKit fixture applications. It verifies ownership of target windows before sending input. It exercises hover, routing between overlapping windows, cancellation of a long drag with button release, menu actions, interruption when another fixture app becomes active, and clearing keyboard aim. It temporarily changes foreground application and window focus, so run it on a desktop available for testing.

The test process needs the macOS Accessibility and Screen Recording grants required by the helper. A development run does not validate permission handling in an installed, signed Synara build.

```sh
helper_test_dir=$(mktemp -d "${TMPDIR:-/tmp}/synara-computer-tests.XXXXXX")
bash apps/server/native/computer-use-macos/build.sh "$helper_test_dir"
swiftc apps/server/native/computer-use-macos/Tests/InputFixture.swift \
  -o "$helper_test_dir/input-fixture" -framework AppKit

SYNARA_MAC_INPUT_TEST=1 \
SYNARA_MAC_HELPER_TEST=1 \
SYNARA_MAC_HELPER_BINARY="$helper_test_dir/synara-computer-helper" \
SYNARA_MAC_INPUT_FIXTURE="$helper_test_dir/input-fixture" \
  bun run --cwd apps/server test \
    src/computer/macComputerInput.integration.test.ts \
    src/computer/macComputerHelper.integration.test.ts
```

To run perception alone, omit `SYNARA_MAC_INPUT_TEST`, `SYNARA_MAC_INPUT_FIXTURE` and the input test file. The perception suite never sends input; unavailable platform capabilities or grants may skip individual checks. The input suite is opt-in and excluded from ordinary runs unless explicitly enabled.

These checks complement the normal server, gateway, provider and web tests. They do not replace installed-build tests for TCC denial/revocation, signed helper updates, real multi-display hot-plugging, multiple Spaces, or end-to-end tasks with actual vision models.

## Performance regression coverage

The perception suite also requests a deduplicated still and then forces another full PNG. A changing real desktop may produce a new image on every request, so the test accepts either a changed image or an explicit `unchanged` response for ordinary polls. Forced requests must always include a decodable PNG.

The backend and publisher tests exercise unchanged replies, force propagation on attachment and reattachment, independent action captures, and reuse of authoritative native window geometry. Run them without desktop permissions:

```sh
bun run --cwd apps/server test src/computer/MacComputerBackend.test.ts src/computer/stillFramePublisher.test.ts
```

The performance changes were developed on Linux, where AppKit, ScreenCaptureKit, CryptoKit and the native Swift compiler were unavailable. Passing TypeScript tests does not establish native compilation or delivery timing. Run the native build and opt-in suites above on macOS before claiming those checks passed. Still requests continue capturing and hashing pixels at the normal cadence, usually twice a second; unchanged frames skip PNG encoding, base64 and stdio transport. This does not imply zero idle capture CPU. Use a static desktop to measure idle still encoding, a multi-display desktop to measure capture concurrency, and native plus Chromium text fields to check insertion fallback. The physical-key fallback retains its original pacing and per-event focus checks.

## Space-change cancellation

This test uses no desktop input. It checks cancellation of running and queued actions,
continued perception, and acceptance of new requests after the transition.

```sh
helper_test_dir=$(mktemp -d "${TMPDIR:-/tmp}/synara-space-tests.XXXXXX")
swiftc apps/server/native/computer-use-macos/Sources/JSONRPC.swift \
  apps/server/native/computer-use-macos/Sources/Cancellation.swift \
  apps/server/native/computer-use-macos/Tests/InputCancellationTests.swift \
  -o "$helper_test_dir/cancellation"
"$helper_test_dir/cancellation"
```

Live Space testing must monitor both `didActivateApplicationNotification` and
`activeSpaceDidChangeNotification`. App activation alone misses Space switches.
Never switch the user's Space to reproduce a bug. Off-Space native input must
return helper error -32015 without focus writes or event injection; screenshots
remain available. A Space change during a gesture cancels further input, but
release events still clean up held keys/buttons. Do not automatically replay a
partially completed gesture.

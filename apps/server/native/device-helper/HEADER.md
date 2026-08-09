# synara-device-helper

The native side of Synara's Device Pane: a macOS program that mirrors and drives
a booted iOS Simulator without `Simulator.app`, using CoreSimulator and
SimulatorKit private APIs.

Source ships in-repo and is compiled on the user's machine with their own Xcode
(`build.sh`), because the private API surface moves with the toolchain. Cache the
binary keyed by Xcode build version (`xcodebuild -version`), as
`scripts/device-helper-smoke.ts` does under
`~/Library/Caches/synara/device-helper/<build>/`.

## Design choices

**Long-running JSON-RPC server, not subcommands.** Attaching to CoreSimulator,
creating the HID client and priming the accessibility translator each cost real
time and are all per-process state. A subcommand design would repay that on
every tap. `--probe` is the one exception: a one-shot preflight for the build and
for the pane's setup checklist.

**Frames leave over a Unix socket, not stdout.** Video and RPC never share a
pipe, so a burst of frames cannot delay a command response. This is the core of
the "must never starve RPC" requirement.

**Private frameworks are `dlopen`'d at runtime**, resolved from `xcode-select -p`
(or `DEVELOPER_DIR`). Nothing is linked at build time, so the binary is
relocatable and a moved/upgraded Xcode produces a diagnosable error rather than a
dyld crash.

**The Objective-C bridges must be compiled with ARC.** `swiftc` hands `.m` files
to clang _without_ `-fobjc-arc`; under manual retain/release the accessibility
translator's response is released underneath it and `describe-ui` segfaults in
`objc_retain`. `build.sh` compiles them separately with `-fobjc-arc` and links
the objects.

## Protocol

Newline-delimited JSON-RPC 2.0 on stdio: one object per line, requests on stdin,
responses and notifications on stdout. Diagnostics go to stderr and never mix
into the protocol stream.

On start the helper emits `{"jsonrpc":"2.0","method":"ready","params":{"protocolVersion":1,...}}`.

### Methods

| Method           | Params                                                  | Result                                                                    |
| ---------------- | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| `ping`           | –                                                       | `{ok, pid}`                                                               |
| `list`           | –                                                       | `{devices: [{udid, name, state, booted, runtime, deviceType}]}`           |
| `attach`         | `udid`                                                  | display geometry + `capabilities` (below)                                 |
| `stream.start`   | `socketPath`, `keyframeIntervalSeconds?` (2.0)          | `{pixelWidth, pixelHeight, codec, socketPath}`                            |
| `stream.stop`    | –                                                       | `{running: false, emittedFrames, droppedBusyFrames, droppedSocketFrames}` |
| `stream.stats`   | –                                                       | as above, plus `running: true` while streaming                            |
| `tap`            | `x`, `y`, `holdMs?` (80)                                | `{ok}`                                                                    |
| `touch`          | `phase` (`down`\|`move`\|`up`), `x`, `y`                | `{ok}`                                                                    |
| `swipe` / `drag` | `startX`, `startY`, `endX`, `endY`, `durationMs?` (250) | `{ok}`                                                                    |
| `key`            | `usage` (USB HID), `phase?` (`down`\|`up`; omit to tap) | `{ok}`                                                                    |
| `text`           | `text`                                                  | `{ok, characters, skipped}`                                               |
| `button`         | `name`, `phase?`                                        | `{ok}`                                                                    |
| `screenshot`     | `path?`                                                 | `{path, bytes}` or `{base64, bytes}`                                      |
| `describe-ui`    | `maxDepth?` (40)                                        | `{tree}`                                                                  |

All coordinates are **normalized 0..1** with the origin at the top-left.
Out-of-range values are rejected rather than clamped, because they nearly always
mean the caller sent pixels by mistake.

`attach` reports `capabilities: {input, accessibility}` and `degraded: {hid}`. A
simulator whose HID client fails still streams and reads: input is degraded, not
fatal.

Buttons: `home`, `lock`, `side`, `siri`, `volume-up`, `volume-down`.

**Rotation is not a HID button.** The simulator exposes no rotation button over
Indigo, so orientation changes are not part of this protocol; drive them at the
UI level (`xcrun simctl` / the device's own controls). Documented here because
the absence is a deliberate choice, not an oversight.

### Errors

Standard JSON-RPC codes, plus `-32000` (not attached) and `-32001` (simulator
failure).

## Frame wire format

Frames are written to the Unix socket given to `stream.start`, each as:

```
u32 little-endian length, then that many bytes of envelope
```

The envelope is the contract defined in `packages/contracts/src/device.ts` and
decoded by `packages/shared/src/deviceFrame.ts`. Little-endian throughout:

```
0   u16  magic     0x5346
2   u8   version   1
3   u8   flags     bit 0 = keyframe, bit 1 = codec config (SPS/PPS)
4   u32  sequence  per device, wraps at 2^32; gaps mean dropped frames
8   f64  timestampMs  helper capture clock
16  u8   deviceId byte length
17  ..   deviceId (UTF-8)
..       payload
```

Payload is H.264 in **Annex B** (4-byte start codes) — VideoToolbox emits AVCC
and the helper rewrites the length prefixes, because `VideoDecoder` in the
browser wants Annex B. Parameter sets are sent as their own `codecConfig`
message immediately before each keyframe, so a keyframe is always decodable
alongside the SPS/PPS that precede it.

Encoding is H.264 Baseline, realtime, no frame reordering, with a forced
keyframe roughly every `keyframeIntervalSeconds`.

### Backpressure

Two independent drop points, both deliberate:

- **Encoder**: a new frame arriving while an encode is in flight is dropped
  (`droppedBusyFrames`). Only the newest frame matters for a live mirror.
- **Socket writer**: above a ~4 MB backlog frames are shed rather than queued
  (`droppedSocketFrames`). A consumer that is not draining gets stale frames
  dropped instead of unbounded memory growth.

Frames only arrive when the display changes: the simulator posts a damage
callback, so an idle screen legitimately produces no frames. Anything driving
the stream (including the smoke test) must cause on-screen motion.

## Fidelity notes

`describe-ui` is the **full** accessibility tree via `AXPTranslator` and
`SimDevice.sendAccessibilityRequestAsync` — the same path idb uses — not a
reduced SimulatorKit dump. Each node carries `role` (AX-prefix stripped),
`label`, `value`, `identifier`, `title`, `frame` (x/y/width/height in points),
`enabled` and `children`. Depth is capped (`maxDepth`, default 40) and a capped
node is marked `truncated: true`, so a pathological hierarchy still returns.

`text` maps printable ASCII to HID usages with shift. Characters with no mapping
(emoji, most non-ASCII) are skipped and counted in `skipped` rather than failing
the call.

## Testing

`bun run test:device` (`scripts/device-helper-smoke.ts`) compiles the helper,
boots or reuses a simulator, streams ≥30 frames asserting keyframe and Annex B
NAL structure, injects a tap, dumps the accessibility tree, verifies PNG magic on
a screenshot, and shuts down only a simulator it booted itself.

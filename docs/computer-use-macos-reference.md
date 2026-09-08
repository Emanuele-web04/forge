# macOS computer control

Synara lets a vision-capable model inspect and operate applications on the Mac running its server. Computer tools are enabled by default in conversations through the shared provider integration, so the agent can call them when needed. The model must support images and tool calls through its Synara provider. Users can turn Computer control off for a conversation or change the default in Settings → Computer use. Existing saved choices are preserved. macOS permissions and the conversation's approval mode still apply.

This operates the real desktop. A separate agent cursor shows its target. Supported applications accept input in the background; others need to be brought forward, which is reported in the activity display. Stop cancels the owning turn and releases computer control, including while the model is thinking between tool calls. Only one conversation owns desktop input at a time.

## Setup

Open Settings → Computer use and choose Set up when prompted. Allow Accessibility and Screen Recording in macOS System Settings → Privacy & Security. A transcript setup card names missing permissions and refreshes as access becomes available. Packaged releases include the helper; Xcode is only needed for source builds and CLI installations that compile it locally.

The Mac must have a logged-in graphical session. A remote browser controls the desktop of the server host. Windows and Linux hosts without their own backend report unavailable computer control.

After a locally built, ad-hoc signed app changes, macOS can retain an obsolete permission entry. Follow the setup guidance for that build's application identity and grant access again. Do not reset another installed Synara flavor's permissions. Release signing is owned by upstream; contributors do not need release credentials to build, test, or submit this change.

## Development and tests

The architecture and wire protocol are documented in [the native helper reference](../apps/server/native/computer-use-macos/HEADER.md). [Native test instructions](../apps/server/native/computer-use-macos/Tests/README.md) cover synthetic multi-display geometry, real helper perception, and input against temporary fixture applications.

Use a separate Synara home and non-default ports when testing beside an installed copy. Point `SYNARA_COMPUTER_HELPER_BINARY_PATH` at a built helper to test that artifact. `SYNARA_COMPUTER_HELPER_SOURCE_DIR` selects source files for development compilation. `SYNARA_COMPUTER_BACKEND=fake` is for automated tests only; it does not drive macOS.

### Local installer validation

Use the repository's supported Node 24 runtime. After building the desktop, validate the macOS artifact with the same update-repository metadata that upstream CI supplies:

```sh
bun run build:desktop
SYNARA_DESKTOP_UPDATE_REPOSITORY=Emanuele-web04/synara \
  bun run dist:desktop:artifact -- --platform mac --target dmg --arch arm64 \
    --skip-build --output-dir /tmp/synara-local-artifacts
```

Use `--arch x64` for Intel builds. This command ad-hoc signs the complete app and its helper without a certificate and does not publish a release. The outer app must have a valid signature too: macOS attributes the helper's privacy requests to Synara. Packaging verifies the complete app before archiving and after ZIP extraction. The update-repository setting generates the updater manifests required by the artifact checks; without it (or `--mock-updates`), a local build has no updater manifest to validate. Developer ID signing and notarization remain upstream release checks.

## Release qualification

The UI retains a Beta label. Private SkyLight interfaces and application-specific input behavior require qualification beyond unit tests. The binary targets macOS 12.3; ScreenCaptureKit screenshot APIs require macOS 14 and have a fallback below that version. Compilation for a deployment target does not establish that an OS version is supported in production.

Before declaring a release qualified, upstream should record results for:

- Developer ID signing, hardened runtime, final notarization and stapling of the app and DMG; verify the nested helper has the expected identity and no Electron entitlements.
- Installation and helper startup on the oldest advertised macOS version and the current release, on both advertised CPU architectures.
- Fresh grants, denial, revocation/regrant, and permission persistence after upgrading a signed build.
- Actual mixed-scale displays, negative display origins, display hot-plugging, multiple Spaces and full-screen applications.
- Complete screenshot/action tasks through each advertised vision-model provider, including approvals, Stop during input and between calls, provider reconnect and application exit.
- Background input in AppKit and Chromium applications, foreground fallback in an application that requires it, and immediate hand-back when the user switches applications.

The contributor's local validation report should distinguish real native checks, deterministic simulations, skipped cases and release checks awaiting upstream. Do not infer signed-build or hardware-matrix coverage from an ad-hoc build on one Mac.

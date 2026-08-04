#!/bin/bash
# Compiles synara-device-helper with the user's own Xcode toolchain.
#
# Everything is resolved through `xcrun`, and no private framework is linked at
# build time (they are dlopen'd at runtime), so the output binary is relocatable
# and does not embed absolute toolchain paths.
#
# Usage:
#   build.sh [output-directory]
#   SYNARA_DEVICE_HELPER_OUT=/path build.sh
#
# Defaults to ./build next to this script.

set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${1:-${SYNARA_DEVICE_HELPER_OUT:-$SOURCE_DIR/build}}"
BINARY_NAME="synara-device-helper"

if ! command -v xcrun >/dev/null 2>&1; then
  echo "error: xcrun not found; install the Xcode command line tools" >&2
  exit 1
fi

# A full Xcode is required, not just the CLI tools: SimulatorKit ships inside the
# Xcode bundle and CoreSimulator is only usable alongside it.
# DEVELOPER_DIR wins over the machine-wide selection: that is how a beta Xcode
# is targeted without moving every other build on the machine onto it. The
# server exports it for this script, so both agree on one toolchain.
DEVELOPER_DIR_PATH="${DEVELOPER_DIR:-}"
if [ -z "$DEVELOPER_DIR_PATH" ]; then
  DEVELOPER_DIR_PATH="$(xcode-select -p 2>/dev/null || true)"
fi
if [ -z "$DEVELOPER_DIR_PATH" ]; then
  echo "error: no active developer directory; run 'sudo xcode-select -s /Applications/Xcode.app'" >&2
  exit 1
fi
if [ ! -d "$DEVELOPER_DIR_PATH/Library/PrivateFrameworks/SimulatorKit.framework" ]; then
  echo "error: SimulatorKit not found under $DEVELOPER_DIR_PATH" >&2
  echo "       point xcode-select at a full Xcode install, not the command line tools" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
OUT_BINARY="$OUT_DIR/$BINARY_NAME"

# Compiled to a temporary path and moved into place so a concurrent build (or a
# running helper holding the old binary open) never sees a half-written file.
TMP_BINARY="$(mktemp "${OUT_DIR}/.${BINARY_NAME}.XXXXXX")"
trap 'rm -f "$TMP_BINARY"' EXIT

TARGET_TRIPLE="$(uname -m)-apple-macosx13.0"

# The Objective-C sources are compiled separately so they can be built with ARC.
# swiftc hands .m files to clang without -fobjc-arc, which would leave the
# accessibility bridge under manual retain/release and crash on the first
# translator response.
OBJC_OBJECTS=()
for source in "$SOURCE_DIR/Sources/AXBridge.m" "$SOURCE_DIR/Sources/HIDBridge.m"; do
  object="$OUT_DIR/$(basename "${source%.m}").o"
  xcrun clang \
    -c \
    -fobjc-arc \
    -O2 \
    -fmodules \
    -target "$TARGET_TRIPLE" \
    "$source" \
    -o "$object"
  OBJC_OBJECTS+=("$object")
done

xcrun swiftc \
  -O \
  -whole-module-optimization \
  -swift-version 5 \
  -target "$TARGET_TRIPLE" \
  -import-objc-header "$SOURCE_DIR/Sources/DeviceHelper-Bridging-Header.h" \
  -framework Foundation \
  -framework AppKit \
  -framework CoreGraphics \
  -framework CoreImage \
  -framework CoreMedia \
  -framework CoreVideo \
  -framework ImageIO \
  -framework IOSurface \
  -framework VideoToolbox \
  "${OBJC_OBJECTS[@]}" \
  "$SOURCE_DIR/Sources/SymbolManifest.swift" \
  "$SOURCE_DIR/Sources/CapabilityProbe.swift" \
  "$SOURCE_DIR/Sources/CoreSimulatorBridge.swift" \
  "$SOURCE_DIR/Sources/FrameStream.swift" \
  "$SOURCE_DIR/Sources/Screenshot.swift" \
  "$SOURCE_DIR/Sources/main.swift" \
  -o "$TMP_BINARY"

chmod +x "$TMP_BINARY"
mv -f "$TMP_BINARY" "$OUT_BINARY"
trap - EXIT

echo "$OUT_BINARY"

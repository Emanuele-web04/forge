import { describe, expect, it } from "vitest";

import {
  DEVICE_HELPER_BINARY_NAME,
  DEVICE_HELPER_CACHE_SEGMENTS,
  deviceHelperCacheKey,
  deviceHelperSourceRevision,
} from "./deviceHelperCache";

const XCODEBUILD_OUTPUT = "Xcode 26.2\nBuild version 17C52";

describe("device helper cache key", () => {
  it("combines the marketing version and the build number", () => {
    expect(deviceHelperCacheKey(XCODEBUILD_OUTPUT)).toBe("26.2-17C52");
  });

  it("tolerates surrounding whitespace and trailing newlines", () => {
    expect(deviceHelperCacheKey("  Xcode 26.2  \n  Build version 17C52  \n")).toBe("26.2-17C52");
  });

  it("changes when the toolchain changes", () => {
    // The whole point of the key: a helper built against one Xcode must never
    // be reused after an upgrade, because it links private frameworks.
    const first = deviceHelperCacheKey(XCODEBUILD_OUTPUT);
    expect(deviceHelperCacheKey("Xcode 26.3\nBuild version 17D10")).not.toBe(first);
    expect(deviceHelperCacheKey("Xcode 26.2\nBuild version 17C60")).not.toBe(first);
  });

  it("still produces a key when only one field is recognizable", () => {
    expect(deviceHelperCacheKey("Xcode 26.2")).toBe("26.2-unknown");
    expect(deviceHelperCacheKey("Build version 17C52")).toBe("unknown-17C52");
  });

  it("returns null rather than caching under a garbage key", () => {
    expect(deviceHelperCacheKey("")).toBeNull();
    expect(
      deviceHelperCacheKey("xcode-select: error: tool 'xcodebuild' requires Xcode"),
    ).toBeNull();
  });

  it("changes when the helper's own sources change", () => {
    // Without this the cache never invalidates on a helper fix: the toolchain
    // is identical, so every existing user keeps running the binary they
    // already built and the fix silently never reaches them.
    const before = deviceHelperSourceRevision([{ name: "HIDBridge.m", contents: "volume = 0x2;" }]);
    const after = deviceHelperSourceRevision([{ name: "HIDBridge.m", contents: "volume = 0xe9;" }]);
    expect(after).not.toBe(before);
    expect(deviceHelperCacheKey(XCODEBUILD_OUTPUT, after)).not.toBe(
      deviceHelperCacheKey(XCODEBUILD_OUTPUT, before),
    );
  });

  it("treats a rename as a change, and file order as irrelevant", () => {
    const a = [
      { name: "A.swift", contents: "x" },
      { name: "B.swift", contents: "y" },
    ];
    // Same tree, listed the other way round: readdir order must not shift the key.
    expect(deviceHelperSourceRevision([...a].reverse())).toBe(deviceHelperSourceRevision(a));
    // A rename with identical contents is still a different build.
    expect(
      deviceHelperSourceRevision([
        { name: "A.swift", contents: "x" },
        { name: "Renamed.swift", contents: "y" },
      ]),
    ).not.toBe(deviceHelperSourceRevision(a));
  });

  it("keys on the toolchain alone when the sources cannot be read", () => {
    // Falling back beats failing the attach outright.
    expect(deviceHelperCacheKey(XCODEBUILD_OUTPUT, undefined)).toBe("26.2-17C52");
  });

  it("pins the cache location both callers build from", () => {
    // The server and scripts/device-helper-smoke.ts must agree on this path or
    // a passing smoke run populates a directory the server never reads.
    expect([...DEVICE_HELPER_CACHE_SEGMENTS]).toEqual([
      "Library",
      "Caches",
      "synara",
      "device-helper",
    ]);
    expect(DEVICE_HELPER_BINARY_NAME).toBe("synara-device-helper");
  });
});

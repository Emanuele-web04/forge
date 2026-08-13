import { describe, expect, it } from "vitest";

import {
  bundleSignatureFromStats,
  isBundleStable,
  isBundleSwapped,
  isWatchableBundlePath,
  type BundleSignature,
} from "./bundleSwapDetection";

const baseline: BundleSignature = { size: 100, mtimeMs: 1_000, inode: 42 };

describe("bundleSignatureFromStats", () => {
  it("captures size, mtime, and inode", () => {
    expect(bundleSignatureFromStats({ size: 7, mtimeMs: 8, ino: 9 })).toEqual({
      size: 7,
      mtimeMs: 8,
      inode: 9,
    });
  });
});

describe("isWatchableBundlePath", () => {
  it("accepts a packaged asar app path", () => {
    expect(isWatchableBundlePath("/Applications/Synara.app/Contents/Resources/app.asar")).toBe(
      true,
    );
  });

  it("rejects an unpackaged directory app path", () => {
    expect(isWatchableBundlePath("/Users/me/dev/synara/apps/desktop")).toBe(false);
  });
});

describe("isBundleSwapped", () => {
  it("reports no swap for an identical signature", () => {
    expect(isBundleSwapped(baseline, { ...baseline })).toBe(false);
  });

  it("treats a transiently unreadable archive as not-yet-swapped", () => {
    expect(isBundleSwapped(baseline, null)).toBe(false);
  });

  it.each([
    ["size", { ...baseline, size: 101 }],
    ["mtime", { ...baseline, mtimeMs: 2_000 }],
    ["inode", { ...baseline, inode: 43 }],
  ])("detects a swap when %s changes", (_dimension, current) => {
    expect(isBundleSwapped(baseline, current)).toBe(true);
  });

  it("detects the archive reappearing with a new identity after a transient gap", () => {
    expect(isBundleSwapped(baseline, null)).toBe(false);
    expect(isBundleSwapped(baseline, { size: 100, mtimeMs: 1_000, inode: 77 })).toBe(true);
  });
});

describe("isBundleStable", () => {
  it("accepts an unchanged readable archive", () => {
    expect(isBundleStable(baseline, { ...baseline })).toBe(true);
  });

  it("rejects an unreadable archive because snapshot integrity is unknown", () => {
    expect(isBundleStable(baseline, null)).toBe(false);
  });

  it("rejects a changed archive", () => {
    expect(isBundleStable(baseline, { ...baseline, inode: 99 })).toBe(false);
  });
});

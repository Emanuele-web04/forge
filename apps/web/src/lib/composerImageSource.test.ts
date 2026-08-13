import { describe, expect, it } from "vitest";

import {
  normalizeComposerImageSource,
  toPersistedComposerImageSource,
} from "./composerImageSource";

describe("normalizeComposerImageSource", () => {
  it("preserves valid AppSnap provenance", () => {
    expect(
      normalizeComposerImageSource({
        kind: "appsnap",
        captureId: "capture-1",
        capturedAt: "2026-07-12T19:59:33.000Z",
        appName: "Safari",
        bundleIdentifier: "com.apple.Safari",
        appIconDataUrl: "data:image/png;base64,aWNvbg==",
        windowTitle: "Synara",
      }),
    ).toEqual({
      kind: "appsnap",
      captureId: "capture-1",
      capturedAt: "2026-07-12T19:59:33.000Z",
      appName: "Safari",
      bundleIdentifier: "com.apple.Safari",
      appIconDataUrl: "data:image/png;base64,aWNvbg==",
      windowTitle: "Synara",
    });
  });

  it("normalizes absent optional labels and rejects incomplete provenance", () => {
    expect(
      normalizeComposerImageSource({
        kind: "appsnap",
        captureId: "capture-2",
        capturedAt: "2026-07-12T20:00:00.000Z",
      }),
    ).toMatchObject({
      appName: null,
      bundleIdentifier: null,
      appIconDataUrl: null,
      windowTitle: null,
    });
    expect(normalizeComposerImageSource({ kind: "appsnap", captureId: "" })).toBeUndefined();
  });

  it("migrates the former provenance discriminator", () => {
    expect(
      normalizeComposerImageSource({
        kind: "appshot",
        captureId: "capture-legacy",
        capturedAt: "2026-07-12T20:00:00.000Z",
      }),
    ).toMatchObject({ kind: "appsnap", captureId: "capture-legacy" });
  });

  it("rejects non-PNG or oversized app icon payloads", () => {
    expect(
      normalizeComposerImageSource({
        kind: "appsnap",
        captureId: "capture-icon",
        capturedAt: "2026-07-12T20:00:00.000Z",
        appIconDataUrl: "https://example.com/icon.png",
      }),
    ).toMatchObject({ appIconDataUrl: null });
  });

  it("keeps inline app icons out of persisted composer metadata", () => {
    expect(
      toPersistedComposerImageSource({
        kind: "appsnap",
        captureId: "capture-icon",
        capturedAt: "2026-07-12T20:00:00.000Z",
        appName: "Safari",
        bundleIdentifier: "com.apple.Safari",
        appIconDataUrl: "data:image/png;base64,aWNvbg==",
        windowTitle: "Synara",
      }),
    ).toEqual({
      kind: "appsnap",
      captureId: "capture-icon",
      capturedAt: "2026-07-12T20:00:00.000Z",
      appName: "Safari",
      bundleIdentifier: "com.apple.Safari",
      windowTitle: "Synara",
    });
  });
});

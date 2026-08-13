// FILE: mediaPermissions.test.ts
// Purpose: Verifies the desktop microphone permission guard stays tolerant of optional Electron fields.
// Layer: Desktop unit test
// Depends on: mediaPermissions helper.

import { describe, expect, it } from "vitest";

import {
  isTrustedMediaPermissionRequest,
  shouldAllowMediaPermissionRequest,
} from "./mediaPermissions";

describe("shouldAllowMediaPermissionRequest", () => {
  it("allows requests when Electron omits mediaTypes", () => {
    expect(shouldAllowMediaPermissionRequest({})).toBe(true);
  });

  it("allows requests when Electron reports audio capture", () => {
    expect(shouldAllowMediaPermissionRequest({ mediaTypes: ["audio"] })).toBe(true);
  });

  it("rejects requests that only ask for video capture", () => {
    expect(shouldAllowMediaPermissionRequest({ mediaTypes: ["video"] })).toBe(false);
  });

  it("rejects mixed audio and video capture", () => {
    expect(shouldAllowMediaPermissionRequest({ mediaTypes: ["audio", "video"] })).toBe(false);
  });

  it("handles Electron permission checks that report one mediaType", () => {
    expect(shouldAllowMediaPermissionRequest({ mediaType: "audio" })).toBe(true);
    expect(shouldAllowMediaPermissionRequest({ mediaType: "video" })).toBe(false);
    expect(shouldAllowMediaPermissionRequest({ mediaType: "unknown" })).toBe(false);
  });
});

describe("isTrustedMediaPermissionRequest", () => {
  const requester = (destroyed = false) => ({ isDestroyed: () => destroyed });

  it("allows microphone capture only from the exact trusted live renderer", () => {
    const trusted = requester();

    expect(isTrustedMediaPermissionRequest(trusted, trusted, { mediaTypes: ["audio"] })).toBe(true);
    expect(isTrustedMediaPermissionRequest(requester(), trusted, { mediaTypes: ["audio"] })).toBe(
      false,
    );
    expect(isTrustedMediaPermissionRequest(null, trusted, { mediaTypes: ["audio"] })).toBe(false);
  });

  it("rejects destroyed renderers and browser content without a trusted renderer", () => {
    const destroyed = requester(true);

    expect(isTrustedMediaPermissionRequest(destroyed, destroyed, { mediaTypes: ["audio"] })).toBe(
      false,
    );
    expect(isTrustedMediaPermissionRequest(requester(), null, { mediaTypes: ["audio"] })).toBe(
      false,
    );
  });

  it("rejects subframes and origins other than the live Synara renderer", () => {
    const trusted = {
      isDestroyed: () => false,
      getURL: () => "synara://app/index.html",
    };

    expect(
      isTrustedMediaPermissionRequest(trusted, trusted, {
        mediaTypes: ["audio"],
        isMainFrame: true,
        requestingUrl: "synara://app/chat",
      }),
    ).toBe(true);
    expect(
      isTrustedMediaPermissionRequest(trusted, trusted, {
        mediaTypes: ["audio"],
        isMainFrame: false,
        requestingUrl: "https://untrusted.example/embed",
      }),
    ).toBe(false);
    expect(
      isTrustedMediaPermissionRequest(trusted, trusted, {
        mediaTypes: ["audio"],
        isMainFrame: true,
        requestingUrl: "https://untrusted.example/",
      }),
    ).toBe(false);
    expect(
      isTrustedMediaPermissionRequest(
        trusted,
        trusted,
        { mediaType: "audio", isMainFrame: true },
        "https://untrusted.example",
      ),
    ).toBe(false);
  });
});

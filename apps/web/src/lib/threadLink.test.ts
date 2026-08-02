import { afterEach, describe, expect, it, vi } from "vitest";

import { buildThreadLinkUrl } from "./threadLink";

const originalWindow = globalThis.window;

afterEach(() => {
  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
  } else {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("buildThreadLinkUrl", () => {
  it("builds an origin-relative thread URL in the browser", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "http://127.0.0.1:58090" },
        desktopBridge: undefined,
      },
    });

    expect(buildThreadLinkUrl("abc-123")).toBe("http://127.0.0.1:58090/abc-123");
  });

  it("uses the desktop WebSocket host so the link opens in Chrome", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "synara://app" },
        desktopBridge: {
          getWsUrl: () => "ws://127.0.0.1:42489/?token=secret-token",
        },
      },
    });

    expect(buildThreadLinkUrl("thread-1")).toBe(
      "http://127.0.0.1:42489/thread-1?token=secret-token",
    );
  });

  it("rejects an empty thread id", () => {
    expect(() => buildThreadLinkUrl("  ")).toThrow("Thread id is required.");
  });
});

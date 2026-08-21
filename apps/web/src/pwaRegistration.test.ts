import { describe, expect, it, vi } from "vitest";

import { registerPwaServiceWorker, shouldRegisterPwaServiceWorker } from "./pwaRegistration";

const eligibleRuntime = {
  isProduction: true,
  isElectron: false,
  isSecureContext: true,
  serviceWorkerSupported: true,
};

describe("PWA service-worker registration", () => {
  it("registers only in a secure production browser", () => {
    expect(shouldRegisterPwaServiceWorker(eligibleRuntime)).toBe(true);
    expect(shouldRegisterPwaServiceWorker({ ...eligibleRuntime, isProduction: false })).toBe(false);
    expect(shouldRegisterPwaServiceWorker({ ...eligibleRuntime, isElectron: true })).toBe(false);
    expect(shouldRegisterPwaServiceWorker({ ...eligibleRuntime, isSecureContext: false })).toBe(
      false,
    );
    expect(
      shouldRegisterPwaServiceWorker({ ...eligibleRuntime, serviceWorkerSupported: false }),
    ).toBe(false);
  });

  it("waits for page load and asks the browser to bypass HTTP caches for updates", () => {
    const register = vi.fn(() => Promise.resolve());
    let onLoad: (() => void) | undefined;

    expect(
      registerPwaServiceWorker({
        ...eligibleRuntime,
        documentReadyState: "interactive",
        onWindowLoad: (callback) => {
          onLoad = callback;
        },
        register,
      }),
    ).toBe(true);
    expect(register).not.toHaveBeenCalled();

    onLoad?.();
    expect(register).toHaveBeenCalledWith(expect.stringMatching(/^\/service-worker\.js\?v=/), {
      scope: "/",
      updateViaCache: "none",
    });
  });
});

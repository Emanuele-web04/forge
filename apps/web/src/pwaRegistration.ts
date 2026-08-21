// Registers the installable WebUI only in a production browser. Electron owns
// its own application lifecycle, and development builds must never retain a
// service worker that can hide fresh Vite output.

import { APP_VERSION } from "./branding";
import { isElectron } from "./env";

interface PwaRegistrationRuntime {
  readonly isProduction: boolean;
  readonly isElectron: boolean;
  readonly isSecureContext: boolean;
  readonly serviceWorkerSupported: boolean;
  readonly documentReadyState: DocumentReadyState;
  readonly onWindowLoad: (callback: () => void) => void;
  readonly register: (scriptUrl: string, options: RegistrationOptions) => Promise<unknown>;
}

export function shouldRegisterPwaServiceWorker(
  runtime: Pick<
    PwaRegistrationRuntime,
    "isProduction" | "isElectron" | "isSecureContext" | "serviceWorkerSupported"
  >,
): boolean {
  return (
    runtime.isProduction &&
    !runtime.isElectron &&
    runtime.isSecureContext &&
    runtime.serviceWorkerSupported
  );
}

function browserRuntime(): PwaRegistrationRuntime | null {
  if (typeof window === "undefined" || typeof navigator === "undefined") return null;

  return {
    isProduction: import.meta.env.PROD,
    isElectron,
    isSecureContext: window.isSecureContext,
    serviceWorkerSupported: "serviceWorker" in navigator,
    documentReadyState: document.readyState,
    onWindowLoad: (callback) => window.addEventListener("load", callback, { once: true }),
    register: (scriptUrl, options) => navigator.serviceWorker.register(scriptUrl, options),
  };
}

export function registerPwaServiceWorker(
  runtime: PwaRegistrationRuntime | null = browserRuntime(),
): boolean {
  if (!runtime || !shouldRegisterPwaServiceWorker(runtime)) return false;

  const register = () => {
    void runtime
      .register(`/service-worker.js?v=${encodeURIComponent(APP_VERSION)}`, {
        scope: "/",
        updateViaCache: "none",
      })
      // Service-worker availability must not prevent the live WebUI from opening.
      .catch(() => undefined);
  };

  if (runtime.documentReadyState === "complete") {
    register();
  } else {
    runtime.onWindowLoad(register);
  }
  return true;
}

import { Effect, Layer } from "effect";

import {
  BrowserAutomationHost,
  type BrowserAutomationHostShape,
} from "../Services/BrowserAutomationHost.ts";
import {
  BrowserHostRpcError,
  callBrowserHostTool,
  resolveBrowserHostCapability,
  resolveBrowserHostPipePath,
} from "../browserHostRpcClient.ts";

export function makeBrowserAutomationHost(
  env: NodeJS.ProcessEnv = process.env,
): BrowserAutomationHostShape {
  const pipePath = resolveBrowserHostPipePath(env);
  const capability = resolveBrowserHostCapability(env);
  if (env.SYNARA_MODE === "desktop" && (!pipePath || !capability)) {
    console.warn("[browser-host] Desktop browser transport is unavailable", {
      pipeConfigured: pipePath !== null,
      capabilityLoaded: capability !== null,
    });
  }
  return {
    available: pipePath !== null && capability !== null,
    execute: (input) => {
      if (!pipePath || !capability) {
        return Effect.fail(
          new BrowserHostRpcError(
            "unavailable",
            "The visible Synara browser is only available in the desktop app.",
          ),
        );
      }
      return Effect.tryPromise({
        try: (signal) => callBrowserHostTool({ ...input, pipePath, capability, signal }),
        catch: (error) =>
          error instanceof BrowserHostRpcError
            ? error
            : new BrowserHostRpcError("transport", String(error)),
      });
    },
  };
}

export const BrowserAutomationHostLive = Layer.sync(BrowserAutomationHost, () =>
  makeBrowserAutomationHost(),
);

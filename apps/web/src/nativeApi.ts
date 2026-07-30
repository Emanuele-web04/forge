import type { NativeApi } from "@synara/contracts";

import { localWsEnvironmentClient } from "./wsEnvironmentRegistry";

let cachedDesktopApi: NativeApi | undefined;

export function readNativeApi(): NativeApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (cachedDesktopApi && window.nativeApi === cachedDesktopApi) return cachedDesktopApi;

  if (window.nativeApi) {
    cachedDesktopApi = window.nativeApi;
    return cachedDesktopApi;
  }

  return localWsEnvironmentClient().api;
}

export function ensureNativeApi(): NativeApi {
  const api = readNativeApi();
  if (!api) {
    throw new Error("Native API not found");
  }
  return api;
}

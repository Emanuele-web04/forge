// FILE: nativeApi.ts
// Purpose: The NativeApi every UI caller dispatches through, with thread-scoped
//          orchestration calls routed to the environment that owns the thread.
// Layer: Web transport
// Exports: readNativeApi, ensureNativeApi

import type { NativeApi } from "@synara/contracts";

import { createEnvironmentRoutedApi } from "./environmentRoutedApi";
import { localWsEnvironmentClient } from "./wsEnvironmentRegistry";

let cachedDesktopApi: NativeApi | undefined;
let routedApi: NativeApi | undefined;
let routedApiSource: NativeApi | undefined;

/**
 * The NativeApi for UI callers.
 *
 * Server-wide calls (settings, provider discovery, the local filesystem) go to
 * the page's own server, as they always have. Thread-scoped orchestration calls
 * are routed by `createEnvironmentRoutedApi` to whichever environment owns the
 * thread, so a remote thread's turn never runs on the local machine.
 *
 * Routing is applied HERE rather than at each call site on purpose: with ~300
 * `readNativeApi()` callers, opt-in routing is routing that gets forgotten, and
 * the failure is silent (issue #18). The desktop bridge is exempt because
 * Electron hosts one local server and registers no remote environments.
 */
export function readNativeApi(): NativeApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (cachedDesktopApi && window.nativeApi === cachedDesktopApi) return cachedDesktopApi;

  if (window.nativeApi) {
    cachedDesktopApi = window.nativeApi;
    return cachedDesktopApi;
  }

  // The local client is replaced on dispose/logout, so the wrapper is rebuilt
  // whenever its source changes rather than pinned to a dead transport.
  const localApi = localWsEnvironmentClient().api;
  if (!routedApi || routedApiSource !== localApi) {
    routedApiSource = localApi;
    routedApi = createEnvironmentRoutedApi(localApi);
  }
  return routedApi;
}

export function ensureNativeApi(): NativeApi {
  const api = readNativeApi();
  if (!api) {
    throw new Error("Native API not found");
  }
  return api;
}

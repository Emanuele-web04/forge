// FILE: nativeApi.test.ts
// Purpose: Prove PRODUCT CODE receives the routed wrapper, not the raw local
//          client.
// Layer: Web transport tests
//
// WHY THIS FILE EXISTS
//
// `environmentRouting.test.ts` covers `createEnvironmentRoutedApi` thoroughly —
// by calling it directly. Nothing asserted that the module every UI caller
// actually imports RETURNS the wrapper, so making `readNativeApi` hand back the
// unwrapped local api left the whole routing suite green while every one of
// ~300 call sites silently dispatched to the local server.
//
// That is the shape this branch keeps hitting: a correct function whose caller
// is untested. Here the caller IS the product's entry point, so its absence
// disarms the entire feature rather than one path.

import type { NativeApi } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const localApi = {
  orchestration: {
    dispatchCommand: vi.fn(async () => ({ sequence: 1 })),
    subscribeThread: vi.fn(async () => undefined),
  },
  terminal: { write: vi.fn(async () => undefined) },
} as unknown as NativeApi;

vi.mock("./wsEnvironmentRegistry", () => ({
  localWsEnvironmentClient: () => ({ api: localApi }),
  getWsEnvironmentClient: () => undefined,
  listWsEnvironmentClients: () => [],
  onWsEnvironmentRegistryChange: () => () => undefined,
}));

vi.mock("./store", () => ({
  useStore: { getState: () => ({ environmentById: {} }) },
}));

import { readNativeApi } from "./nativeApi";

describe("readNativeApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Unit tests run in node, and `readNativeApi` returns undefined without a
    // `window`. No `nativeApi` on it: the desktop bridge short-circuits before
    // the wrapper, and the web path is the one that must be wrapped.
    vi.stubGlobal("window", {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the ROUTED wrapper, not the raw local client", () => {
    // Identity is the assertion. A wrapper that merely looks like a NativeApi
    // would satisfy a shape check while being the unwrapped client, so compare
    // against the object the registry handed out.
    const api = readNativeApi();

    expect(api).toBeDefined();
    expect(api).not.toBe(localApi);
    // A routed method is rebuilt by the wrapper, so it is a different function.
    expect(api?.orchestration.dispatchCommand).not.toBe(localApi.orchestration.dispatchCommand);
  });

  it("routes a dispatch through the wrapper to the local implementation", () => {
    // Proves the wrapper is live rather than merely present: with no remote
    // environment registered everything resolves local, so the call must still
    // reach the underlying client.
    const api = readNativeApi();
    void api?.orchestration.dispatchCommand({
      type: "thread.session.stop",
      commandId: "command-1",
      threadId: "thread-1",
      createdAt: "2026-08-03T00:00:00.000Z",
    } as never);

    expect(localApi.orchestration.dispatchCommand).toHaveBeenCalledTimes(1);
  });

  it("reuses one wrapper while the source client is unchanged", () => {
    // Rebuilding per call would drop subscription identity and re-wrap on every
    // render; the module caches deliberately.
    expect(readNativeApi()).toBe(readNativeApi());
  });
});

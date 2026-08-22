import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cleanup: undefined as (() => void) | undefined,
  queryClient: {},
  readNativeApi: vi.fn(),
  reconcileServerProviderStatuses: vi.fn(async () => undefined),
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      mocks.cleanup = effect() ?? undefined;
    },
  };
});

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => mocks.queryClient,
}));

vi.mock("../nativeApi", () => ({
  readNativeApi: mocks.readNativeApi,
}));

vi.mock("../lib/serverReactQuery", () => ({
  reconcileServerProviderStatuses: mocks.reconcileServerProviderStatuses,
}));

import { useProviderStatusRefresh } from "./useProviderStatusRefresh";

function installBrowserGlobals(visibilityState: DocumentVisibilityState) {
  const windowTarget = new EventTarget();
  Object.assign(windowTarget, {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  });
  const documentTarget = new EventTarget();
  Object.defineProperty(documentTarget, "visibilityState", {
    configurable: true,
    value: visibilityState,
    writable: true,
  });
  vi.stubGlobal("window", windowTarget);
  vi.stubGlobal("document", documentTarget);
  return {
    documentTarget,
    setVisibilityState: (next: DocumentVisibilityState) => {
      Object.defineProperty(documentTarget, "visibilityState", {
        configurable: true,
        value: next,
        writable: true,
      });
    },
    windowTarget,
  };
}

describe("useProviderStatusRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.cleanup = undefined;
    mocks.readNativeApi.mockReset();
    mocks.reconcileServerProviderStatuses.mockClear();
  });

  afterEach(() => {
    mocks.cleanup?.();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("still runs the startup refresh after an early focus attempt fails", async () => {
    const { windowTarget } = installBrowserGlobals("visible");
    const refreshProviders = vi
      .fn()
      .mockRejectedValueOnce(new Error("transport unavailable"))
      .mockResolvedValueOnce({ providers: [] });
    mocks.readNativeApi.mockReturnValue({ server: { refreshProviders } });
    const onRefreshSuccess = vi.fn();

    useProviderStatusRefresh({
      initialDelayMs: 10_000,
      minIntervalMs: 15_000,
      refreshOnFocus: true,
      onRefreshSuccess,
    });

    windowTarget.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshProviders).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(refreshProviders).toHaveBeenCalledTimes(2);
    expect(onRefreshSuccess).toHaveBeenCalledOnce();
  });

  it("retries a hidden startup refresh when the document becomes visible", async () => {
    const { documentTarget, setVisibilityState } = installBrowserGlobals("hidden");
    const refreshProviders = vi.fn().mockResolvedValue({ providers: [] });
    mocks.readNativeApi.mockReturnValue({ server: { refreshProviders } });
    const onRefreshSuccess = vi.fn();

    useProviderStatusRefresh({
      initialDelayMs: 10_000,
      minIntervalMs: 15_000,
      refreshOnFocus: true,
      onRefreshSuccess,
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(refreshProviders).not.toHaveBeenCalled();

    setVisibilityState("visible");
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);

    expect(refreshProviders).toHaveBeenCalledOnce();
    expect(onRefreshSuccess).toHaveBeenCalledOnce();
  });
});

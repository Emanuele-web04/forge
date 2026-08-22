// FILE: backendReadiness.test.ts
// Purpose: Covers desktop backend readiness polling and abort behavior.
// Layer: Desktop startup tests
// Depends on: backendReadiness.ts, vitest

import { describe, expect, it, vi } from "vitest";

import {
  BackendReadinessAbortedError,
  isBackendReadinessAborted,
  waitForHttpReady,
} from "./backendReadiness";

describe("waitForHttpReady", () => {
  it("returns once the backend reports a successful readiness response", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await waitForHttpReady("http://127.0.0.1:3773", {
      fetchImpl,
      timeoutMs: 1_000,
      intervalMs: 0,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("supports custom readiness predicates for routes that are alive before they are ok", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302 }));

    await waitForHttpReady("http://127.0.0.1:3773", {
      fetchImpl,
      timeoutMs: 100,
      intervalMs: 0,
      path: "/",
      isReady: () => true,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:3773/",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("supports async readiness predicates for semantic health responses", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ startupReady: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ startupReady: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    await waitForHttpReady("http://127.0.0.1:3773", {
      fetchImpl,
      timeoutMs: 100,
      intervalMs: 0,
      path: "/health",
      isReady: async (response) => {
        const payload = (await response.json()) as {
          startupReady?: boolean;
        };
        return payload.startupReady === true;
      },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries after a readiness request stalls past the per-request timeout", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                reject(new Error("request timed out"));
              },
              { once: true },
            );
          }) as ReturnType<typeof fetch>,
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await waitForHttpReady("http://127.0.0.1:3773", {
      fetchImpl,
      timeoutMs: 100,
      intervalMs: 0,
      requestTimeoutMs: 1,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps observing a live backend beyond sixty seconds when no deadline is configured", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          Date.now() >= 130_000
            ? new Response(null, { status: 200 })
            : new Response(null, { status: 503 }),
        );

      const readiness = waitForHttpReady("http://127.0.0.1:3773", {
        fetchImpl,
        timeoutMs: null,
        intervalMs: 1_000,
      });

      await vi.advanceTimersByTimeAsync(130_000);

      await expect(readiness).resolves.toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledTimes(131);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts an in-flight readiness wait", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => {
              reject(new BackendReadinessAbortedError());
            },
            { once: true },
          );
        }) as ReturnType<typeof fetch>,
    );

    const waitPromise = waitForHttpReady("http://127.0.0.1:3773", {
      fetchImpl,
      timeoutMs: 1_000,
      intervalMs: 0,
      signal: controller.signal,
    });

    controller.abort();

    await expect(waitPromise).rejects.toBeInstanceOf(BackendReadinessAbortedError);
  });

  it("recognizes aborted readiness errors", () => {
    expect(isBackendReadinessAborted(new BackendReadinessAbortedError())).toBe(true);
    expect(isBackendReadinessAborted(new Error("nope"))).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";

import { unwrapDbusValue, withDbusTimeout } from "./dbusPlumbing.ts";

/** Stands in for a call site's own error type, recovery marker and all. */
class SiteError extends Error {
  readonly connectionLevel = true;
}

describe("unwrapping a D-Bus value", () => {
  it("sees through however many variant layers wrapped it", () => {
    const nested = { signature: "v", value: { signature: "s", value: "ok" } };
    expect(unwrapDbusValue(nested)).toBe("ok");
  });

  it("leaves a plain value, and a look-alike without a signature, alone", () => {
    expect(unwrapDbusValue(["a", "b"])).toEqual(["a", "b"]);
    expect(unwrapDbusValue({ value: "not a variant" })).toEqual({ value: "not a variant" });
    expect(unwrapDbusValue(null)).toBeNull();
  });
});

describe("racing a D-Bus call against a timeout", () => {
  it("rejects with exactly the error the caller's factory built", async () => {
    vi.useFakeTimers();
    try {
      const pending = withDbusTimeout(new Promise(() => undefined), 5_000, {
        onTimeout: () => new SiteError("Method timed out after 5000 ms."),
      });
      const settled = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5_000);
      const error = (await settled) as SiteError;
      expect(error).toBeInstanceOf(SiteError);
      expect(error.message).toBe("Method timed out after 5000 ms.");
      expect(error.connectionLevel).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire early, and builds the error only on expiry", async () => {
    vi.useFakeTimers();
    try {
      let built = 0;
      const pending = withDbusTimeout(new Promise(() => undefined), 5_000, {
        onTimeout: () => {
          built += 1;
          return new SiteError("late");
        },
      });
      const settled = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(built).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await settled;
      expect(built).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the timer when the call answers, leaving nothing pending", async () => {
    vi.useFakeTimers();
    try {
      const call = withDbusTimeout(Promise.resolve("ok"), 5_000, {
        onTimeout: () => new SiteError("no"),
      });
      await expect(call).resolves.toBe("ok");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes a reported failure through untouched when no mapper is given", async () => {
    const reported = { type: "org.freedesktop.DBus.Error.ServiceUnknown" };
    const call = withDbusTimeout(Promise.reject(reported), 5_000, {
      onTimeout: () => new SiteError("no"),
    });
    await expect(call).rejects.toBe(reported);
  });

  it("hands a reported failure to the mapper when there is one", async () => {
    const reported = { type: "org.freedesktop.portal.Error.Cancelled" };
    const call = withDbusTimeout(Promise.reject(reported), 5_000, {
      onTimeout: () => new SiteError("no"),
      onRejected: (error) => new SiteError(`failed: ${JSON.stringify(error)}`),
    });
    await expect(call).rejects.toThrow(/portal.Error.Cancelled/);
  });

  it("clears the timer on a rejection too", async () => {
    vi.useFakeTimers();
    try {
      const call = withDbusTimeout(Promise.reject(new Error("nope")), 5_000, {
        onTimeout: () => new SiteError("no"),
      });
      await expect(call).rejects.toThrow("nope");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

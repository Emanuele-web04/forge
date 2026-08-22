// FILE: expensiveReadRetry.test.ts
// Purpose: Locks down capacity-retry delay and error-only self-heal intervals.
// Layer: Web data-fetching unit tests

import { describe, expect, it } from "vitest";

import {
  expensiveReadErrorRefetchInterval,
  expensiveReadRetryDelay,
  getUnaryRpcCapacityRetryDelayMs,
  isRpcCapacityExceededError,
  MAX_UNARY_RPC_CAPACITY_RETRY_ATTEMPTS,
  shouldRetryExpensiveRead,
  shouldRetryExpensiveReadCapacityOnly,
} from "./expensiveReadRetry";

const capacityError = {
  code: "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED",
  retryable: true,
  retryAfterMs: 375,
};

describe("expensive-read capacity retry", () => {
  it("recognizes typed capacity errors and honors the server retry delay", () => {
    expect(isRpcCapacityExceededError(capacityError)).toBe(true);
    expect(
      isRpcCapacityExceededError({
        code: "RPC_REQUEST_CAPACITY_EXCEEDED",
        retryable: true,
        retryAfterMs: 250,
      }),
    ).toBe(true);
    expect(isRpcCapacityExceededError(new Error("network"))).toBe(false);

    expect(shouldRetryExpensiveRead(0, capacityError)).toBe(true);
    expect(shouldRetryExpensiveRead(11, capacityError)).toBe(true);
    expect(shouldRetryExpensiveRead(12, capacityError)).toBe(false);
    expect(shouldRetryExpensiveRead(0, new Error("Workspace file not found"))).toBe(true);
    expect(shouldRetryExpensiveReadCapacityOnly(0, capacityError)).toBe(true);
    expect(shouldRetryExpensiveReadCapacityOnly(0, new Error("Workspace file not found"))).toBe(
      false,
    );
    expect(expensiveReadRetryDelay(0, capacityError)).toBe(375);
    expect(
      expensiveReadRetryDelay(0, {
        code: "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED",
        retryable: true,
      }),
    ).toBe(250);
  });

  it("uses a bounded in-place unary retry that honors retryAfterMs", () => {
    expect(getUnaryRpcCapacityRetryDelayMs(capacityError, 0)).toBe(375);
    expect(getUnaryRpcCapacityRetryDelayMs(capacityError, 11)).toBe(375);
    expect(
      getUnaryRpcCapacityRetryDelayMs(capacityError, MAX_UNARY_RPC_CAPACITY_RETRY_ATTEMPTS),
    ).toBeNull();
    expect(
      getUnaryRpcCapacityRetryDelayMs(
        { code: "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED", retryable: false, retryAfterMs: 375 },
        0,
      ),
    ).toBeNull();
    expect(getUnaryRpcCapacityRetryDelayMs(new Error("boom"), 0)).toBeNull();
  });

  it("self-heals only while a retryable capacity error is retained", () => {
    expect(expensiveReadErrorRefetchInterval({ state: { error: capacityError } })).toBe(375);
    expect(expensiveReadErrorRefetchInterval({ state: { error: null } })).toBe(false);
    expect(expensiveReadErrorRefetchInterval({ state: { error: new Error("ENOENT") } })).toBe(
      false,
    );
    expect(
      expensiveReadErrorRefetchInterval({
        state: {
          error: {
            code: "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED",
            retryable: false,
            retryAfterMs: 375,
          },
        },
      }),
    ).toBe(false);
  });
});

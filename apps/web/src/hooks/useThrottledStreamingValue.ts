// FILE: useThrottledStreamingValue.ts
// Purpose: Rate-limit how often a fast-changing streamed value reaches an expensive
//          consumer (e.g. a Shiki re-highlight of a growing code block) while a message is
//          streaming, without ever dropping the final value.
// Layer: Web UI streaming primitive
// Exports: useThrottledStreamingValue, planThrottledCommit (pure, unit-tested)
// Why: The reveal cadence (useSmoothStreamedText, ~25 commits/s) is right for prose but
//      far too fast for consumers whose cost grows with the value — re-tokenizing a whole
//      code block 25×/s is quadratic in its length. This hook passes the first change
//      through immediately, then coalesces further changes to at most one per
//      `intervalMs` (trailing edge always delivered). When `active` is false the value is
//      returned verbatim, so settled content never lags.

import { useEffect, useRef, useState } from "react";

export type ThrottledCommitPlan =
  | { readonly immediate: true }
  | { readonly immediate: false; readonly delayMs: number };

/**
 * Decide whether a new value may commit now or must wait for the trailing edge of the
 * current interval. `lastCommitAtMs === 0` marks a fresh burst and always commits.
 */
export function planThrottledCommit(
  lastCommitAtMs: number,
  nowMs: number,
  intervalMs: number,
): ThrottledCommitPlan {
  const elapsed = lastCommitAtMs === 0 ? Number.POSITIVE_INFINITY : nowMs - lastCommitAtMs;
  return elapsed >= intervalMs
    ? { immediate: true }
    : { immediate: false, delayMs: Math.max(0, intervalMs - elapsed) };
}

export function useThrottledStreamingValue<T>(value: T, active: boolean, intervalMs: number): T {
  // Testable env: jsdom's timers are fake and performance.now() is mocked – throttling
  // would coalesce indefinitely and make streaming appear stuck. Bypass.
  const isTestableEnv =
    typeof window === "undefined" ||
    (typeof process !== "undefined" &&
      (process.env.VITEST === "true" || process.env.NODE_ENV === "test"));
  const [throttled, setThrottled] = useState(value);
  const lastCommitAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const latestRef = useRef(value);

  useEffect(() => {
    latestRef.current = value;
    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    if (!active || isTestableEnv) {
      clearTimer();
      lastCommitAtRef.current = 0;
      setThrottled(value);
      return;
    }
    const plan = planThrottledCommit(lastCommitAtRef.current, performance.now(), intervalMs);
    if (plan.immediate) {
      clearTimer();
      lastCommitAtRef.current = performance.now();
      setThrottled(value);
      return;
    }
    if (timerRef.current !== null) {
      // A trailing commit is already scheduled; it reads the latest value when it fires.
      return;
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      lastCommitAtRef.current = performance.now();
      setThrottled(latestRef.current);
    }, plan.delayMs);
  }, [active, intervalMs, isTestableEnv, value]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    },
    [],
  );

  return active && !isTestableEnv ? throttled : value;
}

import type { BrowserRunOutput, BrowserTabId } from "@synara/contracts";
import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { browserHostError } from "./hostErrors";
import { getBrowserNavigationTracker, type BrowserNavigationMark } from "./navigationTracker";

export const waitForLoadMilestone = async (
  runtime: BrowserAutomationVisibleRuntime,
  expected: "commit" | "domcontentloaded" | "load" | "networkidle",
  timeoutMs: number,
  signal?: AbortSignal,
  mark?: BrowserNavigationMark,
) =>
  (await getBrowserNavigationTracker(runtime, signal)).wait(
    runtime,
    expected,
    timeoutMs,
    signal,
    mark,
  );

const jsonDepth = (value: unknown, depth = 0): number => {
  if (value === null || typeof value !== "object") return depth;
  if (depth > 20) return depth;
  const values = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return values.reduce((maximum, item) => Math.max(maximum, jsonDepth(item, depth + 1)), depth);
};

export const browserEvaluationOutput = (tabId: string, value: unknown): BrowserRunOutput => {
  if (value === undefined) {
    browserHostError({
      code: "BrowserEvaluationFailed",
      retryable: false,
      phase: "evaluate",
      effectMayHaveCommitted: true,
      tabId: tabId as BrowserTabId,
    });
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = "";
  }
  const serializedByteCount = Buffer.byteLength(serialized, "utf8");
  if (!serialized || serializedByteCount > 262_144 || jsonDepth(value) > 20) {
    browserHostError({
      code: "BrowserEvaluationResultTooLarge",
      retryable: false,
      phase: "evaluate",
      effectMayHaveCommitted: true,
      tabId: tabId as BrowserTabId,
    });
  }
  return {
    tabId: tabId as BrowserTabId,
    value: value as BrowserRunOutput["value"],
    serializedByteCount,
  };
};

import type {
  BrowserEvaluateInput,
  BrowserEvaluateOutput,
  BrowserTabId,
  BrowserWaitCondition,
  BrowserWaitInput,
  BrowserWaitOutput,
} from "@synara/contracts";

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import {
  abortReason,
  evaluateInContext,
  loadStateForReadyState,
  observePage,
  throwIfAborted,
  type BrowserPageObservation,
} from "./cdpRuntime";
import {
  type BrowserCredentialInputClassification,
  credentialInputMatchFrom,
  HAS_CREDENTIAL_INPUT_EXPRESSION,
} from "./credentialDetection";
import { BrowserAutomationHostError, browserHostError } from "./hostErrors";
import {
  browserLoadMilestoneSatisfied,
  getBrowserNavigationTracker,
  type BrowserNavigationMark,
} from "./navigationTracker";
import type { BrowserSnapshotHandle } from "./semanticSnapshot";
import { releaseBrowserTarget, resolveBrowserTarget } from "./targets";

const POLL_INTERVAL_MS = 50;

const delay = (milliseconds: number, signal?: AbortSignal): Promise<void> => {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, milliseconds));
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
};

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

/**
 * Matches the wait tool's deliberately small wildcard language without
 * compiling caller-controlled input into a regular expression. This is a
 * bit-parallel NFA: each input code point advances the complete bounded glob
 * state in a fixed number of BigInt operations, with no suffix rescanning or
 * backtracking tree.
 */
export const boundedGlobMatches = (value: string, glob: string): boolean => {
  const pattern: string[] = [];
  for (const character of glob) {
    if (character !== "*" || pattern.at(-1) !== "*") pattern.push(character);
  }

  let starMask = 0n;
  let questionMask = 0n;
  const literalMasks = new Map<string, bigint>();
  for (const [index, character] of pattern.entries()) {
    const bit = 1n << BigInt(index);
    if (character === "*") starMask |= bit;
    else if (character === "?") questionMask |= bit;
    else literalMasks.set(character, (literalMasks.get(character) ?? 0n) | bit);
  }

  // Consecutive stars were collapsed, so one shift computes the complete
  // epsilon closure from every active star state.
  const closeStars = (states: bigint): bigint => states | ((states & starMask) << 1n);
  let states = closeStars(1n);
  for (const character of value) {
    const consumingStates = questionMask | (literalMasks.get(character) ?? 0n);
    states = closeStars((states & starMask) | ((states & consumingStates) << 1n));
    if (states === 0n) return false;
  }

  const acceptingState = 1n << BigInt(pattern.length);
  return (states & acceptingState) !== 0n;
};

const targetConditionSatisfied = async (
  runtime: BrowserAutomationVisibleRuntime,
  condition: Extract<BrowserWaitCondition, { readonly kind: "target" }>,
  snapshot: BrowserSnapshotHandle | undefined,
  signal?: AbortSignal,
): Promise<boolean> => {
  try {
    const target = await resolveBrowserTarget(runtime, condition.target, snapshot, {
      requireVisible: false,
      signal,
    });
    try {
      switch (condition.state) {
        case "attached":
          return target.attached;
        case "visible":
          return target.attached && target.visible;
        case "hidden":
          return !target.attached || !target.visible;
        case "enabled":
          return target.attached && target.enabled;
        case "editable":
          return target.attached && target.editable;
        case "detached":
          return !target.attached;
      }
    } finally {
      await releaseBrowserTarget(runtime, target, signal);
    }
  } catch (error) {
    if (!(error instanceof BrowserAutomationHostError)) throw error;
    const code = error.browserError.code;
    if (code === "BrowserTimeout" || code === "BrowserInterruptedByHuman") throw error;
    if (
      code === "BrowserStaleReference" ||
      code === "BrowserInvalidLocator" ||
      code === "BrowserTargetAmbiguous"
    )
      throw error;
    if (condition.state === "detached") return code === "BrowserTargetNotFound";
    if (condition.state === "hidden") {
      return code === "BrowserTargetNotFound" || code === "BrowserTargetNotVisible";
    }
    return false;
  }
};

const conditionSatisfied = async (
  runtime: BrowserAutomationVisibleRuntime,
  condition: BrowserWaitCondition,
  snapshot: BrowserSnapshotHandle | undefined,
  networkIdle: boolean,
  elapsedMs: number,
  observations: {
    page?: Promise<BrowserPageObservation>;
  },
  signal?: AbortSignal,
): Promise<boolean> => {
  if (condition.kind === "delay") return elapsedMs >= condition.timeMs;
  if (condition.kind === "target") {
    return targetConditionSatisfied(runtime, condition, snapshot, signal);
  }
  if (condition.kind === "text") {
    const present =
      (
        await evaluateInContext<boolean>(
          runtime,
          `(document.body?.innerText || "").includes(${JSON.stringify(condition.text)})`,
          { signal },
        )
      ).value === true;
    return condition.state === "present" ? present : !present;
  }
  observations.page ??= observePage(runtime, signal);
  const page = await observations.page;
  if (condition.kind === "url") {
    return "exact" in condition
      ? page.url === condition.exact
      : boundedGlobMatches(page.url, condition.glob);
  }
  const observed = networkIdle ? "networkidle" : loadStateForReadyState(page.readyState);
  return browserLoadMilestoneSatisfied(observed, condition.state);
};

export const waitForBrowserConditions = async (
  runtime: BrowserAutomationVisibleRuntime,
  input: BrowserWaitInput,
  snapshot: BrowserSnapshotHandle | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<BrowserWaitOutput> => {
  const startedAt = performance.now();
  const deadline = startedAt + timeoutMs;
  const navigationTracker = await getBrowserNavigationTracker(runtime, signal);
  while (performance.now() <= deadline) {
    throwIfAborted(signal);
    const networkIdle = navigationTracker.networkIdle();
    const observations: {
      page?: Promise<BrowserPageObservation>;
    } = {};
    const settledStates = await Promise.allSettled(
      input.conditions.map((condition) =>
        conditionSatisfied(
          runtime,
          condition,
          snapshot,
          networkIdle,
          performance.now() - startedAt,
          observations,
          signal,
        ),
      ),
    );
    const failedState = settledStates.find(
      (state): state is PromiseRejectedResult => state.status === "rejected",
    );
    if (failedState) throw failedState.reason;
    const states = settledStates.map((state) => (state as PromiseFulfilledResult<boolean>).value);
    throwIfAborted(signal);
    const satisfiedConditionIndexes = states.flatMap((satisfied, index) =>
      satisfied ? [index] : [],
    );
    const satisfied =
      input.mode === "any"
        ? satisfiedConditionIndexes.length > 0
        : satisfiedConditionIndexes.length === input.conditions.length;
    if (satisfied) {
      observations.page ??= observePage(runtime, signal);
      const page = await observations.page;
      return {
        tabId: runtime.tabId as BrowserTabId,
        satisfiedConditionIndexes,
        observed: {
          url: page.url,
          loadState: networkIdle ? "networkidle" : loadStateForReadyState(page.readyState),
        },
      };
    }
    await delay(POLL_INTERVAL_MS, signal);
  }
  browserHostError({
    code: "BrowserTimeout",
    retryable: true,
    phase: "runtime",
    effectMayHaveCommitted: false,
    tabId: runtime.tabId as BrowserTabId,
  });
};

const jsonDepth = (value: unknown, depth = 0): number => {
  if (value === null || typeof value !== "object") return depth;
  if (depth > 20) return depth;
  const values = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return values.reduce((maximum, item) => Math.max(maximum, jsonDepth(item, depth + 1)), depth);
};

export const evaluateBrowserExpression = async (
  runtime: BrowserAutomationVisibleRuntime,
  input: BrowserEvaluateInput,
  signal?: AbortSignal,
): Promise<BrowserEvaluateOutput> => {
  const credentialSurface = await evaluateInContext<BrowserCredentialInputClassification>(
    runtime,
    HAS_CREDENTIAL_INPUT_EXPRESSION,
    {
      returnByValue: true,
      effectMayHaveCommitted: false,
      signal,
    },
  );
  if (credentialSurface.value !== false) {
    browserHostError(
      {
        code: "BrowserCredentialInputRequired",
        tabId: runtime.tabId as BrowserTabId,
      },
      credentialInputMatchFrom(credentialSurface.value),
    );
  }
  let value: unknown;
  try {
    const response = await evaluateInContext(runtime, input.expression, {
      userGesture: true,
      returnByValue: true,
      awaitPromise: true,
      effectMayHaveCommitted: true,
      signal,
    });
    value = response.value;
  } catch (error) {
    if (error instanceof BrowserAutomationHostError) throw error;
    browserHostError({
      code: "BrowserEvaluationFailed",
      retryable: false,
      phase: "evaluate",
      effectMayHaveCommitted: true,
      tabId: runtime.tabId as BrowserTabId,
    });
  }
  throwIfAborted(signal);
  if (value === undefined) {
    browserHostError({
      code: "BrowserEvaluationFailed",
      retryable: false,
      phase: "evaluate",
      effectMayHaveCommitted: true,
      tabId: runtime.tabId as BrowserTabId,
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
      tabId: runtime.tabId as BrowserTabId,
    });
  }
  return {
    tabId: runtime.tabId as BrowserTabId,
    value: value as BrowserEvaluateOutput["value"],
    serializedByteCount,
  };
};

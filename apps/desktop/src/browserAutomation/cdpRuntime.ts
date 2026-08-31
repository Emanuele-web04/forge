import type { BrowserTabId } from "@synara/contracts";
import type { WebContents } from "electron";

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { BrowserAutomationHostError, browserHostError } from "./hostErrors";

export interface CdpRemoteObject {
  readonly objectId?: string;
  readonly type?: string;
  readonly subtype?: string;
  readonly value?: unknown;
  readonly unserializableValue?: string;
}

interface CdpEvaluationResult {
  readonly result?: CdpRemoteObject;
  readonly exceptionDetails?: {
    readonly text?: string;
    readonly exception?: { readonly description?: string };
  };
}

const cancelledError = (): Error => new Error("Browser operation cancelled.");

export const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : cancelledError();

export const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw abortReason(signal);
};

/**
 * Waits for an Electron operation to drain after cancellation. The public tool
 * call is raced at the host boundary, so callers still receive cancellation
 * immediately, while the per-tab lock remains held until Chromium has stopped
 * touching the shared renderer.
 */
export const drainOnAbort = async <T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  onAbort?: () => void | Promise<void>,
): Promise<T> => {
  throwIfAborted(signal);
  if (!signal) return operation;

  let aborted = false;
  let abortCleanup: Promise<void> | undefined;
  const handleAbort = () => {
    aborted = true;
    try {
      abortCleanup = Promise.resolve(onAbort?.()).then(
        () => undefined,
        () => undefined,
      );
    } catch {
      // Cancellation cleanup is best-effort; the original operation is still drained.
    }
  };
  signal.addEventListener("abort", handleAbort, { once: true });
  try {
    const result = await operation;
    throwIfAborted(signal);
    return result;
  } catch (error) {
    if (aborted || signal.aborted) throw abortReason(signal);
    throw error;
  } finally {
    signal.removeEventListener("abort", handleAbort);
    // A mutating command's compensating stop/release is part of draining the
    // operation. Keep the internal tab lock until Chromium has acknowledged it,
    // while the host's public abort race still rejects immediately.
    if (abortCleanup) await abortCleanup;
  }
};

export interface BrowserPageObservation {
  readonly url: string;
  readonly title: string;
  readonly viewport: {
    readonly width: number;
    readonly height: number;
    readonly deviceScaleFactor: number;
  };
  readonly readyState: "loading" | "interactive" | "complete";
}

const evaluationMessage = (result: CdpEvaluationResult): string =>
  result.exceptionDetails?.exception?.description ??
  result.exceptionDetails?.text ??
  "The page expression could not be evaluated.";

export const ensureCdpAttached = (webContents: WebContents): void => {
  if (webContents.isDestroyed()) {
    browserHostError({
      code: "BrowserRuntimeDisconnected",
      retryable: true,
      phase: "runtime",
      effectMayHaveCommitted: false,
    });
  }
  if (webContents.debugger.isAttached()) return;
  try {
    webContents.debugger.attach("1.3");
  } catch {
    browserHostError({
      code: "BrowserDebuggerConflict",
      retryable: true,
      phase: "runtime",
      effectMayHaveCommitted: false,
    });
  }
};

export const sendCdpCommand = async <Result = unknown>(
  runtime: BrowserAutomationVisibleRuntime,
  method: string,
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
  errorContext: {
    readonly effectMayHaveCommitted?: boolean | undefined;
    readonly onAbort?: (() => void | Promise<void>) | undefined;
  } = {},
): Promise<Result> => {
  throwIfAborted(signal);
  ensureCdpAttached(runtime.webContents);
  try {
    const operation = runtime.webContents.debugger.sendCommand(method, params) as Promise<Result>;
    const terminatesJavaScript =
      method === "Runtime.evaluate" || method === "Runtime.callFunctionOn";
    const onAbort =
      errorContext.onAbort || terminatesJavaScript
        ? async () => {
            await errorContext.onAbort?.();
            if (
              !terminatesJavaScript ||
              runtime.webContents.isDestroyed() ||
              !runtime.webContents.debugger.isAttached()
            ) {
              return;
            }
            await runtime.webContents.debugger.sendCommand("Runtime.terminateExecution").then(
              () => undefined,
              () => undefined,
            );
          }
        : undefined;
    return await drainOnAbort(operation, signal, onAbort);
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    if (error instanceof BrowserAutomationHostError) throw error;
    if (errorContext.effectMayHaveCommitted) {
      // Chromium accepted the command before the transport failure. Reissuing
      // an arbitrary page function/evaluation could double-submit, double-click
      // or duplicate another irreversible effect. Force observation and a new
      // intention instead of presenting the failure as safely retryable.
      browserHostError({ code: "BrowserAmbiguousResult", tabId: runtime.tabId as BrowserTabId });
    }
    browserHostError({
      code: "BrowserRuntimeDisconnected",
      retryable: true,
      phase: "runtime",
      effectMayHaveCommitted: false,
    });
  }
};

export const evaluateInContext = async <Result = unknown>(
  runtime: BrowserAutomationVisibleRuntime,
  expression: string,
  options: {
    readonly contextId?: number | undefined;
    readonly userGesture?: boolean | undefined;
    readonly returnByValue?: boolean | undefined;
    readonly awaitPromise?: boolean | undefined;
    readonly timeoutMs?: number | undefined;
    readonly effectMayHaveCommitted?: boolean | undefined;
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<CdpRemoteObject & { readonly value?: Result }> => {
  const response = await sendCdpCommand<CdpEvaluationResult>(
    runtime,
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: options.awaitPromise ?? true,
      returnByValue: options.returnByValue ?? true,
      userGesture: options.userGesture ?? false,
      generatePreview: false,
      ...(options.contextId === undefined ? {} : { contextId: options.contextId }),
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    },
    options.signal,
    { effectMayHaveCommitted: options.effectMayHaveCommitted },
  );
  throwIfAborted(options.signal);
  if (response.exceptionDetails || !response.result) {
    throw new Error(evaluationMessage(response));
  }
  return response.result as CdpRemoteObject & { readonly value?: Result };
};

export const callFunctionOn = async <Result = unknown>(
  runtime: BrowserAutomationVisibleRuntime,
  objectId: string,
  functionDeclaration: string,
  options: {
    readonly returnByValue?: boolean | undefined;
    readonly arguments?: readonly unknown[] | undefined;
    readonly effectMayHaveCommitted?: boolean | undefined;
    readonly onAbort?: (() => void | Promise<void>) | undefined;
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<CdpRemoteObject & { readonly value?: Result }> => {
  const response = await sendCdpCommand<CdpEvaluationResult>(
    runtime,
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration,
      awaitPromise: true,
      returnByValue: options.returnByValue ?? true,
      userGesture: true,
      arguments: (options.arguments ?? []).map((value) => ({ value })),
    },
    options.signal,
    {
      // callFunctionOn executes caller-supplied JavaScript. Default to the safe
      // classification; observation-only callers can explicitly opt out.
      effectMayHaveCommitted: options.effectMayHaveCommitted ?? true,
      onAbort: options.onAbort,
    },
  );
  throwIfAborted(options.signal);
  if (response.exceptionDetails || !response.result) {
    throw new Error(evaluationMessage(response));
  }
  return response.result as CdpRemoteObject & { readonly value?: Result };
};

export const observePage = async (
  runtime: BrowserAutomationVisibleRuntime,
  signal?: AbortSignal,
): Promise<BrowserPageObservation> => {
  throwIfAborted(signal);
  const [layoutResult, pageResult] = await Promise.allSettled([
    sendCdpCommand<{
      readonly cssLayoutViewport?: {
        readonly clientWidth?: number;
        readonly clientHeight?: number;
      };
      readonly layoutViewport?: { readonly clientWidth?: number; readonly clientHeight?: number };
    }>(runtime, "Page.getLayoutMetrics", {}, signal),
    evaluateInContext<{
      readonly url: string;
      readonly title: string;
      readonly readyState: "loading" | "interactive" | "complete";
      readonly deviceScaleFactor: number;
    }>(
      runtime,
      "({url: location.href, title: document.title, readyState: document.readyState, deviceScaleFactor: window.devicePixelRatio || 1})",
      { signal },
    ),
  ]);
  // Promise.all would reject on the first aborted command and release the tab
  // lock while its sibling CDP command was still running. Always drain both.
  if (layoutResult.status === "rejected") throw layoutResult.reason;
  if (pageResult.status === "rejected") throw pageResult.reason;
  const layout = layoutResult.value;
  const page = pageResult.value;
  throwIfAborted(signal);
  const viewport = layout.cssLayoutViewport ?? layout.layoutViewport ?? {};
  const value = page.value;
  if (!value || typeof value.url !== "string") {
    throw new Error("The visible browser did not return page state.");
  }
  return {
    url: value.url,
    title: value.title,
    readyState: value.readyState,
    viewport: {
      width: Math.max(1, Math.min(3_840, Math.round(viewport.clientWidth ?? 1))),
      height: Math.max(1, Math.min(2_160, Math.round(viewport.clientHeight ?? 1))),
      deviceScaleFactor: Math.max(0.25, Math.min(8, value.deviceScaleFactor || 1)),
    },
  };
};

export function loadStateForReadyState(
  readyState: BrowserPageObservation["readyState"],
): "commit" | "domcontentloaded" | "load" {
  if (readyState === "complete") {
    return "load";
  }
  if (readyState === "interactive") {
    return "domcontentloaded";
  }
  return "commit";
}

import {
  BROWSER_TOOL_NAMES,
  type BrowserBackInput,
  type BrowserClickInput,
  type BrowserCloseOutput,
  type BrowserDragInput,
  type BrowserEvaluateInput,
  type BrowserForwardInput,
  type BrowserHoverInput,
  type BrowserLogsInput,
  type BrowserNavigateOutput,
  type BrowserOpenOutput,
  type BrowserPressInput,
  type BrowserReloadInput,
  type BrowserResizeInput,
  type BrowserResizeOutput,
  type BrowserScrollInput,
  type BrowserScreenshotInput,
  type BrowserSelectInput,
  type BrowserSnapshotInput,
  type BrowserStatusOutput,
  type BrowserTabId,
  type BrowserTabsOutput,
  type BrowserToolName,
  type BrowserToolNavigateInput,
  type BrowserToolOpenInput,
  type BrowserTypeInput,
  type BrowserUploadInput,
  type BrowserWaitInput,
  type BrowserWebMcpCallInput,
  type BrowserWebMcpCallOutput,
  type BrowserWebMcpToolsInput,
  type ThreadBrowserState,
  type ThreadId,
} from "@synara/contracts";
import {
  BROWSER_TOOL_DEFINITIONS_BY_NAME,
  stableJsonStringify,
} from "@synara/shared/browserAutomationCatalogue";
import { Schema } from "effect";

import type {
  BrowserAutomationWindowOpenEvent,
  BrowserAutomationVisibleRuntime,
  DesktopBrowserManager,
} from "../browserManager";
import { abortReason, observePage, sendCdpCommand, throwIfAborted } from "./cdpRuntime";
import { BrowserAutomationHostError, browserHostError } from "./hostErrors";
import {
  clickBrowserTarget,
  dragBrowserTarget,
  hoverBrowserTarget,
  pressBrowserKeys,
  scrollBrowser,
  selectBrowserTarget,
  typeIntoBrowserTarget,
} from "./inputActions";
import { captureSemanticSnapshot, type BrowserSnapshotHandle } from "./semanticSnapshot";
import { BrowserDiagnosticsStore } from "./browserDiagnostics";
import { navigateBrowserHistory, type BrowserHistoryDirection } from "./navigationHistory";
import { captureBrowserScreenshot } from "./screenshotCapture";
import { withDialogHandling } from "./dialogHandling";
import { uploadBrowserFiles } from "./workspaceUpload";
import {
  evaluateBrowserExpression,
  waitForBrowserConditions,
  waitForLoadMilestone,
} from "./waitAndEvaluate";
import {
  discoverWebMcpTools,
  invokeWebMcpTool,
  type WebMcpDiscoveryHandle,
  type WebMcpInvocationResult,
} from "./webMcp";
import {
  beginBrowserNavigation,
  getBrowserNavigationTracker,
  stopBrowserNavigation,
  type BrowserNavigationMark,
  type BrowserNavigationObservation,
} from "./navigationTracker";

const MAX_IDEMPOTENCY_ENTRIES = 512;
const IDEMPOTENCY_TTL_MS = 15 * 60_000;
const MAX_IDEMPOTENCY_TOMBSTONES = 4_096;
const IDEMPOTENCY_TOMBSTONE_TTL_MS = 24 * 60 * 60_000;
const MAX_SESSION_SNAPSHOTS = 256;
const MAX_SESSION_WEB_MCP_DISCOVERIES = 256;
const WINDOW_OPEN_RECONCILIATION_TIMEOUT_MS = 2_000;
const WINDOW_OPEN_EVENT_LOOP_GRACE_MS = 16;

export interface BrowserAutomationToolRequest {
  readonly sessionId: string;
  readonly provider: string;
  readonly threadId: ThreadId;
  readonly name: BrowserToolName;
  readonly arguments: unknown;
  /** Authenticated server-resolved root, intentionally outside public tool arguments. */
  readonly workspaceRoot?: string;
  readonly signal?: AbortSignal;
}

export interface DesktopBrowserAutomationHostOptions {
  readonly requestOpenPanel?: (threadId: ThreadId) => void | Promise<void>;
}

interface SessionAffinity {
  readonly provider: string;
  readonly threadId: ThreadId;
  tabId: string | null;
}

interface IdempotencyEntry {
  readonly fingerprint: string;
  readonly result: Promise<unknown>;
  settled: boolean;
  expiresAt: number;
  readonly effecting: boolean;
}

interface IdempotencyTombstone {
  readonly fingerprint: string;
  readonly expiresAt: number;
}

const boundedMapSet = <K, V>(map: Map<K, V>, key: K, value: V, maximum: number): void => {
  map.delete(key);
  map.set(key, value);
  while (map.size > maximum) map.delete(map.keys().next().value as K);
};

const isToolName = (value: string): value is BrowserToolName =>
  (BROWSER_TOOL_NAMES as readonly string[]).includes(value);

const validateWebUrl = (value: string, effectMayHaveCommitted = false): string => {
  if (effectMayHaveCommitted && value === "about:blank") return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
    return url.href;
  } catch {
    browserHostError({
      code: "BrowserNavigationBlocked",
      retryable: false,
      phase: "navigation",
      effectMayHaveCommitted,
    });
  }
};

const sleep = (milliseconds: number, signal: AbortSignal): Promise<void> => {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
};

const raceWithSignal = <T>(operation: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
};

const waitForWindowOpenEvent = (
  operation: Promise<BrowserAutomationWindowOpenEvent>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<BrowserAutomationWindowOpenEvent | null> => {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: BrowserAutomationWindowOpenEvent | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(error);
    };
    const onAbort = () => {
      fail(abortReason(signal));
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then((event) => finish(event), fail);
  });
};

const waitOneTurnForWindowOpenEvent = (
  operation: Promise<BrowserAutomationWindowOpenEvent>,
  signal: AbortSignal,
): Promise<BrowserAutomationWindowOpenEvent | null> => {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: BrowserAutomationWindowOpenEvent | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(error);
    };
    const onAbort = () => {
      fail(abortReason(signal));
    };
    const timer = setTimeout(() => finish(null), WINDOW_OPEN_EVENT_LOOP_GRACE_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then((event) => finish(event), fail);
  });
};

interface WindowOpenObservation {
  reconcile(
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<BrowserAutomationWindowOpenEvent | null>;
  dispose(): void;
}

interface TabToolExecution {
  readonly output: unknown;
  readonly openedTabId: string | null;
  readonly oauthPopup: boolean;
}

function uncorrelatedExecution(output: unknown): TabToolExecution {
  return {
    output,
    openedTabId: null,
    oauthPopup: false,
  };
}

function browserHistoryDirection(toolName: BrowserToolName): BrowserHistoryDirection | null {
  switch (toolName) {
    case "browser_back":
      return "back";
    case "browser_forward":
      return "forward";
    case "browser_reload":
      return "reload";
    default:
      return null;
  }
}

function browserTabLifecycleState(
  tab: ThreadBrowserState["tabs"][number],
): BrowserTabsOutput["tabs"][number]["state"] {
  if (tab.lastError) {
    return "crashed";
  }
  return tab.status === "live" ? "live" : "restore-held";
}

const abortHostError = (
  signal: AbortSignal,
  fallback: BrowserAutomationHostError,
): BrowserAutomationHostError =>
  signal.reason instanceof BrowserAutomationHostError ? signal.reason : fallback;

const raceWithAbort = <T>(
  operation: Promise<T>,
  signal: AbortSignal,
  abortError: BrowserAutomationHostError,
): Promise<T> => {
  if (signal.aborted) return Promise.reject(abortHostError(signal, abortError));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortHostError(signal, abortError));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
};

export class DesktopBrowserAutomationHost {
  private readonly affinities = new Map<string, SessionAffinity>();
  private readonly idempotency = new Map<string, IdempotencyEntry>();
  private readonly idempotencyTombstones = new Map<string, IdempotencyTombstone>();
  private readonly lockTails = new Map<string, Promise<void>>();
  private readonly snapshotBySession = new Map<string, BrowserSnapshotHandle>();
  private readonly webMcpDiscoveryBySession = new Map<string, WebMcpDiscoveryHandle>();
  private readonly activeOperations = new Set<Promise<unknown>>();
  private readonly diagnostics = new BrowserDiagnosticsStore();
  private readonly requestOpenPanel: ((threadId: ThreadId) => void | Promise<void>) | undefined;
  private disposed = false;
  private disposal: Promise<void> | null = null;

  constructor(
    private readonly browserManager: DesktopBrowserManager,
    options: DesktopBrowserAutomationHostOptions = {},
  ) {
    this.requestOpenPanel = options.requestOpenPanel;
  }

  private discardWebMcpDiscovery(sessionId: string): void {
    const discovery = this.webMcpDiscoveryBySession.get(sessionId);
    if (!discovery) return;
    this.webMcpDiscoveryBySession.delete(sessionId);
    void discovery.release();
  }

  private discardWebMcpDiscoveriesForTab(threadId: ThreadId, tabId: string): void {
    for (const [sessionId, discovery] of this.webMcpDiscoveryBySession) {
      if (discovery.tabId !== tabId || this.affinities.get(sessionId)?.threadId !== threadId) {
        continue;
      }
      this.discardWebMcpDiscovery(sessionId);
    }
  }

  private storeWebMcpDiscovery(sessionId: string, discovery: WebMcpDiscoveryHandle): void {
    if (this.disposed) {
      void discovery.release();
      return;
    }
    this.discardWebMcpDiscovery(sessionId);
    this.webMcpDiscoveryBySession.set(sessionId, discovery);
    discovery.onInvalidated(() => {
      if (this.webMcpDiscoveryBySession.get(sessionId) === discovery) {
        this.webMcpDiscoveryBySession.delete(sessionId);
      }
    });
    while (this.webMcpDiscoveryBySession.size > MAX_SESSION_WEB_MCP_DISCOVERIES) {
      const oldestSessionId = this.webMcpDiscoveryBySession.keys().next().value as
        | string
        | undefined;
      if (!oldestSessionId) break;
      this.discardWebMcpDiscovery(oldestSessionId);
    }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.disposal = (async () => {
      await Promise.allSettled([...this.activeOperations]);
      const discoveries = [...this.webMcpDiscoveryBySession.values()];
      this.webMcpDiscoveryBySession.clear();
      await Promise.all(discoveries.map((discovery) => discovery.release()));
    })();
    return this.disposal;
  }

  async executeTool(request: BrowserAutomationToolRequest): Promise<unknown> {
    if (this.disposed) {
      browserHostError({
        code: "BrowserHostUnavailable",
        retryable: true,
        phase: "routing",
        effectMayHaveCommitted: false,
      });
    }
    if (!isToolName(request.name)) {
      browserHostError({
        code: "BrowserInputUnsupported",
      });
    }
    const definition = BROWSER_TOOL_DEFINITIONS_BY_NAME[request.name];
    if (
      request.name !== "browser_status" &&
      request.name !== "browser_tabs" &&
      this.browserManager.isAnnotationInteractive(request.threadId)
    ) {
      throw new BrowserAutomationHostError({
        code: "BrowserInterruptedByHuman",
        retryable: true,
        phase: "runtime",
        effectMayHaveCommitted: false,
      });
    }
    let input: Record<string, unknown>;
    try {
      input = Schema.decodeUnknownSync(definition.input as never)(request.arguments) as Record<
        string,
        unknown
      >;
    } catch {
      browserHostError({
        code: "BrowserInputUnsupported",
      });
    }
    const affinity = this.bindSession(request);
    const timeoutMs =
      typeof input.timeoutMs === "number" ? input.timeoutMs : definition.defaultTimeoutMs;
    const queuedTimeoutError = new BrowserAutomationHostError({
      code: "BrowserTimeout",
      retryable: true,
      phase: "queue",
      effectMayHaveCommitted: false,
    });
    const runtimeTimeoutError = new BrowserAutomationHostError({
      code: "BrowserTimeout",
      retryable: true,
      phase: "runtime",
      effectMayHaveCommitted: !definition.annotations.readOnlyHint,
    });
    const cancellationError = new BrowserAutomationHostError({
      code: "BrowserCancelled",
      retryable: true,
      phase: "runtime",
      effectMayHaveCommitted: !definition.annotations.readOnlyHint,
    });
    const controller = new AbortController();
    let actionStarted = false;
    const abortForTimeout = () =>
      controller.abort(actionStarted ? runtimeTimeoutError : queuedTimeoutError);
    const abortForRequest = () =>
      controller.abort(
        request.signal?.reason instanceof BrowserAutomationHostError
          ? request.signal.reason
          : cancellationError,
      );
    const interruptByHuman = (error: BrowserAutomationHostError) => controller.abort(error);
    request.signal?.addEventListener("abort", abortForRequest, { once: true });
    if (request.signal?.aborted) abortForRequest();
    const requestedTabId = typeof input.tabId === "string" ? input.tabId : affinity.tabId;
    const unsubscribeHumanControl =
      request.name === "browser_status" || request.name === "browser_tabs"
        ? undefined
        : this.browserManager.subscribeAutomationHumanControl(request.threadId, () => {
            interruptByHuman(
              new BrowserAutomationHostError({
                code: "BrowserInterruptedByHuman",
                retryable: true,
                phase: "runtime",
                effectMayHaveCommitted: !definition.annotations.readOnlyHint,
                ...(requestedTabId ? { tabId: requestedTabId as BrowserTabId } : {}),
              }),
            );
          });

    const run = (): Promise<unknown> => {
      const operation = (async () => {
        try {
          return await this.withLock(
            `session:${request.sessionId}`,
            () =>
              this.dispatch(
                request,
                input,
                affinity,
                controller.signal,
                runtimeTimeoutError,
                interruptByHuman,
                () => (actionStarted = true),
              ),
            controller.signal,
            queuedTimeoutError,
          );
        } catch (error) {
          if (error instanceof BrowserAutomationHostError) throw error;
          throw new BrowserAutomationHostError({
            code: "BrowserMalformedResponse",
            retryable: false,
            phase: "runtime",
            effectMayHaveCommitted: !definition.annotations.readOnlyHint,
          });
        }
      })();
      this.activeOperations.add(operation);
      void operation.then(
        () => this.activeOperations.delete(operation),
        () => this.activeOperations.delete(operation),
      );
      return operation;
    };
    const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey : null;
    const intentionArguments = { ...input };
    // Deadlines are transport/runtime metadata, not part of the browser
    // intention. Retries consume a smaller remaining budget by design.
    delete intentionArguments.timeoutMs;
    const fingerprint = stableJsonStringify({
      name: request.name,
      threadId: request.threadId,
      arguments: intentionArguments,
    });
    let operation: Promise<unknown>;
    if (idempotencyKey) {
      const cacheKey = `${request.sessionId}:${idempotencyKey}`;
      this.trimIdempotencyCache();
      const existing = this.idempotency.get(cacheKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          browserHostError({
            code: "BrowserRequestConflict",
            retryable: false,
            phase: "queue",
            effectMayHaveCommitted: false,
          });
        }
        this.idempotency.delete(cacheKey);
        this.idempotency.set(cacheKey, existing);
        operation = this.reconcileIdempotentReplay(request, affinity, existing.result);
      } else {
        const tombstone = this.idempotencyTombstones.get(cacheKey);
        if (tombstone) {
          if (tombstone.fingerprint !== fingerprint) {
            browserHostError({
              code: "BrowserRequestConflict",
              retryable: false,
              phase: "queue",
              effectMayHaveCommitted: false,
            });
          }
          browserHostError({ code: "BrowserAmbiguousResult" });
        }
        operation = run();
        const entry: IdempotencyEntry = {
          fingerprint,
          result: operation,
          settled: false,
          expiresAt: Number.POSITIVE_INFINITY,
          effecting: !definition.annotations.readOnlyHint,
        };
        this.idempotency.set(cacheKey, entry);
        void operation.then(
          () => {
            entry.settled = true;
            entry.expiresAt = performance.now() + IDEMPOTENCY_TTL_MS;
            this.trimIdempotencyCache();
          },
          (error: unknown) => {
            entry.settled = true;
            entry.expiresAt = performance.now() + IDEMPOTENCY_TTL_MS;
            // A confirmed pre-effect failure is safe to execute again with the
            // same intention. Ambiguous/effecting failures remain cached so a
            // retry cannot accidentally duplicate the action.
            if (
              error instanceof BrowserAutomationHostError &&
              !error.browserError.effectMayHaveCommitted &&
              this.idempotency.get(cacheKey) === entry
            ) {
              this.idempotency.delete(cacheKey);
            }
            this.trimIdempotencyCache();
          },
        );
        this.trimIdempotencyCache();
      }
    } else {
      operation = run();
    }

    const timer = setTimeout(abortForTimeout, timeoutMs);
    try {
      const output = await raceWithAbort(operation, controller.signal, queuedTimeoutError);
      try {
        return Schema.decodeUnknownSync(definition.hostOutput as never)(output);
      } catch {
        throw new BrowserAutomationHostError({
          code: "BrowserMalformedResponse",
          retryable: false,
          phase: "runtime",
          effectMayHaveCommitted: !definition.annotations.readOnlyHint,
        });
      }
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abortForRequest);
      unsubscribeHumanControl?.();
    }
  }

  private trimIdempotencyCache(): void {
    const now = performance.now();
    for (const [key, entry] of this.idempotency) {
      if (entry.settled && entry.expiresAt <= now) this.evictIdempotencyEntry(key, entry, now);
    }
    for (const [key, tombstone] of this.idempotencyTombstones) {
      if (tombstone.expiresAt <= now) this.idempotencyTombstones.delete(key);
    }
    while (this.idempotency.size > MAX_IDEMPOTENCY_ENTRIES) {
      const settled = [...this.idempotency].find(([, entry]) => entry.settled);
      // In-flight operations are operation identity, not a disposable cache.
      // Allow a temporary overshoot until one settles rather than admitting a
      // duplicate browser action under pressure.
      if (!settled) break;
      this.evictIdempotencyEntry(settled[0], settled[1], now);
    }
    while (this.idempotencyTombstones.size > MAX_IDEMPOTENCY_TOMBSTONES) {
      this.idempotencyTombstones.delete(this.idempotencyTombstones.keys().next().value as string);
    }
  }

  private evictIdempotencyEntry(key: string, entry: IdempotencyEntry, now: number): void {
    this.idempotency.delete(key);
    if (!entry.effecting) return;
    this.idempotencyTombstones.delete(key);
    this.idempotencyTombstones.set(key, {
      fingerprint: entry.fingerprint,
      expiresAt: now + IDEMPOTENCY_TOMBSTONE_TTL_MS,
    });
  }

  private async reconcileIdempotentReplay(
    request: BrowserAutomationToolRequest,
    affinity: SessionAffinity,
    result: Promise<unknown>,
  ): Promise<unknown> {
    const output = await result;
    if (request.name === "browser_snapshot") {
      const envelope =
        output && typeof output === "object"
          ? (output as { readonly structuredContent?: { readonly snapshotId?: string } })
          : undefined;
      const replayedSnapshotId = envelope?.structuredContent?.snapshotId;
      const currentSnapshot = this.snapshotBySession.get(request.sessionId);
      if (!replayedSnapshotId || currentSnapshot?.snapshotId !== replayedSnapshotId) {
        throw new BrowserAutomationHostError({
          code: "BrowserStaleReference",
          retryable: false,
          phase: "snapshot",
          effectMayHaveCommitted: false,
          ...(currentSnapshot ? { tabId: currentSnapshot.tabId as BrowserTabId } : {}),
        });
      }
    }
    if (output && typeof output === "object" && "tabId" in output) {
      const replayedTabId = (output as { readonly tabId?: unknown }).tabId;
      if (typeof replayedTabId === "string" && affinity.tabId !== replayedTabId) {
        throw new BrowserAutomationHostError({
          code: "BrowserReconciliationRequired",
          tabId: replayedTabId as BrowserTabId,
        });
      }
    }
    return output;
  }

  private bindSession(request: BrowserAutomationToolRequest): SessionAffinity {
    const existing = this.affinities.get(request.sessionId);
    if (existing) {
      if (existing.provider !== request.provider) {
        browserHostError({
          code: "BrowserProviderProcessMismatch",
          retryable: false,
          phase: "routing",
          effectMayHaveCommitted: false,
        });
      }
      if (existing.threadId !== request.threadId) {
        browserHostError({
          code: "BrowserTabScopeViolation",
          retryable: false,
          phase: "routing",
          effectMayHaveCommitted: false,
        });
      }
      return existing;
    }
    const affinity: SessionAffinity = {
      provider: request.provider,
      threadId: request.threadId,
      tabId: null,
    };
    // Session identities are random, backend-authenticated capabilities. Keep
    // their provider/thread binding immutable for the desktop process lifetime:
    // evicting a binding would let an old session id be rebound after enough
    // unrelated sessions, violating the routing boundary.
    this.affinities.set(request.sessionId, affinity);
    return affinity;
  }

  private async withLock<T>(
    key: string,
    action: () => Promise<T>,
    signal?: AbortSignal,
    abortError?: BrowserAutomationHostError,
  ): Promise<T> {
    const previous = this.lockTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => tail);
    this.lockTails.set(key, chain);
    try {
      if (signal && abortError) await raceWithAbort(previous, signal, abortError);
      else await previous;
      if (signal?.aborted && abortError) throw abortHostError(signal, abortError);
      // Do not race the action here. executeTool already races the public result,
      // while this internal promise must drain before releasing the lock so a
      // late Electron/CDP completion can never overlap the next browser action.
      return await action();
    } finally {
      release();
      void chain.finally(() => {
        if (this.lockTails.get(key) === chain) this.lockTails.delete(key);
      });
    }
  }

  private withVisibilityLock<T>(
    threadId: ThreadId,
    signal: AbortSignal,
    abortError: BrowserAutomationHostError,
    action: () => Promise<T>,
  ): Promise<T> {
    return this.withLock(`visibility:${threadId}`, action, signal, abortError);
  }

  private async withHumanControlGuard<T>(
    threadId: ThreadId,
    tabId: string,
    effectMayHaveCommitted: boolean,
    signal: AbortSignal,
    interrupt: (error: BrowserAutomationHostError) => void,
    action: () => Promise<T> | T,
  ): Promise<T> {
    const epoch = this.browserManager.getAutomationHumanControlEpoch(threadId);
    const humanError = new BrowserAutomationHostError({
      code: "BrowserInterruptedByHuman",
      retryable: true,
      phase: "runtime",
      effectMayHaveCommitted,
      tabId: tabId as BrowserTabId,
    });
    try {
      if (this.browserManager.getAutomationHumanControlEpoch(threadId) !== epoch) {
        interrupt(humanError);
      }
      throwIfAborted(signal);
      const result = await action();
      if (this.browserManager.getAutomationHumanControlEpoch(threadId) !== epoch) {
        interrupt(humanError);
      }
      throwIfAborted(signal);
      return result;
    } catch (error) {
      if (this.browserManager.getAutomationHumanControlEpoch(threadId) !== epoch) {
        interrupt(humanError);
      }
      if (signal.aborted) throw abortReason(signal);
      throw error;
    }
  }

  private async withDownloadGuard<T>(
    threadId: ThreadId,
    tabId: string,
    signal: AbortSignal,
    interrupt: (error: BrowserAutomationHostError) => void,
    action: () => Promise<T> | T,
  ): Promise<T> {
    const downloadError = new BrowserAutomationHostError({
      code: "BrowserDownloadApprovalRequired",
      retryable: false,
      phase: "input",
      effectMayHaveCommitted: true,
      tabId: tabId as BrowserTabId,
    });
    const releaseTracking = this.browserManager.trackAutomationDownload({ threadId, tabId }, () =>
      interrupt(downloadError),
    );
    try {
      const result = await action();
      // CDP acknowledges native input before Electron necessarily emits the
      // resulting session event. Keep the gesture lease through one main-loop
      // turn so a download cannot escape between command completion and cleanup.
      await sleep(0, signal);
      throwIfAborted(signal);
      return result;
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      throw error;
    } finally {
      releaseTracking();
    }
  }

  private withDownloadGuardIfEffecting<T>(
    toolName: BrowserToolName,
    threadId: ThreadId,
    tabId: string,
    signal: AbortSignal,
    interrupt: (error: BrowserAutomationHostError) => void,
    action: () => Promise<T> | T,
  ): Promise<T> {
    if (BROWSER_TOOL_DEFINITIONS_BY_NAME[toolName].annotations.readOnlyHint) {
      return Promise.resolve().then(action);
    }
    return this.withDownloadGuard(threadId, tabId, signal, interrupt, action);
  }

  private resolveTabId(affinity: SessionAffinity, requested: unknown): string {
    const state = this.browserManager.getState({ threadId: affinity.threadId });
    const tabId = typeof requested === "string" ? requested : (affinity.tabId ?? state.activeTabId);
    if (!tabId || !state.tabs.some((tab) => tab.id === tabId)) {
      browserHostError({
        code: "BrowserTabNotFound",
        retryable: false,
        phase: "routing",
        effectMayHaveCommitted: false,
      });
    }
    affinity.tabId = tabId;
    return tabId;
  }

  private async resolveAutomationRuntime(
    affinity: SessionAffinity,
    tabId: string,
    signal: AbortSignal,
    reveal: boolean,
    restore = true,
  ): Promise<BrowserAutomationVisibleRuntime> {
    throwIfAborted(signal);
    this.browserManager.selectAutomationTab({ threadId: affinity.threadId, tabId });
    throwIfAborted(signal);
    if (reveal) this.requestPanelReveal(affinity.threadId);
    throwIfAborted(signal);
    try {
      const runtime = await raceWithSignal(
        this.browserManager.getAutomationRuntime(
          { threadId: affinity.threadId, tabId },
          { restore },
        ),
        signal,
      );
      throwIfAborted(signal);
      await this.diagnostics.observe(runtime, signal);
      return runtime;
    } catch {
      throwIfAborted(signal);
      browserHostError({
        code: "BrowserHostUnavailable",
        retryable: true,
        phase: "runtime",
        effectMayHaveCommitted: false,
        tabId: tabId as BrowserTabId,
      });
    }
  }

  private requestPanelReveal(threadId: ThreadId): void {
    if (!this.requestOpenPanel) return;
    // Revealing is opportunistic UI feedback, not a prerequisite for browser
    // execution. The renderer opens the panel only when this thread is already
    // active; a slow/backgrounded UI must never stall the agent runtime.
    try {
      void Promise.resolve(this.requestOpenPanel(threadId)).catch(() => undefined);
    } catch {
      // The persistent native runtime remains usable when the shell cannot reveal it.
    }
  }

  private observeWindowOpen(runtime: BrowserAutomationVisibleRuntime): WindowOpenObservation {
    let pageAnnouncedWindowOpen = false;
    let observedEvent: BrowserAutomationWindowOpenEvent | null = null;
    let resolveEvent!: (event: BrowserAutomationWindowOpenEvent) => void;
    const eventPromise = new Promise<BrowserAutomationWindowOpenEvent>((resolve) => {
      resolveEvent = resolve;
    });
    const onDebuggerMessage = (...args: unknown[]) => {
      if (args[1] === "Page.windowOpen") pageAnnouncedWindowOpen = true;
    };
    runtime.webContents.debugger.on("message", onDebuggerMessage);
    const releaseManagerTracking = this.browserManager.trackAutomationWindowOpen(
      { threadId: runtime.threadId, tabId: runtime.tabId },
      (event) => {
        if (observedEvent) return;
        observedEvent = event;
        resolveEvent(event);
      },
    );
    let disposed = false;
    return {
      reconcile: (timeoutMs, signal) => {
        if (observedEvent) return Promise.resolve(observedEvent);
        // CDP announces link/window activation before Electron reconciles the
        // denied child into Synara's visible tab model. Only that path waits;
        // ordinary clicks return immediately with no fixed grace period.
        if (!pageAnnouncedWindowOpen) {
          return waitOneTurnForWindowOpenEvent(eventPromise, signal);
        }
        return waitForWindowOpenEvent(eventPromise, timeoutMs, signal);
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        runtime.webContents.debugger.off("message", onDebuggerMessage);
        releaseManagerTracking();
      },
    };
  }

  private async reconcileWindowOpen(
    observation: WindowOpenObservation,
    timeoutMs: number | undefined,
    targetTabId: string,
    signal: AbortSignal,
  ): Promise<Pick<TabToolExecution, "openedTabId" | "oauthPopup">> {
    const event = await observation.reconcile(
      Math.min(
        timeoutMs ?? WINDOW_OPEN_RECONCILIATION_TIMEOUT_MS,
        WINDOW_OPEN_RECONCILIATION_TIMEOUT_MS,
      ),
      signal,
    );
    if (event?.kind === "tab") {
      return { openedTabId: event.openedTabId, oauthPopup: false };
    }
    if (event?.kind === "popup") {
      return { openedTabId: null, oauthPopup: true };
    }
    if (event?.kind === "blocked") {
      browserHostError({
        code: "BrowserPopupBlocked",
        retryable: false,
        phase: "navigation",
        effectMayHaveCommitted: true,
        tabId: targetTabId as BrowserTabId,
      });
    }
    return { openedTabId: null, oauthPopup: false };
  }

  private async dispatch(
    request: BrowserAutomationToolRequest,
    input: Record<string, unknown>,
    affinity: SessionAffinity,
    signal: AbortSignal,
    abortError: BrowserAutomationHostError,
    interruptByHuman: (error: BrowserAutomationHostError) => void,
    markActionStarted: () => void,
  ): Promise<unknown> {
    switch (request.name) {
      case "browser_status":
        return this.status(affinity);
      case "browser_tabs":
        return this.tabs(affinity);
      case "browser_open":
        this.snapshotBySession.delete(request.sessionId);
        this.discardWebMcpDiscovery(request.sessionId);
        return this.open(
          affinity,
          input as BrowserToolOpenInput,
          signal,
          abortError,
          interruptByHuman,
          markActionStarted,
        );
    }

    const annotationTarget =
      request.name === "browser_navigate" && typeof input.annotationId === "string"
        ? this.browserManager.resolveAnnotationNavigationTarget({
            threadId: affinity.threadId,
            annotationId: input.annotationId,
            ...(typeof input.tabId === "string" ? { tabId: input.tabId } : {}),
          })
        : null;
    if (request.name === "browser_navigate" && typeof input.annotationId === "string") {
      if (!annotationTarget) {
        browserHostError({
          code: "BrowserNavigationBlocked",
          retryable: false,
          phase: "navigation",
          effectMayHaveCommitted: false,
        });
      }
      affinity.tabId = annotationTarget.tabId;
    }
    const targetTabId = annotationTarget?.tabId ?? this.resolveTabId(affinity, input.tabId);
    return this.withLock(
      `tab:${affinity.threadId}:${targetTabId}`,
      () =>
        this.withVisibilityLock(affinity.threadId, signal, abortError, async () => {
          const execution = await this.withHumanControlGuard(
            affinity.threadId,
            targetTabId,
            !BROWSER_TOOL_DEFINITIONS_BY_NAME[request.name].annotations.readOnlyHint,
            signal,
            interruptByHuman,
            () => {
              markActionStarted();
              return this.executeTabTool(
                request,
                input,
                affinity,
                targetTabId,
                signal,
                interruptByHuman,
              );
            },
          );
          return this.reconcileTabToolExecution(request, affinity, targetTabId, execution);
        }),
      signal,
      abortError,
    );
  }

  private async executeTabTool(
    request: BrowserAutomationToolRequest,
    input: Record<string, unknown>,
    affinity: SessionAffinity,
    targetTabId: string,
    signal: AbortSignal,
    interruptByHuman: (error: BrowserAutomationHostError) => void,
  ): Promise<TabToolExecution> {
    throwIfAborted(signal);
    if (request.name === "browser_close") {
      this.snapshotBySession.delete(request.sessionId);
      this.discardWebMcpDiscoveriesForTab(affinity.threadId, targetTabId);
      return uncorrelatedExecution(this.close(affinity, targetTabId));
    }

    return this.withDownloadGuardIfEffecting(
      request.name,
      affinity.threadId,
      targetTabId,
      signal,
      interruptByHuman,
      () => this.executeDownloadGuardedTabTool(request, input, affinity, targetTabId, signal),
    );
  }

  private async executeDownloadGuardedTabTool(
    request: BrowserAutomationToolRequest,
    input: Record<string, unknown>,
    affinity: SessionAffinity,
    targetTabId: string,
    signal: AbortSignal,
  ): Promise<TabToolExecution> {
    if (request.name === "browser_navigate") {
      const navigateInput = input as BrowserToolNavigateInput;
      const resolvedUrl =
        navigateInput.annotationId === undefined
          ? navigateInput.url
          : this.browserManager.resolveAnnotationNavigationTarget({
              threadId: affinity.threadId,
              tabId: targetTabId,
              annotationId: navigateInput.annotationId,
            })?.url;
      if (!resolvedUrl) {
        browserHostError({
          code: "BrowserNavigationBlocked",
          retryable: false,
          phase: "navigation",
          tabId: targetTabId as BrowserTabId,
          effectMayHaveCommitted: false,
        });
      }
      const url = validateWebUrl(resolvedUrl);
      this.snapshotBySession.delete(request.sessionId);
      this.discardWebMcpDiscoveriesForTab(affinity.threadId, targetTabId);
      this.browserManager.prepareAutomationNavigation({
        threadId: affinity.threadId,
        tabId: targetTabId,
        url,
      });
      const runtime = await this.resolveAutomationRuntime(
        affinity,
        targetTabId,
        signal,
        true,
        false,
      );
      return uncorrelatedExecution(
        await this.withDialogs(runtime, signal, () =>
          this.navigate(runtime, navigateInput, url, signal),
        ),
      );
    }

    const historyDirection = browserHistoryDirection(request.name);
    if (historyDirection) {
      this.snapshotBySession.delete(request.sessionId);
      this.discardWebMcpDiscoveriesForTab(affinity.threadId, targetTabId);
      const runtime = await this.resolveAutomationRuntime(affinity, targetTabId, signal, true);
      return uncorrelatedExecution(
        await this.withDialogs(runtime, signal, () =>
          navigateBrowserHistory(
            runtime,
            historyDirection,
            input as BrowserBackInput | BrowserForwardInput | BrowserReloadInput,
            signal,
          ),
        ),
      );
    }

    const runtime = await this.resolveAutomationRuntime(affinity, targetTabId, signal, true);
    let snapshot = this.snapshotBySession.get(request.sessionId);
    if (
      snapshot &&
      snapshot.humanControlEpoch !==
        this.browserManager.getAutomationHumanControlEpoch(affinity.threadId)
    ) {
      this.snapshotBySession.delete(request.sessionId);
      snapshot = undefined;
    }
    const windowOpen =
      request.name === "browser_click" ||
      request.name === "browser_press" ||
      request.name === "browser_webmcp_call"
        ? this.observeWindowOpen(runtime)
        : null;
    try {
      return await this.executeVisibleTool(
        request,
        input,
        affinity,
        targetTabId,
        runtime,
        snapshot,
        windowOpen,
        signal,
      );
    } finally {
      // Releasing the correlation commits a reserved target=_blank tab. Keep
      // the source guest alive until dialog handling has drained and restored
      // every CDP shim used by this input action.
      windowOpen?.dispose();
    }
  }

  private async executeVisibleTool(
    request: BrowserAutomationToolRequest,
    input: Record<string, unknown>,
    affinity: SessionAffinity,
    targetTabId: string,
    runtime: BrowserAutomationVisibleRuntime,
    snapshot: BrowserSnapshotHandle | undefined,
    windowOpen: WindowOpenObservation | null,
    signal: AbortSignal,
  ): Promise<TabToolExecution> {
    let openedTabId: string | null = null;
    let oauthPopup = false;
    const output = await this.withDialogs(runtime, signal, async () => {
      switch (request.name) {
        case "browser_resize":
          return this.resize(runtime, input as BrowserResizeInput, request.sessionId, signal);
        case "browser_snapshot": {
          const capture = await captureSemanticSnapshot(
            runtime,
            {
              ...(input as BrowserSnapshotInput),
              includeImage: (input as BrowserSnapshotInput).includeImage ?? false,
              includeDiagnostics: (input as BrowserSnapshotInput).includeDiagnostics ?? true,
              humanControlEpoch: this.browserManager.getAutomationHumanControlEpoch(
                affinity.threadId,
              ),
            },
            signal,
          );
          throwIfAborted(signal);
          boundedMapSet(
            this.snapshotBySession,
            request.sessionId,
            capture.handle,
            MAX_SESSION_SNAPSHOTS,
          );
          return capture.output;
        }
        case "browser_webmcp_tools": {
          const discovery = await discoverWebMcpTools(
            runtime,
            input as BrowserWebMcpToolsInput,
            this.browserManager.getAutomationHumanControlEpoch(affinity.threadId),
            signal,
          );
          if (discovery.handle) {
            this.storeWebMcpDiscovery(request.sessionId, discovery.handle);
          } else {
            this.discardWebMcpDiscovery(request.sessionId);
          }
          return discovery.output;
        }
        case "browser_webmcp_call": {
          const callInput = input as BrowserWebMcpCallInput;
          const discovery = this.webMcpDiscoveryBySession.get(request.sessionId);
          if (!discovery) {
            browserHostError({ code: "BrowserWebMcpDiscoveryStale" });
          }
          if (
            discovery.humanControlEpoch !==
            this.browserManager.getAutomationHumanControlEpoch(affinity.threadId)
          ) {
            this.discardWebMcpDiscovery(request.sessionId);
            browserHostError({ code: "BrowserWebMcpDiscoveryStale" });
          }
          const entry = discovery.entries.get(callInput.toolId);
          if (
            !entry ||
            discovery.discoveryId !== callInput.discoveryId ||
            discovery.tabId !== runtime.tabId
          ) {
            browserHostError({ code: "BrowserWebMcpDiscoveryStale" });
          }
          const navigationTracker = await getBrowserNavigationTracker(runtime, signal);
          const navigationMark = navigationTracker.mark();
          let invocation: WebMcpInvocationResult;
          try {
            invocation = await invokeWebMcpTool(runtime, callInput, discovery, signal);
          } catch (error) {
            if (
              error instanceof BrowserAutomationHostError &&
              error.browserError.code === "BrowserWebMcpDiscoveryStale"
            ) {
              this.discardWebMcpDiscovery(request.sessionId);
            }
            throw error;
          }
          const windowOpenResult = await this.reconcileWindowOpen(
            windowOpen!,
            input.timeoutMs as number | undefined,
            targetTabId,
            signal,
          );
          openedTabId = windowOpenResult.openedTabId;
          oauthPopup = windowOpenResult.oauthPopup;
          await Promise.resolve();
          const navigated = navigationTracker.hasNavigationStartedSince(navigationMark);
          let finalUrl = validateWebUrl(runtime.webContents.getURL(), true);
          let redirects: string[] = [];
          let loadState: BrowserWebMcpCallOutput["loadState"];
          if (navigated) {
            const navigation = await this.waitForNavigation(
              runtime,
              navigationTracker,
              navigationMark,
              "commit",
              (input.timeoutMs as number | undefined) ?? 15_000,
              signal,
            );
            finalUrl = validateWebUrl(navigation.url, true);
            redirects = navigation.redirects
              .map((redirect) => validateWebUrl(redirect, true))
              .slice(0, 20);
            loadState = navigation.state;
            this.discardWebMcpDiscoveriesForTab(affinity.threadId, targetTabId);
            this.snapshotBySession.delete(request.sessionId);
          }
          return {
            tabId: runtime.tabId as BrowserTabId,
            discoveryId: callInput.discoveryId,
            toolId: callInput.toolId,
            toolName: entry.name,
            contentTrust: "untrusted-web-page" as const,
            ...invocation,
            finalUrl,
            navigated,
            redirects,
            ...(loadState ? { loadState } : {}),
          } satisfies BrowserWebMcpCallOutput;
        }
        case "browser_screenshot":
          return captureBrowserScreenshot(runtime, input as BrowserScreenshotInput, signal);
        case "browser_logs":
          return this.diagnostics.read(runtime, input as BrowserLogsInput, signal);
        case "browser_click": {
          const navigationTracker = await getBrowserNavigationTracker(runtime, signal);
          const navigationMark = navigationTracker.mark();
          const clicked = await clickBrowserTarget(
            runtime,
            input as BrowserClickInput,
            snapshot,
            signal,
          );
          const windowOpenResult = await this.reconcileWindowOpen(
            windowOpen!,
            input.timeoutMs as number | undefined,
            targetTabId,
            signal,
          );
          openedTabId = windowOpenResult.openedTabId;
          oauthPopup = windowOpenResult.oauthPopup;
          // A DOM activation initiates same-document and cross-document
          // navigation synchronously. Reconcile CDP events already emitted by
          // that activation so the result never reports the old URL.
          await Promise.resolve();
          if (!navigationTracker.hasNavigationStartedSince(navigationMark)) return clicked;
          const navigation = await this.waitForNavigation(
            runtime,
            navigationTracker,
            navigationMark,
            "commit",
            (input.timeoutMs as number | undefined) ?? 15_000,
            signal,
          );
          this.discardWebMcpDiscoveriesForTab(affinity.threadId, targetTabId);
          return {
            ...clicked,
            finalUrl: validateWebUrl(navigation.url, true),
            redirects: navigation.redirects
              .map((redirect) => validateWebUrl(redirect, true))
              .slice(0, 20),
            loadState: navigation.state,
          };
        }
        case "browser_hover":
          return hoverBrowserTarget(runtime, input as BrowserHoverInput, snapshot, signal);
        case "browser_drag":
          return dragBrowserTarget(runtime, input as BrowserDragInput, snapshot, signal);
        case "browser_type":
          return typeIntoBrowserTarget(runtime, input as BrowserTypeInput, snapshot, signal);
        case "browser_select":
          return selectBrowserTarget(runtime, input as BrowserSelectInput, snapshot, signal);
        case "browser_upload":
          return uploadBrowserFiles(
            runtime,
            input as BrowserUploadInput,
            snapshot,
            request.workspaceRoot,
            signal,
          );
        case "browser_press": {
          const pressed = await pressBrowserKeys(runtime, input as BrowserPressInput, signal);
          const windowOpenResult = await this.reconcileWindowOpen(
            windowOpen!,
            input.timeoutMs as number | undefined,
            targetTabId,
            signal,
          );
          openedTabId = windowOpenResult.openedTabId;
          oauthPopup = windowOpenResult.oauthPopup;
          return pressed;
        }
        case "browser_scroll":
          return scrollBrowser(runtime, input as BrowserScrollInput, snapshot, signal);
        case "browser_wait":
          return waitForBrowserConditions(
            runtime,
            input as BrowserWaitInput,
            snapshot,
            (input.timeoutMs as number | undefined) ?? 15_000,
            signal,
          );
        case "browser_evaluate":
          return evaluateBrowserExpression(runtime, input as BrowserEvaluateInput, signal);
        default:
          browserHostError({ code: "BrowserInputUnsupported" });
      }
    });
    return { output, openedTabId, oauthPopup };
  }

  private reconcileTabToolExecution(
    request: BrowserAutomationToolRequest,
    affinity: SessionAffinity,
    targetTabId: string,
    execution: TabToolExecution,
  ): unknown {
    const result = execution.output;
    if (
      request.name !== "browser_click" &&
      request.name !== "browser_press" &&
      request.name !== "browser_webmcp_call"
    ) {
      return result;
    }

    const reconciledResult =
      execution.oauthPopup && result !== null && typeof result === "object"
        ? {
            ...result,
            humanActionRequired: {
              kind: "oauth_popup" as const,
              instruction: "Complete sign-in in the visible popup before continuing." as const,
            },
          }
        : result;
    const state = this.browserManager.getState({ threadId: affinity.threadId });
    const openedTabId = execution.openedTabId ?? state.activeTabId;
    if (
      !openedTabId ||
      openedTabId === targetTabId ||
      !state.tabs.some((tab) => tab.id === openedTabId)
    ) {
      return reconciledResult;
    }
    // BrowserManager changes activeTabId without advancing the human epoch only
    // for a new tab created inside the short-lived agent gesture lease. Adopt
    // it after the human guard has successfully reconciled.
    affinity.tabId = openedTabId;
    this.snapshotBySession.delete(request.sessionId);
    this.discardWebMcpDiscovery(request.sessionId);
    return reconciledResult && typeof reconciledResult === "object"
      ? { ...reconciledResult, openedTabId: openedTabId as BrowserTabId }
      : reconciledResult;
  }

  private status(affinity: SessionAffinity): BrowserStatusOutput {
    return {
      available: true,
      physicalScope: "visible-shared-electron-webview",
      assignedTabId: affinity.tabId as BrowserTabId | null,
      authorization: "not-required",
    };
  }

  private tabs(affinity: SessionAffinity): BrowserTabsOutput {
    const state = this.browserManager.getState({ threadId: affinity.threadId });
    return {
      tabs: state.tabs.slice(0, 24).map((tab) => ({
        tabId: tab.id as BrowserTabId,
        title: tab.title,
        url: tab.lastCommittedUrl ?? tab.url,
        active: state.activeTabId === tab.id,
        loading: tab.isLoading,
        routable: state.open,
        state: browserTabLifecycleState(tab),
      })),
      activeTabId: state.activeTabId as BrowserTabId | null,
      assignedTabId: affinity.tabId as BrowserTabId | null,
    };
  }

  private async open(
    affinity: SessionAffinity,
    input: BrowserToolOpenInput,
    signal: AbortSignal,
    abortError: BrowserAutomationHostError,
    interruptByHuman: (error: BrowserAutomationHostError) => void,
    markActionStarted: () => void,
  ): Promise<BrowserOpenOutput> {
    throwIfAborted(signal);
    const url = input.url === undefined ? undefined : validateWebUrl(input.url);
    const show = input.show ?? true;
    const before = this.browserManager.getState({ threadId: affinity.threadId });
    const hiddenTabId = !show && (input.reuse ?? true) ? before.activeTabId : null;
    if (!show) {
      if (!hiddenTabId) {
        browserHostError({
          code: "BrowserHostUnavailable",
          retryable: true,
          phase: "runtime",
          effectMayHaveCommitted: false,
        });
      }
    }
    throwIfAborted(signal);
    // A hidden open may only use the tab proven visible below, under both the
    // per-tab lock and the human-control guard. Preparing browser state here
    // would reopen, select, or create a renderer before that proof succeeds.
    const prepared = show
      ? await this.withVisibilityLock(affinity.threadId, signal, abortError, async () => {
          markActionStarted();
          return this.browserManager.prepareAutomationTab({
            threadId: affinity.threadId,
            reuse: input.reuse ?? true,
          });
        })
      : before;
    const selected = show ? prepared.activeTabId : hiddenTabId;
    if (!selected) throw new Error("Browser open did not create a tab.");
    const disposition = before.tabs.some((tab) => tab.id === selected) ? "reused" : "created";
    return this.withLock(
      `tab:${affinity.threadId}:${selected}`,
      () =>
        this.withHumanControlGuard(
          affinity.threadId,
          selected,
          true,
          signal,
          interruptByHuman,
          async () => {
            throwIfAborted(signal);
            if (!show) {
              // Keep the potentially slow diagnostics preflight outside the
              // visibility lease. The state is revalidated under that lease
              // immediately before any hidden mutation below.
              await this.resolveAutomationRuntime(affinity, selected, signal, false);
            }
            const executeOpen = async (): Promise<BrowserOpenOutput> => {
              markActionStarted();
              if (!show) {
                const visibleState = this.browserManager.getState({ threadId: affinity.threadId });
                if (
                  visibleState.activeTabId !== selected ||
                  !visibleState.tabs.some((tab) => tab.id === selected)
                ) {
                  browserHostError({
                    code: "BrowserHostUnavailable",
                    retryable: true,
                    phase: "runtime",
                    effectMayHaveCommitted: false,
                    tabId: selected as BrowserTabId,
                  });
                }
              } else if (!url) {
                // prepareAutomationTab runs before the per-tab lease is known.
                // Reassert its selection now that the thread visibility lease
                // protects this open from every other provider session.
                this.browserManager.selectAutomationTab({
                  threadId: affinity.threadId,
                  tabId: selected,
                });
              }
              affinity.tabId = selected;
              if (!url) {
                if (show) this.requestPanelReveal(affinity.threadId);
                throwIfAborted(signal);
                const tab = prepared.tabs.find((candidate) => candidate.id === selected);
                return {
                  tabId: selected as BrowserTabId,
                  finalUrl: tab?.lastCommittedUrl ?? tab?.url ?? "about:blank",
                  redirects: [],
                  loadState: "load" as const,
                  disposition,
                };
              }
              return this.withDownloadGuard(
                affinity.threadId,
                selected,
                signal,
                interruptByHuman,
                async () => {
                  this.browserManager.prepareAutomationNavigation({
                    threadId: affinity.threadId,
                    tabId: selected,
                    url,
                  });
                  const runtime = await this.resolveAutomationRuntime(
                    affinity,
                    selected,
                    signal,
                    show,
                    false,
                  );
                  return this.withDialogs(runtime, signal, async () => {
                    const loaded = await this.navigateOrObserve(
                      runtime,
                      url,
                      "domcontentloaded",
                      input.timeoutMs ?? 15_000,
                      signal,
                    );
                    return {
                      tabId: selected as BrowserTabId,
                      finalUrl: validateWebUrl(loaded.url, true),
                      redirects: loaded.redirects
                        .map((redirect) => validateWebUrl(redirect, true))
                        .slice(0, 20),
                      loadState: loaded.state,
                      disposition,
                    };
                  });
                },
              );
            };
            return this.withVisibilityLock(affinity.threadId, signal, abortError, executeOpen);
          },
        ),
      signal,
      abortError,
    );
  }

  private async navigate(
    runtime: BrowserAutomationVisibleRuntime,
    input: BrowserToolNavigateInput,
    url: string,
    signal: AbortSignal,
  ): Promise<BrowserNavigateOutput> {
    throwIfAborted(signal);
    const loaded = await this.navigateOrObserve(
      runtime,
      url,
      input.waitUntil ?? "domcontentloaded",
      input.timeoutMs ?? 15_000,
      signal,
    );
    return {
      tabId: runtime.tabId as BrowserTabId,
      finalUrl: validateWebUrl(loaded.url, true),
      redirects: loaded.redirects.map((redirect) => validateWebUrl(redirect, true)).slice(0, 20),
      loadState: loaded.state,
    };
  }

  private async navigateOrObserve(
    runtime: BrowserAutomationVisibleRuntime,
    url: string,
    expected: "commit" | "domcontentloaded" | "load" | "networkidle",
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<BrowserNavigationObservation> {
    if (runtime.webContents.getURL() !== url) {
      const navigation = await beginBrowserNavigation(runtime, url, signal);
      return this.waitForNavigation(
        runtime,
        navigation.tracker,
        navigation.mark,
        expected,
        timeoutMs,
        signal,
      );
    }
    return waitForLoadMilestone(runtime, expected, timeoutMs, signal);
  }

  private async waitForNavigation(
    runtime: BrowserAutomationVisibleRuntime,
    tracker: Awaited<ReturnType<typeof getBrowserNavigationTracker>>,
    mark: BrowserNavigationMark,
    expected: "commit" | "domcontentloaded" | "load" | "networkidle",
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<BrowserNavigationObservation> {
    try {
      return await tracker.wait(runtime, expected, timeoutMs, signal, mark);
    } catch (error) {
      if (signal.aborted) {
        // The public call is already rejected by executeTool's abort race, but
        // hold the tab lock until Chromium has acknowledged stopLoading.
        await stopBrowserNavigation(runtime);
        throw abortReason(signal);
      }
      throw error;
    }
  }

  private async withDialogs<T>(
    runtime: BrowserAutomationVisibleRuntime,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    const handled = await withDialogHandling(runtime, operation, signal);
    if (handled.dialogs.length === 0 || !handled.value || typeof handled.value !== "object") {
      return handled.value;
    }
    const value = handled.value as Record<string, unknown>;
    const structured = value.structuredContent;
    if (structured && typeof structured === "object" && !Array.isArray(structured)) {
      return {
        ...value,
        structuredContent: {
          ...(structured as Record<string, unknown>),
          dialogs: [...handled.dialogs],
        },
      } as T;
    }
    return { ...value, dialogs: [...handled.dialogs] } as T;
  }

  private async resize(
    runtime: BrowserAutomationVisibleRuntime,
    input: BrowserResizeInput,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<BrowserResizeOutput> {
    this.snapshotBySession.delete(sessionId);
    const page = await observePage(runtime, signal);
    await sendCdpCommand(
      runtime,
      "Emulation.setDeviceMetricsOverride",
      {
        width: input.width,
        height: input.height,
        deviceScaleFactor: page.viewport.deviceScaleFactor,
        mobile: false,
        screenWidth: input.width,
        screenHeight: input.height,
      },
      signal,
      { effectMayHaveCommitted: true },
    );
    const observed = await observePage(runtime, signal);
    return {
      tabId: runtime.tabId as BrowserTabId,
      requested: { width: input.width, height: input.height },
      observed: observed.viewport,
    };
  }

  private close(affinity: SessionAffinity, tabId: string): BrowserCloseOutput {
    const state: ThreadBrowserState = this.browserManager.closeAutomationTab({
      threadId: affinity.threadId,
      tabId,
    });
    affinity.tabId = state.activeTabId;
    return {
      closedTabId: tabId as BrowserTabId,
      activeTabId: state.activeTabId as BrowserTabId | null,
    };
  }
}

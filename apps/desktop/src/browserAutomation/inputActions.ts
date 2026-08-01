import type {
  BrowserClickInput,
  BrowserClickOutput,
  BrowserDragInput,
  BrowserDragOutput,
  BrowserHoverInput,
  BrowserHoverOutput,
  BrowserPointerTarget,
  BrowserPressInput,
  BrowserPressOutput,
  BrowserScrollInput,
  BrowserScrollOutput,
  BrowserSelectInput,
  BrowserSelectOutput,
  BrowserTabId,
  BrowserTypeInput,
  BrowserTypeOutput,
} from "@synara/contracts";

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { type ActionableTarget, waitForActionableTarget } from "./actionability";
import {
  callFunctionOn,
  evaluateInContext,
  loadStateForReadyState,
  observePage,
  throwIfAborted,
} from "./cdpRuntime";
import {
  ACTIVE_CREDENTIAL_INPUT_EXPRESSION,
  type BrowserCredentialInputClassification,
  CREDENTIAL_INPUT_CLASSIFIER_SNIPPET,
  credentialInputMatchFrom,
  IS_CREDENTIAL_INPUT_FUNCTION,
} from "./credentialDetection";
import { browserHostError } from "./hostErrors";
import type { BrowserSnapshotHandle } from "./semanticSnapshot";
import { releaseBrowserTarget, resolveBrowserTarget, type ResolvedBrowserTarget } from "./targets";
import {
  dispatchTrustedClick,
  dispatchTrustedDrag,
  dispatchTrustedHover,
  dispatchTrustedKeySequence,
  dispatchTrustedScroll,
  dispatchTrustedText,
  withTrustedGuestFocus,
} from "./trustedInput";

const MAX_ACTIONABILITY_WAIT_MS = 5_000;
const ACTIONABILITY_COMPLETION_HEADROOM_MS = 250;

const tabId = (runtime: BrowserAutomationVisibleRuntime): BrowserTabId =>
  runtime.tabId as BrowserTabId;

const failActionability = (
  runtime: BrowserAutomationVisibleRuntime,
  result: Exclude<Awaited<ReturnType<typeof waitForActionableTarget>>, { readonly ok: true }>,
  target: BrowserPointerTarget,
): never => {
  if (result.reason === "stale_ref") {
    browserHostError({
      code: "ref" in target ? "BrowserStaleReference" : "BrowserTargetNotFound",
      retryable: "ref" in target,
      phase: "target",
      effectMayHaveCommitted: false,
      tabId: tabId(runtime),
    });
  }
  if (result.detail === "disabled") {
    browserHostError({ code: "BrowserTargetNotEnabled", tabId: tabId(runtime) });
  }
  if (result.detail === "covered") {
    browserHostError({ code: "BrowserTargetObscured", tabId: tabId(runtime) });
  }
  if (result.detail === "not editable") {
    browserHostError({
      code: "BrowserTargetNotEditable",
      retryable: false,
      phase: "target",
      effectMayHaveCommitted: false,
      tabId: tabId(runtime),
    });
  }
  if (result.detail === "not visible" || result.detail === "outside viewport") {
    browserHostError({
      code: "BrowserTargetNotVisible",
      retryable: true,
      phase: "target",
      effectMayHaveCommitted: false,
      tabId: tabId(runtime),
    });
  }
  browserHostError({
    code: "BrowserTimeout",
    retryable: true,
    phase: "target",
    effectMayHaveCommitted: false,
    tabId: tabId(runtime),
  });
};

const actionableTarget = async (
  runtime: BrowserAutomationVisibleRuntime,
  target: ResolvedBrowserTarget,
  originalTarget: BrowserPointerTarget,
  options: {
    readonly editable?: boolean | undefined;
    readonly timeoutMs?: number | undefined;
    readonly scroll?: "center" | "nearest" | "none" | undefined;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<ActionableTarget> => {
  if (!target.objectId) {
    browserHostError({
      code: "BrowserTargetNotFound",
      retryable: false,
      phase: "target",
      effectMayHaveCommitted: false,
      tabId: tabId(runtime),
    });
  }
  const requestedTimeoutMs = Math.min(
    MAX_ACTIONABILITY_WAIT_MS,
    options.timeoutMs ?? MAX_ACTIONABILITY_WAIT_MS,
  );
  // The renderer-side actionability loop must finish before the host-level
  // tool deadline so a stable diagnostic such as disabled/covered can cross
  // the CDP and MCP boundaries instead of losing a same-deadline race to the
  // generic BrowserTimeout envelope.
  const actionabilityTimeoutMs = Math.max(
    1,
    requestedTimeoutMs -
      Math.min(ACTIONABILITY_COMPLETION_HEADROOM_MS, Math.ceil(requestedTimeoutMs / 2)),
  );
  const result = await waitForActionableTarget(runtime, target.objectId, {
    editable: options.editable,
    timeoutMs: actionabilityTimeoutMs,
    ...(originalTarget && "point" in originalTarget ? { point: originalTarget.point } : {}),
    ...(options.scroll === undefined ? {} : { scroll: options.scroll }),
    signal: options.signal,
  });
  if (!result.ok) return failActionability(runtime, result, originalTarget);
  return result.target;
};

const resolveActionableTarget = async (
  runtime: BrowserAutomationVisibleRuntime,
  target: BrowserPointerTarget,
  snapshot: BrowserSnapshotHandle | undefined,
  options: {
    readonly editable?: boolean | undefined;
    readonly timeoutMs?: number | undefined;
    readonly scroll?: "center" | "nearest" | "none" | undefined;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<{ readonly resolved: ResolvedBrowserTarget; readonly actionable: ActionableTarget }> => {
  const resolved = await resolveBrowserTarget(runtime, target, snapshot, {
    requireVisible: false,
    resolvePointElement: true,
    signal: options.signal,
  });
  try {
    return {
      resolved,
      actionable: await actionableTarget(runtime, resolved, target, options),
    };
  } catch (error) {
    await releaseBrowserTarget(runtime, resolved);
    throw error;
  }
};

export const clickBrowserTarget = async (
  runtime: BrowserAutomationVisibleRuntime,
  input: BrowserClickInput,
  snapshot: BrowserSnapshotHandle | undefined,
  signal?: AbortSignal,
): Promise<BrowserClickOutput> => {
  const pageBefore = await observePage(runtime, signal);
  const target = await resolveActionableTarget(runtime, input.target, snapshot, {
    timeoutMs: input.timeoutMs,
    signal,
  });
  try {
    await dispatchTrustedClick(
      runtime,
      target.actionable.point,
      {
        button: input.button,
        clickCount: input.clickCount,
      },
      signal,
    );
    let page = pageBefore;
    try {
      page = await observePage(runtime, signal);
    } catch {
      // target=_blank can unmount the source guest immediately. Its pre-click
      // URL remains the correct final URL for the source action; the host
      // separately follows affinity to the newly active scoped tab.
      throwIfAborted(signal);
    }
    return {
      tabId: tabId(runtime),
      finalUrl: page.url,
      redirects: [],
      loadState: loadStateForReadyState(page.readyState),
      target: target.resolved.info,
      point: target.actionable.point,
    } satisfies BrowserClickOutput;
  } finally {
    await releaseBrowserTarget(runtime, target.resolved);
  }
};

export const hoverBrowserTarget = async (
  runtime: BrowserAutomationVisibleRuntime,
  input: BrowserHoverInput,
  snapshot: BrowserSnapshotHandle | undefined,
  signal?: AbortSignal,
): Promise<BrowserHoverOutput> => {
  const target = await resolveActionableTarget(runtime, input.target, snapshot, {
    timeoutMs: input.timeoutMs,
    signal,
  });
  try {
    await dispatchTrustedHover(runtime, target.actionable.point, signal);
    return {
      tabId: tabId(runtime),
      target: target.resolved.info,
      point: target.actionable.point,
    } satisfies BrowserHoverOutput;
  } finally {
    await releaseBrowserTarget(runtime, target.resolved);
  }
};

export const dragBrowserTarget = async (
  runtime: BrowserAutomationVisibleRuntime,
  input: BrowserDragInput,
  snapshot: BrowserSnapshotHandle | undefined,
  signal?: AbortSignal,
): Promise<BrowserDragOutput> => {
  const source = await resolveActionableTarget(runtime, input.source, snapshot, {
    timeoutMs: input.timeoutMs,
    scroll: "nearest",
    signal,
  });
  let sourceActionable = source.actionable;
  let target: Awaited<ReturnType<typeof resolveActionableTarget>> | undefined;
  try {
    target = await resolveActionableTarget(runtime, input.target, snapshot, {
      timeoutMs: input.timeoutMs,
      scroll: "nearest",
      signal,
    });
    // Resolving the second endpoint may scroll the page. Recompute the source
    // without another scroll so both coordinates describe the same viewport
    // frame; otherwise a stale source point can press the drop target itself.
    sourceActionable = await actionableTarget(runtime, source.resolved, input.source, {
      timeoutMs: input.timeoutMs,
      scroll: "none",
      signal,
    });
    await dispatchTrustedDrag(
      runtime,
      sourceActionable.point,
      target.actionable.point,
      { steps: input.steps },
      signal,
    );
    return {
      tabId: tabId(runtime),
      source: { target: source.resolved.info, point: sourceActionable.point },
      target: { target: target.resolved.info, point: target.actionable.point },
    } satisfies BrowserDragOutput;
  } finally {
    if (target) await releaseBrowserTarget(runtime, target.resolved);
    await releaseBrowserTarget(runtime, source.resolved);
  }
};

const PREPARE_EDITABLE_FUNCTION = String.raw`function(append) {
  const classifyCredentialInput = ${CREDENTIAL_INPUT_CLASSIFIER_SNIPPET};
  if (!this || this.nodeType !== 1 || this.isConnected !== true) return { ok: false };
  this.focus({ preventScroll: true });
  if (document.activeElement !== this) return { ok: false };
  // A focus handler can morph the field after the host's pre-focus check (for
  // example by flipping it to type=password), so reclassify in the same
  // injected call once focus has settled.
  const credential = classifyCredentialInput(this);
  if (credential !== false) return { ok: false, credential };
  if (this.isContentEditable) {
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(this);
    // Replacement keeps the complete contents selected. Append collapses at
    // the end (false); Range.collapse(true) would incorrectly type at the
    // beginning of a contenteditable element.
    if (append === true) range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    return { ok: true };
  }
  const value = String(this.value ?? "");
  try {
    if (append === true) this.setSelectionRange(value.length, value.length);
    else if (typeof this.select === "function") this.select();
    else this.setSelectionRange(0, value.length);
  } catch { return { ok: false }; }
  return { ok: true };
}`;

const READ_EDITABLE_VALUE_FUNCTION = String.raw`function() {
  if (!this || this.nodeType !== 1 || this.isConnected !== true) return { kind: "unavailable", length: 0 };
  const raw = this.isContentEditable ? String(this.textContent || "") : String(this.value ?? "");
  const secret = String(this.getAttribute?.("type") || "").toLowerCase() === "password";
  let kind = "unavailable";
  if (secret) kind = "redacted";
  else if (raw.length === 0) kind = "empty";
  else if (raw.length <= 4096) kind = "text";
  return {
    kind,
    length: Math.min(65536, raw.length),
    value: secret || raw.length > 4096 ? undefined : raw,
  };
}`;

export const typeIntoBrowserTarget = async (
  runtime: BrowserAutomationVisibleRuntime,
  input: BrowserTypeInput,
  snapshot: BrowserSnapshotHandle | undefined,
  signal?: AbortSignal,
): Promise<BrowserTypeOutput> => {
  const target = await resolveActionableTarget(runtime, input.target, snapshot, {
    editable: true,
    timeoutMs: input.timeoutMs,
    signal,
  });
  try {
    const credentialInput = await callFunctionOn<BrowserCredentialInputClassification>(
      runtime,
      target.resolved.objectId!,
      IS_CREDENTIAL_INPUT_FUNCTION,
      { effectMayHaveCommitted: false, signal },
    );
    // Fail closed: only a literal `false` classification allows agent typing.
    if (credentialInput.value !== false) {
      browserHostError(
        {
          code: "BrowserCredentialInputRequired",
          tabId: tabId(runtime),
        },
        credentialInputMatchFrom(credentialInput.value),
      );
    }
    const prepared = await callFunctionOn<{
      readonly ok?: boolean;
      readonly credential?: BrowserCredentialInputClassification;
    }>(runtime, target.resolved.objectId!, PREPARE_EDITABLE_FUNCTION, {
      arguments: [input.append ?? false],
      effectMayHaveCommitted: true,
      signal,
    });
    if (prepared.value?.credential !== undefined && prepared.value.credential !== false) {
      browserHostError(
        {
          code: "BrowserCredentialInputRequired",
          tabId: tabId(runtime),
        },
        credentialInputMatchFrom(prepared.value.credential),
      );
    }
    if (prepared.value?.ok !== true) {
      browserHostError({
        code: "BrowserTargetNotEditable",
        retryable: false,
        phase: "target",
        effectMayHaveCommitted: false,
        tabId: tabId(runtime),
      });
    }
    // The prepare step runs page-visible focus handlers, so re-check the
    // focused element the trusted events will actually reach right before
    // dispatch — mirroring pressBrowserKeys.
    const credentialInputActive = await evaluateInContext<BrowserCredentialInputClassification>(
      runtime,
      ACTIVE_CREDENTIAL_INPUT_EXPRESSION,
      { effectMayHaveCommitted: true, signal },
    );
    if (credentialInputActive?.value !== false) {
      browserHostError(
        {
          code: "BrowserCredentialInputRequired",
          tabId: tabId(runtime),
        },
        credentialInputMatchFrom(credentialInputActive?.value),
      );
    }
    if (input.text.length > 0) {
      await withTrustedGuestFocus(
        runtime,
        () => dispatchTrustedText(runtime, input.text, signal),
        signal,
      );
    } else if (!(input.append ?? false)) {
      await dispatchTrustedKeySequence(runtime, ["Backspace"], signal);
    }
    const value = await callFunctionOn<BrowserTypeOutput["resultingValue"]>(
      runtime,
      target.resolved.objectId!,
      READ_EDITABLE_VALUE_FUNCTION,
      { effectMayHaveCommitted: false, signal },
    );
    return {
      tabId: tabId(runtime),
      target: target.resolved.info,
      resultingValue: value.value ?? { kind: "unavailable", length: 0 },
    } satisfies BrowserTypeOutput;
  } finally {
    await releaseBrowserTarget(runtime, target.resolved);
  }
};

const SELECT_OPTIONS_FUNCTION = String.raw`function(values) {
  if (!(this instanceof HTMLSelectElement)) return { ok: false, reason: "not-select" };
  if (this.disabled || this.matches(":disabled") || this.closest('[aria-disabled="true"]')) {
    return { ok: false, reason: "disabled" };
  }
  if (!this.multiple && values.length !== 1) return { ok: false, reason: "not-multiple" };
  const requested = new Set(values);
  const matches = Array.from(this.options).filter((option) => requested.has(option.value));
  if (matches.length !== requested.size) return { ok: false, reason: "not-found" };
  if (matches.some((option) => option.disabled || option.parentElement?.disabled === true)) {
    return { ok: false, reason: "disabled-option" };
  }
  for (const option of this.options) option.selected = requested.has(option.value);
  this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  this.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  return { ok: true, selectedValues: Array.from(this.selectedOptions, (option) => option.value) };
}`;

export const selectBrowserTarget = async (
  runtime: BrowserAutomationVisibleRuntime,
  input: BrowserSelectInput,
  snapshot: BrowserSnapshotHandle | undefined,
  signal?: AbortSignal,
): Promise<BrowserSelectOutput> => {
  const target = await resolveActionableTarget(runtime, input.target, snapshot, {
    timeoutMs: input.timeoutMs,
    signal,
  });
  try {
    const response = await callFunctionOn<{
      readonly ok: boolean;
      readonly reason?: string;
      readonly selectedValues?: readonly string[];
    }>(runtime, target.resolved.objectId!, SELECT_OPTIONS_FUNCTION, {
      arguments: [[...input.values]],
      effectMayHaveCommitted: true,
      signal,
    });
    if (response.value?.reason === "disabled" || response.value?.reason === "disabled-option") {
      browserHostError({ code: "BrowserTargetNotEnabled", tabId: tabId(runtime) });
    }
    if (response.value?.ok !== true || !response.value.selectedValues?.length) {
      browserHostError({ code: "BrowserInputUnsupported" });
    }
    return {
      tabId: tabId(runtime),
      target: target.resolved.info,
      selectedValues: [...response.value.selectedValues],
    } satisfies BrowserSelectOutput;
  } finally {
    await releaseBrowserTarget(runtime, target.resolved);
  }
};

const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);
const PRIVILEGED_CHORDS = new Set([
  "Alt+F4",
  "Alt+ArrowLeft",
  "Alt+ArrowRight",
  "Alt+Escape",
  "Alt+Tab",
  "Control+Alt+Delete",
  "Control+L",
  "Control+N",
  "Control+P",
  "Control+R",
  "Control+T",
  "Control+W",
  "Meta+L",
  "Meta+N",
  "Meta+P",
  "Meta+Q",
  "Meta+R",
  "Meta+T",
  "Meta+W",
  "Meta+H",
  "Meta+M",
  "Meta+Space",
  "Meta+Tab",
  "Control+C",
  "Control+V",
  "Control+X",
  "Meta+C",
  "Meta+V",
  "Meta+X",
  "Control+Shift+C",
  "Control+Shift+I",
  "Control+Shift+J",
  "Meta+Shift+C",
  "Meta+Shift+I",
  "Meta+Shift+J",
]);

const validateKeySequence = (keys: readonly string[]): void => {
  for (const chord of keys) {
    const parts = chord.split("+");
    const key = parts.at(-1) ?? "";
    const modifiers = parts.slice(0, -1);
    const clipboardChord =
      (modifiers.includes("Control") || modifiers.includes("Meta")) &&
      ["c", "v", "x"].includes(key.toLowerCase());
    if (
      !key ||
      modifiers.some((modifier) => !MODIFIER_KEYS.has(modifier)) ||
      new Set(modifiers).size !== modifiers.length ||
      PRIVILEGED_CHORDS.has(chord) ||
      clipboardChord
    ) {
      browserHostError({ code: "BrowserInputUnsupported" });
    }
  }
};

export const pressBrowserKeys = async (
  runtime: BrowserAutomationVisibleRuntime,
  input: BrowserPressInput,
  signal?: AbortSignal,
): Promise<BrowserPressOutput> => {
  validateKeySequence(input.keys);
  const credentialInputActive = await evaluateInContext<BrowserCredentialInputClassification>(
    runtime,
    ACTIVE_CREDENTIAL_INPUT_EXPRESSION,
    { effectMayHaveCommitted: false, signal },
  );
  // Fail closed: only a literal `false` classification allows trusted keys.
  if (credentialInputActive?.value !== false) {
    browserHostError(
      {
        code: "BrowserCredentialInputRequired",
        tabId: tabId(runtime),
      },
      credentialInputMatchFrom(credentialInputActive?.value),
    );
  }
  await dispatchTrustedKeySequence(runtime, input.keys, signal);
  return {
    tabId: tabId(runtime),
    emitted: [...input.keys],
    modifiersReleased: true,
  } satisfies BrowserPressOutput;
};

interface ScrollMetrics {
  readonly before: { readonly x: number; readonly y: number };
  readonly maxX: number;
  readonly maxY: number;
  readonly width: number;
  readonly height: number;
}

const READ_SCROLL_METRICS_FUNCTION = String.raw`async function(waitForSettle) {
  if (waitForSettle) {
    await new Promise((resolve) => setTimeout(resolve, 16));
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  const scrollable = (candidate) => {
    if (!candidate || candidate === document.documentElement || candidate === document.body) return false;
    const style = getComputedStyle(candidate);
    return /(auto|scroll|overlay)/.test(style.overflow + style.overflowX + style.overflowY) &&
      (candidate.scrollHeight > candidate.clientHeight || candidate.scrollWidth > candidate.clientWidth);
  };
  let target = this && this.nodeType === 1 ? this : null;
  while (target && !scrollable(target)) target = target.parentElement;
  const viewport = !target;
  const root = document.scrollingElement || document.documentElement;
  const x = viewport ? window.scrollX : target.scrollLeft;
  const y = viewport ? window.scrollY : target.scrollTop;
  const width = viewport ? window.innerWidth : target.clientWidth;
  const height = viewport ? window.innerHeight : target.clientHeight;
  return {
    before: { x, y }, width, height,
    maxX: Math.max(0, (viewport ? root.scrollWidth : target.scrollWidth) - width),
    maxY: Math.max(0, (viewport ? root.scrollHeight : target.scrollHeight) - height),
  };
}`;

const readScrollMetrics = async (
  runtime: BrowserAutomationVisibleRuntime,
  objectId: string,
  waitForSettle: boolean,
  signal?: AbortSignal,
): Promise<ScrollMetrics> => {
  const result = await callFunctionOn<ScrollMetrics>(
    runtime,
    objectId,
    READ_SCROLL_METRICS_FUNCTION,
    {
      arguments: [waitForSettle],
      effectMayHaveCommitted: false,
      signal,
    },
  );
  if (!result.value) throw new Error("The visible browser did not return scroll metrics.");
  return result.value;
};

const scrollDelta = (
  input: BrowserScrollInput,
  metrics: ScrollMetrics,
): { readonly x: number; readonly y: number } => {
  if (input.mode === "pixels") return { x: input.deltaX ?? 0, y: input.deltaY ?? 0 };
  if (input.mode === "pages") {
    return {
      x: (input.pagesX ?? 0) * metrics.width,
      y: (input.pagesY ?? 0) * metrics.height,
    };
  }
  const amount = input.amount ?? Math.max(1, Math.round(metrics.height * 0.8));
  switch (input.direction) {
    case "up":
      return { x: 0, y: -amount };
    case "down":
      return { x: 0, y: amount };
    case "left":
      return { x: -amount, y: 0 };
    case "right":
      return { x: amount, y: 0 };
    case "start":
      return { x: -metrics.before.x, y: -metrics.before.y };
    case "end":
      return {
        x: metrics.maxX - metrics.before.x,
        y: metrics.maxY - metrics.before.y,
      };
    default:
      return { x: 0, y: 0 };
  }
};

export const scrollBrowser = async (
  runtime: BrowserAutomationVisibleRuntime,
  input: BrowserScrollInput,
  snapshot: BrowserSnapshotHandle | undefined,
  signal?: AbortSignal,
): Promise<BrowserScrollOutput> => {
  let target: ResolvedBrowserTarget | undefined;
  let objectId: string | undefined;
  let point: { readonly x: number; readonly y: number } | undefined;
  try {
    if (input.target) {
      const resolved = await resolveActionableTarget(runtime, input.target, snapshot, {
        timeoutMs: input.timeoutMs,
        signal,
      });
      target = resolved.resolved;
      objectId = resolved.resolved.objectId;
      point = resolved.actionable.point;
    } else {
      const root = await evaluateInContext(runtime, "document.documentElement", {
        returnByValue: false,
        effectMayHaveCommitted: false,
        signal,
      });
      objectId = root.objectId;
      const page = await observePage(runtime, signal);
      point = { x: page.viewport.width / 2, y: page.viewport.height / 2 };
    }
    if (!objectId || !point) {
      browserHostError({
        code: "BrowserTargetNotFound",
        retryable: false,
        phase: "target",
        effectMayHaveCommitted: false,
        tabId: tabId(runtime),
      });
    }
    const beforeMetrics = await readScrollMetrics(runtime, objectId, false, signal);
    const delta = scrollDelta(input, beforeMetrics);
    if (delta.x !== 0 || delta.y !== 0) {
      await dispatchTrustedScroll(runtime, point, delta.x, delta.y, signal);
    }
    const afterMetrics = await readScrollMetrics(runtime, objectId, true, signal);
    return {
      tabId: tabId(runtime),
      before: beforeMetrics.before,
      after: afterMetrics.before,
      reachedBoundary: {
        top: afterMetrics.before.y <= 0,
        right: afterMetrics.before.x >= afterMetrics.maxX,
        bottom: afterMetrics.before.y >= afterMetrics.maxY,
        left: afterMetrics.before.x <= 0,
      },
    } satisfies BrowserScrollOutput;
  } finally {
    if (target) {
      await releaseBrowserTarget(runtime, target);
    } else if (objectId) {
      await releaseBrowserTarget(runtime, {
        objectId,
        point: point ?? { x: 0, y: 0 },
        info: {},
        attached: true,
        visible: true,
        enabled: true,
        editable: false,
      });
    }
  }
};

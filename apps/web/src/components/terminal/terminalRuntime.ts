// FILE: terminalRuntime.ts
// Purpose: Own the long-lived xterm runtime lifecycle behind the terminal runtime registry.
// Layer: Terminal runtime infrastructure

import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import {
  defaultTerminalTitleForCliKind,
  consumeTerminalIdentityInput,
} from "@synara/shared/terminalThreads";
import { describeErrorMessage } from "@synara/shared/errorMessages";
import {
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_ROWS,
  TERMINAL_MIN_COLS,
  TERMINAL_MIN_ROWS,
} from "@synara/contracts";
import type { TerminalSessionSnapshot } from "@synara/contracts";
import { Terminal } from "@xterm/xterm";

import { readNativeApi } from "~/nativeApi";
import { suppressQueryResponses } from "~/lib/suppressQueryResponses";

import { openInPreferredEditor } from "../../editorPreferences";
import { isTerminalClearShortcut, terminalNavigationShortcutData } from "../../keybindings";
import {
  collectWrappedTerminalLinkLine,
  extractTerminalLinks,
  isTerminalLinkActivation,
  resolvePathLinkTarget,
  resolveWrappedTerminalLinkRange,
  wrappedTerminalLinkRangeIntersectsBufferLine,
} from "../../terminal-links";
import { addWsTransportStateListener } from "../../wsTransportEvents";
import {
  getTerminalBoldFontWeight,
  getTerminalFontFamily,
  getTerminalFontSizePx,
  getTerminalFontWeight,
  terminalThemeFromApp,
  writeSystemMessage,
} from "./terminalRuntimeAppearance";
import { terminalEventDispatcher } from "./terminalEventDispatcher";
import type {
  TerminalRuntimeConfig,
  TerminalRuntimeEntry,
  TerminalRuntimeViewState,
} from "./terminalRuntimeTypes";
import { waitForTerminalFontReady } from "./terminalFontSettle";
import { observeTerminalWriteParsed } from "./terminalPerformance";

const ENABLE_TERMINAL_WEBGL = true;
const VISUAL_RESIZE_MIN_INTERVAL_MS = 64;
const BACKEND_RESIZE_DEBOUNCE_MS = 120;
const WRITE_BATCH_SIZE_LIMIT = 262_144;
const WRITE_BATCH_MAX_LATENCY_MS = 50;
const LINK_MATCH_CACHE_LIMIT = 512;
const OPEN_SNAPSHOT_RECONCILE_DELAY_MS = 250;
const TERMINAL_TEXT_ENCODER = new TextEncoder();
const TERMINAL_PARKING_CONTAINER_ID = "synara-terminal-parking";

type SynaraTerminalOptions = NonNullable<ConstructorParameters<typeof Terminal>[0]> & {
  fontWeight?: string | number;
  fontWeightBold?: string | number;
  scrollbar?: { showScrollbar?: boolean };
  vtExtensions?: { kittyKeyboard?: boolean };
};

const TERMINAL_CURSOR_STYLE: NonNullable<SynaraTerminalOptions["cursorStyle"]> = "bar";
const TERMINAL_INACTIVE_CURSOR_STYLE: NonNullable<SynaraTerminalOptions["cursorInactiveStyle"]> =
  "bar";
const TERMINAL_CURSOR_WIDTH = 1;

// Once WebGL fails, skip it for subsequent terminals in this renderer process.
let suggestedRendererType: "webgl" | "dom" | undefined;

function terminalByteLength(data: string): number {
  return TERMINAL_TEXT_ENCODER.encode(data).byteLength;
}

function acknowledgeParsedOutput(entry: TerminalRuntimeEntry, bytes: number): void {
  if (bytes <= 0) return;
  const api = readNativeApi();
  if (!api) return;
  const ackOutput = api.terminal.ackOutput;
  if (typeof ackOutput !== "function") return;

  void ackOutput({
    threadId: entry.threadId,
    terminalId: entry.terminalId,
    bytes,
  }).catch(() => {
    // Flow control is best-effort; reconnect/replay will recover from a missed ACK.
  });
}

function setRuntimeStatus(
  entry: TerminalRuntimeEntry,
  status: TerminalRuntimeEntry["runtimeStatus"],
) {
  if (entry.runtimeStatus === status) return;
  entry.runtimeStatus = status;
  entry.callbacks.onTerminalRuntimeStatusChange?.(entry.terminalId, status);
}

function readCachedTerminalLinks(entry: TerminalRuntimeEntry, line: string) {
  const cached = entry.linkMatchCache.get(line);
  if (cached) return cached;

  const matches = extractTerminalLinks(line);
  if (entry.linkMatchCache.size >= LINK_MATCH_CACHE_LIMIT) {
    entry.linkMatchCache.clear();
  }
  entry.linkMatchCache.set(line, matches);
  return matches;
}

function getTerminalParkingContainer(): HTMLDivElement {
  let container = document.getElementById(TERMINAL_PARKING_CONTAINER_ID) as HTMLDivElement | null;
  if (container) return container;

  container = document.createElement("div");
  container.id = TERMINAL_PARKING_CONTAINER_ID;
  container.setAttribute("aria-hidden", "true");
  container.style.cssText =
    "position:fixed;width:0;height:0;overflow:hidden;contain:strict;left:-10000px;top:-10000px;";
  document.body.append(container);
  return container;
}

function scheduleFontSettleRefit(entry: TerminalRuntimeEntry): void {
  const fontFamily = String(entry.terminal.options.fontFamily ?? "").trim();
  if (!fontFamily) return;
  const fontSize = Number(entry.terminal.options.fontSize ?? 12);
  void waitForTerminalFontReady({ fontFamily, fontSize }).then(() => {
    if (entry.disposed) return;
    // Rebuild the WebGL glyph atlas: the immediate refit may have cached glyphs in
    // the fallback font while the requested font was still loading, and a plain
    // refresh would keep redrawing those stale glyphs.
    runTerminalResize(entry, { clearTextureAtlas: true, refresh: true });
  });
}

function resetForSnapshotReplay(entry: TerminalRuntimeEntry): void {
  entry.titleInputBuffer = "";
  entry.linkMatchCache.clear();
  clearPendingWrites(entry);
  entry.terminal.write("\u001bc");
}

function snapshotReplayPayload(snapshot: TerminalSessionSnapshot): string {
  return `${snapshot.replayPreamble ?? ""}${snapshot.history}`;
}

function snapshotHasReplayPayload(snapshot: TerminalSessionSnapshot): boolean {
  return snapshot.history.length > 0 || (snapshot.replayPreamble?.length ?? 0) > 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Fit xterm to its container, then clamp the result into the PTY contract bounds.
// An ultrawide viewport at a small font can legitimately propose more than the
// old 400-column cap, and a fit before fonts settle can momentarily report a
// glitched (tiny char width -> huge column count) size. Forcing xterm back into
// range keeps the open/resize payloads valid — so the terminal always opens —
// and keeps the rendered grid consistent with what the backend PTY believes.
function fitTerminal(entry: TerminalRuntimeEntry): void {
  entry.fitAddon.fit();
  const cols = clamp(entry.terminal.cols, TERMINAL_MIN_COLS, TERMINAL_MAX_COLS);
  const rows = clamp(entry.terminal.rows, TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS);
  if (cols !== entry.terminal.cols || rows !== entry.terminal.rows) {
    entry.terminal.resize(cols, rows);
  }
}

function buildOpenInput(entry: TerminalRuntimeEntry) {
  return {
    threadId: entry.threadId,
    terminalId: entry.terminalId,
    cwd: entry.cwd,
    cols: entry.terminal.cols,
    rows: entry.terminal.rows,
    ...(entry.runtimeEnv ? { env: entry.runtimeEnv } : {}),
  };
}

function replaySnapshot(
  entry: TerminalRuntimeEntry,
  snapshot: TerminalSessionSnapshot,
  onParsed?: () => void,
): void {
  resetForSnapshotReplay(entry);
  const payload = snapshotReplayPayload(snapshot);
  if (payload.length > 0) {
    setRuntimeStatus(entry, "replaying");
    entry.terminal.write(payload, onParsed);
    return;
  }
  onParsed?.();
}

function clearBackendResizeTimer(entry: TerminalRuntimeEntry): void {
  if (entry.resizeDispatchTimer !== null) {
    window.clearTimeout(entry.resizeDispatchTimer);
    entry.resizeDispatchTimer = null;
  }
}

function clearPendingWrites(entry: TerminalRuntimeEntry): void {
  if (entry.writeRafHandle !== null) {
    window.cancelAnimationFrame(entry.writeRafHandle);
    entry.writeRafHandle = null;
  }
  if (entry.writeFlushTimeout !== null) {
    window.clearTimeout(entry.writeFlushTimeout);
    entry.writeFlushTimeout = null;
  }
  if (entry.pendingWriteBytes > 0) {
    acknowledgeParsedOutput(entry, entry.pendingWriteBytes);
  }
  entry.pendingWrites.length = 0;
  entry.pendingWriteLength = 0;
  entry.pendingWriteBytes = 0;
}

function flushPendingWrites(entry: TerminalRuntimeEntry): void {
  if (entry.writeRafHandle !== null) {
    window.cancelAnimationFrame(entry.writeRafHandle);
    entry.writeRafHandle = null;
  }
  if (entry.writeFlushTimeout !== null) {
    window.clearTimeout(entry.writeFlushTimeout);
    entry.writeFlushTimeout = null;
  }
  if (entry.pendingWrites.length === 0) {
    entry.pendingWriteLength = 0;
    entry.pendingWriteBytes = 0;
    return;
  }
  const combined = entry.pendingWrites.map((write) => write.data).join("");
  const byteLength = entry.pendingWriteBytes;
  const queuedAt = entry.pendingWrites[0]?.queuedAt ?? performance.now();
  entry.pendingWrites.length = 0;
  entry.pendingWriteLength = 0;
  entry.pendingWriteBytes = 0;
  entry.terminal.write(combined, () => {
    acknowledgeParsedOutput(entry, byteLength);
    observeTerminalWriteParsed({
      runtimeKey: entry.runtimeKey,
      bytes: byteLength,
      queuedAt,
    });
  });
}

function scheduleWrite(entry: TerminalRuntimeEntry, data: string, byteLength: number): void {
  entry.pendingWrites.push({
    data,
    byteLength,
    queuedAt: performance.now(),
  });
  entry.pendingWriteLength += data.length;
  entry.pendingWriteBytes += byteLength;

  if (entry.pendingWriteBytes >= WRITE_BATCH_SIZE_LIMIT) {
    flushPendingWrites(entry);
    return;
  }

  if (entry.writeRafHandle === null) {
    entry.writeRafHandle = window.requestAnimationFrame(() => {
      entry.writeRafHandle = null;
      flushPendingWrites(entry);
    });
  }
  if (entry.writeFlushTimeout === null) {
    entry.writeFlushTimeout = window.setTimeout(() => {
      entry.writeFlushTimeout = null;
      flushPendingWrites(entry);
    }, WRITE_BATCH_MAX_LATENCY_MS);
  }
}

function flushPendingResize(entry: TerminalRuntimeEntry): void {
  const api = readNativeApi();
  const pendingResize = entry.pendingResize;
  if (!api || !pendingResize) return;

  entry.pendingResize = null;
  entry.lastSentResize = pendingResize;
  void api.terminal
    .resize({
      threadId: entry.threadId,
      terminalId: entry.terminalId,
      cols: pendingResize.cols,
      rows: pendingResize.rows,
    })
    .catch(() => {
      const current = entry.lastSentResize;
      if (current && current.cols === pendingResize.cols && current.rows === pendingResize.rows) {
        entry.lastSentResize = null;
      }
    });
}

function queueBackendResize(entry: TerminalRuntimeEntry, cols: number, rows: number): void {
  const lastSentResize = entry.lastSentResize;
  const pendingResize = entry.pendingResize;
  if (
    (lastSentResize && lastSentResize.cols === cols && lastSentResize.rows === rows) ||
    (pendingResize && pendingResize.cols === cols && pendingResize.rows === rows)
  ) {
    return;
  }
  entry.pendingResize = { cols, rows };
  clearBackendResizeTimer(entry);
  entry.resizeDispatchTimer = window.setTimeout(() => {
    entry.resizeDispatchTimer = null;
    flushPendingResize(entry);
  }, BACKEND_RESIZE_DEBOUNCE_MS);
}

function runTerminalResize(
  entry: TerminalRuntimeEntry,
  options?: { clearTextureAtlas?: boolean; refresh?: boolean; dispatchBackend?: boolean },
): void {
  if (!entry.container || !entry.viewState.isVisible) return;

  const { clearTextureAtlas = false, refresh = false, dispatchBackend = true } = options ?? {};
  const buffer = entry.terminal.buffer.active;
  const wasAtBottom = buffer.viewportY >= buffer.baseY;
  const savedViewportY = buffer.viewportY;
  const previousCols = entry.terminal.cols;
  const previousRows = entry.terminal.rows;

  if (clearTextureAtlas) {
    (
      entry.webglAddon as unknown as {
        clearTextureAtlas?: () => void;
      } | null
    )?.clearTextureAtlas?.();
  }

  fitTerminal(entry);
  if (wasAtBottom) {
    entry.terminal.scrollToBottom();
  } else {
    const targetViewportY = Math.min(savedViewportY, entry.terminal.buffer.active.baseY);
    if (entry.terminal.buffer.active.viewportY !== targetViewportY) {
      entry.terminal.scrollToLine(targetViewportY);
    }
  }
  const dimensionsChanged =
    entry.terminal.cols !== previousCols || entry.terminal.rows !== previousRows;
  if (dispatchBackend && dimensionsChanged) {
    queueBackendResize(entry, entry.terminal.cols, entry.terminal.rows);
  }
  if (refresh) {
    entry.terminal.refresh(0, Math.max(0, entry.terminal.rows - 1));
  }
}

function cancelScheduledVisualResize(entry: TerminalRuntimeEntry): void {
  if (entry.visualResizeFrame !== null) {
    window.cancelAnimationFrame(entry.visualResizeFrame);
    entry.visualResizeFrame = null;
  }
  if (entry.visualResizeTimer !== null) {
    window.clearTimeout(entry.visualResizeTimer);
    entry.visualResizeTimer = null;
  }
}

function scheduleVisualResize(entry: TerminalRuntimeEntry): void {
  if (!entry.viewState.isVisible || entry.visualResizeTimer !== null) {
    return;
  }

  const now = Date.now();
  const remaining = Math.max(0, VISUAL_RESIZE_MIN_INTERVAL_MS - (now - entry.lastVisualResizeAt));

  const run = () => {
    entry.visualResizeTimer = null;
    if (entry.visualResizeFrame !== null) {
      window.cancelAnimationFrame(entry.visualResizeFrame);
    }
    entry.visualResizeFrame = window.requestAnimationFrame(() => {
      entry.visualResizeFrame = null;
      entry.lastVisualResizeAt = Date.now();
      runTerminalResize(entry);
    });
  };

  if (remaining === 0) {
    run();
    return;
  }

  entry.visualResizeTimer = window.setTimeout(run, remaining);
}

function startVisibilityRecovery(entry: TerminalRuntimeEntry): void {
  if (!entry.container || !entry.viewState.isVisible || entry.visibilityCleanup) {
    return;
  }

  let recoveryFrame = 0;
  let throttleTimer: number | null = null;
  let lastRunAt = 0;
  const RECOVERY_THROTTLE_MS = 120;

  const runRecovery = () => {
    const mount = entry.container;
    if (!mount) return;
    if (!mount.isConnected) return;

    const style = window.getComputedStyle(mount);
    if (style.display === "none" || style.visibility === "hidden") {
      return;
    }
    const rect = mount.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) {
      return;
    }

    cancelScheduledVisualResize(entry);
    entry.lastVisualResizeAt = Date.now();
    runTerminalResize(entry, {
      clearTextureAtlas: true,
      refresh: true,
    });
  };

  const scheduleRecovery = () => {
    if (recoveryFrame !== 0) return;

    recoveryFrame = window.requestAnimationFrame(() => {
      recoveryFrame = 0;
      const now = Date.now();
      if (now - lastRunAt < RECOVERY_THROTTLE_MS) {
        const remaining = RECOVERY_THROTTLE_MS - (now - lastRunAt);
        if (throttleTimer !== null) {
          window.clearTimeout(throttleTimer);
        }
        throttleTimer = window.setTimeout(() => {
          throttleTimer = null;
          scheduleRecovery();
        }, remaining + 1);
        return;
      }
      lastRunAt = now;
      runRecovery();
    });
  };

  const handleVisibilityChange = () => {
    if (document.hidden) return;
    scheduleRecovery();
  };
  const handleWindowFocus = () => {
    scheduleRecovery();
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("focus", handleWindowFocus);
  entry.visibilityCleanup = () => {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("focus", handleWindowFocus);
    if (recoveryFrame !== 0) {
      window.cancelAnimationFrame(recoveryFrame);
    }
    if (throttleTimer !== null) {
      window.clearTimeout(throttleTimer);
    }
    entry.visibilityCleanup = null;
  };
}

function stopVisibilityRecovery(entry: TerminalRuntimeEntry): void {
  entry.visibilityCleanup?.();
  entry.visibilityCleanup = null;
}

function syncTheme(entry: TerminalRuntimeEntry): void {
  const nextTheme = terminalThemeFromApp();
  const nextFontFamily = getTerminalFontFamily();
  const nextFontSize = getTerminalFontSizePx();
  const nextFontWeight = getTerminalFontWeight();
  const nextBoldFontWeight = getTerminalBoldFontWeight();
  const nextFontKey = JSON.stringify({
    fontFamily: nextFontFamily,
    fontSize: nextFontSize,
    fontWeight: nextFontWeight,
    fontWeightBold: nextBoldFontWeight,
  });
  const nextAppearanceKey = JSON.stringify({
    fontFamily: nextFontFamily,
    fontSize: nextFontSize,
    fontWeight: nextFontWeight,
    fontWeightBold: nextBoldFontWeight,
    cursorStyle: TERMINAL_CURSOR_STYLE,
    cursorInactiveStyle: TERMINAL_INACTIVE_CURSOR_STYLE,
    cursorWidth: TERMINAL_CURSOR_WIDTH,
    theme: nextTheme,
  });
  const previousAppearanceKey = (entry.wrapper.dataset.themeKey ?? "") as string;
  if (nextAppearanceKey === previousAppearanceKey) {
    return;
  }
  const shouldClearTextureAtlas = nextFontKey !== (entry.wrapper.dataset.fontKey ?? "");
  entry.wrapper.dataset.themeKey = nextAppearanceKey;
  entry.wrapper.dataset.fontKey = nextFontKey;
  const terminalOptions = entry.terminal.options as SynaraTerminalOptions;
  terminalOptions.theme = nextTheme;
  terminalOptions.fontFamily = nextFontFamily;
  terminalOptions.fontSize = nextFontSize;
  terminalOptions.fontWeight = nextFontWeight;
  terminalOptions.fontWeightBold = nextBoldFontWeight;
  terminalOptions.cursorStyle = TERMINAL_CURSOR_STYLE;
  terminalOptions.cursorInactiveStyle = TERMINAL_INACTIVE_CURSOR_STYLE;
  terminalOptions.cursorWidth = TERMINAL_CURSOR_WIDTH;
  if (shouldClearTextureAtlas) {
    scheduleFontSettleRefit(entry);
  }
  if (entry.viewState.isVisible) {
    runTerminalResize(entry, { clearTextureAtlas: shouldClearTextureAtlas, refresh: true });
  } else {
    entry.terminal.refresh(0, Math.max(0, entry.terminal.rows - 1));
  }
}

function cancelPendingWebglLoad(entry: TerminalRuntimeEntry): void {
  if (entry.webglLoadFrame !== null) {
    window.cancelAnimationFrame(entry.webglLoadFrame);
    entry.webglLoadFrame = null;
  }
}

function disposeWebglAddon(entry: TerminalRuntimeEntry): void {
  cancelPendingWebglLoad(entry);
  entry.webglAddon?.dispose();
  entry.webglAddon = null;
}

function maybeLoadWebglAddon(entry: TerminalRuntimeEntry): void {
  if (
    entry.disposed ||
    !ENABLE_TERMINAL_WEBGL ||
    suggestedRendererType === "dom" ||
    entry.webglAddon !== null ||
    entry.webglLoadFrame !== null ||
    !entry.viewState.isVisible
  ) {
    return;
  }

  entry.webglLoadFrame = window.requestAnimationFrame(() => {
    entry.webglLoadFrame = null;
    if (
      entry.disposed ||
      !ENABLE_TERMINAL_WEBGL ||
      suggestedRendererType === "dom" ||
      entry.webglAddon !== null ||
      !entry.viewState.isVisible
    ) {
      return;
    }

    try {
      const nextWebglAddon = new WebglAddon();
      nextWebglAddon.onContextLoss(() => {
        suggestedRendererType = "dom";
        nextWebglAddon.dispose();
        if (entry.webglAddon === nextWebglAddon) {
          entry.webglAddon = null;
        }
        entry.terminal.refresh(0, Math.max(0, entry.terminal.rows - 1));
      });
      entry.terminal.loadAddon(nextWebglAddon);
      entry.webglAddon = nextWebglAddon;
    } catch {
      suggestedRendererType = "dom";
      entry.webglAddon = null;
    }
  });
}

function applyInitialVisualResize(entry: TerminalRuntimeEntry): void {
  if (!entry.viewState.isVisible) return;

  let firstFrame = 0;
  let secondFrame = 0;

  firstFrame = window.requestAnimationFrame(() => {
    cancelScheduledVisualResize(entry);
    entry.lastVisualResizeAt = Date.now();
    runTerminalResize(entry, {
      clearTextureAtlas: true,
      refresh: true,
    });

    secondFrame = window.requestAnimationFrame(() => {
      entry.lastVisualResizeAt = Date.now();
      runTerminalResize(entry, { refresh: true });
    });
  });

  entry.attachDisposables.push(() => {
    if (firstFrame !== 0) {
      window.cancelAnimationFrame(firstFrame);
    }
    if (secondFrame !== 0) {
      window.cancelAnimationFrame(secondFrame);
    }
  });
}

function ensureResizeObserver(entry: TerminalRuntimeEntry): void {
  if (!entry.container || !entry.viewState.isVisible || entry.resizeObserver) {
    return;
  }

  let frame = 0;
  const observer = new ResizeObserver((entries) => {
    if (
      entries.some(
        (resizeEntry) => resizeEntry.contentRect.width <= 0 || resizeEntry.contentRect.height <= 0,
      )
    ) {
      cancelScheduledVisualResize(entry);
      return;
    }
    if (frame !== 0) {
      window.cancelAnimationFrame(frame);
    }
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      scheduleVisualResize(entry);
    });
  });

  observer.observe(entry.container);
  entry.resizeObserver = observer;
  entry.attachDisposables.push(() => {
    observer.disconnect();
    if (frame !== 0) {
      window.cancelAnimationFrame(frame);
    }
    if (entry.resizeObserver === observer) {
      entry.resizeObserver = null;
    }
  });
}

function clearAttachDisposables(entry: TerminalRuntimeEntry): void {
  const disposables = [...entry.attachDisposables];
  entry.attachDisposables.length = 0;
  for (const dispose of disposables) {
    dispose();
  }
  entry.resizeObserver = null;
}

async function sendTerminalInput(
  entry: TerminalRuntimeEntry,
  data: string,
  fallbackError: string,
): Promise<void> {
  const api = readNativeApi();
  if (!api) return;
  try {
    await api.terminal.write({ threadId: entry.threadId, terminalId: entry.terminalId, data });
  } catch (error) {
    writeSystemMessage(entry.terminal, describeErrorMessage(error, fallbackError));
  }
}

function reconcileTerminalSnapshot(entry: TerminalRuntimeEntry): void {
  if (entry.disposed || !entry.opened || entry.hasHandledExit) return;
  const api = readNativeApi();
  if (!api) return;

  const outputEventVersionAtRequest = entry.outputEventVersion;
  const requestId = ++entry.snapshotReconcileRequestId;
  setRuntimeStatus(entry, "connecting");

  void api.terminal
    .open(buildOpenInput(entry))
    .then((snapshot) => {
      if (
        entry.disposed ||
        !entry.opened ||
        entry.hasHandledExit ||
        entry.snapshotReconcileRequestId !== requestId
      ) {
        return;
      }

      if (entry.outputEventVersion !== outputEventVersionAtRequest) {
        return;
      }

      if (snapshotHasReplayPayload(snapshot)) {
        replaySnapshot(entry, snapshot, () => {
          if (!entry.disposed && entry.snapshotReconcileRequestId === requestId) {
            setRuntimeStatus(entry, "ready");
          }
        });
        return;
      }

      setRuntimeStatus(entry, "ready");
    })
    .catch((error) => {
      if (entry.disposed || !entry.opened || entry.snapshotReconcileRequestId !== requestId) {
        return;
      }
      setRuntimeStatus(entry, "error");
      writeSystemMessage(
        entry.terminal,
        error instanceof Error ? error.message : "Failed to reconnect terminal",
      );
    });
}

export function syncRuntimeConfig(
  entry: TerminalRuntimeEntry,
  config: TerminalRuntimeConfig,
): void {
  entry.runtimeKey = config.runtimeKey;
  entry.threadId = config.threadId;
  entry.terminalId = config.terminalId;
  entry.terminalLabel = config.terminalLabel;
  entry.terminalCliKind = config.terminalCliKind ?? entry.terminalCliKind ?? null;
  entry.cwd = config.cwd;
  if (config.runtimeEnv === undefined) {
    delete entry.runtimeEnv;
  } else {
    entry.runtimeEnv = config.runtimeEnv;
  }
  entry.callbacks = config.callbacks;
}

export function createRuntimeEntry(config: TerminalRuntimeConfig): TerminalRuntimeEntry {
  const wrapper = document.createElement("div");
  wrapper.className = "h-full w-full";

  const fitAddon = new FitAddon();
  const clipboardAddon = new ClipboardAddon();
  const imageAddon = new ImageAddon();
  const searchAddon = new SearchAddon();
  const unicode11Addon = new Unicode11Addon();
  const terminalOptions: SynaraTerminalOptions = {
    cursorBlink: true,
    fontSize: getTerminalFontSizePx(),
    fontWeight: getTerminalFontWeight(),
    fontWeightBold: getTerminalBoldFontWeight(),
    scrollback: 5_000,
    fontFamily: getTerminalFontFamily(),
    theme: terminalThemeFromApp(),
    allowProposedApi: true,
    customGlyphs: true,
    macOptionIsMeta: false,
    cursorStyle: TERMINAL_CURSOR_STYLE,
    cursorInactiveStyle: TERMINAL_INACTIVE_CURSOR_STYLE,
    cursorWidth: TERMINAL_CURSOR_WIDTH,
    screenReaderMode: false,
    allowTransparency: false,
    vtExtensions: { kittyKeyboard: true },
    scrollbar: { showScrollbar: false },
  };
  const terminal = new Terminal(terminalOptions);
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(clipboardAddon);
  terminal.loadAddon(imageAddon);
  terminal.loadAddon(searchAddon);
  terminal.loadAddon(unicode11Addon);
  terminal.unicode.activeVersion = "11";
  try {
    terminal.loadAddon(new LigaturesAddon());
  } catch {
    // Keep terminal startup resilient when the active font doesn't support ligatures.
  }
  terminal.open(wrapper);

  const entry: TerminalRuntimeEntry = {
    runtimeKey: config.runtimeKey,
    threadId: config.threadId,
    terminalId: config.terminalId,
    terminalLabel: config.terminalLabel,
    terminalCliKind: config.terminalCliKind ?? null,
    cwd: config.cwd,
    callbacks: config.callbacks,
    wrapper,
    container: null,
    terminal,
    fitAddon,
    searchAddon,
    webglAddon: null,
    titleInputBuffer: "",
    hasHandledExit: false,
    runtimeStatus: "connecting",
    opened: false,
    disposed: false,
    resizeObserver: null,
    resizeDispatchTimer: null,
    visualResizeFrame: null,
    visualResizeTimer: null,
    lastVisualResizeAt: 0,
    lastSentResize: null,
    pendingResize: null,
    writeRafHandle: null,
    writeFlushTimeout: null,
    pendingWrites: [],
    pendingWriteLength: 0,
    pendingWriteBytes: 0,
    linkMatchCache: new Map(),
    outputEventVersion: 0,
    snapshotReconcileRequestId: 0,
    webglLoadFrame: null,
    themeRefreshFrame: 0,
    themeObserver: null,
    visibilityCleanup: null,
    terminalDisposables: [],
    attachDisposables: [],
    persistentDisposables: [],
    querySuppressionDispose: null,
    viewState: {
      autoFocus: false,
      isVisible: false,
    },
    unsubscribeTerminalEvents: null,
  };
  if (config.runtimeEnv !== undefined) {
    entry.runtimeEnv = config.runtimeEnv;
  }

  scheduleFontSettleRefit(entry);
  entry.querySuppressionDispose = suppressQueryResponses(terminal);

  const handleCopy = (event: ClipboardEvent) => {
    const selection = terminal.getSelection();
    if (!selection) return;
    const trimmed = selection.replace(/[^\S\n]+$/gm, "");
    if (trimmed === selection) return;

    if (event.clipboardData) {
      event.preventDefault();
      event.clipboardData.setData("text/plain", trimmed);
      return;
    }

    void navigator.clipboard?.writeText(trimmed).catch(() => undefined);
  };
  wrapper.addEventListener("copy", handleCopy);
  entry.persistentDisposables.push(() => {
    wrapper.removeEventListener("copy", handleCopy);
  });

  const unsubscribeTransportState = addWsTransportStateListener((state) => {
    if (entry.disposed || !entry.opened || entry.hasHandledExit) return;
    if (state === "open") {
      reconcileTerminalSnapshot(entry);
      return;
    }
    if (state === "connecting" || state === "closed") {
      setRuntimeStatus(entry, "connecting");
    }
  });
  entry.persistentDisposables.push(unsubscribeTransportState);

  terminal.attachCustomKeyEventHandler((event) => {
    if (
      event.type === "keydown" &&
      event.key === "Enter" &&
      event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      void sendTerminalInput(entry, "\n", "Failed to insert newline");
      return false;
    }

    if (
      event.type === "keydown" &&
      event.key.toLowerCase() === "f" &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey
    ) {
      return true;
    }

    const navigationData = terminalNavigationShortcutData(event);
    if (navigationData !== null) {
      event.preventDefault();
      event.stopPropagation();
      void sendTerminalInput(entry, navigationData, "Failed to move cursor");
      return false;
    }

    if (!isTerminalClearShortcut(event)) return true;
    event.preventDefault();
    event.stopPropagation();
    void sendTerminalInput(entry, "\u000c", "Failed to clear terminal");
    return false;
  });

  entry.terminalDisposables.push(
    terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const wrappedLine = collectWrappedTerminalLinkLine(bufferLineNumber, (bufferLineIndex) =>
          terminal.buffer.active.getLine(bufferLineIndex),
        );
        if (!wrappedLine) {
          callback(undefined);
          return;
        }

        const links = readCachedTerminalLinks(entry, wrappedLine.text)
          .map((match) => ({
            match,
            range: resolveWrappedTerminalLinkRange(wrappedLine, match),
          }))
          .filter(({ range }) =>
            wrappedTerminalLinkRangeIntersectsBufferLine(range, bufferLineNumber),
          );
        if (links.length === 0) {
          callback(undefined);
          return;
        }

        callback(
          links.map(({ match, range }) => ({
            text: match.text,
            range,
            activate: (event: MouseEvent) => {
              if (!isTerminalLinkActivation(event)) return;
              const api = readNativeApi();
              if (!api) return;

              if (match.kind === "url") {
                void api.shell.openExternal(match.text).catch((error) => {
                  writeSystemMessage(terminal, describeErrorMessage(error, "Unable to open link"));
                });
                return;
              }

              const target = resolvePathLinkTarget(match.text, entry.cwd);
              void openInPreferredEditor(api, target).catch((error) => {
                writeSystemMessage(terminal, describeErrorMessage(error, "Unable to open path"));
              });
            },
          })),
        );
      },
    }),
  );

  entry.terminalDisposables.push(
    terminal.onData((data) => {
      const nextIdentityState = consumeTerminalIdentityInput(entry.titleInputBuffer, data);
      entry.titleInputBuffer = nextIdentityState.buffer;
      const submittedIdentity = nextIdentityState.identity;
      if (submittedIdentity && (submittedIdentity.cliKind || entry.terminalCliKind !== null)) {
        entry.terminalCliKind = submittedIdentity.cliKind;
        entry.callbacks.onTerminalMetadataChange(entry.terminalId, {
          cliKind: submittedIdentity.cliKind,
          label: submittedIdentity.title,
        });
      }
      const api = readNativeApi();
      if (!api) return;
      void api.terminal
        .write({ threadId: entry.threadId, terminalId: entry.terminalId, data })
        .catch((error) =>
          writeSystemMessage(terminal, describeErrorMessage(error, "Terminal write failed")),
        );
    }),
  );

  entry.themeObserver = new MutationObserver(() => {
    if (entry.themeRefreshFrame !== 0) return;
    entry.themeRefreshFrame = window.requestAnimationFrame(() => {
      entry.themeRefreshFrame = 0;
      syncTheme(entry);
    });
  });
  entry.themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });

  entry.unsubscribeTerminalEvents = terminalEventDispatcher.subscribe(
    entry.threadId,
    entry.terminalId,
    (event) => {
      if (event.type === "output") {
        setRuntimeStatus(entry, "ready");
        entry.outputEventVersion += 1;
        scheduleWrite(entry, event.data, event.byteLength ?? terminalByteLength(event.data));
        return;
      }

      if (event.type === "started" || event.type === "restarted") {
        entry.hasHandledExit = false;
        const shouldReplaySnapshot =
          event.type === "restarted" || snapshotHasReplayPayload(event.snapshot);
        if (shouldReplaySnapshot) {
          replaySnapshot(entry, event.snapshot, () => setRuntimeStatus(entry, "ready"));
        } else {
          setRuntimeStatus(entry, "ready");
        }
        return;
      }

      if (event.type === "cleared") {
        entry.titleInputBuffer = "";
        entry.linkMatchCache.clear();
        clearPendingWrites(entry);
        terminal.clear();
        terminal.write("\u001bc");
        return;
      }

      if (event.type === "activity") {
        if (entry.terminalCliKind !== event.cliKind) {
          entry.terminalCliKind = event.cliKind;
          entry.callbacks.onTerminalMetadataChange(entry.terminalId, {
            cliKind: event.cliKind,
            label: event.cliKind ? defaultTerminalTitleForCliKind(event.cliKind) : "Terminal",
          });
        }
        entry.callbacks.onTerminalActivityChange(entry.terminalId, {
          hasRunningSubprocess: event.hasRunningSubprocess,
          agentState: event.agentState,
        });
        return;
      }

      if (event.type === "error") {
        setRuntimeStatus(entry, "error");
        writeSystemMessage(terminal, event.message);
        return;
      }

      if (event.type === "exited") {
        flushPendingWrites(entry);
        setRuntimeStatus(entry, "exited");
        entry.callbacks.onTerminalActivityChange(entry.terminalId, {
          hasRunningSubprocess: false,
          agentState: null,
        });
        const details = [
          typeof event.exitCode === "number" ? `code ${event.exitCode}` : null,
          typeof event.exitSignal === "number" ? `signal ${event.exitSignal}` : null,
        ]
          .filter((value): value is string => value !== null)
          .join(", ");
        writeSystemMessage(
          terminal,
          details.length > 0 ? `Process exited (${details})` : "Process exited",
        );
        if (entry.hasHandledExit) {
          return;
        }
        entry.hasHandledExit = true;
        window.setTimeout(() => {
          if (!entry.hasHandledExit) {
            return;
          }
          entry.callbacks.onSessionExited();
        }, 0);
      }
    },
  );

  return entry;
}

function openTerminal(entry: TerminalRuntimeEntry): void {
  const api = readNativeApi();
  if (!api || entry.opened) return;

  fitTerminal(entry);
  entry.lastSentResize = null;
  entry.opened = true;
  setRuntimeStatus(entry, "connecting");
  const outputEventVersionAtOpen = entry.outputEventVersion;
  const openInput = buildOpenInput(entry);

  void api.terminal
    .open(openInput)
    .then((snapshot) => {
      if (entry.disposed) return;
      if (
        snapshotHasReplayPayload(snapshot) &&
        entry.outputEventVersion === outputEventVersionAtOpen
      ) {
        replaySnapshot(entry, snapshot, () => setRuntimeStatus(entry, "ready"));
      } else if (entry.outputEventVersion === outputEventVersionAtOpen) {
        setRuntimeStatus(entry, "ready");
        window.setTimeout(() => {
          if (
            entry.disposed ||
            !entry.opened ||
            entry.outputEventVersion !== outputEventVersionAtOpen
          ) {
            return;
          }
          void api.terminal
            .open(openInput)
            .then((nextSnapshot) => {
              if (
                entry.disposed ||
                entry.outputEventVersion !== outputEventVersionAtOpen ||
                !snapshotHasReplayPayload(nextSnapshot)
              ) {
                return;
              }
              replaySnapshot(entry, nextSnapshot, () => setRuntimeStatus(entry, "ready"));
            })
            .catch(() => {
              // Best-effort recovery only; the original open already succeeded.
            });
        }, OPEN_SNAPSHOT_RECONCILE_DELAY_MS);
      }
      if (entry.viewState.autoFocus) {
        window.requestAnimationFrame(() => {
          entry.terminal.focus();
        });
      }
    })
    .catch((error) => {
      if (entry.disposed) return;
      entry.opened = false;
      setRuntimeStatus(entry, "error");
      writeSystemMessage(entry.terminal, describeErrorMessage(error, "Failed to open terminal"));
    });
}

export function attachRuntimeToContainer(
  entry: TerminalRuntimeEntry,
  viewState: TerminalRuntimeViewState,
  container: HTMLDivElement,
): void {
  if (entry.container !== container) {
    detachRuntimeFromContainer(entry);
    entry.container = container;
    container.append(entry.wrapper);
  }

  updateRuntimeViewState(entry, viewState);
  maybeLoadWebglAddon(entry);
  ensureResizeObserver(entry);
  startVisibilityRecovery(entry);
  openTerminal(entry);
}

export function updateRuntimeViewState(
  entry: TerminalRuntimeEntry,
  nextViewState: TerminalRuntimeViewState,
): void {
  const wasVisible = entry.viewState.isVisible;
  entry.viewState = nextViewState;

  if (entry.container) {
    if (nextViewState.isVisible && !wasVisible) {
      maybeLoadWebglAddon(entry);
      applyInitialVisualResize(entry);
      ensureResizeObserver(entry);
      startVisibilityRecovery(entry);
    } else if (!nextViewState.isVisible && wasVisible) {
      cancelScheduledVisualResize(entry);
      stopVisibilityRecovery(entry);
      disposeWebglAddon(entry);
      clearAttachDisposables(entry);
    }
  }

  if (nextViewState.autoFocus) {
    window.requestAnimationFrame(() => {
      entry.terminal.focus();
    });
  }
}

export function detachRuntimeFromContainer(entry: TerminalRuntimeEntry): void {
  cancelScheduledVisualResize(entry);
  stopVisibilityRecovery(entry);
  disposeWebglAddon(entry);
  clearAttachDisposables(entry);
  clearBackendResizeTimer(entry);
  entry.pendingResize = null;
  entry.lastSentResize = null;
  entry.lastVisualResizeAt = 0;
  getTerminalParkingContainer().append(entry.wrapper);
  entry.container = null;
}

export function disposeRuntimeEntry(entry: TerminalRuntimeEntry): void {
  detachRuntimeFromContainer(entry);
  entry.disposed = true;
  // Closing a terminal should not synchronously paint queued output into a buffer
  // that is about to be destroyed; acknowledge and drop it to keep close latency low.
  clearPendingWrites(entry);
  entry.unsubscribeTerminalEvents?.();
  entry.unsubscribeTerminalEvents = null;
  entry.querySuppressionDispose?.();
  entry.querySuppressionDispose = null;
  if (entry.themeRefreshFrame !== 0) {
    window.cancelAnimationFrame(entry.themeRefreshFrame);
    entry.themeRefreshFrame = 0;
  }
  entry.themeObserver?.disconnect();
  entry.themeObserver = null;
  for (const disposable of entry.terminalDisposables) {
    disposable.dispose();
  }
  entry.terminalDisposables.length = 0;
  for (const dispose of entry.persistentDisposables) {
    dispose();
  }
  entry.persistentDisposables.length = 0;
  disposeWebglAddon(entry);
  entry.terminal.dispose();
  entry.wrapper.remove();
}

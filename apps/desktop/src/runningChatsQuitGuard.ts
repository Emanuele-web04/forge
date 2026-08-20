// FILE: runningChatsQuitGuard.ts
// Purpose: Coordinates the renderer Stay/Quit handshake before a user-initiated desktop quit.
// Layer: Desktop quit policy
// Depends on: Quit confirmation IPC payloads from the renderer.

import type {
  DesktopQuitConfirmationRequest,
  DesktopQuitConfirmationResponse,
} from "@synara/contracts";

const DEFAULT_READY_TIMEOUT_MS = 3000;

export function shouldPromptForRunningChatsBeforeQuit(reason: string): boolean {
  return reason === "window-close" || reason === "before-quit";
}

export function parseQuitConfirmationRequest(
  payload: unknown,
): DesktopQuitConfirmationRequest | null {
  if (payload == null || typeof payload !== "object") {
    return null;
  }
  const requestId = (payload as { readonly requestId?: unknown }).requestId;
  if (typeof requestId !== "string" || requestId.trim().length === 0) {
    return null;
  }
  return { requestId };
}

export function parseQuitConfirmationResponse(
  payload: unknown,
): DesktopQuitConfirmationResponse | null {
  if (payload == null || typeof payload !== "object") {
    return null;
  }
  const record = payload as {
    readonly requestId?: unknown;
    readonly phase?: unknown;
    readonly runningCount?: unknown;
    readonly allow?: unknown;
  };
  if (typeof record.requestId !== "string" || record.requestId.trim().length === 0) {
    return null;
  }
  if (record.phase === "ready") {
    if (typeof record.runningCount !== "number" || !Number.isFinite(record.runningCount)) {
      return null;
    }
    return {
      requestId: record.requestId,
      phase: "ready",
      runningCount: record.runningCount,
    };
  }
  if (record.phase === "decision" && typeof record.allow === "boolean") {
    return {
      requestId: record.requestId,
      phase: "decision",
      allow: record.allow,
    };
  }
  return null;
}

export interface RunningChatsQuitGuard {
  readonly hasAllowedQuit: () => boolean;
  readonly receiveResponse: (payload: unknown) => void;
  readonly askRenderer: (input: {
    readonly send: (request: DesktopQuitConfirmationRequest) => void;
    readonly isRendererAvailable: () => boolean;
    readonly readyTimeoutMs?: number;
  }) => Promise<boolean>;
}

interface PendingQuitConfirmation {
  readonly requestId: string;
  waitingForDecision: boolean;
  readyTimer: ReturnType<typeof setTimeout> | null;
  readonly resolve: (allow: boolean) => void;
}

export function makeRunningChatsQuitGuard(
  createRequestId: () => string = () => crypto.randomUUID(),
): RunningChatsQuitGuard {
  let allowed = false;
  let inFlight: Promise<boolean> | null = null;
  let pending: PendingQuitConfirmation | null = null;

  const finish = (allow: boolean): void => {
    const current = pending;
    pending = null;
    if (current?.readyTimer) {
      clearTimeout(current.readyTimer);
    }
    if (allow) {
      allowed = true;
    }
    current?.resolve(allow);
  };

  return {
    hasAllowedQuit: () => allowed,
    receiveResponse(payload: unknown): void {
      const response = parseQuitConfirmationResponse(payload);
      if (!response || pending == null || response.requestId !== pending.requestId) {
        return;
      }
      if (response.phase === "decision") {
        finish(response.allow);
        return;
      }
      if (pending.readyTimer) {
        clearTimeout(pending.readyTimer);
        pending.readyTimer = null;
      }
      if (response.runningCount <= 0) {
        finish(true);
        return;
      }
      pending.waitingForDecision = true;
    },
    askRenderer(input): Promise<boolean> {
      if (allowed) {
        return Promise.resolve(true);
      }
      if (inFlight) {
        return inFlight;
      }
      if (!input.isRendererAvailable()) {
        return Promise.resolve(true);
      }

      inFlight = new Promise<boolean>((resolve) => {
        const requestId = createRequestId();
        pending = {
          requestId,
          waitingForDecision: false,
          readyTimer: setTimeout(() => {
            if (pending?.requestId === requestId && !pending.waitingForDecision) {
              finish(true);
            }
          }, input.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS),
          resolve: (allow) => {
            inFlight = null;
            resolve(allow);
          },
        };
        try {
          input.send({ requestId });
        } catch {
          finish(true);
        }
      });
      return inFlight;
    },
  };
}

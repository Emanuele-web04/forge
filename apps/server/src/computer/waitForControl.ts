import { setTimeout as delay } from "node:timers/promises";
import type { ComputerState, ComputerTarget } from "@synara/contracts";
import { ComputerTargetError, resolveComputerSemanticTarget } from "./uiTreeTargeting.ts";

export interface ComputerControlReadiness {
  readonly status: "ready" | "timeout" | "unavailable" | "ambiguous" | "closed";
  readonly waitedMs: number;
}

/** Wait for a live semantic target without sending input or retaining coordinates. */
export async function waitForControl(
  read: () => Promise<ComputerState>,
  target: ComputerTarget,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ComputerControlReadiness> {
  const started = performance.now();
  const result = (status: ComputerControlReadiness["status"]): ComputerControlReadiness => ({
    status,
    waitedMs: Math.round(performance.now() - started),
  });
  while (true) {
    signal?.throwIfAborted();
    const state = await read();
    signal?.throwIfAborted();
    if (target.windowId && !state.windows.some((window) => window.id === target.windowId)) {
      return result("closed");
    }
    if (
      !state.root ||
      state.accessibility?.status === "unavailable" ||
      (target.windowId && state.accessibility?.unavailableWindowIds?.includes(target.windowId))
    )
      return result("unavailable");
    try {
      resolveComputerSemanticTarget(state.root, target);
      return result("ready");
    } catch (error) {
      if (!(error instanceof ComputerTargetError)) throw error;
      if (error.code === "computer_target_ambiguous") return result("ambiguous");
      if (error.code !== "computer_target_not_found") throw error;
    }
    // A truncated walk cannot establish absence; repeating it burns time
    // without establishing readiness. Let the caller use a scoped screenshot.
    if (state.root.truncated) return result("unavailable");
    const remaining = timeoutMs - (performance.now() - started);
    if (remaining <= 0) return result("timeout");
    await delay(Math.min(100, remaining), undefined, { signal });
  }
}

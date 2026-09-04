// FILE: useKeepAwakeState.ts
// Purpose: Live keep-awake (caffeinate) state pushed by the server.
// Layer: Web hooks
// Exports: useKeepAwakeState

import type { ServerKeepAwakeState } from "@synara/contracts";
import { useEffect, useState } from "react";
import { onServerKeepAwakeUpdated } from "../wsNativeApi";

/**
 * Returns the latest keep-awake state, or `null` until the server's first push
 * arrives. Callers hide keep-awake UI while `null` or `available === false`.
 */
export function useKeepAwakeState(): ServerKeepAwakeState | null {
  const [state, setState] = useState<ServerKeepAwakeState | null>(null);
  useEffect(() => onServerKeepAwakeUpdated((payload) => setState(payload.keepAwake)), []);
  return state;
}

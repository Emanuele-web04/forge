// FILE: terminalContextComposerRegistry.ts
// Purpose: Connect terminal selection actions to the composer that owns draft insertion.
// Layer: Chat capability registry

import type { TerminalContextSelection } from "./terminalContext";

export type TerminalContextComposerTarget = (selection: TerminalContextSelection) => void;

type RegistryListener = () => void;

const targetsByPaneScopeId = new Map<string, TerminalContextComposerTarget>();
const listenersByPaneScopeId = new Map<string, Set<RegistryListener>>();

function notifyTargetChanged(paneScopeId: string): void {
  const listeners = listenersByPaneScopeId.get(paneScopeId);
  if (!listeners) return;
  for (const listener of listeners) {
    listener();
  }
}

export function registerTerminalContextComposerTarget(
  paneScopeId: string,
  target: TerminalContextComposerTarget,
): () => void {
  targetsByPaneScopeId.set(paneScopeId, target);
  notifyTargetChanged(paneScopeId);
  return () => {
    if (targetsByPaneScopeId.get(paneScopeId) !== target) {
      return;
    }
    targetsByPaneScopeId.delete(paneScopeId);
    notifyTargetChanged(paneScopeId);
  };
}

export function getTerminalContextComposerTarget(
  paneScopeId: string,
): TerminalContextComposerTarget | undefined {
  return targetsByPaneScopeId.get(paneScopeId);
}

export function subscribeTerminalContextComposerTarget(
  paneScopeId: string,
  listener: RegistryListener,
): () => void {
  const listeners = listenersByPaneScopeId.get(paneScopeId) ?? new Set<RegistryListener>();
  listeners.add(listener);
  listenersByPaneScopeId.set(paneScopeId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      listenersByPaneScopeId.delete(paneScopeId);
    }
  };
}

// FILE: terminalVisualIdentity.ts
// Purpose: Centralizes terminal icon/title/activity view-model rules for every web surface.
// Layer: UI state logic
// Exports: terminal identity map resolution plus representative-terminal selection.

import {
  type ResolvedTerminalVisualIdentity,
  resolveTerminalVisualIdentity,
  type TerminalCliKind,
  type TerminalVisualState,
} from "@synara/shared/terminalThreads";

export interface RepresentativeTerminalVisualIdentity {
  terminalId: string;
  identity: ResolvedTerminalVisualIdentity;
}

function terminalVisualStatePriority(state: TerminalVisualState): number {
  switch (state) {
    case "attention":
      return 4;
    case "running":
      return 3;
    case "review":
      return 2;
    case "idle":
      return 1;
  }
}

function resolveTerminalVisualStateFromSet(input: {
  runningTerminalIdSet: ReadonlySet<string>;
  terminalAttentionStatesById: Record<string, "attention" | "review">;
  terminalId: string;
}): TerminalVisualState {
  const attentionState = input.terminalAttentionStatesById[input.terminalId] ?? null;
  if (attentionState === "attention") {
    return "attention";
  }
  if (input.runningTerminalIdSet.has(input.terminalId)) {
    return "running";
  }
  if (attentionState === "review") {
    return "review";
  }
  return "idle";
}

export function resolveTerminalVisualIdentityMap(input: {
  runningTerminalIds: readonly string[];
  terminalAttentionStatesById: Record<string, "attention" | "review">;
  terminalCliKindsById: Record<string, TerminalCliKind>;
  terminalIds: readonly string[];
  terminalLabelsById: Record<string, string>;
  terminalTitleOverridesById: Record<string, string>;
}): ReadonlyMap<string, ResolvedTerminalVisualIdentity> {
  const runningTerminalIdSet = new Set(
    input.runningTerminalIds.map((id) => id.trim()).filter((id) => id.length > 0),
  );

  return new Map(
    input.terminalIds.map((terminalId, index) => [
      terminalId,
      resolveTerminalVisualIdentity({
        cliKind: input.terminalCliKindsById[terminalId] ?? null,
        fallbackTitle: `Terminal ${index + 1}`,
        state: resolveTerminalVisualStateFromSet({
          runningTerminalIdSet,
          terminalAttentionStatesById: input.terminalAttentionStatesById,
          terminalId,
        }),
        title: input.terminalTitleOverridesById[terminalId] ?? input.terminalLabelsById[terminalId],
      }),
    ]),
  );
}

// Picks the terminal identity to represent a multi-terminal group or thread.
export function selectRepresentativeTerminalVisualIdentity(input: {
  activeTerminalId?: string | null | undefined;
  terminalIds: readonly string[];
  terminalVisualIdentityById: ReadonlyMap<string, ResolvedTerminalVisualIdentity>;
}): RepresentativeTerminalVisualIdentity | null {
  const fallbackTerminalId =
    input.activeTerminalId && input.terminalIds.includes(input.activeTerminalId)
      ? input.activeTerminalId
      : (input.terminalIds[0] ?? null);
  if (!fallbackTerminalId) {
    return null;
  }

  let representativeTerminalId = fallbackTerminalId;
  for (const terminalId of input.terminalIds) {
    const currentPriority = terminalVisualStatePriority(
      input.terminalVisualIdentityById.get(representativeTerminalId)?.state ?? "idle",
    );
    const nextPriority = terminalVisualStatePriority(
      input.terminalVisualIdentityById.get(terminalId)?.state ?? "idle",
    );
    if (nextPriority > currentPriority) {
      representativeTerminalId = terminalId;
    }
  }

  const identity = input.terminalVisualIdentityById.get(representativeTerminalId);
  return identity ? { terminalId: representativeTerminalId, identity } : null;
}

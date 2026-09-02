// FILE: keepAwake.ts
// Purpose: Single source of keep-awake (caffeinate) copy and indicator logic
//          shared by the Settings "System" section and the sidebar footer menu.
// Layer: Web lib (pure)
// Exports: KEEP_AWAKE_MODE_OPTIONS, labels/tooltip helpers, keepAwakeIndicatorState

import type { KeepAwakeMode, ServerKeepAwakeState } from "@synara/contracts";

export interface KeepAwakeModeOption {
  readonly value: KeepAwakeMode;
  readonly label: string;
  readonly description: string;
}

export const KEEP_AWAKE_ROW_TITLE = "Keep computer awake";

export const KEEP_AWAKE_MODE_OPTIONS: readonly KeepAwakeModeOption[] = [
  { value: "always", label: "On", description: "Keep this computer awake at all times." },
  {
    value: "agent",
    label: "Agent",
    description: "Keep this computer awake while an agent is working.",
  },
  { value: "off", label: "Off", description: "Let the system sleep normally." },
];

export function keepAwakeModeLabel(mode: KeepAwakeMode): string {
  return KEEP_AWAKE_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode;
}

export function keepAwakeActivityLabel(active: boolean): "Active" | "Idle" {
  return active ? "Active" : "Idle";
}

export function keepAwakeStatusLabel(state: Pick<ServerKeepAwakeState, "mode" | "active">): string {
  return `${keepAwakeModeLabel(state.mode)} · ${keepAwakeActivityLabel(state.active)}`;
}

export function keepAwakeTooltip(
  state: Pick<ServerKeepAwakeState, "mode" | "active" | "error">,
): string {
  return `Keep awake: ${state.error ?? keepAwakeStatusLabel(state)}`;
}

export type KeepAwakeIndicatorState = "dimmed" | "default" | "highlighted" | "error";

export function keepAwakeIndicatorState(
  mode: KeepAwakeMode,
  active: boolean,
  error: string | null,
): KeepAwakeIndicatorState {
  if (error !== null) return "error";
  if (mode === "off") return "dimmed";
  return active ? "highlighted" : "default";
}

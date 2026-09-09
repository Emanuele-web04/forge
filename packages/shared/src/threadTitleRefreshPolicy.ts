// FILE: threadTitleRefreshPolicy.ts
// Purpose: Opt-in automatic thread-title refresh policy for issue #1041.
// Layer: Shared pure utility (no I/O, no provider branching)
// Exports: policy type, defaults, resolution order thread > project > global.

export const THREAD_TITLE_REFRESH_MODES = ["off", "suggested", "automatic"] as const;

export type ThreadTitleRefreshMode = (typeof THREAD_TITLE_REFRESH_MODES)[number];

export const DEFAULT_THREAD_TITLE_REFRESH_MODE: ThreadTitleRefreshMode = "off";

export function normalizeThreadTitleRefreshMode(value: unknown): ThreadTitleRefreshMode {
  return value === "suggested" || value === "automatic" ? value : "off";
}

export interface ThreadTitleRefreshPolicyOverrides {
  readonly global?: ThreadTitleRefreshMode | undefined;
  readonly project?: ThreadTitleRefreshMode | undefined;
  readonly thread?: ThreadTitleRefreshMode | undefined;
}

/** Resolution order: thread override beats project override beats global default. Unknown values fall back to off. */
export function resolveThreadTitleRefreshMode(
  overrides: ThreadTitleRefreshPolicyOverrides,
): ThreadTitleRefreshMode {
  if (overrides.thread !== undefined) return normalizeThreadTitleRefreshMode(overrides.thread);
  if (overrides.project !== undefined) return normalizeThreadTitleRefreshMode(overrides.project);
  if (overrides.global !== undefined) return normalizeThreadTitleRefreshMode(overrides.global);
  return DEFAULT_THREAD_TITLE_REFRESH_MODE;
}

export function isThreadTitleRefreshEnabled(mode: ThreadTitleRefreshMode): boolean {
  return mode === "suggested" || mode === "automatic";
}

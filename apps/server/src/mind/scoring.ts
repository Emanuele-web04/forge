// Scoring model and constants adapted from "mind" (https://github.com/Da7-Tech/mind), Copyright (c) 2026 Da7-Tech, MIT License.
import type { MindMemoryType } from "@synara/contracts";

export const CONFIRM_WEIGHT_BUMP = 0.15;
// Synara choice: new memories start at 0.6 (plan 05 §6.2).
export const INITIAL_WEIGHT = 0.6;
export const MAX_WEIGHT = 1;
export const STABILITY_BASE_DAYS = 3;
export const STABILITY_PER_ACCESS_DAYS = 14;
export const TYPE_FACTORS: Record<MindMemoryType, number> = {
  semantic: 1,
  episodic: 0.75,
  procedural: 1.5,
  decision: 2,
};
export const PRUNE_WEIGHT_THRESHOLD = 0.1;
export const PRUNE_MIN_ACCESS_COUNT = 2;
export const PRUNE_GRACE_DAYS = 45;
export const RANK_WEIGHT_FLOOR = 0.35;
const DAY_MS = 86_400_000;

export interface ScoredMemory {
  readonly memoryId: string;
  readonly type: MindMemoryType;
  readonly peakWeight: number;
  readonly accessCount: number;
  readonly pinned: boolean;
  readonly lastAccessedAt: string;
}

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const idleDays = (memory: ScoredMemory, nowIso: string) =>
  Math.max(0, (Date.parse(nowIso) - Date.parse(memory.lastAccessedAt)) / DAY_MS);
export function effectiveWeight(memory: ScoredMemory, nowIso: string): number {
  const peak = clamp(memory.peakWeight);
  if (memory.pinned) return peak;
  const stability =
    (STABILITY_BASE_DAYS + STABILITY_PER_ACCESS_DAYS * Math.max(0, memory.accessCount)) *
    TYPE_FACTORS[memory.type];
  return clamp(peak * Math.exp(-idleDays(memory, nowIso) / stability));
}
export const confirmedWeight = (current: number) => clamp(current + CONFIRM_WEIGHT_BUMP);
export const rankScore = (bm25: number, weight: number) =>
  bm25 * (RANK_WEIGHT_FLOOR + (1 - RANK_WEIGHT_FLOOR) * clamp(weight));
export function shouldPrune(memory: ScoredMemory, nowIso: string): boolean {
  return (
    !memory.pinned &&
    memory.accessCount < PRUNE_MIN_ACCESS_COUNT &&
    idleDays(memory, nowIso) > PRUNE_GRACE_DAYS &&
    effectiveWeight(memory, nowIso) < PRUNE_WEIGHT_THRESHOLD
  );
}
export function rankCandidates<T extends ScoredMemory>(
  candidates: ReadonlyArray<{ readonly memory: T; readonly bm25: number }>,
  nowIso: string,
) {
  return candidates
    .map(({ memory, bm25 }) => ({
      memory,
      effectiveWeight: effectiveWeight(memory, nowIso),
      score: rankScore(bm25, effectiveWeight(memory, nowIso)),
    }))
    .toSorted((a, b) => a.score - b.score || a.memory.memoryId.localeCompare(b.memory.memoryId));
}

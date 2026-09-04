import {
  MIND_RECALL_MAX_DIGEST_CHARS,
  type MindMemory,
  type MindMemoryMatch,
} from "@synara/contracts";

/** Lambda so that ~45 days of idle decays a weight-1.0 memory to ~0.05. */
export const MIND_DECAY_LAMBDA = 0.0667;

/** Multiplier applied to the decayed score for each exact query-token match. */
const MIND_EXACT_TOKEN_MATCH_BOOST = 10.0;

const MILLIS_PER_DAY = 1000 * 60 * 60 * 24;

function tokenize(text: string): ReadonlyArray<string> {
  const matches = text.toLowerCase().match(/\b\w+\b/g);
  if (matches == null) return [];
  return [...new Set(matches)];
}

function exactMatchBoost(memory: MindMemory, query: string | undefined): number {
  if (query == null || query.trim().length === 0) return 1.0;
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 1.0;
  const memoryTokens = new Set(tokenize(memory.text));
  let matched = 0;
  for (const token of queryTokens) {
    if (memoryTokens.has(token)) matched += 1;
  }
  return 1.0 + MIND_EXACT_TOKEN_MATCH_BOOST * (matched / queryTokens.length);
}

/**
 * Compute the effective weight of a memory at a point in time.
 *
 * Pinned memories never decay. Otherwise the weight decays exponentially by
 * `exp(-0.0667 * daysIdle)`.
 */
export function computeMemoryDecay(memory: MindMemory, now: Date): number {
  if (memory.pinned) return memory.weight;
  const updatedAtMs = Date.parse(memory.updatedAt);
  if (!Number.isFinite(updatedAtMs)) return memory.weight;
  const daysIdle = (now.getTime() - updatedAtMs) / MILLIS_PER_DAY;
  return memory.weight * Math.exp(-MIND_DECAY_LAMBDA * Math.max(0, daysIdle));
}

/**
 * Rank memories for recall. Sorts by `decayedWeight * exactMatchBoost` descending,
 * then by `updatedAt` descending. Does not apply a limit.
 */
export function rankMindMemories(
  memories: ReadonlyArray<MindMemory>,
  query: string | undefined,
  now: Date,
): ReadonlyArray<MindMemoryMatch> {
  const scored = memories.map((memory) => {
    const decayedWeight = computeMemoryDecay(memory, now);
    const matchBoost = exactMatchBoost(memory, query);
    return {
      memory,
      decayedWeight,
      score: decayedWeight * matchBoost,
    };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Newer first for ties.
    if (b.memory.updatedAt > a.memory.updatedAt) return 1;
    if (b.memory.updatedAt < a.memory.updatedAt) return -1;
    return 0;
  });

  return scored.map((entry, index) => ({
    memory: entry.memory,
    rank: index + 1,
    decayedWeight: entry.decayedWeight,
  }));
}

/**
 * Join the text of the provided (already-ranked) matches and truncate the result
 * to `MIND_RECALL_MAX_DIGEST_CHARS`.
 */
export function buildMindRecallDigest(
  matches: ReadonlyArray<{ readonly memory: MindMemory; readonly rank: number }>,
): string {
  const full = matches.map((m) => m.memory.text).join("\n\n");
  if (full.length <= MIND_RECALL_MAX_DIGEST_CHARS) return full;
  return `${full.slice(0, MIND_RECALL_MAX_DIGEST_CHARS - 1)}…`;
}

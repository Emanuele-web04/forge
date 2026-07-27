// FILE: storeNormalization.test.ts
// Purpose: Pins the incremental activity accumulator to the `normalizeActivities` fold it replaces.

import { describe, expect, it } from "vitest";

import {
  createThreadActivityAccumulator,
  normalizeActivities,
  type ThreadActivityAccumulator,
} from "./storeNormalization";
import { makeActivity } from "./storeTestFixtures";
import type { Thread } from "./types";

type ThreadActivity = Thread["activities"][number];

interface FoldStep {
  readonly changed: boolean;
}

/**
 * The pre-optimisation batch fold: one full `normalizeActivities` call per appended activity.
 * Kept here (and only here) as the oracle the accumulator must reproduce exactly.
 */
function foldWithNormalizeActivities(
  previous: Thread["activities"],
  batch: readonly ThreadActivity[],
): { readonly result: Thread["activities"]; readonly steps: FoldStep[] } {
  let current = previous;
  const steps: FoldStep[] = [];
  for (const activity of batch) {
    const next = normalizeActivities([...current, activity], current);
    steps.push({ changed: next !== current });
    current = next;
  }
  return { result: current, steps };
}

function foldWithAccumulator(
  previous: Thread["activities"],
  batch: readonly ThreadActivity[],
): { readonly result: Thread["activities"]; readonly steps: FoldStep[] } {
  const accumulator: ThreadActivityAccumulator = createThreadActivityAccumulator(previous);
  const steps = batch.map((activity) => ({ changed: accumulator.append(activity) }));
  return { result: accumulator.result(), steps };
}

function expectEquivalent(previous: Thread["activities"], batch: readonly ThreadActivity[]): void {
  const oracle = foldWithNormalizeActivities(previous, batch);
  const accumulated = foldWithAccumulator(previous, batch);

  expect(accumulated.steps).toEqual(oracle.steps);
  expect(accumulated.result).toEqual(oracle.result);
  expect(accumulated.result.map((activity) => activity.id)).toEqual(
    oracle.result.map((activity) => activity.id),
  );
  // Reference-identity contract: both must fall back to `previous` when nothing changed, because
  // the reducer uses `next === thread.activities` to decide whether to write the thread at all.
  expect(accumulated.result === previous).toBe(oracle.result === previous);
}

const richPayload = {
  itemType: "command_execution",
  title: "Ran command",
  detail: "echo hello",
  data: { item: { type: "commandExecution", command: "echo hello" } },
};

describe("createThreadActivityAccumulator", () => {
  it("matches the normalizeActivities fold for appends, in-place merges and exact duplicates", () => {
    const existing = makeActivity({
      id: "activity-command",
      kind: "tool.completed",
      summary: "Ran command",
      createdAt: "2026-07-09T00:00:00.000Z",
      payload: richPayload,
      sequence: 1,
    });
    const previous = [makeActivity({ id: "activity-seed", sequence: 0 }), existing];
    const batch: ThreadActivity[] = [
      makeActivity({ id: "activity-new", sequence: 2 }),
      // Poorer re-delivery of an existing id: must merge in place and report "unchanged".
      makeActivity({
        id: "activity-command",
        kind: existing.kind,
        summary: existing.summary,
        createdAt: existing.createdAt,
        payload: { title: "Ran command" },
        sequence: 1,
      }),
      // Byte-identical re-delivery: must report "unchanged".
      { ...existing },
      // Richer re-delivery of a plain activity: must replace in place at its original index.
      makeActivity({ id: "activity-seed", payload: richPayload, sequence: 0 }),
      makeActivity({ id: "activity-last", sequence: 3 }),
    ];

    expectEquivalent(previous, batch);
  });

  it("matches the fold when the previous list still contains duplicate ids", () => {
    const duplicated = makeActivity({ id: "activity-dup", sequence: 1 });
    const previous = [duplicated, makeActivity({ id: "activity-other", sequence: 2 }), duplicated];

    // The very first append has to report "changed" because dedupe of `previous` alone rewrote
    // the list, exactly like `normalizeActivities` did on its first call.
    expectEquivalent(previous, [{ ...duplicated }]);
    expectEquivalent(previous, [makeActivity({ id: "activity-new", sequence: 3 })]);
  });

  it("matches the fold across the activity cap, including pending-request retention", () => {
    const pendingApproval = makeActivity({
      id: "activity-approval",
      kind: "approval.requested",
      summary: "Approve?",
      createdAt: "2026-07-09T00:00:00.000Z",
      payload: { requestId: "request-1" },
      sequence: 0,
    });
    const resolvedApproval = makeActivity({
      id: "activity-approval-resolved",
      kind: "approval.requested",
      summary: "Approve?",
      createdAt: "2026-07-09T00:00:00.000Z",
      payload: { requestId: "request-2" },
      sequence: 1,
    });
    const previous: ThreadActivity[] = [
      pendingApproval,
      resolvedApproval,
      makeActivity({
        id: "activity-approval-resolution",
        kind: "approval.resolved",
        payload: { requestId: "request-2" },
        sequence: 2,
      }),
      ...Array.from({ length: 2100 }, (_, index) =>
        makeActivity({ id: `activity-bulk-${index}`, sequence: 10 + index }),
      ),
    ];
    const batch = Array.from({ length: 25 }, (_, index) =>
      makeActivity({ id: `activity-batch-${index}`, sequence: 10_000 + index }),
    );

    expectEquivalent(previous, batch);

    const accumulated = foldWithAccumulator(previous, batch).result;
    // The still-pending approval survives the cap; the resolved one is dropped with the rest.
    expect(accumulated.some((activity) => activity.id === pendingApproval.id)).toBe(true);
    expect(accumulated.some((activity) => activity.id === resolvedApproval.id)).toBe(false);
  });

  it("returns the previous array by reference when the whole batch is a no-op", () => {
    const previous = [
      makeActivity({ id: "activity-a", sequence: 0 }),
      makeActivity({ id: "activity-b", sequence: 1 }),
    ];
    const accumulator = createThreadActivityAccumulator(previous);

    expect(accumulator.append({ ...previous[0]! })).toBe(false);
    expect(accumulator.append({ ...previous[1]! })).toBe(false);
    expect(accumulator.result()).toBe(previous);
  });

  it("never mutates the caller's previous array", () => {
    const previous = [makeActivity({ id: "activity-a", sequence: 0 })];
    const snapshot = [...previous];
    const accumulator = createThreadActivityAccumulator(previous);

    accumulator.append(makeActivity({ id: "activity-b", sequence: 1 }));
    accumulator.append(makeActivity({ id: "activity-a", payload: richPayload, sequence: 0 }));

    expect(previous).toEqual(snapshot);
    expect(accumulator.result()).not.toBe(previous);
  });
});

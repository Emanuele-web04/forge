// Perf probe: client store hot path under N concurrently streaming threads, plus the cost of
// re-applying a real thread-detail snapshot (the periodic projection reconcile).
//   SYNARA_PERF=1 bunx vitest run perf/clientHotPath.perf.test.ts
// Snapshot fixtures come from apps/server/perf/threadDetailSnapshot.perf.test.ts
// (/tmp/synara-perf/snapshot-{p50,p90,max}.json).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  MessageId,
  OrchestrationThreadDetailSnapshot,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@synara/contracts";
import { Schema } from "effect";
import { describe, it } from "vitest";

import { coalesceOrchestrationUiEvents } from "../src/orchestrationEventCoalescing";
import { applyOrchestrationEventsHotPath } from "../src/storeEventReducer";
import { syncServerThreadDetail, syncServerThreadDetailHotPath } from "../src/storeProjection";
import type { AppState } from "../src/storeState";
import { makeActivity, makeDomainEvent, makeState, makeThread } from "../src/storeTestFixtures";

const ENABLED = process.env.SYNARA_PERF === "1";
const FIXTURE_DIR = process.env.SYNARA_PERF_DIR ?? "/tmp/synara-perf";
const THREAD_COUNTS = [1, 4, 8];
const FLUSHES = Number(process.env.SYNARA_PERF_FLUSHES ?? 40);
// Per thread per 100ms flush: a busy Codex/Claude turn interleaves text deltas with tool
// activity. Real DB averages: ~66 chars per delta, ~1.8KB per tool.updated payload.
const DELTAS_PER_THREAD_PER_FLUSH = 6;
const ACTIVITIES_PER_THREAD_PER_FLUSH = 3;
const DELTA_TEXT = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod ";
const ACTIVITY_PAYLOAD = { output: "y".repeat(1_700), status: "running", exitCode: null };

/** The adjacent-only coalescer that shipped in routes/__root.tsx before this change. */
function legacyCoalesce(events: ReadonlyArray<OrchestrationEvent>): OrchestrationEvent[] {
  if (events.length < 2) return [...events];
  const coalesced: OrchestrationEvent[] = [];
  for (const event of events) {
    const previous = coalesced.at(-1);
    if (
      previous?.type === "thread.message-sent" &&
      event.type === "thread.message-sent" &&
      previous.payload.threadId === event.payload.threadId &&
      previous.payload.messageId === event.payload.messageId
    ) {
      coalesced[coalesced.length - 1] = {
        ...event,
        payload: {
          ...event.payload,
          attachments: event.payload.attachments ?? previous.payload.attachments,
          createdAt: previous.payload.createdAt,
          text:
            !event.payload.streaming && event.payload.text.length > 0
              ? event.payload.text
              : previous.payload.text + event.payload.text,
        },
      };
      continue;
    }
    coalesced.push(event);
  }
  return coalesced;
}

const percentile = (values: number[], p: number) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
};
const round = (value: number) => +value.toFixed(3);

function loadSnapshot(label: string) {
  const path = `${FIXTURE_DIR}/snapshot-${label}.json`;
  if (!existsSync(path)) return null;
  const json = readFileSync(path, "utf8");
  return { label, json };
}

function decodeSnapshot(json: string) {
  const t0 = performance.now();
  const parsed: unknown = JSON.parse(json);
  const t1 = performance.now();
  const decoded = Schema.decodeUnknownSync(OrchestrationThreadDetailSnapshot)(parsed);
  const t2 = performance.now();
  return { decoded, parseMs: t1 - t0, decodeMs: t2 - t1 };
}

function retargetThread(thread: OrchestrationThread, threadId: ThreadId): OrchestrationThread {
  return { ...thread, id: threadId };
}

function buildInterleavedFlush(
  threadIds: readonly ThreadId[],
  flushIndex: number,
  sequenceStart: number,
): OrchestrationEvent[] {
  const events: OrchestrationEvent[] = [];
  let sequence = sequenceStart;
  const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, flushIndex)).toISOString();
  const steps = Math.max(DELTAS_PER_THREAD_PER_FLUSH, ACTIVITIES_PER_THREAD_PER_FLUSH);
  for (let step = 0; step < steps; step += 1) {
    for (const threadId of threadIds) {
      if (step < DELTAS_PER_THREAD_PER_FLUSH) {
        events.push(
          makeDomainEvent(
            "thread.message-sent",
            {
              threadId,
              messageId: MessageId.makeUnsafe(`streaming-${threadId}`),
              role: "assistant",
              text: DELTA_TEXT,
              turnId: null,
              streaming: true,
              source: "native",
              createdAt,
              updatedAt: createdAt,
            },
            { sequence: (sequence += 1) },
          ),
        );
      }
      if (step < ACTIVITIES_PER_THREAD_PER_FLUSH) {
        events.push(
          makeDomainEvent(
            "thread.activity-appended",
            {
              threadId,
              activity: makeActivity({
                id: `activity-${threadId}-${flushIndex}-${step}`,
                kind: "tool.updated",
                createdAt,
                payload: ACTIVITY_PAYLOAD,
              }),
            },
            { sequence: (sequence += 1) },
          ),
        );
      }
    }
  }
  return events;
}

describe.skipIf(!ENABLED)("client hot path perf", () => {
  it("measures snapshot decode/merge and per-flush reducer cost", () => {
    const report: Record<string, unknown> = {};
    const snapshots = ["p50", "p90", "max"]
      .map(loadSnapshot)
      .filter((entry): entry is { label: string; json: string } => entry !== null);
    if (snapshots.length === 0) {
      throw new Error(`No snapshot fixtures in ${FIXTURE_DIR}; run the server probe first.`);
    }

    // 1. Snapshot reconcile cost: JSON.parse + schema decode + merge into a store that already
    //    holds the identical thread (the steady-state "nothing changed" reconcile).
    const snapshotReport: Record<string, unknown>[] = [];
    for (const { label, json } of snapshots) {
      const parseMs: number[] = [];
      const decodeMs: number[] = [];
      const mergeMs: number[] = [];
      let state = makeState(makeThread({ id: ThreadId.makeUnsafe("seed") }));
      const first = decodeSnapshot(json);
      state = syncServerThreadDetail(state, first.decoded.thread);
      for (let i = 0; i < 8; i += 1) {
        const run = decodeSnapshot(json);
        parseMs.push(run.parseMs);
        decodeMs.push(run.decodeMs);
        const t0 = performance.now();
        const next = syncServerThreadDetailHotPath(state, run.decoded.thread);
        mergeMs.push(performance.now() - t0);
        state = next;
      }
      snapshotReport.push({
        label,
        jsonKB: Math.round(json.length / 1024),
        messages: first.decoded.thread.messages.length,
        activities: first.decoded.thread.activities.length,
        parseP50Ms: round(percentile(parseMs, 0.5)),
        decodeP50Ms: round(percentile(decodeMs, 0.5)),
        mergeP50Ms: round(percentile(mergeMs, 0.5)),
        totalP50Ms: round(
          percentile(parseMs, 0.5) + percentile(decodeMs, 0.5) + percentile(mergeMs, 0.5),
        ),
      });
    }
    report.snapshotReconcile = snapshotReport;

    // 2. Per-flush reducer cost with N threads streaming concurrently (interleaved deltas),
    //    legacy adjacent-only coalescing vs keyed coalescing.
    const base = snapshots.find((entry) => entry.label === "p90") ?? snapshots[0]!;
    const baseThread = decodeSnapshot(base.json).decoded.thread;
    const flushReport: Record<string, unknown>[] = [];
    for (const threadCount of THREAD_COUNTS) {
      const threadIds = Array.from({ length: threadCount }, (_, index) =>
        ThreadId.makeUnsafe(`thread-${index}`),
      );
      const seedState = (): AppState => {
        let state = makeState(makeThread({ id: ThreadId.makeUnsafe("seed") }));
        for (const threadId of threadIds) {
          state = syncServerThreadDetail(state, retargetThread(baseThread, threadId));
        }
        return state;
      };
      for (const [mode, coalesce] of [
        ["legacy", legacyCoalesce],
        ["keyed", coalesceOrchestrationUiEvents],
      ] as const) {
        let state = seedState();
        const flushMs: number[] = [];
        let rawEvents = 0;
        let coalescedEvents = 0;
        let sequence = 1_000_000;
        for (let flush = 0; flush < FLUSHES; flush += 1) {
          const events = buildInterleavedFlush(threadIds, flush, sequence);
          sequence += events.length;
          const t0 = performance.now();
          const coalesced = coalesce(events);
          state = applyOrchestrationEventsHotPath(state, coalesced, {
            updateSidebarSummary: false,
          });
          flushMs.push(performance.now() - t0);
          rawEvents += events.length;
          coalescedEvents += coalesced.length;
        }
        flushReport.push({
          threads: threadCount,
          mode,
          rawEventsPerFlush: rawEvents / FLUSHES,
          coalescedEventsPerFlush: coalescedEvents / FLUSHES,
          flushP50Ms: round(percentile(flushMs, 0.5)),
          flushP95Ms: round(percentile(flushMs, 0.95)),
        });
      }
    }
    report.flush = flushReport;
    writeFileSync(
      process.env.SYNARA_PERF_OUT ?? `${FIXTURE_DIR}/client-report.json`,
      JSON.stringify(report, null, 2),
    );
  }, 300_000);
});

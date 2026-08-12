// FILE: accountUsageReporter.test.ts
// Purpose: Coverage for the event-driven account usage reporter — per-minute
// bucket derivation against the migrated SQLite schema, watermark handling,
// debounce coalescing, batch splitting, regrowth recompute, signed-out
// inertness, and failure backoff.
// Layer: Server account tests

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { PushUsageRequest } from "@synara/contracts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import {
  chunkingForTesting,
  collectUsageBuckets,
  createAccountUsageReporter,
  isAccountUsageRelevantEventType,
  minuteStartIso,
  type AccountUsageReporterDeps,
} from "./accountUsageReporter";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";

const testLayer = SqlitePersistenceMemory.pipe(Layer.provide(NodeServices.layer));

function runReporterTest<A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) {
  return effect.pipe(Effect.provide(testLayer), Effect.scoped, Effect.runPromise);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RecordedPush {
  readonly request: PushUsageRequest;
}

function makeReporterHarness(
  sql: SqlClient.SqlClient,
  overrides: Partial<AccountUsageReporterDeps> = {},
) {
  const pushes: RecordedPush[] = [];
  const reporter = createAccountUsageReporter({
    sql,
    baseDir: "/nonexistent-account-usage-test",
    isSignedIn: async () => true,
    environmentId: async () => "env-test",
    accountIdentity: async () => "https://accounts.example.com#org_1",
    push: async (request) => {
      pushes.push({ request });
    },
    // High debounce so only explicit flushNow calls (or explicitly small
    // overrides) drive flushes; the construction-time catch-up stays pending.
    debounceMs: 60_000,
    log: () => {},
    ...overrides,
  });
  return { reporter, pushes };
}

const readSyncState = (sql: SqlClient.SqlClient) =>
  sql<{
    readonly watermarkMinute: string | null;
    readonly lastFailureAt: string | null;
    readonly accountIdentity: string | null;
  }>`
    SELECT
      watermark_minute AS watermarkMinute,
      last_failure_at AS lastFailureAt,
      account_identity AS accountIdentity
    FROM account_usage_sync
    WHERE id = 1
  `.pipe(Effect.map((rows) => rows[0]));

// ── Seed helpers ───────────────────────────────────────────────────────

const seedThread = (
  sql: SqlClient.SqlClient,
  threadId: string,
  modelSelectionJson: string | null,
) => sql`
  INSERT INTO projection_threads (
    thread_id, project_id, title, model_selection_json, runtime_mode,
    interaction_mode, env_mode, created_at, updated_at, deleted_at
  ) VALUES (
    ${threadId}, 'project-usage', 'Usage Thread', ${modelSelectionJson},
    'full-access', 'default', 'local',
    '2026-08-11T09:00:00.000Z', '2026-08-11T09:00:00.000Z', NULL
  )
`;

const seedTurnStartEvent = (
  sql: SqlClient.SqlClient,
  input: {
    readonly eventId: string;
    readonly threadId: string;
    readonly streamVersion: number;
    readonly occurredAt: string;
    readonly payloadJson: string;
  },
) => sql`
  INSERT INTO orchestration_events (
    event_id, aggregate_kind, stream_id, stream_version, event_type,
    occurred_at, actor_kind, payload_json, metadata_json
  ) VALUES (
    ${input.eventId}, 'thread', ${input.threadId}, ${input.streamVersion},
    'thread.turn-start-requested', ${input.occurredAt}, 'client',
    ${input.payloadJson}, '{}'
  )
`;

const seedUserMessage = (
  sql: SqlClient.SqlClient,
  input: {
    readonly messageId: string;
    readonly threadId: string;
    readonly turnId: string | null;
    readonly createdAt: string;
    readonly text?: string;
    readonly skillsJson?: string | null;
    readonly mentionsJson?: string | null;
    readonly dispatchOrigin?: string | null;
  },
) => sql`
  INSERT INTO projection_thread_messages (
    message_id, thread_id, turn_id, role, text, skills_json, mentions_json,
    dispatch_origin, is_streaming, source, created_at, updated_at
  ) VALUES (
    ${input.messageId}, ${input.threadId}, ${input.turnId}, 'user',
    ${input.text ?? "hello"}, ${input.skillsJson ?? null}, ${input.mentionsJson ?? null},
    ${input.dispatchOrigin ?? null}, 0, 'native', ${input.createdAt}, ${input.createdAt}
  )
`;

const seedTurn = (
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly pendingMessageId: string;
    readonly requestedAt: string;
  },
) => sql`
  INSERT INTO projection_turns (
    thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json
  ) VALUES (
    ${input.threadId}, ${input.turnId}, ${input.pendingMessageId}, 'completed',
    ${input.requestedAt}, '[]'
  )
`;

const seedTokenActivity = (
  sql: SqlClient.SqlClient,
  input: {
    readonly activityId: string;
    readonly threadId: string;
    readonly turnId: string | null;
    readonly sequence: number;
    readonly createdAt: string;
    readonly payloadJson: string;
  },
) => sql`
  INSERT INTO projection_thread_activities (
    activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
  ) VALUES (
    ${input.activityId}, ${input.threadId}, ${input.turnId}, 'info',
    'context-window.updated', 'tokens updated', ${input.payloadJson},
    ${input.sequence}, ${input.createdAt}
  )
`;

// Full fixture: two turns on one thread (model switch between them), token
// activities across two minutes, a skill-bearing prompt, and an
// agent-dispatched prompt that must not count.
const seedUsageFixture = Effect.fnUntraced(function* (sql: SqlClient.SqlClient) {
  yield* seedThread(sql, "thread-a", '{"provider":"codex","model":"gpt-5-codex"}');

  // Turn 1: claudeAgent/fable at effort max — attribution must follow the
  // turn's selection, not the thread's current (codex) selection.
  yield* seedUserMessage(sql, {
    messageId: "msg-1",
    threadId: "thread-a",
    turnId: "turn-1",
    createdAt: "2026-08-11T09:05:10.000Z",
    text: "use $check-code please",
    skillsJson: '[{"name":"check-code","path":"/skills/check-code/SKILL.md"}]',
  });
  yield* seedTurn(sql, {
    threadId: "thread-a",
    turnId: "turn-1",
    pendingMessageId: "msg-1",
    requestedAt: "2026-08-11T09:05:10.000Z",
  });
  yield* seedTurnStartEvent(sql, {
    eventId: "evt-1",
    threadId: "thread-a",
    streamVersion: 1,
    occurredAt: "2026-08-11T09:05:10.000Z",
    payloadJson:
      '{"threadId":"thread-a","messageId":"msg-1","modelSelection":{"provider":"claudeAgent","model":"claude-fable-5","options":{"effort":"max"}}}',
  });
  // Cumulative counter: 1000 in minute 09:05, grows to 1600 in minute 09:06.
  yield* seedTokenActivity(sql, {
    activityId: "act-1",
    threadId: "thread-a",
    turnId: "turn-1",
    sequence: 1,
    createdAt: "2026-08-11T09:05:20.000Z",
    payloadJson: '{"totalProcessedTokens":1000}',
  });
  yield* seedTokenActivity(sql, {
    activityId: "act-2",
    threadId: "thread-a",
    turnId: "turn-1",
    sequence: 2,
    createdAt: "2026-08-11T09:06:05.000Z",
    payloadJson: '{"totalProcessedTokens":1600}',
  });

  // Turn 2, same minute 09:06: codex without reasoning options.
  yield* seedUserMessage(sql, {
    messageId: "msg-2",
    threadId: "thread-a",
    turnId: "turn-2",
    createdAt: "2026-08-11T09:06:30.000Z",
    text: "continue",
  });
  yield* seedTurn(sql, {
    threadId: "thread-a",
    turnId: "turn-2",
    pendingMessageId: "msg-2",
    requestedAt: "2026-08-11T09:06:30.000Z",
  });
  yield* seedTurnStartEvent(sql, {
    eventId: "evt-2",
    threadId: "thread-a",
    streamVersion: 2,
    occurredAt: "2026-08-11T09:06:30.000Z",
    payloadJson:
      '{"threadId":"thread-a","messageId":"msg-2","modelSelection":{"provider":"codex","model":"gpt-5-codex"}}',
  });
  // Cumulative counter keeps growing under the new turn's model.
  yield* seedTokenActivity(sql, {
    activityId: "act-3",
    threadId: "thread-a",
    turnId: "turn-2",
    sequence: 3,
    createdAt: "2026-08-11T09:06:45.000Z",
    payloadJson: '{"totalProcessedTokens":1850}',
  });

  // Agent-dispatched prompt: excluded from prompts, turns, and tokens.
  yield* seedUserMessage(sql, {
    messageId: "msg-agent",
    threadId: "thread-a",
    turnId: "turn-agent",
    createdAt: "2026-08-11T09:07:00.000Z",
    dispatchOrigin: "agent",
  });
  yield* seedTurn(sql, {
    threadId: "thread-a",
    turnId: "turn-agent",
    pendingMessageId: "msg-agent",
    requestedAt: "2026-08-11T09:07:00.000Z",
  });
  yield* seedTurnStartEvent(sql, {
    eventId: "evt-agent",
    threadId: "thread-a",
    streamVersion: 3,
    occurredAt: "2026-08-11T09:07:00.000Z",
    payloadJson:
      '{"threadId":"thread-a","messageId":"msg-agent","modelSelection":{"provider":"codex","model":"gpt-5-codex"}}',
  });
});

// Archived (purged-thread) aggregates: what profileStatsArchive.ts leaves in
// the profile_stats_deleted_* tables after a hard delete. Two threads: one
// with full evidence (tokens + prompts + turns + skills), one whose only rows
// are timestampless turns — no synthetic minute exists for it, so it must be
// skipped rather than invented.
const seedArchivedFixture = Effect.fnUntraced(function* (sql: SqlClient.SqlClient) {
  yield* sql`
    INSERT INTO profile_stats_deleted_tokens (thread_id, created_at, provider, model, tokens)
    VALUES
      ('thread-purged', '2026-08-01T14:03:12.000Z', 'codex', 'gpt-5-codex', 300),
      ('thread-purged', '2026-08-02T10:30:45.000Z', 'codex', 'gpt-5-codex', 200)
  `;
  yield* sql`
    INSERT INTO profile_stats_deleted_prompts (thread_id, project_id, created_at)
    VALUES
      ('thread-purged', 'project-usage', '2026-08-01T14:03:00.000Z'),
      ('thread-purged', 'project-usage', '2026-08-02T10:30:00.000Z')
  `;
  yield* sql`
    INSERT INTO profile_stats_deleted_turns (thread_id, provider, model, reasoning, turn_count)
    VALUES ('thread-purged', 'codex', 'gpt-5-codex', NULL, 3)
  `;
  yield* sql`
    INSERT INTO profile_stats_deleted_skills (thread_id, name, kind, run_count)
    VALUES ('thread-purged', 'check-code', 'skill', 2)
  `;
  // No tokens and no prompts for this thread: nothing carries a timestamp,
  // so its turn count has no minute to land on and is skipped.
  yield* sql`
    INSERT INTO profile_stats_deleted_turns (thread_id, provider, model, reasoning, turn_count)
    VALUES ('thread-orphan-turns', 'grok', 'grok-4', NULL, 5)
  `;
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("minuteStartIso", () => {
  it("floors to the UTC minute in the contract's fixed spelling", () => {
    expect(minuteStartIso(Date.parse("2026-08-11T09:05:42.813Z"))).toBe("2026-08-11T09:05:00Z");
    expect(minuteStartIso(Date.parse("2026-08-11T09:05:00.000Z"))).toBe("2026-08-11T09:05:00Z");
  });
});

describe("isAccountUsageRelevantEventType", () => {
  it("keeps usage-shaped events and drops the streaming bulk", () => {
    expect(isAccountUsageRelevantEventType("thread.turn-start-requested")).toBe(true);
    expect(isAccountUsageRelevantEventType("thread.message-sent")).toBe(true);
    expect(isAccountUsageRelevantEventType("thread.activity-appended")).toBe(true);
    expect(isAccountUsageRelevantEventType("thread.message.assistant.delta")).toBe(false);
    expect(isAccountUsageRelevantEventType("thread.meta-updated")).toBe(false);
  });
});

describe("collectUsageBuckets", () => {
  it("derives per-minute token deltas, turns, prompts, and skills with model+reasoning attribution", async () => {
    await runReporterTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedUsageFixture(sql);

        const { models, skills } = yield* collectUsageBuckets(sql, "2026-08-11T09:00:00Z");

        expect(models).toEqual([
          {
            minute: "2026-08-11T09:05:00Z",
            provider: "claudeAgent",
            model: "claude-fable-5",
            reasoning: "max",
            tokens: 1000,
            turns: 1,
            prompts: 1,
          },
          {
            minute: "2026-08-11T09:06:00Z",
            provider: "claudeAgent",
            model: "claude-fable-5",
            reasoning: "max",
            tokens: 600,
            turns: 0,
            prompts: 0,
          },
          {
            minute: "2026-08-11T09:06:00Z",
            provider: "codex",
            model: "gpt-5-codex",
            reasoning: null,
            tokens: 250,
            turns: 1,
            prompts: 1,
          },
        ]);
        expect(skills).toEqual([
          { minute: "2026-08-11T09:05:00Z", name: "check-code", kind: "skill", runs: 1 },
        ]);
      }),
    );
  });

  it("does not count pre-window cumulative history as a delta when the window cuts a thread", async () => {
    await runReporterTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedUsageFixture(sql);

        // Window starts at 09:06 — the 09:05 counter (1000) is history; only
        // the growth inside the window (600 + 250) may count.
        const { models } = yield* collectUsageBuckets(sql, "2026-08-11T09:06:00Z");
        const totalTokens = models.reduce((sum, bucket) => sum + bucket.tokens, 0);
        expect(totalTokens).toBe(850);
        expect(models.every((bucket) => bucket.minute >= "2026-08-11T09:06:00Z")).toBe(true);
      }),
    );
  });

  // Threads purged before their first sync live only in the
  // profile_stats_deleted_* archive. The account totals must match what the
  // local dashboard (profileStats.ts) counts from those same tables: every
  // archived token, prompt, turn, and skill run.
  it("folds archived purged-thread aggregates into the buckets, matching the local totals", async () => {
    await runReporterTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedArchivedFixture(sql);

        const { models, skills } = yield* collectUsageBuckets(sql, "2026-07-01T00:00:00Z");

        // Totals match profileStats over the same tables: SUM(tokens) = 500,
        // 2 prompts, 3 turns for the evidenced thread; the timestampless
        // orphan-turn thread contributes nothing anywhere.
        expect(models.reduce((sum, bucket) => sum + bucket.tokens, 0)).toBe(500);
        expect(models.reduce((sum, bucket) => sum + bucket.prompts, 0)).toBe(2);
        expect(models.reduce((sum, bucket) => sum + bucket.turns, 0)).toBe(3);
        expect(models.some((bucket) => bucket.provider === "grok")).toBe(false);

        // Tokens bucket by their archived created_at minute.
        const firstMinute = models.find(
          (bucket) => bucket.minute === "2026-08-01T14:03:00Z" && bucket.provider === "codex",
        );
        expect(firstMinute).toMatchObject({ model: "gpt-5-codex", reasoning: null, tokens: 300 });

        // Turns land on the thread's synthetic minute — its most recent
        // archived token timestamp — merged with that minute's token bucket.
        const syntheticMinute = models.find(
          (bucket) => bucket.minute === "2026-08-02T10:30:00Z" && bucket.provider === "codex",
        );
        expect(syntheticMinute).toMatchObject({ tokens: 200, turns: 3 });

        // Skills use the same synthetic minute.
        expect(skills).toEqual([
          { minute: "2026-08-02T10:30:00Z", name: "check-code", kind: "skill", runs: 2 },
        ]);
      }),
    );
  });

  it("excludes archived aggregates that fall before the window", async () => {
    await runReporterTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedArchivedFixture(sql);

        const { models, skills } = yield* collectUsageBuckets(sql, "2026-08-03T00:00:00Z");
        expect(models).toEqual([]);
        expect(skills).toEqual([]);
      }),
    );
  });
});

describe("chunkByMinute", () => {
  const { chunkByMinute } = chunkingForTesting;

  const bucket = (minute: string, padding = 0) => ({
    minute,
    provider: "codex",
    model: `gpt-5-codex${"x".repeat(padding)}`,
    reasoning: null,
    tokens: 1000,
    turns: 1,
    prompts: 1,
  });

  it("splits on the bucket-count cap at complete minute boundaries", () => {
    const buckets = [
      bucket("2026-08-10T00:00:00Z"),
      bucket("2026-08-10T00:00:00Z", 1),
      bucket("2026-08-10T00:01:00Z"),
      bucket("2026-08-10T00:01:00Z", 1),
      bucket("2026-08-10T00:02:00Z"),
    ];

    const chunks = chunkByMinute(buckets, 3, Number.POSITIVE_INFINITY);

    // Minute 00:01 does not fit next to minute 00:00's two buckets under a
    // cap of 3 — it moves WHOLE to the next chunk, never split.
    expect(chunks.map((chunk) => chunk.map((item) => item.minute))).toEqual([
      ["2026-08-10T00:00:00Z", "2026-08-10T00:00:00Z"],
      ["2026-08-10T00:01:00Z", "2026-08-10T00:01:00Z", "2026-08-10T00:02:00Z"],
    ]);
  });

  it("splits on the byte budget before the count cap is reached", () => {
    // Four one-bucket minutes, each ~large; a budget of ~2.5 buckets' bytes
    // forces two per chunk even though the count cap (500) is nowhere near.
    const oneBucketBytes = Buffer.byteLength(JSON.stringify(bucket("2026-08-10T00:00:00Z"))) + 1;
    const buckets = [
      bucket("2026-08-10T00:00:00Z"),
      bucket("2026-08-10T00:01:00Z"),
      bucket("2026-08-10T00:02:00Z"),
      bucket("2026-08-10T00:03:00Z"),
    ];

    const chunks = chunkByMinute(buckets, 500, Math.floor(oneBucketBytes * 2.5));

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(2);
    expect(chunks[1]).toHaveLength(2);
  });

  it("never splits one minute across chunks even when it alone busts the byte budget", () => {
    // A single enormous minute (many buckets) exceeding the budget must ship
    // as ONE oversized chunk: splitting it would let the API's
    // minute-replacement delete the first half, and dropping it loses data.
    const buckets = [
      bucket("2026-08-10T00:00:00Z"),
      ...Array.from({ length: 10 }, (_, index) => bucket("2026-08-10T00:01:00Z", index)),
      bucket("2026-08-10T00:02:00Z"),
    ];

    const chunks = chunkByMinute(buckets, 500, 300);

    for (const chunk of chunks) {
      expect(new Set(chunk.map((item) => item.minute)).size).toBeGreaterThan(0);
    }
    const oversized = chunks.find((chunk) =>
      chunk.some((item) => item.minute === "2026-08-10T00:01:00Z"),
    );
    expect(oversized?.filter((item) => item.minute === "2026-08-10T00:01:00Z")).toHaveLength(10);
    // The neighbouring minutes were not dropped either.
    expect(chunks.flat()).toHaveLength(12);
  });

  it("500 buckets of realistic size would overflow the transport cap without the byte budget", () => {
    // The regression this exists for: USAGE_PUSH_MAX_BUCKETS (500) buckets
    // with plausible dimension strings serialize past 64 KiB. The byte
    // budget must split them even though the count cap alone would not.
    const buckets = Array.from({ length: 500 }, (_, index) =>
      bucket(minuteStartIso(Date.parse("2026-08-10T00:00:00Z") + index * 60_000), 20),
    );
    expect(Buffer.byteLength(JSON.stringify(buckets))).toBeGreaterThan(64 * 1024);

    const chunks = chunkByMinute(buckets, 500);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThanOrEqual(
        chunkingForTesting.USAGE_PUSH_MAX_STREAM_BYTES,
      );
    }
    expect(chunks.flat()).toHaveLength(500);
  });
});

describe("createAccountUsageReporter", () => {
  it("pushes absolute buckets and advances the watermark only on success", async () => {
    await runReporterTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedUsageFixture(sql);

        const flushedAt = Date.parse("2026-08-11T09:10:30.000Z");
        let failPush = true;
        const pushes: PushUsageRequest[] = [];
        const { reporter } = makeReporterHarness(sql, {
          now: () => flushedAt,
          push: async (request) => {
            if (failPush) throw new Error("account unreachable");
            pushes.push(request);
          },
        });

        yield* Effect.promise(() => reporter.flushNow());
        const afterFailure = yield* readSyncState(sql);
        expect(afterFailure?.watermarkMinute).toBeNull();
        expect(afterFailure?.lastFailureAt).toBe(new Date(flushedAt).toISOString());
        expect(pushes).toHaveLength(0);

        failPush = false;
        yield* Effect.promise(() => reporter.flushNow());
        const afterSuccess = yield* readSyncState(sql);
        // Watermark = newest fully elapsed minute at flush start, scoped to
        // the identity it belongs to.
        expect(afterSuccess?.watermarkMinute).toBe("2026-08-11T09:09:00Z");
        expect(afterSuccess?.lastFailureAt).toBeNull();
        expect(afterSuccess?.accountIdentity).toBe("https://accounts.example.com#org_1");
        expect(pushes).toHaveLength(1);
        expect(pushes[0]?.environmentId).toBe("env-test");
        expect(pushes[0]?.models).toHaveLength(3);
        expect(pushes[0]?.skills).toHaveLength(1);

        reporter.stop();
      }),
    );
  });

  it("recomputes a grown minute and re-pushes its larger absolute value", async () => {
    await runReporterTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedUsageFixture(sql);

        // Flush "now" stays within the fixture's active minute, so the
        // watermark safety lap keeps re-covering it as it grows.
        const flushedAt = Date.parse("2026-08-11T09:07:10.000Z");
        const { reporter, pushes } = makeReporterHarness(sql, { now: () => flushedAt });

        yield* Effect.promise(() => reporter.flushNow());
        const firstCodexBucket = pushes[0]?.request.models.find(
          (bucket) => bucket.minute === "2026-08-11T09:06:00Z" && bucket.provider === "codex",
        );
        expect(firstCodexBucket?.tokens).toBe(250);

        // The same minute grows after it was already pushed.
        yield* seedTokenActivity(sql, {
          activityId: "act-4",
          threadId: "thread-a",
          turnId: "turn-2",
          sequence: 4,
          createdAt: "2026-08-11T09:06:55.000Z",
          payloadJson: '{"totalProcessedTokens":2450}',
        });

        yield* Effect.promise(() => reporter.flushNow());
        const secondCodexBucket = pushes[1]?.request.models.find(
          (bucket) => bucket.minute === "2026-08-11T09:06:00Z" && bucket.provider === "codex",
        );
        // Absolute recompute: 250 + the 600 regrowth, not an increment.
        expect(secondCodexBucket?.tokens).toBe(850);

        reporter.stop();
      }),
    );
  });

  // The watermark is a claim about ONE account. After an account switch the
  // stored watermark says nothing about what the NEW account has received,
  // so the next flush must take the no-watermark full-backfill path.
  it("ignores the previous identity's watermark and re-backfills after an account switch", async () => {
    await runReporterTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedUsageFixture(sql);

        // Flush "now" far past the fixture: an honored watermark would leave
        // nothing in the window, a full backfill re-covers everything.
        const flushedAt = Date.parse("2026-08-12T12:00:00.000Z");
        let identity = "https://accounts.example.com#org_a";
        const { reporter, pushes } = makeReporterHarness(sql, {
          now: () => flushedAt,
          accountIdentity: async () => identity,
        });

        // Account A syncs everything and records its watermark + identity.
        yield* Effect.promise(() => reporter.flushNow());
        expect(pushes).toHaveLength(1);
        expect((yield* readSyncState(sql))?.accountIdentity).toBe(
          "https://accounts.example.com#org_a",
        );

        // Same identity: the watermark holds, so a quiet window pushes nothing.
        yield* Effect.promise(() => reporter.flushNow());
        expect(pushes).toHaveLength(1);

        // Account B signs in: the stored watermark belongs to A and must be
        // ignored — the flush backfills the full history for B.
        identity = "https://accounts.example.com#org_b";
        yield* Effect.promise(() => reporter.flushNow());
        expect(pushes).toHaveLength(2);
        expect(pushes[1]?.request.models).toHaveLength(3);
        expect((yield* readSyncState(sql))?.accountIdentity).toBe(
          "https://accounts.example.com#org_b",
        );

        reporter.stop();
      }),
    );
  });

  // Organizations are multi-member, so the identity carries the USER too:
  // user B signing in to the SAME org on the same machine has received none
  // of A's usage rows (they are keyed per user on the service) and must not
  // inherit A's watermark. Same user signing back in stays incremental.
  it("re-backfills when a different user signs in to the same workspace, but not for the same user", async () => {
    await runReporterTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedUsageFixture(sql);

        const flushedAt = Date.parse("2026-08-12T12:00:00.000Z");
        let identity = "https://accounts.example.com#org_1#user_a";
        const { reporter, pushes } = makeReporterHarness(sql, {
          now: () => flushedAt,
          accountIdentity: async () => identity,
        });

        // User A syncs everything.
        yield* Effect.promise(() => reporter.flushNow());
        expect(pushes).toHaveLength(1);

        // Same user again: incremental — the quiet window pushes nothing.
        yield* Effect.promise(() => reporter.flushNow());
        expect(pushes).toHaveLength(1);

        // User B, same accountUrl and organization: A's watermark says
        // nothing about B's rows — full backfill.
        identity = "https://accounts.example.com#org_1#user_b";
        yield* Effect.promise(() => reporter.flushNow());
        expect(pushes).toHaveLength(2);
        expect(pushes[1]?.request.models).toHaveLength(3);
        expect((yield* readSyncState(sql))?.accountIdentity).toBe(
          "https://accounts.example.com#org_1#user_b",
        );

        reporter.stop();
      }),
    );
  });

  // A watermark with no recorded identity (a row written before the identity
  // column existed) proves nothing about the current account either.
  it("treats a NULL stored identity with a watermark as a mismatch and re-backfills", async () => {
    await runReporterTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedUsageFixture(sql);
        yield* sql`
          INSERT INTO account_usage_sync (id, watermark_minute, last_failure_at, account_identity)
          VALUES (1, '2026-08-12T11:00:00Z', NULL, NULL)
          ON CONFLICT (id) DO UPDATE SET
            watermark_minute = '2026-08-12T11:00:00Z',
            last_failure_at = NULL,
            account_identity = NULL
        `;

        const flushedAt = Date.parse("2026-08-12T12:00:00.000Z");
        const { reporter, pushes } = makeReporterHarness(sql, { now: () => flushedAt });

        yield* Effect.promise(() => reporter.flushNow());
        // Honoring the legacy watermark would push nothing (fixture is a day
        // old); the identity mismatch forces the full backfill instead.
        expect(pushes).toHaveLength(1);
        expect(pushes[0]?.request.models).toHaveLength(3);

        reporter.stop();
      }),
    );
  });

  it("coalesces bursts of notifyActivity into one debounced flush", async () => {
    await runReporterTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedUsageFixture(sql);

        const { reporter, pushes } = makeReporterHarness(sql, {
          debounceMs: 25,
          isSignedIn: async () => true,
        });

        for (let index = 0; index < 10; index += 1) {
          reporter.notifyActivity();
        }
        yield* Effect.promise(() => sleep(150));

        expect(pushes).toHaveLength(1);
        reporter.stop();
      }),
    );
  });

  it("splits more than 500 buckets across multiple byte- and count-bounded pushes", async () => {
    await runReporterTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedThread(sql, "thread-bulk", '{"provider":"codex","model":"gpt-5-codex"}');
        // 501 prompts in 501 distinct minutes → 501 model buckets.
        const baseMs = Date.parse("2026-08-10T00:00:00.000Z");
        for (let index = 0; index < 501; index += 1) {
          const createdAt = new Date(baseMs + index * 60_000).toISOString();
          yield* seedUserMessage(sql, {
            messageId: `msg-bulk-${index}`,
            threadId: "thread-bulk",
            turnId: null,
            createdAt,
          });
        }

        const { reporter, pushes } = makeReporterHarness(sql, {
          now: () => baseMs + 502 * 60_000,
        });
        yield* Effect.promise(() => reporter.flushNow());

        // Every bucket lands exactly once, in minute order, across several
        // pushes — the exact split is byte-driven, not a count of 500.
        expect(pushes.length).toBeGreaterThan(1);
        const allModels = pushes.flatMap((push) => push.request.models);
        expect(allModels).toHaveLength(501);
        for (const push of pushes) {
          const { models } = push.request;
          expect(models.length).toBeGreaterThan(0);
          expect(models.length).toBeLessThanOrEqual(500);
          // Each chunk's serialized rows respect the per-stream byte budget.
          expect(Buffer.byteLength(JSON.stringify(models))).toBeLessThanOrEqual(
            chunkingForTesting.USAGE_PUSH_MAX_STREAM_BYTES,
          );
          expect(push.request.skills).toHaveLength(0);
        }
        // Chunks never share a minute: each push starts strictly after the
        // previous one's last minute (minute-replacement safety).
        for (let index = 1; index < pushes.length; index += 1) {
          const previousLast = pushes[index - 1]?.request.models.at(-1)?.minute ?? "";
          const nextFirst = pushes[index]?.request.models[0]?.minute ?? "";
          expect(nextFirst > previousLast).toBe(true);
        }

        reporter.stop();
      }),
    );
  });

  // A large first-sync backfill must not lose all progress to one mid-way
  // 429: the watermark advances after each pushed chunk, so the next flush
  // resumes from the failed chunk instead of replaying the whole history
  // (which a sustained rate limit could keep from ever completing).
  it("advances the watermark per chunk so a mid-backfill failure resumes, not replays", async () => {
    await runReporterTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedThread(sql, "thread-bulk", '{"provider":"codex","model":"gpt-5-codex"}');
        // 501 prompts in 501 distinct minutes → 2 chunks (500 + 1).
        const baseMs = Date.parse("2026-08-10T00:00:00.000Z");
        for (let index = 0; index < 501; index += 1) {
          const createdAt = new Date(baseMs + index * 60_000).toISOString();
          yield* seedUserMessage(sql, {
            messageId: `msg-bulk-${index}`,
            threadId: "thread-bulk",
            turnId: null,
            createdAt,
          });
        }

        let failFromPush = 2;
        const pushes: PushUsageRequest[] = [];
        const { reporter } = makeReporterHarness(sql, {
          now: () => baseMs + 502 * 60_000,
          push: async (request) => {
            if (pushes.length + 1 >= failFromPush) {
              throw new Error("429 too many requests");
            }
            pushes.push(request);
          },
        });

        // First flush: chunk 1 lands, chunk 2 hits the rate limit.
        yield* Effect.promise(() => reporter.flushNow());
        expect(pushes).toHaveLength(1);
        const deliveredCount = pushes[0]?.models.length ?? 0;
        expect(deliveredCount).toBeGreaterThan(0);
        const afterFailure = yield* readSyncState(sql);
        // The watermark reflects the last successful chunk: the newest
        // minute fully covered before chunk 2's first bucket (one bucket per
        // minute here, so that is the minute before bucket `deliveredCount`).
        expect(afterFailure?.watermarkMinute).toBe(
          minuteStartIso(baseMs + (deliveredCount - 1) * 60_000),
        );
        expect(afterFailure?.lastFailureAt).not.toBeNull();

        // Next flush resumes from the failed chunk: only the watermark's
        // safety lap plus the unpushed tail, never replaying everything
        // already delivered.
        failFromPush = Number.POSITIVE_INFINITY;
        yield* Effect.promise(() => reporter.flushNow());
        expect(pushes.length).toBeGreaterThan(1);
        // The resume starts at the safety lap behind the watermark — two
        // minutes of overlap, not the start of history.
        expect(pushes[1]?.models[0]?.minute).toBe(
          minuteStartIso(baseMs + (deliveredCount - 3) * 60_000),
        );
        const resumed = pushes.slice(1).flatMap((request) => request.models);
        expect(resumed.length).toBeLessThanOrEqual(501 - deliveredCount + 3);
        // Everything is on the account exactly where a fully successful
        // flush would have put it.
        const deliveredMinutes = new Set(
          pushes.flatMap((request) => request.models.map((bucket) => bucket.minute)),
        );
        expect(deliveredMinutes.size).toBe(501);
        const afterSuccess = yield* readSyncState(sql);
        // Final state matches a fully successful flush exactly.
        expect(afterSuccess?.watermarkMinute).toBe(minuteStartIso(baseMs + 501 * 60_000));
        expect(afterSuccess?.lastFailureAt).toBeNull();

        reporter.stop();
      }),
    );
  });

  it("stays fully inert while signed out", async () => {
    await runReporterTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedUsageFixture(sql);

        const { reporter, pushes } = makeReporterHarness(sql, {
          isSignedIn: async () => false,
          debounceMs: 1,
        });
        reporter.notifyActivity();
        yield* Effect.promise(() => reporter.flushNow());
        yield* Effect.promise(() => sleep(30));

        expect(pushes).toHaveLength(0);
        const state = yield* readSyncState(sql);
        expect(state?.watermarkMinute).toBeNull();
        expect(state?.lastFailureAt).toBeNull();

        reporter.stop();
      }),
    );
  });

  it("backs off after a failure until the backoff window has elapsed", async () => {
    await runReporterTest(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedUsageFixture(sql);

        let nowMs = Date.parse("2026-08-11T09:10:00.000Z");
        let attempts = 0;
        let failPush = true;
        const { reporter, pushes } = makeReporterHarness(sql, {
          debounceMs: 1,
          failureBackoffMs: 60_000,
          now: () => nowMs,
          push: async () => {
            attempts += 1;
            if (failPush) throw new Error("boom");
          },
        });

        // First scheduled flush fails and records the failure.
        reporter.notifyActivity();
        yield* Effect.promise(() => sleep(50));
        expect(attempts).toBe(1);

        // Activity inside the backoff window does not retry.
        failPush = false;
        nowMs += 30_000;
        reporter.notifyActivity();
        yield* Effect.promise(() => sleep(50));
        expect(attempts).toBe(1);

        // Past the window, the next activity retries and succeeds.
        nowMs += 31_000;
        reporter.notifyActivity();
        yield* Effect.promise(() => sleep(50));
        expect(attempts).toBe(2);
        const state = yield* readSyncState(sql);
        expect(state?.lastFailureAt).toBeNull();
        expect(state?.watermarkMinute).toBe(minuteStartIso(nowMs - 60_000));
        expect(pushes.length).toBe(0); // harness default push was overridden

        reporter.stop();
      }),
    );
  });
});

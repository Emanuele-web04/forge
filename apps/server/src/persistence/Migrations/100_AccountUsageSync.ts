/**
 * Watermark state for the account usage reporter (accountUsageReporter.ts).
 *
 * A single row records how far this environment has synced its per-minute
 * usage buckets to the account service: `watermark_minute` is the newest
 * fully elapsed UTC minute covered by a successful push, and
 * `last_failure_at` records the most recent failed push so retries can back
 * off. Deliberately NOT a `projection_*` table: projections can be reset and
 * rebuilt from orchestration_events, while this row must survive rebuilds —
 * losing it only costs one redundant (idempotent) re-push of recent history,
 * but keeping it is what makes each flush cheap.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS account_usage_sync (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      watermark_minute TEXT,
      last_failure_at TEXT
    )
  `;

  // Seed the singleton so readers and writers can assume the row exists.
  yield* sql`
    INSERT OR IGNORE INTO account_usage_sync (id, watermark_minute, last_failure_at)
    VALUES (1, NULL, NULL)
  `;
});

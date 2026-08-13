/**
 * Adds message_text_segments: ordered slices of streamed assistant text.
 *
 * Each row is one contiguous run of assistant deltas between row-making
 * provider events (tool calls, warnings, ...). The web timeline interleaves
 * these segments with tool rows so streamed reasoning renders in execution
 * order instead of one block above every tool call. Rows are append-only
 * during streaming. Completed messages retain rows only when a tool boundary
 * produced multiple segments; edits and rollbacks discard derived boundaries.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS message_text_segments (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (thread_id, message_id, sequence)
    )
  `;
});

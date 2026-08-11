/**
 * Adds message_text_segments: ordered slices of streamed assistant text.
 *
 * Each row is one contiguous run of assistant deltas between row-making
 * provider events (tool calls, warnings, ...). The web timeline interleaves
 * these segments with tool rows so streamed reasoning renders in execution
 * order instead of one block above every tool call. Rows are append-only
 * during streaming; a completed/edited message is collapsed back into a
 * single whole-message segment by the projection.
 */
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS message_text_segments (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (thread_id, message_id, started_at)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_message_text_segments_thread_message
    ON message_text_segments(thread_id, message_id, started_at)
  `;
});
// Purpose: Converts the old automatic-retention delete lifecycle into the reversible
//          archive lifecycle, preserving manual deletions and event-replay consistency.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const RETENTION_COMMAND_ID_PATTERN = "thread-retention:%";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Retention deletes were deliberately kept in projection_threads, so they can be
  // recovered without reconstructing message data. Convert the authoritative event too:
  // a later projection replay must produce the same archived state as the repaired row.
  yield* sql`
    UPDATE orchestration_events
    SET event_type = 'thread.archived',
        payload_json = json_set(
          json_remove(payload_json, '$.deletedAt'),
          '$.archivedAt', json_extract(payload_json, '$.deletedAt'),
          '$.updatedAt', json_extract(payload_json, '$.deletedAt')
        )
    WHERE event_type = 'thread.deleted'
      AND command_id LIKE ${RETENTION_COMMAND_ID_PATTERN}
  `;

  yield* sql`
    UPDATE projection_threads
    SET archived_at = COALESCE(archived_at, deleted_at),
        deleted_at = NULL
    WHERE deleted_at IS NOT NULL
      AND thread_id IN (
        SELECT stream_id
        FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND event_type = 'thread.archived'
          AND command_id LIKE ${RETENTION_COMMAND_ID_PATTERN}
      )
  `;
});

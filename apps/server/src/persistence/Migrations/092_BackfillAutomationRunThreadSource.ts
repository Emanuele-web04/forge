// Purpose: Backfills creationSource = "automation_run" onto per-run threads that standalone
//          automations created before the marker existed, so the sidebar visibility setting
//          applies to legacy runs too.
//
// Scope: automation-run thread ids (`automation:automation-run:<uuid>:thread`) that are NOT
// any automation definition's dedicated target thread (including archived definitions').
// Dedicated threads are persistent conversations and stay unmarked. A definition that was
// hard-deleted (not archived) no longer excludes its dedicated thread, so that thread gets
// reclassified as a run thread — acceptable: nothing references it as a conversation anymore.
//
// Repairs the authoritative thread.created event AND the projection row, so a later
// projection replay reproduces the same state (089 pattern).

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const AUTOMATION_RUN_THREAD_ID_PATTERN = "automation:automation-run:%:thread";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.creationSource', 'automation_run')
    WHERE aggregate_kind = 'thread'
      AND event_type = 'thread.created'
      AND stream_id LIKE ${AUTOMATION_RUN_THREAD_ID_PATTERN}
      AND json_extract(payload_json, '$.creationSource') IS NULL
      AND stream_id NOT IN (
        SELECT target_thread_id
        FROM automation_definitions
        WHERE target_thread_id IS NOT NULL
      )
  `;

  yield* sql`
    UPDATE projection_threads
    SET creation_source = 'automation_run'
    WHERE creation_source IS NULL
      AND thread_id LIKE ${AUTOMATION_RUN_THREAD_ID_PATTERN}
      AND thread_id NOT IN (
        SELECT target_thread_id
        FROM automation_definitions
        WHERE target_thread_id IS NOT NULL
      )
  `;
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// After the fix that adds `thread.session-set` and `thread.turn-diff-completed`
// to the hot threads projector, an existing `projection.threads` cursor that is
// already past those events will never backfill them. The next startup will
// instead fast-forward the cursor and skip the newly covered history. Deleting
// the cursor forces the bootstrap replay to re-apply the entire journal with the
// updated replay filter, healing regressed `projection_threads.updated_at` values
// to the turn completion time without needing the manual repairState path.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DELETE FROM projection_state
    WHERE projector = 'projection.threads'
  `;
});

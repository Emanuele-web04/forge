import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE automation_definitions
    SET disabled_reason = 'max-iterations'
    WHERE enabled = 0
      AND archived_at IS NULL
      AND disabled_reason IS NULL
      AND max_iterations IS NOT NULL
      AND iteration_count >= max_iterations
  `;
});

// Purpose: Adds the SSH target of a project to the projection read model. Local projects
//          keep a NULL `remote_json`, so the column is additive and every existing row
//          stays a local project without a backfill.
//
//          Stored as JSON rather than as columns because the shape is a closed contract
//          schema (`ProjectRemote`) that is read and written whole, exactly like the
//          neighbouring `default_model_selection_json` and `scripts_json`.

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly exists: number }>`
    SELECT EXISTS(
      SELECT 1 FROM pragma_table_info('projection_projects')
      WHERE name = 'remote_json'
    ) AS "exists"
  `;
  if (columns[0]?.exists !== 1) {
    yield* sql.unsafe(`
      ALTER TABLE projection_projects
      ADD COLUMN remote_json TEXT
    `);
  }
});

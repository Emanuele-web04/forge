import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "projection_projects", "sources_json"))) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN sources_json TEXT NOT NULL DEFAULT '[]'`;
  }
  if (!(yield* columnExists(sql, "projection_projects", "primary_source_id"))) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN primary_source_id TEXT`;
  }

  yield* sql`
    UPDATE projection_projects
    SET
      primary_source_id = 'src-' || project_id,
      sources_json = json_array(json_object(
        'id', 'src-' || project_id,
        'path', workspace_root,
        'sortOrder', 0,
        'createdAt', created_at,
        'updatedAt', updated_at
      ))
    WHERE primary_source_id IS NULL OR sources_json = '[]'
  `;
});

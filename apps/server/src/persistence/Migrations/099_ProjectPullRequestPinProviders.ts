import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const createLimitTrigger = (sql: SqlClient.SqlClient) => sql`
  CREATE TRIGGER IF NOT EXISTS trg_project_pull_request_pins_limit
  BEFORE INSERT ON project_pull_request_pins
  WHEN
    NOT EXISTS (
      SELECT 1
      FROM project_pull_request_pins
      WHERE project_id = NEW.project_id
        AND provider = NEW.provider
        AND repository_key = NEW.repository_key
        AND pull_request_number = NEW.pull_request_number
    )
    AND (
      SELECT COUNT(*)
      FROM project_pull_request_pins
      WHERE project_id = NEW.project_id
    ) >= 20
  BEGIN
    SELECT RAISE(ABORT, 'project pull request pin limit exceeded');
  END
`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('project_pull_request_pins')
  `;

  yield* sql`DROP TRIGGER IF EXISTS trg_project_pull_request_pins_limit`;
  if (columns.some((column) => column.name === "provider")) {
    yield* createLimitTrigger(sql);
    return;
  }

  yield* sql`
    CREATE TABLE project_pull_request_pins_next (
      project_id TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'github',
      repository_key TEXT NOT NULL,
      pull_request_number INTEGER NOT NULL CHECK (pull_request_number > 0),
      PRIMARY KEY (project_id, provider, repository_key, pull_request_number)
    ) STRICT
  `;
  yield* sql`
    INSERT INTO project_pull_request_pins_next (
      project_id,
      provider,
      repository_key,
      pull_request_number
    )
    SELECT project_id, 'github', repository_key, pull_request_number
    FROM project_pull_request_pins
  `;
  yield* sql`DROP TABLE project_pull_request_pins`;
  yield* sql`ALTER TABLE project_pull_request_pins_next RENAME TO project_pull_request_pins`;
  yield* createLimitTrigger(sql);
});

import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS pull_request_review_drafts (
      id TEXT PRIMARY KEY,
      repository TEXT NOT NULL COLLATE NOCASE,
      pull_request_number INTEGER NOT NULL CHECK (pull_request_number > 0),
      head_sha TEXT NOT NULL,
      patch_signature TEXT NOT NULL,
      path TEXT NOT NULL,
      line INTEGER NOT NULL CHECK (line > 0),
      side TEXT NOT NULL CHECK (side IN ('LEFT', 'RIGHT')),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pull_request_review_drafts_identity
    ON pull_request_review_drafts(repository, pull_request_number, created_at, id)
  `;
});

// FILE: 089_ExternalAgentProfiles.ts
// Purpose: Adds external agent profile and immutable revision tables. Profiles
// carry a stable identity and a pointer to the current content-addressed
// revision; revisions are immutable, content-deduplicated rows.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const [profilesTable] = yield* sql<{ readonly exists: number }>`
    SELECT EXISTS(
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'external_agent_profiles'
    ) AS "exists"
  `;
  if (profilesTable?.exists !== 1) {
    yield* sql`
      CREATE TABLE external_agent_profiles (
        profile_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        current_revision_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
  }

  const [revisionsTable] = yield* sql<{ readonly exists: number }>`
    SELECT EXISTS(
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'external_agent_profile_revisions'
    ) AS "exists"
  `;
  if (revisionsTable?.exists !== 1) {
    yield* sql`
      CREATE TABLE external_agent_profile_revisions (
        revision_id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `;
  }
});

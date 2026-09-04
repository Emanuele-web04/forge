// FILE: 102_CapabilityEvidenceWithdrawal.ts
// Purpose: Adds a `withdrawn_at` column to the append-only capability
// observation store (KAR-530). Observations are never rewritten: when a live
// session withdraws a capability's evidence (unsafe outcome) the prior rows are
// *marked* withdrawn so policy derivation excludes them, but the raw history is
// preserved for audit. Purged rows (honeypot verdicts) are hard-deleted as
// before; this migration only adds the marker column.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "capability_observations", "withdrawn_at"))) {
    yield* sql`
      ALTER TABLE capability_observations
      ADD COLUMN withdrawn_at TEXT
    `;
  }
});

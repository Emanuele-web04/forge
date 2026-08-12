// FILE: 091_AutomationFailureTolerance.ts
// Purpose: Adds consecutive-failure policy and durable automation disable metadata.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "automation_definitions", "stop_after_consecutive_failures"))) {
    yield* sql`
      ALTER TABLE automation_definitions
      ADD COLUMN stop_after_consecutive_failures INTEGER
      CHECK (
        stop_after_consecutive_failures IS NULL
        OR stop_after_consecutive_failures >= 1
      )
    `;
    yield* sql`
      UPDATE automation_definitions
      SET stop_after_consecutive_failures = CASE stop_on_error
        WHEN 1 THEN 3
        ELSE NULL
      END
    `;
  }

  if (!(yield* columnExists(sql, "automation_definitions", "consecutive_failure_count"))) {
    yield* sql`
      ALTER TABLE automation_definitions
      ADD COLUMN consecutive_failure_count INTEGER NOT NULL DEFAULT 0
    `;
  }

  if (!(yield* columnExists(sql, "automation_definitions", "disabled_reason"))) {
    yield* sql`
      ALTER TABLE automation_definitions
      ADD COLUMN disabled_reason TEXT
      CHECK (
        disabled_reason IS NULL
        OR disabled_reason IN ('failures', 'max-iterations', 'completion', 'schedule', 'user')
      )
    `;
  }

  if (!(yield* columnExists(sql, "automation_definitions", "disabled_at"))) {
    yield* sql`
      ALTER TABLE automation_definitions
      ADD COLUMN disabled_at TEXT
    `;
  }
});

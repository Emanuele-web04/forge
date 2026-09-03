/**
 * Adds `account_identity` to account_usage_sync so the reporter's watermark is
 * scoped to the signed-in identity (`${accountUrl}#${organizationId}`).
 *
 * The watermark says "this account has everything up to minute X" — a claim
 * about ONE account. Without the identity column the claim is environment-
 * global: sign out of account A, sign in to account B, and B silently
 * inherits A's watermark, skipping the full-history backfill it never
 * received. Nullable: NULL means "identity unknown" (legacy rows), which the
 * reporter treats as a mismatch and re-backfills — one redundant idempotent
 * push, never missing history.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "account_usage_sync", "account_identity"))) {
    yield* sql`
      ALTER TABLE account_usage_sync
      ADD COLUMN account_identity TEXT
    `;
  }
});

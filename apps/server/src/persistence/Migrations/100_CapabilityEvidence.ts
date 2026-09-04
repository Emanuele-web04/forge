// FILE: 100_CapabilityEvidence.ts
// Purpose: Creates the append-only capability observation store for the
// canonical capability/evidence model (KAR-523). Observations are immutable
// facts about what an external agent runtime demonstrated or advertised; the
// effective capability state is always derived from this history, never stored
// as a single mutable flag.

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { tableExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* tableExists(sql, "capability_observations"))) {
    yield* sql`
      CREATE TABLE capability_observations (
        observation_id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        source TEXT NOT NULL,
        outcome TEXT NOT NULL,
        attribution TEXT NOT NULL,
        runtime_identity_json TEXT NOT NULL,
        verifier_json TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        run_metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `;

    yield* sql`
      CREATE INDEX capability_observations_namespace_idx
      ON capability_observations (namespace, capability_id, observed_at)
    `;
  }

  // Derived cache of effective capability state per (namespace, capability).
  // Deliberately NOT the source of truth: it is recomputable from the append-only
  // observation history via `deriveEffectiveState`, and it is the only table in
  // this module that is ever updated (by re-derivation or explicit invalidation).
  if (!(yield* tableExists(sql, "capability_effective_states"))) {
    yield* sql`
      CREATE TABLE capability_effective_states (
        namespace TEXT NOT NULL,
        capability_id TEXT NOT NULL,
        state TEXT NOT NULL,
        advertised INTEGER NOT NULL DEFAULT 0,
        policy_json TEXT NOT NULL,
        last_observation_at TEXT,
        last_observation_id TEXT,
        derived_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (namespace, capability_id)
      )
    `;
  }
});

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// The Kilo provider was removed; its sessions ran on the shared OpenCode
// runtime, so persisted 'kilo' provider values are rewritten to 'opencode'.
// Without this, strict ProviderKind/ModelSelection decoding fails on every
// durable surface that still holds kilo-era rows (thread projections, handoff
// metadata, automations, event replay, the runtime journal).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_threads
    SET model_selection_json = json_set(model_selection_json, '$.provider', 'opencode')
    WHERE json_extract(model_selection_json, '$.provider') = 'kilo'
  `;

  yield* sql`
    UPDATE projection_threads
    SET handoff_json = json_set(handoff_json, '$.sourceProvider', 'opencode')
    WHERE json_extract(handoff_json, '$.sourceProvider') = 'kilo'
  `;

  yield* sql`
    UPDATE projection_projects
    SET default_model_selection_json = json_set(default_model_selection_json, '$.provider', 'opencode')
    WHERE json_extract(default_model_selection_json, '$.provider') = 'kilo'
  `;

  yield* sql`
    UPDATE projection_thread_sessions
    SET provider_name = 'opencode'
    WHERE provider_name = 'kilo'
  `;

  yield* sql`
    UPDATE provider_session_runtime
    SET provider_name = 'opencode'
    WHERE provider_name = 'kilo'
  `;

  yield* sql`
    UPDATE provider_session_runtime
    SET adapter_key = 'opencode'
    WHERE adapter_key = 'kilo'
  `;

  yield* sql`
    UPDATE automation_definitions
    SET model_selection_json = json_set(model_selection_json, '$.provider', 'opencode')
    WHERE json_extract(model_selection_json, '$.provider') = 'kilo'
  `;

  yield* sql`
    UPDATE provider_runtime_events
    SET event_json = json_set(event_json, '$.provider', 'opencode')
    WHERE json_extract(event_json, '$.provider') = 'kilo'
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.provider', 'opencode')
    WHERE json_extract(payload_json, '$.provider') = 'kilo'
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.providerName', 'opencode')
    WHERE json_extract(payload_json, '$.providerName') = 'kilo'
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.modelSelection.provider', 'opencode')
    WHERE json_extract(payload_json, '$.modelSelection.provider') = 'kilo'
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.defaultModelSelection.provider', 'opencode')
    WHERE json_extract(payload_json, '$.defaultModelSelection.provider') = 'kilo'
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.handoff.sourceProvider', 'opencode')
    WHERE json_extract(payload_json, '$.handoff.sourceProvider') = 'kilo'
  `;
});

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
    SET model_selection_json = CASE
      WHEN json_type(model_selection_json, '$.options.kilo') IS NOT NULL THEN
        json_set(
          model_selection_json,
          '$.provider', 'opencode',
          '$.options', json_extract(model_selection_json, '$.options.kilo')
        )
      ELSE json_set(model_selection_json, '$.provider', 'opencode')
    END
    WHERE json_extract(model_selection_json, '$.provider') = 'kilo'
  `;

  yield* sql`
    UPDATE projection_threads
    SET handoff_json = json_set(handoff_json, '$.sourceProvider', 'opencode')
    WHERE json_extract(handoff_json, '$.sourceProvider') = 'kilo'
  `;

  yield* sql`
    UPDATE projection_projects
    SET default_model_selection_json = CASE
      WHEN json_type(default_model_selection_json, '$.options.kilo') IS NOT NULL THEN
        json_set(
          default_model_selection_json,
          '$.provider', 'opencode',
          '$.options', json_extract(default_model_selection_json, '$.options.kilo')
        )
      ELSE json_set(default_model_selection_json, '$.provider', 'opencode')
    END
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
    UPDATE provider_session_runtime
    SET runtime_payload_json = json_remove(runtime_payload_json, '$.providerOptions.kilo')
    WHERE json_type(runtime_payload_json, '$.providerOptions.kilo') IS NOT NULL
  `;

  yield* sql`
    UPDATE provider_session_runtime
    SET runtime_payload_json = CASE
      WHEN json_type(runtime_payload_json, '$.modelSelection.options.kilo') IS NOT NULL THEN
        json_set(
          runtime_payload_json,
          '$.modelSelection.provider', 'opencode',
          '$.modelSelection.options',
          json_extract(runtime_payload_json, '$.modelSelection.options.kilo')
        )
      ELSE json_set(runtime_payload_json, '$.modelSelection.provider', 'opencode')
    END
    WHERE json_extract(runtime_payload_json, '$.modelSelection.provider') = 'kilo'
  `;

  // Kilo binary paths, endpoints, and auth are not compatible with OpenCode's
  // process protocol. Remove them while preserving any real OpenCode bundle.
  yield* sql`
    UPDATE automation_definitions
    SET provider_options_json = json_remove(provider_options_json, '$.kilo')
    WHERE json_type(provider_options_json, '$.kilo') IS NOT NULL
  `;

  yield* sql`
    UPDATE automation_definitions
    SET model_selection_json = CASE
      WHEN json_type(model_selection_json, '$.options.kilo') IS NOT NULL THEN
        json_set(
          model_selection_json,
          '$.provider', 'opencode',
          '$.options', json_extract(model_selection_json, '$.options.kilo')
        )
      ELSE json_set(model_selection_json, '$.provider', 'opencode')
    END
    WHERE json_extract(model_selection_json, '$.provider') = 'kilo'
  `;

  yield* sql`
    UPDATE provider_runtime_events
    SET event_json = json_set(event_json, '$.provider', 'opencode')
    WHERE json_extract(event_json, '$.provider') = 'kilo'
  `;

  yield* sql`
    UPDATE provider_runtime_events
    SET event_json = json_set(event_json, '$.raw.source', 'opencode.sdk.event')
    WHERE json_extract(event_json, '$.raw.source') = 'kilo.sdk.event'
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
    SET payload_json = json_set(payload_json, '$.session.providerName', 'opencode')
    WHERE json_extract(payload_json, '$.session.providerName') = 'kilo'
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.activity.payload.provider', 'opencode')
    WHERE json_extract(payload_json, '$.activity.payload.provider') = 'kilo'
  `;

  // Preserve an existing OpenCode bundle but never feed Kilo endpoints or
  // binaries to the incompatible OpenCode process protocol.
  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_remove(payload_json, '$.providerOptions.kilo')
    WHERE json_type(payload_json, '$.providerOptions.kilo') IS NOT NULL
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = CASE
      WHEN json_type(payload_json, '$.modelSelection.options.kilo') IS NOT NULL THEN
        json_set(
          payload_json,
          '$.modelSelection.provider', 'opencode',
          '$.modelSelection.options', json_extract(payload_json, '$.modelSelection.options.kilo')
        )
      ELSE json_set(payload_json, '$.modelSelection.provider', 'opencode')
    END
    WHERE json_extract(payload_json, '$.modelSelection.provider') = 'kilo'
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = CASE
      WHEN json_type(payload_json, '$.defaultModelSelection.options.kilo') IS NOT NULL THEN
        json_set(
          payload_json,
          '$.defaultModelSelection.provider', 'opencode',
          '$.defaultModelSelection.options',
          json_extract(payload_json, '$.defaultModelSelection.options.kilo')
        )
      ELSE json_set(payload_json, '$.defaultModelSelection.provider', 'opencode')
    END
    WHERE json_extract(payload_json, '$.defaultModelSelection.provider') = 'kilo'
  `;

  yield* sql`
    UPDATE orchestration_events
    SET payload_json = json_set(payload_json, '$.handoff.sourceProvider', 'opencode')
    WHERE json_extract(payload_json, '$.handoff.sourceProvider') = 'kilo'
  `;

  yield* sql`
    UPDATE projection_thread_activities
    SET payload_json = json_set(payload_json, '$.provider', 'opencode')
    WHERE json_extract(payload_json, '$.provider') = 'kilo'
  `;

  yield* sql`
    UPDATE profile_stats_deleted_turns
    SET provider = 'opencode'
    WHERE provider = 'kilo'
  `;

  yield* sql`
    UPDATE profile_stats_deleted_tokens
    SET provider = 'opencode'
    WHERE provider = 'kilo'
  `;
});

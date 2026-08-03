import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  MIGRATION_LINEAGE_ALIASES,
  migrationEntries,
  planMigrationLineageAliasRepairs,
  runMigrations,
} from "./Migrations.ts";
import { MigrationSchemaTooNewError } from "./Errors.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";
import DurableProviderCommandDeliveryMigration from "./Migrations/064_DurableProviderCommandDelivery.ts";
import ProjectionThreadsGatewayProvenanceMigration from "./Migrations/071_ProjectionThreadsGatewayProvenance.ts";
import ProjectPullRequestPinsMigration from "./Migrations/069_ProjectPullRequestPins.ts";
import SpacesMigration from "./Migrations/079_Spaces.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const trackerRows = (sql: SqlClient.SqlClient) =>
  sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id ASC
  `;

const projectionThreadsColumnNames = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('projection_threads')
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

layer("reconcileMigrationLineage", (it) => {
  // An imported database whose tracker high-water
  // mark is at or beyond Synara's latest migration ID. The migrator's max-ID
  // gate then skips every Synara migration — including the #032 self-heal —
  // and startup crashes on the missing env_mode column.
  it.effect("re-runs skipped migrations when an imported tracker outruns Synara's latest ID", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Bring the schema to the last shared migration.
      yield* runMigrations({ toMigrationInclusive: 16 });

      // Record a foreign lineage from 17 through past Synara's latest ID.
      const latestSynaraId = Math.max(...migrationEntries.map(([id]) => id));
      for (let id = 17; id <= latestSynaraId + 3; id++) {
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (${id}, ${`ForeignMigration${id}`})
        `;
      }

      // The foreign lineage added some of the same columns, so the
      // re-run must tolerate columns that already exist.
      yield* sql`ALTER TABLE projection_threads ADD COLUMN archived_at TEXT`;

      const beforeColumns = yield* projectionThreadsColumnNames(sql);
      assert.notInclude(beforeColumns, "env_mode");

      const executed = yield* runMigrations();
      assert.deepStrictEqual(
        executed.map(([id]) => id),
        migrationEntries.map(([id]) => id).filter((id) => id >= 17),
      );

      const afterColumns = yield* projectionThreadsColumnNames(sql);
      assert.include(afterColumns, "env_mode");
      assert.include(afterColumns, "archived_at");

      // The tracker now mirrors the Synara lineage exactly; foreign rows are gone.
      const rows = yield* trackerRows(sql);
      assert.deepStrictEqual(
        rows.map((row) => [row.migration_id, row.name]),
        migrationEntries.map(([id, name]) => [id, name]),
      );
    }),
  );

  it.effect("leaves a healthy tracker alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      const executed = yield* runMigrations();
      assert.lengthOf(executed, 0);

      const rows = yield* trackerRows(sql);
      assert.deepStrictEqual(
        rows.map((row) => [row.migration_id, row.name]),
        migrationEntries.map(([id, name]) => [id, name]),
      );
    }),
  );

  it.effect("canonicalizes migration 32 when the preceding lineage is exact", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      yield* sql`
        UPDATE effect_sql_migrations
        SET name = 'PreviousMigration32Name'
        WHERE migration_id = 32
      `;

      const executed = yield* runMigrations();
      assert.lengthOf(executed, 0);
      const rows = yield* trackerRows(sql);
      assert.strictEqual(
        rows.find((row) => row.migration_id === 32)?.name,
        "ReconcileImportedSchemaLineage",
      );
    }),
  );

  it.effect("refuses writable migration startup for a newer Synara schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      const futureId = Math.max(...migrationEntries.map(([id]) => id)) + 1;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${futureId}, 'FutureSynaraMigration')
      `;

      const rowsBefore = yield* trackerRows(sql);
      const error = yield* Effect.flip(runMigrations());
      assert.instanceOf(error, MigrationSchemaTooNewError);
      assert.strictEqual(error.databaseMigrationId, futureId);
      assert.strictEqual(error.latestSupportedMigrationId, futureId - 1);

      const rows = yield* trackerRows(sql);
      assert.deepStrictEqual(rows, rowsBefore);

      // The suite shares one in-memory database through the layer.
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${futureId}`;
    }),
  );

  it.effect("refuses to run when the divergence is inside the shared lineage prefix", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      yield* sql`
        UPDATE effect_sql_migrations
        SET name = 'NotAKnownLineage'
        WHERE migration_id = 5
      `;
      const rowsBefore = yield* trackerRows(sql);

      const error = yield* Effect.flip(runMigrations());
      assert.strictEqual(error._tag, "MigrationLineageError");

      // Nothing was deleted on the unrecognized database.
      const rowsAfter = yield* trackerRows(sql);
      assert.deepStrictEqual(rowsAfter, rowsBefore);
    }),
  );
});

const providerDeliveryCutoverLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

providerDeliveryCutoverLayer(
  "registered DurableProviderCommandDelivery cutover migration",
  (it) => {
    it.effect("initializes at the event high-water mark when cutover explicitly runs", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 53 });
        const now = new Date().toISOString();

        const inserted = yield* sql<{ readonly sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        ) VALUES (
          'evt-before-durable-delivery', 'thread', 'thread-before-durable-delivery', 0,
          'thread.turn-start-requested', ${now}, 'cmd-before-durable-delivery',
          NULL, NULL, 'user', '{"threadId":"thread-before-durable-delivery"}', '{}'
        )
        RETURNING sequence
      `;

        yield* DurableProviderCommandDeliveryMigration;
        const rows = yield* sql<{ readonly lastAckedSequence: number }>`
        SELECT last_acked_sequence AS "lastAckedSequence"
        FROM orchestration_consumer_state
        WHERE consumer_name = 'provider-command-reactor.v1'
      `;
        assert.strictEqual(rows[0]?.lastAckedSequence, inserted[0]?.sequence);

        yield* DurableProviderCommandDeliveryMigration;
        const idempotentRows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM orchestration_consumer_state
        WHERE consumer_name = 'provider-command-reactor.v1'
      `;
        assert.strictEqual(idempotentRows[0]?.count, 1);
      }),
    );
  },
);

const managedAttachmentsFreshLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

managedAttachmentsFreshLayer("managed attachment migration on a fresh database", (it) => {
  it.effect("reserves legacy migration 54 and creates the managed ledger on a fresh database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const executed = yield* runMigrations();
      assert.deepInclude(executed, [54, "DurableProviderCommandDelivery"]);
      assert.deepInclude(executed, [55, "ManagedAttachments"]);
      assert.deepInclude(executed, [64, "DurableProviderCommandDeliveryCutover"]);
      assert.deepInclude(executed, [65, "DurableQueuedTurnPromotions"]);
      assert.deepInclude(executed, [66, "DurableProviderRuntimeEvents"]);
      assert.deepInclude(executed, [67, "ProviderDeliveryReconciliation"]);
      assert.deepInclude(executed, [79, "Spaces"]);

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('managed_attachment_blobs', 'managed_attachment_cleanup_jobs')
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map((row) => row.name),
        ["managed_attachment_blobs", "managed_attachment_cleanup_jobs"],
      );

      const providerDeliveryTables = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('orchestration_consumer_state', 'orchestration_event_deliveries')
      `;
      assert.strictEqual(providerDeliveryTables[0]?.count, 2);
    }),
  );
});

const managedAttachmentsLegacyLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

managedAttachmentsLegacyLayer("managed attachment migration after private migration 54", (it) => {
  it.effect("keeps a private database that already recorded old migration 54 compatible", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 53 });
      yield* DurableProviderCommandDeliveryMigration;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (54, 'DurableProviderCommandDelivery')
      `;

      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, [
        [55, "ManagedAttachments"],
        [56, "CommandReceiptFingerprints"],
        [57, "ThreadScopedProjectionMessageIdentity"],
        [58, "ThreadScopedPendingApprovalIdentity"],
        [59, "ProviderSessionLifecycleGeneration"],
        [60, "PendingApprovalLifecycleGeneration"],
        [61, "PendingApprovalSettlementState"],
        [62, "PendingInteractionSettlementParity"],
        [63, "ProjectionMessageCausalSequence"],
        [64, "DurableProviderCommandDeliveryCutover"],
        [65, "DurableQueuedTurnPromotions"],
        [66, "DurableProviderRuntimeEvents"],
        [67, "ProviderDeliveryReconciliation"],
        [68, "GitHandoffOperations"],
        [69, "ProjectPullRequestPins"],
        [70, "AgentGatewayOperations"],
        [71, "ProjectionThreadsGatewayProvenance"],
        [72, "AgentGatewayOperationRetention"],
        [73, "OperationalDiagnostics"],
        [74, "ExternalMcpIntegrations"],
        [75, "ExternalMcpActiveCapacity"],
        [76, "ExternalMcpHardening"],
        [77, "ExternalMcpCompensatingCapacity"],
        [78, "ExternalMcpLiveTurnCapacity"],
        [79, "Spaces"],
        [80, "ExternalMcpProjectScope"],
        [81, "AutomationProposals"],
        [82, "AutomationMemory"],
        [83, "AutomationHeartbeatEligibility"],
        [84, "AutomationNotificationPolicy"],
        [85, "AutomationSettings"],
        [86, "NormalizeStudioThreadWorkspaces"],
        [87, "DropUnusedOrchestrationEventIndexes"],
        [88, "ProjectionThreadsSettledAt"],
      ]);

      const tracker = yield* trackerRows(sql);
      assert.deepStrictEqual(tracker.slice(-35), [
        { migration_id: 54, name: "DurableProviderCommandDelivery" },
        { migration_id: 55, name: "ManagedAttachments" },
        { migration_id: 56, name: "CommandReceiptFingerprints" },
        { migration_id: 57, name: "ThreadScopedProjectionMessageIdentity" },
        { migration_id: 58, name: "ThreadScopedPendingApprovalIdentity" },
        { migration_id: 59, name: "ProviderSessionLifecycleGeneration" },
        { migration_id: 60, name: "PendingApprovalLifecycleGeneration" },
        { migration_id: 61, name: "PendingApprovalSettlementState" },
        { migration_id: 62, name: "PendingInteractionSettlementParity" },
        { migration_id: 63, name: "ProjectionMessageCausalSequence" },
        { migration_id: 64, name: "DurableProviderCommandDeliveryCutover" },
        { migration_id: 65, name: "DurableQueuedTurnPromotions" },
        { migration_id: 66, name: "DurableProviderRuntimeEvents" },
        { migration_id: 67, name: "ProviderDeliveryReconciliation" },
        { migration_id: 68, name: "GitHandoffOperations" },
        { migration_id: 69, name: "ProjectPullRequestPins" },
        { migration_id: 70, name: "AgentGatewayOperations" },
        { migration_id: 71, name: "ProjectionThreadsGatewayProvenance" },
        { migration_id: 72, name: "AgentGatewayOperationRetention" },
        { migration_id: 73, name: "OperationalDiagnostics" },
        { migration_id: 74, name: "ExternalMcpIntegrations" },
        { migration_id: 75, name: "ExternalMcpActiveCapacity" },
        { migration_id: 76, name: "ExternalMcpHardening" },
        { migration_id: 77, name: "ExternalMcpCompensatingCapacity" },
        { migration_id: 78, name: "ExternalMcpLiveTurnCapacity" },
        { migration_id: 79, name: "Spaces" },
        { migration_id: 80, name: "ExternalMcpProjectScope" },
        { migration_id: 81, name: "AutomationProposals" },
        { migration_id: 82, name: "AutomationMemory" },
        { migration_id: 83, name: "AutomationHeartbeatEligibility" },
        { migration_id: 84, name: "AutomationNotificationPolicy" },
        { migration_id: 85, name: "AutomationSettings" },
        { migration_id: 86, name: "NormalizeStudioThreadWorkspaces" },
        { migration_id: 87, name: "DropUnusedOrchestrationEventIndexes" },
        { migration_id: 88, name: "ProjectionThreadsSettledAt" },
      ]);
      const preserved = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_consumer_state
      `;
      assert.strictEqual(preserved[0]?.count, 1);
    }),
  );
});

const agentGatewayRetentionLegacyLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

agentGatewayRetentionLegacyLayer(
  "agent gateway retention migration after legacy migration 71",
  (it) => {
    it.effect("adds caller purge tracking without losing legacy operation rows", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 69 });
        yield* sql`
        CREATE TABLE agent_gateway_operations (
          operation_id TEXT PRIMARY KEY,
          caller_thread_id TEXT NOT NULL,
          caller_turn_id TEXT NOT NULL,
          operation_kind TEXT NOT NULL CHECK (operation_kind IN ('create_threads')),
          request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 256),
          fingerprint TEXT NOT NULL,
          requested_count INTEGER NOT NULL CHECK (requested_count BETWEEN 1 AND 20),
          plan_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN ('reserved', 'dispatching', 'completed', 'failed', 'compensating')
          ),
          result_json TEXT,
          error_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (caller_thread_id, caller_turn_id, operation_kind)
        )
      `;
        yield* sql`
        CREATE INDEX idx_agent_gateway_operations_status
        ON agent_gateway_operations (status, updated_at)
      `;
        yield* ProjectionThreadsGatewayProvenanceMigration;
        yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (70, 'AgentGatewayOperations'),
          (71, 'ProjectionThreadsGatewayProvenance')
      `;
        yield* sql`
        INSERT INTO agent_gateway_operations (
          operation_id, caller_thread_id, caller_turn_id, operation_kind,
          request_id, fingerprint, requested_count, plan_json, status,
          result_json, error_json, created_at, updated_at
        ) VALUES (
          'legacy-operation', 'legacy-thread', 'legacy-turn', 'create_threads',
          'legacy-request', 'legacy-fingerprint', 1, '[{"legacy":true}]', 'dispatching',
          NULL, NULL, '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z'
        )
      `;

        const executed = yield* runMigrations();
        assert.deepStrictEqual(executed, [
          [72, "AgentGatewayOperationRetention"],
          [73, "OperationalDiagnostics"],
          [74, "ExternalMcpIntegrations"],
          [75, "ExternalMcpActiveCapacity"],
          [76, "ExternalMcpHardening"],
          [77, "ExternalMcpCompensatingCapacity"],
          [78, "ExternalMcpLiveTurnCapacity"],
          [79, "Spaces"],
          [80, "ExternalMcpProjectScope"],
          [81, "AutomationProposals"],
          [82, "AutomationMemory"],
          [83, "AutomationHeartbeatEligibility"],
          [84, "AutomationNotificationPolicy"],
          [85, "AutomationSettings"],
          [86, "NormalizeStudioThreadWorkspaces"],
          [87, "DropUnusedOrchestrationEventIndexes"],
          [88, "ProjectionThreadsSettledAt"],
        ]);

        const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('agent_gateway_operations')
      `;
        assert.include(
          columns.map(({ name }) => name),
          "caller_purged_at",
        );
        const rows = yield* sql<{
          readonly operationId: string;
          readonly callerThreadId: string;
          readonly callerTurnId: string;
          readonly planJson: string;
          readonly status: string;
          readonly callerPurgedAt: string | null;
        }>`
        SELECT
          operation_id AS "operationId", caller_thread_id AS "callerThreadId",
          caller_turn_id AS "callerTurnId", plan_json AS "planJson", status,
          caller_purged_at AS "callerPurgedAt"
        FROM agent_gateway_operations
      `;
        assert.deepStrictEqual(rows, [
          {
            operationId: "legacy-operation",
            callerThreadId: "legacy-thread",
            callerTurnId: "legacy-turn",
            planJson: '[{"legacy":true}]',
            status: "dispatching",
            callerPurgedAt: null,
          },
        ]);
      }),
    );
  },
);

const spacesMigrationCollisionLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

spacesMigrationCollisionLayer("Spaces migration after the private migration 70 collision", (it) => {
  it.effect("reconciles the tracker and preserves pre-existing Spaces data", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 69 });

      // Private builds of the original Spaces branch claimed migration 70 before
      // current main assigned that ID to AgentGatewayOperations.
      yield* SpacesMigration;
      yield* sql`
        INSERT INTO projection_spaces (
          space_id, name, icon, sort_order, created_at, updated_at, deleted_at
        ) VALUES (
          'space-private-70', 'Private Space', 'bag', 0,
          '2026-07-17T00:00:00.000Z', '2026-07-17T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (70, 'Spaces')
      `;

      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, [
        [70, "AgentGatewayOperations"],
        [71, "ProjectionThreadsGatewayProvenance"],
        [72, "AgentGatewayOperationRetention"],
        [73, "OperationalDiagnostics"],
        [74, "ExternalMcpIntegrations"],
        [75, "ExternalMcpActiveCapacity"],
        [76, "ExternalMcpHardening"],
        [77, "ExternalMcpCompensatingCapacity"],
        [78, "ExternalMcpLiveTurnCapacity"],
        [79, "Spaces"],
        [80, "ExternalMcpProjectScope"],
        [81, "AutomationProposals"],
        [82, "AutomationMemory"],
        [83, "AutomationHeartbeatEligibility"],
        [84, "AutomationNotificationPolicy"],
        [85, "AutomationSettings"],
        [86, "NormalizeStudioThreadWorkspaces"],
        [87, "DropUnusedOrchestrationEventIndexes"],
        [88, "ProjectionThreadsSettledAt"],
      ]);

      const tracker = yield* trackerRows(sql);
      assert.deepStrictEqual(
        tracker.slice(-19).map((row) => [row.migration_id, row.name]),
        [
          [70, "AgentGatewayOperations"],
          [71, "ProjectionThreadsGatewayProvenance"],
          [72, "AgentGatewayOperationRetention"],
          [73, "OperationalDiagnostics"],
          [74, "ExternalMcpIntegrations"],
          [75, "ExternalMcpActiveCapacity"],
          [76, "ExternalMcpHardening"],
          [77, "ExternalMcpCompensatingCapacity"],
          [78, "ExternalMcpLiveTurnCapacity"],
          [79, "Spaces"],
          [80, "ExternalMcpProjectScope"],
          [81, "AutomationProposals"],
          [82, "AutomationMemory"],
          [83, "AutomationHeartbeatEligibility"],
          [84, "AutomationNotificationPolicy"],
          [85, "AutomationSettings"],
          [86, "NormalizeStudioThreadWorkspaces"],
          [87, "DropUnusedOrchestrationEventIndexes"],
          [88, "ProjectionThreadsSettledAt"],
        ],
      );

      const preservedSpaces = yield* sql<{ readonly spaceId: string; readonly name: string }>`
        SELECT space_id AS "spaceId", name
        FROM projection_spaces
        WHERE space_id = 'space-private-70'
      `;
      assert.deepStrictEqual(preservedSpaces, [
        { spaceId: "space-private-70", name: "Private Space" },
      ]);

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'agent_gateway_operations',
            'operational_diagnostics',
            'projection_spaces'
          )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map((row) => row.name),
        ["agent_gateway_operations", "operational_diagnostics", "projection_spaces"],
      );
      assert.include(yield* projectionThreadsColumnNames(sql), "gateway_operation_id");
      const gatewayColumns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('agent_gateway_operations')
      `;
      assert.include(
        gatewayColumns.map((row) => row.name),
        "caller_purged_at",
      );
    }),
  );

  it.effect("upgrades the previous Spaces-at-74 lineage without losing data", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 74 });

      // PR #365 previously published Spaces as migration 74. Main now owns 74–78 for
      // External MCP, so lineage reconciliation must replay that canonical range and
      // apply Spaces at 79 without dropping the already-created table or rows.
      yield* SpacesMigration;
      yield* sql`
        INSERT INTO projection_spaces (
          space_id, name, icon, sort_order, created_at, updated_at, deleted_at
        ) VALUES (
          'space-previous-74', 'Previous Space', 'bag', 0,
          '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        UPDATE effect_sql_migrations
        SET name = 'Spaces'
        WHERE migration_id = 74
      `;

      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, [
        [74, "ExternalMcpIntegrations"],
        [75, "ExternalMcpActiveCapacity"],
        [76, "ExternalMcpHardening"],
        [77, "ExternalMcpCompensatingCapacity"],
        [78, "ExternalMcpLiveTurnCapacity"],
        [79, "Spaces"],
        [80, "ExternalMcpProjectScope"],
        [81, "AutomationProposals"],
        [82, "AutomationMemory"],
        [83, "AutomationHeartbeatEligibility"],
        [84, "AutomationNotificationPolicy"],
        [85, "AutomationSettings"],
        [86, "NormalizeStudioThreadWorkspaces"],
        [87, "DropUnusedOrchestrationEventIndexes"],
        [88, "ProjectionThreadsSettledAt"],
      ]);

      const tracker = yield* trackerRows(sql);
      assert.deepStrictEqual(
        tracker.slice(-15).map((row) => [row.migration_id, row.name]),
        [
          [74, "ExternalMcpIntegrations"],
          [75, "ExternalMcpActiveCapacity"],
          [76, "ExternalMcpHardening"],
          [77, "ExternalMcpCompensatingCapacity"],
          [78, "ExternalMcpLiveTurnCapacity"],
          [79, "Spaces"],
          [80, "ExternalMcpProjectScope"],
          [81, "AutomationProposals"],
          [82, "AutomationMemory"],
          [83, "AutomationHeartbeatEligibility"],
          [84, "AutomationNotificationPolicy"],
          [85, "AutomationSettings"],
          [86, "NormalizeStudioThreadWorkspaces"],
          [87, "DropUnusedOrchestrationEventIndexes"],
          [88, "ProjectionThreadsSettledAt"],
        ],
      );
      const preservedSpaces = yield* sql<{ readonly spaceId: string }>`
        SELECT space_id AS "spaceId"
        FROM projection_spaces
        WHERE space_id = 'space-previous-74'
      `;
      assert.deepStrictEqual(preservedSpaces, [{ spaceId: "space-previous-74" }]);
    }),
  );
});

const managedAttachmentsConstraintsLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

managedAttachmentsConstraintsLayer("managed attachment schema constraints", (it) => {
  it.effect(
    "enforces lifecycle, immutable metadata, cleanup ownership, and indexed quota scans",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        const now = "2026-07-14T00:00:00.000Z";
        const expiry = "2026-07-15T00:00:00.000Z";

        yield* sql`
        INSERT INTO managed_attachment_blobs (
          attachment_id, owner_thread_id, owner_kind, owner_id, kind,
          original_name, mime_type, reserved_bytes, size_bytes, sha256,
          relative_path, state, staging_expires_at, claim_command_id,
          claim_message_id, claimed_at, delete_reason, delete_requested_at,
          deleted_at, created_at, updated_at
        ) VALUES (
          'att-v2-one', 'Thread/Exact', 'session', 'session-one', 'file',
          'notes.txt', 'text/plain', 1024, NULL, NULL,
          'objects/at/att-v2-one.bin', 'uploading', ${expiry}, NULL,
          NULL, NULL, NULL, NULL, NULL, ${now}, ${now}
        )
      `;

        yield* sql`
        UPDATE managed_attachment_blobs
        SET
          size_bytes = 5,
          sha256 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          state = 'staged',
          updated_at = ${now}
        WHERE attachment_id = 'att-v2-one'
      `;
        yield* sql`
        UPDATE managed_attachment_blobs
        SET
          state = 'claimed',
          claim_command_id = 'command-one',
          claim_message_id = 'message-one',
          claimed_at = ${now},
          updated_at = ${now}
        WHERE attachment_id = 'att-v2-one'
      `;
        yield* sql`
        UPDATE managed_attachment_blobs
        SET
          state = 'deleting',
          delete_reason = 'rollback',
          delete_requested_at = ${now},
          updated_at = ${now}
        WHERE attachment_id = 'att-v2-one'
      `;
        yield* sql`
        INSERT INTO managed_attachment_cleanup_jobs (
          attachment_id, reason, attempt_count, next_attempt_at,
          lease_owner, lease_expires_at, last_error, created_at, updated_at
        ) VALUES (
          'att-v2-one', 'rollback', 0, ${now}, NULL, NULL, NULL, ${now}, ${now}
        )
      `;

        const invalidState = yield* Effect.flip(sql`
        UPDATE managed_attachment_blobs
        SET state = 'staged', updated_at = ${now}
        WHERE attachment_id = 'att-v2-one'
      `);
        assert.isDefined(invalidState);

        const mutatedOwner = yield* Effect.flip(sql`
        UPDATE managed_attachment_blobs
        SET owner_thread_id = 'different-thread'
        WHERE attachment_id = 'att-v2-one'
      `);
        assert.isDefined(mutatedOwner);

        const duplicatePath = yield* Effect.flip(sql`
        INSERT INTO managed_attachment_blobs (
          attachment_id, owner_thread_id, owner_kind, owner_id, kind,
          original_name, mime_type, reserved_bytes, relative_path, state,
          staging_expires_at, created_at, updated_at
        ) VALUES (
          'att-v2-two', 'thread-two', 'session', 'session-two', 'image',
          'image.png', 'image/png', 2048, 'objects/at/att-v2-one.bin',
          'uploading', ${expiry}, ${now}, ${now}
        )
      `);
        assert.isDefined(duplicatePath);

        const missingBlobJob = yield* Effect.flip(sql`
        INSERT INTO managed_attachment_cleanup_jobs (
          attachment_id, reason, attempt_count, next_attempt_at,
          created_at, updated_at
        ) VALUES ('missing', 'gc', 0, ${now}, ${now}, ${now})
      `);
        assert.isDefined(missingBlobJob);

        const quota = yield* sql<{
          readonly reservedBytes: number;
          readonly reservedCount: number;
        }>`
        SELECT
          COALESCE(SUM(reserved_bytes), 0) AS "reservedBytes",
          COUNT(*) AS "reservedCount"
        FROM managed_attachment_blobs
        WHERE state <> 'deleted'
      `;
        assert.deepStrictEqual(quota[0], { reservedBytes: 1024, reservedCount: 1 });

        const blobIndexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_index_list('managed_attachment_blobs')
      `;
        assert.includeMembers(
          blobIndexes.map((row) => row.name),
          [
            "idx_managed_attachment_blobs_state_expiry",
            "idx_managed_attachment_blobs_state_reserved",
            "idx_managed_attachment_blobs_owner_thread",
            "idx_managed_attachment_blobs_owner_principal",
            "idx_managed_attachment_blobs_claim",
          ],
        );
        const cleanupIndexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_index_list('managed_attachment_cleanup_jobs')
      `;
        assert.include(
          cleanupIndexes.map((row) => row.name),
          "idx_managed_attachment_cleanup_jobs_due",
        );
      }),
  );
});

const managedAttachmentsIdempotencyLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

managedAttachmentsIdempotencyLayer("managed attachment migration idempotency", (it) => {
  it.effect("is idempotent after the managed attachment schema is registered", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const executed = yield* runMigrations();
      assert.lengthOf(executed, 0);
    }),
  );
});

const latestMigrationId = Math.max(...migrationEntries.map(([id]) => id));

// `migrationEntries` is `as const`, so an inferred Map keys on the literal id union and rejects
// the plain `number` ids these helpers are looked up with. Widen the key type once, here.
const canonicalNamesById = new Map<number, string>(
  migrationEntries.map(([id, name]) => [id, name] as const),
);

const canonicalTrackerThrough = (throughId: number) =>
  new Map<number, string>(
    migrationEntries.filter(([id]) => id <= throughId).map(([id, name]) => [id, name] as const),
  );

const trackerCreatedAtById = (sql: SqlClient.SqlClient) =>
  sql<{ readonly migration_id: number; readonly created_at: string }>`
    SELECT migration_id, created_at FROM effect_sql_migrations ORDER BY migration_id ASC
  `.pipe(Effect.map((rows) => new Map(rows.map((row) => [row.migration_id, row.created_at]))));

describe("migration lineage aliases", () => {
  it("keeps every declared alias consistent with the current lineage", () => {
    for (const alias of MIGRATION_LINEAGE_ALIASES) {
      // The migration must still live at `currentId` under the historical name,
      // otherwise the alias silently stops repairing the databases it names.
      assert.strictEqual(
        canonicalNamesById.get(alias.currentId),
        alias.historicalName,
        `alias for ${alias.historicalName} no longer resolves to migration ${alias.currentId}`,
      );
      // The historical slot must still be a real divergence, and must still be
      // occupied — the repair renames the row to whatever lives there now.
      assert.isDefined(canonicalNamesById.get(alias.historicalId));
      assert.notStrictEqual(canonicalNamesById.get(alias.historicalId), alias.historicalName);
    }
  });

  it("repairs a released v0.5.5 tracker in place", () => {
    const recorded = canonicalTrackerThrough(53);
    recorded.set(54, "ProjectPullRequestPins");

    assert.deepStrictEqual(planMigrationLineageAliasRepairs(recorded), [
      { kind: "rename", migrationId: 54, name: "DurableProviderCommandDelivery" },
    ]);
  });

  it("declines when the tracker also diverges outside the alias", () => {
    const recorded = canonicalTrackerThrough(53);
    recorded.set(54, "ProjectPullRequestPins");
    // Development builds between v0.5.5 and v0.6.0 also claimed migration 55.
    recorded.set(55, "AgentGatewayOperations");

    assert.deepStrictEqual(planMigrationLineageAliasRepairs(recorded), []);
  });

  it("declines for a healthy tracker and for a foreign lineage", () => {
    assert.deepStrictEqual(
      planMigrationLineageAliasRepairs(canonicalTrackerThrough(latestMigrationId)),
      [],
    );

    const foreign = canonicalTrackerThrough(16);
    for (let id = 17; id <= 60; id++) foreign.set(id, `ForeignMigration${id}`);
    assert.deepStrictEqual(planMigrationLineageAliasRepairs(foreign), []);
  });
});

const releasedV055Layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

releasedV055Layer("released v0.5.5 database", (it) => {
  it.effect("reconciles the renumbered pins migration without replaying the lineage", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Reproduce a database written by v0.5.5: canonical rows 1-53, then the
      // pins migration recorded under the ID that release shipped it at.
      yield* runMigrations({ toMigrationInclusive: 53 });
      yield* ProjectPullRequestPinsMigration;
      yield* sql`
        INSERT INTO project_pull_request_pins (project_id, repository_key, pull_request_number)
        VALUES ('project-v055', 'owner/repo', 7)
      `;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (54, 'ProjectPullRequestPins')
      `;

      const createdAtBefore = yield* trackerCreatedAtById(sql);
      const executed = yield* runMigrations();

      // Migration 54 is never replayed: its tracker row was renamed in place.
      assert.deepStrictEqual(
        executed.map(([id]) => id),
        migrationEntries.map(([id]) => id).filter((id) => id >= 55),
      );

      const rows = yield* trackerRows(sql);
      assert.deepStrictEqual(
        rows.map((row) => [row.migration_id, row.name]),
        migrationEntries.map(([id, name]) => [id, name]),
      );

      // Every pre-existing row survived as a row — a metadata fix-up, not a
      // delete-and-replay. `created_at` would change if rows were re-inserted.
      const createdAtAfter = yield* trackerCreatedAtById(sql);
      for (const [id, createdAt] of createdAtBefore) {
        assert.strictEqual(createdAtAfter.get(id), createdAt, `migration ${id} row was recreated`);
      }

      // The pins migration re-runs at 69 and must be a no-op over real data.
      const pins = yield* sql<{ readonly projectId: string; readonly number: number }>`
        SELECT project_id AS "projectId", pull_request_number AS "number"
        FROM project_pull_request_pins
      `;
      assert.deepStrictEqual(pins, [{ projectId: "project-v055", number: 7 }]);
    }),
  );
});

const divergedBeyondAliasLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

divergedBeyondAliasLayer("tracker that diverges beyond a known alias", (it) => {
  it.effect("still truncates and replays from the first divergence", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // A development build between v0.5.5 and v0.6.0: migration 54 matches the
      // alias but 55 was claimed by an unrelated migration, so this is not a
      // v0.5.5 database and must keep taking the existing replay path.
      yield* runMigrations({ toMigrationInclusive: 53 });
      yield* ProjectPullRequestPinsMigration;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (54, 'ProjectPullRequestPins'), (55, 'AgentGatewayOperations')
      `;

      const executed = yield* runMigrations();
      assert.deepStrictEqual(
        executed.map(([id]) => id),
        migrationEntries.map(([id]) => id).filter((id) => id >= 54),
      );

      const rows = yield* trackerRows(sql);
      assert.deepStrictEqual(
        rows.map((row) => [row.migration_id, row.name]),
        migrationEntries.map(([id, name]) => [id, name]),
      );
    }),
  );
});

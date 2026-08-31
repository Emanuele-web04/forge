import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../../persistence/Errors.ts";
import {
  OutboundMcpConnectionRecord,
  OutboundMcpRepository,
  OutboundMcpStatusUpdate,
  type OutboundMcpRepositoryShape,
} from "../Services/OutboundMcpRepository.ts";

const ConnectionId = Schema.Struct({ connectionId: Schema.String });

const makeOutboundMcpRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: OutboundMcpConnectionRecord,
    execute: () => sql`
      SELECT
        connection_id AS "connectionId",
        preset_id AS "presetId",
        display_name AS "displayName",
        endpoint,
        status,
        error_category AS "errorCategory",
        catalog_fingerprint AS "catalogFingerprint",
        last_validated_at AS "lastValidatedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM outbound_mcp_connections
      ORDER BY created_at ASC, connection_id ASC
    `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: ConnectionId,
    Result: OutboundMcpConnectionRecord,
    execute: ({ connectionId }) => sql`
      SELECT
        connection_id AS "connectionId",
        preset_id AS "presetId",
        display_name AS "displayName",
        endpoint,
        status,
        error_category AS "errorCategory",
        catalog_fingerprint AS "catalogFingerprint",
        last_validated_at AS "lastValidatedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM outbound_mcp_connections
      WHERE connection_id = ${connectionId}
      LIMIT 1
    `,
  });

  const upsertRow = SqlSchema.void({
    Request: OutboundMcpConnectionRecord,
    execute: (record) => sql`
      INSERT INTO outbound_mcp_connections (
        connection_id,
        preset_id,
        display_name,
        endpoint,
        status,
        error_category,
        catalog_fingerprint,
        last_validated_at,
        created_at,
        updated_at
      ) VALUES (
        ${record.connectionId},
        ${record.presetId},
        ${record.displayName},
        ${record.endpoint},
        ${record.status},
        ${record.errorCategory},
        ${record.catalogFingerprint},
        ${record.lastValidatedAt},
        ${record.createdAt},
        ${record.updatedAt}
      )
      ON CONFLICT (connection_id) DO UPDATE SET
        preset_id = excluded.preset_id,
        display_name = excluded.display_name,
        endpoint = excluded.endpoint,
        status = excluded.status,
        error_category = excluded.error_category,
        catalog_fingerprint = excluded.catalog_fingerprint,
        last_validated_at = excluded.last_validated_at,
        updated_at = excluded.updated_at
    `,
  });

  const setStatusRow = SqlSchema.void({
    Request: OutboundMcpStatusUpdate,
    execute: (input) => sql`
      UPDATE outbound_mcp_connections
      SET
        status = ${input.status},
        error_category = ${input.errorCategory},
        catalog_fingerprint = CASE
          WHEN ${input.catalogFingerprint === undefined ? 0 : 1} = 0
          THEN catalog_fingerprint
          ELSE ${input.catalogFingerprint ?? null}
        END,
        last_validated_at = CASE
          WHEN ${input.lastValidatedAt === undefined ? 0 : 1} = 0
          THEN last_validated_at
          ELSE ${input.lastValidatedAt ?? null}
        END,
        updated_at = ${input.updatedAt}
      WHERE connection_id = ${input.connectionId}
    `,
  });

  const deleteRow = SqlSchema.void({
    Request: ConnectionId,
    execute: ({ connectionId }) => sql`
      DELETE FROM outbound_mcp_connections
      WHERE connection_id = ${connectionId}
    `,
  });

  const mapError = (operation: string) =>
    toPersistenceSqlOrDecodeError(
      `OutboundMcpRepository.${operation}:query`,
      `OutboundMcpRepository.${operation}:decode`,
    );

  const list: OutboundMcpRepositoryShape["list"] = () =>
    listRows(undefined).pipe(Effect.mapError(mapError("list")));

  const get: OutboundMcpRepositoryShape["get"] = (connectionId) =>
    getRow({ connectionId }).pipe(
      Effect.map(Option.getOrNull),
      Effect.mapError(mapError("get")),
    );

  const upsertMetadata: OutboundMcpRepositoryShape["upsertMetadata"] = (record) =>
    upsertRow(record).pipe(Effect.mapError(mapError("upsertMetadata")));

  const setStatus: OutboundMcpRepositoryShape["setStatus"] = (input) =>
    setStatusRow(input).pipe(Effect.mapError(mapError("setStatus")));

  const deleteConnection: OutboundMcpRepositoryShape["delete"] = (connectionId) =>
    deleteRow({ connectionId }).pipe(Effect.mapError(mapError("delete")));

  return {
    list,
    get,
    upsertMetadata,
    setStatus,
    delete: deleteConnection,
  } satisfies OutboundMcpRepositoryShape;
});

export const OutboundMcpRepositoryLive = Layer.effect(
  OutboundMcpRepository,
  makeOutboundMcpRepository,
);

import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError } from "../../persistence/Errors.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OutboundMcpRepository } from "../Services/OutboundMcpRepository.ts";
import { OutboundMcpRepositoryLive } from "./OutboundMcpRepository.ts";

const layer = it.layer(
  OutboundMcpRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const paratyMetadata = {
  connectionId: "paraty",
  presetId: "paraty",
  displayName: "Paraty MCP",
  endpoint: "https://mcp.paraty.example/mcp",
  status: "disconnected",
  errorCategory: null,
  catalogFingerprint: null,
  lastValidatedAt: null,
  createdAt: "2026-09-01T08:00:00.000Z",
  updatedAt: "2026-09-01T08:00:00.000Z",
} as const;

layer("OutboundMcpRepository", (it) => {
  it.effect("persists metadata without credential columns", () =>
    Effect.gen(function* () {
      const repository = yield* OutboundMcpRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* repository.upsertMetadata(paratyMetadata);

      expect(yield* repository.get("paraty")).toEqual(paratyMetadata);
      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(outbound_mcp_connections)
      `;
      expect(columns.map(({ name }) => name)).toEqual([
        "connection_id",
        "preset_id",
        "display_name",
        "endpoint",
        "status",
        "error_category",
        "catalog_fingerprint",
        "last_validated_at",
        "created_at",
        "updated_at",
      ]);
      expect(columns.map(({ name }) => name)).not.toContain("access_token");
      expect(columns.map(({ name }) => name)).not.toContain("refresh_token");
      yield* repository.delete("paraty");
    }),
  );

  it.effect("lists records deterministically and preserves creation time on metadata upsert", () =>
    Effect.gen(function* () {
      const repository = yield* OutboundMcpRepository;
      yield* repository.upsertMetadata(paratyMetadata);
      yield* repository.upsertMetadata({
        ...paratyMetadata,
        connectionId: "earlier",
        presetId: "earlier",
        displayName: "Earlier MCP",
        createdAt: "2026-09-01T07:00:00.000Z",
        updatedAt: "2026-09-01T07:00:00.000Z",
      });
      yield* repository.upsertMetadata({
        ...paratyMetadata,
        displayName: "Renamed Paraty MCP",
        status: "connected",
        catalogFingerprint: "catalog-v1",
        lastValidatedAt: "2026-09-01T09:00:00.000Z",
        createdAt: "2026-09-01T09:00:00.000Z",
        updatedAt: "2026-09-01T09:00:00.000Z",
      });

      const records = yield* repository.list();
      expect(records.map(({ connectionId }) => connectionId)).toEqual(["earlier", "paraty"]);
      expect(records[1]).toMatchObject({
        displayName: "Renamed Paraty MCP",
        status: "connected",
        catalogFingerprint: "catalog-v1",
        lastValidatedAt: "2026-09-01T09:00:00.000Z",
        createdAt: "2026-09-01T08:00:00.000Z",
        updatedAt: "2026-09-01T09:00:00.000Z",
      });
      yield* repository.delete("earlier");
      yield* repository.delete("paraty");
    }),
  );

  it.effect("preserves, clears, and replaces optional status metadata", () =>
    Effect.gen(function* () {
      const repository = yield* OutboundMcpRepository;
      yield* repository.upsertMetadata({
        ...paratyMetadata,
        status: "connected",
        catalogFingerprint: "catalog-v1",
        lastValidatedAt: "2026-09-01T08:30:00.000Z",
      });

      yield* repository.setStatus({
        connectionId: "paraty",
        status: "authorizing",
        errorCategory: null,
        updatedAt: "2026-09-01T09:00:00.000Z",
      });
      expect(yield* repository.get("paraty")).toMatchObject({
        status: "authorizing",
        errorCategory: null,
        catalogFingerprint: "catalog-v1",
        lastValidatedAt: "2026-09-01T08:30:00.000Z",
      });

      yield* repository.setStatus({
        connectionId: "paraty",
        status: "disconnected",
        errorCategory: "credentials-removed",
        catalogFingerprint: null,
        lastValidatedAt: null,
        updatedAt: "2026-09-01T10:00:00.000Z",
      });
      expect(yield* repository.get("paraty")).toMatchObject({
        status: "disconnected",
        errorCategory: "credentials-removed",
        catalogFingerprint: null,
        lastValidatedAt: null,
      });

      yield* repository.setStatus({
        connectionId: "paraty",
        status: "connected",
        errorCategory: null,
        catalogFingerprint: "catalog-v2",
        lastValidatedAt: "2026-09-01T11:00:00.000Z",
        updatedAt: "2026-09-01T11:00:00.000Z",
      });
      expect(yield* repository.get("paraty")).toMatchObject({
        status: "connected",
        errorCategory: null,
        catalogFingerprint: "catalog-v2",
        lastValidatedAt: "2026-09-01T11:00:00.000Z",
        updatedAt: "2026-09-01T11:00:00.000Z",
      });
      yield* repository.delete("paraty");
    }),
  );

  it.effect("returns null for missing records and deletes idempotently", () =>
    Effect.gen(function* () {
      const repository = yield* OutboundMcpRepository;
      expect(yield* repository.get("missing")).toBeNull();

      yield* repository.upsertMetadata(paratyMetadata);
      yield* repository.delete("paraty");
      yield* repository.delete("paraty");

      expect(yield* repository.get("paraty")).toBeNull();
      expect((yield* repository.list()).map(({ connectionId }) => connectionId)).not.toContain(
        "paraty",
      );
    }),
  );

  it.effect("fails with PersistenceDecodeError when stored metadata violates the schema", () =>
    Effect.gen(function* () {
      const repository = yield* OutboundMcpRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* repository.upsertMetadata({
        ...paratyMetadata,
        connectionId: "decode-paraty",
      });
      yield* sql`
        UPDATE outbound_mcp_connections
        SET status = 'not-a-connection-status'
        WHERE connection_id = 'decode-paraty'
      `;

      const error = yield* Effect.flip(repository.get("decode-paraty"));
      expect(error).toBeInstanceOf(PersistenceDecodeError);
    }),
  );
});

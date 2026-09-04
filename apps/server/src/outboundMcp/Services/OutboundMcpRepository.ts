import {
  IsoDateTime,
  OutboundMcpConnectionStatus,
  OutboundMcpResourceEndpoint,
  TrimmedNonEmptyString,
} from "@synara/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type {
  PersistenceDecodeError,
  PersistenceSqlError,
} from "../../persistence/Errors.ts";

export type OutboundMcpRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export const OutboundMcpConnectionRecord = Schema.Struct({
  connectionId: TrimmedNonEmptyString,
  presetId: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  endpoint: OutboundMcpResourceEndpoint,
  status: OutboundMcpConnectionStatus,
  errorCategory: Schema.NullOr(TrimmedNonEmptyString),
  catalogFingerprint: Schema.NullOr(TrimmedNonEmptyString),
  lastValidatedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OutboundMcpConnectionRecord = typeof OutboundMcpConnectionRecord.Type;

export const OutboundMcpStatusUpdate = Schema.Struct({
  connectionId: TrimmedNonEmptyString,
  status: OutboundMcpConnectionStatus,
  errorCategory: Schema.NullOr(TrimmedNonEmptyString),
  catalogFingerprint: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  lastValidatedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  updatedAt: IsoDateTime,
});
export type OutboundMcpStatusUpdate = typeof OutboundMcpStatusUpdate.Type;

export interface OutboundMcpRepositoryShape {
  readonly list: () => Effect.Effect<
    ReadonlyArray<OutboundMcpConnectionRecord>,
    OutboundMcpRepositoryError
  >;
  readonly get: (
    connectionId: string,
  ) => Effect.Effect<OutboundMcpConnectionRecord | null, OutboundMcpRepositoryError>;
  readonly upsertMetadata: (
    record: OutboundMcpConnectionRecord,
  ) => Effect.Effect<void, OutboundMcpRepositoryError>;
  readonly setStatus: (
    input: OutboundMcpStatusUpdate,
  ) => Effect.Effect<void, OutboundMcpRepositoryError>;
  readonly delete: (
    connectionId: string,
  ) => Effect.Effect<void, OutboundMcpRepositoryError>;
}

export class OutboundMcpRepository extends ServiceMap.Service<
  OutboundMcpRepository,
  OutboundMcpRepositoryShape
>()("synara/outboundMcp/Services/OutboundMcpRepository") {}

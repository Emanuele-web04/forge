import { Schema } from "effect";

import { CommandId, EnvironmentId, NonNegativeInt, PositiveInt, ThreadId } from "./baseSchemas";
import { BoundedUtf8String, utf8ByteLength } from "./browserAutomationBounds";

const BrowserUuidId = <Brand extends string>(brand: Brand) =>
  Schema.String.check(Schema.isUUID(undefined)).pipe(Schema.brand(brand));

export const BrowserDesktopInstanceId = BrowserUuidId("BrowserDesktopInstanceId");
export const BrowserDesktopRuntimeId = BrowserUuidId("BrowserDesktopRuntimeId");
export const BrowserHostConnectionId = BrowserUuidId("BrowserHostConnectionId");
export const BrowserClientId = BrowserUuidId("BrowserClientId");
export const BrowserOperationId = BrowserUuidId("BrowserOperationId");
export const BrowserProviderSessionId = BrowserUuidId("BrowserProviderSessionId");
export const BrowserTabId = BrowserUuidId("BrowserTabId");
export const BrowserSnapshotId = BrowserUuidId("BrowserSnapshotId");
export const BrowserWebMcpDiscoveryId = BrowserUuidId("BrowserWebMcpDiscoveryId");
export const BrowserWebMcpToolId = Schema.String.check(
  Schema.isPattern(/^w[1-9][0-9]{0,2}$/u),
).pipe(Schema.brand("BrowserWebMcpToolId"));
export const BrowserElementRef = Schema.String.check(Schema.isPattern(/^e[1-9][0-9]{0,3}$/u)).pipe(
  Schema.brand("BrowserElementRef"),
);
export const BrowserIdempotencyKey = BoundedUtf8String(128, 1).pipe(
  Schema.brand("BrowserIdempotencyKey"),
);
export const BrowserEnvironmentId = EnvironmentId.check(
  Schema.makeFilter((value: typeof EnvironmentId.Type) => utf8ByteLength(value) <= 128),
);
export const BrowserThreadId = ThreadId.check(
  Schema.makeFilter((value: typeof ThreadId.Type) => utf8ByteLength(value) <= 128),
);
export const BrowserCommandId = CommandId.check(
  Schema.makeFilter((value: typeof CommandId.Type) => utf8ByteLength(value) <= 128),
);

export const BrowserAuthorizationRequestId = BrowserUuidId("BrowserAuthorizationRequestId");
export const BrowserAuthorizationEpoch = PositiveInt.pipe(
  Schema.brand("BrowserAuthorizationEpoch"),
);
export const BrowserProviderRuntimeGeneration = PositiveInt.pipe(
  Schema.brand("BrowserProviderRuntimeGeneration"),
);
export const BrowserRuntimeGeneration = PositiveInt.pipe(Schema.brand("BrowserRuntimeGeneration"));
export const BrowserControlEpoch = NonNegativeInt.pipe(Schema.brand("BrowserControlEpoch"));
export const BrowserTabRecordVersion = NonNegativeInt.pipe(Schema.brand("BrowserTabRecordVersion"));
export const BrowserAssignmentVersion = NonNegativeInt.pipe(
  Schema.brand("BrowserAssignmentVersion"),
);
export const BrowserRoutingInventoryVersion = NonNegativeInt.pipe(
  Schema.brand("BrowserRoutingInventoryVersion"),
);

export type BrowserDesktopInstanceId = typeof BrowserDesktopInstanceId.Type;
export type BrowserDesktopRuntimeId = typeof BrowserDesktopRuntimeId.Type;
export type BrowserHostConnectionId = typeof BrowserHostConnectionId.Type;
export type BrowserClientId = typeof BrowserClientId.Type;
export type BrowserOperationId = typeof BrowserOperationId.Type;
export type BrowserProviderSessionId = typeof BrowserProviderSessionId.Type;
export type BrowserTabId = typeof BrowserTabId.Type;
export type BrowserSnapshotId = typeof BrowserSnapshotId.Type;
export type BrowserWebMcpDiscoveryId = typeof BrowserWebMcpDiscoveryId.Type;
export type BrowserWebMcpToolId = typeof BrowserWebMcpToolId.Type;
export type BrowserElementRef = typeof BrowserElementRef.Type;
export type BrowserIdempotencyKey = typeof BrowserIdempotencyKey.Type;
export type BrowserEnvironmentId = typeof BrowserEnvironmentId.Type;
export type BrowserThreadId = typeof BrowserThreadId.Type;
export type BrowserCommandId = typeof BrowserCommandId.Type;
export type BrowserAuthorizationRequestId = typeof BrowserAuthorizationRequestId.Type;
export type BrowserAuthorizationEpoch = typeof BrowserAuthorizationEpoch.Type;
export type BrowserProviderRuntimeGeneration = typeof BrowserProviderRuntimeGeneration.Type;
export type BrowserRuntimeGeneration = typeof BrowserRuntimeGeneration.Type;
export type BrowserControlEpoch = typeof BrowserControlEpoch.Type;
export type BrowserTabRecordVersion = typeof BrowserTabRecordVersion.Type;
export type BrowserAssignmentVersion = typeof BrowserAssignmentVersion.Type;
export type BrowserRoutingInventoryVersion = typeof BrowserRoutingInventoryVersion.Type;

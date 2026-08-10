import type {
  ProviderKind,
  ProviderProfileId,
  ProviderTarget,
  ProviderSessionRuntimeStatus,
  RuntimeMode,
  ThreadId,
} from "@synara/contracts";
import { Option, ServiceMap } from "effect";
import type { Effect } from "effect";

import type {
  ProviderSessionDirectoryPersistenceError,
  ProviderValidationError,
} from "../Errors.ts";

export interface ProviderRuntimeBinding {
  readonly threadId: ThreadId;
  readonly provider: ProviderKind;
  readonly profileId: ProviderProfileId;
  readonly adapterKey?: string;
  readonly status?: ProviderSessionRuntimeStatus;
  readonly lifecycleGeneration?: string;
  readonly lastSeenAt?: string;
  readonly resumeCursor?: unknown | null;
  readonly runtimePayload?: unknown | null;
  readonly runtimeMode?: RuntimeMode;
}

export type ProviderRuntimeBindingUpdate = Omit<ProviderRuntimeBinding, "profileId"> & {
  readonly profileId?: ProviderProfileId;
};

export type ProviderSessionDirectoryReadError = ProviderSessionDirectoryPersistenceError;

export type ProviderSessionDirectoryWriteError =
  | ProviderValidationError
  | ProviderSessionDirectoryPersistenceError;

export interface ProviderSessionDirectoryShape {
  readonly upsert: (
    binding: ProviderRuntimeBindingUpdate,
  ) => Effect.Effect<void, ProviderSessionDirectoryWriteError>;

  readonly getProvider: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderKind, ProviderSessionDirectoryReadError>;

  readonly getTarget: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderTarget, ProviderSessionDirectoryReadError>;

  readonly getBinding: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProviderRuntimeBinding>, ProviderSessionDirectoryReadError>;

  readonly remove: (
    threadId: ThreadId,
  ) => Effect.Effect<void, ProviderSessionDirectoryPersistenceError>;

  readonly listThreadIds: () => Effect.Effect<
    ReadonlyArray<ThreadId>,
    ProviderSessionDirectoryPersistenceError
  >;

  readonly listBindings: () => Effect.Effect<
    ReadonlyArray<ProviderRuntimeBinding>,
    ProviderSessionDirectoryPersistenceError
  >;
}

export class ProviderSessionDirectory extends ServiceMap.Service<
  ProviderSessionDirectory,
  ProviderSessionDirectoryShape
>()("synara/provider/Services/ProviderSessionDirectory") {}
